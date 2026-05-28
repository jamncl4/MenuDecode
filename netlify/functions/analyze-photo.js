// netlify/functions/analyze-photo.js
// Two-pass approach:
//   Pass 1: Claude Vision extracts raw text from the menu image (fast, no JSON)
//   Pass 2: Claude analyzes that text for nutrition (same as text tab, reliable)
// This handles large dense menus that fail with single-pass vision+JSON.

const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}';

const SYSTEM_ANALYZE = [
  "You are a restaurant nutrition expert.",
  "Extract every food and drink item from the provided menu text.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation — generous butter, oil, sauces, and seasoning as actually served.",
  "Restaurant sodium is typically 2-4x what home cooking would use. Sauces, glazes and dressings add significant hidden calories, fat and sodium.",
  "Do NOT underestimate. Err on the side of higher calories, sodium and carbs to reflect real restaurant portions.",
  "For complete dinner plates and entrees that include sides, calculate the FULL PLATE — every listed accompaniment (stuffing, potatoes, vegetables, sauces, gravy) must be included in the calorie and nutrition totals.",
  "Use these calorie anchors for accuracy — PROTEINS per ounce: fatty beef cuts (prime rib, ribeye, brisket) 70-80 cal/oz; lean beef (sirloin, filet) 55-65 cal/oz; grilled chicken breast 45-55 cal/oz; fried or breaded chicken 65-75 cal/oz; pork chops or tenderloin 55-65 cal/oz; grilled fish 35-45 cal/oz; fried fish 55-65 cal/oz; shrimp 30-40 cal/oz.",
  "STARCH anchors: twice baked potato 400-500 cal; restaurant mashed potatoes 250-350 cal; restaurant french fries 400-500 cal; pasta dishes 800-1200 cal; rice one cup 200-250 cal; stuffing three-quarter cup 180-220 cal.",
  "RICH ADDITION anchors: cream or butter sauces per ounce 50-80 cal; cheese toppings 100-150 cal; gravy quarter cup 60-80 cal; aioli or mayo-based sauces 80-100 cal per tablespoon.",
  "FULL PLATE minimums: steakhouse entree with sides rarely under 1200 cal; pasta entree rarely under 900 cal; fried seafood plate rarely under 800 cal; burger with fries rarely under 900 cal.",
  "Seafood scampi or butter sauce pasta dishes: base pasta with butter or scampi sauce 800-1000 cal without bread; add 200-250 cal if garlic bread is included making total 1000-1250 cal; add another 150-200 cal per protein addition (shrimp, scallops, chicken). Bull-Run-style scampi WITH garlic bread and broccolini: 1200-1500 cal total.",
  "Chicken pot pie with sides (mashed potato, squash): 1100-1400 cal — the pastry crust adds 300-400 cal and restaurant mashed potato side adds another 300-400 cal beyond the filling.",
  "Also estimate low/high bounds for natural portion variation.",
  "Output ONLY a compact minified JSON object on a single line — no code fences, no markdown, no spaces, no indentation, no explanation — just raw JSON:",
  SCHEMA
].join(" ");

// ── JSON extraction ───────────────────────────────────────────────────────────
function sanitize(str) {
  return str
    // Strip markdown code fences (e.g. ```json ... ```)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    // Normalize smart quotes and special chars
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

// ── Raw API call helper ───────────────────────────────────────────────────────
async function claudeCall(messages, system, maxTokens, model = "claude-sonnet-4-6") {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages
    })
  });
  const data = await response.json();
  if (!response.ok || data.type === "error") {
    throw new Error(data?.error?.message || "API error " + response.status);
  }
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// ── CORS headers ──────────────────────────────────────────────────────────────
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Handler ───────────────────────────────────────────────────────────────────
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
  console.log("analyze-photo: image size", imageSizeKb, "KB");

  try {
    // ── Pass 1: Extract text from image ──────────────────────────────────────
    // Simple OCR — no JSON, just raw text. Fast and reliable for any menu size.
    console.log("analyze-photo: pass 1 — OCR");
    const menuText = await claudeCall(
      [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: validMime, data: cleanImage } },
          { type: "text", text: "Extract text from this menu image. Only include text you can read clearly and confidently. If any text is blurry, partially visible, or unclear, skip it entirely — do not guess, infer, or fill in items. Return only the raw text you can clearly read, exactly as it appears — no formatting, no commentary." }
        ]
      }],
      "You are an expert at reading restaurant menus. Extract all visible text accurately.",
      1024,    // OCR only needs a small token budget
      "claude-haiku-4-5-20251001"  // Haiku is 3-4x faster for OCR — essential for staying within 30s limit
    );

    if (!menuText?.trim()) throw new Error("Could not read text from image. Try a clearer photo.");
    console.log("analyze-photo: pass 1 complete, extracted", menuText.length, "chars");

    // ── Pass 2: Analyze nutrition from extracted text ─────────────────────────
    // Same path as the text tab — proven reliable for large menus.
    console.log("analyze-photo: pass 2 — nutrition analysis");
    const analysisText = await claudeCall(
      [{ role: "user", content: "Analyze this menu:\n\n" + menuText }],
      SYSTEM_ANALYZE,
      4800,
      "claude-haiku-4-5-20251001"  // Haiku for speed — keeps total under 30s limit
    );

    console.log("analyze-photo: pass 2 raw (first 500):", analysisText ? analysisText.slice(0, 500) : "EMPTY");
    const result = parseMenu(analysisText);
    if (!result?.items?.length) throw new Error("No menu items found in the image");

    console.log("analyze-photo: complete,", result.items.length, "items");
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (e) {
    console.error("analyze-photo error:", e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message || "Photo analysis failed" }) };
  }
};
