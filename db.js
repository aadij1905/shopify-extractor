const Database = require("better-sqlite3");
const path = require("path");

// DB_PATH must point at a mounted persistent volume in production (e.g.
// Railway wipes anything outside one on every redeploy) — default to a local
// file only for dev, where the app directory itself persists.
const db = new Database(process.env.DB_PATH || path.join(__dirname, "shops.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    shop_domain    TEXT PRIMARY KEY,
    access_token   TEXT NOT NULL,
    installed_at   TEXT NOT NULL,
    last_synced_at TEXT
  )
`);

// Added for expiring-token support (Shopify now rejects non-expiring tokens
// on some Admin API surfaces, e.g. ShopifyQL). SQLite has no
// "ADD COLUMN IF NOT EXISTS", so migrate existing shops.db files by hand.
const shopColumns = db.prepare("PRAGMA table_info(shops)").all().map((c) => c.name);
for (const [column, type] of [
  ["refresh_token", "TEXT"],
  ["access_token_expires_at", "TEXT"],
  ["refresh_token_expires_at", "TEXT"],
]) {
  if (!shopColumns.includes(column)) {
    db.exec(`ALTER TABLE shops ADD COLUMN ${column} ${type}`);
  }
}

function upsertShop(shopDomain, accessToken, { refreshToken, expiresIn, refreshTokenExpiresIn } = {}) {
  const now = Date.now();
  const accessTokenExpiresAt = expiresIn ? new Date(now + expiresIn * 1000).toISOString() : null;
  const refreshTokenExpiresAt = refreshTokenExpiresIn
    ? new Date(now + refreshTokenExpiresIn * 1000).toISOString()
    : null;
  db.prepare(`
    INSERT INTO shops (shop_domain, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, installed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_domain) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      installed_at = excluded.installed_at
  `).run(
    shopDomain,
    accessToken,
    refreshToken || null,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    new Date(now).toISOString()
  );
}

function getShop(shopDomain) {
  return db.prepare("SELECT * FROM shops WHERE shop_domain = ?").get(shopDomain);
}

function updateLastSynced(shopDomain) {
  db.prepare("UPDATE shops SET last_synced_at = ? WHERE shop_domain = ?")
    .run(new Date().toISOString(), shopDomain);
}

// Used by the app/uninstalled and shop/redact webhooks — an uninstalled
// shop's token is dead anyway, and shop/redact requires we not retain it.
function deleteShop(shopDomain) {
  db.prepare("DELETE FROM shops WHERE shop_domain = ?").run(shopDomain);
}

module.exports = { upsertShop, getShop, updateLastSynced, deleteShop };
