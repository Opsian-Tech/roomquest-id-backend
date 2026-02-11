// pages/api/cloudbeds/search-by-name.js
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

/**
 * Helper to compare names with fuzzy matching
 */
function namesMatch(name1, name2) {
  if (!name1 || !name2) return false;
  
  const normalize = (s) => s.trim().toLowerCase()
    .replace(/[,.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const n1 = normalize(name1);
  const n2 = normalize(name2);
  
  if (n1 === n2) return true;
  
  const parts1 = n1.split(' ').filter(p => p.length > 1);
  const parts2 = n2.split(' ').filter(p => p.length > 1);
  
  const shorter = parts1.length <= parts2.length ? parts1 : parts2;
  const longer = parts1.length <= parts2.length ? parts2 : parts1;
  
  const matchCount = shorter.filter(sp => longer.includes(sp)).length;
  const minRequired = shorter.length === 1 ? 1 : 2;
  
  return matchCount >= minRequired;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!CLOUDBED_API_KEY) {
      return res.status(500).json({ error: "Missing CLOUDBED_API_KEY" });
    }

    const { guest_name, booking_ref } = req.body || {};

    if (!guest_name) {
      return res.status(400).json({ error: "Missing guest_name" });
    }

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    // Get upcoming reservations (today + 30 days)
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const checkInStart = today.toISOString().split('T')[0];
    const checkInEnd = futureDate.toISOString().split('T')[0];

    const url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&checkInFrom=${checkInStart}&checkInTo=${checkInEnd}`;

    console.log(`[Cloudbeds Search] Searching for guest: "${guest_name}", booking_ref: "${booking_ref}"`);
    console.log(`[Cloudbeds Search] Fetching:`, url);

    const cbRes = await fetch(url, { headers });

    if (!cbRes.ok) {
      const errText = await cbRes.text();
      console.error("[Cloudbeds Search] API error:", cbRes.status, errText);
      throw new Error("Cloudbeds API request failed");
    }

    const cbData = await cbRes.json();

    if (!cbData.success || !cbData.data) {
      throw new Error("No reservations found");
    }

    const reservations = Array.isArray(cbData.data) ? cbData.data : [cbData.data];
    
    console.log(`[Cloudbeds Search] Found ${reservations.length} total reservations`);

    // Find matching reservation by name
    const matches = reservations.filter(r => {
      const matchByName = namesMatch(guest_name, r.guestName || "");
      const matchByRef = booking_ref && (
        r.reservationID === booking_ref ||
        r.thirdPartyIdentifier === booking_ref ||
        r.sourceReservationID === booking_ref
      );

      return matchByName || matchByRef;
    });

    console.log(`[Cloudbeds Search] Found ${matches.length} matching reservations`);

    if (matches.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No reservation found matching guest name",
      });
    }

    // If multiple matches, prefer the one matching booking_ref
    let reservation = matches[0];
    if (matches.length > 1 && booking_ref) {
      const exactMatch = matches.find(r => 
        r.reservationID === booking_ref ||
        r.thirdPartyIdentifier === booking_ref ||
        r.sourceReservationID === booking_ref
      );
      if (exactMatch) reservation = exactMatch;
    }

    // Extract room and access code
    let assigned = reservation.assigned || [];
    let roomName = null;
    if (assigned.length > 0) {
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
    }

    // Extract door code from custom fields - check multiple common field names
    let accessCode = null;
    const customFields = reservation.customFields || [];
    
    // Try common door code field names (case-sensitive exact match first)
    const doorCodeFieldNames = [
      "DOORCODE",
      "Door Code",
      "door code",
      "Door code",
      "Access Code",
      "access code",
      "Access code",
      "Room Code",
      "room code",
      "Lock Code",
      "lock code",
      "Key Code",
      "key code",
      "Room Key Passcode",
      "room key passcode",
      "Room key passcode",
      "Passcode",
      "passcode",
    ];
    
    for (const fieldName of doorCodeFieldNames) {
      const field = customFields.find((f) => f && String(f.customFieldName || "").trim() === fieldName);
      if (field && field.customFieldValue != null && String(field.customFieldValue).trim() !== "") {
        accessCode = String(field.customFieldValue).trim();
        break;
      }
    }
    
    // Fallback: case-insensitive search for any field containing "door", "code", "access", "key", "lock", or "passcode"
    if (!accessCode && customFields.length > 0) {
      const lowerNames = ["door", "code", "access", "key", "lock", "passcode"];
      const fallback = customFields.find((f) => {
        if (!f || !f.customFieldName || !f.customFieldValue) return false;
        const value = String(f.customFieldValue).trim();
        if (value === "") return false;
        const name = String(f.customFieldName).toLowerCase();
        return lowerNames.some((k) => name.includes(k));
      });
      if (fallback) {
        accessCode = String(fallback.customFieldValue).trim();
      }
    }
    
    // Log available custom field names if no door code found (for debugging)
    if (!accessCode && customFields.length > 0) {
      const fieldNames = customFields.map((f) => f?.customFieldName).filter(Boolean);
      const fieldDetails = customFields.map((f) => ({
        name: f?.customFieldName,
        value: f?.customFieldValue ? String(f.customFieldValue).substring(0, 20) + "..." : null
      }));
      console.warn("[Cloudbeds Search] No door code found. Available custom fields:", fieldNames.join(", "));
      console.warn("[Cloudbeds Search] Custom field details:", JSON.stringify(fieldDetails, null, 2));
    } else if (!accessCode) {
      console.warn("[Cloudbeds Search] No custom fields found on reservation");
    } else {
      console.log("[Cloudbeds Search] Door code found:", accessCode);
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

    console.log(`[Cloudbeds Search] Match found:`, result);
    return res.status(200).json(result);
  } catch (e) {
    console.error("[Cloudbeds Search] Error:", e);
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
