// netlify/functions/analyze-menu.js
//
// Handles two input types:
//   { type: "text",       content: "menu text..." }
//   { type: "restaurant", name:    "Chipotle"     }
//
// Returns: { restaurant: "Name", items: [...] }

const Anthropic = require("@anthropic-ai/sdk");

// ── Shared prompt ─────────────────────────────────────────────────────────────
const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}';
const SYSTEM = [
  "You are a restaurant nutrition expert.",
  "Extract every food and drink item from the provided menu.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation — generous butter, oil, sauces, and seasoning as actually served.",
  "Restaurant sodium is typically 2-4x what home cooking would use. Sauces, glazes and dressings add significant hidden calories, fat and sodium.",
  "Do NOT underestimate. Err on the side of higher calories, sodium and carbs to reflect real restaurant portions.",
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

  let type, content, name;
  try {
    ({ type, content, name } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let userMessage;
  if (type === "restaurant") {
    if (!name?.trim()) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing restaurant name" }) };
    userMessage = [
      "Using your training knowledge, generate a full nutrition analysis for the restaurant: " + name + ".",
      "Include all major menu categories and as many items as you know.",
      "If you are not familiar with this specific restaurant, respond with only the word: UNKNOWN"
    ].join(" ");
  } else if (type === "text") {
    if (!content?.trim()) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing menu content" }) };
    userMessage = "Analyze this menu:\n\n" + content;
  } else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid type — use 'text' or 'restaurant'" }) };
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    });

    const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("");

    if (type === "restaurant" && text.trim() === "UNKNOWN") {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({ error: "Restaurant not found in training data. Try the Text tab — paste the menu directly." })
      };
    }

    const result = parseMenu(text);
    if (!result?.items?.length) throw new Error("No menu items found in response");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (e) {
    console.error("analyze-menu error:", e);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message || "Analysis failed" })
    };
  }
};
