// pages/api/cloudbeds/callback.js
import { createClient } from "@supabase/supabase-js";

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

  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    const client_id = process.env.CLOUDBEDS_CLIENT_ID;
    const client_secret = process.env.CLOUDBEDS_CLIENT_SECRET;
    const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).send("Missing Supabase env vars");
    }
    if (!client_id || !client_secret || !redirect_uri) {
      return res
        .status(500)
        .send("Missing env: CLOUDBEDS_CLIENT_ID / CLOUDBEDS_CLIENT_SECRET / CLOUDBEDS_REDIRECT_URI");
    }

    // Cloudbeds may send back ?code=... OR ?authorization_code=...
    const code = req.query.code || req.query.authorization_code;
    if (!code) {
      return res.status(400).send("Missing authorization code on callback (?code=...)");
    }

    // ✅ Exchange code -> token (v1.3)
    // grant_type = authorization_code
    const tokenUrl = "https://api.cloudbeds.com/api/v1.3/access_token";

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      client_secret,
      redirect_uri,
      authorization_code: String(code),
    });

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenJson = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { error: upsertErr } = await supabase
      .from("cloudbeds_tokens")
      .upsert(
        {
          id: 1,
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token,
          token_type: tokenJson.token_type,
          expires_in: tokenJson.expires_in,
          scope: tokenJson.scope || null,
          raw: tokenJson,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (upsertErr) {
      return res.status(500).send(`Supabase save failed: ${upsertErr.message}`);
    }

    return res.status(200).send("Cloudbeds connected ✅ Token saved to cloudbeds_tokens.");
  } catch (e) {
    return res.status(500).send(e?.message || String(e));
  }
}
