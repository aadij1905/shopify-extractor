// shopAuth.js
// Expiring offline access tokens (requested via `expiring: 1` in the OAuth
// code exchange, see server.js /auth/callback) last 1 hour; the 90-day
// refresh token that comes with them rotates on every use. Every call site
// that used to read `record.access_token` directly must go through
// getValidAccessToken() instead so it transparently refreshes when needed.

const { getShop, upsertShop } = require("./db");

const REFRESH_BUFFER_MS = 60 * 1000; // refresh a bit before actual expiry

async function refreshAccessToken(shopDomain, refreshToken) {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed for ${shopDomain}: HTTP ${res.status} ${body} — shop likely needs to reinstall`
    );
  }

  const { access_token, refresh_token, expires_in, refresh_token_expires_in } = await res.json();
  upsertShop(shopDomain, access_token, {
    refreshToken: refresh_token,
    expiresIn: expires_in,
    refreshTokenExpiresIn: refresh_token_expires_in,
  });
  return access_token;
}

// Returns a usable access token for shopDomain, refreshing first if the
// stored one is expired/near-expiry. Rows with no access_token_expires_at
// (non-expiring tokens issued before this feature existed, or the local-only
// extractor/getToken.js dev flow) are returned as-is.
async function getValidAccessToken(shopDomain) {
  const record = getShop(shopDomain);
  if (!record) throw new Error(`Shop not installed: ${shopDomain}`);

  if (!record.access_token_expires_at) return record.access_token;

  const expiresAt = new Date(record.access_token_expires_at).getTime();
  if (Date.now() < expiresAt - REFRESH_BUFFER_MS) return record.access_token;

  if (!record.refresh_token) {
    throw new Error(`Access token expired for ${shopDomain} and no refresh token stored — shop needs to reinstall`);
  }
  return refreshAccessToken(shopDomain, record.refresh_token);
}

module.exports = { getValidAccessToken };
