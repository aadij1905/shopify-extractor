// extractor/themeExtractor.js
// Code extractor — the mirror of extractAll.js, but for THEME SOURCE instead
// of analytics. Given a finding's affected page, it fetches only the handful
// of Liquid files that render that page, so the AI service can generate a
// patch against the merchant's REAL code instead of assuming Dawn.
//
// Requires the `read_themes` OAuth scope. Add it to SHOPIFY_SCOPES and have
// merchants re-authorize; a token issued for read_analytics alone will get
// 403 on these endpoints.
//
// Token strategy: we never download the whole theme (~300 files, ~1–2M
// tokens). We use the OS 2.0 template graph — a page's templates/*.json lists
// exactly which section files render it — so a typical extraction is:
//   templates/product.json (~1KB) → 1–3 sections/*.liquid (~5–15KB) each.

const SHOPIFY_API_VERSION = "2026-04";

// ── Low-level Admin REST helper (429-aware, mirrors shopifyql.js) ────────────
async function adminGet(shopDomain, accessToken, pathAndQuery) {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${pathAndQuery}`;
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
  });

  if (response.status === 429) {
    // Assets API is rate-limited (2 req/s). Honour Retry-After, else back off 2s.
    const wait = Number(response.headers.get("Retry-After")) * 1000 || 2000;
    await new Promise((r) => setTimeout(r, wait));
    return adminGet(shopDomain, accessToken, pathAndQuery);
  }
  if (response.status === 403) {
    throw new Error(
      "403 from Themes API — token lacks read_themes scope. Add it to " +
        "SHOPIFY_SCOPES and re-authorize the store."
    );
  }
  if (!response.ok) {
    throw new Error(`Admin API request failed: HTTP ${response.status} on ${pathAndQuery}`);
  }
  return response.json();
}

// The published (live) theme. role === "main" is the one customers see.
async function getPublishedTheme(shopDomain, accessToken) {
  const { themes } = await adminGet(shopDomain, accessToken, "themes.json");
  const main = (themes || []).find((t) => t.role === "main");
  if (!main) throw new Error("No published (role=main) theme found");
  return { id: main.id, name: main.name, role: main.role };
}

// Asset KEYS only (no content) + their updated_at — cheap, used for caching
// and for locating files we can't reach via the template graph.
async function listAssetKeys(shopDomain, accessToken, themeId) {
  const { assets } = await adminGet(
    shopDomain,
    accessToken,
    `themes/${themeId}/assets.json`
  );
  return (assets || []).map((a) => ({ key: a.key, updatedAt: a.updated_at, size: a.size }));
}

// One asset's CONTENT. Text assets come back on `value`; binary on `attachment`
// (base64) — we skip binaries, we only care about source files.
async function getAsset(shopDomain, accessToken, themeId, key) {
  const data = await adminGet(
    shopDomain,
    accessToken,
    `themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
  );
  const asset = data.asset;
  if (!asset || asset.value == null) return null; // binary or missing
  return { key: asset.key, content: asset.value, updatedAt: asset.updated_at };
}

// ── Template-graph retrieval ────────────────────────────────────────────────

// affectedPage → template file basename. CRO findings mostly land on product
// pages, so that's the fallback.
function templateForPage(affectedPage) {
  const p = (affectedPage || "").toLowerCase();
  if (p === "/" || p === "" || p.includes("/index") || p === "home") return "index";
  if (p.includes("/products/")) return "product";
  if (p.includes("/collections/")) return "collection";
  if (p.includes("/cart")) return "cart";
  if (p.includes("/pages/")) return "page";
  if (p.includes("/blogs/")) return "article";
  return "product";
}

// Extract the section `type`s an OS 2.0 JSON template renders. Legacy themes
// use a .liquid template instead (no section graph) — handled by the caller.
function sectionTypesFromJsonTemplate(jsonString) {
  try {
    const tpl = JSON.parse(jsonString);
    const order = tpl.order || Object.keys(tpl.sections || {});
    return order
      .map((id) => tpl.sections?.[id]?.type)
      .filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i); // unique
  } catch {
    return [];
  }
}

// Trim a file before it goes to the LLM: drop {% comment %} blocks (dead
// weight, sometimes huge) and collapse blank-line runs. Keeps {% schema %}
// (the model needs it to understand section settings). ~15–30% token savings.
function trimForPrompt(content) {
  return content
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// {% render 'x' %} / {% include "x", foo: bar %} — the section/snippet names
// a Liquid file pulls in. A patch that only touches the section shell and
// misses the snippet doing the actual rendering is not a correct patch.
function snippetNamesFromLiquid(content) {
  const names = new Set();
  const re = /{%-?\s*(?:render|include)\s+['"]([a-zA-Z0-9_-]+)['"]/g;
  let m;
  while ((m = re.exec(content))) names.add(m[1]);
  return [...names];
}

/**
 * Fetch the theme files that render a finding's affected page: the template,
 * every section it references (no arbitrary cap), every snippet those pull
 * in (recursively), and the theme layout. Built to hand the AI patch-generator
 * the exact real files, not a lossy sample of them.
 *
 * @returns {{
 *   themeId: number, themeName: string, template: string,
 *   files: Array<{ key: string, content: string, bytes: number }>,
 *   truncated: boolean
 * }}
 */
async function extractThemeCodeForPage(
  shopDomain,
  accessToken,
  affectedPage,
  { maxBytesPerFile = 60000, includeLayout = true } = {}
) {
  const theme = await getPublishedTheme(shopDomain, accessToken);
  const base = templateForPage(affectedPage);
  const files = [];
  const fetchedKeys = new Set();
  let truncated = false;

  const takeFile = (asset) => {
    if (!asset || fetchedKeys.has(asset.key)) return null;
    fetchedKeys.add(asset.key);
    let content = trimForPrompt(asset.content);
    if (content.length > maxBytesPerFile) {
      content = content.slice(0, maxBytesPerFile) + "\n{# …truncated… #}";
      truncated = true;
    }
    files.push({ key: asset.key, content, bytes: content.length });
    return content;
  };

  // Follow render/include chains breadth-first until no new snippets turn up.
  const pullSnippets = async (content) => {
    let names = snippetNamesFromLiquid(content).filter(
      (n) => !fetchedKeys.has(`snippets/${n}.liquid`)
    );
    while (names.length) {
      const assets = await Promise.all(
        names.map((n) => getAsset(shopDomain, accessToken, theme.id, `snippets/${n}.liquid`))
      );
      const nextNames = new Set();
      assets.forEach((asset) => {
        const taken = takeFile(asset);
        if (taken) {
          snippetNamesFromLiquid(taken).forEach((n) => {
            if (!fetchedKeys.has(`snippets/${n}.liquid`)) nextNames.add(n);
          });
        }
      });
      names = [...nextNames];
    }
  };

  // OS 2.0 JSON template first; fall back to a legacy .liquid template.
  const jsonTpl = await getAsset(shopDomain, accessToken, theme.id, `templates/${base}.json`);
  if (jsonTpl) {
    const tplContent = takeFile(jsonTpl);
    const types = sectionTypesFromJsonTemplate(jsonTpl.content);
    const sections = await Promise.all(
      types.map((t) => getAsset(shopDomain, accessToken, theme.id, `sections/${t}.liquid`))
    );
    for (const asset of sections) {
      const taken = takeFile(asset);
      if (taken) await pullSnippets(taken);
    }
    if (tplContent) await pullSnippets(tplContent);
  } else {
    const liquidTpl = await getAsset(
      shopDomain,
      accessToken,
      theme.id,
      `templates/${base}.liquid`
    );
    const taken = takeFile(liquidTpl);
    if (taken) await pullSnippets(taken);
  }

  if (includeLayout) {
    const layout = await getAsset(shopDomain, accessToken, theme.id, "layout/theme.liquid");
    const taken = takeFile(layout);
    if (taken) await pullSnippets(taken);
  }

  return {
    themeId: theme.id,
    themeName: theme.name,
    template: base,
    files,
    truncated,
  };
}

module.exports = {
  getPublishedTheme,
  listAssetKeys,
  getAsset,
  extractThemeCodeForPage,
  templateForPage,
  sectionTypesFromJsonTemplate,
  snippetNamesFromLiquid,
  trimForPrompt,
};
