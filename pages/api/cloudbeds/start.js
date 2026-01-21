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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const client_id = process.env.CLOUDBEDS_CLIENT_ID;
  const redirect_uri =
    process.env.CLOUDBEDS_REDIRECT_URI ||
    "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";

  if (!client_id) return res.status(500).send("Missing env: CLOUDBEDS_CLIENT_ID");

  const state = crypto.randomBytes(16).toString("hex");
  const scope = "reservations.read";

  // ✅ Correct Cloudbeds OAuth authorize endpoint:
  const authUrl =
    `https://api.cloudbeds.com/api/v1.3/oauth` +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scope)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
