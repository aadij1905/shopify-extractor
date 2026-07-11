const crypto = require("crypto");

// Webhook HMAC differs from the OAuth callback HMAC in verifyHmac.js: it's
// computed over the raw request body (not sorted query params) and compared
// base64, not hex. Requires the route to be mounted with express.raw() so
// `body` is still the original Buffer, not a parsed/re-serialized object.
function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyWebhookHmac };
