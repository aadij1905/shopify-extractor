// extractor/shopifyql.js
const SHOPIFY_API_VERSION = "2026-04";

async function runShopifyQLQuery(shopDomain, accessToken, queryString) {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const body = {
    query: `
      query ShopifyQLQuery($query: String!) {
        shopifyqlQuery(query: $query) {
          __typename
          ... on TableResponse {
            tableData {
              columns { name dataType displayName }
              rowData
            }
          }
          parseErrors
        }
      }
    `,
    variables: { query: queryString },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, 60000));
    return runShopifyQLQuery(shopDomain, accessToken, queryString);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ShopifyQL request failed: HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(`ShopifyQL GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  const result = data.data?.shopifyqlQuery;
  if (result?.parseErrors?.length) {
    throw new Error(`ShopifyQL parse error: ${JSON.stringify(result.parseErrors)}`);
  }
  return result?.tableData;
}

function parseTableData(tableData) {
  if (!tableData || !tableData.columns || !tableData.rowData) return [];
  const colNames = tableData.columns.map((c) => c.name);
  return tableData.rowData.map((row) => {
    const obj = {};
    colNames.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  });
}

module.exports = { runShopifyQLQuery, parseTableData };
