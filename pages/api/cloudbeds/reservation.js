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

async function findReservationByAnyId(searchId) {
  const headers = {
    "Authorization": `Bearer ${CLOUDBED_API_KEY}`,
    "Content-Type": "application/json",
  };

  // Step 1: Try direct CloudBeds reservation ID lookup
  try {
    const directUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${searchId}`;
    const res = await fetch(directUrl, { headers });
    const data = await res.json();
    
    if (data.success) {
      console.log("[Cloudbeds] Found by direct reservationID");
      return data.data;
    }
  } catch (e) {
    console.log("[Cloudbeds] Direct lookup failed, searching all reservations");
  }

  // Step 2: Search through all reservations for thirdPartyIdentifier (Agoda/Expedia ID)
  const listUrl = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}`;
  const res = await fetch(listUrl, { headers });
  const data = await res.json();
  
  if (!data.success || !data.data) {
    throw new Error("Failed to fetch reservations");
  }

  // Search for matching thirdPartyIdentifier or reservationID
  const found = data.data.find(r => 
    r.reservationID === searchId || 
    r.thirdPartyIdentifier === searchId
  );
  
  if (!found) {
    throw new Error("Reservation not found");
  }

  console.log("[Cloudbeds] Found by thirdPartyIdentifier:", found.reservationID);
  
  // Now get full details using the CloudBeds reservationID
  const detailUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${found.reservationID}`;
  const detailRes = await fetch(detailUrl, { headers });
  const detailData = await detailRes.json();
  
  return detailData.success ? detailData.data : found;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!CLOUDBED_API_KEY) {
      return res.status(500).json({ error: "Missing CLOUDBED_API_KEY" });
    }

    const { reservation_id } = req.body || {};
    if (!reservation_id) {
      return res.status(400).json({ error: "Missing reservation_id" });
    }

    console.log("[Cloudbeds] Searching for:", reservation_id);

    const reservation = await findReservationByAnyId(reservation_id);
    
    const assigned = reservation.assigned || [];
    let roomName = null;
    if (assigned.length > 0) {
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
    }

    const result = {
      success: true,
      reservationId: reservation.reservationID,
      roomName,
      accessCode: null, // You'll handle this separately
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