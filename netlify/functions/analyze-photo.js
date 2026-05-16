// netlify/functions/analyze-photo.js
// Uses raw fetch instead of SDK — matches the exact format that worked in the artifact.
// Input:  { image: "base64string", mimeType: "image/jpeg" }
// Output: { restaurant: "Name", items: [...] }

const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}';
const SYSTEM = [
  "You are a restaurant nutrition expert.",
  "Analyze the menu image and extract every food and drink item you can read.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation — generous butter, oil, sauces, and seasoning as actually served.",
  "Restaurant sodium is typically 2-4x what home cooking would use.",
  "Do NOT underestimate. Err on the side of higher calories, sodium and carbs.",
  "Also estimate low/high bounds for natural portion variation.",
  "Output ONLY a JSON object matching this shape — no markdown, no explanation:",
  SCHEMA
].join(" ");

function sanitize(str) {
  return str
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\u00e9/g, 'e')
    .replace(/[\u0080-\u009F]/g, '');
}

function parseMenu(str) {
  if (!str?.trim()) throw new Error("Empty response from Claude");
  const clean = sanitize(str);
  let start = -1, depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "{") { if (start === -1) start = i; depth++; }
    else if (clean[i] === "}" && depth > 0 && --depth === 0) {
      try { return JSON.parse(clean.slice(start, i + 1)); }
      catch { try { return JSON.parse(clean.slice(start, i + 1).replace(/[\x00-\x1F\x7F]/g, ' ')); } catch {} }
    }
  }
  const hits = [...clean.matchAll(/\{"name":"[^"]+","category":"[^"]+",[^{}]+\}/g)];
  if (hits.length) {
    const resto = (clean.match(/"restaurant"\s*:\s*"([^"]+)"/) || [])[1] || "Menu (partial)";
    return { restaurant: resto, items: hits.map(h => { try { return JSON.parse(h[0]); } catch { return null; } }).filter(Boolean) };
  }
  throw new Error("No menu data found in response");
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };

  let image, mimeType;
  try { ({ image, mimeType } = JSON.parse(event.body || "{}")); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid request body" }) }; }

  if (!image) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing image data" }) };

  const cleanImage = image.replace(/\s/g, "");
  const validMime = ["image/jpeg","image/jpg","image/png","image/webp"].includes(mimeType)
    ? mimeType : "image/jpeg";

  const imageSizeKb = Math.round(cleanImage.length * 0.75 / 1024);
  console.log("analyze-photo: image size", imageSizeKb, "KB, mime:", validMime);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: validMime, data: cleanImage } },
            { type: "text", text: "Analyze every item on this menu and return the JSON." }
          ]
        }]
      })
    });

    const data = await response.json();
    console.log("analyze-photo: API status", response.status);

    if (!response.ok || data.type === "error") {
      const msg = data?.error?.message || JSON.stringify(data).slice(0, 200);
      console.error("analyze-photo: API error", response.status, msg);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Claude API error: " + msg }) };
    }

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const result = parseMenu(text);
    if (!result?.items?.length) throw new Error("No menu items found in the image");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (e) {
    console.error("analyze-photo error:", e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message || "Photo analysis failed" }) };
  }
};
