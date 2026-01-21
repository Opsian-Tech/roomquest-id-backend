// pages/api/cloudbeds/start.js

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const client_id = process.env.CLOUDBEDS_CLIENT_ID;
  const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI; 
  // MUST match EXACTLY what Cloudbeds has whitelisted

  // Optional but recommended
  const scope = process.env.CLOUDBEDS_SCOPE || "reservations.read";

  // Cloudbeds authorize base (per docs)
  const authorizeBase =
    process.env.CLOUDBEDS_AUTHORIZE_URL ||
    "https://hotels.cloudbeds.com/oauth/authorize";

  if (!client_id || !redirect_uri) {
    return res.status(500).send("Missing CLOUDBEDS_CLIENT_ID or CLOUDBEDS_REDIRECT_URI");
  }

  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const url =
    `${authorizeBase}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scope)}`;

  return res.status(302).setHeader("Location", url).end();
}
