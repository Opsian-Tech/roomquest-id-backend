// pages/api/cloudbeds/reservation.js

const CLOUDBED_API_KEY = process.env.CLOUDBEDS_API_KEY;
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
    if (!CLOUDBED_API_KEY) {
      return res.status(500).json({ error: "Missing CLOUDBED_API_KEY" });
    }

    const { reservation_id, third_party_identifier, sub_reservation_id } = req.body || {};

    if (!reservation_id && !third_party_identifier && !sub_reservation_id) {
      return res.status(400).json({ error: "Missing reservation identifier" });
    }

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    let reservation;

    if (third_party_identifier) {
      // Step 1: Search by third-party identifier (returns summary array)
      const searchUrl = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${third_party_identifier}`;
      console.log("[Cloudbeds] Step 1 - Searching by thirdPartyIdentifier:", searchUrl);

      const searchRes = await fetch(searchUrl, { headers });
      if (!searchRes.ok) {
        const errText = await searchRes.text();
        console.error("[Cloudbeds] Search API error:", searchRes.status, errText);
        throw new Error("Cloudbeds API request failed");
      }

      const searchData = await searchRes.json();
      if (!searchData.success || !searchData.data) {
        throw new Error("Reservation not found");
      }

      const results = Array.isArray(searchData.data) ? searchData.data : [searchData.data];
      if (results.length === 0) throw new Error("Reservation not found");

      const foundId = results[0].reservationID;
      if (!foundId) throw new Error("Reservation found but missing reservationID");

      console.log("[Cloudbeds] Step 2 - Fetching full details for reservationID:", foundId);

      // Step 2: Get full reservation details using the found reservationID
      const detailUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${foundId}`;
      const detailRes = await fetch(detailUrl, { headers });
      if (!detailRes.ok) {
        const errText = await detailRes.text();
        console.error("[Cloudbeds] Detail API error:", detailRes.status, errText);
        throw new Error("Failed to fetch full reservation details");
      }

      const detailData = await detailRes.json();
      if (!detailData.success || !detailData.data) {
        throw new Error("Failed to load reservation details");
      }

      reservation = detailData.data;
    } else if (sub_reservation_id) {
      const mainId = sub_reservation_id.split("-")[0];
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${mainId}`;
      console.log("[Cloudbeds] Fetching:", url);

      const cbRes = await fetch(url, { headers });
      if (!cbRes.ok) {
        const errText = await cbRes.text();
        console.error("[Cloudbeds] API error:", cbRes.status, errText);
        throw new Error("Cloudbeds API request failed");
      }

      const cbData = await cbRes.json();
      if (!cbData.success || !cbData.data) throw new Error("Reservation not found");
      reservation = cbData.data;
    } else {
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${reservation_id}`;
      console.log("[Cloudbeds] Fetching:", url);

      const cbRes = await fetch(url, { headers });
      if (!cbRes.ok) {
        const errText = await cbRes.text();
        console.error("[Cloudbeds] API error:", cbRes.status, errText);
        throw new Error("Cloudbeds API request failed");
      }

      const cbData = await cbRes.json();
      if (!cbData.success || !cbData.data) throw new Error("Reservation not found");
      reservation = cbData.data;
    }

    // Handle sub-reservation filtering
    let assigned = reservation.assigned || [];
    if (sub_reservation_id && assigned.length > 1) {
      const subMatch = assigned.find(
        (s) => String(s.subReservationID) === String(sub_reservation_id)
      );
      if (subMatch) assigned = [subMatch];
    }

    let roomName = null;
    if (assigned.length > 0) {
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
    }

    let accessCode = null;
    const customFields = reservation.customFields || [];
    const doorCodeField = customFields.find((f) => f.customFieldName === "Door Code");
    if (doorCodeField) {
      accessCode = doorCodeField.customFieldValue;
    }

    const result = {
      success: true,
      reservationId: reservation.reservationID,
      roomName,
      accessCode,
      guestName: reservation.guestName || null,
      checkInDate: reservation.startDate || null,
      checkOutDate: reservation.endDate || null,
      status: reservation.status || null,
    };

    console.log("[Cloudbeds] Success:", result);
    return res.status(200).json(result);
  } catch (e) {
    console.error("[Cloudbeds] Error:", e);
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
