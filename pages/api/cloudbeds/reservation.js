// reservation.js — NEW (OTA-safe + better door code extraction + correct HTTP statuses)
//
// Fixes / Improvements:
// 1) Returns 404 (not 500) when a reservation is not found so callers can fallback to other identifiers cleanly
// 2) OTA lookup always uses /getReservations?thirdPartyIdentifier=... then fetches /getReservation for full details
// 3) Door code extraction is more robust:
//    - checks top-level fields (doorCode / door_code / roomAccessCode / accessCode variants)
//    - checks assigned[0] variants
//    - checks customFields with flexible matching ("door code", "door_code", "doorcode", etc)
// 4) Checked-in detection is more robust (checked_in / checked-in / in_house / in-house)
//
// Env:
// - CLOUDBEDS_API_KEY
// - CLOUDBEDS_PROPERTY_EXTERNAL_ID

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

function normalizeStr(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function normalizeKey(v) {
  return normalizeStr(v).replace(/\s+/g, "").replace(/[_-]/g, "");
}

function isCheckedInStatus(status) {
  const s = normalizeKey(status);
  return s === "checkedin" || s === "inhouse";
}

async function fetchCloudbedsAPI(url, headers) {
  console.log("[Cloudbeds] ========== API CALL ==========");
  console.log("[Cloudbeds] URL:", url);

  const cbRes = await fetch(url, { headers });

  if (!cbRes.ok) {
    const errText = await cbRes.text().catch(() => "");
    console.error("[Cloudbeds] API error:", cbRes.status, errText);
    const err = new Error(`Cloudbeds API request failed: ${cbRes.status}`);
    err.status = cbRes.status;
    err.body = errText;
    throw err;
  }

  const cbData = await cbRes.json();
  console.log("[Cloudbeds] ========== COMPLETE API RESPONSE ==========");
  console.log(JSON.stringify(cbData, null, 2));
  console.log("[Cloudbeds] ================================================");

  if (!cbData?.success) {
    const err = new Error("Cloudbeds API returned success=false");
    err.status = 502;
    throw err;
  }

  return cbData;
}

function extractRoomName(fullReservation, sub_reservation_id) {
  let assigned = fullReservation?.assigned || [];
  if (!Array.isArray(assigned)) assigned = [];

  if (sub_reservation_id && assigned.length > 1) {
    const subMatch = assigned.find(
      (s) => String(s?.subReservationID) === String(sub_reservation_id)
    );
    if (subMatch) assigned = [subMatch];
  }

  if (assigned.length === 0) return null;

  // Prefer the actual room name/number if assigned
  return (
    assigned[0]?.roomName ||
    assigned[0]?.roomNumber ||
    assigned[0]?.room ||
    assigned[0]?.roomTypeName ||
    assigned[0]?.roomType ||
    null
  );
}

function extractDoorCode(fullReservation, sub_reservation_id) {
  // 1) Top-level fields (different integrations name these differently)
  const topLevelCandidates = [
    fullReservation?.doorCode,
    fullReservation?.door_code,
    fullReservation?.roomAccessCode,
    fullReservation?.room_access_code,
    fullReservation?.accessCode,
    fullReservation?.access_code,
    fullReservation?.ttlockCode,
    fullReservation?.ttlock_code,
  ].filter(Boolean);

  if (topLevelCandidates.length) return String(topLevelCandidates[0]);

  // 2) Assigned fields (common place)
  let assigned = fullReservation?.assigned || [];
  if (!Array.isArray(assigned)) assigned = [];

  if (sub_reservation_id && assigned.length > 1) {
    const subMatch = assigned.find(
      (s) => String(s?.subReservationID) === String(sub_reservation_id)
    );
    if (subMatch) assigned = [subMatch];
  }

  if (assigned.length > 0) {
    const a = assigned[0];
    const assignedCandidates = [
      a?.doorCode,
      a?.door_code,
      a?.roomAccessCode,
      a?.room_access_code,
      a?.accessCode,
      a?.access_code,
    ].filter(Boolean);

    if (assignedCandidates.length) return String(assignedCandidates[0]);
  }

  // 3) Custom fields (flex matching)
  const customFields = Array.isArray(fullReservation?.customFields)
    ? fullReservation.customFields
    : [];

  const matchField = (f) => {
    const name = normalizeKey(f?.customFieldName);
    const id = normalizeKey(f?.customFieldID);
    const shortcode = normalizeKey(f?.customFieldShortcode);

    // Allow several variants
    const isDoor =
      name === "doorcode" ||
      name === "dooraccesscode" ||
      name === "roomaccesscode" ||
      id === "doorcode" ||
      id === "dooraccesscode" ||
      shortcode === "doorcode" ||
      shortcode === "dooraccesscode";

    // Also allow contains-style for safety (if someone names it "Door Code (TTLock)")
    const containsDoor =
      name.includes("doorcode") ||
      name.includes("dooraccess") ||
      name.includes("roomaccess") ||
      shortcode.includes("doorcode") ||
      shortcode.includes("dooraccess") ||
      shortcode.includes("roomaccess");

    return isDoor || containsDoor;
  };

  const doorField = customFields.find(matchField);
  if (doorField) {
    const v = doorField?.customFieldValue ?? doorField?.value ?? null;
    if (v) return String(v);
  }

  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    console.log("[Cloudbeds] ========== NEW REQUEST ==========");
    console.log("[Cloudbeds] Request body:", JSON.stringify(req.body, null, 2));

    if (!CLOUDBED_API_KEY) {
      return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_API_KEY" });
    }
    if (!CLOUDBEDS_PROPERTY_ID) {
      return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_PROPERTY_EXTERNAL_ID" });
    }

    const {
      reservation_id,
      third_party_identifier,
      sub_reservation_id,
      source_reservation_id,
      channel_reservation_id,
      third_party_reservation_id,
      ota_reservation_id,
    } = req.body || {};

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    // Treat any of these as "OTA identifiers" (Cloudbeds uses thirdPartyIdentifier param)
    const otaIdentifier =
      third_party_identifier ||
      source_reservation_id ||
      channel_reservation_id ||
      third_party_reservation_id ||
      ota_reservation_id;

    let mainReservation = null;
    let fullReservation = null;
    let isOtaLookup = false;

    // ==============
    // STEP 1: Lookup
    // ==============
    if (otaIdentifier) {
      isOtaLookup = true;
      console.log("[Cloudbeds] STEP 1: OTA lookup with thirdPartyIdentifier:", otaIdentifier);

      const url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${encodeURIComponent(
        otaIdentifier
      )}`;
      const cbData = await fetchCloudbedsAPI(url, headers);

      const list = Array.isArray(cbData?.data) ? cbData.data : cbData?.data ? [cbData.data] : [];
      if (!list.length) {
        return res.status(404).json({ success: false, error: "Reservation not found" });
      }

      mainReservation = list[0];
      console.log("[Cloudbeds] OTA lookup found reservationID:", mainReservation?.reservationID);
    } else if (sub_reservation_id) {
      console.log("[Cloudbeds] STEP 1: Sub-reservation lookup:", sub_reservation_id);
      const mainId = String(sub_reservation_id).split("-")[0];
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${encodeURIComponent(
        mainId
      )}`;

      const cbData = await fetchCloudbedsAPI(url, headers);
      if (!cbData?.data) return res.status(404).json({ success: false, error: "Reservation not found" });

      mainReservation = cbData.data;
    } else if (reservation_id) {
      console.log("[Cloudbeds] STEP 1: Direct reservation lookup:", reservation_id);
      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${encodeURIComponent(
        reservation_id
      )}`;

      const cbData = await fetchCloudbedsAPI(url, headers);
      if (!cbData?.data) return res.status(404).json({ success: false, error: "Reservation not found" });

      mainReservation = cbData.data;
    } else {
      return res.status(400).json({ success: false, error: "Missing reservation identifier" });
    }

    // ==========================
    // STEP 2: Fetch full details
    // ==========================
    // Even for direct lookup, normalize to "fullReservation" from getReservation response.
    if (mainReservation?.reservationID) {
      console.log("[Cloudbeds] STEP 2: Fetching full reservation details:", mainReservation.reservationID);

      const url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${encodeURIComponent(
        mainReservation.reservationID
      )}`;

      try {
        const fullData = await fetchCloudbedsAPI(url, headers);
        fullReservation = fullData?.data || null;
      } catch (e) {
        console.error("[Cloudbeds] Failed to fetch full reservation details:", e?.message || e);
        // If we can't fetch full, fall back to mainReservation (best effort)
        fullReservation = mainReservation;
      }
    } else {
      // Sometimes getReservation returns data without reservationID (rare). Use mainReservation.
      fullReservation = mainReservation;
    }

    if (!fullReservation) {
      return res.status(404).json({ success: false, error: "Reservation not found" });
    }

    // ==========================
    // STEP 3: Extract room + code
    // ==========================
    console.log("[Cloudbeds] STEP 3: Extracting room and door code");

    const roomName = extractRoomName(fullReservation, sub_reservation_id);
    const accessCode = extractDoorCode(fullReservation, sub_reservation_id);

    // ==========================
    // STEP 4: Build response
    // ==========================
    const status = fullReservation?.status || null;
    const result = {
      success: true,
      reservationId: fullReservation?.reservationID || mainReservation?.reservationID || null,
      roomName,
      accessCode,
      guestName: fullReservation?.guestName || mainReservation?.guestName || null,
      checkInDate: fullReservation?.startDate || mainReservation?.startDate || null,
      checkOutDate: fullReservation?.endDate || mainReservation?.endDate || null,
      status,
      otaIdentifier: isOtaLookup ? String(otaIdentifier) : null,
      guestIsCheckedIn: isCheckedInStatus(status),
    };

    console.log("[Cloudbeds] ========== FINAL RESULT ==========");
    console.log(JSON.stringify(result, null, 2));
    console.log("[Cloudbeds] =====================================");

    return res.status(200).json(result);
  } catch (e) {
    console.error("[Cloudbeds] ========== ERROR ==========");
    console.error("[Cloudbeds] Error:", e?.message || e);
    console.error("[Cloudbeds] Stack:", e?.stack || "no-stack");
    console.error("[Cloudbeds] ===========================");

    // If the upstream error indicates a 404-ish condition, propagate as 404
    const msg = String(e?.message || "");
    const status = e?.status === 404 || msg.includes("Reservation not found") ? 404 : 500;

    return res.status(status).json({
      success: false,
      error: e?.message || "Server error",
    });
  }
}
