const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  buildFlatRowsFromDetailExport,
  fetchAnalysisReportScfMetrics,
  fetchFlexibleSalesforceReportData,
  hasAnalysisDetailExportRows,
  normalizeLabel,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const ANALYSIS_STORAGE_DIR = process.env.HPA_ANALYSIS_DATA_DIR
  ? path.resolve(process.env.HPA_ANALYSIS_DATA_DIR)
  : DATA_DIR;
const ANALYSIS_RUNS_PATH = path.join(ANALYSIS_STORAGE_DIR, "analysis-runs.json");
const ANALYSIS_SETUPS_PATH = path.join(ANALYSIS_STORAGE_DIR, "analysis-setups.json");
const ANALYSIS_REPORTS_PATH = path.join(ANALYSIS_STORAGE_DIR, "analysis-reports.json");
const SCF_REFERENCE_LISTS_PATH = path.join(ANALYSIS_STORAGE_DIR, "scf-reference-lists.json");
const ANALYSIS_REFERENCE_LIST_EXPORT_DIR = path.join(os.tmpdir(), "hpa-reference-list-exports");
const ANALYSIS_REPORT_EXPORT_DIR = path.join(os.tmpdir(), "hpa-analysis-report-exports");
const ANALYSIS_COMPARISON_ARTIFACT_DIR = path.join(DATA_DIR, "analysis-comparison-artifacts");
const ANALYSIS_RUNS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-analysis-runs.json");
const ANALYSIS_SETUPS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-analysis-setups.json");
const ANALYSIS_REPORTS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-analysis-reports.json");
const SCF_REFERENCE_LISTS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-scf-reference-lists.json");
const ANALYSIS_RUNS_SUPABASE_KEY = "analysis-runs.json";
const ANALYSIS_SETUPS_SUPABASE_KEY = "analysis-setups.json";
const ANALYSIS_REPORTS_SUPABASE_KEY = "analysis-reports.json";
const SCF_REFERENCE_LISTS_SUPABASE_KEY = "scf-reference-lists.json";

const DEFAULT_REPORT_ID = "00OQm000003PIxhMAG";
const DEFAULT_ACTOR = "Local User";

function parseAnalysisMetricNumber(value) {
  const normalized = Number(String(value ?? "").replace(/[$,%(),\s]/g, ""));
  return Number.isFinite(normalized) ? normalized : 0;
}

function isSparseSavedAnalysisMetricRow(row = {}) {
  const oppCount = parseAnalysisMetricNumber(row["Sum of Opp Count"] ?? row["sum of opp count"] ?? 0);
  const totalMonthlyPremium = parseAnalysisMetricNumber(
    row["Sum of Total Monthly Premium"] ?? row["sum of total monthly premium"] ?? 0
  );
  const inForceMonthlyPremium = parseAnalysisMetricNumber(
    row["Sum of In Force Monthly Premium"] ?? row["sum of in force monthly premium"] ?? 0
  );
  const convertedPremium = parseAnalysisMetricNumber(
    row["Sum of Total Converted Monthly Premiums"] ?? row["sum of total converted monthly premiums"] ?? 0
  );
  return oppCount > 0 && totalMonthlyPremium === 0 && inForceMonthlyPremium === 0 && convertedPremium === 0;
}

function getAnalysisMetricNumber(row = {}, labels = []) {
  const requested = Array.isArray(labels) ? labels : [labels];
  for (const label of requested) {
    const normalizedTarget = normalizeLabel(label);
    for (const [key, value] of Object.entries(row || {})) {
      if (normalizeLabel(key) === normalizedTarget) {
        return parseAnalysisMetricNumber(value);
      }
    }
  }
  return 0;
}

function getAnalysisMetricRawValue(row = {}, labels = []) {
  const requested = Array.isArray(labels) ? labels : [labels];
  for (const label of requested) {
    const normalizedTarget = normalizeLabel(label);
    for (const [key, value] of Object.entries(row || {})) {
      if (normalizeLabel(key) === normalizedTarget) {
        return value;
      }
    }
  }
  return "";
}

function findAnalysisSummaryRow(rows = [], normalizedScf, normalizedKeys = []) {
  return ensureArray(rows).filter((row) => {
    const rowScf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row.scf ?? "");
    if (rowScf !== normalizedScf) {
      return false;
    }
    if (!normalizedKeys.length) {
      return true;
    }
    const rowKey = String(row["Key"] ?? row.key ?? "").trim().toUpperCase();
    return normalizedKeys.includes(rowKey);
  });
}

function normalizeAnalysisStoredKeyCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "NHCL" || normalized === "N") {
    return "N";
  }
  if (normalized === "RFC") {
    return "RFC";
  }
  return normalized;
}

function getAnalysisRateFieldCandidates(rows = []) {
  const candidates = {
    mailed: new Set(),
    soldCount: new Set(),
    inForceCount: new Set(),
    convertedPremium: new Set(),
  };
  const patterns = {
    mailed: ["mailed"],
    soldCount: ["opp count", "applications received", "application count", "sold"],
    inForceCount: ["in force", "inforce"],
    convertedPremium: ["converted monthly premium"],
  };

  ensureArray(rows).forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      const normalized = normalizeLabel(key);
      Object.entries(patterns).forEach(([metric, metricPatterns]) => {
        if (metricPatterns.some((pattern) => normalized.includes(pattern))) {
          candidates[metric].add(key);
        }
      });
    });
  });

  return {
    mailed: Array.from(candidates.mailed),
    soldCount: Array.from(candidates.soldCount),
    inForceCount: Array.from(candidates.inForceCount),
    convertedPremium: Array.from(candidates.convertedPremium),
  };
}

function summarizeAnalysisRateRow(row = {}) {
  const mailed = getAnalysisMetricNumber(row, ["Sum of Mailed", "Mailed"]);
  const soldCount = getAnalysisMetricNumber(row, [
    "Sum of Opp Count",
    "Opp Count",
    "Applications Received",
    "Application Count",
  ]);
  const inForceCount = getAnalysisMetricNumber(row, ["Sum of In Force", "In Force"]);
  const convertedCount = Number.isFinite(Number(row?.appConvertedCount))
    ? Number(row.appConvertedCount)
    : getAnalysisMetricNumber(row, ["Sum of Converted", "Converted", "Sum of Sold", "Sold"]);
  const convertedPremiumTotal = getAnalysisMetricNumber(row, [
    "Sum of Total Converted Monthly Premiums",
    "Total Converted Monthly Premiums",
  ]);
  const soldRate = getAnalysisMetricNumber(row, ["Sold Rate"]);
  const inForceRate = getAnalysisMetricNumber(row, ["In Force Rate"]);
  const convertedRate = getAnalysisMetricNumber(row, ["Converted Rate"]);
  const salesforceSoldRate = Number.isFinite(Number(row.salesforceSoldRate))
    ? Number(row.salesforceSoldRate)
    : soldRate;
  const salesforceInForceRate = Number.isFinite(Number(row.salesforceInForceRate))
    ? Number(row.salesforceInForceRate)
    : inForceRate;
  const appConvertedRate = Number.isFinite(Number(row.appConvertedRate))
    ? Number(row.appConvertedRate)
    : convertedRate;

  return {
    mailed,
    soldCount,
    inForceCount,
    convertedCount,
    convertedPremiumTotal,
    soldRate,
    inForceRate,
    convertedRate,
    salesforceSoldRate,
    salesforceInForceRate,
    appConvertedRate,
  };
}

function buildAnalysisOverwriteProtection(baseRow = {}, candidateRow = {}) {
  const warnings = [];
  [
    "Sum of Mailed",
    "Sum of Opp Count",
    "Sum of In Force",
    "Sum of Sold",
    "Sold Rate",
    "In Force Rate",
    "Converted Rate",
  ].forEach((label) => {
    const baseValue = getAnalysisMetricNumber(baseRow, [label]);
    const candidateValue = getAnalysisMetricNumber(candidateRow, [label]);
    const candidateRaw = getAnalysisMetricRawValue(candidateRow, [label]);
    if (
      (candidateRaw === "" || candidateRaw === null || candidateRaw === undefined || candidateValue === 0) &&
      baseValue > 0
    ) {
      warnings.push(`${label}: protected saved nonzero value against live zero`);
    }
  });
  return warnings;
}

function choosePreferredAnalysisScfRow({
  detailRow = null,
  savedSummaryRow = null,
  liveRow = null,
} = {}) {
  if (detailRow) {
    return { row: detailRow, source: "detail-export-rows" };
  }
  if (savedSummaryRow) {
    return { row: savedSummaryRow, source: "saved-summary-rows" };
  }
  if (liveRow) {
    return { row: liveRow, source: "salesforce-scoped-refetch" };
  }
  return { row: null, source: "no-source" };
}

function shouldSupplementSavedSummaryRow(row = {}) {
  const metrics = summarizeAnalysisRateRow(row);
  return (
    metrics.mailed > 0 &&
    metrics.soldCount === 0 &&
    metrics.inForceCount === 0 &&
    metrics.convertedCount === 0 &&
    metrics.soldRate === 0 &&
    metrics.inForceRate === 0 &&
    metrics.convertedRate === 0
  );
}

function mergeAnalysisMetricRowsPreferNonZero(baseRow = {}, candidateRow = {}) {
  const mergedRow = {
    ...(baseRow && typeof baseRow === "object" ? baseRow : {}),
    ...(candidateRow && typeof candidateRow === "object" ? candidateRow : {}),
  };

  [
    "SCF Grouping",
    "Key",
    "Sum of Mailed",
    "Sum of Opp Count",
    "Sum of In Force",
    "Sum of Sold",
    "Sum of Total Monthly Premium",
    "Sum of In Force Monthly Premium",
    "Sum of Total Converted Monthly Premiums",
    "Sold Rate",
    "In Force Rate",
    "Converted Rate",
  ].forEach((label) => {
    const baseRaw = getAnalysisMetricRawValue(baseRow, [label]);
    const candidateRaw = getAnalysisMetricRawValue(candidateRow, [label]);
    const baseValue = getAnalysisMetricNumber(baseRow, [label]);
    const candidateValue = getAnalysisMetricNumber(candidateRow, [label]);
    if (
      (candidateRaw === "" || candidateRaw === null || candidateRaw === undefined || candidateValue === 0) &&
      baseRaw !== "" &&
      baseRaw !== null &&
      baseRaw !== undefined &&
      baseValue > 0
    ) {
      mergedRow[label] = baseRaw;
    }
  });

  return mergedRow;
}

const DNM_CATALOG_HEADER = "Per Amalgamated, states we can not mail 9/19/2024:";
const DNM_SEED_GROUPS = [
  { key: "alabama", state: "Alabama", label: "Alabama", scope: "Alabama", scfs: [] },
  { key: "alaska", state: "Alaska", label: "Alaska", scope: "Alaska", scfs: [] },
  { key: "arizona", state: "Arizona", label: "Arizona", scope: "Arizona", scfs: [] },
  { key: "arkansas", state: "Arkansas", label: "Arkansas", scope: "Arkansas", scfs: [] },
  { key: "california", state: "California", label: "California", scope: "California", scfs: [] },
  { key: "colorado", state: "Colorado", label: "Colorado", scope: "Colorado", scfs: [] },
  { key: "connecticut", state: "Connecticut", label: "Connecticut", scope: "Connecticut", scfs: [] },
  { key: "delaware", state: "Delaware", label: "Delaware", scope: "Delaware", scfs: [] },
  { key: "district-of-columbia", state: "District of Columbia", label: "District of Columbia", scope: "District of Columbia", scfs: [] },
  { key: "florida", state: "Florida", label: "Florida", scope: "Florida", scfs: [] },
  { key: "georgia", state: "Georgia", label: "Georgia", scope: "Georgia", scfs: [] },
  { key: "hawaii", state: "Hawaii", label: "Hawaii", scope: "Hawaii", scfs: [] },
  { key: "idaho", state: "Idaho", label: "Idaho", scope: "Idaho", scfs: [] },
  { key: "illinois", state: "Illinois", label: "Illinois", scope: "Illinois", scfs: [] },
  { key: "indiana", state: "Indiana", label: "Indiana", scope: "Indiana", scfs: [] },
  { key: "iowa", state: "Iowa", label: "Iowa", scope: "Iowa", scfs: [] },
  { key: "kansas", state: "Kansas", label: "Kansas", scope: "Kansas", scfs: [] },
  { key: "kentucky", state: "Kentucky", label: "Kentucky", scope: "Kentucky", scfs: [] },
  { key: "louisiana-add", state: "Louisiana", label: "Louisiana - just the AD&D", scope: "Louisiana - just the AD&D", scfs: ["700", "701", "703", "704", "705", "706", "707", "708", "710", "711", "712", "713", "714"] },
  { key: "maine", state: "Maine", label: "Maine", scope: "Maine", scfs: [] },
  { key: "maryland", state: "Maryland", label: "Maryland", scope: "Maryland", scfs: ["207", "208", "209", "210", "211", "212", "214", "215", "216", "218", "219", "267"] },
  { key: "massachusetts", state: "Massachusetts", label: "Massachusetts", scope: "Massachusetts", scfs: [] },
  { key: "michigan", state: "Michigan", label: "Michigan", scope: "Michigan", scfs: [] },
  { key: "minnesota", state: "Minnesota", label: "Minnesota", scope: "Minnesota", scfs: [] },
  { key: "mississippi", state: "Mississippi", label: "Mississippi", scope: "Mississippi", scfs: [] },
  { key: "missouri", state: "Missouri", label: "Missouri", scope: "Missouri", scfs: [] },
  { key: "montana", state: "Montana", label: "Montana", scope: "Montana", scfs: ["590", "591", "592", "593", "594", "595", "596", "597", "598", "599"] },
  { key: "nebraska", state: "Nebraska", label: "Nebraska", scope: "Nebraska", scfs: [] },
  { key: "nevada", state: "Nevada", label: "Nevada", scope: "Nevada", scfs: [] },
  { key: "new-hampshire", state: "New Hampshire", label: "New Hampshire", scope: "New Hampshire", scfs: ["030", "031", "032", "033", "034", "035", "036", "037", "038"] },
  { key: "new-jersey", state: "New Jersey", label: "New Jersey", scope: "New Jersey", scfs: [] },
  { key: "new-mexico", state: "New Mexico", label: "New Mexico", scope: "New Mexico", scfs: ["870", "871", "873", "874", "875", "877", "878", "879", "880", "881", "882", "883", "884"] },
  { key: "new-york", state: "New York", label: "New York", scope: "New York", scfs: [] },
  { key: "north-carolina", state: "North Carolina", label: "North Carolina", scope: "North Carolina", scfs: ["270", "271", "272", "273", "274", "275", "276", "277", "278", "279", "280", "281", "282", "283", "284", "285", "286", "287", "288", "289"] },
  { key: "north-dakota", state: "North Dakota", label: "North Dakota", scope: "North Dakota", scfs: [] },
  { key: "ohio", state: "Ohio", label: "Ohio", scope: "Ohio", scfs: [] },
  { key: "oklahoma", state: "Oklahoma", label: "Oklahoma", scope: "Oklahoma", scfs: [] },
  { key: "oregon", state: "Oregon", label: "Oregon", scope: "Oregon", scfs: [] },
  { key: "pennsylvania", state: "Pennsylvania", label: "Pennsylvania", scope: "Pennsylvania", scfs: [] },
  { key: "rhode-island", state: "Rhode Island", label: "Rhode Island", scope: "Rhode Island", scfs: [] },
  { key: "south-carolina", state: "South Carolina", label: "South Carolina", scope: "South Carolina", scfs: [] },
  { key: "south-dakota", state: "South Dakota", label: "South Dakota", scope: "South Dakota", scfs: ["570", "571", "572", "573", "574", "575", "576", "577"] },
  { key: "tennessee", state: "Tennessee", label: "Tennessee", scope: "Tennessee", scfs: [] },
  { key: "texas", state: "Texas", label: "Texas", scope: "Texas", scfs: [] },
  { key: "utah", state: "Utah", label: "Utah", scope: "Utah", scfs: ["840", "841", "843", "844", "845", "846", "847"] },
  { key: "vermont", state: "Vermont", label: "Vermont", scope: "Vermont", scfs: ["050", "051", "052", "053", "054", "055", "056", "057", "058", "059"] },
  { key: "virginia", state: "Virginia", label: "Virginia", scope: "Virginia", scfs: [] },
  { key: "washington", state: "Washington", label: "Washington", scope: "Washington", scfs: [] },
  { key: "west-virginia", state: "West Virginia", label: "West Virginia", scope: "West Virginia", scfs: [] },
  { key: "wisconsin", state: "Wisconsin", label: "Wisconsin", scope: "Wisconsin", scfs: [] },
  { key: "wyoming", state: "Wyoming", label: "Wyoming", scope: "Wyoming", scfs: [] },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStorage() {
  ensureDir(DATA_DIR);
}

function ensureAnalysisArtifactDir() {
  ensureDir(ANALYSIS_COMPARISON_ARTIFACT_DIR);
}

function normalizeScf(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }

  return digits.slice(-3).padStart(3, "0");
}

function resolveClientTypeKeyFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "nhcl" || normalized === "n") {
    return "n";
  }

  if (normalized === "rfc") {
    return "rfc";
  }

  return "";
}

function normalizeClientTypeForKeyFilter(value) {
  return resolveClientTypeKeyFilter(value) || String(value || "").trim();
}

function buildSalesforceFilterValues(rawFilters) {
  const keyCodes = ensureArray(rawFilters.keyCodes || [])
    .map((entry) => normalizeClientTypeForKeyFilter(entry))
    .filter(Boolean);

  const normalizedKeyCodes = [];
  const seen = new Set();

  const addKey = (entry) => {
    const token = String(entry || "").trim();
    if (!token) {
      return;
    }
    const normalizedToken = token.toLowerCase();
    if (seen.has(normalizedToken)) {
      return;
    }

    seen.add(normalizedToken);
    normalizedKeyCodes.push(token);
  };

  keyCodes.forEach(addKey);

  const clientTypeAlias = resolveClientTypeKeyFilter(rawFilters.clientType);
  const clientTypeFilter = normalizeClientTypeForKeyFilter(rawFilters.clientType);
  if (!normalizedKeyCodes.length && clientTypeFilter) {
    addKey(clientTypeFilter);
  }

  const legacyClientType =
    normalizedKeyCodes.length > 0 || clientTypeAlias
      ? ""
      : String(rawFilters.clientType || "").trim();

  return {
    keyCodes: normalizedKeyCodes,
    clientType: legacyClientType,
  };
}

function normalizeState(value) {
  return String(value || "").trim();
}

function normalizeReferenceListSourceName(value) {
  return String(value || "")
    .trim()
    .replace(/\.(xlsx|xlsm|xls|csv|pdf)$/i, "");
}

function resolveListItemState(entry = {}) {
  return normalizeState(entry.state || entry.scope);
}

function createDefaultReferenceLists() {
  return {
    updatedAt: new Date().toISOString(),
    history: [],
    lists: [
      {
        type: "dnm",
        name: "Do Not Mail",
        sourceName: DNM_CATALOG_HEADER,
        items: DNM_SEED_GROUPS.flatMap((group) =>
          group.scfs.map((scf) => ({
            scf,
            scope: group.scope,
            stateKey: group.key,
            addedAt: new Date().toISOString(),
            addedBy: "System Seed",
            reason: "Imported from the initial analysis requirements.",
            sourceAnalysis: "initial-seed",
          }))
        ),
      },
      {
        type: "nhcl",
        name: "NHCL Mailing SCFs",
        sourceName: "Awaiting upload",
        items: [],
      },
      {
        type: "rfc",
        name: "RFC Mailing SCFs",
        sourceName: "Awaiting upload",
        items: [],
      },
      {
        type: "candidate",
        name: "Candidate SCFs",
        sourceName: "Generated from analysis actions",
        items: [],
      },
    ],
  };
}

const REFERENCE_LIST_HISTORY_LIMIT = 250;

function normalizeReferenceListSnapshotItems(items = []) {
  const seen = new Set();
  return ensureArray(items)
    .map((item) => {
      const scf = normalizeScf(item?.scf);
      if (!scf) {
        return null;
      }
      return {
        scf,
        state: normalizeState(item?.state || item?.scope || ""),
      };
    })
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.scf)) {
        return false;
      }
      seen.add(item.scf);
      return true;
    })
    .sort((left, right) => left.scf.localeCompare(right.scf, undefined, { numeric: true }));
}

function normalizeReferenceListHistoryEntries(entries = []) {
  return ensureArray(entries)
    .map((entry) => ({
      id: String(entry?.id || "").trim() || `ref_history_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      listType: String(entry?.listType || "").trim().toLowerCase(),
      actionType: String(entry?.actionType || "").trim().toLowerCase() || "update",
      actor: String(entry?.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
      sourceName: normalizeReferenceListSourceName(entry?.sourceName || ""),
      reason: String(entry?.reason || "").trim(),
      changedAt: entry?.changedAt || entry?.changed_at || new Date().toISOString(),
      beforeItems: normalizeReferenceListSnapshotItems(entry?.beforeItems || []),
      afterItems: normalizeReferenceListSnapshotItems(entry?.afterItems || []),
      metadata: entry?.metadata && typeof entry.metadata === "object" ? clone(entry.metadata) : {},
    }))
    .filter((entry) => ["dnm", "nhcl", "rfc", "candidate"].includes(entry.listType))
    .slice(0, REFERENCE_LIST_HISTORY_LIMIT);
}

function normalizeReferenceListsPayload(payload = null) {
  const fallback = createDefaultReferenceLists();
  const source = payload && typeof payload === "object" ? payload : fallback;
  const normalizedLists = ensureArray(source.lists).length
    ? ensureArray(source.lists).map((list) => ({
        ...list,
        type: String(list?.type || "").trim().toLowerCase(),
        name: String(list?.name || "").trim(),
        sourceName: normalizeReferenceListSourceName(list?.sourceName || ""),
        items: ensureArray(list?.items),
      }))
    : fallback.lists;

  return {
    updatedAt: source.updatedAt || new Date().toISOString(),
    history: normalizeReferenceListHistoryEntries(source.history || []),
    lists: normalizedLists,
  };
}

function buildReferenceListHistoryEntry({
  listType,
  actionType,
  actor,
  sourceName,
  reason,
  beforeItems,
  afterItems,
  changedAt,
  metadata = {},
}) {
  return {
    id: `ref_history_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    listType: String(listType || "").trim().toLowerCase(),
    actionType: String(actionType || "").trim().toLowerCase() || "update",
    actor: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
    sourceName: normalizeReferenceListSourceName(sourceName || ""),
    reason: String(reason || "").trim(),
    changedAt: changedAt || new Date().toISOString(),
    beforeItems: normalizeReferenceListSnapshotItems(beforeItems),
    afterItems: normalizeReferenceListSnapshotItems(afterItems),
    metadata: metadata && typeof metadata === "object" ? clone(metadata) : {},
  };
}

function recordReferenceListHistory(payload, entry) {
  const normalizedEntry = buildReferenceListHistoryEntry(entry);
  const beforeSerialized = JSON.stringify(normalizedEntry.beforeItems);
  const afterSerialized = JSON.stringify(normalizedEntry.afterItems);
  if (beforeSerialized === afterSerialized) {
    return;
  }
  payload.history = [
    normalizedEntry,
    ...ensureArray(payload.history),
  ].slice(0, REFERENCE_LIST_HISTORY_LIMIT);
}

function readJson(filePath, fallbackValue) {
  ensureStorage();
  return safeParseJson(filePath, fallbackValue);
}

let analysisRunsCache = null;
let analysisSetupsCache = null;
let analysisReportsCache = null;
let analysisReportsCacheMtimeMs = 0;
let analysisReportsInitialized = false;
let referenceListsCache = null;
let analysisPersistenceReady = false;

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) || clone(fallbackValue);
  } catch (error) {
    console.warn(`Unable to parse local state file ${filePath}:`, error.message);
    return clone(fallbackValue);
  }
}

function persistJsonFile(filePath, payload) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    console.warn(`Unable to persist analysis state file ${filePath}:`, error.message);
    return false;
  }
}

function readAnalysisRuns() {
  const primaryExists = fs.existsSync(ANALYSIS_RUNS_PATH);
  const fallbackExists = fs.existsSync(ANALYSIS_RUNS_FALLBACK_PATH);
  if (!analysisRunsCache) {
    if (primaryExists) {
      analysisRunsCache = readJson(ANALYSIS_RUNS_PATH, []);
    } else if (fallbackExists) {
      analysisRunsCache = readJson(ANALYSIS_RUNS_FALLBACK_PATH, []);
    } else {
      analysisRunsCache = [];
    }
  }

  return analysisRunsCache;
}

function writeAnalysisRuns(runs) {
  analysisRunsCache = clone(runs);
  const savedPrimary = persistJsonFile(ANALYSIS_RUNS_PATH, analysisRunsCache);
  if (!savedPrimary) {
    persistJsonFile(ANALYSIS_RUNS_FALLBACK_PATH, analysisRunsCache);
  }
  queueStateSync(ANALYSIS_RUNS_SUPABASE_KEY, analysisRunsCache);
}

function readAnalysisSetups() {
  const primaryExists = fs.existsSync(ANALYSIS_SETUPS_PATH);
  const fallbackExists = fs.existsSync(ANALYSIS_SETUPS_FALLBACK_PATH);
  if (!analysisSetupsCache) {
    if (primaryExists) {
      analysisSetupsCache = readJson(ANALYSIS_SETUPS_PATH, []);
    } else if (fallbackExists) {
      analysisSetupsCache = readJson(ANALYSIS_SETUPS_FALLBACK_PATH, []);
    } else {
      analysisSetupsCache = [];
    }
  }

  return analysisSetupsCache;
}

function writeAnalysisSetups(setups) {
  analysisSetupsCache = clone(setups);
  const savedPrimary = persistJsonFile(ANALYSIS_SETUPS_PATH, analysisSetupsCache);
  if (!savedPrimary) {
    persistJsonFile(ANALYSIS_SETUPS_FALLBACK_PATH, analysisSetupsCache);
  }
  queueStateSync(ANALYSIS_SETUPS_SUPABASE_KEY, analysisSetupsCache);
}

function buildRunMonthYear(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    runMonth: safeDate.toLocaleString("en-US", { month: "long" }),
    runYear: safeDate.getFullYear(),
  };
}

function createAnalysisReportId() {
  return `analysis_report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatReportDateStamp(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function formatReportRunDateLabel(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  const year = safeDate.getFullYear();
  return `${month}/${day}/${year}`;
}

function resolveAnalysisReportTitlePrefix(value = "") {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "RFC" || normalized === "REFINANCE") {
    return "Refinance";
  }
  if (normalized === "NHCL" || normalized === "N" || normalized === "NEW HOME") {
    return "New Home";
  }
  return "";
}

function buildAnalysisTitleLabel(prefixValue, startDate, endDate, runDate) {
  const prefix = resolveAnalysisReportTitlePrefix(prefixValue);
  const startLabel = formatAutoAnalysisMonthPart(startDate);
  const endLabel = formatAutoAnalysisMonthPart(endDate);
  const runDateLabel = formatReportRunDateLabel(runDate);
  if (prefix && startLabel && endLabel) {
    return `${prefix} - ${startLabel} - ${endLabel} (${runDateLabel})`;
  }
  if (prefix) {
    return `${prefix} (${runDateLabel})`;
  }
  return "";
}

function buildAnalysisReportName(run, pull) {
  const runDate = run.createdAt || run.created_at || new Date().toISOString();
  const titleLabel = buildAnalysisTitleLabel(
    ensureArray(pull.keyCodes)[0] || pull.clientType || "",
    pull.dateRange?.startDate || "",
    pull.dateRange?.endDate || "",
    runDate
  );
  if (titleLabel) {
    return titleLabel;
  }

  const label =
    String(pull.analysisLabel || pull.clientType || pull.reportId || "Analysis Report").trim() ||
    "Analysis Report";
  const runName = String(run.runName || "").trim();
  return runName ? `${label} - ${runName}` : label;
}

function buildAnalysisReportSummary({ inputRowCount, exportRowCount, zeroReason, reportId }) {
  if (exportRowCount === 0) {
    return zeroReason || "No rows found for this report.";
  }

  return `Exported ${exportRowCount} row(s) from Salesforce report ${reportId || "unknown"} after reviewing ${inputRowCount} source row(s).`;
}

const ANALYSIS_REPORT_LABEL_MAP = {
  "Sum of Opp Count": "Applications Received",
  "Sum of Sold": "Sum of Converted",
  "Sum of In Force": "Inforce (policy currently in effect)",
  "Sum of Total Monthly Premium": "Sum of Total Sold",
  "Average Monthly Premium": "Average Monthly Premium",
  "Sold Rate": "Sold Rate",
  "Converted Rate": "Converted Rate",
  "In Force Rate": "In Force Rate",
};

function renameAnalysisReportLabel(label) {
  const trimmed = String(label || "").trim();
  return ANALYSIS_REPORT_LABEL_MAP[trimmed] || trimmed;
}

function relabelAnalysisColumns(columns = []) {
  return ensureArray(columns).map((column) => ({
    ...column,
    label: renameAnalysisReportLabel(column?.label || column?.key || column?.normalized || ""),
  }));
}

function relabelAnalysisSummaryValues(summaryValues = []) {
  return ensureArray(summaryValues).map((entry) => ({
    ...entry,
    label: renameAnalysisReportLabel(entry?.label || entry?.key || ""),
  }));
}

function relabelAnalysisRows(rows = [], columns = []) {
  const rawColumns = ensureArray(columns);
  if (!rawColumns.length) {
    return ensureArray(rows);
  }

  return ensureArray(rows).map((row) => {
    const output = { ...row };
    rawColumns.forEach((column) => {
      const originalLabel = String(column?.label || column?.key || "").trim();
      const renamedLabel = renameAnalysisReportLabel(originalLabel);
      if (!originalLabel || !renamedLabel || originalLabel === renamedLabel) {
        return;
      }

      const value =
        row?.[originalLabel] ??
        row?.[column?.normalized || ""] ??
        row?.[column?.key || ""];

      if (value !== undefined) {
        output[renamedLabel] = value;
      }
    });
    return output;
  });
}

function ensureAnalysisReportExportDir() {
  ensureDir(ANALYSIS_REPORT_EXPORT_DIR);
  return ANALYSIS_REPORT_EXPORT_DIR;
}

function writeAnalysisReportExport(reportName, columns, rows, reportId, options = {}) {
  const worksheetColumns = ensureArray(options.exportColumns).length
    ? ensureArray(options.exportColumns)
    : ensureArray(columns);
  const worksheetRows = ensureArray(options.exportRows).length
    ? ensureArray(options.exportRows)
    : ensureArray(rows);
  const outputColumns = worksheetColumns.length
    ? worksheetColumns.map((column) => column.label || column.key || column.normalized || "Value")
    : Object.keys(worksheetRows[0] || {});
  const exportRows = worksheetRows.map((row) => {
    const output = {};
    outputColumns.forEach((columnName, index) => {
      const column = worksheetColumns[index];
      const normalizedKey = column?.normalized || "";
      const rawValue =
        row?.[columnName] ??
        (normalizedKey ? row?.[normalizedKey] : undefined) ??
        row?.[column?.key] ??
        "";
      output[columnName] = rawValue;
    });
    return output;
  });
  const fileName = `${sanitizeSlug(reportName || "analysis-report")}-${reportId}.xlsx`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-analysis-report-export-"));
  const exportDir = path.join(tempDir, "bundle");
  const xlDir = path.join(exportDir, "xl");
  const relsDir = path.join(exportDir, "_rels");
  const workbookRelsDir = path.join(xlDir, "_rels");
  const worksheetsDir = path.join(xlDir, "worksheets");
  const outputZipPath = path.join(tempDir, "analysis-report-export.zip");
  const filePath = path.join(ensureAnalysisReportExportDir(), fileName);

  try {
    ensureDir(exportDir);
    ensureDir(relsDir);
    ensureDir(workbookRelsDir);
    ensureDir(worksheetsDir);
    ensureDir(path.join(exportDir, "docProps"));

    fs.writeFileSync(
      path.join(exportDir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\n  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\n</Types>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(relsDir, ".rels"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\n</Relationships>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(workbookRelsDir, "workbook.xml.rels"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n</Relationships>\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(xlDir, "workbook.xml"), buildAnalysisReportWorkbookXml("Report"), "utf8");
    fs.writeFileSync(path.join(xlDir, "styles.xml"), buildAnalysisReportStylesXml(), "utf8");
    fs.writeFileSync(
      path.join(worksheetsDir, "sheet1.xml"),
      buildAnalysisReportWorksheetXml(reportName, worksheetColumns, worksheetRows, options.parameters || {}),
      "utf8"
    );
    fs.writeFileSync(
      path.join(exportDir, "docProps", "core.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <dc:title>${escapeXmlValue(reportName)}</dc:title>\n  <cp:category>Analysis Report</cp:category>\n  <cp:lastModifiedBy>HPA Automations</cp:lastModifiedBy>\n  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>\n  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>\n</cp:coreProperties>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(exportDir, "docProps", "app.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n  <Application>HPA Automations</Application>\n  <DocSecurity>0</DocSecurity>\n  <ScaleCrop>false</ScaleCrop>\n  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>\n  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Report</vt:lpstr></vt:vector></TitlesOfParts>\n</Properties>\n`,
      "utf8"
    );

    runPowerShell(
      `Compress-Archive -Path '${path.join(exportDir, "*")}' -DestinationPath '${outputZipPath}' -Force`
    );
    fs.copyFileSync(outputZipPath, filePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    fileName,
    filePath,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function buildAnalysisReportRecord(run, pull, options = {}) {
  const timestamp = options.createdAt || new Date().toISOString();
  const { runMonth, runYear } = buildRunMonthYear(run.createdAt || timestamp);
  const reportName = buildAnalysisReportName(run, pull);
  const reportId = options.id || createAnalysisReportId();
  const listType = resolveAnalysisReferenceListTypeFromPull(pull);
  const normalizedClientType = listType === "nhcl" ? "NHCL" : listType === "rfc" ? "RFC" : (pull.clientType || "");
  const rawColumns = ensureArray(options.columns);
  const rawRows = ensureArray(options.rows);
  const rawExportColumns = ensureArray(options.exportColumns || rawColumns);
  const rawExportRows = ensureArray(options.exportRows || rawRows);
  const columns = relabelAnalysisColumns(rawColumns);
  const rows = relabelAnalysisRows(rawRows, rawColumns);
  const exportColumns = relabelAnalysisColumns(rawExportColumns);
  const exportRows = relabelAnalysisRows(rawExportRows, rawExportColumns);
  const inputRowCount = Number(options.inputRowCount || 0);
  const exportRowCount = Number(options.exportRowCount || exportRows.length || 0);
  const summaryValues = relabelAnalysisSummaryValues(options.summaryValues);
  const zeroReason =
    options.zeroReason ||
    (inputRowCount === 0
      ? "No matching source rows were returned from Salesforce."
      : "Filters removed all rows for this report.");

  let exportFile = null;
  if (exportRows.length > 0) {
    exportFile = writeAnalysisReportExport(reportName, columns, rows, reportId, {
      exportColumns,
      exportRows,
      parameters: {
        report_id: pull.reportId,
        analysis_label: pull.analysisLabel || "",
        key_codes: ensureArray(pull.keyCodes),
        selected_years: ensureArray(pull.years),
        start_date: pull.dateRange?.startDate || "",
        end_date: pull.dateRange?.endDate || "",
        scf_filter: pull.scf || "",
        client_type: normalizedClientType,
        notes: pull.notes || "",
      },
    });
  }

  return {
    id: reportId,
    runId: run.id,
    pullId: pull.id,
    report_type: sanitizeSlug(pull.analysisLabel || pull.clientType || pull.reportId || "analysis-report"),
    report_name: reportName,
    run_month: runMonth,
    run_year: runYear,
    created_at: timestamp,
    updated_at: options.updatedAt || timestamp,
    completed_at: options.completedAt || timestamp,
    status: options.status || "complete",
    result_count: inputRowCount || exportRowCount,
    export_row_count: exportRowCount,
    input_row_count: inputRowCount,
    export_file_name: exportFile?.fileName || null,
    export_file_path: exportFile?.filePath || null,
    download_url: exportFile ? `/api/analysis/reports/${reportId}/export` : null,
    parameters: {
      report_id: pull.reportId,
      analysis_label: pull.analysisLabel || "",
      key_codes: ensureArray(pull.keyCodes),
      selected_years: ensureArray(pull.years),
      start_date: pull.dateRange?.startDate || "",
      end_date: pull.dateRange?.endDate || "",
      scf_filter: pull.scf || "",
      client_type: normalizedClientType,
      notes: pull.notes || "",
    },
    results_summary: buildAnalysisReportSummary({
      inputRowCount,
      exportRowCount,
      zeroReason,
      reportId: pull.reportId,
    }),
    created_by: DEFAULT_ACTOR,
    columns,
    summaryValues,
    rows,
    exportColumns,
    exportRows,
    error_message: options.errorMessage || "",
    warning_message: options.warningMessage || "",
    diagnostics: options.diagnostics || null,
  };
}

function buildAnalysisReportsFromRuns(runs = []) {
  const reports = [];
  runs.forEach((run) => {
    ensureArray(run.reportPulls).forEach((pull) => {
      const executedAt = pull.executedAt || run.completedAt || run.updatedAt || run.createdAt || new Date().toISOString();
      const exportColumns = ensureArray(pull.exportColumns).length
        ? ensureArray(pull.exportColumns)
        : ensureArray(pull.columns);
      const exportRows = ensureArray(pull.exportRows).length
        ? ensureArray(pull.exportRows)
        : ensureArray(pull.rows);
      const exportRowCount = Number(
        pull.exportRowCount || pull.resultCount || pull.rawRowCount || exportRows.length || 0
      );
      reports.push(
        buildAnalysisReportRecord(run, pull, {
          id: `analysis_report_${run.id}_${pull.id}`,
          createdAt: executedAt,
          updatedAt: executedAt,
          completedAt: executedAt,
          status: pull.status || run.status || "complete",
          rows: ensureArray(pull.rows),
          columns: ensureArray(pull.columns),
          summaryValues: ensureArray(pull.summaryValues),
          exportColumns,
          exportRows,
          exportRowCount,
          inputRowCount: Number(pull.rawRowCount || 0),
          zeroReason:
            Number(pull.rawRowCount || 0) === 0
              ? "No matching source rows were returned from Salesforce."
              : "Filters removed all rows for this report.",
          errorMessage: pull.error || "",
        })
      );
    });
  });
  return reports.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function readAnalysisReports() {
  const primaryExists = fs.existsSync(ANALYSIS_REPORTS_PATH);
  const fallbackExists = fs.existsSync(ANALYSIS_REPORTS_FALLBACK_PATH);
  const activePath = primaryExists ? ANALYSIS_REPORTS_PATH : fallbackExists ? ANALYSIS_REPORTS_FALLBACK_PATH : "";
  const activeMtimeMs = activePath ? (fs.statSync(activePath).mtimeMs || 0) : 0;

  if (
    analysisReportsInitialized &&
    activePath &&
    activeMtimeMs > Number(analysisReportsCacheMtimeMs || 0)
  ) {
    analysisReportsCache = readJson(activePath, []);
    analysisReportsCacheMtimeMs = activeMtimeMs;
  }

  if (!analysisReportsInitialized) {
    if (primaryExists) {
      analysisReportsCache = readJson(ANALYSIS_REPORTS_PATH, []);
      analysisReportsCacheMtimeMs = fs.statSync(ANALYSIS_REPORTS_PATH).mtimeMs || 0;
    } else if (fallbackExists) {
      analysisReportsCache = readJson(ANALYSIS_REPORTS_FALLBACK_PATH, []);
      analysisReportsCacheMtimeMs = fs.statSync(ANALYSIS_REPORTS_FALLBACK_PATH).mtimeMs || 0;
    } else {
      analysisReportsCache = buildAnalysisReportsFromRuns(readAnalysisRuns());
      writeAnalysisReports(analysisReportsCache);
    }

    analysisReportsInitialized = true;
  }

  const normalizedReports = normalizePersistedAnalysisReports(analysisReportsCache || []);
  if (normalizedReports.changed) {
    writeAnalysisReports(normalizedReports.reports);
  } else {
    analysisReportsCache = normalizedReports.reports;
  }

  return analysisReportsCache || [];
}

function normalizePersistedAnalysisReports(reports = []) {
  let changed = false;
  const normalizedReports = ensureArray(reports).map((report) => {
    const normalized = normalizePersistedAnalysisReport(report);
    if (normalized.changed) {
      changed = true;
    }
    return normalized.report;
  });

  return {
    changed,
    reports: normalizedReports,
  };
}

function normalizePersistedAnalysisReport(report = {}) {
  const exportRows = ensureArray(report.exportRows);
  if (!exportRows.length || !hasAnalysisDetailExportRows(exportRows) || typeof buildFlatRowsFromDetailExport !== "function") {
    return { changed: false, report };
  }

  const parameters = report.parameters || {};
  const effectiveClientType =
    parameters.client_type ||
    report.parameters?.clientType ||
    "";
  const rebuiltSummary = buildFlatRowsFromDetailExport(exportRows);
  const rebuiltRows = padAnalysisRowsWithReferenceList(
    rebuiltSummary.rows,
    rebuiltSummary.columns,
    effectiveClientType
  );
  const normalizedExistingRows = JSON.stringify(ensureArray(report.rows));
  const normalizedNextRows = JSON.stringify(rebuiltRows);
  const normalizedExistingColumns = JSON.stringify(ensureArray(report.columns));
  const normalizedNextColumns = JSON.stringify(ensureArray(rebuiltSummary.columns));
  const normalizedExistingSummary = JSON.stringify(ensureArray(report.summaryValues));
  const normalizedNextSummary = JSON.stringify(ensureArray(rebuiltSummary.summaryValues));

  if (
    normalizedExistingRows === normalizedNextRows &&
    normalizedExistingColumns === normalizedNextColumns &&
    normalizedExistingSummary === normalizedNextSummary
  ) {
    return { changed: false, report };
  }

  return {
    changed: true,
    report: {
      ...report,
      columns: rebuiltSummary.columns,
      rows: rebuiltRows,
      summaryValues: rebuiltSummary.summaryValues,
      result_count: rebuiltRows.length,
      updated_at: new Date().toISOString(),
    },
  };
}

function writeAnalysisReports(reports) {
  analysisReportsCache = clone(reports);
  analysisReportsInitialized = true;
  const savedPrimary = persistJsonFile(ANALYSIS_REPORTS_PATH, analysisReportsCache);
  if (!savedPrimary) {
    // Fallback writes are preserved for legacy compatibility where the primary file
    // path may be inaccessible.
    persistJsonFile(ANALYSIS_REPORTS_FALLBACK_PATH, analysisReportsCache);
  }
  if (fs.existsSync(ANALYSIS_REPORTS_PATH)) {
    analysisReportsCacheMtimeMs = fs.statSync(ANALYSIS_REPORTS_PATH).mtimeMs || Date.now();
  } else if (fs.existsSync(ANALYSIS_REPORTS_FALLBACK_PATH)) {
    analysisReportsCacheMtimeMs = fs.statSync(ANALYSIS_REPORTS_FALLBACK_PATH).mtimeMs || Date.now();
  }
  queueStateSync(ANALYSIS_REPORTS_SUPABASE_KEY, analysisReportsCache);
}

function readReferenceLists() {
  if (!referenceListsCache) {
    if (fs.existsSync(SCF_REFERENCE_LISTS_PATH)) {
      referenceListsCache = normalizeReferenceListsPayload(readJson(
        SCF_REFERENCE_LISTS_PATH,
        createDefaultReferenceLists()
      ));
    } else if (fs.existsSync(SCF_REFERENCE_LISTS_FALLBACK_PATH)) {
      referenceListsCache = normalizeReferenceListsPayload(readJson(
        SCF_REFERENCE_LISTS_FALLBACK_PATH,
        createDefaultReferenceLists()
      ));
    } else {
      referenceListsCache = normalizeReferenceListsPayload(createDefaultReferenceLists());
    }
  }

  return referenceListsCache;
}

function writeReferenceLists(payload) {
  referenceListsCache = normalizeReferenceListsPayload(clone(payload));
  const savedPrimary = persistJsonFile(SCF_REFERENCE_LISTS_PATH, referenceListsCache);
  if (!savedPrimary) {
    persistJsonFile(SCF_REFERENCE_LISTS_FALLBACK_PATH, referenceListsCache);
  }
  queueStateSync(SCF_REFERENCE_LISTS_SUPABASE_KEY, referenceListsCache);
}

function normalizeCompletionReferenceEntries(entries = []) {
  const seen = new Set();
  return ensureArray(entries)
    .map((entry) => {
      const scf = normalizeScf(entry?.scf || entry);
      if (!scf) {
        return null;
      }
      return { scf, state: normalizeState(entry?.state || entry?.scope || "") };
    })
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.scf)) {
        return false;
      }
      seen.add(entry.scf);
      return true;
    });
}

function normalizeCompletionReferenceListChanges(rawChanges = []) {
  const normalized = {
    nhcl: { added: [], removed: [] },
    rfc: { added: [], removed: [] },
  };

  ensureArray(rawChanges).forEach((change) => {
    const type = String(change?.type || "").trim().toLowerCase();
    if (!["nhcl", "rfc"].includes(type)) {
      return;
    }

    normalized[type].added.push(...normalizeCompletionReferenceEntries(change.added || []));
    normalized[type].removed.push(...normalizeCompletionReferenceEntries(change.removed || []));
  });

  return normalized;
}

function hasMeaningfulReferenceListChanges(rawChanges = []) {
  const normalized = normalizeCompletionReferenceListChanges(rawChanges);
  return ["nhcl", "rfc"].some((type) => {
    const entry = normalized[type] || {};
    return ensureArray(entry.added).length > 0 || ensureArray(entry.removed).length > 0;
  });
}

function normalizeReferenceListSnapshot(snapshot = []) {
  return ensureArray(snapshot)
    .map((entry) => {
      const type = String(entry?.type || "").trim().toLowerCase();
      if (!["nhcl", "rfc", "dnm", "candidate"].includes(type)) {
        return null;
      }
      const items = Array.isArray(entry?.items)
        ? entry.items
        : ensureArray(entry?.scfValues).map((scf) => ({ scf, state: "" }));
      return {
        type,
        sourceName: String(entry?.sourceName || entry?.source || "").trim(),
        items: normalizeReferenceListSnapshotItems(items),
      };
    })
    .filter(Boolean);
}

function applyCompletionReferenceListChanges(rawChanges = [], actor, sourceName, reason) {
  const changes = normalizeCompletionReferenceListChanges(rawChanges);
  const payload = readReferenceLists();
  const now = new Date().toISOString();
  const dnmLookup = getReferenceListLookup("dnm");
  let changed = false;
  const normalizedActor = String(actor || "Local User").trim() || "Local User";
  const normalizedSource = String(sourceName || "analysis-completion").trim() || "analysis-completion";
  const normalizedReason = String(reason || "").trim();

  ["nhcl", "rfc"].forEach((type) => {
    const listChanges = changes[type] || {};
    const list = payload.lists.find((entry) => entry.type === type);
    if (!list) {
      return;
    }
    const beforeItems = normalizeReferenceListSnapshotItems(list.items);

    const existingItems = ensureArray(list.items);
    const blockedScfs = new Set();
    listChanges.added.forEach((entry) => {
      const scf = entry.scf;
      if (dnmLookup.has(scf)) {
        blockedScfs.add(scf);
      }
    });
    if (blockedScfs.size) {
      const blockedList = Array.from(blockedScfs).join(", ");
      throw new Error(
        `This SCF is on the Do Not Mail list and cannot be added to ${type.toUpperCase()}: ${blockedList}`
      );
    }

    const removedSet = new Set(listChanges.removed.map((entry) => entry.scf));
    if (removedSet.size) {
      const keptItems = existingItems.filter((entry) => !removedSet.has(normalizeScf(entry.scf)));
      if (keptItems.length !== existingItems.length) {
        changed = true;
        list.items = keptItems;
      }
    }

    const filteredItems = ensureArray(list.items).filter((entry) => {
      const normalizedScf = normalizeScf(entry.scf);
      return Boolean(normalizedScf);
    });
    const nextSet = new Set(filteredItems.map((entry) => normalizeScf(entry.scf)).filter(Boolean));
    listChanges.added.forEach((entry) => {
      const scf = normalizeScf(entry?.scf);
      if (!scf || nextSet.has(scf)) {
        return;
      }
      list.items.unshift({
        scf,
        scope: normalizeState(entry.state),
        state: normalizeState(entry.state),
        addedAt: now,
        addedBy: normalizedActor,
        reason: normalizedReason,
        sourceAnalysis: normalizedSource,
      });
      nextSet.add(scf);
      changed = true;
    });

    recordReferenceListHistory(payload, {
      listType: type,
      actionType: "analysis-complete",
      actor: normalizedActor,
      sourceName: normalizedSource,
      reason: normalizedReason,
      changedAt: now,
      beforeItems,
      afterItems: normalizeReferenceListSnapshotItems(list.items),
      metadata: {
        addedScfs: ensureArray(listChanges.added).map((entry) => entry.scf),
        removedScfs: ensureArray(listChanges.removed).map((entry) => entry.scf),
      },
    });
  });

  if (changed) {
    payload.updatedAt = now;
    writeReferenceLists(payload);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function initializeAnalysisStatePersistence() {
  if (analysisPersistenceReady) {
    return;
  }
  analysisPersistenceReady = true;

  const localRuns = fs.existsSync(ANALYSIS_RUNS_PATH)
    ? safeParseJson(ANALYSIS_RUNS_PATH, [])
    : safeParseJson(ANALYSIS_RUNS_FALLBACK_PATH, []);
  const localSetups = fs.existsSync(ANALYSIS_SETUPS_PATH)
    ? safeParseJson(ANALYSIS_SETUPS_PATH, [])
    : safeParseJson(ANALYSIS_SETUPS_FALLBACK_PATH, []);
  const localReports = fs.existsSync(ANALYSIS_REPORTS_PATH)
    ? safeParseJson(ANALYSIS_REPORTS_PATH, [])
    : safeParseJson(ANALYSIS_REPORTS_FALLBACK_PATH, []);
  const localLists = fs.existsSync(SCF_REFERENCE_LISTS_PATH)
    ? safeParseJson(
        SCF_REFERENCE_LISTS_PATH,
        createDefaultReferenceLists()
      )
    : safeParseJson(
        SCF_REFERENCE_LISTS_FALLBACK_PATH,
        createDefaultReferenceLists()
      );

  const remoteRuns = await loadStateObject(ANALYSIS_RUNS_SUPABASE_KEY, localRuns);
  const remoteSetups = await loadStateObject(ANALYSIS_SETUPS_SUPABASE_KEY, localSetups);
  const remoteLists = await loadStateObject(SCF_REFERENCE_LISTS_SUPABASE_KEY, localLists);

  analysisRunsCache = Array.isArray(remoteRuns) ? clone(remoteRuns) : clone(localRuns);
  analysisSetupsCache = Array.isArray(remoteSetups) ? clone(remoteSetups) : clone(localSetups);
  const resolvedReferenceLists = remoteLists && remoteLists.lists ? remoteLists : localLists;

  referenceListsCache =
    typeof resolvedReferenceLists === "object" && resolvedReferenceLists !== null
      ? clone(resolvedReferenceLists)
      : clone(createDefaultReferenceLists());

  const reportFallback = Array.isArray(localReports) && localReports.length
    ? localReports
    : !analysisReportsInitialized
      ? buildAnalysisReportsFromRuns(analysisRunsCache)
      : [];
  const remoteReports = await loadStateObject(
    ANALYSIS_REPORTS_SUPABASE_KEY,
    null
  );
  const resolvedReports = Array.isArray(remoteReports)
    ? remoteReports
    : reportFallback;
  analysisReportsCache = clone(resolvedReports);
  analysisReportsInitialized = true;
  analysisReportsCacheMtimeMs = fs.existsSync(ANALYSIS_REPORTS_PATH)
    ? fs.statSync(ANALYSIS_REPORTS_PATH).mtimeMs || 0
    : 0;

  writeAnalysisRuns(analysisRunsCache);
  writeAnalysisSetups(analysisSetupsCache);
  writeReferenceLists(referenceListsCache);
  writeAnalysisReports(analysisReportsCache);
}

function createRunId() {
  return `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createPullId() {
  return `pull_${Math.random().toString(36).slice(2, 8)}`;
}

function createSetupId() {
  return `setup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeSlug(value) {
  return String(value || "analysis")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "analysis";
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeIsoDateForLabel(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function formatAutoAnalysisMonthPart(value) {
  const normalized = normalizeIsoDateForLabel(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }

  const [, yearRaw, monthRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw) - 1;
  if (!Number.isInteger(year) || month < 0 || month > 11) {
    return "";
  }

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month, 1))
  );
  return `${monthLabel} ${String(year)}`;
}

function buildAutoAnalysisLabel(rawPull = {}, index = 0) {
  const keyCode = String(ensureArray(rawPull.keyCodes)[0] || rawPull.clientType || "").trim().toUpperCase();
  const startDate = normalizeIsoDateForLabel(rawPull.dateRange?.startDate || "");
  const endDate = normalizeIsoDateForLabel(rawPull.dateRange?.endDate || "");
  const titleLabel = buildAnalysisTitleLabel(keyCode, startDate, endDate, new Date().toISOString());

  if (titleLabel) {
    return titleLabel;
  }

  const titlePrefix = resolveAnalysisReportTitlePrefix(keyCode);
  if (titlePrefix) {
    return titlePrefix;
  }

  return "Choose Key Code and dates";
}

function validateAnalysisReportId(reportId, label) {
  const normalizedId = String(reportId || "").trim();
  if (!normalizedId) {
    throw new Error(`${label} is missing a Salesforce Report ID.`);
  }

  if (!/^[A-Za-z0-9]{15,18}$/.test(normalizedId)) {
    throw new Error(`${label} has an invalid Salesforce Report ID.`);
  }

  return normalizedId;
}

function normalizePullRequest(rawPull = {}, index = 0) {
  const keyCodes = ensureArray(rawPull.keyCodes)
    .flatMap((entry) => String(entry || "").split(/[,\n]/))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const years = ensureArray(rawPull.years)
    .flatMap((entry) => String(entry || "").split(/[,\n]/))
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry));

  const normalizedDateRange =
    rawPull.dateRange?.startDate && rawPull.dateRange?.endDate
      ? {
          startDate: rawPull.dateRange.startDate,
          endDate: rawPull.dateRange.endDate,
        }
      : null;
  const autoAnalysisLabel = buildAutoAnalysisLabel({
    ...rawPull,
    keyCodes,
    dateRange: normalizedDateRange,
  }, index);
  const normalizedClientTypeFromKeyCodes = resolveClientTypeKeyFilter(keyCodes[0] || "");
  const normalizedClientType = normalizedClientTypeFromKeyCodes
    ? normalizedClientTypeFromKeyCodes.toUpperCase() === "N" ? "NHCL" : "RFC"
    : String(rawPull.clientType || "").trim();

  return {
    id: rawPull.id || createPullId(),
    savedReportId: String(rawPull.savedReportId || "").trim(),
    reportName: String(rawPull.reportName || rawPull.report_name || "").trim(),
    status: String(rawPull.status || "").trim(),
    resultCount: Number(rawPull.resultCount || rawPull.result_count || 0),
    rawRowCount: Number(rawPull.rawRowCount || 0),
    analysisLabel: String(rawPull.analysisLabel || autoAnalysisLabel).trim(),
    reportId: validateAnalysisReportId(
      rawPull.reportId,
      String(rawPull.analysisLabel || autoAnalysisLabel).trim()
    ),
    keyCodes,
    years,
    dateRange: normalizedDateRange,
    scf: normalizeScf(rawPull.scf),
    clientType: normalizedClientType,
    notes: String(rawPull.notes || "").trim(),
  };
}

function normalizeArchivedValue(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return false;
}

function isOpenAnalysisStatus(status) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  return normalizedStatus !== "complete" && normalizedStatus !== "reverted";
}

function normalizeAnalysisReviewState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalizeMap = (entries) => {
    if (!entries || typeof entries !== "object") {
      return {};
    }
    return Object.entries(entries).reduce((accumulator, [key, rawValue]) => {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) {
        return accumulator;
      }
      accumulator[normalizedKey] = String(rawValue || "").trim();
      return accumulator;
    }, {});
  };
  const normalizeListSnapshots = (lists) =>
    ensureArray(lists).map((entry) => {
      const type = String(entry?.type || "").trim().toLowerCase();
      if (!type) {
        return null;
      }
      return {
        type,
        name: String(entry?.name || "").trim(),
        sourceName: String(entry?.sourceName || "").trim(),
        updatedAt: String(entry?.updatedAt || "").trim(),
        items: normalizeReferenceListSnapshotItems(entry?.items || []),
      };
    }).filter(Boolean);
  const normalizeZeroRateRemovals = (entries) =>
    ensureArray(entries).map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const removedScfs = Array.from(new Set(ensureArray(entry.removedScfs).map((scf) => normalizeScf(scf)).filter(Boolean)));
      const foundZeroRateScfs = Array.from(new Set(ensureArray(entry.foundZeroRateScfs).map((scf) => normalizeScf(scf)).filter(Boolean)));
      const skippedAlreadyRemovedScfs = Array.from(new Set(ensureArray(entry.skippedAlreadyRemovedScfs).map((scf) => normalizeScf(scf)).filter(Boolean)));
      const skippedDnmScfs = Array.from(new Set(ensureArray(entry.skippedDnmScfs).map((scf) => normalizeScf(scf)).filter(Boolean)));
      if (!removedScfs.length && !foundZeroRateScfs.length && !skippedAlreadyRemovedScfs.length && !skippedDnmScfs.length) {
        return null;
      }
      return {
        id: String(entry.id || "").trim(),
        comparisonId: String(entry.comparisonId || "").trim(),
        comparisonName: String(entry.comparisonName || "").trim(),
        primaryReportId: String(entry.primaryReportId || "").trim(),
        primaryReportName: String(entry.primaryReportName || "").trim(),
        listType: String(entry.listType || "").trim().toLowerCase(),
        removalKind: String(entry.removalKind || "zero-rate").trim().toLowerCase(),
        metricKey: String(entry.metricKey || "soldRate").trim() || "soldRate",
        fieldUsed: String(entry.fieldUsed || "").trim(),
        checkedCount: Number(entry.checkedCount || 0),
        totalMailedRemoved: Number(entry.totalMailedRemoved || 0),
        removedScfs,
        foundZeroRateScfs,
        skippedAlreadyRemovedScfs,
        skippedDnmScfs,
        createdAt: String(entry.createdAt || "").trim(),
        undoneAt: String(entry.undoneAt || "").trim(),
      };
    }).filter(Boolean);
  const normalizeZeroRemovalDiagnostics = (source) => {
    if (!source || typeof source !== "object") {
      return null;
    }
    return {
      setupId: String(source.setupId || "").trim(),
      comparisonName: String(source.comparisonName || "").trim(),
      selectedPrimaryReportId: String(source.selectedPrimaryReportId || "").trim(),
      resolvedSavedReportId: String(source.resolvedSavedReportId || "").trim(),
      totalReportRowsChecked: Number(source.totalReportRowsChecked || 0),
      zeroRemovalFieldUsed: String(source.zeroRemovalFieldUsed || "").trim(),
      zeroRemovalMetricKey: String(source.zeroRemovalMetricKey || "").trim(),
      zeroRemovalMetricLabel: String(source.zeroRemovalMetricLabel || "").trim(),
      zeroRemovalCandidateCount: Number(source.zeroRemovalCandidateCount || 0),
      zeroValueCount: Number(source.zeroValueCount || 0),
      blankOrNullCount: Number(source.blankOrNullCount || 0),
      nonNumericCount: Number(source.nonNumericCount || 0),
      zeroRemovalOnWorkingListCount: Number(source.zeroRemovalOnWorkingListCount || 0),
      zeroRemovalAlreadyOffListCount: Number(source.zeroRemovalAlreadyOffListCount || 0),
      zeroRemovalAlreadyDnmCount: Number(source.zeroRemovalAlreadyDnmCount || 0),
      zeroRemovalSampleRows: ensureArray(source.zeroRemovalSampleRows).map((entry) => {
        const hasMetricShape = Object.prototype.hasOwnProperty.call(entry || {}, "rawMetricValue")
          || Object.prototype.hasOwnProperty.call(entry || {}, "parsedMetricValue");
        return hasMetricShape
          ? {
              scf: normalizeScf(entry?.scf),
              metricKey: String(entry?.metricKey || "").trim(),
              metricLabel: String(entry?.metricLabel || "").trim(),
              metricFieldKey: String(entry?.metricFieldKey || "").trim(),
              displayedMetricValue:
                entry?.displayedMetricValue === null || entry?.displayedMetricValue === undefined
                  ? ""
                  : String(entry.displayedMetricValue),
              rawMetricValue:
                entry?.rawMetricValue === null || entry?.rawMetricValue === undefined
                  ? ""
                  : String(entry.rawMetricValue),
              parsedMetricValue: Number(entry?.parsedMetricValue || 0),
              parsedDisplayedMetricValue: Number(entry?.parsedDisplayedMetricValue || 0),
              parsedRawMetricValue: Number(entry?.parsedRawMetricValue || 0),
              wouldRemove: entry?.wouldRemove === true,
              onWorkingList: entry?.onWorkingList === true,
              onDoNotMailList: entry?.onDoNotMailList === true,
            }
          : {
              scf: normalizeScf(entry?.scf),
              rawMailedValue:
                entry?.rawMailedValue === null || entry?.rawMailedValue === undefined
                  ? ""
                  : String(entry.rawMailedValue),
              parsedMailedValue: Number(entry?.parsedMailedValue || 0),
              wouldRemove: entry?.wouldRemove === true,
            };
      }).filter((entry) => entry.scf).slice(0, 10),
      zeroRemovalLastResult: source.zeroRemovalLastResult && typeof source.zeroRemovalLastResult === "object"
        ? {
            status: String(source.zeroRemovalLastResult.status || "").trim(),
            removedCount: Number(source.zeroRemovalLastResult.removedCount || 0),
            totalMailedRemoved: Number(source.zeroRemovalLastResult.totalMailedRemoved || 0),
            message: String(source.zeroRemovalLastResult.message || "").trim(),
            checkedAt: String(source.zeroRemovalLastResult.checkedAt || "").trim(),
          }
        : null,
    };
  };

  return {
    selectedComparisonId: String(source.selectedComparisonId || "").trim(),
    lastEditedComparisonId: String(source.lastEditedComparisonId || "").trim(),
    reviewPrimaryReportIds: normalizeMap(source.reviewPrimaryReportIds),
    reviewSelectedScfs: normalizeMap(source.reviewSelectedScfs),
    reviewCompletedByName: String(source.reviewCompletedByName || "").trim(),
    reviewCompletedOnDate: String(source.reviewCompletedOnDate || "").trim(),
    reviewExcludedScfs: normalizeMap(source.reviewExcludedScfs),
    reviewBaselineLists: normalizeListSnapshots(source.reviewBaselineLists),
    reviewWorkingLists: normalizeListSnapshots(source.reviewWorkingLists),
    reviewZeroRateRemovals: normalizeZeroRateRemovals(source.reviewZeroRateRemovals),
    reviewZeroRemovalDiagnostics: normalizeZeroRemovalDiagnostics(source.reviewZeroRemovalDiagnostics),
  };
}

function buildPersistedComparisonSetups(
  setupId,
  comparisonRequests = [],
  reviewState = {},
  existingComparisonSetups = [],
  timestamp = new Date().toISOString()
) {
  const existingById = new Map(
    ensureArray(existingComparisonSetups)
      .map((entry) => [String(entry?.id || "").trim(), entry])
      .filter(([id]) => id)
  );
  const normalizedReviewState = normalizeAnalysisReviewState(reviewState);

  return ensureArray(comparisonRequests).map((entry, index) => {
    const comparisonId = String(entry?.id || `comparison_${index + 1}`).trim() || `comparison_${index + 1}`;
    const existing = existingById.get(comparisonId) || null;
    const reportIds = ensureArray(entry?.selectedReportIds).length
      ? ensureArray(entry.selectedReportIds)
      : ensureArray(entry?.reportIds).length
        ? ensureArray(entry.reportIds)
        : [entry?.reportAId, entry?.reportBId];
    const selectedReportIds = Array.from(
      new Set(
        reportIds
          .map((reportId) => String(reportId || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 5);
    const comparisonName = String(entry?.comparisonName || entry?.name || entry?.label || "").trim();

    return {
      id: comparisonId,
      analysisSetupId: String(setupId || "").trim(),
      comparisonName,
      selectedReportIds,
      primaryReportId: String(normalizedReviewState.reviewPrimaryReportIds?.[comparisonId] || "").trim(),
      keyCodeGroup: String(entry?.keyCodeGroup || entry?.key_code_group || "NHCL").trim(),
      selectedScf: String(normalizedReviewState.reviewSelectedScfs?.[comparisonId] || "").trim(),
      reviewStatus: String(existing?.reviewStatus || "").trim(),
      reviewProgress: existing?.reviewProgress || null,
      createdAt: entry?.createdAt || entry?.created_at || existing?.createdAt || timestamp,
      updatedAt: entry?.updatedAt || entry?.updated_at || timestamp,
    };
  });
}

function inferComparisonKeyCodeGroupFromPull(pull = {}) {
  const directSources = [
    ...(ensureArray(pull?.keyCodes)),
    pull?.keyCodeGroup,
    pull?.key_code_group,
    pull?.clientType,
    pull?.client_type,
  ];
  for (const source of directSources) {
    const normalized = String(source || "").trim().toUpperCase();
    if (normalized === "RFC" || normalized === "REFINANCE") {
      return "RFC";
    }
    if (normalized === "N" || normalized === "NHCL" || normalized === "NEW HOME") {
      return "NHCL";
    }
  }

  const nameSources = [
    pull?.title,
    pull?.analysisLabel,
    pull?.reportName,
    pull?.report_name,
  ];
  for (const source of nameSources) {
    const normalized = String(source || "").trim().toUpperCase();
    if (normalized.startsWith("RFC") || normalized.startsWith("REFINANCE")) {
      return "RFC";
    }
    if (normalized.startsWith("NHCL") || normalized.startsWith("NEW HOME")) {
      return "NHCL";
    }
  }

  return "";
}

function resolveAnalysisComparisonNameFromGroup(keyCodeGroup = "") {
  return String(keyCodeGroup || "").trim().toUpperCase() === "RFC" ? "Refinance" : "New Home";
}

function recoverComparisonRequestsFromSetup(setup = {}) {
  const existingRequests = ensureArray(setup?.comparisonRequests);
  if (existingRequests.length) {
    return existingRequests;
  }

  const persistedComparisonSetups = ensureArray(setup?.comparisonSetups);
  if (persistedComparisonSetups.length) {
    return persistedComparisonSetups.map((entry, index) => {
      const selectedReportIds = Array.from(
        new Set(
          ensureArray(entry?.selectedReportIds)
            .map((reportId) => String(reportId || "").trim())
            .filter(Boolean)
        )
      ).slice(0, 5);
      const comparisonName = String(entry?.comparisonName || "").trim()
        || resolveAnalysisComparisonNameFromGroup(entry?.keyCodeGroup || "");
      return {
        id: String(entry?.id || `comparison_${index + 1}`).trim() || `comparison_${index + 1}`,
        name: comparisonName,
        comparisonName,
        keyCodeGroup: String(entry?.keyCodeGroup || "NHCL").trim().toUpperCase() === "RFC" ? "RFC" : "NHCL",
        reportIds: selectedReportIds,
        selectedReportIds,
        reportAId: selectedReportIds[0] || "",
        reportBId: selectedReportIds[1] || "",
        createdAt: entry?.createdAt || null,
        updatedAt: entry?.updatedAt || null,
        matchField: String(entry?.matchField || "SCF").trim() || "SCF",
        metricColumns: ensureArray(entry?.metricColumns),
      };
    });
  }

  const pullsByGroup = new Map();
  ensureArray(setup?.reportPulls).forEach((pull) => {
    const keyCodeGroup = inferComparisonKeyCodeGroupFromPull(pull);
    if (!keyCodeGroup) {
      return;
    }
    const selectedReportId = String(pull?.savedReportId || pull?.id || "").trim();
    if (!selectedReportId) {
      return;
    }
    const existing = pullsByGroup.get(keyCodeGroup) || [];
    existing.push(selectedReportId);
    pullsByGroup.set(keyCodeGroup, existing);
  });

  return Array.from(pullsByGroup.entries())
    .map(([keyCodeGroup, reportIds], index) => {
      const selectedReportIds = Array.from(new Set(reportIds.filter(Boolean))).slice(0, 5);
      if (selectedReportIds.length < 2) {
        return null;
      }
      const comparisonName = resolveAnalysisComparisonNameFromGroup(keyCodeGroup);
      return {
        id: `comparison_${String(keyCodeGroup || index + 1).trim().toLowerCase()}`,
        name: comparisonName,
        comparisonName,
        keyCodeGroup,
        reportIds: selectedReportIds,
        selectedReportIds,
        reportAId: selectedReportIds[0] || "",
        reportBId: selectedReportIds[1] || "",
        createdAt: setup?.updatedAt || setup?.createdAt || new Date().toISOString(),
        updatedAt: setup?.updatedAt || setup?.createdAt || new Date().toISOString(),
        matchField: "SCF",
        metricColumns: [],
      };
    })
    .filter(Boolean);
}

function recoverAnalysisReviewStateFromSetup(setup = {}, comparisonRequests = []) {
  const normalizedReviewState = normalizeAnalysisReviewState(setup?.reviewState);
  const currentPrimaryIds = normalizedReviewState.reviewPrimaryReportIds || {};
  if (Object.keys(currentPrimaryIds).length) {
    return normalizedReviewState;
  }

  const primaryReportIds = {};
  ensureArray(comparisonRequests).forEach((entry) => {
    const selectedIds = ensureArray(entry?.selectedReportIds).length
      ? ensureArray(entry.selectedReportIds)
      : ensureArray(entry?.reportIds);
    const primaryReportId = String(selectedIds[0] || "").trim();
    if (!primaryReportId) {
      return;
    }
    primaryReportIds[String(entry?.id || "").trim()] = primaryReportId;
  });

  if (!Object.keys(primaryReportIds).length) {
    return normalizedReviewState;
  }

  return {
    ...normalizedReviewState,
    reviewPrimaryReportIds: primaryReportIds,
    selectedComparisonId:
      normalizedReviewState.selectedComparisonId || String(comparisonRequests[0]?.id || "").trim(),
    lastEditedComparisonId:
      normalizedReviewState.lastEditedComparisonId || String(comparisonRequests[0]?.id || "").trim(),
  };
}

function backfillSavedReportIds(reportPulls = []) {
  const reportsByPullId = new Map(
    readAnalysisReports()
      .map((report) => [String(report?.pullId || "").trim(), String(report?.id || "").trim()])
      .filter(([pullId, reportId]) => pullId && reportId)
  );
  let changed = false;
  const nextPulls = ensureArray(reportPulls).map((pull) => {
    const currentSavedReportId = String(pull?.savedReportId || "").trim();
    if (currentSavedReportId) {
      return pull;
    }
    const inferredSavedReportId = String(reportsByPullId.get(String(pull?.id || "").trim()) || "").trim();
    if (!inferredSavedReportId) {
      return pull;
    }
    changed = true;
    return {
      ...pull,
      savedReportId: inferredSavedReportId,
    };
  });

  return {
    changed,
    reportPulls: nextPulls,
  };
}

function normalizeAnalysisRequest(body = {}) {
  const reportPulls = ensureArray(body.reportPulls).map(normalizePullRequest);

  return {
    runName: String(body.runName || "Analysis Run").trim(),
    status: String(body.status || "idle").trim() || "idle",
    createdAt: body.createdAt || null,
    updatedAt: body.updatedAt || null,
    completedAt: body.completedAt || null,
    setupId: String(body.setupId || "").trim() || null,
    archived: normalizeArchivedValue(body.archived),
    reportPulls,
    notes: String(body.notes || "").trim(),
    comparisonRequests: ensureArray(body.comparisonRequests).map((entry, index) => {
      const reportIds = ensureArray(entry.reportIds).length
        ? ensureArray(entry.reportIds)
            .map((reportId) => String(reportId || "").trim())
            .filter(Boolean)
        : [entry.reportAId, entry.reportBId]
            .map((reportId) => String(reportId || "").trim())
            .filter(Boolean);
      const comparisonName = String(entry.name || entry.comparisonName || entry.label || "").trim();
      return {
        id: entry.id || `comparison_${index + 1}`,
        name: comparisonName,
        comparisonName,
        keyCodeGroup: String(entry.keyCodeGroup || entry.key_code_group || "NHCL").trim().toUpperCase() === "RFC"
          ? "RFC"
          : "NHCL",
        reportIds: Array.from(new Set(reportIds)).slice(0, 5),
        selectedReportIds: Array.from(new Set(reportIds)).slice(0, 5),
        reportAId: String(reportIds[0] || entry.reportAId || "").trim(),
        reportBId: String(reportIds[1] || entry.reportBId || "").trim(),
        createdAt: entry.createdAt || entry.created_at || null,
        updatedAt: entry.updatedAt || entry.updated_at || null,
        matchField: String(entry.matchField || "SCF").trim() || "SCF",
        metricColumns: ensureArray(entry.metricColumns)
          .map((metric) => String(metric || "").trim())
          .filter(Boolean),
      };
    }),
    reviewState: normalizeAnalysisReviewState(body.reviewState),
    results: body.results || null,
    errorMessage: body.errorMessage || null,
    referenceListsSnapshot: body.referenceListsSnapshot || null,
    referenceListChanges: ensureArray(body.referenceListChanges || []),
    referenceListActor: String(body.referenceListActor || "Local User").trim(),
    referenceListSourceName: String(
      body.referenceListSourceName || body.runName || "Analysis Run"
    ).trim(),
    referenceListReason: String(body.referenceListReason || "").trim(),
    referenceListChangesAppliedAt: body.referenceListChangesAppliedAt || null,
    commitComparisonSetup: body.commitComparisonSetup === true,
    clearComparisonSetup: body.clearComparisonSetup === true,
  };
}

function serializeAnalysisSetup(setup) {
  const recoveredComparisonRequests = recoverComparisonRequestsFromSetup(setup);
  const recoveredReviewState = recoverAnalysisReviewStateFromSetup(setup, recoveredComparisonRequests);
  const comparisonSetups = buildPersistedComparisonSetups(
    setup.id,
    recoveredComparisonRequests,
    recoveredReviewState,
    setup.comparisonSetups,
    setup.updatedAt || setup.createdAt || new Date().toISOString()
  );
  const latestCompleted = getLatestCompletedAnalysisSetup();
  const canUndoLatestCompletion =
    !!latestCompleted && String(latestCompleted.id || "").trim() === String(setup?.id || "").trim();
  const comparisonReview = setup?.results?.comparisonReview && typeof setup.results.comparisonReview === "object"
    ? {
        ...clone(setup.results.comparisonReview),
        canUndoLatestCompletion,
      }
    : setup?.results?.comparisonReview || null;
  return {
    id: setup.id,
    runName: setup.runName,
    run_name: setup.runName,
    status: setup.status || "idle",
    archived: Boolean(setup.archived || false),
    createdAt: setup.createdAt,
    created_at: setup.createdAt,
    updatedAt: setup.updatedAt,
    updated_at: setup.updatedAt,
    completedAt: setup.completedAt || null,
    completed_at: setup.completedAt || null,
    reportPulls: setup.reportPulls,
    notes: setup.notes || "",
    comparisonRequests: recoveredComparisonRequests,
    comparisonSetups,
    reviewState: recoveredReviewState,
    results: setup.results
      ? {
          ...setup.results,
          comparisonReview,
        }
      : null,
    referenceListsSnapshot: setup.referenceListsSnapshot || null,
    reference_lists_snapshot: setup.referenceListsSnapshot || null,
    referenceListChanges: ensureArray(setup.referenceListChanges),
    reference_list_changes: ensureArray(setup.referenceListChanges),
    referenceListChangesAppliedAt: setup.referenceListChangesAppliedAt || null,
    reference_list_changes_applied_at: setup.referenceListChangesAppliedAt || null,
    completionUndoneAt: setup.completionUndoneAt || null,
    completion_undone_at: setup.completionUndoneAt || null,
    completionUndoneBy: setup.completionUndoneBy || "",
    completion_undone_by: setup.completionUndoneBy || "",
    canUndoLatestCompletion,
  };
}

function getReferenceList(listType) {
  const payload = readReferenceLists();
  return payload.lists.find((entry) => entry.type === listType) || null;
}

function getDnmCatalog() {
  return DNM_SEED_GROUPS.map((group) => ({
    key: group.key,
    state: group.state,
    label: group.label,
    scope: group.scope,
    scfs: [...group.scfs],
  }));
}

function getDnmScfStateLookup() {
  const lookup = new Map();
  DNM_SEED_GROUPS.forEach((group) => {
    ensureArray(group.scfs).forEach((scf) => {
      const normalizedScf = normalizeScf(scf);
      if (!normalizedScf) {
        return;
      }
      lookup.set(normalizedScf, group.state || group.label || group.scope || "");
    });
  });
  return lookup;
}

function normalizeScopeForDnm(scope = "") {
  const normalizedScope = String(scope || "").trim().toLowerCase();
  if (normalizedScope === "louisiana ad&d only") {
    return DNM_SEED_GROUPS.find((group) => group.key === "louisiana-add") || null;
  }

  return (
    DNM_SEED_GROUPS.find(
      (group) =>
        group.scope.toLowerCase() === normalizedScope ||
        group.label.toLowerCase() === normalizedScope ||
        group.state.toLowerCase() === normalizedScope
    ) || null
  );
}

function buildDnmStateGroups(items = []) {
  return getDnmCatalog().map((group) => {
    const activeItems = ensureArray(items).filter((entry) => {
      if (entry.stateKey && entry.stateKey === group.key) {
        return true;
      }
      const normalizedScf = normalizeScf(entry.scf);
      return group.scfs.includes(normalizedScf);
    });
    const activeScfs = activeItems.map((entry) => normalizeScf(entry.scf)).filter(Boolean);
    const missingScfs = group.scfs.filter((scf) => !activeScfs.includes(scf));
    const extraScfs = activeScfs.filter((scf) => !group.scfs.includes(scf));

    return {
      key: group.key,
      state: group.state,
      label: group.label,
      scfs: [...group.scfs],
      scfText: group.scfs.join(","),
      isActive: activeItems.length > 0,
      activeCount: activeItems.length,
      matchesCatalog: missingScfs.length === 0 && extraScfs.length === 0 && activeItems.length > 0,
      missingScfs,
      extraScfs,
    };
  });
}

function buildReferenceListSnapshotForRun() {
  const payload = readReferenceLists();
  const requestedTypes = ["dnm", "nhcl", "rfc", "candidate"];

  return requestedTypes
    .map((type) => payload.lists.find((entry) => entry.type === type))
    .filter(Boolean)
    .map((list) => {
      const scfValues = Array.from(
        new Set(
          ensureArray(list.items)
            .map((entry) => normalizeScf(entry.scf))
            .filter(Boolean)
        )
      );

      return {
        type: list.type,
        source: list.sourceName || "Not loaded",
        updatedAt: payload.updatedAt,
        updated_at: payload.updatedAt,
        count: scfValues.length,
        scfValues,
      };
    });
}

function getReferenceListLookup(listType) {
  const list = getReferenceList(listType);
  return new Map((list?.items || []).map((entry) => [entry.scf, entry]));
}

function resolveAnalysisReferenceListType(clientType) {
  const normalized = String(clientType || "").trim().toLowerCase();
  if (normalized === "nhcl" || normalized === "n") {
    return "nhcl";
  }
  if (normalized === "rfc") {
    return "rfc";
  }
  return "";
}

function resolveAnalysisReferenceListTypeFromPull(pull = {}) {
  const firstKeyCode = String(ensureArray(pull.keyCodes)[0] || "").trim();
  const fromKeyCode = resolveAnalysisReferenceListType(firstKeyCode);
  if (fromKeyCode) {
    return fromKeyCode;
  }
  return resolveAnalysisReferenceListType(pull.clientType);
}

function buildAnalysisEmptyCell(column = {}, clientType = "") {
  const label = String(column.label || column.key || "").trim().toLowerCase();
  const dataType = String(column.dataType || "").trim().toLowerCase();

  if (label === "scf grouping") {
    return "";
  }
  if (label === "key") {
    return resolveAnalysisReferenceListType(clientType) === "nhcl" ? "N" : "RFC";
  }
  if (label.includes("rate")) {
    return "0.0000000000";
  }
  if (dataType === "currency" || label.includes("premium")) {
    return "$0.00";
  }
  if (dataType === "double" || label.includes("sum of")) {
    return "0";
  }
  return "";
}

function sortAnalysisReportRows(rows = []) {
  return [...ensureArray(rows)].sort((rowA, rowB) => {
    const soldRateA = Number.parseFloat(
      String(rowA?.["Sold Rate"] ?? rowA?.["sold rate"] ?? "0").replace(/,/g, "")
    ) || 0;
    const soldRateB = Number.parseFloat(
      String(rowB?.["Sold Rate"] ?? rowB?.["sold rate"] ?? "0").replace(/,/g, "")
    ) || 0;
    if (soldRateB !== soldRateA) {
      return soldRateB - soldRateA;
    }

    const scfA = normalizeScf(rowA?.["SCF Grouping"] ?? rowA?.["scf grouping"] ?? "");
    const scfB = normalizeScf(rowB?.["SCF Grouping"] ?? rowB?.["scf grouping"] ?? "");
    if (scfA !== scfB) {
      return scfA.localeCompare(scfB, undefined, { numeric: true });
    }

    const keyA = String(rowA?.Key ?? rowA?.key ?? "").trim();
    const keyB = String(rowB?.Key ?? rowB?.key ?? "").trim();
    return keyA.localeCompare(keyB, undefined, { numeric: true });
  });
}

function padAnalysisRowsWithReferenceList(rows = [], columns = [], clientType = "") {
  const listType = resolveAnalysisReferenceListType(clientType);
  if (!listType) {
    return ensureArray(rows);
  }

  const list = getReferenceList(listType);
  const scfValues = Array.from(
    new Set(
      ensureArray(list?.items)
        .map((entry) => normalizeScf(entry?.scf))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!scfValues.length) {
    return ensureArray(rows);
  }

  const paddedRows = ensureArray(rows).map((row) => ({ ...row }));
  const existingScfs = new Set(
    paddedRows
      .map((row) => normalizeScf(row?.["SCF Grouping"] ?? row?.["scf grouping"] ?? ""))
      .filter(Boolean)
  );

  scfValues.forEach((scf) => {
    if (existingScfs.has(scf)) {
      return;
    }

    const row = {};
    ensureArray(columns).forEach((column) => {
      const value = buildAnalysisEmptyCell(column, clientType);
      if (column.label) {
        row[column.label] = value;
      }
      if (column.normalized) {
        row[column.normalized] = value;
      }
      if (column.key && !row[column.key]) {
        row[column.key] = value;
      }
    });
    row["SCF Grouping"] = scf;
    row["scf grouping"] = scf;
    row.Key = resolveAnalysisReferenceListType(clientType) === "nhcl" ? "N" : "RFC";
    row.key = row.Key;
    paddedRows.push(row);
  });

  return sortAnalysisReportRows(paddedRows);
}

function isDoNotMailScf(scf) {
  return getReferenceListLookup("dnm").has(normalizeScf(scf));
}

function findColumnLabel(columns, preferredLabel) {
  const normalizedTarget = normalizeLabel(preferredLabel);
  const direct = columns.find((column) => column.normalized === normalizedTarget);
  if (direct) {
    return direct.label;
  }

  const fuzzy = columns.find((column) => column.normalized.includes(normalizedTarget));
  return fuzzy?.label || preferredLabel;
}

function getScfValue(row) {
  for (const [key, value] of Object.entries(row || {})) {
    if (key.endsWith("__label") || key.endsWith(" label")) {
      continue;
    }

    if (normalizeLabel(key).includes("scf")) {
      const scf = normalizeScf(value);
      if (scf) {
        return scf;
      }
    }
  }

  return "";
}

function getMetricValue(row, metricLabel) {
  const value =
    row?.[metricLabel] ??
    row?.[normalizeLabel(metricLabel)] ??
    row?.[findNormalizedMatch(row, metricLabel)] ??
    0;
  const parsed = Number(String(value ?? "").replace(/[$,%(),\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function findNormalizedMatch(row, metricLabel) {
  const target = normalizeLabel(metricLabel);
  return Object.keys(row || {}).find((key) => {
    if (key.endsWith("__label") || key.endsWith(" label")) {
      return false;
    }

    return normalizeLabel(key) === target;
  });
}

function buildComparison(reportA, reportB, comparisonRequest) {
  const matchField = comparisonRequest.matchField || "SCF";
  const metricColumns = comparisonRequest.metricColumns.length
    ? comparisonRequest.metricColumns
    : [matchField];
  const matchLabelA = findColumnLabel(reportA.columns, matchField);
  const matchLabelB = findColumnLabel(reportB.columns, matchField);
  const mapA = new Map();
  const mapB = new Map();

  reportA.rows.forEach((row) => {
    const key = normalizeScf(row[matchLabelA] ?? row[normalizeLabel(matchLabelA)] ?? getScfValue(row));
    if (key) {
      mapA.set(key, row);
    }
  });
  reportB.rows.forEach((row) => {
    const key = normalizeScf(row[matchLabelB] ?? row[normalizeLabel(matchLabelB)] ?? getScfValue(row));
    if (key) {
      mapB.set(key, row);
    }
  });

  const allKeys = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort();
  const rows = allKeys.map((key) => {
    const rowA = mapA.get(key) || null;
    const rowB = mapB.get(key) || null;
    const metrics = metricColumns.map((metricLabel) => {
      const reportAValue = rowA ? getMetricValue(rowA, metricLabel) : null;
      const reportBValue = rowB ? getMetricValue(rowB, metricLabel) : null;
      const difference =
        reportAValue !== null && reportBValue !== null ? reportAValue - reportBValue : null;
      const percentChange =
        difference !== null && reportBValue
          ? (difference / reportBValue) * 100
          : null;

      return {
        metricLabel,
        reportAValue,
        reportBValue,
        difference,
        percentChange,
      };
    });

    return {
      matchValue: key,
      inReportA: Boolean(rowA),
      inReportB: Boolean(rowB),
      rowA,
      rowB,
      metrics,
    };
  });

  return {
    id: comparisonRequest.id,
    comparisonName:
      String(comparisonRequest.comparisonName || comparisonRequest.label || "").trim()
      || `${reportA.analysisLabel} vs ${reportB.analysisLabel}`,
    reportAId: reportA.id,
    reportALabel: reportA.analysisLabel,
    reportBId: reportB.id,
    reportBLabel: reportB.analysisLabel,
    matchField,
    metricColumns,
    rows,
    summary: {
      inBoth: rows.filter((row) => row.inReportA && row.inReportB).length,
      onlyInReportA: rows.filter((row) => row.inReportA && !row.inReportB).length,
      onlyInReportB: rows.filter((row) => !row.inReportA && row.inReportB).length,
    },
  };
}

function toCsvCell(value) {
  const stringValue =
    value === null || value === undefined ? "" : String(value).replace(/\r?\n/g, " ");
  return /[",]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

function buildCsv(columns, rows) {
  const output = [columns.map(toCsvCell).join(",")];
  rows.forEach((row) => {
    output.push(columns.map((column) => toCsvCell(row[column])).join(","));
  });
  return output.join("\n");
}

function writeAnalysisArtifacts(run) {
  return [];
}

function ensureReferenceListExportDir() {
  const fallbackDir = path.join(DATA_DIR, "reference-list-exports");
  const candidates = [ANALYSIS_REFERENCE_LIST_EXPORT_DIR, fallbackDir];
  for (const candidate of candidates) {
    try {
      ensureDir(candidate);
      return candidate;
    } catch (error) {
      if (String(candidate).toLowerCase() !== String(fallbackDir).toLowerCase()) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to initialize reference list export directory.`);
}

function escapeXmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeXmlValue(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildReferenceListStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n  <numFmts count="1">\n    <numFmt numFmtId="164" formatCode="@"/>\n  </numFmts>\n  <fonts count="1">\n    <font>\n      <sz val="11"/>\n      <name val="Calibri"/>\n      <family val="2"/>\n    </font>\n  </fonts>\n  <fills count="2">\n    <fill><patternFill patternType="none"/></fill>\n    <fill><patternFill patternType="gray125"/></fill>\n  </fills>\n  <borders count="1">\n    <border><left/><right/><top/><bottom/><diagonal/></border>\n  </borders>\n  <cellStyleXfs count="1">\n    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>\n  </cellStyleXfs>\n  <cellXfs count="2">\n    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\n    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\n  </cellXfs>\n  <cellStyles count="1">\n    <cellStyle name="Normal" xfId="0" builtinId="0"/>\n  </cellStyles>\n</styleSheet>\n`;
}

function buildAnalysisReportStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n  <fonts count="4">\n    <font>\n      <sz val="11"/>\n      <name val="Calibri"/>\n      <family val="2"/>\n    </font>\n    <font>\n      <b/>\n      <sz val="16"/>\n      <name val="Calibri"/>\n      <family val="2"/>\n    </font>\n    <font>\n      <sz val="11"/>\n      <name val="Calibri"/>\n      <family val="2"/>\n      <color rgb="FF555555"/>\n    </font>\n    <font>\n      <b/>\n      <sz val="11"/>\n      <name val="Calibri"/>\n      <family val="2"/>\n    </font>\n  </fonts>\n  <fills count="3">\n    <fill><patternFill patternType="none"/></fill>\n    <fill><patternFill patternType="gray125"/></fill>\n    <fill><patternFill patternType="solid"><fgColor rgb="FFEDE7DB"/><bgColor indexed="64"/></patternFill></fill>\n  </fills>\n  <borders count="2">\n    <border><left/><right/><top/><bottom/><diagonal/></border>\n    <border>\n      <left style="thin"><color rgb="FFD9CDB8"/></left>\n      <right style="thin"><color rgb="FFD9CDB8"/></right>\n      <top style="thin"><color rgb="FFD9CDB8"/></top>\n      <bottom style="thin"><color rgb="FFD9CDB8"/></bottom>\n      <diagonal/>\n    </border>\n  </borders>\n  <cellStyleXfs count="1">\n    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>\n  </cellStyleXfs>\n  <cellXfs count="4">\n    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\n    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>\n    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>\n    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>\n  </cellXfs>\n  <cellStyles count="1">\n    <cellStyle name="Normal" xfId="0" builtinId="0"/>\n  </cellStyles>\n</styleSheet>\n`;
}

function buildSimpleScfStateWorksheetXml(entries = [], options = {}) {
  const finalRow = entries.length + 1;
  const dimension = `A1:B${Math.max(finalRow, 1)}`;
  const freezeHeaderXml =
    '<sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\n      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>\n    </sheetView>\n  </sheetViews>';
  const colsXml =
    '<cols>\n    <col min="1" max="1" width="8.5" bestFit="1" customWidth="1"/>\n    <col min="2" max="2" width="24" bestFit="1" customWidth="1"/>\n  </cols>';
  const rows = [];
  const headerCells = [
    `<c r="A1" t="inlineStr"><is><t>${escapeXmlValue("SCF")}</t></is></c>`,
    `<c r="B1" t="inlineStr"><is><t>${escapeXmlValue("State")}</t></is></c>`,
  ].join("");
  rows.push(`<row r="1">${headerCells}</row>`);

  entries.forEach((entry, index) => {
    const rowIndex = index + 2;
    const scf = normalizeScf(entry.scf);
    const state = normalizeState(entry.state);
    rows.push(
      `<row r="${rowIndex}">` +
        `<c r="A${rowIndex}" s="1" t="inlineStr"><is><t>${escapeXmlValue(scf)}</t></is></c>` +
        `<c r="B${rowIndex}" t="inlineStr"><is><t>${escapeXmlValue(state)}</t></is></c>` +
        `</row>`
    );
  });

  const autoFilterXml = options.includeFilter === false ? "" : `\n  <autoFilter ref="A1:B${Math.max(finalRow, 1)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <dimension ref="${dimension}"/>\n  ${freezeHeaderXml}\n  ${colsXml}\n  <sheetData>\n    ${rows.join("\n")}\n  </sheetData>${autoFilterXml}\n</worksheet>\n`;
}

function buildReferenceListWorksheetXml(entries = [], sheetName = "Sheet1") {
  return buildSimpleScfStateWorksheetXml(entries, { sheetName });
}

function buildDnmReferenceListWorksheetXml(entries = []) {
  const groups = buildDnmStateGroups(entries)
    .filter((group) => group.isActive)
    .map((group) => ({
      state: group.label || group.state || "",
      scfs: ensureArray(group.scfs).map((scf) => normalizeScf(scf)).filter(Boolean),
    }))
    .filter((group) => group.scfs.length > 0);

  const maxScfCount = groups.reduce((max, group) => Math.max(max, group.scfs.length), 0);
  const totalColumns = Math.max(maxScfCount + 1, 2);
  const finalRow = Math.max(groups.length + 1, 1);
  const lastColumnLetter = columnNumberToLetter(totalColumns);
  const dimension = `A1:${lastColumnLetter}${finalRow}`;
  const cols = [
    '<col min="1" max="1" width="28" bestFit="1" customWidth="1"/>',
  ];
  for (let index = 0; index < maxScfCount; index += 1) {
    const columnNumber = index + 2;
    cols.push(
      `<col min="${columnNumber}" max="${columnNumber}" width="8.5" bestFit="1" customWidth="1"/>`
    );
  }

  const headerCells = [
    `<c r="A1" t="inlineStr"><is><t>${escapeXmlValue("State")}</t></is></c>`,
  ];
  for (let index = 0; index < maxScfCount; index += 1) {
    const columnLetter = columnNumberToLetter(index + 2);
    headerCells.push(
      `<c r="${columnLetter}1" t="inlineStr"><is><t>${escapeXmlValue(`SCF ${index + 1}`)}</t></is></c>`
    );
  }

  const rows = [`<row r="1">${headerCells.join("")}</row>`];
  groups.forEach((group, rowIndex) => {
    const excelRow = rowIndex + 2;
    const rowCells = [
      `<c r="A${excelRow}" t="inlineStr"><is><t>${escapeXmlValue(group.state)}</t></is></c>`,
    ];
    group.scfs.forEach((scf, scfIndex) => {
      const columnLetter = columnNumberToLetter(scfIndex + 2);
      rowCells.push(
        `<c r="${columnLetter}${excelRow}" s="1" t="inlineStr"><is><t>${escapeXmlValue(scf)}</t></is></c>`
      );
    });
    rows.push(`<row r="${excelRow}">${rowCells.join("")}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <dimension ref="${dimension}"/>\n  <sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\n      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>\n    </sheetView>\n  </sheetViews>\n  <cols>\n    ${cols.join("\n    ")}\n  </cols>\n  <sheetData>\n    ${rows.join("\n    ")}\n  </sheetData>\n  <autoFilter ref="A1:${lastColumnLetter}${finalRow}"/>\n</worksheet>\n`;
}

function columnNumberToLetter(value) {
  let number = Number(value || 0);
  let output = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    number = Math.floor((number - 1) / 26);
  }
  return output || "A";
}

function buildBucketedReferenceListWorksheetXml(entries = []) {
  const bucketMap = new Map();
  for (let digit = 0; digit <= 9; digit += 1) {
    bucketMap.set(String(digit), []);
  }

  entries.forEach((entry) => {
    const scf = normalizeScf(entry.scf);
    if (!scf) {
      return;
    }
    const digit = scf.charAt(0);
    if (!bucketMap.has(digit)) {
      bucketMap.set(digit, []);
    }
    bucketMap.get(digit).push({
      scf,
      state: normalizeState(entry.state),
    });
  });

  for (let digit = 0; digit <= 9; digit += 1) {
    bucketMap.get(String(digit)).sort((a, b) => a.scf.localeCompare(b.scf));
  }

  const rows = [];
  const headerCells = [];
  for (let digit = 0; digit <= 9; digit += 1) {
    const scfColumn = columnNumberToLetter(digit + 1);
    headerCells.push(
      `<c r="${scfColumn}1" t="inlineStr"><is><t>${escapeXmlValue(String(digit))}</t></is></c>`
    );
  }
  rows.push(`<row r="1">${headerCells.join("")}</row>`);

  const maxBucketSize = Math.max(
    0,
    ...Array.from(bucketMap.values(), (bucketEntries) => bucketEntries.length)
  );

  for (let rowOffset = 0; rowOffset < maxBucketSize; rowOffset += 1) {
    const rowIndex = rowOffset + 2;
    const rowCells = [];
    for (let digit = 0; digit <= 9; digit += 1) {
      const entry = bucketMap.get(String(digit))[rowOffset];
      if (!entry) {
        continue;
      }
      const scfColumn = columnNumberToLetter(digit + 1);
      const cellValue = entry.state
        ? `${entry.scf} ${entry.state}`
        : entry.scf;
      rowCells.push(
        `<c r="${scfColumn}${rowIndex}" s="1" t="inlineStr"><is><t>${escapeXmlValue(cellValue)}</t></is></c>`
      );
    }
    rows.push(`<row r="${rowIndex}">${rowCells.join("")}</row>`);
  }

  const finalRow = Math.max(maxBucketSize + 1, 1);
  const finalColumn = columnNumberToLetter(10);
  const dimension = `A1:${finalColumn}${finalRow}`;
  const cols = Array.from({ length: 10 }, (_, index) => {
    const column = index + 1;
    return `<col min="${column}" max="${column}" width="16" bestFit="1" customWidth="1"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <dimension ref="${dimension}"/>\n  <sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\n      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>\n    </sheetView>\n  </sheetViews>\n  <cols>\n    ${cols.join("\n    ")}\n  </cols>\n  <sheetData>\n    ${rows.join("\n    ")}\n  </sheetData>\n  <autoFilter ref="A1:${finalColumn}${finalRow}"/>\n</worksheet>\n`;
}

function buildMailerReferenceListWorksheetXml(entries = []) {
  const sortedEntries = ensureArray(entries)
    .map((entry) => normalizeScf(entry?.scf || entry))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const rows = [
    `<row r="1"><c r="A1" s="3" t="inlineStr"><is><t>SCF</t></is></c></row>`,
  ];

  sortedEntries.forEach((scf, index) => {
    const rowIndex = index + 2;
    rows.push(
      `<row r="${rowIndex}"><c r="A${rowIndex}" s="1" t="inlineStr"><is><t>${escapeXmlValue(scf)}</t></is></c></row>`
    );
  });

  const finalRow = Math.max(sortedEntries.length + 1, 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <dimension ref="A1:A${finalRow}"/>\n  <sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\n      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>\n    </sheetView>\n  </sheetViews>\n  <cols>\n    <col min="1" max="1" width="14" bestFit="1" customWidth="1"/>\n  </cols>\n  <sheetData>\n    ${rows.join("\n    ")}\n  </sheetData>\n  <autoFilter ref="A1:A${finalRow}"/>\n</worksheet>\n`;
}

function buildReferenceListWorkbookXml(sheetName = "Sheet1") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <sheets>\n    <sheet name="${escapeXmlAttribute(sheetName)}" sheetId="1" r:id="rId1"/>\n  </sheets>\n</workbook>\n`;
}

function buildAnalysisReportWorkbookXml(sheetName = "Report") {
  return buildReferenceListWorkbookXml(sheetName);
}

function buildAnalysisReportFiltersText(parameters = {}) {
  const parts = [];
  const keyCodes = ensureArray(parameters.key_codes || parameters.keyCodes).filter(Boolean);
  if (keyCodes.length) {
    parts.push(`Key: ${keyCodes.join(", ")}`);
  }
  const years = ensureArray(parameters.selected_years || parameters.selectedYears).filter(Boolean);
  if (years.length) {
    parts.push(`Years: ${years.join(", ")}`);
  }
  const startDate = String(parameters.start_date || parameters.startDate || "").trim();
  const endDate = String(parameters.end_date || parameters.endDate || "").trim();
  if (startDate || endDate) {
    parts.push(`Date: ${startDate || "?"} to ${endDate || "?"}`);
  }
  const scf = String(parameters.scf_filter || parameters.scf || "").trim();
  if (scf) {
    parts.push(`SCF: ${scf}`);
  }
  const clientType = String(parameters.client_type || parameters.clientType || "").trim();
  if (clientType) {
    parts.push(`Client: ${clientType}`);
  }
  return parts.length ? `Filters Applied: ${parts.join(" | ")}` : "Filters Applied: None";
}

function buildAnalysisReportWorksheetXml(reportName, columns = [], rows = [], parameters = {}) {
  const columnDefs = ensureArray(columns).length
    ? ensureArray(columns).map((column) =>
        typeof column === "string"
          ? {
              label: column,
              key: column,
              normalized: String(column || "").trim().toLowerCase(),
            }
          : {
              label: column.label || column.key || column.normalized || "Value",
              key: column.key || column.label || column.normalized || "Value",
              normalized: column.normalized || String(column.label || column.key || "").trim().toLowerCase(),
            }
      )
    : Object.keys(rows[0] || {}).map((key) => ({
        label: key,
        key,
        normalized: String(key || "").trim().toLowerCase(),
      }));
  const outputColumns = columnDefs.map((column) => column.label || "Value");
  const totalColumns = Math.max(outputColumns.length, 1);
  const lastColumnLetter = columnNumberToLetter(totalColumns);
  const finalRow = Math.max(rows.length + 4, 4);
  const dimension = `A1:${lastColumnLetter}${finalRow}`;
  const filterText = buildAnalysisReportFiltersText(parameters);

  const columnWidths = outputColumns.map((columnName, index) => {
    const widestCell = rows.reduce((max, row) => {
      const column = columnDefs[index] || {};
      const value =
        row?.[column.label] ??
        row?.[column.key] ??
        (column.normalized ? row?.[column.normalized] : undefined);
      return Math.max(max, String(value ?? "").length);
    }, String(columnName || "").length);
    const width = Math.min(Math.max(widestCell + 2, 12), 42);
    const columnNumber = index + 1;
    return `<col min="${columnNumber}" max="${columnNumber}" width="${width}" bestFit="1" customWidth="1"/>`;
  });

  const rowsXml = [];
  rowsXml.push(
    `<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>${escapeXmlValue(reportName)}</t></is></c></row>`
  );
  rowsXml.push(
    `<row r="2"><c r="A2" s="2" t="inlineStr"><is><t>${escapeXmlValue(filterText)}</t></is></c></row>`
  );
  rowsXml.push(`<row r="3"></row>`);

  const headerCells = outputColumns.map((columnName, index) => {
    const columnLetter = columnNumberToLetter(index + 1);
    return `<c r="${columnLetter}4" s="3" t="inlineStr"><is><t>${escapeXmlValue(columnName)}</t></is></c>`;
  });
  rowsXml.push(`<row r="4">${headerCells.join("")}</row>`);

  rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 5;
    const cells = outputColumns.map((columnName, columnIndex) => {
      const columnLetter = columnNumberToLetter(columnIndex + 1);
      const column = columnDefs[columnIndex] || {};
      const rawValue =
        row?.[column.label] ??
        row?.[column.key] ??
        (column.normalized ? row?.[column.normalized] : undefined) ??
        "";
      return `<c r="${columnLetter}${excelRow}" t="inlineStr"><is><t>${escapeXmlValue(rawValue)}</t></is></c>`;
    });
    rowsXml.push(`<row r="${excelRow}">${cells.join("")}</row>`);
  });

  const autoFilterStartRow = 4;
  const autoFilterEndRow = Math.max(finalRow, 4);
  const mergeCellsXml = totalColumns > 1
    ? `\n  <mergeCells count="2">\n    <mergeCell ref="A1:${lastColumnLetter}1"/>\n    <mergeCell ref="A2:${lastColumnLetter}2"/>\n  </mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <dimension ref="${dimension}"/>\n  <sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/>\n      <selection pane="bottomLeft" activeCell="A5" sqref="A5"/>\n    </sheetView>\n  </sheetViews>\n  <cols>\n    ${columnWidths.join("\n    ")}\n  </cols>\n  <sheetData>\n    ${rowsXml.join("\n    ")}\n  </sheetData>\n  <autoFilter ref="A${autoFilterStartRow}:${lastColumnLetter}${autoFilterEndRow}"/>${mergeCellsXml}\n</worksheet>\n`;
}

function buildNormalizedDnmExportItems(listItems = []) {
  const activeLookup = new Set(
    ensureArray(listItems)
      .map((entry) => normalizeScf(entry.scf))
      .filter(Boolean)
  );
  const rows = [];

  DNM_SEED_GROUPS.forEach((group) => {
    const stateLabel =
      group.key === "louisiana-add"
        ? "Louisiana - AD&D only"
        : normalizeState(group.state || group.label || group.scope);

    ensureArray(group.scfs).forEach((rawScf) => {
      const scf = normalizeScf(rawScf);
      if (!scf || !activeLookup.has(scf)) {
        return;
      }
      rows.push({ scf, state: stateLabel });
    });
  });

  const seen = new Set(rows.map((entry) => entry.scf));
  ensureArray(listItems).forEach((entry) => {
    const scf = normalizeScf(entry.scf);
    if (!scf || seen.has(scf)) {
      return;
    }
    rows.push({
      scf,
      state: normalizeState(entry.state || entry.scope),
    });
    seen.add(scf);
  });

  return rows;
}

function validateDnmExportItems(entries = []) {
  const requiredExamples = [
    "030", "031", "032", "033", "034", "035", "036", "037", "038",
    "050", "051", "052", "053", "054", "055", "056", "057", "058", "059",
  ];

  entries.forEach((entry, index) => {
    const scf = String(entry.scf || "");
    if (!scf || scf.includes(",")) {
      throw new Error(`Invalid DNM export row ${index + 2}: every row must contain exactly one SCF.`);
    }
    if (scf.length < 3) {
      throw new Error(`Invalid DNM export row ${index + 2}: SCF must be 3 characters.`);
    }
    if (normalizeScf(scf).length !== 3) {
      throw new Error(`Invalid DNM export row ${index + 2}: SCF must remain a 3-character text value.`);
    }
    if (String(entry.state || "").trim() === "") {
      throw new Error(`Invalid DNM export row ${index + 2}: state is required.`);
    }
  });

  const scfSet = new Set(entries.map((entry) => String(entry.scf || "")));
  requiredExamples.forEach((scf) => {
    if (!scfSet.has(scf)) {
      throw new Error(`DNM export validation failed: required SCF ${scf} is missing.`);
    }
  });
}

function writeReferenceListExport(listType, options = {}) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    throw new Error("Reference list export supports only DNM, NHCL, or RFC.");
  }
  const exportFormat = String(options.format || "").trim().toLowerCase();
  const isMailerExport = exportFormat === "mailer";
  if (isMailerExport && normalizedType === "dnm") {
    throw new Error("Mailer export is available for NHCL and RFC only.");
  }

  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === normalizedType);
  if (!list) {
    throw new Error(`Reference list not found: ${normalizedType}`);
  }

  const items = normalizeListItems(
    ensureArray(list.items).map((entry) => ({
      scf: entry.scf,
      state: normalizeState(entry.state),
    }))
  );
  const dnmExportItems =
    normalizedType === "dnm"
      ? buildNormalizedDnmExportItems(list.items)
      : [];
  if (normalizedType === "dnm") {
    validateDnmExportItems(dnmExportItems);
  }

  const sheetName =
    isMailerExport
      ? "Mailer SCFs"
      : normalizedType === "nhcl"
      ? "Sheet1"
      : normalizedType === "rfc"
        ? "Combined SCF for Data Team"
        : "Do Not Mail";
  const baseName =
    isMailerExport
      ? `${normalizedType.toUpperCase()}_mailer_scfs`
      : normalizedType === "nhcl"
      ? "NHCL Mailing SCFs"
      : normalizedType === "rfc"
        ? "RFC Mailing SCFs"
        : "dnm_mailing_scfs";
  const fileName =
    normalizedType === "dnm"
      ? "dnm_mailing_scfs.xlsx"
      : `${baseName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hpa-${normalizedType}-list-export-`));
  const exportDir = path.join(tempDir, "bundle");
  const xlDir = path.join(exportDir, "xl");
  const relsDir = path.join(exportDir, "_rels");
  const workbookRelsDir = path.join(xlDir, "_rels");
  const worksheetsDir = path.join(xlDir, "worksheets");
  const outputZipPath = path.join(tempDir, "reference-list-export.zip");
  const exportDirPath = ensureReferenceListExportDir();
  const outputXlsxPath = path.join(exportDirPath, fileName);

  try {
    ensureDir(exportDir);
    ensureDir(relsDir);
    ensureDir(workbookRelsDir);
    ensureDir(worksheetsDir);
    ensureDir(path.join(exportDir, "docProps"));

    fs.writeFileSync(
      path.join(exportDir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\n  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\n</Types>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(relsDir, ".rels"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\n</Relationships>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(workbookRelsDir, "workbook.xml.rels"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n</Relationships>\n`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(xlDir, "workbook.xml"),
      buildReferenceListWorkbookXml(sheetName),
      "utf8"
    );
    fs.writeFileSync(
      path.join(xlDir, "styles.xml"),
      buildReferenceListStylesXml(),
      "utf8"
    );
    fs.writeFileSync(
      path.join(worksheetsDir, "sheet1.xml"),
      normalizedType === "dnm"
        ? buildDnmReferenceListWorksheetXml(dnmExportItems)
        : isMailerExport
          ? buildMailerReferenceListWorksheetXml(items)
          : buildBucketedReferenceListWorksheetXml(items),
      "utf8"
    );
    fs.writeFileSync(
      path.join(exportDir, "docProps", "core.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <dc:title>${escapeXmlValue(fileName)}</dc:title>\n  <cp:category>Reference List</cp:category>\n  <cp:lastModifiedBy>HPA Automations</cp:lastModifiedBy>\n  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>\n  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>\n</cp:coreProperties>\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(exportDir, "docProps", "app.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n  <Application>HPA Automations</Application>\n  <DocSecurity>0</DocSecurity>\n  <ScaleCrop>false</ScaleCrop>\n  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>\n  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${escapeXmlValue(sheetName)}</vt:lpstr></vt:vector></TitlesOfParts>\n</Properties>\n`,
      "utf8"
    );

    runPowerShell(
      `Compress-Archive -Path '${path.join(exportDir, "*")}' -DestinationPath '${outputZipPath}' -Force`
    );
    fs.copyFileSync(outputZipPath, outputXlsxPath);

    return {
      fileName,
      filePath: outputXlsxPath,
      path: outputXlsxPath,
      listType: normalizedType,
      count: normalizedType === "dnm" ? dnmExportItems.length : items.length,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeListItems(items = []) {
  const normalizedScf = new Set();
  const output = [];
  items.forEach((item) => {
    const scf = normalizeScf(item.scf);
    if (!scf) {
      return;
    }

    const key = `${scf}`;
    if (normalizedScf.has(key)) {
      return;
    }

    normalizedScf.add(key);
    output.push({ scf, state: normalizeState(item.state || item.scope) });
  });
  return output;
}

function serializeAnalysisRun(run) {
  const linkedSetup = run?.setupId
    ? readAnalysisSetups().find((entry) => String(entry?.id || "").trim() === String(run.setupId || "").trim()) || null
    : null;
  return {
    id: run.id,
    runName: run.runName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt || null,
    completed_at: run.completedAt || null,
    statusDetail: run.statusDetail,
    errorMessage: run.errorMessage || "",
    setupId: run.setupId || null,
    setupStatus: linkedSetup?.status || null,
    setupCompletedAt: linkedSetup?.completedAt || null,
    setupCompletionUndoneAt: linkedSetup?.completionUndoneAt || null,
    reviewState: normalizeAnalysisReviewState(run.reviewState),
    referenceListsSnapshot: run.referenceListsSnapshot || null,
    reference_lists_snapshot: run.referenceListsSnapshot || null,
    reportPulls: run.reportPulls,
    comparisons: run.comparisons || [],
    scfActions: run.scfActions || [],
    summary: run.summary || null,
    artifacts: ensureArray(run.artifacts).map((artifact) => ({
      ...artifact,
      url: `/api/analysis/runs/${run.id}/artifacts/${artifact.fileName}`,
    })),
  };
}

function serializeAnalysisReport(report) {
  const columns = relabelAnalysisColumns(ensureArray(report.columns));
  const summaryValues = relabelAnalysisSummaryValues(ensureArray(report.summaryValues));
  const rows = relabelAnalysisRows(ensureArray(report.rows), ensureArray(report.columns));
  const exportColumns = relabelAnalysisColumns(ensureArray(report.exportColumns));
  const exportRows = relabelAnalysisRows(ensureArray(report.exportRows), ensureArray(report.exportColumns));

  return {
    id: report.id,
    runId: report.runId,
    run_id: report.runId,
    pullId: report.pullId,
    pull_id: report.pullId,
    reportType: report.report_type,
    report_type: report.report_type,
    reportName: report.report_name,
    report_name: report.report_name,
    runMonth: report.run_month,
    run_month: report.run_month,
    runYear: report.run_year,
    run_year: report.run_year,
    createdAt: report.created_at,
    created_at: report.created_at,
    updatedAt: report.updated_at,
    updated_at: report.updated_at,
    completedAt: report.completed_at,
    completed_at: report.completed_at,
    status: report.status,
    resultCount: Number(report.result_count || 0),
    result_count: Number(report.result_count || 0),
    exportRowCount: Number(report.export_row_count || report.result_count || 0),
    export_row_count: Number(report.export_row_count || report.result_count || 0),
    inputRowCount: Number(report.input_row_count || 0),
    input_row_count: Number(report.input_row_count || 0),
    exportFileName: report.export_file_name || null,
    export_file_name: report.export_file_name || null,
    exportFilePath: report.export_file_path || null,
    export_file_path: report.export_file_path || null,
    downloadUrl:
      report.download_url || (report.export_file_name ? `/api/analysis/reports/${report.id}/export` : null),
    download_url:
      report.download_url || (report.export_file_name ? `/api/analysis/reports/${report.id}/export` : null),
    parameters: report.parameters || {},
    resultsSummary: report.results_summary || "",
    results_summary: report.results_summary || "",
    createdBy: report.created_by || DEFAULT_ACTOR,
    created_by: report.created_by || DEFAULT_ACTOR,
    columns,
    summaryValues,
    rows,
    exportColumns,
    exportRows,
    warningMessage: report.warning_message || "",
    warning_message: report.warning_message || "",
    diagnostics: report.diagnostics || null,
    errorMessage: report.error_message || "",
    error_message: report.error_message || "",
  };
}

function summarizeRun(run) {
  const blocked = ensureArray(run.scfActions).filter((entry) => entry.action === "blocked").length;
  const candidates = ensureArray(run.scfActions).filter((entry) => entry.action === "candidate").length;
  const added = ensureArray(run.scfActions).filter((entry) => entry.action === "add").length;
  const resultCounts = run.reportPulls.map((pull) => ({
    pullId: pull.id,
    analysisLabel: pull.analysisLabel,
    count: Array.isArray(pull.rows) ? pull.rows.length : 0,
  }));

  return {
    reportResultCounts: resultCounts,
    addedCount: added,
    candidateCount: candidates,
    blockedCount: blocked,
    comparisonCount: ensureArray(run.comparisons).length,
  };
}

function replaceReportsForRun(runId, nextReports = []) {
  const reports = readAnalysisReports().filter((entry) => entry.runId !== runId);
  nextReports.forEach((report) => reports.unshift(report));
  writeAnalysisReports(reports);
}

function listAnalysisRuns() {
  return readAnalysisRuns().map(serializeAnalysisRun);
}

function listAnalysisReports() {
  return readAnalysisReports().map(serializeAnalysisReport);
}

function listAnalysisSetups() {
  const serialized = readAnalysisSetups().map(serializeAnalysisSetup);
  const latestOpenId = serialized
    .filter((entry) => !entry.archived && isOpenAnalysisStatus(entry.status || ""))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || "") || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || "") || 0;
      return rightTime - leftTime;
    })[0]?.id || "";

  return serialized.map((entry) => (
    !entry.archived
    && isOpenAnalysisStatus(entry.status || "")
    && latestOpenId
    && String(entry.id || "").trim() !== String(latestOpenId).trim()
      ? {
          ...entry,
          archived: true,
        }
      : entry
  ));
}

function getAnalysisSetup(setupId) {
  const setup = readAnalysisSetups().find((entry) => entry.id === setupId);
  return setup ? serializeAnalysisSetup(setup) : null;
}

function normalizeAnalysisDebugKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findAnalysisDebugFieldKeys(row = {}, matchers = []) {
  const keys = Object.keys(row || {});
  return Array.from(
    new Set(
      keys.filter((key) => {
        const normalizedKey = normalizeAnalysisDebugKey(key);
        return ensureArray(matchers).some((matcher) => normalizedKey.includes(matcher));
      })
    )
  ).slice(0, 3);
}

function getLatestOpenAnalysisSetupEntry() {
  return readAnalysisSetups()
    .filter((entry) => !entry?.archived && isOpenAnalysisStatus(entry?.status || ""))
    .sort((left, right) => {
      const leftTime = Date.parse(left?.updatedAt || left?.createdAt || "") || 0;
      const rightTime = Date.parse(right?.updatedAt || right?.createdAt || "") || 0;
      return rightTime - leftTime;
    })[0] || null;
}

function getAnalysisSetupReviewDebug(setupId = "") {
  const normalizedSetupId = String(setupId || "").trim();
  const setupEntry = normalizedSetupId && normalizedSetupId.toLowerCase() !== "active"
    ? readAnalysisSetups().find((entry) => String(entry?.id || "").trim() === normalizedSetupId)
    : getLatestOpenAnalysisSetupEntry();
  if (!setupEntry) {
    return null;
  }

  const setup = serializeAnalysisSetup(setupEntry);
  const reports = readAnalysisReports();
  const savedReportIdByPullId = new Map(
    reports
      .map((report) => [String(report?.pullId || report?.pull_id || "").trim(), String(report?.id || "").trim()])
      .filter(([pullId, reportId]) => pullId && reportId)
  );
  const comparisonRequests = ensureArray(setup.comparisonRequests);
  const selectedComparisonId = String(
    setup?.reviewState?.selectedComparisonId
    || comparisonRequests[0]?.id
    || ""
  ).trim();
  const selectedComparison = comparisonRequests.find((entry) => String(entry?.id || "").trim() === selectedComparisonId)
    || comparisonRequests[0]
    || null;
  const selectedPrimaryReportId = selectedComparison
    ? String(
        setup?.reviewState?.reviewPrimaryReportIds?.[selectedComparison.id]
        || selectedComparison?.selectedReportIds?.[0]
        || selectedComparison?.reportIds?.[0]
        || ""
      ).trim()
    : "";
  const resolvedPrimaryReportId = String(
    savedReportIdByPullId.get(selectedPrimaryReportId)
    || selectedPrimaryReportId
  ).trim();
  const selectedPrimaryReport = reports.find((report) => (
    String(report?.id || "").trim() === resolvedPrimaryReportId
    || String(report?.pullId || report?.pull_id || "").trim() === selectedPrimaryReportId
  )) || null;
  const firstRow = selectedPrimaryReport?.rows?.[0] || null;

  return {
    setupId: String(setup.id || "").trim(),
    setupStatus: String(setup.status || "").trim(),
    comparisonRequestsCount: comparisonRequests.length,
    reportPullsCount: ensureArray(setup.reportPulls).length,
    selectedComparisonId,
    selectedComparisonName: String(selectedComparison?.comparisonName || selectedComparison?.name || "").trim(),
    selectedPrimaryReportId,
    resolvedPrimaryReportId,
    selectedPrimaryReportExists: Boolean(selectedPrimaryReport),
    savedReportRowCount: Array.isArray(selectedPrimaryReport?.rows) ? selectedPrimaryReport.rows.length : 0,
    savedReportName: String(selectedPrimaryReport?.report_name || selectedPrimaryReport?.reportName || "").trim(),
    reportPulls: ensureArray(setup.reportPulls).map((pull) => ({
      id: String(pull?.id || "").trim(),
      savedReportId: String(pull?.savedReportId || savedReportIdByPullId.get(String(pull?.id || "").trim()) || "").trim(),
      analysisLabel: String(pull?.analysisLabel || "").trim(),
      clientType: String(pull?.clientType || "").trim(),
      keyCodes: ensureArray(pull?.keyCodes),
    })),
    comparisonRequests: comparisonRequests.map((entry) => ({
      id: String(entry?.id || "").trim(),
      comparisonName: String(entry?.comparisonName || entry?.name || "").trim(),
      selectedReportIds: ensureArray(entry?.selectedReportIds),
      reportIds: ensureArray(entry?.reportIds),
      keyCodeGroup: String(entry?.keyCodeGroup || "").trim(),
    })),
    fieldHints: firstRow
      ? {
          sampleKeys: Object.keys(firstRow).slice(0, 12),
          scfFieldKeys: findAnalysisDebugFieldKeys(firstRow, ["scf"]),
          mailedFieldKeys: findAnalysisDebugFieldKeys(firstRow, ["mailed", "mail", "quantity"]),
          soldRateFieldKeys: findAnalysisDebugFieldKeys(firstRow, ["sold rate"]),
          inForceRateFieldKeys: findAnalysisDebugFieldKeys(firstRow, ["in force rate", "inforce rate"]),
          convertedRateFieldKeys: findAnalysisDebugFieldKeys(firstRow, ["converted rate"]),
        }
      : {
          sampleKeys: [],
          scfFieldKeys: [],
          mailedFieldKeys: [],
          soldRateFieldKeys: [],
          inForceRateFieldKeys: [],
          convertedRateFieldKeys: [],
        },
    zeroRemovalFieldUsed: String(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalFieldUsed || "").trim(),
    zeroRemovalMetricKey: String(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalMetricKey || "").trim(),
    zeroRemovalMetricLabel: String(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalMetricLabel || "").trim(),
    zeroRemovalCandidateCount: Number(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalCandidateCount || 0),
    zeroRemovalOnWorkingListCount: Number(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalOnWorkingListCount || 0),
    zeroRemovalAlreadyOffListCount: Number(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalAlreadyOffListCount || 0),
    zeroRemovalAlreadyDnmCount: Number(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalAlreadyDnmCount || 0),
    zeroRemovalSampleRows: ensureArray(setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalSampleRows),
    zeroRemovalLastResult: setup?.reviewState?.reviewZeroRemovalDiagnostics?.zeroRemovalLastResult || null,
  };
}

function getAnalysisComparisonSetups(setupId) {
  const setup = readAnalysisSetups().find((entry) => entry.id === setupId);
  return setup ? ensureArray(setup.comparisonSetups).map((entry) => clone(entry)) : [];
}

function getAnalysisComparisonSetup(setupId, comparisonId) {
  const comparisonSetups = getAnalysisComparisonSetups(setupId);
  return comparisonSetups.find((entry) => String(entry.id || "").trim() === String(comparisonId || "").trim()) || null;
}

function saveAnalysisSetup(body = {}) {
  const request = normalizeAnalysisRequest(body);
  const setups = readAnalysisSetups();
  const setupId = String(body.id || "").trim();
  const existingSetup = setupId ? setups.find((entry) => entry.id === setupId) : null;
  const timestamp = new Date().toISOString();
  const savedReportBackfill = backfillSavedReportIds(request.reportPulls);
  request.reportPulls = savedReportBackfill.reportPulls;
  const existingComparisonRequests = ensureArray(existingSetup?.comparisonRequests);
  const incomingComparisonRequests = ensureArray(request.comparisonRequests);
  const shouldPreserveExistingComparisonSetup =
    !!existingSetup
    && !request.clearComparisonSetup
    && !incomingComparisonRequests.length
    && existingComparisonRequests.length;

  if (request.commitComparisonSetup && shouldPreserveExistingComparisonSetup) {
    throw new Error("Saved comparison setup cannot be overwritten with an empty draft. Remove it explicitly instead.");
  }

  const comparisonRequests = shouldPreserveExistingComparisonSetup
    ? existingComparisonRequests
    : incomingComparisonRequests;
  const reviewState = shouldPreserveExistingComparisonSetup
    ? normalizeAnalysisReviewState(existingSetup?.reviewState)
    : request.reviewState;
  const recoveredComparisonRequests = comparisonRequests.length
    ? comparisonRequests
    : recoverComparisonRequestsFromSetup({
        ...existingSetup,
        reportPulls: request.reportPulls,
        comparisonRequests,
      });
  const recoveredReviewState = recoverAnalysisReviewStateFromSetup(
    {
      ...existingSetup,
      reviewState,
    },
    recoveredComparisonRequests
  );
  const nextSetupId = existingSetup?.id || createSetupId();

  const setup = {
    id: nextSetupId,
    runName: request.runName,
    status: request.status || existingSetup?.status || "idle",
    createdAt: request.createdAt || existingSetup?.createdAt || timestamp,
    updatedAt: request.updatedAt || timestamp,
    completedAt: request.completedAt || existingSetup?.completedAt || null,
    archived: request.archived !== undefined ? request.archived : existingSetup?.archived || false,
    reportPulls: request.reportPulls,
    comparisonRequests: recoveredComparisonRequests,
    comparisonSetups: buildPersistedComparisonSetups(
      nextSetupId,
      recoveredComparisonRequests,
      recoveredReviewState,
      existingSetup?.comparisonSetups,
      timestamp
    ),
    reviewState: recoveredReviewState || existingSetup?.reviewState || null,
    notes: request.notes || "",
    results: request.results || existingSetup?.results || null,
    referenceListsSnapshot: request.referenceListsSnapshot || existingSetup?.referenceListsSnapshot || null,
    referenceListChanges: ensureArray(request.referenceListChanges).length
      ? clone(request.referenceListChanges)
      : ensureArray(existingSetup?.referenceListChanges),
    referenceListChangesAppliedAt:
      request.referenceListChangesAppliedAt ||
      existingSetup?.referenceListChangesAppliedAt ||
      null,
    completionUndoneAt: request.completionUndoneAt || existingSetup?.completionUndoneAt || null,
    completionUndoneBy: request.completionUndoneBy || existingSetup?.completionUndoneBy || "",
  };

  if (existingSetup) {
    const index = setups.findIndex((entry) => entry.id === existingSetup.id);
    setups[index] = setup;
  } else {
    setups.unshift(setup);
  }

  if (isOpenAnalysisStatus(request.status || setup.status || "")) {
    setups.forEach((entry) => {
      if (String(entry.id || "").trim() === String(setup.id || "").trim()) {
        entry.archived = false;
        return;
      }
      if (!entry.archived && isOpenAnalysisStatus(entry.status || "")) {
        entry.archived = true;
        entry.updatedAt = timestamp;
      }
    });
  }

  const normalizedStatus = String(request.status || setup.status || "").trim().toLowerCase();
  if (
    normalizedStatus === "complete" &&
    ensureArray(request.referenceListChanges).length &&
    !setup.referenceListChangesAppliedAt
  ) {
    applyCompletionReferenceListChanges(
      request.referenceListChanges,
      request.referenceListActor,
      request.referenceListSourceName || setup.runName,
      request.referenceListReason
    );
    setup.referenceListChangesAppliedAt = timestamp;
    setup.completionUndoneAt = null;
    setup.completionUndoneBy = "";
  }

  writeAnalysisSetups(setups);
  return serializeAnalysisSetup(setup);
}

function restoreReferenceListsFromSnapshot(snapshot = [], options = {}) {
  const normalizedSnapshot = normalizeReferenceListSnapshot(snapshot);
  const payload = readReferenceLists();
  const now = new Date().toISOString();
  const actor = String(options.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const sourceName = String(options.sourceName || "analysis-delete-restore").trim() || "analysis-delete-restore";
  const reason = String(options.reason || "").trim();
  const actionType = String(options.actionType || "restore-analysis-delete").trim() || "restore-analysis-delete";
  const restoredTypes = [];

  ["nhcl", "rfc"].forEach((type) => {
    const snapshotEntry = normalizedSnapshot.find((entry) => entry.type === type);
    if (!snapshotEntry) {
      return;
    }
    const list = payload.lists.find((entry) => entry.type === type);
    if (!list) {
      return;
    }
    const beforeItems = normalizeReferenceListSnapshotItems(list.items);
    const afterItems = normalizeReferenceListSnapshotItems(snapshotEntry.items);
    if (JSON.stringify(beforeItems) === JSON.stringify(afterItems)) {
      return;
    }
    list.items = afterItems.map((entry) => ({
      scf: entry.scf,
      state: entry.state,
      scope: entry.state,
      addedAt: now,
      addedBy: actor,
      reason,
      sourceAnalysis: sourceName,
    }));
    if (snapshotEntry.sourceName) {
      list.sourceName = snapshotEntry.sourceName;
    }
    recordReferenceListHistory(payload, {
      listType: type,
      actionType,
      actor,
      sourceName,
      reason,
      changedAt: now,
      beforeItems,
      afterItems,
      metadata: options.metadata || {},
    });
    restoredTypes.push(type);
  });

  if (restoredTypes.length) {
    payload.updatedAt = now;
    writeReferenceLists(payload);
  }

  return restoredTypes;
}

function deleteAnalysisSetup(setupId, options = {}) {
  const normalizedSetupId = String(setupId || "").trim();
  const setups = readAnalysisSetups();
  const setup = setups.find((entry) => entry.id === normalizedSetupId);
  if (!setup) {
    throw new Error("Analysis setup not found.");
  }

  const revertReferenceLists = options.revertReferenceLists === true;
  const actor = String(options.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const relatedRuns = readAnalysisRuns().filter((entry) => String(entry.setupId || "").trim() === normalizedSetupId);
  const relatedRunIds = new Set(relatedRuns.map((entry) => String(entry.id || "").trim()).filter(Boolean));
  const reports = readAnalysisReports();
  const relatedReports = reports.filter((entry) => relatedRunIds.has(String(entry.runId || "").trim()));

  let revertedLists = [];
  if (revertReferenceLists && hasMeaningfulReferenceListChanges(setup.referenceListChanges || [])) {
    revertedLists = restoreReferenceListsFromSnapshot(setup.referenceListsSnapshot || [], {
      actor,
      sourceName: String(setup.runName || "analysis-delete-restore").trim() || "analysis-delete-restore",
      reason: `Restored while deleting analysis ${String(setup.runName || setup.id || "").trim()}`,
      metadata: {
        setupId: normalizedSetupId,
      },
    });
  }

  relatedReports.forEach((report) => {
    if (report?.export_file_path) {
      try {
        fs.unlinkSync(report.export_file_path);
      } catch (error) {
        // Ignore cleanup failures for already-removed exports.
      }
    }
  });

  writeAnalysisReports(reports.filter((entry) => !relatedRunIds.has(String(entry.runId || "").trim())));
  writeAnalysisRuns(readAnalysisRuns().filter((entry) => String(entry.setupId || "").trim() !== normalizedSetupId));
  writeAnalysisSetups(setups.filter((entry) => entry.id !== normalizedSetupId));

  return {
    deletedSetupId: normalizedSetupId,
    deletedRunIds: Array.from(relatedRunIds),
    deletedReportIds: relatedReports.map((entry) => String(entry.id || "").trim()).filter(Boolean),
    revertedLists,
  };
}

function getLatestCompletedAnalysisSetup() {
  return readAnalysisSetups()
    .filter((entry) =>
      String(entry?.status || "").trim().toLowerCase() === "complete"
      && entry?.referenceListChangesAppliedAt
      && !entry?.completionUndoneAt
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.referenceListChangesAppliedAt || left.completedAt || left.updatedAt || "") || 0;
      const rightTime = Date.parse(right.referenceListChangesAppliedAt || right.completedAt || right.updatedAt || "") || 0;
      return rightTime - leftTime;
    })[0] || null;
}

function undoLatestCompletedAnalysis(setupId, options = {}) {
  const normalizedSetupId = String(setupId || "").trim();
  if (!normalizedSetupId) {
    throw new Error("Analysis setup ID is required.");
  }

  const setups = readAnalysisSetups();
  const setupIndex = setups.findIndex((entry) => String(entry.id || "").trim() === normalizedSetupId);
  if (setupIndex === -1) {
    throw new Error("Analysis setup not found.");
  }

  const setup = clone(setups[setupIndex]);
  const latestCompleted = getLatestCompletedAnalysisSetup();
  if (!latestCompleted || String(latestCompleted.id || "").trim() !== normalizedSetupId) {
    throw new Error("Only the most recent completed analysis can be undone.");
  }
  if (!setup.referenceListChangesAppliedAt || !hasMeaningfulReferenceListChanges(setup.referenceListChanges || [])) {
    throw new Error("This analysis did not apply mailing-list changes.");
  }
  if (!setup.referenceListsSnapshot) {
    throw new Error("No pre-completion mailing-list snapshot is available for this analysis.");
  }

  const actor = String(options.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const revertedLists = restoreReferenceListsFromSnapshot(setup.referenceListsSnapshot || [], {
    actor,
    actionType: "undo-analysis-complete",
    sourceName: String(setup.runName || setup.id || "analysis-completion-undo").trim() || "analysis-completion-undo",
    reason: `Undo completed analysis ${String(setup.runName || setup.id || "").trim()}`,
    metadata: {
      setupId: normalizedSetupId,
    },
  });

  const timestamp = new Date().toISOString();
  setup.status = "reverted";
  setup.updatedAt = timestamp;
  setup.completionUndoneAt = timestamp;
  setup.completionUndoneBy = actor;
  setup.referenceListChangesAppliedAt = null;
  setups[setupIndex] = setup;
  writeAnalysisSetups(setups);

  return {
    setup: serializeAnalysisSetup(setup),
    revertedLists,
    lists: listReferenceLists(),
  };
}

function deleteAnalysisComparisonSetup(setupId, comparisonId) {
  const normalizedSetupId = String(setupId || "").trim();
  const normalizedComparisonId = String(comparisonId || "").trim();
  if (!normalizedSetupId || !normalizedComparisonId) {
    throw new Error("Both setup ID and comparison ID are required.");
  }

  const setups = readAnalysisSetups();
  const setupIndex = setups.findIndex((entry) => String(entry.id || "").trim() === normalizedSetupId);
  if (setupIndex === -1) {
    throw new Error("Analysis setup not found.");
  }

  const setup = clone(setups[setupIndex]);
  const nextComparisonRequests = ensureArray(setup.comparisonRequests).filter(
    (entry) => String(entry?.id || "").trim() !== normalizedComparisonId
  );
  if (nextComparisonRequests.length === ensureArray(setup.comparisonRequests).length) {
    throw new Error("Comparison setup not found.");
  }

  const nextReviewState = normalizeAnalysisReviewState(setup.reviewState);
  delete nextReviewState.reviewPrimaryReportIds[normalizedComparisonId];
  delete nextReviewState.reviewSelectedScfs[normalizedComparisonId];
  if (nextReviewState.selectedComparisonId === normalizedComparisonId) {
    nextReviewState.selectedComparisonId = String(nextComparisonRequests[0]?.id || "").trim();
  }
  if (nextReviewState.lastEditedComparisonId === normalizedComparisonId) {
    nextReviewState.lastEditedComparisonId = String(nextComparisonRequests[0]?.id || "").trim();
  }

  const timestamp = new Date().toISOString();
  setup.comparisonRequests = nextComparisonRequests;
  setup.reviewState = nextReviewState;
  setup.comparisonSetups = buildPersistedComparisonSetups(
    normalizedSetupId,
    nextComparisonRequests,
    nextReviewState,
    setup.comparisonSetups,
    timestamp
  );
  setup.updatedAt = timestamp;
  setups[setupIndex] = setup;
  writeAnalysisSetups(setups);
  return serializeAnalysisSetup(setup);
}

function getAnalysisRun(runId) {
  const run = readAnalysisRuns().find((entry) => entry.id === runId);
  return run ? serializeAnalysisRun(run) : null;
}

function getAnalysisReport(reportId) {
  const report = readAnalysisReports().find((entry) => entry.id === reportId);
  return report ? serializeAnalysisReport(report) : null;
}

function deleteAnalysisRun(runId) {
  const runs = readAnalysisRuns();
  const nextRuns = runs.filter((entry) => entry.id !== runId);
  if (nextRuns.length === runs.length) {
    throw new Error("Analysis run not found.");
  }
  writeAnalysisRuns(nextRuns);
}

function deleteAnalysisReport(reportId) {
  const reports = readAnalysisReports();
  const report = reports.find((entry) => entry.id === reportId);
  if (!report) {
    throw new Error("Analysis report not found.");
  }

  if (report.export_file_path) {
    try {
      fs.unlinkSync(report.export_file_path);
    } catch (error) {
      // Ignore cleanup failures for already-removed exports.
    }
  }

  const nextReports = reports.filter((entry) => entry.id !== reportId);
  writeAnalysisReports(nextReports);
  removeDeletedReportsFromRuns([report]);
}

function deleteAnalysisReports(reportIds = []) {
  const normalizedIds = Array.from(
    new Set(
      ensureArray(reportIds)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    throw new Error("Select at least one analysis report to delete.");
  }

  const reports = readAnalysisReports();
  const reportMap = new Map(reports.map((entry) => [String(entry.id || "").trim(), entry]));
  const missingIds = normalizedIds.filter((id) => !reportMap.has(id));
  if (missingIds.length) {
    throw new Error("One or more selected analysis reports could not be found.");
  }

  normalizedIds.forEach((id) => {
    const report = reportMap.get(id);
    if (report?.export_file_path) {
      try {
        fs.unlinkSync(report.export_file_path);
      } catch (error) {
        // Ignore cleanup failures for already-removed exports.
      }
    }
  });

  const deletedReports = normalizedIds
    .map((id) => reportMap.get(id))
    .filter(Boolean);
  writeAnalysisReports(reports.filter((entry) => !normalizedIds.includes(String(entry.id || "").trim())));
  removeDeletedReportsFromRuns(deletedReports);
  return normalizedIds;
}

function removeDeletedReportsFromRuns(reportsToDelete = []) {
  const normalizedReports = ensureArray(reportsToDelete).filter(Boolean);
  if (!normalizedReports.length) {
    return;
  }

  const deletedReportIds = new Set(
    normalizedReports
      .map((report) => String(report.id || "").trim())
      .filter(Boolean)
  );
  const deletedPullIds = new Set(
    normalizedReports
      .map((report) => String(report.pullId || report.pull_id || "").trim())
      .filter(Boolean)
  );
  const deletedRunIds = new Set(
    normalizedReports
      .map((report) => String(report.runId || report.run_id || "").trim())
      .filter(Boolean)
  );

  const runs = readAnalysisRuns();
  let didChangeRuns = false;
  const nextRuns = runs.map((run) => {
    const originalPulls = ensureArray(run.reportPulls);
    const nextPulls = originalPulls.filter((pull) => {
      const pullId = String(pull.id || "").trim();
      const savedReportId = String(pull.savedReportId || "").trim();
      return !deletedPullIds.has(pullId) && !deletedReportIds.has(savedReportId);
    });

    const originalComparisons = ensureArray(run.comparisonRequests);
    const nextComparisons = originalComparisons.filter((comparison) => {
      const reportIds = ensureArray(comparison.reportIds).map((entry) => String(entry || "").trim());
      const reportAId = String(comparison.reportAId || "").trim();
      const reportBId = String(comparison.reportBId || "").trim();
      if (reportIds.some((id) => deletedPullIds.has(id) || deletedReportIds.has(id))) {
        return false;
      }
      if (deletedPullIds.has(reportAId) || deletedPullIds.has(reportBId)) {
        return false;
      }
      return true;
    });

    if (nextPulls.length === originalPulls.length && nextComparisons.length === originalComparisons.length) {
      return run;
    }

    didChangeRuns = true;
    return {
      ...run,
      reportPulls: nextPulls,
      comparisonRequests: nextComparisons,
      updatedAt: new Date().toISOString(),
      statusDetail:
        deletedRunIds.has(String(run.id || "").trim()) &&
        nextPulls.length === 0
          ? "All saved reports for this analysis were deleted."
          : run.statusDetail,
    };
  });

  if (didChangeRuns) {
    writeAnalysisRuns(nextRuns);
  }
}

function renameAnalysisReport(reportId, nextTitle) {
  const normalizedId = String(reportId || "").trim();
  const normalizedTitle = String(nextTitle || "").trim();

  if (!normalizedId) {
    throw new Error("Analysis report not found.");
  }

  if (!normalizedTitle) {
    throw new Error("Report title is required.");
  }

  const reports = readAnalysisReports();
  const reportIndex = reports.findIndex((entry) => entry.id === normalizedId);
  if (reportIndex === -1) {
    throw new Error("Analysis report not found.");
  }

  const existingReport = reports[reportIndex];
  reports[reportIndex] = {
    ...existingReport,
    report_name: normalizedTitle,
    updated_at: new Date().toISOString(),
  };

  writeAnalysisReports(reports);
  return serializeAnalysisReport(reports[reportIndex]);
}

async function rebuildAnalysisReport(reportId) {
  const normalizedId = String(reportId || "").trim();
  if (!normalizedId) {
    throw new Error("Analysis report not found.");
  }

  const reports = readAnalysisReports();
  const reportIndex = reports.findIndex((entry) => entry.id === normalizedId);
  if (reportIndex === -1) {
    throw new Error("Analysis report not found.");
  }

  const existingReport = reports[reportIndex];
  const parameters = existingReport.parameters || {};
  const run = {
    id: existingReport.runId || existingReport.run_id || "rebuild_run",
    runName: existingReport.run_name || existingReport.runName || "",
    createdAt: existingReport.created_at || existingReport.createdAt || new Date().toISOString(),
  };
  const pull = {
    id: existingReport.pullId || existingReport.pull_id || "rebuild_pull",
    reportId: parameters.report_id || DEFAULT_REPORT_ID,
    analysisLabel: parameters.analysis_label || existingReport.report_name || "",
    keyCodes: ensureArray(parameters.key_codes),
    years: ensureArray(parameters.selected_years),
    dateRange: {
      startDate: parameters.start_date || "",
      endDate: parameters.end_date || "",
    },
    scf: parameters.scf_filter || "",
    clientType: parameters.client_type || "",
    notes: parameters.notes || "",
  };

  const filterValues = buildSalesforceFilterValues(pull);
  const result = await fetchFlexibleSalesforceReportData(pull.reportId, {
    keyCodes: filterValues.keyCodes,
    years: pull.years,
    dateRange: pull.dateRange,
    scf: pull.scf,
    clientType: filterValues.clientType,
  });

  const inputRows = Number(result.unfilteredRowCount || 0);
  const effectiveListType = resolveAnalysisReferenceListTypeFromPull(pull);
  const effectiveClientType = effectiveListType === "nhcl" ? "NHCL" : effectiveListType === "rfc" ? "RFC" : pull.clientType;
  const rows = padAnalysisRowsWithReferenceList(result.rows, result.columns, effectiveClientType);
  const exportRows = ensureArray(result.exportRows).length
    ? ensureArray(result.exportRows)
    : ensureArray(result.rows);
  const exportRowCount = Number(result.exportRowCount || exportRows.length || 0);
  let zeroReason = "";
  if (inputRows === 0) {
    zeroReason = "No matching source rows were returned from Salesforce.";
  } else if (rows.length === 0) {
    zeroReason = "Filters removed all rows for this report.";
  }
  if (
    rows.length === 0 &&
    Array.isArray(result.availableKeyValues) &&
    result.availableKeyValues.length > 0 &&
    buildSalesforceFilterValues(pull).keyCodes.length > 0
  ) {
    zeroReason = `No rows matched the selected Key filter. Available Key values in this report: ${result.availableKeyValues.join(", ")}.`;
  }

  const rebuiltReport = buildAnalysisReportRecord(run, pull, {
    id: existingReport.id,
    createdAt: existingReport.created_at || existingReport.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "complete",
    rows,
    columns: result.columns,
    summaryValues: result.summaryValues || [],
    exportColumns: result.exportColumns || [],
    exportRows,
    exportRowCount,
    inputRowCount: inputRows,
    zeroReason,
  });

  reports[reportIndex] = {
    ...rebuiltReport,
    report_name: existingReport.report_name || rebuiltReport.report_name,
  };
  writeAnalysisReports(reports);
  return serializeAnalysisReport(reports[reportIndex]);
}

async function getAnalysisReportScfMetrics(reportId, scf) {
  const normalizedId = String(reportId || "").trim();
  const normalizedScf = normalizeScf(scf);
  if (!normalizedId) {
    throw new Error("Analysis report not found.");
  }
  if (!normalizedScf) {
    throw new Error("SCF is required.");
  }

  const report = readAnalysisReports().find((entry) => String(entry.id || "").trim() === normalizedId);
  if (!report) {
    throw new Error("Analysis report not found.");
  }

  const savedExportRows = ensureArray(report.exportRows);
  const normalizedKeys = ensureArray(report.parameters?.key_codes)
    .map((value) => normalizeAnalysisStoredKeyCode(value))
    .filter(Boolean);

  if (savedExportRows.length && hasAnalysisDetailExportRows(savedExportRows)) {
    const savedSummary = buildFlatRowsFromDetailExport(savedExportRows);
    const matchingSavedRows = findAnalysisSummaryRow(savedSummary?.rows, normalizedScf, normalizedKeys);
    if (matchingSavedRows.length) {
      const preferredSavedRow =
        matchingSavedRows.find((row) => !isSparseSavedAnalysisMetricRow(row)) || matchingSavedRows[0];
      if (!isSparseSavedAnalysisMetricRow(preferredSavedRow)) {
        return {
          reportId: normalizedId,
          scf: normalizedScf,
          row: preferredSavedRow,
          rows: matchingSavedRows,
          source: "saved-detail-export-aggregate",
        };
      }
    }
  }

  const parameters = report.parameters || {};
  const savedSummaryRows = findAnalysisSummaryRow(report.rows, normalizedScf, normalizedKeys);
  const savedSummaryRow = savedSummaryRows[0] || null;
  const shouldFetchLiveFallback = !savedSummaryRow || shouldSupplementSavedSummaryRow(savedSummaryRow);

  if (savedSummaryRow && !shouldFetchLiveFallback) {
    return {
      reportId: normalizedId,
      scf: normalizedScf,
      row: savedSummaryRow,
      rows: savedSummaryRows,
      source: "saved-summary-rows",
    };
  }

  const result = shouldFetchLiveFallback
    ? await fetchAnalysisReportScfMetrics(parameters.report_id || DEFAULT_REPORT_ID, {
        scf: normalizedScf,
        keyCodes: ensureArray(parameters.key_codes),
        dateRange: {
          startDate: parameters.start_date || "",
          endDate: parameters.end_date || "",
        },
      })
    : { row: null, rows: [] };

  if (savedSummaryRow) {
    const mergedRow = result?.row
      ? mergeAnalysisMetricRowsPreferNonZero(savedSummaryRow, result.row)
      : savedSummaryRow;
    return {
      reportId: normalizedId,
      scf: normalizedScf,
      row: mergedRow,
      rows: result?.row ? [mergedRow] : savedSummaryRows,
      source: result?.row ? "saved-summary-with-live-supplement" : "saved-summary-rows",
    };
  }

  return {
    reportId: normalizedId,
    scf: normalizedScf,
    row: result.row,
    rows: result.rows,
    source: "salesforce-scoped-refetch",
  };
}

async function getAnalysisReportRateDebug(reportId, scf) {
  const normalizedId = String(reportId || "").trim();
  const normalizedScf = normalizeScf(scf);
  if (!normalizedId) {
    throw new Error("Analysis report not found.");
  }
  if (!normalizedScf) {
    throw new Error("SCF is required.");
  }

  const report = readAnalysisReports().find((entry) => String(entry.id || "").trim() === normalizedId);
  if (!report) {
    throw new Error("Analysis report not found.");
  }

  const normalizedKeys = ensureArray(report.parameters?.key_codes)
    .map((value) => normalizeAnalysisStoredKeyCode(value))
    .filter(Boolean);
  const savedExportRows = ensureArray(report.exportRows);
  const savedExportIsDetail = hasAnalysisDetailExportRows(savedExportRows);
  const matchingSavedDetailRows = savedExportIsDetail
    ? savedExportRows.filter((row) => {
        const rowScf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row.scf ?? "");
        if (rowScf !== normalizedScf) {
          return false;
        }
        if (!normalizedKeys.length) {
          return true;
        }
        const rowKey = String(row["Key"] ?? row.key ?? "").trim().toUpperCase();
        return normalizedKeys.includes(rowKey);
      })
    : [];
  const savedDetailAggregate = matchingSavedDetailRows.length
    ? findAnalysisSummaryRow(buildFlatRowsFromDetailExport(matchingSavedDetailRows).rows, normalizedScf, normalizedKeys)[0] || null
    : null;
  const savedSummaryRows = findAnalysisSummaryRow(report.rows, normalizedScf, normalizedKeys);
  const savedSummaryRow = savedSummaryRows[0] || null;

  let liveMetrics = null;
  let liveError = "";
  try {
    const parameters = report.parameters || {};
    liveMetrics = await fetchAnalysisReportScfMetrics(parameters.report_id || DEFAULT_REPORT_ID, {
      scf: normalizedScf,
      keyCodes: ensureArray(parameters.key_codes),
      dateRange: {
        startDate: parameters.start_date || "",
        endDate: parameters.end_date || "",
      },
    });
  } catch (error) {
    liveError = error instanceof Error ? error.message : String(error || "Unable to fetch live SCF metrics.");
  }

  const liveRow = liveMetrics?.row || null;
  const selectedSource = choosePreferredAnalysisScfRow({
    detailRow: savedDetailAggregate,
    savedSummaryRow,
    liveRow,
  });
  const chosenSource = selectedSource.source;
  const overwriteWarnings = savedSummaryRow && liveRow
    ? buildAnalysisOverwriteProtection(savedSummaryRow, liveRow)
    : [];

  const debugPayload = {
    reportId: normalizedId,
    requestedScf: String(scf || ""),
    normalizedScf,
    keyCodes: normalizedKeys,
    sourcePriority: [
      "detail-export-rows",
      "saved-summary-rows",
      "salesforce-scoped-refetch",
    ],
    chosenSource,
    savedExportRowsAreDetail: savedExportIsDetail,
    savedExportRowCount: savedExportRows.length,
    matchingSavedDetailRowCount: matchingSavedDetailRows.length,
    matchingSavedSummaryRowCount: savedSummaryRows.length,
    candidateFieldNames: getAnalysisRateFieldCandidates([
      ...matchingSavedDetailRows,
      ...(savedSummaryRow ? [savedSummaryRow] : []),
      ...(liveRow ? [liveRow] : []),
    ]),
    savedDetailAggregate: savedDetailAggregate
      ? {
          metrics: summarizeAnalysisRateRow(savedDetailAggregate),
          row: savedDetailAggregate,
        }
      : null,
    savedSummaryAggregate: savedSummaryRow
      ? {
          metrics: summarizeAnalysisRateRow(savedSummaryRow),
          row: savedSummaryRow,
        }
      : null,
    liveScopedAggregate: liveRow
      ? {
          metrics: summarizeAnalysisRateRow(liveRow),
          row: liveRow,
          source: liveMetrics?.source || "salesforce-scoped-refetch",
        }
      : null,
    liveError,
    mergeProtection: {
      attemptedOverwrite: overwriteWarnings.length > 0,
      warnings: overwriteWarnings,
    },
  };

  console.log(`Analysis rate debug ${normalizedId} ${normalizedScf}:`, JSON.stringify({
    source: debugPayload.chosenSource,
    savedExportRowsAreDetail: debugPayload.savedExportRowsAreDetail,
    matchingSavedDetailRowCount: debugPayload.matchingSavedDetailRowCount,
    savedDetailMetrics: debugPayload.savedDetailAggregate?.metrics || null,
    savedSummaryMetrics: debugPayload.savedSummaryAggregate?.metrics || null,
    liveMetrics: debugPayload.liveScopedAggregate?.metrics || null,
    liveError: debugPayload.liveError || "",
  }));

  return debugPayload;
}

function compareAnalysisReports(reportAId, reportBId, comparisonRequest = {}) {
  const reports = readAnalysisReports();
  const reportA = reports.find((entry) => entry.id === reportAId);
  const reportB = reports.find((entry) => entry.id === reportBId);
  if (!reportA || !reportB) {
    throw new Error("Both reports must be selected for comparison.");
  }

  const normalizedRequest = {
    id: comparisonRequest.id || `comparison_${Date.now()}`,
    reportAId,
    reportBId,
    comparisonName: String(comparisonRequest.comparisonName || comparisonRequest.label || "").trim(),
    matchField: String(comparisonRequest.matchField || "SCF Grouping").trim() || "SCF Grouping",
    metricColumns: ensureArray(comparisonRequest.metricColumns)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  };

  const normalizedReportA = {
    id: reportA.id,
    analysisLabel: reportA.report_name,
    columns: ensureArray(reportA.columns),
    rows: ensureArray(reportA.rows),
  };
  const normalizedReportB = {
    id: reportB.id,
    analysisLabel: reportB.report_name,
    columns: ensureArray(reportB.columns),
    rows: ensureArray(reportB.rows),
  };

  return buildComparison(normalizedReportA, normalizedReportB, normalizedRequest);
}

async function executeAnalysisRun(runId) {
  const runs = readAnalysisRuns();
  const run = runs.find((entry) => entry.id === runId);
  if (!run) {
    return;
  }

  try {
    run.errorMessage = null;
    run.referenceListsSnapshot =
      run.referenceListsSnapshot || buildReferenceListSnapshotForRun();
    const results = [];
    const savedReports = [];
    const errors = [];
    const totalPulls = run.reportPulls.length;

    for (let index = 0; index < run.reportPulls.length; index += 1) {
      const pull = run.reportPulls[index];
      try {
        run.updatedAt = new Date().toISOString();
        run.statusDetail = `Running report ${index + 1} of ${totalPulls}: ${pull.analysisLabel || pull.reportId || pull.id}`;
        writeAnalysisRuns(runs);
        console.log("Starting report:", pull.analysisLabel || pull.reportId || pull.id);
        const filterValues = buildSalesforceFilterValues(pull);
        const result = await fetchFlexibleSalesforceReportData(pull.reportId, {
          keyCodes: filterValues.keyCodes,
          years: pull.years,
          dateRange: pull.dateRange,
          scf: pull.scf,
          clientType: filterValues.clientType,
        });
        const diagnostics = result.diagnostics || null;
        const inputRows = Number(result.unfilteredRowCount || 0);
        const effectiveListType = resolveAnalysisReferenceListTypeFromPull(pull);
        const effectiveClientType = effectiveListType === "nhcl" ? "NHCL" : effectiveListType === "rfc" ? "RFC" : pull.clientType;
        const displayRows = padAnalysisRowsWithReferenceList(
          result.rows,
          result.columns,
          effectiveClientType
        );
        const savedExportRows = ensureArray(result.exportRows).length
          ? ensureArray(result.exportRows)
          : ensureArray(result.rows);
        const exportRowCount = Number(result.exportRowCount || savedExportRows.length || 0);
        console.log("Input rows:", inputRows);
        console.log("Summary rows:", displayRows.length);
        console.log("Export rows:", exportRowCount);
        if (diagnostics) {
          console.log("Field names:", diagnostics.availableFieldNames);
          console.log("Premium samples:", diagnostics.samplePremiumValues);
          console.log("Key distribution:", diagnostics.keyDistribution);
          if (diagnostics.suspicious) {
            console.warn("Dollar warning:", diagnostics.warningMessage);
          }
        }

        let zeroReason = "";
        if (!pull.analysisLabel && !pull.clientType) {
          zeroReason = "Missing selected report type.";
        } else if (inputRows === 0) {
          zeroReason = "No matching source rows were returned from Salesforce.";
        } else if (displayRows.length === 0) {
          zeroReason = "Filters removed all rows for this report.";
        }
        if (
          displayRows.length === 0 &&
          Array.isArray(result.availableKeyValues) &&
          result.availableKeyValues.length > 0 &&
          buildSalesforceFilterValues(pull).keyCodes.length > 0
        ) {
          zeroReason = `No rows matched the selected Key filter. Available Key values in this report: ${result.availableKeyValues.join(", ")}.`;
        }
        if (displayRows.length === 0) {
          console.log("Zero-row reason:", zeroReason || "No rows found after processing.");
        }

        const savedReport = buildAnalysisReportRecord(run, pull, {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "complete",
          rows: displayRows,
          columns: result.columns,
          summaryValues: result.summaryValues || [],
          exportColumns: result.exportColumns || [],
          exportRows: savedExportRows,
          exportRowCount,
          inputRowCount: inputRows,
          zeroReason,
          warningMessage: diagnostics?.warningMessage || "",
          diagnostics,
        });
        savedReports.push(savedReport);
        console.log("Saved report id:", savedReport.id);
        console.log(
          "Export file:",
          savedReport.export_file_name
            ? { fileName: savedReport.export_file_name, path: savedReport.export_file_path }
            : null
        );

        const displayColumns = relabelAnalysisColumns(result.columns);
        const displaySummaryValues = relabelAnalysisSummaryValues(result.summaryValues || []);
        const renderedRows = relabelAnalysisRows(displayRows, result.columns);

        results.push({
          ...pull,
          status: "complete",
          error: "",
          columns: displayColumns,
          summaryValues: displaySummaryValues,
          rows: renderedRows,
          rawRowCount: result.unfilteredRowCount,
          exportRowCount,
          executedAt: new Date().toISOString(),
          savedReportId: savedReport.id,
          reportName: savedReport.report_name,
          resultCount: savedReport.result_count,
          exportFileName: savedReport.export_file_name,
          warningMessage: savedReport.warning_message || "",
          diagnostics,
        });
        run.updatedAt = new Date().toISOString();
        run.statusDetail = `Completed report ${index + 1} of ${totalPulls}: ${pull.analysisLabel || pull.reportId || pull.id}`;
        writeAnalysisRuns(runs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Unknown error");
        errors.push(`${pull.analysisLabel}: ${message}`);
        console.log("Starting report:", pull.analysisLabel || pull.reportId || pull.id);
        console.log("Input rows:", 0);
        console.log("Export rows:", 0);
        console.log("Zero-row reason:", message || "Parser failed.");
        const failedReport = buildAnalysisReportRecord(run, pull, {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "failed",
          rows: [],
          columns: [],
          summaryValues: [],
          exportColumns: [],
          exportRows: [],
          exportRowCount: 0,
          inputRowCount: 0,
          zeroReason: message || "Parser failed.",
          errorMessage: message,
        });
        savedReports.push(failedReport);
        console.log("Saved report id:", failedReport.id);
        console.log("Export file:", null);
        results.push({
          ...pull,
          status: "failed",
          error: message,
          columns: [],
          summaryValues: [],
          rows: [],
          rawRowCount: 0,
          exportRowCount: 0,
          executedAt: new Date().toISOString(),
          savedReportId: failedReport.id,
          reportName: failedReport.report_name,
          resultCount: 0,
          exportFileName: null,
        });
        run.updatedAt = new Date().toISOString();
        run.statusDetail = `Report ${index + 1} of ${totalPulls} failed: ${pull.analysisLabel || pull.reportId || pull.id}. ${message}`;
        writeAnalysisRuns(runs);
      }
    }

    run.reportPulls = results;
    run.comparisons = run.comparisonRequests
      .map((comparisonRequest) => {
        const reportA = run.reportPulls.find((entry) => entry.id === comparisonRequest.reportAId);
        const reportB = run.reportPulls.find((entry) => entry.id === comparisonRequest.reportBId);
        if (!reportA || !reportB) {
          return null;
        }

        return buildComparison(reportA, reportB, comparisonRequest);
      })
      .filter(Boolean);
    run.updatedAt = new Date().toISOString();
    run.completedAt = new Date().toISOString();
    run.summary = summarizeRun(run);
    run.artifacts = writeAnalysisArtifacts(run);
    replaceReportsForRun(run.id, savedReports);

    const successfulPullCount = run.reportPulls.filter((pull) => pull.status !== "failed").length;
    const zeroRowPullCount = run.reportPulls.filter(
      (pull) => pull.status !== "failed" && Number(pull.rawRowCount || 0) === 0
    ).length;
    if (successfulPullCount === run.reportPulls.length && zeroRowPullCount === 0) {
      run.status = "complete";
      run.statusDetail = "Analysis run completed successfully.";
      run.errorMessage = null;
    } else if (successfulPullCount === run.reportPulls.length) {
      run.status = "complete";
      run.statusDetail = `Analysis run completed, but ${zeroRowPullCount} report pull(s) returned no source rows.`;
      run.errorMessage = null;
    } else if (successfulPullCount > 0) {
      run.status = "partial";
      run.statusDetail = `Completed ${successfulPullCount} of ${run.reportPulls.length} report pulls. Failed pulls: ${errors.join(" | ")}`;
      run.errorMessage = errors.join(" | ");
    } else {
      run.status = "failed";
      run.errorMessage = errors.join(" | ") || "All report pulls failed.";
      run.statusDetail = run.errorMessage;
    }
  } catch (error) {
    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    run.completedAt = new Date().toISOString();
    run.errorMessage = error.message;
    run.statusDetail = error.message;
  }

  writeAnalysisRuns(runs);
}

function createAnalysisRun(body = {}) {
  const request = normalizeAnalysisRequest(body);
  if (!request.reportPulls.length) {
    throw new Error("At least one report pull is required.");
  }
  const runs = readAnalysisRuns();
  const now = new Date().toISOString();
  const run = {
    id: createRunId(),
    runName: request.runName,
    status: "running",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    setupId: request.setupId,
    errorMessage: null,
    referenceListsSnapshot:
      request.referenceListsSnapshot || buildReferenceListSnapshotForRun(),
    statusDetail: "Queued Salesforce analysis run.",
    reportPulls: request.reportPulls,
    comparisonRequests: request.comparisonRequests,
    reviewState: request.reviewState,
    comparisons: [],
    scfActions: [],
    artifacts: [],
    summary: null,
  };

  runs.unshift(run);
  writeAnalysisRuns(runs);

  setTimeout(() => {
    executeAnalysisRun(run.id);
  }, 300);

  return serializeAnalysisRun(run);
}

function archiveAnalysisSetup(setupId, archived = true) {
  const setups = readAnalysisSetups();
  const setup = setups.find((entry) => entry.id === setupId);
  if (!setup) {
    throw new Error("Analysis setup not found.");
  }

  setup.archived = Boolean(archived);
  setup.updatedAt = new Date().toISOString();
  writeAnalysisSetups(setups);
  return serializeAnalysisSetup(setup);
}

function listReferenceLists() {
  const payload = readReferenceLists();
  return payload.lists.map((list) => ({
    type: list.type,
    name: list.name,
    sourceName: list.sourceName || "",
    updatedAt: payload.updatedAt,
    count: ensureArray(list.items).length,
    items: list.items,
    history: ensureArray(payload.history).filter((entry) => entry.listType === list.type),
    ...(list.type === "dnm"
      ? {
          dnmHeader: DNM_CATALOG_HEADER,
          stateGroups: buildDnmStateGroups(list.items),
        }
      : {}),
  }));
}

function getReferenceListByType(listType) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc", "candidate"].includes(normalizedType)) {
    throw new Error("Reference list type must be dnm, nhcl, rfc, or candidate.");
  }

  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === normalizedType);
  if (!list) {
    throw new Error(`Reference list not found: ${normalizedType}`);
  }

  return {
    type: list.type,
    name: list.name,
    sourceName: list.sourceName || "",
    updatedAt: payload.updatedAt,
    count: ensureArray(list.items).length,
    items: ensureArray(list.items),
    history: ensureArray(payload.history).filter((entry) => entry.listType === normalizedType),
    ...(normalizedType === "dnm"
      ? {
          dnmHeader: DNM_CATALOG_HEADER,
          stateGroups: buildDnmStateGroups(list.items),
          availableStateGroups: buildDnmStateGroups(list.items).filter((group) => !group.isActive),
        }
      : {}),
  };
}

function parseReferenceListEntriesFromBody(payload = {}, normalizedType = "") {
  const rawEntries = [];
  const entriesFromBody = ensureArray(payload.entries);
  const fallbackState = normalizeState(
    payload.state || payload.scope || payload.mailingTo || ""
  );

  entriesFromBody.forEach((entry) => {
    const scf = normalizeScf(entry?.scf);
    if (!scf) {
      return;
    }
    rawEntries.push({ scf, state: normalizeState(entry.state) });
  });

  const parsedScfInput = ensureArray(payload.scfs).length
    ? payload.scfs
    : Array.isArray(payload.scf)
      ? payload.scf.flatMap((item) => String(item || "").split(/[,\n\r\t ]+/)).filter(Boolean)
      : [payload.scf].flatMap((item) => String(item || "").split(/[,\n\r\t ]+/)).filter(Boolean);

  parsedScfInput.forEach((entry) => {
    const scf = normalizeScf(entry);
    if (!scf) {
      return;
    }
    rawEntries.push({ scf, state: fallbackState });
  });

  const scfItems = [];
  const seenScfs = new Set();
  rawEntries.forEach((entry) => {
    if (seenScfs.has(entry.scf)) {
      return;
    }
    seenScfs.add(entry.scf);
    scfItems.push({ scf: entry.scf, state: normalizeState(entry.state) });
  });

  if (normalizedType !== "dnm") {
    return scfItems;
  }

  return scfItems.filter((entry) => entry.scf);
}

function addReferenceListItems({
  listType,
  scfs = [],
  actor = DEFAULT_ACTOR,
  reason = "",
  sourceName = "",
  scope = "",
  state = "",
  requestPayload = null,
}) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    throw new Error("Reference list type must be dnm, nhcl, or rfc.");
  }

  const normalizedEntries = parseReferenceListEntriesFromBody(
    {
      entries: requestPayload?.entries || [],
      scfs: requestPayload?.entries ? [] : scfs,
      scf: requestPayload?.scf,
      state: requestPayload?.state || state,
      scope,
      mailingTo: requestPayload?.mailingTo || "",
    },
    normalizedType
  );

  if (!normalizedEntries.length) {
    throw new Error("Add at least one valid 3-digit SCF.");
  }

  if (normalizedType !== "dnm") {
    const dnmLookup = getReferenceListLookup("dnm");
    const blockedEntry = normalizedEntries.find((entry) => dnmLookup.has(entry.scf));
    if (blockedEntry) {
      throw new Error(
        "This SCF is on the Do Not Mail list and cannot be added to NHCL/RFC."
      );
    }
  }

  const parsedScfs = normalizedEntries.map((entry) => entry.scf);
  const scfStates = normalizedEntries.reduce((memo, entry) => {
    memo[entry.scf] = normalizeState(entry.state);
    return memo;
  }, {});

  if (!parsedScfs.length) {
    throw new Error("Add at least one valid 3-digit SCF.");
  }


  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === normalizedType);
  if (!list) {
    throw new Error(`Reference list not found: ${normalizedType}`);
  }
  const beforeItems = normalizeReferenceListSnapshotItems(list.items);

  const existing = new Set(ensureArray(list.items).map((entry) => entry.scf));
  const added = [];

  parsedScfs.forEach((scf) => {
    if (existing.has(scf)) {
      return;
    }

    const dnmGroup = normalizedType === "dnm" ? normalizeScopeForDnm(scope) : null;

    list.items.unshift({
      scf,
      scope: dnmGroup?.scope || scfStates[scf] || String(scope || "").trim(),
      state: normalizedType === "dnm" ? resolveListItemState({ state: dnmGroup?.scope }) : scfStates[scf] || "",
      stateKey: dnmGroup?.key || "",
      addedAt: new Date().toISOString(),
      addedBy: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
      reason: String(reason || "").trim(),
      sourceAnalysis: String(sourceName || "manual-list-manager").trim() || "manual-list-manager",
    });
    existing.add(scf);
    added.push(scf);
  });

  list.sourceName = String(sourceName || list.sourceName || "Managed in app").trim() || "Managed in app";
  const changedAt = new Date().toISOString();
  payload.updatedAt = changedAt;
  recordReferenceListHistory(payload, {
    listType: normalizedType,
    actionType: "manual-add",
    actor: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
    sourceName: String(sourceName || list.sourceName || "manual-list-manager").trim() || "manual-list-manager",
    reason: String(reason || "").trim(),
    changedAt,
    beforeItems,
    afterItems: normalizeReferenceListSnapshotItems(list.items),
    metadata: {
      addedScfs: added,
      skippedCount: parsedScfs.length - added.length,
    },
  });
  writeReferenceLists(payload);

  return {
    list: getReferenceListByType(normalizedType),
    addedScfs: added,
    skippedCount: parsedScfs.length - added.length,
  };
}

function removeReferenceListItem(listType, scf) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    throw new Error("Reference list type must be dnm, nhcl, or rfc.");
  }

  const normalizedScf = normalizeScf(scf);
  if (!normalizedScf) {
    throw new Error("A valid 3-digit SCF is required.");
  }

  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === normalizedType);
  if (!list) {
    throw new Error(`Reference list not found: ${normalizedType}`);
  }
  const beforeItems = normalizeReferenceListSnapshotItems(list.items);

  const nextItems = ensureArray(list.items).filter((entry) => entry.scf !== normalizedScf);
  if (nextItems.length === ensureArray(list.items).length) {
    throw new Error(`SCF ${normalizedScf} was not found in ${normalizedType.toUpperCase()}.`);
  }

  list.items = nextItems;
  const changedAt = new Date().toISOString();
  payload.updatedAt = changedAt;
  recordReferenceListHistory(payload, {
    listType: normalizedType,
    actionType: "manual-remove",
    actor: DEFAULT_ACTOR,
    sourceName: "manual-list-manager",
    reason: "",
    changedAt,
    beforeItems,
    afterItems: normalizeReferenceListSnapshotItems(list.items),
    metadata: {
      removedScfs: [normalizedScf],
    },
  });
  writeReferenceLists(payload);

  return getReferenceListByType(normalizedType);
}

function addDnmStateGroup({
  stateKey,
  actor = DEFAULT_ACTOR,
  reason = "",
  sourceName = "",
}) {
  const group = DNM_SEED_GROUPS.find((entry) => entry.key === String(stateKey || "").trim());
  if (!group) {
    throw new Error("Select a valid Do Not Mail state.");
  }

  if (!group.scfs.length) {
    const payload = readReferenceLists();
    const list = payload.lists.find((entry) => entry.type === "dnm");
    if (!list) {
      throw new Error("Reference list not found: dnm");
    }

    const existingMarker = ensureArray(list.items).some(
      (entry) => entry.stateKey === group.key || normalizeScopeForDnm(entry.scope)?.key === group.key
    );
    if (!existingMarker) {
      const beforeItems = normalizeReferenceListSnapshotItems(list.items);
      list.items.unshift({
        scf: "",
        scope: group.scope,
        stateKey: group.key,
        addedAt: new Date().toISOString(),
        addedBy: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
        reason: String(reason || "").trim(),
        sourceAnalysis: String(sourceName || DNM_CATALOG_HEADER).trim() || DNM_CATALOG_HEADER,
      });
      const changedAt = new Date().toISOString();
      payload.updatedAt = changedAt;
      recordReferenceListHistory(payload, {
        listType: "dnm",
        actionType: "manual-add-state",
        actor: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
        sourceName: String(sourceName || DNM_CATALOG_HEADER).trim() || DNM_CATALOG_HEADER,
        reason: String(reason || "").trim(),
        changedAt,
        beforeItems,
        afterItems: normalizeReferenceListSnapshotItems(list.items),
        metadata: {
          stateKey: group.key,
        },
      });
      writeReferenceLists(payload);
    }

    return {
      list: getReferenceListByType("dnm"),
      addedScfs: [],
      skippedCount: 0,
    };
  }

  return addReferenceListItems({
    listType: "dnm",
    scfs: group.scfs,
    actor,
    reason,
    sourceName: sourceName || DNM_CATALOG_HEADER,
    scope: group.scope,
  });
}

function removeDnmStateGroup(stateKey) {
  const group = DNM_SEED_GROUPS.find((entry) => entry.key === String(stateKey || "").trim());
  if (!group) {
    throw new Error("Select a valid Do Not Mail state.");
  }

  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === "dnm");
  if (!list) {
    throw new Error("Reference list not found: dnm");
  }
  const beforeItems = normalizeReferenceListSnapshotItems(list.items);

  const nextItems = ensureArray(list.items).filter((entry) => {
    const normalizedScf = normalizeScf(entry.scf);
    const scopeGroup = normalizeScopeForDnm(entry.scope);
    if (entry.stateKey && entry.stateKey === group.key) {
      return false;
    }
    if (scopeGroup?.key === group.key) {
      return false;
    }
    return !group.scfs.includes(normalizedScf);
  });

  if (nextItems.length === ensureArray(list.items).length) {
    throw new Error(`${group.state} was not found in DNM.`);
  }

  list.items = nextItems;
  const changedAt = new Date().toISOString();
  payload.updatedAt = changedAt;
  recordReferenceListHistory(payload, {
    listType: "dnm",
    actionType: "manual-remove-state",
    actor: DEFAULT_ACTOR,
    sourceName: "manual-list-manager",
    reason: "",
    changedAt,
    beforeItems,
    afterItems: normalizeReferenceListSnapshotItems(list.items),
    metadata: {
      stateKey: group.key,
    },
  });
  writeReferenceLists(payload);
  return getReferenceListByType("dnm");
}

function extractScfsFromText(text) {
  return Array.from(new Set((String(text || "").match(/\b\d{3}\b/g) || []).map(normalizeScf))).filter(Boolean);
}

function runPowerShell(command) {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "PowerShell command failed.");
  }
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseWorksheetValues(sheetXml, sharedStrings) {
  const values = [];
  const cellPattern = /<c\b[^>]*?(?:t="([^"]+)")?[^>]*?(?:>([\s\S]*?)<\/c>|\/>)/g;
  let cellMatch = null;

  while ((cellMatch = cellPattern.exec(sheetXml))) {
    const cellType = cellMatch[1] || "";
    const cellBody = cellMatch[2] || "";
    const inlineMatch = cellBody.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
    const valueMatch = cellBody.match(/<v>([\s\S]*?)<\/v>/);
    let value = "";

    if (inlineMatch) {
      value = decodeXmlEntities(inlineMatch[1]);
    } else if (cellType === "s" && valueMatch) {
      value = sharedStrings[Number(valueMatch[1])] || "";
    } else if (valueMatch) {
      value = decodeXmlEntities(valueMatch[1]);
    }

    if (String(value).trim()) {
      values.push(String(value).trim());
    }
  }

  return values;
}

function parseWorksheetRows(sheetXml, sharedStrings) {
  const rows = {};
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellPattern = /<c\b[^>]*r="([A-Z]+)\d+"[^>]*?(?:t="([^"]+)")?[^>]*?(?:>([\s\S]*?)<\/c>|\/>)/g;

  let rowMatch = null;
  let maxRow = 0;

  while ((rowMatch = rowPattern.exec(sheetXml))) {
    const rowXml = rowMatch[1] || "";
    const cellMatches = rowXml.matchAll(cellPattern);
    for (const cellMatch of cellMatches) {
      const cellRef = cellMatch[0].match(/r="([A-Z]+)(\d+)"/);
      if (!cellRef) {
        continue;
      }

      const column = cellRef[1];
      const row = Number(cellRef[2]);
      const cellType = cellMatch[2] || "";
      const cellBody = cellMatch[3] || "";
      const inlineMatch = cellBody.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const valueMatch = cellBody.match(/<v>([\s\S]*?)<\/v>/);
      let value = "";

      if (inlineMatch) {
        value = decodeXmlEntities(inlineMatch[1]);
      } else if (cellType === "s" && valueMatch) {
        value = sharedStrings[Number(valueMatch[1])] || "";
      } else if (valueMatch) {
        value = decodeXmlEntities(valueMatch[1]);
      }

      if (!rows[row]) {
        rows[row] = {};
      }
      rows[row][column] = String(value).trim();
      if (row > maxRow) {
        maxRow = row;
      }
    }
  }

  return Array.from({ length: maxRow }, (_, index) => rows[index + 1] || {}).map((row, index) => ({
    index: index + 1,
    cells: row || {},
  }));
}

function parseXlsxScfs(buffer) {
  const worksheets = parseXlsxWorksheets(buffer);
  if (!worksheets.length) {
    return [];
  }

  return extractScfsFromText(
    parseWorksheetValues(worksheets[0].xml, worksheets[0].sharedStrings).join("\n")
  );
}

function parseXlsxScfStateRows(buffer, sheetName) {
  const worksheets = parseXlsxWorksheets(buffer);
  const normalizedSheetName = String(sheetName || "").trim().toLowerCase();
  const isLikelyStateCode = (value) => /^[A-Za-z]{2,3}$/.test(String(value || "").trim());

  const extractScfStateEntriesFromRows = (worksheetRows) => {
    const maxColumnFromLetter = (column) => {
      return [...String(column || "").toUpperCase()].reduce(
        (acc, char) => acc * 26 + (char.charCodeAt(0) - 64),
        0
      );
    };

    return worksheetRows
      .flatMap((row) => {
        const values = row.cells;
        const columns = Object.keys(values).sort((a, b) => maxColumnFromLetter(a) - maxColumnFromLetter(b));
        const entries = [];

        const isSimpleTwoColumn =
          columns.length <= 2 && columns.includes("A") && columns.includes("B");

        if (isSimpleTwoColumn) {
          const scf = normalizeScf(values.A);
          const state = normalizeState(values.B);
          if (scf && isLikelyStateCode(state)) {
            entries.push({ scf, state });
          }
          return entries;
        }

        for (let i = 0; i < columns.length - 1; i += 1) {
          const col = columns[i];
          const nextCol = columns[i + 1];
          if (!col || !nextCol) {
            continue;
          }

          if (maxColumnFromLetter(nextCol) - maxColumnFromLetter(col) !== 1) {
            continue;
          }

          const scf = normalizeScf(values[col]);
          if (!scf) {
            continue;
          }

          const state = normalizeState(values[nextCol]);
          if (!isLikelyStateCode(state)) {
            continue;
          }

          entries.push({ scf, state });
        }

        return entries;
      })
      .filter(Boolean);
  };

  const tryWorksheet = (worksheet) => {
    const worksheetRows = parseWorksheetRows(worksheet.xml, worksheet.sharedStrings);
    return extractScfStateEntriesFromRows(worksheetRows);
  };

  if (worksheets.length === 0) {
    throw new Error("Worksheet not found.");
  }

  const exactMatchWorksheet = worksheets.find(
    (entry) => String(entry.name || "").trim().toLowerCase() === normalizedSheetName
  );
  if (exactMatchWorksheet) {
    const exactMatchEntries = tryWorksheet(exactMatchWorksheet);
    if (exactMatchEntries.length > 0) {
      return exactMatchEntries;
    }
  }

  const fallbackCandidates = worksheets
    .map((entry) => {
      const extractedEntries = tryWorksheet(entry);
      return { entry, extractedEntries, score: extractedEntries.length };
    })
    .filter((item) => item.extractedEntries.length > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      const aHasPreferredName =
        /table\s*1/i.test(String(a.entry.name || "")) ||
        /combined scf for data team/i.test(String(a.entry.name || ""));
      const bHasPreferredName =
        /table\s*1/i.test(String(b.entry.name || "")) ||
        /combined scf for data team/i.test(String(b.entry.name || ""));
      if (aHasPreferredName !== bHasPreferredName) {
        return aHasPreferredName ? -1 : 1;
      }
      return 0;
    });

  if (!fallbackCandidates.length) {
    throw new Error(`Worksheet not found: ${sheetName}`);
  }

  return fallbackCandidates[0].extractedEntries;
}

function parseXlsxWorksheets(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-analysis-upload-"));
  const zipPath = path.join(tempDir, "upload.zip");
  const extractDir = path.join(tempDir, "unzipped");
  fs.writeFileSync(zipPath, buffer);
  runPowerShell(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`);

  try {
    const sharedStringsPath = path.join(extractDir, "xl", "sharedStrings.xml");
    const workbookPath = path.join(extractDir, "xl", "workbook.xml");
    const relsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
    const sharedStrings = fs.existsSync(sharedStringsPath)
      ? Array.from(
          fs.readFileSync(sharedStringsPath, "utf8").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g),
          (match) => decodeXmlEntities(match[1])
        )
      : [];
    const workbookXml = fs.readFileSync(workbookPath, "utf8");
    const relsXml = fs.readFileSync(relsPath, "utf8");
    const sheets = Array.from(
      workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g),
      (match) => ({ name: match[1], relId: match[2] })
    );

    return sheets
      .map((entry) => {
        const relMatch = relsXml.match(
          new RegExp(`<Relationship[^>]*Id="${entry.relId}"[^>]*Target="([^"]+)"`)
        );
        if (!relMatch) {
          return null;
        }

        const worksheetPath = path.join(
          extractDir,
          "xl",
          relMatch[1].replace(/\//g, path.sep)
        );
        if (!fs.existsSync(worksheetPath)) {
          return null;
        }

        return {
          name: entry.name,
          relId: entry.relId,
          xml: fs.readFileSync(worksheetPath, "utf8"),
          sharedStrings,
        };
      })
      .filter(Boolean);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractScfsFromUpload(fileName, base64Content) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const buffer = Buffer.from(String(base64Content || ""), "base64");

  if (extension === ".json") {
    const parsed = JSON.parse(buffer.toString("utf8"));
    const source = Array.isArray(parsed) ? parsed : parsed.items || [];
    return Array.from(new Set(source.map((entry) => normalizeScf(entry.scf || entry)).filter(Boolean)));
  }

  if (extension === ".csv" || extension === ".txt" || extension === ".pdf") {
    return extractScfsFromText(buffer.toString("latin1"));
  }

  if (extension === ".xlsx" || extension === ".xlsm") {
    return parseXlsxScfs(buffer);
  }

  throw new Error(`Unsupported file type: ${extension || "unknown"}`);
}

function extractReferenceListEntriesFromUpload(fileName, base64Content, listType = "") {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const buffer = Buffer.from(String(base64Content || ""), "base64");
  const normalizedType = String(listType || "").trim().toLowerCase();

  if (extension === ".json") {
    const parsed = JSON.parse(buffer.toString("utf8"));
    const source = Array.isArray(parsed) ? parsed : parsed.items || [];
    if (normalizedType === "nhcl" || normalizedType === "rfc") {
      return source
        .map((entry) => {
          if (typeof entry === "string") {
            return { scf: normalizeScf(entry), state: "" };
          }
          return {
            scf: normalizeScf(entry.scf || entry.code || ""),
            state: normalizeState(entry.state || entry.scope || ""),
          };
        })
        .filter((entry) => entry.scf);
    }

    return extractScfsFromUpload(fileName, base64Content).map((scf) => ({ scf, state: "" }));
  }

  if (extension === ".csv" || extension === ".txt") {
    const lines = buffer.toString("latin1").split(/\r?\n/);
    if (normalizedType === "nhcl" || normalizedType === "rfc") {
      return lines
        .map((line) => {
          const [rawScf, rawState] = line
            .split(/,|\t/)
            .map((item) => item.replace(/^"|"$/g, "").trim());
          const scf = normalizeScf(rawScf);
          if (!scf) {
            return null;
          }
          return { scf, state: normalizeState(rawState) };
        })
        .filter(Boolean);
    }

    return extractScfsFromText(buffer.toString("latin1")).map((scf) => ({ scf, state: "" }));
  }

  if (extension === ".xlsx" || extension === ".xlsm") {
    if (normalizedType === "nhcl") {
      return parseXlsxScfStateRows(buffer, "Sheet1");
    }
    if (normalizedType === "rfc") {
      return parseXlsxScfStateRows(buffer, "Combined SCF for Data Team");
    }
    return parseXlsxScfs(buffer).map((scf) => ({ scf, state: "" }));
  }

  if (extension === ".pdf") {
    if (normalizedType === "nhcl" || normalizedType === "rfc") {
      throw new Error(`Use XLSX upload for ${normalizedType.toUpperCase()} list imports.`);
    }
    return extractScfsFromUpload(fileName, base64Content).map((scf) => ({ scf, state: "" }));
  }

  throw new Error(`Unsupported file type: ${extension || "unknown"}`);
}

function importReferenceList({ listType, fileName, base64Content, actor = DEFAULT_ACTOR }) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    throw new Error("Reference list type must be dnm, nhcl, or rfc.");
  }

  const entries = extractReferenceListEntriesFromUpload(fileName, base64Content, normalizedType);
  const payload = readReferenceLists();
  const list = payload.lists.find((entry) => entry.type === normalizedType);
  if (!list) {
    throw new Error(`Reference list not found: ${normalizedType}`);
  }
  const beforeItems = normalizeReferenceListSnapshotItems(list.items);

  list.sourceName = normalizeReferenceListSourceName(fileName);
  const normalizedEntries = [];
  const seenScfs = new Set();
  const dnmLookup = getReferenceListLookup("dnm");
  let skippedDuplicateCount = 0;
  let skippedDoNotMailCount = 0;
  entries.forEach((entry) => {
    const scf = normalizeScf(entry.scf);
    const state = normalizeState(entry.state);
    if (!scf) {
      return;
    }

    if (seenScfs.has(scf)) {
      skippedDuplicateCount += 1;
      return;
    }

    if (normalizedType !== "dnm" && dnmLookup.has(scf)) {
      skippedDoNotMailCount += 1;
      return;
    }

    seenScfs.add(scf);
    normalizedEntries.push({
      scf,
      state,
      scope: state,
      addedAt: new Date().toISOString(),
      addedBy: actor,
      reason: `Imported from ${fileName}`,
      sourceAnalysis: "reference-upload",
    });
  });
  list.items = normalizedEntries;
  const changedAt = new Date().toISOString();
  payload.updatedAt = changedAt;
  recordReferenceListHistory(payload, {
    listType: normalizedType,
    actionType: "import-replace",
    actor: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
    sourceName: normalizeReferenceListSourceName(fileName),
    reason: `Imported from ${fileName}`,
    changedAt,
    beforeItems,
    afterItems: normalizeReferenceListSnapshotItems(list.items),
    metadata: {
      fileName,
      skippedDuplicateCount,
      skippedDoNotMailCount,
    },
  });
  writeReferenceLists(payload);

  const addedCount = normalizedEntries.length;
  return {
    listType: normalizedType,
    fileName,
    addedCount,
    skippedDuplicateCount,
    skippedDoNotMailCount,
    totalSavedCount: list.items.length,
  };
}

function updateRunArtifactsAndSummary(run) {
  run.summary = summarizeRun(run);
  run.artifacts = writeAnalysisArtifacts(run);
}

function addScfAction(runId, actionRequest = {}) {
  const runs = readAnalysisRuns();
  const run = runs.find((entry) => entry.id === runId);
  if (!run) {
    throw new Error("Analysis run not found.");
  }

  const scf = normalizeScf(actionRequest.scf);
  if (!scf) {
    throw new Error("A valid 3-digit SCF is required.");
  }

  const actor = String(actionRequest.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const action = String(actionRequest.action || "").trim().toLowerCase();
  const targetList = String(actionRequest.targetList || "").trim().toLowerCase();
  const reason = String(actionRequest.reason || "").trim();
  const sourceAnalysis = String(actionRequest.sourceAnalysis || run.runName).trim();

  if (action === "ignore") {
    run.scfActions.unshift({
      scf,
      action,
      targetList: "",
      reason,
      actor,
      sourceAnalysis,
      createdAt: new Date().toISOString(),
    });
    updateRunArtifactsAndSummary(run);
    writeAnalysisRuns(runs);
    return serializeAnalysisRun(run);
  }

  if (action === "candidate") {
    const payload = readReferenceLists();
    const candidateList = payload.lists.find((entry) => entry.type === "candidate");
    if (!candidateList.items.some((entry) => entry.scf === scf)) {
      candidateList.items.unshift({
        scf,
        addedAt: new Date().toISOString(),
        addedBy: actor,
        reason,
        sourceAnalysis,
      });
      payload.updatedAt = new Date().toISOString();
      writeReferenceLists(payload);
    }
    run.scfActions.unshift({
      scf,
      action,
      targetList: "candidate",
      reason,
      actor,
      sourceAnalysis,
      createdAt: new Date().toISOString(),
    });
    updateRunArtifactsAndSummary(run);
    writeAnalysisRuns(runs);
    return serializeAnalysisRun(run);
  }

  if (action === "add") {
    if (!["nhcl", "rfc"].includes(targetList)) {
      throw new Error("Target list must be NHCL or RFC.");
    }

    if (isDoNotMailScf(scf)) {
      run.scfActions.unshift({
        scf,
        action: "blocked",
        targetList,
        reason: reason || "Blocked by Do Not Mail list.",
        actor,
        sourceAnalysis,
        createdAt: new Date().toISOString(),
      });
      updateRunArtifactsAndSummary(run);
      writeAnalysisRuns(runs);
      throw new Error("This SCF is marked Do Not Mail and cannot be added.");
    }

    const payload = readReferenceLists();
    const list = payload.lists.find((entry) => entry.type === targetList);
    if (list.items.some((entry) => entry.scf === scf)) {
      throw new Error(`SCF ${scf} already exists in ${targetList.toUpperCase()}.`);
    }

    list.items.unshift({
      scf,
      addedAt: new Date().toISOString(),
      addedBy: actor,
      reason,
      sourceAnalysis,
    });
    payload.updatedAt = new Date().toISOString();
    writeReferenceLists(payload);
    run.scfActions.unshift({
      scf,
      action,
      targetList,
      reason,
      actor,
      sourceAnalysis,
      createdAt: new Date().toISOString(),
    });
    updateRunArtifactsAndSummary(run);
    writeAnalysisRuns(runs);
    return serializeAnalysisRun(run);
  }

  throw new Error(`Unsupported SCF action: ${action}`);
}

function saveComparison(runId, comparisonRequest) {
  const runs = readAnalysisRuns();
  const run = runs.find((entry) => entry.id === runId);
  if (!run) {
    throw new Error("Analysis run not found.");
  }

  const reportA = run.reportPulls.find((entry) => entry.id === comparisonRequest.reportAId);
  const reportB = run.reportPulls.find((entry) => entry.id === comparisonRequest.reportBId);
  if (!reportA || !reportB) {
    throw new Error("Both reports must be selected for comparison.");
  }

  const normalizedRequest = {
    id: comparisonRequest.id || `comparison_${Date.now()}`,
    reportAId: reportA.id,
    reportBId: reportB.id,
    comparisonName: String(comparisonRequest.comparisonName || comparisonRequest.label || "").trim(),
    matchField: String(comparisonRequest.matchField || "SCF").trim() || "SCF",
    metricColumns: ensureArray(comparisonRequest.metricColumns)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  };
  const comparison = buildComparison(reportA, reportB, normalizedRequest);
  run.comparisons.unshift(comparison);
  updateRunArtifactsAndSummary(run);
  writeAnalysisRuns(runs);
  return serializeAnalysisRun(run);
}

function getAnalysisArtifactPath(runId, fileName) {
  return null;
}

function getAnalysisReportExportPath(reportId) {
  const report = readAnalysisReports().find((entry) => entry.id === reportId);
  if (!report) {
    return null;
  }

  const exportFile = writeAnalysisReportExport(
    report.report_name || "analysis-report",
    ensureArray(report.columns),
    ensureArray(report.rows),
    report.id,
    {
      exportColumns: ensureArray(report.exportColumns),
      exportRows: ensureArray(report.exportRows),
      parameters: report.parameters || {},
    }
  );

  return {
    fileName: exportFile.fileName,
    filePath: exportFile.filePath,
    contentType: exportFile.contentType,
  };
}

module.exports = {
  DEFAULT_REPORT_ID,
  initializeAnalysisStatePersistence,
  addDnmStateGroup,
  addScfAction,
  addReferenceListItems,
  archiveAnalysisSetup,
  createAnalysisRun,
  deleteAnalysisReport,
  deleteAnalysisReports,
  deleteAnalysisSetup,
  deleteAnalysisComparisonSetup,
  deleteAnalysisRun,
  undoLatestCompletedAnalysis,
  compareAnalysisReports,
  getAnalysisArtifactPath,
  getAnalysisReport,
  getAnalysisReportRateDebug,
  getAnalysisReportScfMetrics,
  getAnalysisReportExportPath,
  getAnalysisRun,
  getAnalysisSetup,
  getAnalysisSetupReviewDebug,
  getAnalysisComparisonSetup,
  getAnalysisComparisonSetups,
  getReferenceListByType,
  importReferenceList,
  isDoNotMailScf,
  listAnalysisReports,
  listAnalysisRuns,
  listAnalysisSetups,
  listReferenceLists,
  normalizeScf,
  buildAnalysisOverwriteProtection,
  buildAnalysisReportName,
  choosePreferredAnalysisScfRow,
  mergeAnalysisMetricRowsPreferNonZero,
  buildPersistedComparisonSetups,
  renameAnalysisReport,
  rebuildAnalysisReport,
  removeDnmStateGroup,
  removeReferenceListItem,
  writeReferenceListExport,
  saveAnalysisSetup,
  saveComparison,
};
