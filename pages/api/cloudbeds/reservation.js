// pages/api/cloudbeds/reservation.js
// ✅ FIXED: Using API Key authentication instead of OAuth 2.0

const CLOUDBEDS_API_KEY = process.env.CLOUDBEDS_API_KEY;
const CLOUDBEDS_PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_EXTERNAL_ID;
const CLOUDBEDS_API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!CLOUDBEDS_API_KEY) {
      return res.status(500).json({ error: "Missing CLOUDBED_API_KEY" });
    }

    if (!CLOUDBEDS_PROPERTY_ID) {
      return res.status(500).json({ error: "Missing CLOUDBED_PROPERTY_ID" });
    }

    const { reservation_id } = req.body || {};

    if (!reservation_id) {
      return res.status(400).json({ error: "Missing reservation_id" });
    }

    console.log("[Cloudbeds] Looking up reservation:", reservation_id);

    // ✅ FIXED: Simple API Key authentication - no OAuth tokens needed!
    const headers = {
      "Authorization": `Bearer ${CLOUDBEDS_API_KEY}`,
      "Content-Type": "application/json",
    };

    // 1. Get reservation details from CloudBeds
    const reservationUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${encodeURIComponent(reservation_id)}`;
    console.log("[Cloudbeds] Fetching reservation from:", reservationUrl);

    const reservationRes = await fetch(reservationUrl, { headers });
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
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
      console.log("[Cloudbeds] Room assignment found:", roomName);
    } else {
      console.log("[Cloudbeds] No room assigned yet");
    }

    // 3. Get door lock access code (TT Lock integration)
    let accessCode = null;

    try {
      // Try CloudBeds door lock API if integrated
      const keysUrl = `https://api.cloudbeds.com/v2/keys?reservationId=${encodeURIComponent(reservation_id)}`;
      console.log("[Cloudbeds] Fetching door lock keys from:", keysUrl);

      const keysRes = await fetch(keysUrl, { headers });

      if (keysRes.ok) {
        const keysData = await keysRes.json();
        console.log("[Cloudbeds] Door lock response:", JSON.stringify(keysData));

        const keys = keysData.data || keysData.keys || [];

        if (Array.isArray(keys) && keys.length > 0) {
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