// extractor/getToken.js
// One-time script to get a Shopify access token via OAuth.
// Run: node extractor/getToken.js
// Then open the printed URL in your browser and approve the install.

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const http = require("http");
const { exec } = require("child_process");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
// Pull scopes from .env so adding read_themes there flows through here too.
const SCOPE = process.env.SHOPIFY_SCOPES || "read_analytics,read_themes";

if (!CLIENT_ID || !CLIENT_SECRET || !SHOP) {
  console.error("Missing SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, or SHOPIFY_SHOP_DOMAIN in .env");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.end("Waiting for Shopify callback...");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.end("No code received. Try again.");
    server.close();
    return;
  }

  // Exchange code for access token
  try {
    const tokenRes = await fetch(
      `https://${SHOP}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
      }
    );
    const data = await tokenRes.json();
    const token = data.access_token;

    if (token) {
      // Persist to the same SQLite db the server/debug route reads, so the
      // new (read_themes-capable) token is used immediately — no manual paste.
      try {
        const { upsertShop } = require("../db");
        upsertShop(SHOP, token);
        console.log(`\n✓ Token saved to db for ${SHOP} (scopes: ${SCOPE})`);
      } catch (e) {
        console.error("Could not save token to db:", e.message);
      }
      res.end(`
        <h2>Success!</h2>
        <p>Token saved to the app database for <code>${SHOP}</code>.</p>
        <p>Scopes: <code>${SCOPE}</code></p>
        <p>You can now hit <code>/api/debug/theme-code</code> in Postman.</p>
      `);
      console.log("\n✓ Access token received and stored.");
    } else {
      res.end(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
      console.error("Token exchange failed:", data);
    }
  } catch (err) {
    res.end(`Error: ${err.message}`);
    console.error(err);
  }

  server.close();
});

server.listen(PORT, () => {
  const installUrl =
    `https://${SHOP}/admin/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&scope=${SCOPE}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=shopifyql_extractor`;

  console.log("\nLocal callback server running on port", PORT);
  console.log("\nOpening install URL in browser...");
  console.log("\nIf browser doesn't open, paste this URL manually:\n");
  console.log(installUrl + "\n");

  // Open browser automatically
  exec(`open "${installUrl}"`);
});
