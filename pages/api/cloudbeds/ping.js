// pages/api/cloudbeds/ping.js
export default async function handler(req, res) {
  try {
    const apiKey = process.env.CLOUDBEDS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing env: CLOUDBEDS_API_KEY" });

    // Simple read endpoint to verify auth works
    const url = "https://hotels.cloudbeds.com/api/v1.2/getHotels";

    const r = await fetch(url, {
      headers: {
        // Cloudbeds supports API key as Bearer OR x-api-key
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
    });

    const text = await r.text();
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
