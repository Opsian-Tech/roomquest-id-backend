// verify.js - v2 UPDATED (Fixes: OTA overwrite-to-null + get_session key mismatch)
// - Prevents verify_face from overwriting valid physical_room/room_access_code with null if Cloudbeds lookup fails
// - Prefers cloudbeds_reservation_id for lookup when available (works for OTA thirdPartyIdentifier flows)
// - get_session now returns BOTH snake_case and camelCase room access code keys for frontend compatibility

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";
import { TextractClient, AnalyzeIDCommand } from "@aws-sdk/client-textract";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AWS_REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET_NAME;
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

/**
 * BUILD MARKER
 */
const BUILD_ID = "cloudbeds-integration-v1-ota-fixed-v2";

if (!SUPABASE_URL) console.warn("Missing env: NEXT_PUBLIC_SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) console.warn("Missing env: SUPABASE_SERVICE_KEY");
if (!AWS_REGION) console.warn("Missing env: AWS_REGION");
if (!BUCKET) console.warn("Missing env: S3_BUCKET_NAME");
if (!BACKEND_URL) console.warn("Missing env: NEXT_PUBLIC_BACKEND_URL");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const rekognition = new RekognitionClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const textract = new TextractClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

async function fetchCloudbedsReservation(bookingRef) {
  console.log("[Cloudbeds] Fetching reservation:", bookingRef);

  const lookups = [
    { reservation_id: bookingRef },
    { third_party_identifier: bookingRef },
    { source_reservation_id: bookingRef },
    { channel_reservation_id: bookingRef },
    { third_party_reservation_id: bookingRef },
    { ota_reservation_id: bookingRef },
  ];

  if (String(bookingRef).includes("-")) {
    lookups.push({
      reservation_id: String(bookingRef).split("-")[0],
      sub_reservation_id: bookingRef,
    });
  }

  for (const body of lookups) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/cloudbeds/reservation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) continue;

      const data = await res.json();

      if (data?.success) {
        console.log("[Cloudbeds] Found via", Object.keys(body)[0], ":", {
          guestName: data.guestName,
          roomName: data.roomName,
          accessCode: data.accessCode,
          reservationId: data.reservationId,
          otaIdentifier: data.otaIdentifier,
        });
        return data;
      }
    } catch (e) {
      console.warn("[Cloudbeds] Lookup failed for", body, e?.message || e);
    }
  }

  throw new Error("Reservation not found in Cloudbeds");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version"
  );
}

function generateToken() {
  return crypto.randomBytes(9).toString("base64url");
}

function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function getGuestIsCheckedIn(cloudbeds) {
  const v =
    cloudbeds?.guestIsCheckedIn ??
    cloudbeds?.isCheckedIn ??
    cloudbeds?.checkedIn ??
    cloudbeds?.reservationCheckedIn ??
    cloudbeds?.is_checked_in ??
    cloudbeds?.checked_in;

  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "checkedin", "checked_in", "checked-in", "1"].includes(s)) return true;
    if (["false", "no", "n", "notcheckedin", "not_checked_in", "not-checked-in", "0"].includes(s))
      return false;
  }
  return true; // backward-compatible default
}

async function streamToBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeBase64(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("data:image/")) return v.replace(/^data:image\/\w+;base64,/, "");
  return v;
}

function normalizeFlowType(v) {
  return String(v || "").toLowerCase() === "visitor" ? "visitor" : "guest";
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(Math.trunc(x), min), max);
}

function safeJson(res, status, payload) {
  return res.status(status).json({ ...payload, build_id: BUILD_ID });
}

/**
 * Helper to compare names with fuzzy matching
 */
function namesMatch(name1, name2) {
  if (!name1 || !name2) return false;

  const normalize = (s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[,.\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  console.log("[namesMatch] Raw inputs:", { name1, name2 });
  console.log("[namesMatch] Normalized:", { n1, n2 });

  if (n1 === n2) {
    console.log("[namesMatch] Exact match found");
    return true;
  }

  const parts1 = n1.split(" ").filter((p) => p.length > 1);
  const parts2 = n2.split(" ").filter((p) => p.length > 1);

  console.log("[namesMatch] Parts:", { parts1, parts2 });

  const shorter = parts1.length <= parts2.length ? parts1 : parts2;
  const longer = parts1.length <= parts2.length ? parts2 : parts1;

  const matchCount = shorter.filter((sp) => longer.includes(sp)).length;
  const minRequired = shorter.length === 1 ? 1 : 2;

  console.log("[namesMatch] Match analysis:", { matchCount, minRequired, result: matchCount >= minRequired });

  return matchCount >= minRequired;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return safeJson(res, 405, { error: "Method not allowed" });

  const { action } = req.body || {};

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return safeJson(res, 500, { error: "Server misconfigured: missing Supabase env vars" });
    }
    if (!AWS_REGION || !BUCKET) {
      return safeJson(res, 500, { error: "Server misconfigured: missing AWS env vars" });
    }

    // ============================================
    // ACTION: get_session
    // ============================================
    if (action === "get_session") {
      const { session_token } = req.body || {};
      if (!session_token) return safeJson(res, 400, { error: "Session token required" });

      const { data: session, error: sessionErr } = await supabase
        .from("demo_sessions")
        .select(
          [
            "session_token",
            "flow_type",
            "status",
            "current_step",
            "consent_given",
            "consent_time",
            "consent_locale",
            "guest_name",
            "room_number",
            "adults",
            "children",
            "visitor_first_name",
            "visitor_last_name",
            "visitor_phone",
            "visitor_reason",
            "intake_payload",
            "document_url",
            "selfie_url",
            "is_verified",
            "verification_score",
            "liveness_score",
            "face_match_score",
            "expected_guest_count",
            "verified_guest_count",
            "requires_additional_guest",
            "physical_room",
            "room_access_code",
            "cloudbeds_reservation_id",
            "visitor_access_code",
            "visitor_access_granted_at",
            "visitor_access_expires_at",
            "created_at",
            "updated_at",
          ].join(",")
        )
        .eq("session_token", session_token)
        .single();

      if (sessionErr) {
        console.error("[verify.js] get_session lookup error:", sessionErr);
        return safeJson(res, 500, { error: "Failed to load session" });
      }
      if (!session) return safeJson(res, 404, { error: "Session not found" });

      return safeJson(res, 200, {
        success: true,
        session: {
          session_token: session.session_token,
          flow_type: session.flow_type ?? null,
          status: session.status ?? null,
          current_step: session.current_step ?? null,

          consent_given: session.consent_given ?? null,
          consent_time: session.consent_time ?? null,
          consent_locale: session.consent_locale ?? null,

          guest_name: session.guest_name ?? null,
          room_number: session.room_number ?? null,
          adults: session.adults ?? null,
          children: session.children ?? null,

          visitor_first_name: session.visitor_first_name ?? null,
          visitor_last_name: session.visitor_last_name ?? null,
          visitor_phone: session.visitor_phone ?? null,
          visitor_reason: session.visitor_reason ?? null,

          intake_payload: session.intake_payload ?? null,

          document_uploaded: Boolean(session.document_url),
          selfie_uploaded: Boolean(session.selfie_url),

          is_verified: session.is_verified ?? null,
          verification_score: session.verification_score ?? null,
          liveness_score: session.liveness_score ?? null,
          face_match_score: session.face_match_score ?? null,

          expected_guest_count: session.expected_guest_count ?? null,
          verified_guest_count: session.verified_guest_count ?? null,
          requires_additional_guest: session.requires_additional_guest ?? null,

          physical_room: session.physical_room ?? null,

          // ✅ FIX: return BOTH keys to avoid camel/snake mismatch bugs
          room_access_code: session.room_access_code ?? null,
          roomAccessCode: session.room_access_code ?? null,

          cloudbeds_reservation_id: session.cloudbeds_reservation_id ?? null,

          visitor_access_code: session.visitor_access_code ?? null,
          visitor_access_granted_at: session.visitor_access_granted_at ?? null,
          visitor_access_expires_at: session.visitor_access_expires_at ?? null,

          created_at: session.created_at ?? null,
          updated_at: session.updated_at ?? null,
        },
      });
    }

    // ============================================
    // ACTION: verify_face
    // ============================================
    if (action === "verify_face") {
      const { session_token, selfie_data } = req.body || {};
      if (!session_token || !selfie_data) {
        return safeJson(res, 400, { error: "Missing params" });
      }

      const { data: session, error: sessionErr } = await supabase
        .from("demo_sessions")
        .select("*")
        .eq("session_token", session_token)
        .single();

      if (sessionErr) {
        console.error("[verify.js] session lookup error:", sessionErr);
        return safeJson(res, 500, { error: "Failed to load session" });
      }
      if (!session) return safeJson(res, 404, { error: "Session not found" });

      const flow_type = normalizeFlowType(session.flow_type);

      if (flow_type === "visitor") {
        return safeJson(res, 400, { error: "Face verification not required for visitors" });
      }

      const expected = clampInt(session.expected_guest_count, 1, 10);
      const verifiedBefore = clampInt(session.verified_guest_count, 0, 10);
      const guestIndex = clampInt(verifiedBefore + 1, 1, expected);

      const docKey = `demo/${session_token}/document_${guestIndex}.jpg`;

      let docBuffer;
      try {
        const docObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: docKey }));
        if (!docObj?.Body) return safeJson(res, 500, { error: "Failed to read document from S3" });
        docBuffer = await streamToBuffer(docObj.Body);
      } catch (e) {
        return safeJson(res, 400, {
          error: `Document not uploaded for guest ${guestIndex}. Please upload the ID first.`,
        });
      }

      const selfieBase64 = normalizeBase64(selfie_data);
      if (!selfieBase64) return safeJson(res, 400, { error: "Invalid selfie_data format" });

      const selfieBuffer = Buffer.from(selfieBase64, "base64");
      if (selfieBuffer.length < 1000) return safeJson(res, 400, { error: "Image too small" });

      const selfieKey = `demo/${session_token}/selfie_${guestIndex}.jpg`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: selfieKey,
          Body: selfieBuffer,
          ContentType: "image/jpeg",
        })
      );

      const selfieUrl = `s3://${BUCKET}/${selfieKey}`;

      const liveness = await rekognition.send(
        new DetectFacesCommand({ Image: { Bytes: selfieBuffer }, Attributes: ["ALL"] })
      );

      const face = liveness.FaceDetails?.[0];
      const isLive = Boolean(face?.EyesOpen?.Value);
      const livenessScore = (face?.Confidence || 0) / 100;

      const compare = await rekognition.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: docBuffer },
          SimilarityThreshold: 80,
        })
      );

      const similarity = (compare.FaceMatches?.[0]?.Similarity || 0) / 100;
      const verificationScore = (isLive ? 0.4 : 0) + livenessScore * 0.3 + similarity * 0.3;

      const guest_verified = isLive && similarity >= 0.40;

      const verifiedAfter = guest_verified ? Math.min(verifiedBefore + 1, expected) : verifiedBefore;

      const requiresAdditionalGuest = verifiedAfter < expected;
      const overallVerified = verifiedAfter >= expected;

      // ✅ FIX: default to existing DB values so we never overwrite with null on lookup failures
      let physical_room = session.physical_room ?? null;
      let room_access_code = session.room_access_code ?? null;
      let cloudbeds_reservation_id = session.cloudbeds_reservation_id ?? null;

      // ✅ FIX: Prefer true Cloudbeds reservation id for lookup (works for OTA thirdPartyIdentifier flows)
      if (guest_verified && flow_type === "guest" && BACKEND_URL) {
        const lookupRef = session.cloudbeds_reservation_id || session.room_number;

        if (lookupRef) {
          try {
            const cloudbeds = await fetchCloudbedsReservation(String(lookupRef));

            const guestIsCheckedIn = getGuestIsCheckedIn(cloudbeds);
            if (!guestIsCheckedIn) {
              return safeJson(res, 400, { error: "guest check in required" });
            }

            // ✅ only overwrite if Cloudbeds returns values
            if (cloudbeds.roomName) physical_room = cloudbeds.roomName;
            if (cloudbeds.accessCode) room_access_code = cloudbeds.accessCode;

            cloudbeds_reservation_id =
              cloudbeds.reservationId || cloudbeds_reservation_id || String(lookupRef);
          } catch (cbErr) {
            console.error("[Cloudbeds] Lookup failed (no overwrite):", cbErr?.message || cbErr);
            // keep existing values
          }
        }
      }

      const { error: updateErr } = await supabase
        .from("demo_sessions")
        .update({
          selfie_url: selfieUrl,
          document_url: `s3://${BUCKET}/${docKey}`,
          is_verified: overallVerified,
          verification_score: verificationScore,
          liveness_score: livenessScore,
          face_match_score: similarity,
          verified_guest_count: verifiedAfter,
          requires_additional_guest: requiresAdditionalGuest,
          physical_room,
          room_access_code,
          cloudbeds_reservation_id,
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateErr) {
        console.error("[verify.js] update error:", updateErr);
        return safeJson(res, 500, { error: "Failed to save verification result" });
      }

      return safeJson(res, 200, {
        success: true,
        flow_type,
        guest_index: guestIndex,
        guest_verified,
        is_verified: overallVerified,
        verification_score: verificationScore,
        physical_room,
        room_access_code,
        cloudbeds_reservation_id,
        requires_additional_guest: requiresAdditionalGuest,
        verified_guest_count: verifiedAfter,
        expected_guest_count: expected,
      });
    }

    // ============================================
    // ACTION: start
    // ============================================
    if (action === "start") {
      const { flow_type } = req.body || {};
      const normalizedFlowType = normalizeFlowType(flow_type);
      const token = generateToken();

      const expected_guest_count = normalizedFlowType === "visitor" ? 0 : 1;
      const verified_guest_count = 0;
      const requires_additional_guest = expected_guest_count > verified_guest_count;

      const { error: insertErr } = await supabase.from("demo_sessions").insert({
        session_token: token,
        flow_type: normalizedFlowType,
        status: "started",
        current_step: "welcome",
        expected_guest_count,
        verified_guest_count,
        requires_additional_guest,
        updated_at: new Date().toISOString(),
      });

      if (insertErr) {
        console.error("[verify.js] Error creating session:", insertErr);
        return safeJson(res, 500, { error: "Failed to create session" });
      }

      return safeJson(res, 200, {
        success: true,
        session_token: token,
        flow_type: normalizedFlowType,
        verify_url: `/verify/${token}`,
      });
    }

    // ============================================
    // ACTION: log_consent
    // ============================================
    if (action === "log_consent") {
      const { session_token, consent_given, consent_time, consent_locale } = req.body || {};
      if (!session_token) return safeJson(res, 400, { error: "Session token required" });

      const { data: existing, error: findErr } = await supabase
        .from("demo_sessions")
        .select("session_token")
        .eq("session_token", session_token)
        .single();

      if (findErr || !existing) return safeJson(res, 404, { error: "Session not found" });

      const { error: updateErr } = await supabase
        .from("demo_sessions")
        .update({
          consent_given: Boolean(consent_given),
          consent_time: consent_time || new Date().toISOString(),
          consent_locale: consent_locale || "en",
          status: "consent_logged",
          current_step: "welcome",
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateErr) {
        console.error("[verify.js] Error updating consent:", updateErr);
        return safeJson(res, 500, { error: "Failed to log consent" });
      }

      return safeJson(res, 200, { success: true, message: "Consent logged successfully" });
    }

   // ============================================
// ACTION: update_guest (OTA-safe: always store real Cloudbeds reservationID)
// ============================================
if (action === "update_guest") {
  const { session_token, guest_name, booking_ref, flow_type } = req.body || {};

  if (!session_token) return safeJson(res, 400, { error: "Session token required" });
  if (!guest_name) return safeJson(res, 400, { error: "Guest name required" });
  if (flow_type !== "visitor" && !booking_ref)
    return safeJson(res, 400, { error: "Booking reference required" });

  // Load session flow type from DB (authoritative)
  const { data: sess, error: sessErr } = await supabase
    .from("demo_sessions")
    .select("flow_type")
    .eq("session_token", session_token)
    .single();

  if (sessErr || !sess) return safeJson(res, 404, { error: "Session not found" });

  const flowType = normalizeFlowType(sess.flow_type);

  // ==========================
  // VISITOR FLOW (no Cloudbeds)
  // ==========================
  if (flowType === "visitor") {
    const { error: updateErr } = await supabase
      .from("demo_sessions")
      .update({
        guest_name,
        room_number: "VISITOR",
        flow_type: "visitor",
        visitor_first_name: req.body.visitor_first_name || null,
        visitor_last_name: req.body.visitor_last_name || null,
        visitor_phone: req.body.visitor_phone || null,
        visitor_reason: req.body.visitor_reason || null,
        status: "guest_verified",
        current_step: "document",
        updated_at: new Date().toISOString(),
      })
      .eq("session_token", session_token);

    if (updateErr) {
      console.error("[verify.js] Error updating visitor info:", updateErr);
      return safeJson(res, 500, { error: "Failed to save visitor info" });
    }

    return safeJson(res, 200, {
      success: true,
      guest_name,
      room_number: "VISITOR",
      flow_type: "visitor",
    });
  }

  // ==========================
  // GUEST FLOW (Cloudbeds)
  // ==========================
  try {
    // First lookup using whatever user typed (Cloudbeds reservationID OR OTA ID)
    const cloudbeds = await fetchCloudbedsReservation(booking_ref);

    const inputName = (guest_name || "").trim();
    const cbName = (cloudbeds.guestName || "").trim();

    console.log(
      "[verify.js] Name comparison - Input:",
      JSON.stringify(inputName),
      "Cloudbeds:",
      JSON.stringify(cbName),
      "booking_ref:",
      booking_ref,
      "cb.reservationId:",
      cloudbeds?.reservationId
    );

    // If name mismatch, try a secondary lookup using REAL Cloudbeds reservation ID (if available)
    if (!namesMatch(inputName, cbName)) {
      const secondaryId =
        cloudbeds?.reservationId && cloudbeds.reservationId !== booking_ref
          ? cloudbeds.reservationId
          : null;

      if (secondaryId) {
        console.log(
          "[verify.js] Name mismatch on initial lookup. Trying secondary Cloudbeds reservation ID:",
          secondaryId
        );

        try {
          const cloudbedsSecondary = await fetchCloudbedsReservation(secondaryId);
          const cbNameSecondary = (cloudbedsSecondary.guestName || "").trim();

          console.log(
            "[verify.js] Secondary lookup name:",
            JSON.stringify(cbNameSecondary),
            "secondaryId:",
            secondaryId
          );

          if (namesMatch(inputName, cbNameSecondary)) {
            console.log("[verify.js] Name matched on secondary lookup");

            const guestIsCheckedInSecondary = getGuestIsCheckedIn(cloudbedsSecondary);
            if (!guestIsCheckedInSecondary) {
              return safeJson(res, 400, { error: "guest check in required" });
            }

            //  OTA-safe persistence:
            // - room_number stores what the guest typed (OTA ID or reservation ID)
            // - cloudbeds_reservation_id stores the REAL Cloudbeds reservation ID
            const { error: updateErr } = await supabase
              .from("demo_sessions")
              .update({
                guest_name,
                room_number: String(booking_ref),

                //  critical fix
                cloudbeds_reservation_id: cloudbedsSecondary.reservationId || null,

                physical_room: cloudbedsSecondary.roomName || null,
                room_access_code: cloudbedsSecondary.accessCode || null,

                status: "guest_verified",
                current_step: "document",
                updated_at: new Date().toISOString(),
              })
              .eq("session_token", session_token);

            if (updateErr) {
              console.error("[verify.js] Error updating guest info (secondary):", updateErr);
              return safeJson(res, 500, { error: "Failed to save guest info" });
            }

            return safeJson(res, 200, {
              success: true,
              guest_name: cloudbedsSecondary.guestName,
              room_number: cloudbedsSecondary.roomName,
              reservation_id: cloudbedsSecondary.reservationId,
              access_code: cloudbedsSecondary.accessCode,
            });
          }
        } catch (secondaryErr) {
          console.warn("[verify.js] Secondary Cloudbeds lookup failed:", secondaryErr);
        }
      }

      console.log("[verify.js] Name mismatch - Input:", inputName, "Cloudbeds:", cbName);
      return safeJson(res, 400, {
        error: "name_mismatch_reservation",
        details: { provided: inputName, expected: cbName },
      });
    }

    // Check reservation check-in status
    const guestIsCheckedIn = getGuestIsCheckedIn(cloudbeds);
    if (!guestIsCheckedIn) {
      return safeJson(res, 400, { error: "guest check in required" });
    }

    //  Primary persistence (works for BOTH direct reservationID and OTA):
    // If this was OTA, cloudbeds.reservationId should be the Cloudbeds reservation ID (e.g., 490GYSS9MN)
    const { error: updateErr } = await supabase
      .from("demo_sessions")
      .update({
        guest_name,
        room_number: String(booking_ref),

        // critical fix (never store OTA id here)
        cloudbeds_reservation_id: cloudbeds.reservationId || null,

        physical_room: cloudbeds.roomName || null,
        room_access_code: cloudbeds.accessCode || null,

        status: "guest_verified",
        current_step: "document",
        updated_at: new Date().toISOString(),
      })
      .eq("session_token", session_token);

    if (updateErr) {
      console.error("[verify.js] Error updating guest info:", updateErr);
      return safeJson(res, 500, { error: "Failed to save guest info" });
    }

    return safeJson(res, 200, {
      success: true,
      guest_name: cloudbeds.guestName,
      room_number: cloudbeds.roomName,
      reservation_id: cloudbeds.reservationId,
      access_code: cloudbeds.accessCode,
    });
  } catch (err) {
    console.error("[verify.js] CloudBeds verification failed:", err);
    return safeJson(res, 404, { error: "Reservation not found in CloudBeds" });
  }
}

// ============================================
// ACTION: visitor_intake
// ============================================

    if (action === "visitor_intake") {
      const { session_token, first_name, last_name, phone, reason } = req.body || {};
      if (!session_token) return safeJson(res, 400, { error: "Session token required" });

      const { error: updateErr } = await supabase
        .from("demo_sessions")
        .update({
          visitor_first_name: first_name || null,
          visitor_last_name: last_name || null,
          visitor_phone: phone || null,
          visitor_reason: reason || null,
          status: "visitor_info_saved",
          current_step: "document",
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateErr) {
        console.error("[verify.js] Error saving visitor info:", updateErr);
        return safeJson(res, 500, { error: "Failed to save visitor info" });
      }

      return safeJson(res, 200, { success: true });
    }

    // ============================================
    // ACTION: upload_document
    // ============================================
    if (action === "upload_document") {
      const { session_token, image_data } = req.body || {};

      if (!session_token) return safeJson(res, 400, { error: "Session token required" });
      if (!image_data) return safeJson(res, 400, { error: "image_data required" });

      const { data: sess, error: sessErr } = await supabase
        .from("demo_sessions")
        .select("flow_type, expected_guest_count, verified_guest_count, guest_name")
        .eq("session_token", session_token)
        .single();

      if (sessErr || !sess) return safeJson(res, 404, { error: "Session not found" });

      const flowType = normalizeFlowType(sess.flow_type);

      const base64Data = normalizeBase64(image_data);
      if (!base64Data) return safeJson(res, 400, { error: "Invalid image_data format" });

      const imageBuffer = Buffer.from(base64Data, "base64");
      if (imageBuffer.length < 1000) return safeJson(res, 400, { error: "Image too small" });

      const expected = clampInt(sess.expected_guest_count, 0, 10);
      const verifiedBefore = clampInt(sess.verified_guest_count, 0, 10);
      const guestIndex = flowType === "visitor" ? 1 : clampInt(verifiedBefore + 1, 1, expected || 1);

      // Textract name validation (guest flow only)
      if (flowType === "guest" && sess.guest_name) {
        try {
          console.log("[verify.js] Running Textract ID analysis...");

          const analyzeRes = await textract.send(
            new AnalyzeIDCommand({
              DocumentPages: [{ Bytes: imageBuffer }],
            })
          );

          const fields = analyzeRes.IdentityDocuments?.[0]?.IdentityDocumentFields || [];

          const getField = (type) => {
            const field = fields.find((f) => f.Type?.Text === type);
            return field?.ValueDetection?.Text || "";
          };

          const docFirstName = getField("FIRST_NAME").trim();
          const docLastName = getField("LAST_NAME").trim();
          const docFullName = `${docFirstName} ${docLastName}`.trim();

          console.log("[verify.js] Textract extracted:", { docFirstName, docLastName, docFullName });

          const storedName = (sess.guest_name || "").trim();

          if (docFullName && storedName && !namesMatch(docFullName, storedName)) {
            console.log("[verify.js] Document name mismatch - Document:", docFullName, "Expected:", storedName);
            return safeJson(res, 400, {
              error: "name_mismatch_document",
              details: {
                document: docFullName,
                expected: storedName,
              },
            });
          }

          console.log("[verify.js] Document name validation passed");
        } catch (textractErr) {
          console.error("[verify.js] Textract analysis failed:", textractErr);
          // continue without hard failing
        }
      }

      const s3Key = `demo/${session_token}/document_${guestIndex}.jpg`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          Body: imageBuffer,
          ContentType: "image/jpeg",
        })
      );

      const documentUrl = `s3://${BUCKET}/${s3Key}`;

      // Visitor flow: generate 6-digit access code
      if (flowType === "visitor") {
        const accessCode = generateSixDigitCode();
        const grantedAt = new Date();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        const { error: updateErr } = await supabase
          .from("demo_sessions")
          .update({
            status: "visitor_access_granted",
            current_step: "results",
            document_url: documentUrl,
            visitor_access_code: accessCode,
            visitor_access_granted_at: grantedAt.toISOString(),
            visitor_access_expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("session_token", session_token);

        if (updateErr) {
          console.error("[verify.js] Error updating visitor document session:", updateErr);
          return safeJson(res, 500, { error: "Failed to save visitor access state" });
        }

        return safeJson(res, 200, {
          success: true,
          flow_type: flowType,
          visitor_access_code: accessCode,
          visitor_access_granted_at: grantedAt.toISOString(),
          visitor_access_expires_at: expiresAt.toISOString(),
        });
      }

      // Guest flow: proceed
      const { error: updateErr } = await supabase
        .from("demo_sessions")
        .update({
          status: "document_uploaded",
          current_step: "selfie",
          document_url: documentUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("session_token", session_token);

      if (updateErr) {
        console.error("[verify.js] Error updating document session:", updateErr);
        return safeJson(res, 500, { error: "Failed to save document state" });
      }

      return safeJson(res, 200, {
        success: true,
        flow_type: flowType,
        guest_index: guestIndex,
      });
    }

    return safeJson(res, 400, { error: "Invalid action" });
  } catch (e) {
    console.error("[verify.js] Error:", e);
    return safeJson(res, 500, { error: e?.message || "Server error" });
  }
}
