// netlify/functions/scrape-menu.js
//
// Renders any restaurant website (including Wix, Squarespace, Toast Tab)
// using headless Chrome, extracts the menu text, then analyzes with Claude.
//
// Input:  { url: "https://restaurant.com/menu" }
// Output: { restaurant: "Name", items: [...] }
//
// ── SETUP ────────────────────────────────────────────────────────────────────
// npm install @anthropic-ai/sdk @sparticuz/chromium puppeteer-core
//
// netlify.toml:
//   [functions."scrape-menu"]
//     timeout = 60
//     memory  = 1024

const Anthropic = require("@anthropic-ai/sdk");
const chromium  = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// ── Shared prompt ─────────────────────────────────────────────────────────────
const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}';
const SYSTEM = [
  "You are a restaurant nutrition expert.",
  "Extract every food and drink item from the provided menu text.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation — generous butter, oil, sauces, and seasoning as actually served.",
  "Restaurant sodium is typically 2-4x what home cooking would use.",
  "Do NOT underestimate. Err on the side of higher calories, sodium and carbs.",
  "Also estimate low/high bounds for natural portion variation.",
  "Output ONLY a JSON object matching this shape — no markdown, no explanation:",
  SCHEMA
].join(" ");

// ── JSON extraction ───────────────────────────────────────────────────────────
function sanitize(str) {
  // Replace smart quotes and special chars that break JSON
  return str
    .replace(/\u2018|\u2019/g, "'")   // smart single quotes
    .replace(/\u201C|\u201D/g, '"')   // smart double quotes
    .replace(/\u2013|\u2014/g, '-')   // en/em dashes
    .replace(/\u00e9/g, 'e')           // é
    .replace(/[\u0080-\u009F]/g, ''); // control characters
}

function parseMenu(str) {
  if (!str?.trim()) throw new Error("Empty response from Claude");
  const clean = sanitize(str);
  // Find outermost { ... }
  let start = -1, depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "{") { if (start === -1) start = i; depth++; }
    else if (clean[i] === "}" && depth > 0 && --depth === 0) {
      try {
        return JSON.parse(clean.slice(start, i + 1));
      } catch(e) {
        // Try stripping any remaining control chars and retry
        const stripped = clean.slice(start, i + 1).replace(/[\x00-\x1F\x7F]/g, ' ');
        try { return JSON.parse(stripped); } catch {}
      }
    }
  }
  // Truncated response — salvage complete items
  const hits = [...clean.matchAll(/\{"name":"[^"]+","category":"[^"]+",[^{}]+\}/g)];
  if (hits.length) {
    const resto = (clean.match(/"restaurant"\s*:\s*"([^"]+)"/) || [])[1] || "Menu (partial)";
    return {
      restaurant: resto,
      items: hits.map(h => { try { return JSON.parse(h[0]); } catch { return null; } }).filter(Boolean)
    };
  }
  throw new Error("No menu data found in response");
}

// ── Page text extraction ──────────────────────────────────────────────────────
const NOISE_TAGS = ["script","style","nav","footer","header","aside","noscript","iframe"];
const MENU_SELECTORS = [
  "[class*='menu']","[id*='menu']","[class*='food']","[class*='dish']",
  "main","article","#content",".content"
];

// ── CORS headers ──────────────────────────────────────────────────────────────
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };

  let url;
  try {
    ({ url } = JSON.parse(event.body || "{}"));
    if (!url) throw new Error("Missing url");
    new URL(url); // validate
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid or missing URL" }) };
  }

  // ── Scrape with Puppeteer ─────────────────────────────────────────────────
  let menuText = "";
  let browser  = null;
  try {
    browser = await puppeteer.launch({
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    });

    const page = await browser.newPage();

    // Block images/fonts/stylesheets to speed up render
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image","stylesheet","font","media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000)); // wait for JS hydration

    // Try focused menu containers first
    let rawText = null;
    for (const sel of MENU_SELECTORS) {
      try {
        rawText = await page.$eval(sel, el => el.innerText || el.textContent);
        if (rawText && rawText.trim().length > 200) break;
        rawText = null;
      } catch {}
    }

    if (!rawText) {
      rawText = await page.evaluate(() => document.body.innerText || document.body.textContent);
    }

    menuText = rawText
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 18000); // ~4500 tokens

  } catch (e) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ error: "Could not scrape page: " + e.message })
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!menuText || menuText.length < 100) {
    return {
      statusCode: 422,
      headers: HEADERS,
      body: JSON.stringify({ error: "Page content too thin. Try the Text tab — paste the menu directly." })
    };
  }

  // ── Analyze with Claude ───────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: "Menu from " + url + ":\n\n" + menuText }]
    });

    const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const result = parseMenu(text);
    if (!result?.items?.length) throw new Error("No menu items found on page");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (e) {
    console.error("scrape-menu Claude error:", e);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message || "Analysis failed" })
    };
  }
};
