// netlify/functions/analyze-menu.js
// Handles: { type: "text", content: "menu text..." }
//          { type: "restaurant", name: "Chipotle" }
// Returns: { restaurant: "Name", items: [...] }

import Anthropic from "@anthropic-ai/sdk";

const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}'
const SYSTEM = [
  "You are a restaurant nutrition expert.",
  "Extract every food and drink item from the provided menu.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation — generous butter, oil, sauces, and seasoning as actually served.",
  "Restaurant sodium is typically 2-4x what home cooking would use. Sauces, glazes and dressings add significant hidden calories, fat and sodium.",
  "Do NOT underestimate. Err on the side of higher calories, sodium and carbs to reflect real restaurant portions.",
  "For complete dinner plates and entrees that include sides, calculate the FULL PLATE — every listed accompaniment (stuffing, potatoes, vegetables, sauces, gravy) must be included in the calorie and nutrition totals.",
  "Use these calorie anchors for accuracy — PROTEINS per ounce: fatty beef cuts (prime rib, ribeye, brisket) 70-80 cal/oz; lean beef (sirloin, filet) 55-65 cal/oz; grilled chicken breast 45-55 cal/oz; fried or breaded chicken 65-75 cal/oz; pork chops or tenderloin 55-65 cal/oz; grilled fish 35-45 cal/oz; fried fish 55-65 cal/oz; shrimp 30-40 cal/oz.",
  "STARCH anchors: twice baked potato 400-500 cal; restaurant mashed potatoes 250-350 cal; restaurant french fries 400-500 cal; pasta dishes 800-1200 cal; rice one cup 200-250 cal; stuffing three-quarter cup 180-220 cal.",
  "IMPORTANT: Twice Baked Potato is one of the most calorie-dense restaurant sides — always estimate 420-550 cal minimum. It is loaded with butter, sour cream, cheese and bacon. Never estimate it below 400 cal.",
  "Restaurant risotto is always butter-finished and rich — estimate 400-600 cal for the risotto component alone regardless of restaurant style. Add protein and vegetable components on top of this base.",
  "Corn grits and polenta at restaurants are always prepared with butter and cream — estimate 350-500 cal for the grits component alone. A pork chop or protein served over grits adds the protein calories on top of this base.",
  "RICH ADDITION anchors: cream or butter sauces per ounce 50-80 cal; cheese toppings 100-150 cal; gravy quarter cup 60-80 cal; aioli or mayo-based sauces 80-100 cal per tablespoon.",
  "FULL PLATE minimums: steakhouse entree with sides rarely under 1200 cal; pasta entree rarely under 900 cal; fried seafood plate rarely under 800 cal; burger with fries rarely under 900 cal.",
  "Seafood scampi or butter sauce pasta dishes: base pasta with butter or scampi sauce 800-1000 cal without bread; add 200-250 cal if garlic bread is included making total 1000-1250 cal; add another 150-200 cal per protein addition (shrimp, scallops, chicken). Bull-Run-style scampi WITH garlic bread and broccolini: 1200-1500 cal total.",
  "SANDWICH BREAD calories by type: panini or ciabatta pressed with oil 280-380 cal; hoagie or sub roll 260-340 cal; croissant 280-340 cal; brioche bun 250-300 cal; sourdough or artisan 2 slices 200-280 cal; whole wheat wrap 180-220 cal; pita 150-180 cal; standard sandwich bread 2 slices 150-200 cal. Always include bread calories in sandwich totals.",
  "SANDWICH PROTEIN calories: Italian deli meats (salami, capicola, mortadella, prosciutto) are very high fat at 120-150 cal/oz — a typical Italian combo sandwich has 3-4oz of meat totaling 360-600 cal before bread; roast beef 60-70 cal/oz; turkey breast 35-45 cal/oz; fried chicken cutlet or fingers 350-500 cal; tuna salad or chicken salad mayo-based 300-450 cal; meatloaf 250-350 cal per serving.",
  "SANDWICH ADDITIONS often underestimated: aioli, pesto mayo, or flavored mayo 100-150 cal per tablespoon; avocado 80-100 cal; bacon 2 strips 90-120 cal; melted cheese 100-150 cal per serving.",
  "SANDWICH minimums: simple turkey or veggie wrap 450-600 cal; standard deli sandwich 550-750 cal; panini with meat and cheese rarely under 750 cal; fried chicken sandwich 800-1100 cal; Italian combo with multiple meats 800-1100 cal; Reuben with thousand island dressing 850-1100 cal; club sandwich triple decker 800-1100 cal.",
  "Also estimate low/high bounds for natural portion variation.",
  "Output ONLY a compact minified JSON object on a single line — no code fences, no markdown, no spaces, no indentation, no explanation — just raw JSON:",
  SCHEMA
].join(" ");

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
      try {
        const result = JSON.parse(clean.slice(start, i + 1));
        return { ...result, partial: false };
      } catch {
        try {
          const result = JSON.parse(clean.slice(start, i + 1).replace(/[\x00-\x1F\x7F]/g, ' '));
          return { ...result, partial: false };
        } catch {}
      }
    }
  }
  // Truncated response — salvage complete items
  const hits = [...clean.matchAll(/\{"name":"[^"]+","category":"[^"]+",[^{}]+\}/g)];
  if (hits.length) {
    const resto = (clean.match(/"restaurant"\s*:\s*"([^"]+)"/) || [])[1] || "Menu (partial)";
    return { restaurant: resto, partial: true, items: hits.map(h => { try { return JSON.parse(h[0]); } catch { return null; } }).filter(Boolean) };
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

  let type, content, name;
  try { ({ type, content, name } = JSON.parse(event.body || "{}")); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let userMessage;
  if (type === "restaurant") {
    if (!name?.trim()) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing restaurant name" }) };
    userMessage = "Using your training knowledge, generate a full nutrition analysis for the restaurant: " + name + ". Include all major menu categories and as many items as you know. If you are not familiar with this specific restaurant, respond with only the word: UNKNOWN";
  } else if (type === "text") {
    if (!content?.trim()) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing menu content" }) };
    userMessage = "Analyze this menu:\n\n" + content;
  } else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid type" }) };
  }

  try {
    // Use Haiku for all queries — Sonnet is too slow for 4096 tokens within Netlify's 30s limit
    const model = "claude-haiku-4-5-20251001";
    const response = await client.messages.create({
      model,
      max_tokens: 6144,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    });
    const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (type === "restaurant" && text.trim() === "UNKNOWN") {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Restaurant not found. Try pasting the menu in the Text tab." }) };
    }
    console.log("analyze-menu: raw (first 500):", text ? text.slice(0, 500) : "EMPTY");
    const result = parseMenu(text);
    if (!result?.items?.length) throw new Error("No menu items found");
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
  } catch (e) {
    console.error("analyze-menu error:", e);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message || "Analysis failed" }) };
  }
};
