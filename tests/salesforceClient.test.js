const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFlatRowsFromDetailExport,
  calculateAnalysisCountRates,
  hasAnalysisDetailExportRows,
  normalizeScf,
  resolveAnalysisConvertedCount,
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

function getAggregateRow(dataset, scf) {
  return (dataset.rows || []).find((row) => String(row["SCF Grouping"] || "") === scf);
}

test("primary report rates use mailed counts with converted premium derived counts", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "166",
      Key: "A",
      Mailed: 166,
      "Opp Count": 1,
      "In Force": 1,
      "Sum of Sold": 0,
      "Total Converted Monthly Premiums": "$75.62",
    },
  ]);

  const row = getAggregateRow(dataset, "166");
  assert.equal(row["Sum of Opp Count"], "1");
  assert.equal(row["Sum of Sold"], "1");
  assert.equal(row["Sold Rate"], "0.6024096386");
  assert.equal(row["In Force Rate"], "0.6024096386");
  assert.equal(row["Converted Rate"], "0.6024096386");
});

test("primary report rates stay zero-safe and do not count zero converted premium", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "260",
      Key: "B",
      Mailed: 260,
      "Opp Count": 1,
      "In Force": 0,
      "Sum of Sold": 4,
      "Total Converted Monthly Premiums": 0,
    },
  ]);

  const row = getAggregateRow(dataset, "260");
  assert.equal(row["Sum of Opp Count"], "1");
  assert.equal(row["Sum of Sold"], "0");
  assert.equal(row["Sold Rate"], "0.3846153846");
  assert.equal(row["In Force Rate"], "0.0000000000");
  assert.equal(row["Converted Rate"], "0.0000000000");
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

test("converted rate never uses converted premium dollars as the numerator", () => {
  const dataset = buildFlatRowsFromDetailExport([
    {
      "SCF Grouping": "999",
      Key: "C",
      Mailed: 166,
      "Opp Count": 1,
      "In Force": 1,
      "Sum of Sold": 0,
      "Total Converted Monthly Premiums": 100,
    },
  ]);

  const row = getAggregateRow(dataset, "999");
  assert.equal(row["Converted Rate"], "0.6024096386");
  assert.notEqual(row["Converted Rate"], "60.2409638554");
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
  assert.equal(normalizeScf(893), "893");
});

test("rows with SCF 10, 010, and numeric 10 aggregate together under 010", () => {
  const dataset = buildFlatRowsFromDetailExport([
    { "SCF Grouping": "10", Key: "N", Mailed: 100, "Opp Count": 1, "In Force": 0, "Total Converted Monthly Premiums": 0 },
    { "SCF Grouping": "010", Key: "N", Mailed: 50, "Opp Count": 0, "In Force": 1, "Total Converted Monthly Premiums": 15 },
    { "SCF Grouping": 10, Key: "N", Mailed: 16, "Opp Count": 0, "In Force": 0, "Total Converted Monthly Premiums": 0 },
  ]);

  const row = getAggregateRow(dataset, "010");
  assert.equal(row["Sum of Mailed"], "166");
  assert.equal(row["Sum of Opp Count"], "1");
  assert.equal(row["Sum of In Force"], "1");
  assert.equal(row["Sum of Sold"], "1");
  assert.equal(row["Sold Rate"], "0.6024096386");
  assert.equal(row["In Force Rate"], "0.6024096386");
  assert.equal(row["Converted Rate"], "0.6024096386");
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
