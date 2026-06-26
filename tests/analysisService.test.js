const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildAnalysisOverwriteProtection,
  buildAnalysisReportName,
  buildPersistedComparisonSetups,
  choosePreferredAnalysisScfRow,
  mergeAnalysisMetricRowsPreferNonZero,
} = require("../services/analysisService");

function loadAnalysisServiceWithTempDir(tempDir) {
  const servicePath = require.resolve("../services/analysisService");
  delete require.cache[servicePath];
  process.env.HPA_ANALYSIS_DATA_DIR = tempDir;
  return require("../services/analysisService");
}

function createTempAnalysisDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpa-analysis-persistence-"));
}

function createComparisonPayload(overrides = {}) {
  return {
    runName: "June 2026",
    status: "draft",
    notes: "Persist comparison setup",
    reportPulls: [
      {
        id: "pull_a",
        savedReportId: "report_a",
        reportName: "NHCL Jan 2026 - May 2026",
        reportId: "00OQm000003PIxhMAG",
        keyCodes: ["N"],
      },
      {
        id: "pull_b",
        savedReportId: "report_b",
        reportName: "NHCL Jan 2013 - Dec 2025",
        reportId: "00OQm000003PIxhMAG",
        keyCodes: ["N"],
      },
    ],
    comparisonRequests: [
      {
        id: "comparison_nhcl",
        comparisonName: "NHCL Compare",
        keyCodeGroup: "NHCL",
        selectedReportIds: ["report_a", "report_b"],
        reportIds: ["report_a", "report_b"],
        reportAId: "report_a",
        reportBId: "report_b",
      },
    ],
    reviewState: {
      selectedComparisonId: "comparison_nhcl",
      lastEditedComparisonId: "comparison_nhcl",
      reviewPrimaryReportIds: {
        comparison_nhcl: "report_a",
      },
      reviewSelectedScfs: {
        comparison_nhcl: "010",
      },
    },
    commitComparisonSetup: true,
    ...overrides,
  };
}

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

test("analysis report names use Refinance title format with run date", () => {
  const reportName = buildAnalysisReportName(
    {
      createdAt: "2026-06-26T15:30:00.000Z",
      runName: "June 2026",
    },
    {
      keyCodes: ["RFC"],
      dateRange: {
        startDate: "2013-01-01",
        endDate: "2025-12-31",
      },
      analysisLabel: "RFC - Jan 2013 - Dec 2025",
    }
  );

  assert.equal(reportName, "Refinance - Jan 2013 - Dec 2025 (06/26/2026)");
});

test("analysis report names use New Home title format with run date", () => {
  const reportName = buildAnalysisReportName(
    {
      createdAt: "2026-06-26T15:30:00.000Z",
      runName: "June 2026",
    },
    {
      keyCodes: ["N"],
      dateRange: {
        startDate: "2026-01-01",
        endDate: "2026-05-31",
      },
      analysisLabel: "NHCL - Jan 2026 - May 2026",
    }
  );

  assert.equal(reportName, "New Home - Jan 2026 - May 2026 (06/26/2026)");
});

test("buildPersistedComparisonSetups stores primary report and selected scf per comparison", () => {
  const entries = buildPersistedComparisonSetups(
    "setup_123",
    [
      {
        id: "comparison_1",
        comparisonName: "RFC Compare",
        keyCodeGroup: "RFC",
        selectedReportIds: ["report_1", "report_2"],
      },
    ],
    {
      selectedComparisonId: "comparison_1",
      reviewPrimaryReportIds: { comparison_1: "report_1" },
      reviewSelectedScfs: { comparison_1: "033" },
    },
    []
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].analysisSetupId, "setup_123");
  assert.equal(entries[0].primaryReportId, "report_1");
  assert.equal(entries[0].selectedScf, "033");
  assert.deepEqual(entries[0].selectedReportIds, ["report_1", "report_2"]);
});

test("saving a comparison setup writes it to persistent storage and reload survives refresh", (t) => {
  const tempDir = createTempAnalysisDir();
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup(createComparisonPayload());
  const persistedFile = path.join(tempDir, "analysis-setups.json");

  assert.equal(fs.existsSync(persistedFile), true);
  assert.equal(saved.comparisonRequests.length, 1);
  assert.equal(saved.comparisonSetups.length, 1);
  assert.equal(saved.comparisonSetups[0].primaryReportId, "report_a");
  assert.equal(saved.comparisonSetups[0].selectedScf, "010");

  service = loadAnalysisServiceWithTempDir(tempDir);
  const reloaded = service.getAnalysisSetup(saved.id);

  assert.ok(reloaded);
  assert.equal(reloaded.id, saved.id);
  assert.equal(reloaded.reviewState.selectedComparisonId, "comparison_nhcl");
  assert.equal(reloaded.comparisonRequests[0].comparisonName, "NHCL Compare");
  assert.equal(reloaded.comparisonSetups[0].primaryReportId, "report_a");
});

test("empty local draft style saves cannot overwrite a committed comparison setup", (t) => {
  const tempDir = createTempAnalysisDir();
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup(createComparisonPayload());

  assert.throws(
    () =>
      service.saveAnalysisSetup({
        id: saved.id,
        runName: saved.runName,
        reportPulls: saved.reportPulls,
        comparisonRequests: [],
        reviewState: {
          selectedComparisonId: "",
          lastEditedComparisonId: "",
          reviewPrimaryReportIds: {},
          reviewSelectedScfs: {},
        },
        commitComparisonSetup: true,
      }),
    /cannot be overwritten with an empty draft/i
  );

  const preserved = service.getAnalysisSetup(saved.id);
  assert.equal(preserved.comparisonRequests.length, 1);
  assert.equal(preserved.comparisonSetups[0].primaryReportId, "report_a");
});

test("delete removes only the requested persisted comparison setup", (t) => {
  const tempDir = createTempAnalysisDir();
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup(createComparisonPayload({
    comparisonRequests: [
      {
        id: "comparison_nhcl",
        comparisonName: "NHCL Compare",
        keyCodeGroup: "NHCL",
        selectedReportIds: ["report_a", "report_b"],
      },
      {
        id: "comparison_rfc",
        comparisonName: "RFC Compare",
        keyCodeGroup: "RFC",
        selectedReportIds: ["report_c", "report_d"],
      },
    ],
    reviewState: {
      selectedComparisonId: "comparison_nhcl",
      lastEditedComparisonId: "comparison_rfc",
      reviewPrimaryReportIds: {
        comparison_nhcl: "report_a",
        comparison_rfc: "report_c",
      },
      reviewSelectedScfs: {
        comparison_nhcl: "010",
        comparison_rfc: "143",
      },
    },
  }));

  const updated = service.deleteAnalysisComparisonSetup(saved.id, "comparison_nhcl");

  assert.equal(updated.comparisonRequests.length, 1);
  assert.equal(updated.comparisonRequests[0].id, "comparison_rfc");
  assert.equal(updated.reviewState.selectedComparisonId, "comparison_rfc");
  assert.equal(updated.comparisonSetups.length, 1);
  assert.equal(updated.comparisonSetups[0].id, "comparison_rfc");
});
