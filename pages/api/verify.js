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
const BUILD_ID = "visitor-schedule-v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({ region: AWS_REGION });
const rekognition = new RekognitionClient({ region: AWS_REGION });
const textract = new TextractClient({ region: AWS_REGION });

async function fetchCloudbedsReservation(reservationId) {
  const res = await fetch(`${BACKEND_URL}/api/cloudbeds/reservation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservation_id: reservationId }),
  });

  if (!res.ok) throw new Error("Cloudbeds request failed");
  const data = await res.json();
  if (!data?.success) throw new Error("Invalid Cloudbeds response");
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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body || {};

  try {
    if (action === "verify_face") {
      const { session_token, selfie_data } = req.body || {};
      if (!session_token || !selfie_data)
        return res.status(400).json({ error: "Missing params" });

      const { data: session } = await supabase
        .from("demo_sessions")
        .select("*")
        .eq("session_token", session_token)
        .single();

      if (!session) return res.status(404).json({ error: "Session not found" });

      const flow_type = normalizeFlowType(session.flow_type);
      const expected = clampInt(session.expected_guest_count, 1, 10);
      const verifiedBefore = clampInt(session.verified_guest_count, 0, 10);
      const guestIndex = clampInt(verifiedBefore + 1, 1, expected);

      const docKey = `demo/${session_token}/document_${guestIndex}.jpg`;
      const docObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: docKey }));
      const docBuffer = await streamToBuffer(docObj.Body);

      const selfieBuffer = Buffer.from(normalizeBase64(selfie_data), "base64");
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

      if (guest_verified && flow_type === "guest" && session.room_number) {
        try {
          const cloudbeds = await fetchCloudbedsReservation(session.room_number);
          physical_room = cloudbeds.roomName || null;
          room_access_code = cloudbeds.accessCode || null;
          cloudbeds_reservation_id = session.room_number;

          await supabase.from("demo_sessions").update({
            physical_room,
            room_access_code,
            cloudbeds_reservation_id,
          }).eq("session_token", session_token);
        } catch {}
      }

      await supabase.from("demo_sessions").update({
        selfie_url: selfieUrl,
        is_verified: overallVerified,
        verification_score: verificationScore,
        liveness_score: livenessScore,
        face_match_score: similarity,
        verified_guest_count: verifiedAfter,
        requires_additional_guest: requiresAdditionalGuest,
        updated_at: new Date().toISOString(),
      }).eq("session_token", session_token);

      return res.json({
        success: true,
        flow_type,
        guest_verified,
        is_verified: overallVerified,
        verification_score: verificationScore,
        physical_room,
        room_access_code,
        cloudbeds_reservation_id,
      });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
