const { extractAll } = require("./extractor/extractAll");

async function getWebsiteUrl(shopDomain, accessToken) {
  try {
    const res = await fetch(`https://${shopDomain}/admin/api/2024-01/shop.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    const { shop } = await res.json();
    // prefer custom domain, fall back to myshopify domain
    const domain = shop.domain || shop.myshopify_domain;
    return domain ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

async function syncShop(shopDomain, accessToken, websiteUrlOverride, storePassword) {
  // A caller-supplied website URL (from the dashboard) wins; otherwise derive it
  // from the shop's Shopify domain. The Analytics Service decides whether to
  // crawl based on whether this ends up non-empty.
  const websiteUrl =
    websiteUrlOverride && websiteUrlOverride.trim()
      ? websiteUrlOverride.trim()
      : await getWebsiteUrl(shopDomain, accessToken);
  console.log(`Website URL for ${shopDomain}: ${websiteUrl}`);
  const data = await extractAll(shopDomain, accessToken, websiteUrl, storePassword || null);

  const res = await fetch(process.env.ANALYTICS_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    throw new Error(`Analytics Service responded with HTTP ${res.status}`);
  }

  return { metrics: data.metrics, errors: data.errors };
}

module.exports = { syncShop };
