# Shopify Extractor (`gl_extractor`)

A small Node/Express Shopify app that a merchant installs on their store via
OAuth. Once installed it can, on demand:

- Run a set of **ShopifyQL analytics queries** (sessions, conversion, bounce,
  sales/AOV, per-page and per-source breakdowns, the checkout funnel, and Core
  Web Vitals) against the store's Admin API.
- Extract the **theme Liquid/CSS/JS code** that renders a given storefront page
  (requires the `read_themes` scope).
- **Sync** the extracted data to a downstream Analytics Service
  (`ANALYTICS_SERVICE_URL`), which is where the rest of the Exp Intelligence
  pipeline picks it up.

It stores only `shop_domain` + an **encrypted** access/refresh token per shop
in a local SQLite file — no customer PII. It's the first stage of the
[Exp Intelligence](../README.md) pipeline (`shopify-pp` → Analytics → AI →
Review Hub).

---

## Table of contents

1. [How it works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Local setup](#local-setup)
4. [Environment variables](#environment-variables)
5. [Create the app in the Shopify Partner Dashboard](#create-the-app-in-the-shopify-partner-dashboard)
6. [Deploy so anyone can install it](#deploy-so-anyone-can-install-it)
7. [Installing on a store](#installing-on-a-store)
8. [API reference](#api-reference)
9. [Data & privacy](#data--privacy)
10. [Troubleshooting](#troubleshooting)

---

## How it works

```
Merchant browser                 This app                       Shopify
─────────────────                ─────────                      ───────
GET /auth?shop=store ───────────► redirect to Shopify OAuth ───► consent screen
                                                                     │
GET /auth/callback?code=… ◄──────────────────────────────────────────┘
        │
        ├─ exchange code → access_token (+ refresh_token, expiring: 1)
        ├─ encrypt + store in shops.db
        └─ register app/uninstalled webhook

POST /api/sync?shop=store ──────► run ShopifyQL queries via Admin API
                                  extract theme code
                                  POST result → ANALYTICS_SERVICE_URL
```

- **Tokens are expiring** (`expiring: 1` in the code exchange). They last ~1h;
  a 90-day refresh token comes with them and rotates on every use.
  `getValidAccessToken()` refreshes transparently before each API call, so a
  shop only has to reinstall if its refresh token lapses.
- **Webhooks** (`app/uninstalled`, `shop/redact`, plus the two mandatory
  customer-compliance topics) delete the shop record so no dead token lingers.

Key files: [`server.js`](server.js) (routes/OAuth/webhooks),
[`db.js`](db.js) (SQLite + encryption), [`shopAuth.js`](shopAuth.js) (token
refresh), [`sync.js`](sync.js) (extract + POST to Analytics),
[`extractor/`](extractor) (ShopifyQL queries + theme extractor).

---

## Prerequisites

- **Node.js 18+** (uses the built-in global `fetch`) and npm.
- A **Shopify Partner account** — free at
  <https://partners.shopify.com/signup>.
- A **development store** (create one from the Partner Dashboard) or any store
  you're allowed to install a custom/unlisted app on, for testing.

---

## Local setup

```bash
git clone https://github.com/aadij1905/shopify-extractor.git
cd shopify-extractor
npm install
```

Create your env file from the example and fill it in (see
[Environment variables](#environment-variables)):

```bash
cp .env.example .env
```

Generate an encryption key (used to encrypt tokens at rest in `shops.db`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
npm start
```

It listens on `http://localhost:3000` (or `PORT`). For OAuth to work locally,
Shopify must be able to reach a **public HTTPS URL**, so expose your local port
with a tunnel and use that URL as `APP_URL` (and in the Partner Dashboard):

```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Copy the printed `https://…` URL into `APP_URL`, restart, then install via
`https://<that-url>/auth?shop=your-dev-store.myshopify.com`.

---

## Environment variables

Set these in `.env` for local dev and in your host's dashboard for production.
Values come from the Partner Dashboard (client id/secret) and your own config.

| Variable | Required | Description |
| --- | --- | --- |
| `SHOPIFY_CLIENT_ID` | ✅ | App's Client ID (API key) from the Partner Dashboard. |
| `SHOPIFY_CLIENT_SECRET` | ✅ | App's Client secret. Keep it secret — used for HMAC verification and token exchange. |
| `SHOPIFY_SCOPES` | ✅ | Comma-separated OAuth scopes. Default: `read_reports,read_themes`. Must match the app config. |
| `APP_URL` | ✅ | Public HTTPS base URL of this app (no trailing slash), e.g. `https://your-app.up.railway.app`. Used to build the OAuth redirect and webhook addresses. |
| `ANALYTICS_SERVICE_URL` | ✅ | Full URL of the Analytics Service ingest endpoint that `/api/sync` POSTs to, e.g. `http://localhost:4000/api/analytics/ingest`. |
| `PORT` | – | Port to listen on. Defaults to `3000`. Most hosts set this automatically. |
| `DB_PATH` | prod | Path to the SQLite file. **In production this MUST point at a mounted persistent volume** (e.g. `/data/shops.db`) or every redeploy wipes installed shops. Unset = `./shops.db` (dev only). |
| `ENCRYPTION_KEY` | prod | 32-byte key (hex or base64) that encrypts tokens at rest. Generate as shown above. **Required in production** — if unset, tokens are stored in plaintext (dev only). |

`read_reports` powers the ShopifyQL analytics queries; `read_themes` powers the
theme-code extractor. Drop `read_themes` if you don't need theme extraction.

---

## Create the app in the Shopify Partner Dashboard

Do this once. It gives you the client id/secret and registers the URLs Shopify
will redirect to.

1. Sign in at <https://partners.shopify.com> → **Apps** → **Create app** →
   **Create app manually**. Give it a name (e.g. `gl_extractor`).
2. On the app's **Overview / Client credentials** page, copy the **Client ID**
   and **Client secret** into `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`.
3. Go to **Configuration** and set:
   - **App URL**: `https://<your-deployed-domain>` (your `APP_URL`).
   - **Allowed redirection URL(s)**: `https://<your-deployed-domain>/auth/callback`
     — this must match exactly or OAuth fails.
   - **Embedded**: this app sets `embedded = true` in
     [`shopify.app.toml`](shopify.app.toml). Leaving it embedded is fine; the
     install flow still works via the `/auth` link.
4. Under **Protected customer data access** / **API scopes**, request the
   scopes in `SHOPIFY_SCOPES` (`read_reports`, `read_themes`).
5. Under **Compliance webhooks** (a.k.a. GDPR/mandatory webhooks), set all three
   to your deployed domain:
   - `customers/data_request` → `https://<domain>/webhooks/customers/data_request`
   - `customers/redact` → `https://<domain>/webhooks/customers/redact`
   - `shop/redact` → `https://<domain>/webhooks/shop/redact`

   These are already declared in [`shopify.app.toml`](shopify.app.toml); if you
   deploy config with the Shopify CLI (`shopify app deploy`) they'll be applied
   automatically — just update the domain in that file first. The
   `app/uninstalled` webhook is registered at runtime by the app itself after
   each install, so you don't configure it here.
6. Save. Keep the app **unlisted** (not submitted to the public App Store) if
   you only want to share an install link — see below.

> **Tip:** [`shopify.app.toml`](shopify.app.toml) in this repo already contains
> the client id, name, scopes, redirect URL, and compliance webhook URIs. Point
> its URLs at your own domain and use `shopify app deploy` (Shopify CLI) to push
> the config instead of clicking through the dashboard.

---

## Deploy so anyone can install it

The app needs to run somewhere with a **stable public HTTPS URL** and a
**persistent disk** for `shops.db`. The reference deployment uses
[Railway](https://railway.app); any host that provides a volume works (Render,
Fly.io, a VPS, etc.).

### Deploy on Railway (reference)

1. Push this repo to GitHub (or use the existing
   `aadij1905/shopify-extractor`).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway auto-detects Node and runs `npm install` then `npm start`.
3. **Add a Volume** (Railway → your service → **Volumes → New Volume**) and
   mount it at `/data`. This is what keeps installed shops across redeploys.
4. **Set variables** (Railway → **Variables**):

   ```
   SHOPIFY_CLIENT_ID=<from Partner Dashboard>
   SHOPIFY_CLIENT_SECRET=<from Partner Dashboard>
   SHOPIFY_SCOPES=read_reports,read_themes
   APP_URL=https://<your-service>.up.railway.app
   ANALYTICS_SERVICE_URL=https://<your-analytics-service>/api/analytics/ingest
   DB_PATH=/data/shops.db
   ENCRYPTION_KEY=<32-byte hex from the generate command above>
   ```

   Leave `PORT` unset — Railway injects it.
5. **Generate a domain** (Railway → **Settings → Networking → Generate Domain**)
   if you don't have one. Copy it into `APP_URL` and into the Partner Dashboard
   (App URL, redirect URL, compliance webhook URLs — they must all match this
   domain).
6. Redeploy. Visit `https://<domain>/` — you should see the install page from
   [`public/index.html`](public/index.html).

> **Critical:** `DB_PATH` **must** live on the mounted volume (`/data/shops.db`).
> If it points at the app directory, every redeploy resets the container's
> filesystem and all installed shops (and their tokens) vanish.

Any change to your domain means updating **both** `APP_URL` and the three
matching URLs in the Partner Dashboard, or OAuth/webhooks break.

---

## Installing on a store

Once deployed and configured, share this link (replacing the store domain):

```
https://<your-domain>/auth?shop=THEIR-STORE.myshopify.com
```

Or send the merchant to `https://<your-domain>/` and let them type their
`*.myshopify.com` domain into the install page. The merchant clicks **Install**,
approves the requested scopes, and is redirected back — the app stores their
encrypted token and they're ready to sync.

To trigger a sync for an installed store:

```bash
curl -X POST "https://<your-domain>/api/sync?shop=THEIR-STORE.myshopify.com" \
  -H "Content-Type: application/json" \
  -d '{"storePassword":"optional-storefront-password"}'
```

(`storePassword` is only needed for stores still behind Shopify's storefront
password wall, and is passed through to the Analytics Service's crawler.)

---

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth?shop=<domain>` | Start OAuth install for a store. Redirects to Shopify's consent screen. |
| `GET` | `/auth/callback` | OAuth redirect target. Exchanges the code, stores the token, registers the uninstall webhook. (Shopify calls this — not you.) |
| `POST` | `/api/sync?shop=<domain>` | Run all extractors and POST the result to `ANALYTICS_SERVICE_URL`. Optional JSON body `{ "storePassword": "…" }`. |
| `GET` | `/api/shop?shop=<domain>` | Return `{ shopDomain, lastSyncedAt }` for an installed shop. |
| `GET` | `/api/debug/queries?shop=<domain>` | Run the ShopifyQL queries and return raw parsed rows per query. Does **not** POST to Analytics — for inspecting query output. |
| `GET` | `/api/debug/theme-code?shop=<domain>&page=/products/x` | Return the theme files that render `page`. Needs `read_themes`; re-authorize via `/auth` if you just added the scope. |
| `POST` | `/webhooks/app/uninstalled` | Deletes the shop record. Registered automatically after install. |
| `POST` | `/webhooks/shop/redact` | Deletes the shop record (~48h after uninstall). |
| `POST` | `/webhooks/customers/data_request` | Compliance no-op — no customer data is stored. |
| `POST` | `/webhooks/customers/redact` | Compliance no-op — no customer data is stored. |

All webhook requests are HMAC-verified against `SHOPIFY_CLIENT_SECRET`; the
OAuth callback is HMAC-verified on the query string.

---

## Data & privacy

- The only data persisted is one row per shop: `shop_domain`, an **encrypted**
  access token and refresh token, install timestamp, and last-sync timestamp.
  No customer PII is stored — see [`public/privacy.html`](public/privacy.html).
- Tokens are encrypted at rest with `ENCRYPTION_KEY` (see [`crypto.js`](crypto.js)).
- Uninstalling a store (or a `shop/redact` webhook) deletes its row immediately.
- `.env` and `shops.db` are gitignored — never commit real secrets or the DB.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Invalid shop parameter` on `/auth` | The `shop` query param must end in `.myshopify.com`. |
| `HMAC verification failed` on callback | `SHOPIFY_CLIENT_SECRET` is wrong, or the redirect URL in the Partner Dashboard doesn't exactly match `APP_URL/auth/callback`. |
| `Failed to get access token from Shopify` | Client id/secret mismatch, or the code was already used/expired — retry the install. |
| Installed shops disappear after every deploy | `DB_PATH` isn't on a persistent volume. Point it at the mounted disk (`/data/shops.db`). |
| `403` from `/api/debug/theme-code` | The stored token lacks `read_themes`. Add the scope in config and re-run `/auth` for that shop to re-consent. |
| Sync returns `Shop not installed` | The shop never completed OAuth, or its row was deleted on uninstall. Reinstall via `/auth`. |
| ShopifyQL queries return empty/`errors` | The store may lack `read_reports`, or has no analytics data in the query window. Check `/api/debug/queries`. |
| Token refresh fails, "shop likely needs to reinstall" | The 90-day refresh token lapsed. The merchant must reinstall via `/auth`. |

For running the downstream services locally behind tunnels, see
[`../TUNNELS.md`](../TUNNELS.md).
