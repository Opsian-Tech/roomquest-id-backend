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
const s3 = new S3Client({ region: AWS_REGION });
const rekognition = new RekognitionClient({ region: AWS_REGION });
const textract = new TextractClient({ region: AWS_REGION });

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

      // Read the uploaded document image from S3
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

      // Decode selfie
      const selfieBase64 = normalizeBase64(selfie_data);
      if (!selfieBase64) return safeJson(res, 400, { error: "Invalid selfie_data format" });

      const selfieBuffer = Buffer.from(selfieBase64, "base64");
      if (selfieBuffer.length < 1000) return safeJson(res, 400, { error: "Image too small" });

      // Upload selfie to S3
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

      // Liveness-ish signal (basic)
      const liveness = await rekognition.send(
        new DetectFacesCommand({ Image: { Bytes: selfieBuffer }, Attributes: ["ALL"] })
      );

      const face = liveness.FaceDetails?.[0];
      const isLive = Boolean(face?.EyesOpen?.Value);
      const livenessScore = (face?.Confidence || 0) / 100;

      // Face match
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

      // Cloudbeds integration - fetch room and access code
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
          // Continue without Cloudbeds data - guest is still verified
        }
      }

      // Single combined database update
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

    return safeJson(res, 400, { error: "Invalid action" });
  } catch (e) {
    console.error("[verify.js] Error:", e);
    return safeJson(res, 500, { error: e?.message || "Server error" });
  }
}
