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

    const {
      reservation_id,
      third_party_identifier,
      source_reservation_id,
      channel_reservation_id,
      third_party_reservation_id,
      ota_reservation_id,
      sub_reservation_id,
    } = req.body || {};

    if (
      !reservation_id &&
      !third_party_identifier &&
      !source_reservation_id &&
      !channel_reservation_id &&
      !third_party_reservation_id &&
      !ota_reservation_id &&
      !sub_reservation_id
    ) {
      return res.status(400).json({ error: "Missing reservation identifier" });
    }

    const headers = {
      Authorization: `Bearer ${CLOUDBED_API_KEY}`,
      "Content-Type": "application/json",
    };

    let url;
    let lookupType;

    if (sub_reservation_id) {
      const mainId = sub_reservation_id.split("-")[0];
      url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${mainId}`;
      lookupType = "sub_reservation_id";
    } else if (reservation_id) {
      url = `${CLOUDBEDS_API_BASE}/getReservation?propertyID=${CLOUDBEDS_PROPERTY_ID}&reservationID=${reservation_id}`;
      lookupType = "reservation_id";
    } else if (
      source_reservation_id ||
      third_party_identifier ||
      channel_reservation_id ||
      third_party_reservation_id ||
      ota_reservation_id
    ) {
      // All OTA/third-party lookups use thirdPartyIdentifier parameter
      // Priority order: source_reservation_id > third_party_identifier > others
      const identifier =
        source_reservation_id ||
        third_party_identifier ||
        channel_reservation_id ||
        third_party_reservation_id ||
        ota_reservation_id;

      url = `${CLOUDBEDS_API_BASE}/getReservations?propertyID=${CLOUDBEDS_PROPERTY_ID}&thirdPartyIdentifier=${identifier}`;

      if (source_reservation_id) lookupType = "source_reservation_id";
      else if (third_party_identifier) lookupType = "third_party_identifier";
      else if (channel_reservation_id) lookupType = "channel_reservation_id";
      else if (third_party_reservation_id) lookupType = "third_party_reservation_id";
      else lookupType = "ota_reservation_id";
    }

    console.log(`[Cloudbeds] Fetching via ${lookupType}:`, url);

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

    // getReservations returns an array, getReservation returns an object
    let reservation = cbData.data;
    if (Array.isArray(reservation)) {
      if (reservation.length === 0) throw new Error("Reservation not found");
      reservation = reservation[0];
    }

    // If sub_reservation_id was used, find the matching sub-reservation
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
    const doorCodeField = customFields.find((f) => f.customFieldName === "DOORCODE");
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

    console.log(`[Cloudbeds] Success via ${lookupType}:`, result);
    return res.status(200).json(result);
  } catch (e) {
    console.error("[Cloudbeds] Error:", e);
    return res.status(500).json({
      success: false,
      error: e.message || "Server error",
    });
  }
}
