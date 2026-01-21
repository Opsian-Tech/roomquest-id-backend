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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const client_id = process.env.CLOUDBEDS_CLIENT_ID;
    const client_secret = process.env.CLOUDBEDS_CLIENT_SECRET;
    const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;

    if (!client_id || !client_secret || !redirect_uri) {
      return res
        .status(500)
        .send("Missing env: CLOUDBEDS_CLIENT_ID / CLOUDBEDS_CLIENT_SECRET / CLOUDBEDS_REDIRECT_URI");
    }

    // Cloudbeds has mixed examples in docs; accept ALL common param names safely.
    // (Some examples show ?code=..., others mention authorization_code.)
    const code =
      req.query.authorization_code ||
      req.query.code ||
      req.query.authorizationCode ||
      null;

    const state = req.query.state || null;

    if (!code) {
      return res.status(400).send("Missing authorization code on callback");
    }

    // ✅ Correct token exchange endpoint + body shape:
    // POST https://api.cloudbeds.com/api/v1.3/access_token
    // grant_type=authorization_code
    // client_id, client_secret, redirect_uri, authorization_code
    // (docs: access_token call with grant_type: authorization_code) :contentReference[oaicite:1]{index=1}
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

    const tokenJson = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    // tokenJson usually includes: access_token, refresh_token, expires_in, token_type, resources...
    // Store it if you have the table; otherwise still show success.
    if (supabase) {
      // Adjust table/columns if yours differ
      const { error } = await supabase.from("cloudbeds_tokens").upsert({
        id: "primary",
        token_type: tokenJson.token_type ?? "Bearer",
        access_token: tokenJson.access_token ?? null,
        refresh_token: tokenJson.refresh_token ?? null,
        expires_in: tokenJson.expires_in ?? null,
        scope: tokenJson.scope ?? null,
        resources: tokenJson.resources ?? null,
        updated_at: new Date().toISOString(),
      });

      if (error) {
        // Don’t fail OAuth if DB write fails — just show token success
        console.warn("Supabase upsert cloudbeds_tokens failed:", error?.message || error);
      }
    }

    // Simple success response (you can redirect to your app later)
    return res.status(200).json({
      success: true,
      state,
      token_type: tokenJson.token_type,
      expires_in: tokenJson.expires_in,
      has_access_token: Boolean(tokenJson.access_token),
    });
  } catch (e) {
    return res.status(500).send(`Callback crashed: ${e?.message || String(e)}`);
  }
}
