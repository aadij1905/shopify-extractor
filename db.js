const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "shops.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    shop_domain    TEXT PRIMARY KEY,
    access_token   TEXT NOT NULL,
    installed_at   TEXT NOT NULL,
    last_synced_at TEXT
  )
`);

function upsertShop(shopDomain, accessToken) {
  db.prepare(`
    INSERT INTO shops (shop_domain, access_token, installed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(shop_domain) DO UPDATE SET
      access_token = excluded.access_token,
      installed_at = excluded.installed_at
  `).run(shopDomain, accessToken, new Date().toISOString());
}

function getShop(shopDomain) {
  return db.prepare("SELECT * FROM shops WHERE shop_domain = ?").get(shopDomain);
}

function updateLastSynced(shopDomain) {
  db.prepare("UPDATE shops SET last_synced_at = ? WHERE shop_domain = ?")
    .run(new Date().toISOString(), shopDomain);
}

module.exports = { upsertShop, getShop, updateLastSynced };
