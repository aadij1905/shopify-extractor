// extractor/extractAll.js
const { runShopifyQLQuery, parseTableData } = require("./shopifyql");
const { QUERIES } = require("./queries");

/**
 * @param {string} shopDomain          e.g. "my-store.myshopify.com"
 * @param {string} accessToken         Shopify Admin API token
 * @param {string|null} websiteUrl     Pass-through only. The Analytics
 *   Service uses this to decide whether to run the Playwright crawler.
 *   This module never calls Playwright itself.
 * @param {string|null} storePassword  Pass-through only. Storefront
 *   password (Settings > Online Store > Preferences), entered by the
 *   merchant during onboarding, for stores not yet public. Used by the
 *   Analytics Service's crawler to get past the /password wall — this
 *   module never touches Playwright or the storefront itself.
 */
async function extractAll(shopDomain, accessToken, websiteUrl = null, storePassword = null) {
  const startTime = Date.now();
  const results = {};
  const queriesRun = [];
  let failedQueries = 0;
  const errors = {};

  for (const [name, queryString] of Object.entries(QUERIES)) {
    try {
      const tableData = await runShopifyQLQuery(shopDomain, accessToken, queryString);
      results[name] = parseTableData(tableData);
      queriesRun.push(name);
    } catch (err) {
      console.error(`ShopifyQL query "${name}" failed:`, err.message);
      errors[name] = err.message;
      failedQueries++;
      results[name] = [];
    }
  }

  return {
    storeId: shopDomain,
    websiteUrl, // pass-through — crawl decision belongs to Analytics Service
    storePassword, // pass-through — used by Analytics Service's crawler only
    queriesRun,
    metrics: {
      totalQueriesAttempted: Object.keys(QUERIES).length,
      successfulQueries: queriesRun.length,
      failedQueries,
      processingTimeMs: Date.now() - startTime,
    },
    errors,
    raw: results,
  };
}

module.exports = { extractAll };
