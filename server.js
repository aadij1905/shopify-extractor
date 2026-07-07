require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { verifyHmac } = require("./verifyHmac");
const { upsertShop, getShop, updateLastSynced } = require("./db");
const { syncShop } = require("./sync");

const app = express();
// Allow the Review Hub frontend (localhost:5173) to call /api/sync and /api/shop
// from the browser. OAuth routes are hit via redirect, so CORS is only needed
// for the JSON API endpoints.
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  APP_URL,
  PORT = 3000,
} = process.env;

// ── Install entry point ──────────────────────────────────────────────────────
// Share this URL with clients:
// https://your-app.railway.app/auth?shop=their-store.myshopify.com
app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Invalid shop parameter");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

// ── OAuth callback ───────────────────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;

  if (!verifyHmac(req.query, SHOPIFY_CLIENT_SECRET)) {
    return res.status(403).send("HMAC verification failed");
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });

  const { access_token } = await tokenRes.json();
  if (!access_token) {
    return res.status(500).send("Failed to get access token from Shopify");
  }

  upsertShop(shop, access_token);
  console.log(`Installed: ${shop}`);

  const host = Buffer.from(`${shop}/admin`).toString("base64");
  res.redirect(`/?shop=${shop}&host=${host}`);
});

// ── Sync endpoint ────────────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  const { shop, websiteUrl } = req.query;
  if (!shop) return res.status(400).json({ error: "shop parameter required" });

  const record = getShop(shop);
  if (!record) return res.status(404).json({ error: "Shop not installed" });

  try {
    const metrics = await syncShop(shop, record.access_token, websiteUrl);
    updateLastSynced(shop);
    res.json({ success: true, metrics });
  } catch (err) {
    console.error(`Sync failed for ${shop}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Shop info (for UI) ───────────────────────────────────────────────────────
app.get("/api/shop", (req, res) => {
  const { shop } = req.query;
  const record = getShop(shop);
  if (!record) return res.status(404).json({ error: "Not installed" });
  res.json({
    shopDomain: record.shop_domain,
    lastSyncedAt: record.last_synced_at,
  });
});

app.listen(PORT, () => console.log(`Shopify app running on port ${PORT}`));
