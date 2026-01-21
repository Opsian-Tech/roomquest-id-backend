// pages/api/cloudbeds/start.js

const CLOUDBEDS_CLIENT_ID = process.env.CLOUDBEDS_CLIENT_ID;

// MUST match what you whitelisted in Cloudbeds
const CLOUDBEDS_REDIRECT_URI =
  process.env.CLOUDBEDS_REDIRECT_URI ||
  "https://roomquest-id-visitor-flow.vercel.app/api/cloudbeds/callback";

// If Cloudbeds gave you scopes, put them here (space-separated).
// If you don't know yet, leave it as "" and your Cloudbeds guy will tell you.
const CLOUDBEDS_SCOPES = process.env.CLOUDBEDS_SCOPES || "";

export default async function handler(req, res) {
  try {
    if (!CLOUDBEDS_CLIENT_ID) {
      return res.status(500).send("Missing CLOUDBEDS_CLIENT_ID env var");
    }

    // Basic CSRF protection: store a random state
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

    const authorizeUrl = new URL("https://hotels.cloudbeds.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLOUDBEDS_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", CLOUDBEDS_REDIRECT_URI);
    authorizeUrl.searchParams.set("state", state);

    if (CLOUDBEDS_SCOPES.trim()) {
      authorizeUrl.searchParams.set("scope", CLOUDBEDS_SCOPES.trim());
    }

    // Redirect you to Cloudbeds login/authorize screen
    res.status(302).setHeader("Location", authorizeUrl.toString());
    return res.end();
  } catch (e) {
    return res.status(500).send(`Server error: ${e?.message || String(e)}`);
  }
}
