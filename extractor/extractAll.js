// extractor/extractAll.js
const { runShopifyQLQuery, parseTableData } = require("./shopifyql");
const { QUERIES } = require("./queries");

/**
 * @param {string} shopDomain       e.g. "my-store.myshopify.com"
 * @param {string} accessToken      Shopify Admin API token
 * @param {string|null} websiteUrl  Pass-through only. The Analytics
 *   Service uses this to decide whether to run the Playwright crawler.
 *   This module never calls Playwright itself.
 */
async function extractAll(shopDomain, accessToken, websiteUrl = null) {
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
