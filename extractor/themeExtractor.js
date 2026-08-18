// extractor/themeExtractor.js
// Code extractor — the mirror of extractAll.js, but for THEME SOURCE instead
// of analytics. Given a finding's affected page, it fetches only the handful
// of Liquid files that render that page, so the AI service can generate a
// patch against the merchant's REAL code instead of assuming Dawn.
//
// Requires the `read_themes` OAuth scope. Add it to SHOPIFY_SCOPES and have
// merchants re-authorize; a token issued for read_reports alone will get
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

// ── Alternate-template detection ────────────────────────────────────────────
// Merchants can assign a specific product/collection/page/article a custom
// "alternate template" (templates/{type}.{suffix}.json) instead of the
// theme's default. templateForPage() only looks at the URL shape, so without
// this a finding on such a resource would silently pull the WRONG file.

async function adminGraphQL(shopDomain, accessToken, query, variables) {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.errors ? null : data.data;
}

// {type, handle} for the resource a page URL points at, or null for template
// types with no assignable alternate template (index, cart, search, ...).
function resourceHandleFromPage(base, affectedPage) {
  const p = affectedPage || "";
  if (base === "product") {
    const m = p.match(/\/products\/([^/?]+)/);
    return m ? { type: "product", handle: m[1] } : null;
  }
  if (base === "collection") {
    const m = p.match(/\/collections\/([^/?]+)/);
    return m ? { type: "collection", handle: m[1] } : null;
  }
  if (base === "page") {
    const m = p.match(/\/pages\/([^/?]+)/);
    return m ? { type: "page", handle: m[1] } : null;
  }
  if (base === "article") {
    const m = p.match(/\/blogs\/[^/]+\/([^/?]+)/);
    return m ? { type: "article", handle: m[1] } : null;
  }
  return null;
}

// Best-effort: any failure (bad handle, resource deleted, API hiccup) just
// falls back to the default template rather than breaking extraction.
async function getTemplateSuffix(shopDomain, accessToken, resource) {
  if (!resource) return null;
  const { type, handle } = resource;
  try {
    if (type === "product") {
      const data = await adminGraphQL(
        shopDomain,
        accessToken,
        `query($handle: String!) { productByHandle(handle: $handle) { templateSuffix } }`,
        { handle }
      );
      return data?.productByHandle?.templateSuffix || null;
    }
    if (type === "collection") {
      const data = await adminGraphQL(
        shopDomain,
        accessToken,
        `query($handle: String!) { collectionByHandle(handle: $handle) { templateSuffix } }`,
        { handle }
      );
      return data?.collectionByHandle?.templateSuffix || null;
    }
    if (type === "page") {
      const data = await adminGraphQL(
        shopDomain,
        accessToken,
        `query($q: String!) { pages(first: 1, query: $q) { edges { node { templateSuffix } } } }`,
        { q: `handle:${handle}` }
      );
      return data?.pages?.edges?.[0]?.node?.templateSuffix || null;
    }
    if (type === "article") {
      const data = await adminGraphQL(
        shopDomain,
        accessToken,
        `query($q: String!) { articles(first: 1, query: $q) { edges { node { templateSuffix } } } }`,
        { q: `handle:${handle}` }
      );
      return data?.articles?.edges?.[0]?.node?.templateSuffix || null;
    }
  } catch {
    return null;
  }
  return null;
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
 *   templateSuffix: string|null,
 *   files: Array<{ key: string, content: string, bytes: number }>,
 *   truncated: boolean
 * }}
 */
const MAX_BYTES_PER_FILE = 60000;

async function extractThemeCodeForPage(shopDomain, accessToken, affectedPage) {
  const theme = await getPublishedTheme(shopDomain, accessToken);
  const base = templateForPage(affectedPage);
  const files = [];
  const fetchedKeys = new Set();
  let truncated = false;

  // If this specific resource uses an alternate template, prefer it — falling
  // back to the theme's default {base}.json/.liquid if that file doesn't
  // actually exist on the published theme (e.g. suffix from a stale/older
  // theme assignment).
  const resource = resourceHandleFromPage(base, affectedPage);
  const templateSuffix = await getTemplateSuffix(shopDomain, accessToken, resource);
  const templateAsset = async (ext) => {
    if (templateSuffix) {
      const withSuffix = await getAsset(
        shopDomain,
        accessToken,
        theme.id,
        `templates/${base}.${templateSuffix}.${ext}`
      );
      if (withSuffix) return withSuffix;
    }
    return getAsset(shopDomain, accessToken, theme.id, `templates/${base}.${ext}`);
  };

  const takeFile = (asset) => {
    if (!asset || fetchedKeys.has(asset.key)) return null;
    fetchedKeys.add(asset.key);
    let content = trimForPrompt(asset.content);
    if (content.length > MAX_BYTES_PER_FILE) {
      content = content.slice(0, MAX_BYTES_PER_FILE) + "\n{# …truncated… #}";
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
  const jsonTpl = await templateAsset("json");
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
    const liquidTpl = await templateAsset("liquid");
    const taken = takeFile(liquidTpl);
    if (taken) await pullSnippets(taken);
  }

  const layout = await getAsset(shopDomain, accessToken, theme.id, "layout/theme.liquid");
  const layoutTaken = takeFile(layout);
  if (layoutTaken) await pullSnippets(layoutTaken);

  return {
    themeId: theme.id,
    themeName: theme.name,
    template: base,
    templateSuffix: templateSuffix || null,
    files,
    truncated,
  };
}

module.exports = { extractThemeCodeForPage };
