// pages/api/cloudbeds/refresh.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CLOUDBEDS_TOKEN_URL = "https://api.cloudbeds.com/api/v1.3/access_token";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version"
  );
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Get current token from database
    const { data: tokenRecord, error: fetchError } = await supabase
      .from("cloudbeds_tokens")
      .select("*")
      .eq("id", 1)
      .single();

    if (fetchError || !tokenRecord) {
      console.error("[Cloudbeds Refresh] No token found:", fetchError);
      return res.status(404).json({
        success: false,
        error: "No Cloudbeds token found. Please authorize the property first.",
      });
    }

    console.log("[Cloudbeds Refresh] Current token updated_at:", tokenRecord.updated_at);

    // 2. Get OAuth credentials from environment
    const client_id = process.env.CLOUDBEDS_CLIENT_ID;
    const client_secret = process.env.CLOUDBEDS_CLIENT_SECRET;
    const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;

    if (!client_id || !client_secret || !redirect_uri) {
      console.error("[Cloudbeds Refresh] Missing OAuth credentials");
      return res.status(500).json({
        success: false,
        error: "Missing Cloudbeds OAuth configuration",
      });
    }

    // 3. Call Cloudbeds token refresh endpoint
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      redirect_uri,
      refresh_token: tokenRecord.refresh_token,
    });

    console.log("[Cloudbeds Refresh] Requesting new token...");

    const tokenResponse = await fetch(CLOUDBEDS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenJson = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenJson.access_token) {
      console.error("[Cloudbeds Refresh] Token refresh failed:", tokenJson);
      return res.status(400).json({
        success: false,
        error: "Failed to refresh Cloudbeds token",
        details: tokenJson.message || tokenJson.error || "Unknown error",
      });
    }

    // 4. Update token in database
    const { error: updateError } = await supabase
      .from("cloudbeds_tokens")
      .update({
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        token_type: tokenJson.token_type || "Bearer",
        expires_in: tokenJson.expires_in,
        scope: tokenJson.scope || tokenRecord.scope,
        raw: tokenJson,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    if (updateError) {
      console.error("[Cloudbeds Refresh] Failed to save new token:", updateError);
      return res.status(500).json({
        success: false,
        error: "Failed to save refreshed token",
      });
    }

    console.log("[Cloudbeds Refresh] Token refreshed successfully");

    // 5. Return success with token info (not the actual token for security)
    return res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      expires_in: tokenJson.expires_in,
      expires_in_hours: Math.round(tokenJson.expires_in / 3600),
      refreshed_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error("[Cloudbeds Refresh] Error:", e);
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
