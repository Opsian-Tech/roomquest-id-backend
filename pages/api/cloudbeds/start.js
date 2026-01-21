// pages/api/cloudbeds/start.js
import crypto from "crypto";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

export default function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const client_id = process.env.CLOUDBEDS_CLIENT_ID;
  const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;

  if (!client_id) return res.status(500).send("Missing env: CLOUDBEDS_CLIENT_ID");
  if (!redirect_uri) return res.status(500).send("Missing env: CLOUDBEDS_REDIRECT_URI");

  const state = crypto.randomBytes(16).toString("hex");

  // ✅ Cloudbeds OAuth start (v1.3)
  // Docs show: GET https://api.cloudbeds.com/api/v1.3/oauth?client_id=...&redirect_uri=...&state=...
  const url =
    "https://api.cloudbeds.com/api/v1.3/oauth" +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}`;

  res.status(302).setHeader("Location", url).end();
}
