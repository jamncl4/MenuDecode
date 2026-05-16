// netlify/functions/scrape-menu.js
// Note: Puppeteer/Chromium not included by default.
// Returns a helpful message if URL scraping is attempted.
// To enable: npm install @sparticuz/chromium puppeteer-core at project root.

import Anthropic from "@anthropic-ai/sdk";

const ITEM_SHAPE = '{"name":"...","category":"Appetizer|Entree|Salad|Soup|Side|Dessert|Drink","calories":450,"cal_lo":380,"cal_hi":520,"fat_g":18,"fat_lo":14,"fat_hi":22,"sodium_mg":820,"sod_lo":650,"sod_hi":990,"carbs_g":52,"carb_lo":44,"carb_hi":60,"protein_g":24,"pro_lo":20,"pro_hi":28,"price":"$12"}';
const SCHEMA = '{"restaurant":"Name","items":[' + ITEM_SHAPE + ']}'
const SYSTEM = [
  "You are a restaurant nutrition expert.",
  "Extract every food and drink item from the provided menu text.",
  "For each item estimate realistic calories, fat, sodium, carbs, protein.",
  "IMPORTANT: Assume full restaurant-style preparation.",
  "Do NOT underestimate.",
  "Also estimate low/high bounds for natural portion variation.",
  "Output ONLY a JSON object matching this shape — no markdown, no explanation:",
  SCHEMA
].join(" ");

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };

  // URL scraping via Puppeteer is not yet enabled.
  // The Text tab is the recommended path for websites.
  return {
    statusCode: 501,
    headers: HEADERS,
    body: JSON.stringify({
      error: "URL scraping is not yet enabled. Please copy the menu text from the restaurant website and paste it in the Text tab."
    })
  };
};
