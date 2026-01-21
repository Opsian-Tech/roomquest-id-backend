// pages/api/cloudbeds/callback.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CLOUDBEDS_CLIENT_ID = process.env.CLOUDBEDS_CLIENT_ID;
const CLOUDBEDS_CLIENT_SECRET = process.env.CLOUDBEDS_CLIENT_SECRET;

// IMPORTANT: must match exactly what you whitelist in Cloudbeds
const CLOUDBEDS_REDIRECT_URI =
  process.env.CLOUDBEDS_REDIRECT_URI ||
  "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  try {
    const { code, error, error_description } = req.query || {};

    if (error) {
      return res.status(400).send(`Cloudbeds OAuth error: ${error} - ${error_description || ""}`);
    }

    if (!code) {
      return res.status(400).send("Missing ?code= from Cloudbeds redirect");
    }

    if (!CLOUDBEDS_CLIENT_ID || !CLOUDBEDS_CLIENT_SECRET) {
      return res.status(500).send("Missing CLOUDBEDS_CLIENT_ID / CLOUDBEDS_CLIENT_SECRET env vars");
    }

    // Exchange code -> token
    // Cloudbeds token endpoint:
    // POST https://api.cloudbeds.com/api/v1.3/access_token  :contentReference[oaicite:0]{index=0}
    const tokenRes = await fetch("https://api.cloudbeds.com/api/v1.3/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLOUDBEDS_CLIENT_ID,
        client_secret: CLOUDBEDS_CLIENT_SECRET,
        redirect_uri: CLOUDBEDS_REDIRECT_URI,
        code: String(code),
      }),
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    // Store token in Supabase (simple + safe)
    // You need a table for this in Step 2.
    const { error: upsertErr } = await supabase
      .from("cloudbeds_tokens")
      .upsert(
        {
          id: "primary",
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token || null,
          token_type: tokenJson.token_type || "Bearer",
          expires_in: tokenJson.expires_in || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (upsertErr) {
      return res.status(500).send(`Failed saving token: ${upsertErr.message}`);
    }

    // Done — show a success page
    return res
      .status(200)
      .send("✅ Cloudbeds connected. Token stored successfully. You can close this tab.");
  } catch (e) {
    return res.status(500).send(`Server error: ${e?.message || String(e)}`);
  }
}
