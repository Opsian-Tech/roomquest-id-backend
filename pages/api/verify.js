// pages/api/verify.js
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
const BUILD_ID = "cloudbeds-integration-v1";

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
  }
});
const rekognition = new RekognitionClient({ 
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }
});
const textract = new TextractClient({ 
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }
});

async function fetchCloudbedsReservation(reservationId) {
  console.log("[Cloudbeds] Fetching reservation:", reservationId);

  const res = await fetch(`${BACKEND_URL}/api/cloudbeds/reservation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservation_id: reservationId }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[Cloudbeds] Request failed:", res.status, errorText);
    throw new Error("Cloudbeds request failed");
  }

  const data = await res.json();

  if (!data?.success) {
    console.error("[Cloudbeds] Invalid response:", data);
    throw new Error("Invalid Cloudbeds response");
  }

  console.log("[Cloudbeds] Success:", { roomName: data.roomName, accessCode: data.accessCode });
  return data;
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

    // ✅ Added: get_session so the frontend can read physical_room + room_access_code
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

          // ✅ These are what your ResultsStep wants
          physical_room: session.physical_room ?? null,
          room_access_code: session.room_access_code ?? null,
          cloudbeds_reservation_id: session.cloudbeds_reservation_id ?? null,

          created_at: session.created_at ?? null,
          updated_at: session.updated_at ?? null,
        },
      });
    }

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

      const guest_verified = isLive && similarity >= 0.65;

      const verifiedAfter = guest_verified
        ? Math.min(verifiedBefore + 1, expected)
        : verifiedBefore;

      const requiresAdditionalGuest = verifiedAfter < expected;
      const overallVerified = verifiedAfter >= expected;

      let physical_room = null;
      let room_access_code = null;
      let cloudbeds_reservation_id = null;

      if (guest_verified && flow_type === "guest" && session.room_number && BACKEND_URL) {
        try {
          const cloudbeds = await fetchCloudbedsReservation(session.room_number);
          physical_room = cloudbeds.roomName || null;
          room_access_code = cloudbeds.accessCode || null;
          cloudbeds_reservation_id = session.room_number;
        } catch (cbErr) {
          console.error("[Cloudbeds] Lookup failed:", cbErr?.message || cbErr);
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
// ACTION: verify_guest
// ============================================

// syedmuhammadosama@Syeds-MacBook-Pro roomquest-id-backend % curl -X POST http://localhost:3000/api/cloudbeds/reservation \
//   -H "Content-Type: application/json" \
//   -d '{"reservation_id": "4257TZGWU9"}'
// {"success":true,"reservationId":"4257TZGWU9","roomName":"203","accessCode":null,"guestName":"Thiraphong Saethan","checkInDate":"2026-01-24","checkOutDate":"2026-01-26","status":"confirmed"}%  
// ============================================
// ACTION: update_guest
// ============================================
if (action === "update_guest") {
  const { session_token, guest_name, booking_ref } = req.body || {};
  
  if (!session_token) return safeJson(res, 400, { error: "Session token required" });
  if (!guest_name) return safeJson(res, 400, { error: "Guest name required" });
  if (!booking_ref) return safeJson(res, 400, { error: "Booking reference required" });

  // Verify reservation exists in CloudBeds
  try {
    const cloudbeds = await fetchCloudbedsReservation(booking_ref);
    
    if (!cloudbeds.success) {
      return safeJson(res, 404, { error: "Reservation not found" });
    }

    // Update session with reservation details
    const { error: updateErr } = await supabase
      .from("demo_sessions")
      .update({
        guest_name,
        room_number: booking_ref,
        cloudbeds_reservation_id: booking_ref,
        physical_room: cloudbeds.roomName,
        room_access_code: cloudbeds.accessCode,
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
      reservation_id: booking_ref,
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
        .select("flow_type, expected_guest_count, verified_guest_count")
        .eq("session_token", session_token)
        .single();

      if (sessErr || !sess) return safeJson(res, 404, { error: "Session not found" });

      const expected = clampInt(sess.expected_guest_count, 0, 10);
      const verifiedBefore = clampInt(sess.verified_guest_count, 0, 10);
      const guestIndex = clampInt(verifiedBefore + 1, 1, expected || 1);

      const base64Data = normalizeBase64(image_data);
      if (!base64Data) return safeJson(res, 400, { error: "Invalid image_data format" });

      const imageBuffer = Buffer.from(base64Data, "base64");
      if (imageBuffer.length < 1000) return safeJson(res, 400, { error: "Image too small" });

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
        guest_index: guestIndex,
      });
    }
    return safeJson(res, 400, { error: "Invalid action" });
  } catch (e) {
    console.error("[verify.js] Error:", e);
    return safeJson(res, 500, { error: e?.message || "Server error" });
  }
}
