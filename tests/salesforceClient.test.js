const test = require("node:test");
const assert = require("node:assert/strict");

const {
  backfillMissingAnalysisMetrics,
  buildConvertedDebugSummary,
  buildFlatRowsFromDetailExport,
  calculateAnalysisCountRates,
  calculateAnalysisConvertedRate,
  hasAnalysisDetailExportRows,
  normalizeScf,
  parseConvertedNumber,
  resolveConvertedValue,
  resolveAnalysisConvertedCount,
  summarizeAnalysisExportRows,
  shouldFallbackToSoqlForReportPayload,
} = require("../services/salesforceClient");

test("shouldFallbackToSoqlForReportPayload detects truncated Salesforce tabular payloads", () => {
  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: false,
      hasExceededTabularRowLimit: true,
    }),
    true
  );
});

test("shouldFallbackToSoqlForReportPayload ignores complete Salesforce payloads", () => {
  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: true,
      hasExceededTabularRowLimit: false,
    }),
    false
  );

  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: false,
      hasExceededTabularRowLimit: false,
    }),
    false
  );
});

test("resolveConvertedValue prefers direct Sum of Converted fields", () => {
  const resolved = resolveConvertedValue({ "Sum of Converted": 5 });
  assert.equal(resolved.key, "Sum of Converted");
  assert.equal(resolved.numericValue, 5);
  assert.equal(resolved.usedPaymentReceivedFallback, false);
});

test("resolveConvertedValue parses alternate converted count field names", () => {
  assert.equal(resolveConvertedValue({ Converted: "7" }).numericValue, 7);
  assert.equal(resolveConvertedValue({ converted_count: "3" }).numericValue, 3);
});

test("resolveConvertedValue falls back to payment received only when needed", () => {
  const truthy = resolveConvertedValue({ "Payment Received": true });
  const received = resolveConvertedValue({ "Payment Received": "Received" });
  const blank = resolveConvertedValue({ "Payment Received": "" });

  assert.equal(truthy.key, "Payment Received");
  assert.equal(truthy.numericValue, 1);
  assert.equal(truthy.usedPaymentReceivedFallback, true);
  assert.equal(received.numericValue, 1);
  assert.equal(blank.numericValue, null);
});

test("resolveConvertedValue returns null values when no converted field exists", () => {
  const resolved = resolveConvertedValue({ "Sum of Mailed": 10 });
  assert.equal(resolved.key, null);
  assert.equal(resolved.numericValue, null);
});

test("parseConvertedNumber preserves missing values instead of forcing zero", () => {
  assert.equal(parseConvertedNumber(""), null);
  assert.equal(parseConvertedNumber(null), null);
  assert.equal(parseConvertedNumber("$12.00"), 12);
});

test("buildConvertedDebugSummary reports missing converted sources as warnings", () => {
  const summary = buildConvertedDebugSummary([
    { "Sum of Converted": 5 },
    { "Payment Received": "Received" },
    { "Sum of Mailed": 10 },
  ]);

  assert.equal(summary.rowsWithConvertedSource, 2);
  assert.equal(summary.rowsWithConvertedNumericValue, 2);
  assert.equal(summary.convertedTotalFromSource, 6);
  assert.match(summary.warnings[0], /No converted source field found/);
});

function getAggregateRow(dataset, scf) {
  return (dataset.rows || []).find((row) => String(row["SCF Grouping"] || "") === scf);
}

test("SCF 893 keeps the Salesforce sold and in-force rates instead of recalculating from counts", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "893",
      Key: "N",
      Mailed: 166,
      "Opp Count": 1,
      "In Force": 1,
      "Sum of Sold": 0,
      "Sold Rate": 3.082991454,
      "In Force Rate": 3.082991454,
      "Total Converted Monthly Premiums": "$75.62",
    },
  ]);

  const row = getAggregateRow(dataset, "893");
  assert.equal(row["Sum of Converted"], "1");
  assert.equal(row["Sold Rate"], "3.0829914540");
  assert.equal(row["In Force Rate"], "3.0829914540");
  assert.equal(row["Converted Rate"], "3.0829914540");
});

test("SCF 903 keeps the Salesforce sold rate instead of recalculating from mailed count", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "903",
      Key: "N",
      Mailed: 260,
      "Opp Count": 1,
      "In Force": 0,
      "Sum of Sold": 4,
      "Sold Rate": 2.94776892,
      "In Force Rate": 0,
      "Total Converted Monthly Premiums": 0,
    },
  ]);

  const row = getAggregateRow(dataset, "903");
  assert.equal(row["Sum of Converted"], "0");
  assert.equal(row["Sold Rate"], "2.9477689200");
  assert.equal(row["In Force Rate"], "0.0000000000");
  assert.equal(row["Converted Rate"], "0.0000000000");
});

test("SCF 143 keeps the Salesforce sold rate instead of count divided by mailed", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "143",
      Key: "N",
      Mailed: 489,
      "Opp Count": 4,
      "In Force": 2,
      "Sold Rate": 2.299856603,
      "In Force Rate": 1.1499283015,
      "Total Converted Monthly Premiums": 0,
    },
  ]);

  const row = getAggregateRow(dataset, "143");
  assert.equal(row["Sold Rate"], "2.2998566030");
  assert.equal(row["In Force Rate"], "1.1499283015");
});

test("converted count is derived from positive converted premium even when Salesforce converted count is blank or zero", () => {
  assert.equal(
    resolveAnalysisConvertedCount({
      "Sum of Sold": 0,
      "Sum of Total Converted Monthly Premiums": "$10.00",
    }),
    1
  );

  assert.equal(
    resolveAnalysisConvertedCount({
      "Sum of Sold": "",
      "Sum of Total Converted Monthly Premiums": "$10.00",
    }),
    1
  );
});

test("in-force rate displays the Salesforce in-force rate column exactly", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "812",
      Key: "N",
      Mailed: 100,
      "Opp Count": 2,
      "In Force": 1,
      "Sold Rate": 5.5,
      "In Force Rate": 4.125,
      "Total Converted Monthly Premiums": 0,
    },
  ]);

  const row = getAggregateRow(dataset, "812");
  assert.equal(row["In Force Rate"], "4.1250000000");
});

test("converted rate uses the restored Salesforce rate basis when detail rows exist", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "999",
      Key: "N",
      Mailed: 166,
      "Opp Count": 2,
      "In Force": 1,
      "Sum of Sold": 0,
      "Sold Rate": 6.165982908,
      "In Force Rate": 3.082991454,
      "Total Converted Monthly Premiums": 100,
    },
  ]);

  const row = getAggregateRow(dataset, "999");
  assert.equal(row["Sum of Converted"], "1");
  assert.equal(row["Converted Rate"], "3.0829914540");
});

test("converted count uses one certificate per positive converted premium row instead of sold count", () => {
  const convertedCount = resolveAnalysisConvertedCount(
    {
      "Sum of Opp Count": 9,
      "Sum of Sold": 9,
      "Sum of Converted": 0,
      "Total Converted Monthly Premiums": 76.05,
    }
  );

  assert.equal(convertedCount, 1);
});

test("payments minus credits greater than one dollar counts the certificate as converted", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "812",
      Key: "N",
      Mailed: 166,
      "Opp Count": 9,
      "In Force": 5,
      "Sum of Sold": 9,
      "Payments Minus Credits": 19038.1,
      "Total Converted Monthly Premiums": 0,
      "Sold Rate": 3.082991454,
      "In Force Rate": 3.082991454,
    },
  ]);

  const row = getAggregateRow(dataset, "812");
  assert.equal(row["Sum of Converted"], "1");
});

test("sum of converted counts every converted certificate row in the SCF, not just one", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "812",
      Key: "N",
      Mailed: 1000,
      "Opp Count": 1,
      "In Force": 1,
      "Payments Minus Credits": 50,
      "Total Converted Monthly Premiums": 0,
      "Sold Rate": 1.5,
      "In Force Rate": 1.0,
    },
    {
      "SCF Grouping": "812",
      Key: "N",
      Mailed: 1000,
      "Opp Count": 1,
      "In Force": 1,
      "Payments Minus Credits": 20,
      "Total Converted Monthly Premiums": 0,
      "Sold Rate": 1.5,
      "In Force Rate": 1.0,
    },
    {
      "SCF Grouping": "812",
      Key: "N",
      Mailed: 1000,
      "Opp Count": 1,
      "In Force": 1,
      "Payments Minus Credits": 0,
      "Total Converted Monthly Premiums": 0,
      "Sold Rate": 1.5,
      "In Force Rate": 1.0,
    },
  ]);

  const row = getAggregateRow(dataset, "812");
  assert.equal(row["Sum of Converted"], "2");
});

test("summary rows do not collapse converted count to one from aggregate premium dollars alone", () => {
  assert.equal(
    resolveAnalysisConvertedCount(
      {
        "Sum of Total Converted Monthly Premiums": "$200.00",
        "Sum of Converted": "",
      },
      200,
      { allowPremiumRowInference: false }
    ),
    0
  );
});

test("converted count requires the Salesforce converted field to be greater than one dollar", () => {
  assert.equal(
    resolveAnalysisConvertedCount({
      "Payments Minus Credits": "$1.00",
      "Sum of Converted": "",
    }),
    0
  );

  assert.equal(
    resolveAnalysisConvertedCount({
      "Payments Minus Credits": "$1.01",
      "Sum of Converted": "",
    }),
    1
  );
});

test("zero mailed rows return zero rates without dividing by zero", () => {
  const rates = calculateAnalysisCountRates({
    mailed: 0,
    soldCount: 1,
    inForceCount: 1,
    convertedCount: 1,
  });

  assert.deepEqual(rates, {
    soldRate: 0,
    inForceRate: 0,
    convertedRate: 0,
  });
});

test("normalizeScf preserves leading zeros and pads short numeric values", () => {
  assert.equal(normalizeScf(10), "010");
  assert.equal(normalizeScf("10"), "010");
  assert.equal(normalizeScf("010"), "010");
  assert.equal(normalizeScf("033"), "033");
  assert.equal(normalizeScf(893), "893");
});

test("rows with SCF 10, 010, and numeric 10 aggregate together under 010", () => {
  const dataset = buildFlatRowsFromDetailExport([
    { "SCF Grouping": "10", Key: "N", Mailed: 100, "Opp Count": 1, "In Force": 0, "Sold Rate": 3.082991454, "In Force Rate": 0, "Total Converted Monthly Premiums": 0 },
    { "SCF Grouping": "010", Key: "N", Mailed: 50, "Opp Count": 0, "In Force": 1, "Sold Rate": 3.082991454, "In Force Rate": 3.082991454, "Total Converted Monthly Premiums": 15 },
    { "SCF Grouping": 10, Key: "N", Mailed: 16, "Opp Count": 0, "In Force": 0, "Total Converted Monthly Premiums": 0 },
  ]);

  const row = getAggregateRow(dataset, "010");
  assert.equal(row["Sum of Mailed"], "166");
  assert.equal(row["Sum of Converted"], "1");
  assert.equal(row["Sold Rate"], "3.0829914540");
  assert.equal(row["In Force Rate"], "3.0829914540");
  assert.equal(row["Converted Rate"], "3.0829914540");
});

test("aggregate-shaped saved rows are not mistaken for detail export rows", () => {
  assert.equal(
    hasAnalysisDetailExportRows([
      {
        "SCF Grouping": "010",
        "Sum of Mailed": "2,319",
        "Sum of Opp Count": "1",
        "Sold Rate": "0.0431220354",
      },
    ]),
    false
  );

  assert.equal(
    hasAnalysisDetailExportRows([
      {
        "SCF Grouping": "010",
        Mailed: 2319,
        "Opp Count": 1,
        "In Force": 0,
        "Total Converted Monthly Premiums": 0,
      },
    ]),
    true
  );
});

test("summary-shaped export rows keep Salesforce sold and in-force rates and restored converted rate", () => {
  const dataset = summarizeAnalysisExportRows(
    [
      {
        "SCF Grouping": "893",
        Key: "N",
        "Sum of Mailed": "166",
        "Sum of Opp Count": "1",
        "Sum of In Force": "1",
        "Sum of Converted": "1",
        "Sum of Total Converted Monthly Premiums": "$76.05",
        "Sold Rate": "3.0829914540",
        "In Force Rate": "3.0829914540",
        "Converted Rate": "3.0829914540",
      },
    ],
    [
      { key: "SCF Grouping", label: "SCF Grouping", normalized: "scf grouping", dataType: "string" },
      { key: "Key", label: "Key", normalized: "key", dataType: "string" },
      { key: "Sum of Mailed", label: "Sum of Mailed", normalized: "sum of mailed", dataType: "double" },
      { key: "Sum of Opp Count", label: "Sum of Opp Count", normalized: "sum of opp count", dataType: "double" },
      { key: "Sold Rate", label: "Sold Rate", normalized: "sold rate", dataType: "double" },
    ]
  );

  const row = getAggregateRow(dataset, "893");
  assert.equal(row["Sold Rate"], "3.0829914540");
  assert.equal(row["In Force Rate"], "3.0829914540");
  assert.equal(row["Converted Rate"], "3.0829914540");
});

test("detail-derived sum of converted backfills grouped rows that still show zero", () => {
  const [row] = backfillMissingAnalysisMetrics(
    [
      {
        "SCF Grouping": "362",
        Key: "N",
        "Sum of Mailed": "130",
        "Sum of Opp Count": "1",
        "Sum of In Force": "1",
        "Sum of Converted": "0",
        "Sum of Total Converted Monthly Premiums": "$61.97",
        "Sold Rate": "3.2078890154",
        "In Force Rate": "3.2078890154",
        "Converted Rate": "3.2078890154",
      },
    ],
    [
      {
        "SCF Grouping": "362",
        Key: "N",
        "Sum of Converted": "1",
        "Sum of Total Converted Monthly Premiums": "$61.97",
      },
    ]
  );

  assert.equal(row["Sum of Converted"], "1");
});

test("calculateAnalysisConvertedRate falls back safely when Salesforce rate fields are missing", () => {
  assert.equal(
    calculateAnalysisConvertedRate({
      convertedCount: 1,
      soldCount: 0,
      inForceCount: 0,
      soldRate: null,
      inForceRate: null,
      convertedRate: null,
      mailed: 166,
    }),
    0.6024096385542169
  );
});
