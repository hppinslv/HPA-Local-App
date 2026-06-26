const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnalysisOverwriteProtection,
  choosePreferredAnalysisScfRow,
  mergeAnalysisMetricRowsPreferNonZero,
} = require("../services/analysisService");

test("detail-derived nonzero metrics are not overwritten by zero live fallback data", () => {
  const warnings = buildAnalysisOverwriteProtection(
    {
      "Sum of Mailed": "166",
      "Sum of Opp Count": "1",
      "Sum of In Force": "1",
      "Sum of Sold": "1",
      "Sold Rate": "0.6024096386",
      "In Force Rate": "0.6024096386",
      "Converted Rate": "0.6024096386",
    },
    {
      "Sum of Mailed": "166",
      "Sum of Opp Count": "0",
      "Sum of In Force": "0",
      "Sum of Sold": "0",
      "Sold Rate": "0.0000000000",
      "In Force Rate": "0.0000000000",
      "Converted Rate": "0.0000000000",
    }
  );

  assert.ok(warnings.includes("Sum of Opp Count: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Sum of In Force: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Sum of Sold: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Sold Rate: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Converted Rate: protected saved nonzero value against live zero"));
});

test("detail aggregate wins over saved summary and live fallback", () => {
  const selected = choosePreferredAnalysisScfRow({
    detailRow: { "SCF Grouping": "010", "Sum of Opp Count": "2", "Converted Rate": "1.0000000000" },
    savedSummaryRow: { "SCF Grouping": "010", "Sum of Opp Count": "0", "Converted Rate": "0.0000000000" },
    liveRow: { "SCF Grouping": "010", "Sum of Opp Count": "0", "Converted Rate": "0.0000000000" },
  });

  assert.equal(selected.source, "detail-export-rows");
  assert.equal(selected.row["Sum of Opp Count"], "2");
});

test("missing detail rows fall back to saved summary before live fallback", () => {
  const selected = choosePreferredAnalysisScfRow({
    detailRow: null,
    savedSummaryRow: { "SCF Grouping": "011", "Sum of Opp Count": "3" },
    liveRow: { "SCF Grouping": "011", "Sum of Opp Count": "1" },
  });

  assert.equal(selected.source, "saved-summary-rows");
  assert.equal(selected.row["Sum of Opp Count"], "3");
});

test("live fallback is used only when detail and saved summary are unavailable", () => {
  const selected = choosePreferredAnalysisScfRow({
    detailRow: null,
    savedSummaryRow: null,
    liveRow: { "SCF Grouping": "012", "Sum of Opp Count": "1" },
  });

  assert.equal(selected.source, "salesforce-scoped-refetch");
  assert.equal(selected.row["Sum of Opp Count"], "1");
});

test("live fallback can supplement zero saved summary values without clobbering nonzero saved values", () => {
  const merged = mergeAnalysisMetricRowsPreferNonZero(
    {
      "SCF Grouping": "013",
      "Sum of Mailed": "748",
      "Sum of Opp Count": "0",
      "Sum of In Force": "0",
      "Sum of Sold": "0",
      "Sold Rate": "0.0000000000",
    },
    {
      "SCF Grouping": "013",
      "Sum of Mailed": "748",
      "Sum of Opp Count": "1",
      "Sum of In Force": "0",
      "Sum of Sold": "0",
      "Sold Rate": "0.1336898396",
    }
  );

  assert.equal(merged["Sum of Mailed"], "748");
  assert.equal(merged["Sum of Opp Count"], "1");
  assert.equal(merged["Sold Rate"], "0.1336898396");
});
