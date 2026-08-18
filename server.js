try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. env vars injected directly, as on Railway) — fine
}
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { verifyHmac } = require("./verifyHmac");
const { verifyWebhookHmac } = require("./webhookVerify");
const { upsertShop, getShop, updateLastSynced, deleteShop } = require("./db");
const { getValidAccessToken } = require("./shopAuth");
const { syncShop } = require("./sync");

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  APP_URL,
  PORT = 3000,
} = process.env;

const app = express();
// Allow the Review Hub frontend (localhost:5173) to call /api/sync and /api/shop
// from the browser. OAuth routes are hit via redirect, so CORS is only needed
// for the JSON API endpoints.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
// Mounted with express.raw() and BEFORE express.json() below: Shopify's HMAC
// is computed over the exact raw request body, so it must reach here
// unparsed. If express.json() ran first it would consume/re-serialize the
// body and every signature check would fail.
function webhookHandler(fn) {
  return async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    if (!verifyWebhookHmac(req.body, hmacHeader, SHOPIFY_CLIENT_SECRET)) {
      return res.status(401).send("HMAC verification failed");
    }
    const shop = req.get("X-Shopify-Shop-Domain");
    let payload = {};
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      // some topics (e.g. shop/redact) send a minimal/empty body — fine
    }
    try {
      await fn(shop, payload);
      res.status(200).send("ok");
    } catch (err) {
      console.error(`Webhook failed for ${shop}:`, err.message);
      res.status(500).send("error");
    }
  };
}

const rawJson = express.raw({ type: "application/json" });

// This app stores no customer PII (only shop_domain + access_token), so the
// two customer-facing compliance topics have nothing to return or delete.
app.post(
  "/webhooks/customers/data_request",
  rawJson,
  webhookHandler(async (shop) => {
    console.log(`customers/data_request for ${shop} — no customer data stored, nothing to return`);
  })
);

app.post(
  "/webhooks/customers/redact",
  rawJson,
  webhookHandler(async (shop) => {
    console.log(`customers/redact for ${shop} — no customer data stored, nothing to delete`);
  })
);

// Fires ~48h after uninstall. Must have deleted the shop's data by then.
app.post(
  "/webhooks/shop/redact",
  rawJson,
  webhookHandler(async (shop) => {
    deleteShop(shop);
    console.log(`shop/redact for ${shop} — shop record deleted`);
  })
);

// Fires immediately on uninstall. Token is dead the moment this arrives, so
// drop it now rather than waiting on shop/redact.
app.post(
  "/webhooks/app/uninstalled",
  rawJson,
  webhookHandler(async (shop) => {
    deleteShop(shop);
    console.log(`Uninstalled: ${shop}`);
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
      expiring: 1, // non-expiring tokens are rejected by ShopifyQL/GraphQL
    }),
  });

  const { access_token, refresh_token, expires_in, refresh_token_expires_in } = await tokenRes.json();
  if (!access_token) {
    return res.status(500).send("Failed to get access token from Shopify");
  }

  upsertShop(shop, access_token, {
    refreshToken: refresh_token,
    expiresIn: expires_in,
    refreshTokenExpiresIn: refresh_token_expires_in,
  });
  console.log(`Installed: ${shop}`);

  // Best-effort: app/uninstalled isn't a mandatory compliance topic (those
  // three are configured in the Partner Dashboard instead), but without it
  // deleteShop() never runs and a dead token just sits in shops.db forever.
  registerUninstallWebhook(shop, access_token).catch((err) =>
    console.error(`Could not register app/uninstalled webhook for ${shop}:`, err.message)
  );

  const host = Buffer.from(`${shop}/admin`).toString("base64");
  res.redirect(`/?shop=${shop}&host=${host}`);
});

async function registerUninstallWebhook(shop, accessToken) {
  const res = await fetch(`https://${shop}/admin/api/2026-04/webhooks.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      webhook: {
        topic: "app/uninstalled",
        address: `${APP_URL}/webhooks/app/uninstalled`,
        format: "json",
      },
    }),
  });
  // 422 here almost always means the webhook is already registered for this
  // shop (re-auth case) — not worth failing the install over.
  if (!res.ok && res.status !== 422) {
    throw new Error(`HTTP ${res.status} registering app/uninstalled webhook`);
  }
}

// ── Sync endpoint ────────────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  const { shop, websiteUrl } = req.query;
  // storePassword travels in the JSON body, not the query string — query
  // strings tend to land in access logs and proxy logs, a body doesn't.
  const { storePassword } = req.body || {};
  if (!shop) return res.status(400).json({ error: "shop parameter required" });

  const record = getShop(shop);
  if (!record) return res.status(404).json({ error: "Shop not installed" });

  try {
    const accessToken = await getValidAccessToken(shop);
    const { metrics, errors } = await syncShop(shop, accessToken, websiteUrl, storePassword);
    updateLastSynced(shop);
    res.json({ success: true, metrics, errors });
  } catch (err) {
    console.error(`Sync failed for ${shop}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Debug: analytics query output (Postman-testable) ─────────────────────────
// GET /api/debug/queries?shop=<domain>
// Runs the ShopifyQL queries and returns the raw parsed rows per query, plus
// whatever failed. Unlike /api/sync, this does NOT POST to
// ANALYTICS_SERVICE_URL — it's for inspecting query output directly.
app.get("/api/debug/queries", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "shop parameter required" });

  const record = getShop(shop);
  if (!record) return res.status(404).json({ error: "Shop not installed" });

  try {
    const accessToken = await getValidAccessToken(shop);
    const { extractAll } = require("./extractor/extractAll");
    const data = await extractAll(shop, accessToken);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: theme code extractor (Postman-testable) ───────────────────────────
// GET /api/debug/theme-code?shop=<domain>&page=/products/whatever
// Returns the real theme files that render `page`. Requires the store's token
// to have the read_themes scope (re-authorize via /auth if you just added it).
app.get("/api/debug/theme-code", async (req, res) => {
  const { shop, page } = req.query;
  if (!shop) return res.status(400).json({ error: "shop parameter required" });

  const record = getShop(shop);
  if (!record) return res.status(404).json({ error: "Shop not installed" });

  try {
    const accessToken = await getValidAccessToken(shop);
    const { extractThemeCodeForPage } = require("./extractor/themeExtractor");
    const result = await extractThemeCodeForPage(
      shop,
      accessToken,
      page || "/products/sample"
    );
    res.json({
      shop,
      page: page || "/products/sample",
      themeName: result.themeName,
      themeId: result.themeId,
      template: result.template,
      templateSuffix: result.templateSuffix,
      truncated: result.truncated,
      files: result.files.map((f) => ({ key: f.key, bytes: f.bytes, content: f.content })),
    });
  } catch (err) {
    res.status(err.message.includes("403") ? 403 : 500).json({ error: err.message });
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
