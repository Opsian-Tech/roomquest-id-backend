@@ -1,4 +1,5 @@
// pages/api/cloudbeds/callback.js

import { createClient } from "@supabase/supabase-js";

function setCors(res) {
@@ -11,58 +12,44 @@ function setCors(res) {
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
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    const client_id = process.env.CLOUDBEDS_CLIENT_ID;
    const client_secret = process.env.CLOUDBEDS_CLIENT_SECRET;
    const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;
    const redirect_uri =
      process.env.CLOUDBEDS_REDIRECT_URI ||
      "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";

    if (!client_id || !client_secret || !redirect_uri) {
      return res
        .status(500)
        .send("Missing env: CLOUDBEDS_CLIENT_ID / CLOUDBEDS_CLIENT_SECRET / CLOUDBEDS_REDIRECT_URI");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).send("Missing Supabase env vars");
    }
    if (!client_id || !client_secret) {
      return res.status(500).send("Missing CLOUDBEDS_CLIENT_ID or CLOUDBEDS_CLIENT_SECRET");
    }

    // Cloudbeds has mixed examples in docs; accept ALL common param names safely.
    // (Some examples show ?code=..., others mention authorization_code.)
    const code =
      req.query.authorization_code ||
      req.query.code ||
      req.query.authorizationCode ||
      null;

    const state = req.query.state || null;

    // Cloudbeds sometimes returns `code`, sometimes `authorization_code` depending on doc/version.
    const code = req.query.code || req.query.authorization_code;
    if (!code) {
      return res.status(400).send("Missing authorization code on callback");
      return res.status(400).send("Missing authorization code (expected ?code=... or ?authorization_code=...)");
    }

    // ✅ Correct token exchange endpoint + body shape:
    // POST https://api.cloudbeds.com/api/v1.3/access_token
    // grant_type=authorization_code
    // client_id, client_secret, redirect_uri, authorization_code
    // (docs: access_token call with grant_type: authorization_code) :contentReference[oaicite:1]{index=1}
    // ✅ Correct token endpoint + required grant_type
    // Cloudbeds docs: exchange authorization_code using /access_token and grant_type=authorization_code
    const tokenUrl = "https://api.cloudbeds.com/api/v1.3/access_token";

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      client_secret,
      redirect_uri,
      authorization_code: String(code),
      code: String(code),
    });

    const tokenRes = await fetch(tokenUrl, {
@@ -71,44 +58,41 @@ export default async function handler(req, res) {
      body,
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));
    const tokenJson = await tokenRes.json().catch(() => null);

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

    // Simple success response (you can redirect to your app later)
    return res.status(200).json({
      success: true,
      state,
      token_type: tokenJson.token_type,
      expires_in: tokenJson.expires_in,
      has_access_token: Boolean(tokenJson.access_token),
    });
    // Send a clean success page (so you don't see JSON in the browser)
    return res.status(200).send("Cloudbeds connected ✅ Token saved.");
  } catch (e) {
    return res.status(500).send(`Callback crashed: ${e?.message || String(e)}`);
    return res.status(500).send(e?.message || String(e));
  }
}
