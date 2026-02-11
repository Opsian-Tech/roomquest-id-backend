//DIAGNOSTIC reservation.js - Maximum logging for door code debugging
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

async function fetchCloudbedsAPI(url, headers) {
  console.log("[Cloudbeds] ========== API CALL ==========");
  console.log("[Cloudbeds] URL:", url);
  const cbRes = await fetch(url, { headers });
  
  if (!cbRes.ok) {
    const errText = await cbRes.text();
    console.error("[Cloudbeds] API error:", cbRes.status, errText);
    throw new Error(`Cloudbeds API request failed: ${cbRes.status}`);
  }
  
  const cbData = await cbRes.json();
  console.log("[Cloudbeds] ========== COMPLETE API RESPONSE ==========");
  console.log(JSON.stringify(cbData, null, 2));
  console.log("[Cloudbeds] ================================================");
  
  if (!cbData.success) {
    throw new Error("Cloudbeds API returned success=false");
  }
  
  return cbData;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    console.log("[Cloudbeds] ========== NEW REQUEST ==========");
    console.log("[Cloudbeds] Request body:", JSON.stringify(req.body, null, 2));
    
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

    // Determine which identifier we're using
    const otaIdentifier = third_party_identifier || 
                          source_reservation_id || 
                          channel_reservation_id || 
                          third_party_reservation_id || 
                          ota_reservation_id;

    let mainReservation = null;
    let isOtaLookup = false;

    // STEP 1: Initial lookup
    if (otaIdentifier) {
      console.log("[Cloudbeds] STEP 1: OTA lookup with identifier:", otaIdentifier);
      isOtaLookup = true;
      
      const url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${otaIdentifier}`;
      const cbData = await fetchCloudbedsAPI(url, headers);
      
      if (!cbData.data || (Array.isArray(cbData.data) && cbData.data.length === 0)) {
        throw new Error("Reservation not found");
      }
      
      mainReservation = Array.isArray(cbData.data) ? cbData.data[0] : cbData.data;
      console.log("[Cloudbeds] OTA lookup found reservation ID:", mainReservation.reservationID);
      console.log("[Cloudbeds] Main reservation object keys:", Object.keys(mainReservation));
      
    } else if (sub_reservation_id) {
      console.log("[Cloudbeds] STEP 1: Sub-reservation lookup:", sub_reservation_id);
      const mainId = sub_reservation_id.split("-")[0];
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${mainId}`;
      const cbData = await fetchCloudbedsAPI(url, headers);
      
      if (!cbData.data) {
        throw new Error("Reservation not found");
      }
      
      mainReservation = cbData.data;
      
    } else if (reservation_id) {
      console.log("[Cloudbeds] STEP 1: Direct reservation lookup:", reservation_id);
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${reservation_id}`;
      const cbData = await fetchCloudbedsAPI(url, headers);
      
      if (!cbData.data) {
        throw new Error("Reservation not found");
      }
      
      mainReservation = cbData.data;
      
    } else {
      return res.status(400).json({ error: "Missing reservation identifier" });
    }

    // STEP 2: If this was an OTA lookup, fetch the full reservation details to get custom fields
    let fullReservation = mainReservation;
    
    if (isOtaLookup && mainReservation.reservationID) {
      console.log("[Cloudbeds] STEP 2: Fetching full reservation for door code:", mainReservation.reservationID);
      
      try {
        const fullUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${mainReservation.reservationID}`;
        const fullData = await fetchCloudbedsAPI(fullUrl, headers);
        
        if (fullData.data) {
          fullReservation = fullData.data;
          console.log("[Cloudbeds] Full reservation object keys:", Object.keys(fullReservation));
        }
      } catch (fullErr) {
        console.error("[Cloudbeds] Failed to fetch full reservation:", fullErr);
      }
    }

    // STEP 3: Extract room information
    console.log("[Cloudbeds] STEP 3: Extracting room information");
    let assigned = fullReservation.assigned || [];
    console.log("[Cloudbeds] Assigned array length:", assigned.length);
    if (assigned.length > 0) {
      console.log("[Cloudbeds] First assigned object:", JSON.stringify(assigned[0], null, 2));
    }
    
    if (sub_reservation_id && assigned.length > 1) {
      const subMatch = assigned.find(
        (s) => String(s.subReservationID) === String(sub_reservation_id)
      );
      if (subMatch) {
        assigned = [subMatch];
      }
    }

    let roomName = null;
    if (assigned.length > 0) {
      roomName = assigned[0].roomName || assigned[0].roomTypeName || null;
      console.log("[Cloudbeds] Room name:", roomName);
    }

    // STEP 4: Extract door code from custom fields
    console.log("[Cloudbeds] STEP 4: Extracting door code");
    let accessCode = null;
    const customFields = fullReservation.customFields || [];
    
    console.log("[Cloudbeds] Custom fields count:", customFields.length);
    console.log("[Cloudbeds] ========== ALL CUSTOM FIELDS ==========");
    console.log(JSON.stringify(customFields, null, 2));
    console.log("[Cloudbeds] ========================================");
    
    // Check each field individually with detailed logging
    customFields.forEach((field, index) => {
      console.log(`[Cloudbeds] Field ${index}:`, {
        customFieldName: field.customFieldName,
        customFieldID: field.customFieldID,
        customFieldShortcode: field.customFieldShortcode,
        customFieldValue: field.customFieldValue,
        value: field.value,
        allKeys: Object.keys(field)
      });
    });
    
    // Check for door code using multiple possible field identifiers
    const doorCodeField = customFields.find((f) => {
      const name = (f.customFieldName || "").toLowerCase().replace(/\s+/g, "");
      const id = (f.customFieldID || "").toLowerCase().replace(/\s+/g, "");
      const shortcode = (f.customFieldShortcode || "").toLowerCase().replace(/\s+/g, "");
      
      console.log("[Cloudbeds] Checking field:", {
        originalName: f.customFieldName,
        originalID: f.customFieldID,
        originalShortcode: f.customFieldShortcode,
        normalizedName: name,
        normalizedID: id,
        normalizedShortcode: shortcode
      });
      
      const matches = name === "doorcode" || 
             id === "doorcode" || 
             shortcode === "doorcode" ||
             name === "door_code" ||
             id === "door_code" ||
             shortcode === "door_code";
      
      if (matches) {
        console.log("[Cloudbeds] ✅ MATCH FOUND!");
      }
      
      return matches;
    });
    
    if (doorCodeField) {
      accessCode = doorCodeField.customFieldValue || doorCodeField.value;
      console.log("[Cloudbeds] ✅ Found door code:", accessCode);
      console.log("[Cloudbeds] Door code field:", JSON.stringify(doorCodeField, null, 2));
    } else {
      console.warn("[Cloudbeds] ❌ NO DOOR CODE FOUND");
      
      // FALLBACK: Check if door code is in the assigned array
      if (assigned.length > 0) {
        console.log("[Cloudbeds] Checking assigned array for door code...");
        console.log("[Cloudbeds] Assigned[0] keys:", Object.keys(assigned[0]));
        
        if (assigned[0].doorCode) {
          accessCode = assigned[0].doorCode;
          console.log("[Cloudbeds] ✅ Found door code in assigned array:", accessCode);
        } else {
          console.log("[Cloudbeds] ❌ No doorCode in assigned array");
        }
      }
    }

    // STEP 5: Build response
    console.log("[Cloudbeds] STEP 5: Building response");
    const result = {
      success: true,
      reservationId: fullReservation.reservationID,
      roomName,
      accessCode,
      guestName: fullReservation.guestName || null,
      checkInDate: fullReservation.startDate || null,
      checkOutDate: fullReservation.endDate || null,
      status: fullReservation.status || null,
      otaIdentifier: isOtaLookup ? otaIdentifier : null,
      guestIsCheckedIn: fullReservation.status === "checked_in" || fullReservation.status === "checked-in",
    };

    console.log("[Cloudbeds] ========== FINAL RESULT ==========");
    console.log(JSON.stringify(result, null, 2));
    console.log("[Cloudbeds] =====================================");
    
    return res.status(200).json(result);
    
  } catch (e) {
    console.error("[Cloudbeds] ========== ERROR ==========");
    console.error("[Cloudbeds] Error:", e);
    console.error("[Cloudbeds] Stack:", e.stack);
    console.error("[Cloudbeds] ===========================");
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
