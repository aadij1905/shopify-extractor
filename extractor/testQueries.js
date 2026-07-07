// extractor/testQueries.js
// Run: node extractor/testQueries.js
// Tests each ShopifyQL query individually and prints row counts + first row.

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { runShopifyQLQuery, parseTableData } = require("./shopifyql");
const { QUERIES } = require("./queries");

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error(
    "Missing credentials. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN in .env"
  );
  process.exit(1);
}

async function testAll() {
  console.log(`\nTesting against: ${SHOP_DOMAIN}\n${"=".repeat(60)}`);

  for (const [name, queryString] of Object.entries(QUERIES)) {
    process.stdout.write(`\n[${name}] ... `);
    try {
      const tableData = await runShopifyQLQuery(SHOP_DOMAIN, ACCESS_TOKEN, queryString);
      const rows = parseTableData(tableData);

      if (rows.length === 0) {
        console.log(`WARN — 0 rows returned (query valid but no data)`);
      } else {
        console.log(`OK — ${rows.length} row(s)`);
        console.log("  First row:", JSON.stringify(rows[0], null, 2));
      }
    } catch (err) {
      console.log(`FAIL`);
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log(`\n${"=".repeat(60)}\nDone.\n`);
}

testAll();
