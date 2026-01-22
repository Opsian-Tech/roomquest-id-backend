// pages/api/cloudbeds/reservation.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLOUDBEDS_API_BASE = "https://api.cloudbeds.com/api/v1.2";
const CLOUDBEDS_DOORLOCKS_BASE = "https://api.cloudbeds.com/v2";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

async function getValidToken(supabase) {
  const { data: tokenRecord, error } = await supabase
    .from("cloudbeds_tokens")
    .select("*")
    .eq("id", 1)
    .single();

  if (error || !tokenRecord) {
    throw new Error("No Cloudbeds token found. Please re-authorize.");
  }

  // Check if token is expired (access_token valid for 8 hours = 28800 seconds)
  const updatedAt = new Date(tokenRecord.updated_at);
  const expiresAt = new Date(updatedAt.getTime() + (tokenRecord.expires_in * 1000));
  const now = new Date();

  // Add 5-minute buffer before expiry
  const bufferMs = 5 * 60 * 1000;

  if (now.getTime() >= expiresAt.getTime() - bufferMs) {
    // Token expired or about to expire - refresh it
    console.log("[Cloudbeds] Token expired, refreshing...");
    return await refreshToken(supabase, tokenRecord.refresh_token);
  }

  console.log("[Cloudbeds] Using valid token");
  return tokenRecord.access_token;
}

async function refreshToken(supabase, refreshTokenValue) {
  const client_id = process.env.CLOUDBEDS_CLIENT_ID;
  const client_secret = process.env.CLOUDBEDS_CLIENT_SECRET;
  const redirect_uri = process.env.CLOUDBEDS_REDIRECT_URI;

  const tokenUrl = "https://api.cloudbeds.com/api/v1.3/access_token";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id,
    client_secret,
    redirect_uri,
    refresh_token: refreshTokenValue,
  });

  console.log("[Cloudbeds] Refreshing token...");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const tokenJson = await response.json();

  if (!response.ok) {
    console.error("[Cloudbeds] Token refresh failed:", tokenJson);
    throw new Error("Failed to refresh Cloudbeds token. Property may need to re-authorize.");
  }

  // Update token in database
  const { error: updateError } = await supabase.from("cloudbeds_tokens").update({
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    expires_in: tokenJson.expires_in,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  if (updateError) {
    console.error("[Cloudbeds] Failed to save refreshed token:", updateError);
  }

  console.log("[Cloudbeds] Token refreshed successfully");
  return tokenJson.access_token;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { reservation_id } = req.body || {};

    if (!reservation_id) {
      return res.status(400).json({ error: "Missing reservation_id" });
    }

    console.log("[Cloudbeds] Looking up reservation:", reservation_id);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const accessToken = await getValidToken(supabase);

    // 1. Get reservation details from Cloudbeds
    const reservationUrl = `${CLOUDBEDS_API_BASE}/getReservation?reservationID=${encodeURIComponent(reservation_id)}`;
    console.log("[Cloudbeds] Fetching reservation from:", reservationUrl);

    const reservationRes = await fetch(reservationUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const reservationData = await reservationRes.json();

    if (!reservationRes.ok || !reservationData.success) {
      console.error("[Cloudbeds] getReservation failed:", reservationData);
      return res.status(404).json({
        success: false,
        error: "Reservation not found",
        details: reservationData.message || "Unknown error",
      });
    }

    console.log("[Cloudbeds] Reservation found:", {
      guestName: reservationData.data?.guestName,
      status: reservationData.data?.status,
      assignedRooms: reservationData.data?.assigned?.length || 0,
    });

    // 2. Extract room name from assigned rooms array
    const assigned = reservationData.data?.assigned || [];
    let roomName = null;

    if (assigned.length > 0) {
      // Use roomName if available, otherwise fall back to roomTypeName
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
      console.log("[Cloudbeds] Room assignment found:", roomName);
    } else {
      console.log("[Cloudbeds] No room assigned yet");
    }

    // 3. Get door lock access code (v2 API)
    let accessCode = null;

    try {
      const keysUrl = `${CLOUDBEDS_DOORLOCKS_BASE}/keys?reservationId=${encodeURIComponent(reservation_id)}`;
      console.log("[Cloudbeds] Fetching door lock keys from:", keysUrl);

      const keysRes = await fetch(keysUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (keysRes.ok) {
        const keysData = await keysRes.json();
        console.log("[Cloudbeds] Door lock response:", JSON.stringify(keysData));

        // Door lock API may return keys in different formats depending on provider
        const keys = keysData.data || keysData.keys || [];

        if (Array.isArray(keys) && keys.length > 0) {
          // Try common field names for the access code
          accessCode = keys[0].pin || keys[0].code || keys[0].accessCode || keys[0].pinCode || null;
          console.log("[Cloudbeds] Access code found:", accessCode ? "Yes" : "No");
        } else {
          console.log("[Cloudbeds] No door lock keys found for reservation");
        }
      } else {
        const keysError = await keysRes.text();
        console.warn("[Cloudbeds] Door lock API error:", keysRes.status, keysError);
      }
    } catch (doorErr) {
      // Non-fatal - property might not use Cloudbeds door locks
      console.warn("[Cloudbeds] Door lock API exception (non-fatal):", doorErr.message);
    }

    // 4. Return the combined data
    const result = {
      success: true,
      reservationId: reservation_id,
      roomName,
      accessCode,
      guestName: reservationData.data?.guestName || null,
      checkInDate: reservationData.data?.startDate || null,
      checkOutDate: reservationData.data?.endDate || null,
      status: reservationData.data?.status || null,
    };

    console.log("[Cloudbeds] Returning result:", {
      roomName: result.roomName,
      accessCode: result.accessCode ? "***" : null,
      guestName: result.guestName,
    });

    return res.status(200).json(result);

  } catch (e) {
    console.error("[Cloudbeds] Reservation lookup error:", e);
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
