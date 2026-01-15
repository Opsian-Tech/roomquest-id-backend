import crypto from "crypto";
import formidable from "formidable";

/**
 * Next.js Pages Router: IMPORTANT
 * Mailgun forwards as form-data / urlencoded, so we must disable bodyParser.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

function setCors(res) {
  // CORS is not required for Mailgun (server-to-server), but keeping it is fine.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, Accept, Origin, Authorization"
  );
}

/**
 * Parse Mailgun inbound payload (multipart/form-data or x-www-form-urlencoded)
 */
function parseForm(req) {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/**
 * Some fields may arrive as arrays; normalize into a clean string.
 */
function toStr(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v[0]?.toString?.() ?? "";
  return v.toString?.() ?? "";
}

/**
 * Optional: Verify Mailgun signature (recommended once stable)
 * Mailgun sends: timestamp, token, signature
 * signature = HMAC-SHA256(timestamp + token, API_KEY)
 *
 * IMPORTANT: This uses your Mailgun API key, NOT "signing key".
 * Add to Vercel env as: MAILGUN_API_KEY
 */
function verifyMailgunSignature(fields) {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    // If you haven't set the key yet, skip verification for now.
    return { ok: true, skipped: true };
  }

  const timestamp = toStr(fields.timestamp);
  const token = toStr(fields.token);
  const signature = toStr(fields.signature);

  if (!timestamp || !token || !signature) {
    return { ok: false, reason: "Missing timestamp/token/signature" };
  }

  const hmac = crypto
    .createHmac("sha256", apiKey)
    .update(timestamp + token)
    .digest("hex");

  const ok = crypto.timingSafeEqual(
    Buffer.from(hmac, "utf8"),
    Buffer.from(signature, "utf8")
  );

  return ok ? { ok: true, skipped: false } : { ok: false, reason: "Bad signature" };
}

export default async function handler(req, res) {
  setCors(res);

  // Preflight (browser only; Mailgun doesn't need it)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fields, files } = await parseForm(req);

    // --- OPTIONAL SECURITY (turn on once you set MAILGUN_API_KEY in Vercel) ---
    const sig = verifyMailgunSignature(fields);
    if (!sig.ok) {
      console.warn("❌ Mailgun signature failed:", sig.reason);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // Normalize common fields
    const recipient = toStr(fields.recipient);
    const from = toStr(fields.from);
    const subject = toStr(fields.subject);

    // Prefer "stripped-text" (Mailgun often provides cleaned text)
    const strippedText = toStr(fields["stripped-text"]);
    const bodyPlain = toStr(fields["body-plain"]);
    const bodyHtml = toStr(fields["body-html"]);

    const bodyText = strippedText || bodyPlain || "";

    // Logs (safe / minimal)
    console.log("📩 Mailgun inbound received");
    console.log("headers:", req.headers);
    console.log("fields keys:", Object.keys(fields || {}));
    console.log("recipient:", recipient);
    console.log("from:", from);
    console.log("subject:", subject);
    console.log("attachments:", files ? Object.keys(files).length : 0);
    console.log("body preview:", bodyText.slice(0, 800));

    // Return minimal response
    return res.status(200).json({
      success: true,
      verified: sig.skipped ? "skipped" : true,
      received: {
        recipient,
        from,
        subject,
        hasText: Boolean(bodyText),
        hasHtml: Boolean(bodyHtml),
      },
    });
  } catch (err) {
    console.error("❌ inbound parse error:", err);
    return res.status(400).json({ success: false, error: "Parse failed" });
  }
}
