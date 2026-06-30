const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  addReferenceListItems,
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

function seedReferenceLists(tempDir, overrides = {}) {
  const payload = {
    updatedAt: "2026-06-26T00:00:00.000Z",
    history: [],
    lists: [
      { type: "dnm", name: "Do Not Mail", sourceName: "Test", items: [] },
      { type: "nhcl", name: "NHCL Mailing SCFs", sourceName: "Test", items: [] },
      { type: "rfc", name: "RFC Mailing SCFs", sourceName: "Test", items: [] },
      { type: "candidate", name: "Candidate SCFs", sourceName: "Test", items: [] },
    ],
    ...overrides,
  };
  fs.writeFileSync(path.join(tempDir, "scf-reference-lists.json"), JSON.stringify(payload, null, 2));
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
      reviewCompletedByName: "Melinda Harris",
      reviewCompletedOnDate: "2026-06-26",
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
      "Sum of Converted": "1",
      "Sold Rate": "0.6024096386",
      "In Force Rate": "0.6024096386",
      "Converted Rate": "0.6024096386",
    },
    {
      "Sum of Mailed": "166",
      "Sum of Opp Count": "0",
      "Sum of In Force": "0",
      "Sum of Converted": "0",
      "Sold Rate": "0.0000000000",
      "In Force Rate": "0.0000000000",
      "Converted Rate": "0.0000000000",
    }
  );

  assert.ok(warnings.includes("Sum of Opp Count: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Sum of In Force: protected saved nonzero value against live zero"));
  assert.ok(warnings.includes("Sum of Converted: protected saved nonzero value against live zero"));
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
      "Sum of Converted": "0",
      "Sold Rate": "0.0000000000",
    },
    {
      "SCF Grouping": "013",
      "Sum of Mailed": "748",
      "Sum of Opp Count": "1",
      "Sum of In Force": "0",
      "Sum of Converted": "0",
      "Sold Rate": "0.1336898396",
    }
  );

  assert.equal(merged["Sum of Mailed"], "748");
  assert.equal(merged["Sum of Opp Count"], "1");
  assert.equal(merged["Sold Rate"], "0.1336898396");
});

test("saved analysis reports relabel legacy sum of sold as sum of converted in view and export columns", () => {
  const tempDir = createTempAnalysisDir();
  fs.writeFileSync(
    path.join(tempDir, "analysis-reports.json"),
    JSON.stringify([
      {
        id: "report_1",
        runId: "run_1",
        pullId: "pull_1",
        report_type: "analysis-report",
        report_name: "Test Report",
        run_month: "June",
        run_year: 2026,
        created_at: "2026-06-29T00:00:00.000Z",
        updated_at: "2026-06-29T00:00:00.000Z",
        completed_at: "2026-06-29T00:00:00.000Z",
        status: "complete",
        result_count: 1,
        export_row_count: 1,
        input_row_count: 1,
        summaryValues: [{ key: "Sum of Sold", label: "Sum of Sold", value: "1" }],
        columns: [{ key: "Sum of Sold", label: "Sum of Sold", normalized: "sum of sold" }],
        rows: [{ "Sum of Sold": "1" }],
        exportColumns: [{ key: "Sum of Sold", label: "Sum of Sold", normalized: "sum of sold" }],
        exportRows: [{ "Sum of Sold": "1" }],
      },
    ], null, 2)
  );

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const [report] = service.listAnalysisReports();

  assert.equal(report.columns[0].label, "Sum of Converted");
  assert.equal(report.summaryValues[0].label, "Sum of Converted");
  assert.equal(report.rows[0]["Sum of Converted"], "1");
  assert.equal(report.exportColumns[0].label, "Sum of Converted");
  assert.equal(report.exportRows[0]["Sum of Converted"], "1");
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
  seedReferenceLists(tempDir);
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
  assert.equal(saved.reviewState.reviewCompletedByName, "Melinda Harris");
  assert.equal(saved.reviewState.reviewCompletedOnDate, "2026-06-26");

  service = loadAnalysisServiceWithTempDir(tempDir);
  const reloaded = service.getAnalysisSetup(saved.id);

  assert.ok(reloaded);
  assert.equal(reloaded.id, saved.id);
  assert.equal(reloaded.reviewState.selectedComparisonId, "comparison_nhcl");
  assert.equal(reloaded.comparisonRequests[0].comparisonName, "NHCL Compare");
  assert.equal(reloaded.comparisonSetups[0].primaryReportId, "report_a");
  assert.equal(reloaded.reviewState.reviewCompletedByName, "Melinda Harris");
});

test("older saved setups recover comparison groups from report pulls and backfill saved report ids", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(tempDir, "analysis-reports.json"),
    JSON.stringify(
      [
        {
          id: "report_nhcl_current",
          pullId: "pull_nhcl_current",
          status: "complete",
          result_count: 256,
          report_name: "New Home - Jan 2026 - May 2026 (06/26/2026)",
          parameters: { client_type: "NHCL", key_codes: ["N"] },
        },
        {
          id: "report_nhcl_old",
          pullId: "pull_nhcl_old",
          status: "complete",
          result_count: 796,
          report_name: "New Home - Jan 2013 - Dec 2025 (06/26/2026)",
          parameters: { client_type: "NHCL", key_codes: ["N"] },
        },
        {
          id: "report_rfc_current",
          pullId: "pull_rfc_current",
          status: "complete",
          result_count: 466,
          report_name: "Refinance - Jan 2026 - May 2026 (06/26/2026)",
          parameters: { client_type: "RFC", key_codes: ["RFC"] },
        },
        {
          id: "report_rfc_old",
          pullId: "pull_rfc_old",
          status: "complete",
          result_count: 890,
          report_name: "Refinance - Jan 2013 - Dec 2025 (06/26/2026)",
          parameters: { client_type: "RFC", key_codes: ["RFC"] },
        },
      ],
      null,
      2
    )
  );

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup({
    runName: "June 2026",
    status: "draft",
    reportPulls: [
      { id: "pull_nhcl_current", reportName: "NHCL - Jan 2026 - May 2026", reportId: "00OQm000003PIxhMAG", keyCodes: ["N"] },
      { id: "pull_nhcl_old", reportName: "NHCL - Jan 2013 - Dec 2025", reportId: "00OQm000003PIxhMAG", keyCodes: ["N"] },
      { id: "pull_rfc_current", reportName: "RFC - Jan 2026 - May 2026", reportId: "00OQm000003PIxhMAG", keyCodes: ["RFC"] },
      { id: "pull_rfc_old", reportName: "RFC - Jan 2013 - Dec 2025", reportId: "00OQm000003PIxhMAG", keyCodes: ["RFC"] },
    ],
    comparisonRequests: [],
    reviewState: {},
  });

  assert.deepEqual(
    saved.reportPulls.map((pull) => pull.savedReportId),
    ["report_nhcl_current", "report_nhcl_old", "report_rfc_current", "report_rfc_old"]
  );
  assert.equal(saved.comparisonRequests.length, 2);
  assert.deepEqual(
    saved.comparisonRequests.map((entry) => entry.comparisonName),
    ["New Home", "Refinance"]
  );
  assert.deepEqual(saved.comparisonRequests[0].selectedReportIds, ["report_nhcl_current", "report_nhcl_old"]);
  assert.deepEqual(saved.comparisonRequests[1].selectedReportIds, ["report_rfc_current", "report_rfc_old"]);
  assert.equal(saved.reviewState.reviewPrimaryReportIds.comparison_nhcl, "report_nhcl_current");
  assert.equal(saved.reviewState.reviewPrimaryReportIds.comparison_rfc, "report_rfc_current");
});

test("review debug resolves saved primary report rows from pull ids", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(tempDir, "analysis-reports.json"), JSON.stringify([
    {
      id: "report_nhcl_saved",
      pullId: "pull_nhcl",
      report_name: "NHCL 2026.06.26 - Jan 2013 - Dec 2025",
      parameters: {
        key_codes: ["NHCL"],
        client_type: "NHCL",
      },
      rows: [
        {
          "SCF Grouping": "143",
          "Sum of Mailed": "489",
          "Sold Rate": "0.8179959100",
          "In Force Rate": "0.0000000000",
          "Converted Rate": "0.0000000000",
        },
      ],
    },
  ], null, 2));

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup({
    ...createComparisonPayload({
      reportPulls: [
        {
          id: "pull_nhcl",
          reportName: "NHCL Jan 2013 - Dec 2025",
          reportId: "00OQm000003PIxhMAG",
          keyCodes: ["NHCL"],
          clientType: "NHCL",
        },
        {
          id: "pull_nhcl_b",
          savedReportId: "report_nhcl_saved_b",
          reportName: "NHCL Jan 2026 - May 2026",
          reportId: "00OQm000003PIxhMAG",
          keyCodes: ["NHCL"],
          clientType: "NHCL",
        },
      ],
      comparisonRequests: [],
      reviewState: {
        selectedComparisonId: "",
        lastEditedComparisonId: "",
        reviewPrimaryReportIds: {},
      },
    }),
  });

  const debug = service.getAnalysisSetupReviewDebug(saved.id);

  assert.equal(debug.setupId, saved.id);
  assert.equal(debug.comparisonRequestsCount, 1);
  assert.equal(debug.selectedPrimaryReportId, "report_nhcl_saved");
  assert.equal(debug.resolvedPrimaryReportId, "report_nhcl_saved");
  assert.equal(debug.selectedPrimaryReportExists, true);
  assert.equal(debug.savedReportRowCount, 1);
  assert.ok(debug.fieldHints.scfFieldKeys.includes("SCF Grouping"));
  assert.ok(debug.fieldHints.mailedFieldKeys.includes("Sum of Mailed"));
});

test("manual DNM SCF add preserves the typed state/scope", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const result = service.addReferenceListItems({
    listType: "dnm",
    scfs: ["206"],
    state: "Louisiana",
    actor: "Local User",
    sourceName: "manual-list-manager",
  });

  const entry = result.list.items.find((item) => item.scf === "206");
  assert.ok(entry);
  assert.equal(entry.scope, "Louisiana - just the AD&D");
  assert.equal(entry.state, "Louisiana - just the AD&D");
  assert.equal(entry.stateKey, "louisiana-add");
});

test("DNM state catalog keeps audited Maryland and West Virginia SCFs", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  service.addDnmStateGroup({ stateKey: "maryland", actor: "Local User" });
  service.addDnmStateGroup({ stateKey: "west-virginia", actor: "Local User" });

  const dnmList = service.getReferenceListByType("dnm");
  const scfs = new Set(dnmList.items.map((entry) => entry.scf).filter(Boolean));

  assert.ok(scfs.has("206"));
  assert.ok(scfs.has("217"));
  assert.ok(scfs.has("254"));
  assert.ok(scfs.has("267"));
  assert.ok(scfs.has("268"));
  assert.ok(!scfs.has("213"));
});

test("DNM state selector exposes corrected Maryland and West Virginia catalog entries", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const dnmList = service.getReferenceListByType("dnm");
  const marylandGroup = dnmList.availableStateGroups.find((group) => group.key === "maryland");
  const westVirginiaGroup = dnmList.availableStateGroups.find((group) => group.key === "west-virginia");

  assert.deepEqual(marylandGroup.scfs.slice(0, 3), ["206", "207", "208"]);
  assert.ok(marylandGroup.scfs.includes("217"));
  assert.ok(!marylandGroup.scfs.includes("267"));
  assert.ok(westVirginiaGroup.scfs.includes("254"));
  assert.ok(westVirginiaGroup.scfs.includes("267"));
  assert.ok(westVirginiaGroup.scfs.includes("268"));
});

test("existing Maryland DNM state groups are auto-repaired to include missing SCFs like 206", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir, {
    lists: [
      {
        type: "dnm",
        name: "Do Not Mail",
        sourceName: "Test",
        items: [
          { scf: "207", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "208", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "209", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "210", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "211", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "212", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "214", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "215", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "216", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "218", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "219", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
          { scf: "267", scope: "Maryland", addedAt: "2026-06-12T00:00:00.000Z", addedBy: "System Seed" },
        ],
      },
      { type: "nhcl", name: "NHCL Mailing SCFs", sourceName: "Test", items: [] },
      { type: "rfc", name: "RFC Mailing SCFs", sourceName: "Test", items: [] },
      { type: "candidate", name: "Candidate SCFs", sourceName: "Test", items: [] },
    ],
  });
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const dnmList = service.getReferenceListByType("dnm");
  const marylandItems = dnmList.items.filter((entry) => String(entry.scope || entry.state || "").includes("Maryland"));
  const marylandScfs = new Set(marylandItems.map((entry) => entry.scf));

  assert.ok(marylandScfs.has("206"));
  assert.ok(marylandScfs.has("217"));
  assert.ok(!marylandScfs.has("267"));

  const marylandGroup = dnmList.stateGroups.find((group) => group.key === "maryland");
  assert.ok(marylandGroup.matchesCatalog);
  assert.deepEqual(marylandGroup.missingScfs, []);
  assert.deepEqual(marylandGroup.extraScfs, []);
});

test("review working-list changes persist before completion and reload with the setup", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup(createComparisonPayload({
    reviewState: {
      selectedComparisonId: "comparison_nhcl",
      lastEditedComparisonId: "comparison_nhcl",
      reviewPrimaryReportIds: { comparison_nhcl: "report_a" },
      reviewSelectedScfs: { comparison_nhcl: "010" },
      reviewCompletedByName: "",
      reviewCompletedOnDate: "2026-06-26",
      reviewExcludedScfs: { comparison_nhcl: "010,011" },
      reviewBaselineLists: [
        { type: "nhcl", items: [{ scf: "010", state: "" }] },
        { type: "rfc", items: [{ scf: "143", state: "" }] },
      ],
      reviewWorkingLists: [
        { type: "nhcl", items: [{ scf: "010", state: "" }, { scf: "011", state: "" }] },
        { type: "rfc", items: [] },
      ],
      reviewZeroRateRemovals: [
        {
          id: "zero_remove_1",
          comparisonId: "comparison_nhcl",
          comparisonName: "NHCL Compare",
          primaryReportId: "report_a",
          primaryReportName: "New Home - Jan 2013 - Dec 2025 (06/26/2026)",
          listType: "nhcl",
          removalKind: "zero-quantity",
          metricKey: "soldRate",
          fieldUsed: "Sum of Mailed",
          checkedCount: 25,
          totalMailedRemoved: 0,
          removedScfs: ["010"],
          foundZeroRateScfs: ["010", "011"],
          skippedAlreadyRemovedScfs: ["011"],
          skippedDnmScfs: [],
          createdAt: "2026-06-26T15:30:00.000Z",
        },
      ],
      reviewZeroRemovalDiagnostics: {
        setupId: "setup_1",
        comparisonName: "NHCL Compare",
        selectedPrimaryReportId: "report_a",
        resolvedSavedReportId: "report_a",
        totalReportRowsChecked: 25,
        zeroRemovalFieldUsed: "Sum of Mailed",
        zeroRemovalMetricKey: "soldRate",
        zeroRemovalMetricLabel: "Sold Rate",
        zeroRemovalCandidateCount: 1,
        zeroValueCount: 1,
        blankOrNullCount: 0,
        nonNumericCount: 0,
        zeroRemovalOnWorkingListCount: 1,
        zeroRemovalAlreadyOffListCount: 0,
        zeroRemovalAlreadyDnmCount: 0,
        zeroRemovalSampleRows: [
          {
            scf: "010",
            metricKey: "soldRate",
            metricLabel: "Sold Rate",
            metricFieldKey: "Sold Rate",
            displayedMetricValue: "0.0000000000",
            rawMetricValue: "0.00%",
            parsedMetricValue: 0,
            parsedDisplayedMetricValue: 0,
            parsedRawMetricValue: 0,
            wouldRemove: true,
            onWorkingList: true,
            onDoNotMailList: false,
          },
        ],
        zeroRemovalLastResult: {
          status: "removed",
          removedCount: 1,
          totalMailedRemoved: 0,
          message: "Removed 1 zero-mailed SCF(s) from the working copy.",
          checkedAt: "2026-06-26T15:31:00.000Z",
        },
      },
    },
  }));

  service = loadAnalysisServiceWithTempDir(tempDir);
  const reloaded = service.getAnalysisSetup(saved.id);

  assert.deepEqual(reloaded.reviewState.reviewExcludedScfs, { comparison_nhcl: "010,011" });
  assert.deepEqual(reloaded.reviewState.reviewBaselineLists, [
    { type: "nhcl", name: "", sourceName: "", updatedAt: "", items: [{ scf: "010", state: "" }] },
    { type: "rfc", name: "", sourceName: "", updatedAt: "", items: [{ scf: "143", state: "" }] },
  ]);
  assert.deepEqual(reloaded.reviewState.reviewWorkingLists, [
    { type: "nhcl", name: "", sourceName: "", updatedAt: "", items: [{ scf: "010", state: "" }, { scf: "011", state: "" }] },
    { type: "rfc", name: "", sourceName: "", updatedAt: "", items: [] },
  ]);
  assert.deepEqual(reloaded.reviewState.reviewZeroRateRemovals, [
    {
      id: "zero_remove_1",
      comparisonId: "comparison_nhcl",
      comparisonName: "NHCL Compare",
      primaryReportId: "report_a",
      primaryReportName: "New Home - Jan 2013 - Dec 2025 (06/26/2026)",
      listType: "nhcl",
      removalKind: "zero-quantity",
      metricKey: "soldRate",
      fieldUsed: "Sum of Mailed",
      checkedCount: 25,
      totalMailedRemoved: 0,
      removedScfs: ["010"],
      foundZeroRateScfs: ["010", "011"],
      skippedAlreadyRemovedScfs: ["011"],
      skippedDnmScfs: [],
      createdAt: "2026-06-26T15:30:00.000Z",
      undoneAt: "",
    },
  ]);
  assert.deepEqual(reloaded.reviewState.reviewZeroRemovalDiagnostics, {
    setupId: "setup_1",
    comparisonName: "NHCL Compare",
    selectedPrimaryReportId: "report_a",
    resolvedSavedReportId: "report_a",
    totalReportRowsChecked: 25,
    zeroRemovalFieldUsed: "Sum of Mailed",
    zeroRemovalMetricKey: "soldRate",
    zeroRemovalMetricLabel: "Sold Rate",
    zeroRemovalCandidateCount: 1,
    zeroValueCount: 1,
    blankOrNullCount: 0,
    nonNumericCount: 0,
    zeroRemovalOnWorkingListCount: 1,
    zeroRemovalAlreadyOffListCount: 0,
    zeroRemovalAlreadyDnmCount: 0,
    zeroRemovalSampleRows: [
      {
        scf: "010",
        metricKey: "soldRate",
        metricLabel: "Sold Rate",
        metricFieldKey: "Sold Rate",
        displayedMetricValue: "0.0000000000",
        rawMetricValue: "0.00%",
        parsedMetricValue: 0,
        parsedDisplayedMetricValue: 0,
        parsedRawMetricValue: 0,
        wouldRemove: true,
        onWorkingList: true,
        onDoNotMailList: false,
      },
    ],
    zeroRemovalLastResult: {
      status: "removed",
      removedCount: 1,
      totalMailedRemoved: 0,
      message: "Removed 1 zero-mailed SCF(s) from the working copy.",
      checkedAt: "2026-06-26T15:31:00.000Z",
    },
  });
});

test("empty local draft style saves cannot overwrite a committed comparison setup", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
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
  seedReferenceLists(tempDir);
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

test("completed comparison review persistence keeps detailed added and removed SCF rows", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const saved = service.saveAnalysisSetup(createComparisonPayload({
    status: "complete",
    reviewState: {
      selectedComparisonId: "comparison_nhcl",
      lastEditedComparisonId: "comparison_nhcl",
      reviewPrimaryReportIds: {
        comparison_nhcl: "report_a",
      },
      reviewSelectedScfs: {
        comparison_nhcl: "010",
      },
      reviewCompletedByName: "Melinda Harris",
      reviewCompletedOnDate: "2026-06-26",
      reviewBaselineLists: [
        { type: "nhcl", items: [{ scf: "010", state: "" }, { scf: "011", state: "" }] },
        { type: "rfc", items: [{ scf: "143", state: "" }] },
      ],
      reviewWorkingLists: [
        { type: "nhcl", items: [{ scf: "010", state: "" }] },
        { type: "rfc", items: [{ scf: "143", state: "" }, { scf: "144", state: "" }] },
      ],
    },
    results: {
      comparisonReview: {
        summary: {
          generatedAt: "2026-06-26T15:30:00.000Z",
          runNotes: "Review notes",
          lists: {
            nhcl: {
              added: [],
              removed: [{ scf: "011", state: "" }],
              blocked: [],
              addedCount: 0,
              removedCount: 1,
              blockedCount: 0,
            },
            rfc: {
              added: [{ scf: "144", state: "" }],
              removed: [],
              blocked: [],
              addedCount: 1,
              removedCount: 0,
              blockedCount: 0,
            },
          },
          summary: {
            nhclAdded: 0,
            nhclRemoved: 1,
            rfcAdded: 1,
            rfcRemoved: 0,
            blockedCount: 0,
          },
          violations: [],
        },
        notes: "Review notes",
        completedAt: "2026-06-26T15:30:00.000Z",
        completedByName: "Melinda Harris",
        completedOnDate: "2026-06-26",
      },
    },
  }));

  const reopened = service.getAnalysisSetup(saved.id);
  assert.equal(reopened.results.comparisonReview.summary.lists.nhcl.removed[0].scf, "011");
  assert.equal(reopened.results.comparisonReview.summary.lists.rfc.added[0].scf, "144");
  assert.equal(reopened.results.comparisonReview.completedByName, "Melinda Harris");
});

test("undo latest completed analysis restores mailing lists to the pre-completion snapshot", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const setup = service.saveAnalysisSetup({
    ...createComparisonPayload({
      status: "complete",
      completedAt: "2026-06-26T15:30:00.000Z",
      referenceListsSnapshot: [
        { type: "nhcl", items: [{ scf: "010", state: "" }] },
        { type: "rfc", items: [{ scf: "143", state: "" }] },
      ],
      referenceListChanges: [
        { type: "nhcl", added: [{ scf: "011", state: "" }], removed: [] },
        { type: "rfc", added: [], removed: [{ scf: "143", state: "" }] },
      ],
    }),
  });

  const nhclBeforeUndo = service.getReferenceListByType("nhcl");
  const rfcBeforeUndo = service.getReferenceListByType("rfc");
  assert.deepEqual(nhclBeforeUndo.items.map((entry) => entry.scf).sort(), ["011"]);
  assert.deepEqual(rfcBeforeUndo.items.map((entry) => entry.scf).sort(), []);

  const undoResult = service.undoLatestCompletedAnalysis(setup.id, { actor: "Melinda Harris" });
  const nhclAfterUndo = service.getReferenceListByType("nhcl");
  const rfcAfterUndo = service.getReferenceListByType("rfc");

  assert.equal(undoResult.setup.status, "reverted");
  assert.equal(undoResult.setup.completionUndoneBy, "Melinda Harris");
  assert.deepEqual(nhclAfterUndo.items.map((entry) => entry.scf).sort(), ["010"]);
  assert.deepEqual(rfcAfterUndo.items.map((entry) => entry.scf).sort(), ["143"]);
  assert.ok(nhclAfterUndo.history.some((entry) => entry.actionType === "undo-analysis-complete"));
});

test("deleting a completed analysis restores list history and keeps normalized source names", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir, {
    lists: [
      { type: "dnm", name: "Do Not Mail", sourceName: "Test", items: [] },
      { type: "nhcl", name: "NHCL Mailing SCFs", sourceName: "NHCL SCF's_2025.10.xlsx", items: [{ scf: "010", state: "" }] },
      { type: "rfc", name: "RFC Mailing SCFs", sourceName: "RFC SCF's_2025.10.xlsx", items: [{ scf: "143", state: "" }] },
      { type: "candidate", name: "Candidate SCFs", sourceName: "Test", items: [] },
    ],
  });
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const setup = service.saveAnalysisSetup({
    ...createComparisonPayload({
      status: "complete",
      completedAt: "2026-06-26T15:30:00.000Z",
      referenceListsSnapshot: [
        { type: "nhcl", sourceName: "NHCL SCF's_2025.10", items: [{ scf: "010", state: "" }] },
        { type: "rfc", sourceName: "RFC SCF's_2025.10", items: [{ scf: "143", state: "" }] },
      ],
      referenceListChanges: [
        { type: "nhcl", added: [{ scf: "011", state: "" }], removed: [] },
        { type: "rfc", added: [], removed: [{ scf: "143", state: "" }] },
      ],
    }),
  });

  const deletion = service.deleteAnalysisSetup(setup.id, {
    revertReferenceLists: true,
    actor: "Melinda Harris",
  });
  const nhclAfterDelete = service.getReferenceListByType("nhcl");
  const rfcAfterDelete = service.getReferenceListByType("rfc");

  assert.deepEqual(deletion.revertedLists.sort(), ["nhcl", "rfc"]);
  assert.equal(nhclAfterDelete.sourceName, "NHCL SCF's_2025.10");
  assert.equal(rfcAfterDelete.sourceName, "RFC SCF's_2025.10");
  assert.ok(nhclAfterDelete.history.some((entry) => entry.actionType === "restore-analysis-delete"));
  assert.ok(rfcAfterDelete.history.some((entry) => entry.actionType === "restore-analysis-delete"));
});

test("saving a new open analysis archives older open analyses so only one stays active", (t) => {
  const tempDir = createTempAnalysisDir();
  seedReferenceLists(tempDir);
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const older = service.saveAnalysisSetup(createComparisonPayload({
    runName: "Older Open Analysis",
    status: "draft",
  }));
  const newest = service.saveAnalysisSetup(createComparisonPayload({
    id: undefined,
    runName: "Newest Open Analysis",
    status: "draft",
  }));

  const setups = service.listAnalysisSetups();
  const olderReloaded = setups.find((entry) => entry.id === older.id);
  const newestReloaded = setups.find((entry) => entry.id === newest.id);

  assert.equal(newestReloaded?.archived, false);
  assert.equal(olderReloaded?.archived, true);
  assert.equal(setups.filter((entry) => !entry.archived && entry.status === "draft").length, 1);
});

test("only the most recent completed analysis can be undone", (t) => {
  const tempDir = createTempAnalysisDir();
  t.after(() => {
    delete process.env.HPA_ANALYSIS_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = loadAnalysisServiceWithTempDir(tempDir);
  const olderSetup = service.saveAnalysisSetup({
    ...createComparisonPayload({
      status: "complete",
      completedAt: "2026-06-25T15:30:00.000Z",
      referenceListsSnapshot: [
        { type: "nhcl", items: [] },
        { type: "rfc", items: [] },
      ],
      referenceListChanges: [
        { type: "nhcl", added: [{ scf: "143", state: "" }], removed: [] },
      ],
    }),
  });
  const latestSetup = service.saveAnalysisSetup({
    ...createComparisonPayload({
      id: undefined,
      status: "complete",
      completedAt: "2026-06-26T15:30:00.000Z",
      referenceListsSnapshot: [
        { type: "nhcl", items: [{ scf: "143", state: "" }] },
        { type: "rfc", items: [] },
      ],
      referenceListChanges: [
        { type: "nhcl", added: [{ scf: "144", state: "" }], removed: [] },
      ],
    }),
  });

  assert.throws(
    () => service.undoLatestCompletedAnalysis(olderSetup.id, { actor: "Melinda Harris" }),
    /most recent completed analysis/i
  );
  assert.doesNotThrow(() => service.undoLatestCompletedAnalysis(latestSetup.id, { actor: "Melinda Harris" }));
});
