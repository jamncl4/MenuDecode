// netlify/functions/analyze-photo.js
// Pass 1 of two-pass photo analysis: OCR only.
// Returns { text: "extracted menu text" } to the frontend.
// Frontend then calls analyze-menu with that text for nutrition analysis.
// This gives photos the same quality as text tab with independent 30s windows.

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
  console.log("analyze-photo OCR: image size", imageSizeKb, "KB");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: "You are an expert at reading restaurant menus. Extract all visible text accurately.",
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: validMime, data: cleanImage } },
            { type: "text", text: "Extract text from this menu image. Only include text you can read clearly and confidently. If any text is blurry, partially visible, or unclear, skip it entirely — do not guess, infer, or fill in items. Include every item name, description, and price you can clearly read. Return only the raw text exactly as it appears — no formatting, no commentary." }
          ]
        }]
      })
    });

    const data = await response.json();
    console.log("analyze-photo OCR: API status", response.status);

    if (!response.ok || data.type === "error") {
      const msg = data?.error?.message || "API error " + response.status;
      console.error("analyze-photo OCR error:", msg);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: msg }) };
    }

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log("analyze-photo OCR: extracted", text.length, "chars");

    if (!text) return { statusCode: 422, headers: HEADERS, body: JSON.stringify({ error: "Could not read text from image. Try a clearer photo or use the Text tab." }) };

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ text }) };

  } catch (e) {
    console.error("analyze-photo error:", e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message || "OCR failed" }) };
  }
};
