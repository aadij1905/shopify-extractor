const crypto = require("crypto");

// Encrypts OAuth tokens at rest in shops.db. Key must be a 32-byte value,
// base64 or hex encoded, provided via ENCRYPTION_KEY (generate with
// `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
const ALGO = "aes-256-gcm";

function loadKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return buf;
}

const KEY = loadKey();

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  if (!KEY) return plaintext; // unset in local dev — stored as plaintext
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decrypt(stored) {
  if (stored == null) return stored;
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext row, pre-dates ENCRYPTION_KEY
  if (!KEY) {
    throw new Error("ENCRYPTION_KEY not set but stored value is encrypted");
  }
  const [, ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt };
