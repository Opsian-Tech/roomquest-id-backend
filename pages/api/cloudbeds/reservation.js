// pages/api/cloudbeds/reservation.js
const CLOUDBED_API_KEY = process.env.CLOUDBEDS_API_KEY;
const CLOUDBEDS_PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_EXTERNAL_ID;
const CLOUDBEDS_API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, Accept, Origin, Authorization");
}

function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}
function normKey(v) {
  return norm(v).replace(/\s+/g, "").replace(/[_-]/g, "");
}
function isCheckedInStatus(status) {
  const s = normKey(status);
  return s === "checkedin" || s === "inhouse";
}

async function fetchCloudbedsAPI(url, headers) {
  const cbRes = await fetch(url, { headers });
  const text = await cbRes.text().catch(() => "");
  let cbData = {};
  try {
    cbData = text ? JSON.parse(text) : {};
  } catch {
    // ignore parse fail
  }

  if (!cbRes.ok) {
    console.error("[Cloudbeds] API error:", cbRes.status, text);
    const err = new Error(`Cloudbeds API request failed: ${cbRes.status}`);
    err.status = cbRes.status;
    err.body = text;
    throw err;
  }

  if (!cbData?.success) {
    console.error("[Cloudbeds] success=false payload:", cbData);
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

function extractRoomName(fullReservation, sub_reservation_id) {
  let assigned = fullReservation?.assigned || [];
  if (!Array.isArray(assigned)) assigned = [];

  if (sub_reservation_id && assigned.length > 1) {
    const subMatch = assigned.find((s) => String(s?.subReservationID) === String(sub_reservation_id));
    if (subMatch) assigned = [subMatch];
  }

  if (!assigned.length) return null;

  return (
    assigned[0]?.roomName ||
    assigned[0]?.roomNumber ||
    assigned[0]?.room ||
    assigned[0]?.roomTypeName ||
    assigned[0]?.roomType ||
    null
  );
}

function getCustomFieldValue(f) {
  return f?.customFieldValue ?? f?.custom_field_value ?? f?.value ?? f?.Value ?? null;
}

function extractDoorCode(fullReservation, sub_reservation_id) {
  const top = [
    fullReservation?.accessCode,
    fullReservation?.access_code,
    fullReservation?.doorCode,
    fullReservation?.door_code,
    fullReservation?.roomAccessCode,
    fullReservation?.room_access_code,
  ].filter(Boolean);
  if (top.length) return String(top[0]);

  let assigned = fullReservation?.assigned || [];
  if (!Array.isArray(assigned)) assigned = [];

  if (sub_reservation_id && assigned.length > 1) {
    const subMatch = assigned.find((s) => String(s?.subReservationID) === String(sub_reservation_id));
    if (subMatch) assigned = [subMatch];
  }

  if (assigned.length) {
    const a = assigned[0];
    const aTop = [
      a?.doorCode, a?.door_code,
      a?.accessCode, a?.access_code,
      a?.roomAccessCode, a?.room_access_code,
    ].filter(Boolean);
    if (aTop.length) return String(aTop[0]);
  }

  const customFields = Array.isArray(fullReservation?.customFields) ? fullReservation.customFields : [];
  const pick = customFields.find((f) => {
    const name = norm(f?.customFieldName || "");
    const shortcode = norm(f?.customFieldShortcode ?? f?.customFieldShortCode ?? "");
    const id = norm(f?.customFieldID || "");
    const blob = `${name} ${shortcode} ${id}`;

    return (
      (blob.includes("door") && blob.includes("code")) ||
      blob.includes("doorcode") ||
      blob.includes("roomaccess") ||
      blob.includes("keycode") ||
      blob.includes("pin") ||
      (blob.includes("code") && blob.includes("lock"))
    );
  });

  if (pick) {
    const v = getCustomFieldValue(pick);
    if (v) return String(v);
  }

  return null;
}

async function resolveRidFromOta(otaIdentifier, headers) {
  const base = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${encodeURIComponent(CLOUDBEDS_PROPERTY_ID)}`;

  const paramCandidates = [
    ["thirdPartyIdentifier", otaIdentifier],
    ["sourceReservationID", otaIdentifier],
    ["sourceReservationId", otaIdentifier],
    ["channelReservationID", otaIdentifier],
    ["channelReservationId", otaIdentifier],
    ["thirdPartyReservationID", otaIdentifier],
    ["thirdPartyReservationId", otaIdentifier],
  ];

  for (const [k, v] of paramCandidates) {
    const url = `${base}&${k}=${encodeURIComponent(String(v))}`;
    try {
      const cbData = await fetchCloudbedsAPI(url, headers);
      const list = Array.isArray(cbData?.data) ? cbData.data : cbData?.data ? [cbData.data] : [];
      if (!list.length) continue;

      for (const row of list) {
        const candidate = getReservationIdFromRow(row);
        if (looksLikeCloudbedsReservationId(candidate)) return candidate;
      }

      const fallback = getReservationIdFromRow(list[0]);
      if (looksLikeCloudbedsReservationId(fallback)) return fallback;
    } catch {
      // miss, continue
    }
  }

  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    if (!CLOUDBED_API_KEY) return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_API_KEY" });
    if (!CLOUDBEDS_PROPERTY_ID) return res.status(500).json({ success: false, error: "Missing CLOUDBEDS_PROPERTY_EXTERNAL_ID" });

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

    const otaIdentifier =
      third_party_identifier ||
      source_reservation_id ||
      channel_reservation_id ||
      third_party_reservation_id ||
      ota_reservation_id;

    let rid = null;

    // ---- ALWAYS RESOLVE RID FIRST ----
    if (otaIdentifier) {
      rid = await resolveRidFromOta(String(otaIdentifier), headers);
      if (!rid) {
        return res.status(404).json({ success: false, error: "Could not resolve Cloudbeds reservationID from OTA identifier" });
      }
    } else if (sub_reservation_id) {
      rid = String(sub_reservation_id).split("-")[0];
    } else if (reservation_id) {
      rid = String(reservation_id);
    } else {
      return res.status(400).json({ success: false, error: "Missing reservation identifier" });
    }

    // ---- ALWAYS FETCH FULL RESERVATION USING RID ----
    const fullUrl = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${encodeURIComponent(CLOUDBEDS_PROPERTY_ID)}&reservationID=${encodeURIComponent(String(rid))}`;
    const fullData = await fetchCloudbedsAPI(fullUrl, headers);
    const fullReservation = fullData?.data;

    if (!fullReservation) return res.status(404).json({ success: false, error: "Reservation not found" });

    const roomName =
      extractRoomName(fullReservation, sub_reservation_id) ||
      fullReservation?.roomName ||
      fullReservation?.roomNumber ||
      null;

    const accessCode = extractDoorCode(fullReservation, sub_reservation_id);

    const status = fullReservation?.status || null;

    return res.status(200).json({
      success: true,
      reservationId: fullReservation?.reservationID || fullReservation?.reservationId || rid,
      roomName,
      accessCode,
      guestName: fullReservation?.guestName || null,
      checkInDate: fullReservation?.startDate || null,
      checkOutDate: fullReservation?.endDate || null,
      status,
      otaIdentifier: otaIdentifier ? String(otaIdentifier) : null,
      guestIsCheckedIn: isCheckedInStatus(status),
    });
  } catch (e) {
    console.error("[Cloudbeds] ERROR:", e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || "Server error" });
  }
}
