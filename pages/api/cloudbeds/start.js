
import crypto from "crypto";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
// pages/api/cloudbeds/start.js
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

export default async function handler(req, res) {
  setCors(res);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const client_id = process.env.CLOUDBEDS_CLIENT_ID;
  const redirect_uri =
    process.env.CLOUDBEDS_REDIRECT_URI ||
    "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";
  const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;
  // MUST exactly match what Cloudbeds has whitelisted

  if (!client_id) return res.status(500).send("Missing env: CLOUDBEDS_CLIENT_ID");
  if (!client_id || !redirect_uri) {
    return res
      .status(500)
      .send("Missing CLOUDBEDS_CLIENT_ID or CLOUDBEDS_REDIRECT_URI");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const scope = "reservations.read";
  const state =
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ✅ Correct Cloudbeds OAuth authorize endpoint:
  const authUrl =
    `https://api.cloudbeds.com/api/v1.3/oauth` +
  const url =
    "https://api.cloudbeds.com/api/v1.3/oauth" +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scope)}`;
    `&state=${encodeURIComponent(state)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
  return res.status(302).setHeader("Location", url).end();
}
