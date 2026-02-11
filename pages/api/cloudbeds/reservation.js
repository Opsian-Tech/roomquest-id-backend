// shaisaiah verify.js — PRODUCTION SAFE PRE-CHECK-IN VERSION

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

function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}

function normKey(v) {
  return norm(v).replace(/\s+/g, "").replace(/[_-]/g, "");
}

function normalizeStatus(status) {
  return normKey(status);
}

async function fetchCloudbedsAPI(url, headers) {
  console.log("[VERIFY] Cloudbeds URL:", url);

  const cbRes = await fetch(url, { headers });

  if (!cbRes.ok) {
    const errText = await cbRes.text().catch(() => "");
    console.error("[VERIFY] Cloudbeds API error:", cbRes.status, errText);
    const err = new Error(`Cloudbeds API request failed: ${cbRes.status}`);
    err.status = cbRes.status;
    throw err;
  }

  const cbData = await cbRes.json();

  if (!cbData?.success) {
    const err = new Error("Cloudbeds API returned success=false");
    err.status = 502;
    throw err;
  }

  return cbData;
}

function getReservationIdFromRow(row) {
  return row?.reservationID || row?.reservationId || row?.reservation_id || null;
}

function looksLikeCloudbedsReservationId(id) {
  const s = String(id || "").trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

function isReservationStatusValid(statusRaw) {
  const status = normalizeStatus(statusRaw);

  // Block invalid states
  if (["cancelled", "canceled", "noshow"].includes(status)) {
    return false;
  }

  // Allow everything else (confirmed, reserved, checkedin, inhouse, etc.)
  return true;
}

function isWithinStayWindow(startDate, endDate) {
  if (!startDate || !endDate) return true;

  const now = new Date();
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Prevent early check-in
  if (now < start) return false;

  // Prevent expired reservation
  if (now > end) return false;

  return true;
}

function extractRoomName(fullReservation) {
  const assigned = Array.isArray(fullReservation?.assigned)
    ? fullReservation.assigned
    : [];

  if (!assigned.length) return null;

  return (
    assigned[0]?.roomName ||
    assigned[0]?.roomNumber ||
    assigned[0]?.roomTypeName ||
    null
  );
}

function extractDoorCode(fullReservation) {
  const direct = [
    fullReservation?.accessCode,
    fullReservation?.doorCode,
    fullReservation?.roomAccessCode,
  ].filter(Boolean);

  if (direct.length) return String(direct[0]);

  const customFields = Array.isArray(fullReservation?.customFields)
    ? fullReservation.customFields
    : [];

  const match = customFields.find((f) => {
    const blob = norm(
      `${f?.customFieldName} ${f?.customFieldShortcode} ${f?.customFieldID}`
    );

    return (
      (blob.includes("door") && blob.includes("code")) ||
      blob.includes("keycode") ||
      blob.includes("pin")
    );
  });

  if (match) {
    return String(
      match?.customFieldValue ||
      match?.custom_field_value ||
      match?.value ||
      ""
    );
  }

  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    if (!CLOUDBED_API_KEY)
      return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_API_KEY" });

    if (!CLOUDBEDS_PROPERTY_ID)
      return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_PROPERTY_EXTERNAL_ID" });

    const {
      reservation_id,
      third_party_identifier,
      source_reservation_id,
      channel_reservation_id,
      third_party_reservation_id,
      ota_reservation_id,
    } = req.body || {};

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    const otaIdentifier =
      third_party_identifier ||
      source_reservation_id ||
      channel_reservation_id ||
      third_party_reservation_id ||
      ota_reservation_id;

    let rid = null;

    // ===============================
    // STEP 1: Resolve reservationID
    // ===============================
    if (otaIdentifier) {
      const url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${encodeURIComponent(
        otaIdentifier
      )}`;

      const cbData = await fetchCloudbedsAPI(url, headers);
      const list = Array.isArray(cbData?.data)
        ? cbData.data
        : cbData?.data
        ? [cbData.data]
        : [];

      if (!list.length)
        return res.status(404).json({ success: false, error: "Reservation not found" });

      for (const row of list) {
        const candidate = getReservationIdFromRow(row);
        if (looksLikeCloudbedsReservationId(candidate)) {
          rid = candidate;
          break;
        }
      }

      if (!rid)
        return res.status(404).json({
          success: false,
          error: "Could not resolve Cloudbeds reservationID",
        });
    } else if (reservation_id) {
      rid = reservation_id;
    } else {
      return res.status(400).json({
        success: false,
        error: "Missing reservation identifier",
      });
    }

    // ===============================
    // STEP 2: Fetch full reservation
    // ===============================
    const fullUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${encodeURIComponent(
      rid
    )}`;

    const fullData = await fetchCloudbedsAPI(fullUrl, headers);
    const fullReservation = fullData?.data;

    if (!fullReservation)
      return res.status(404).json({ success: false, error: "Reservation not found" });

    const status = fullReservation?.status;

    console.log("[VERIFY] Reservation status:", status);

    // ===============================
    // STEP 3: Status validation
    // ===============================
    if (!isReservationStatusValid(status)) {
      return res.status(400).json({
        success: false,
        error: "Reservation not valid",
        status,
      });
    }

    // ===============================
    // STEP 4: Date validation
    // ===============================
    if (
      !isWithinStayWindow(
        fullReservation?.startDate,
        fullReservation?.endDate
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "Reservation not within valid stay dates",
      });
    }

    // ===============================
    // STEP 5: Extract room + access
    // ===============================
    const roomName = extractRoomName(fullReservation);
    const accessCode = extractDoorCode(fullReservation);

    return res.status(200).json({
      success: true,
      reservationId:
        fullReservation?.reservationID ||
        fullReservation?.reservationId ||
        rid,
      guestName: fullReservation?.guestName || null,
      roomName,
      accessCode,
      checkInDate: fullReservation?.startDate || null,
      checkOutDate: fullReservation?.endDate || null,
      status,
    });
  } catch (e) {
    console.error("[VERIFY] ERROR:", e?.message || e);

    return res.status(500).json({
      success: false,
      error: e?.message || "Server error",
    });
  }
}
