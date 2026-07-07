// extractor/queries.js

const QUERIES = {
  // Overview: sessions, conversion, bounce — site-wide with
  // period-over-period comparison. All fields confirmed real.
  overview: `
    FROM sessions
    SHOW sessions, conversion_rate, bounce_rate
    TIMESERIES day WITH TOTALS, PERCENT_CHANGE
    SINCE -7d UNTIL today
    COMPARE TO previous_period
    ORDER BY day ASC
  `,

  // Revenue: sales, orders, AOV by day.
  sales: `
    FROM sales
    SHOW total_sales, total_orders, average_order_value
    GROUP BY day
    SINCE -7d UNTIL today
    ORDER BY day ASC
  `,

  // Per-page: sessions, conversion, bounce — all three confirmed real
  // together via landing_page_path (NOT landing_page).
  pages: `
    FROM sessions
    SHOW sessions, conversion_rate, bounce_rate
    GROUP BY landing_page_path WITH TOTALS
    SINCE -7d UNTIL today
    ORDER BY sessions DESC
    LIMIT 50
  `,

  // Per-source: sessions, conversion_rate, bounce_rate confirmed real
  // via the trafficSources behavior report.
  trafficSources: `
    FROM sessions
    SHOW sessions, conversion_rate, bounce_rate
    GROUP BY referrer_source
    SINCE -7d UNTIL today
  `,

  // Per-device: sessions and online_store_visitors ONLY.
  // bounce_rate and conversion_rate are NOT available per
  // session_device_type — confirmed missing from the Sessions by
  // device type report. Do not attempt to SHOW them here.
  devices: `
    FROM sessions
    SHOW sessions, online_store_visitors
    GROUP BY session_device_type
    SINCE -7d UNTIL today
  `,

  // REAL multi-stage funnel — confirmed field names from the
  // Conversion rate breakdown report.
  // Fields: sessions_with_cart_additions, sessions_that_reached_checkout,
  // sessions_that_completed_checkout — all confirmed real.
  funnelBreakdown: `
    FROM sessions
    SHOW sessions, sessions_with_cart_additions,
      sessions_that_reached_checkout,
      sessions_that_completed_checkout, conversion_rate
    WHERE human_or_bot_session IN ('human', 'bot')
    TIMESERIES day WITH TOTALS, PERCENT_CHANGE
    SINCE -7d UNTIL today
    COMPARE TO previous_period
    ORDER BY day ASC
  `,

  // Checkout-stage conversion — used to derive cart abandonment rate.
  // cartAbandonmentRate = 1 - checkout_conversion_rate (computed in
  // normalize.js, not fabricated here).
  checkoutConversion: `
    FROM sessions
    SHOW checkout_conversion_rate
    TIMESERIES day
    SINCE -7d UNTIL today
  `,

  // Core Web Vitals per page — three separate queries, one per metric.
  // Table: web_performance (NOT sessions).
  // Grouping: page_path (NOT landing_page_path).
  // Field names confirmed directly from Explore UI:
  //   LCP: lcp_p75_ms
  //   CLS: p75_cls   (note: different naming pattern from LCP/INP)
  //   INP: inp_p75_ms
  // 30-day window matches Explore UI default; web_performance data is
  // sparser than session data and benefits from a longer look-back.
  performanceLCP: `
    FROM web_performance
    SHOW percent_of_page_loads, page_loads, lcp_p75_ms
    GROUP BY page_path WITH TOTALS
    SINCE -30d UNTIL yesterday
    ORDER BY percent_of_page_loads DESC
    LIMIT 50
  `,

  performanceCLS: `
    FROM web_performance
    SHOW percent_of_page_loads, page_loads, p75_cls
    GROUP BY page_path WITH TOTALS
    SINCE -30d UNTIL yesterday
    ORDER BY percent_of_page_loads DESC
    LIMIT 50
  `,

  performanceINP: `
    FROM web_performance
    SHOW percent_of_page_loads, page_loads, inp_p75_ms
    GROUP BY page_path WITH TOTALS
    SINCE -30d UNTIL yesterday
    ORDER BY percent_of_page_loads DESC
    LIMIT 50
  `,
};

module.exports = { QUERIES };
