//UPDATED reservation.js
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

    const { 
      reservation_id, 
      third_party_identifier, 
      sub_reservation_id,
      source_reservation_id,
      channel_reservation_id,
      third_party_reservation_id,
      ota_reservation_id
    } = req.body || {};

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    let url;
    let useReservationsEndpoint = false;

    // Handle OTA identifiers (these all use getReservations plural endpoint)
    const otaIdentifier = third_party_identifier || 
                          source_reservation_id || 
                          channel_reservation_id || 
                          third_party_reservation_id || 
                          ota_reservation_id;

    if (otaIdentifier) {
      useReservationsEndpoint = true;
      url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${otaIdentifier}`;
    } else if (sub_reservation_id) {
      const mainId = sub_reservation_id.split("-")[0];
      url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${mainId}`;
    } else if (reservation_id) {
      url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${reservation_id}`;
    } else {
      return res.status(400).json({ error: "Missing reservation identifier" });
    }

    console.log("[Cloudbeds] Fetching:", url);
    const cbRes = await fetch(url, { headers });

    if (!cbRes.ok) {
      const errText = await cbRes.text();
      console.error("[Cloudbeds] API error:", cbRes.status, errText);
      throw new Error("Cloudbeds API request failed");
    }

    const cbData = await cbRes.json();

    if (!cbData.success || !cbData.data) {
      throw new Error("Reservation not found");
    }

    let reservation = cbData.data;
    if (Array.isArray(reservation)) {
      if (reservation.length === 0) throw new Error("Reservation not found");
      reservation = reservation[0];
    }

    // ✅ NEW: If this was an OTA lookup, we need to fetch the actual Cloudbeds reservation
    // to get the door code (which is stored as a custom field on the main reservation)
    let doorCodeReservation = reservation;
    
    if (useReservationsEndpoint && reservation.reservationID) {
      console.log("[Cloudbeds] OTA lookup successful, fetching main reservation for door code:", reservation.reservationID);
      
      try {
        const doorCodeUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${reservation.reservationID}`;
        const doorCodeRes = await fetch(doorCodeUrl, { headers });
        
        if (doorCodeRes.ok) {
          const doorCodeData = await doorCodeRes.json();
          if (doorCodeData.success && doorCodeData.data) {
            doorCodeReservation = doorCodeData.data;
            console.log("[Cloudbeds] Successfully fetched door code from main reservation");
          }
        }
      } catch (doorCodeErr) {
        console.warn("[Cloudbeds] Failed to fetch door code from main reservation:", doorCodeErr);
        // Continue with original reservation data
      }
    }

    // Handle sub-reservations
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

    // ✅ Extract door code from the correct reservation object
    let accessCode = null;
    const customFields = doorCodeReservation.customFields || [];
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
      // ✅ NEW: Include the original OTA identifier used for lookup
      otaIdentifier: useReservationsEndpoint ? otaIdentifier : null,
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
