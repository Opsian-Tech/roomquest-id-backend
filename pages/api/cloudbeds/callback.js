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
    const redirect_uri =
      process.env.CLOUDBEDS_REDIRECT_URI ||
      "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).send("Missing Supabase env vars");
    }
    if (!client_id || !client_secret) {
      return res.status(500).send("Missing CLOUDBEDS_CLIENT_ID or CLOUDBEDS_CLIENT_SECRET");
    }

    // Cloudbeds sometimes returns `code`, sometimes `authorization_code` depending on doc/version.
    const code = req.query.code || req.query.authorization_code;
    if (!code) {
      return res.status(400).send("Missing authorization code (expected ?code=... or ?authorization_code=...)");
    }

    // ✅ Correct token endpoint + required grant_type
    // Cloudbeds docs: exchange authorization_code using /access_token and grant_type=authorization_code
    const tokenUrl = "https://api.cloudbeds.com/api/v1.3/access_token";

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      client_secret,
      redirect_uri,
      code: String(code),
    });

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenJson = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    // tokenJson should include: access_token, refresh_token, token_type, expires_in, etc.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Store one row (simple) — adjust if you want per-property tokens later
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

    // Send a clean success page (so you don't see JSON in the browser)
    return res.status(200).send("Cloudbeds connected ✅ Token saved.");
  } catch (e) {
    return res.status(500).send(e?.message || String(e));
  }
}
