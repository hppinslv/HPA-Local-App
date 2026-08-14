const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");
const { DEFAULT_BILL_SETTINGS, calculateBillDates, normalizeSettings } = require("./billDateService");

const DEFAULT_ACTOR = "HPA User";
const BILL_DATA_DIR = process.env.HPA_BILL_DATA_DIR
  ? path.resolve(process.env.HPA_BILL_DATA_DIR)
  : path.join(__dirname, "..", "data");
const BILL_RUNS_PATH = path.join(BILL_DATA_DIR, "bill-runs.json");
const BILL_SETTINGS_PATH = path.join(BILL_DATA_DIR, "bill-settings.json");
const BILL_RUNS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-bill-runs.json");
const BILL_SETTINGS_FALLBACK_PATH = path.join(os.tmpdir(), "hpa-bill-settings.json");
const BILL_RUNS_SUPABASE_KEY = "bill-runs.json";
const BILL_SETTINGS_SUPABASE_KEY = "bill-settings.json";

const BILL_WORKFLOW_STAGES = Object.freeze([
  "Create Monthly Run",
  "Pull Bill 2 Correction Records",
  "Correct Bill 2 Payment Method",
  "Upload Bill 2 Corrections to Salesforce",
  "Pull Bill 4 Correction Records",
  "Correct Bill 4 Coverage Values",
  "Upload Bill 4 Corrections to Salesforce",
  "Pull Bill 1-4 Report Data",
  "Validate Bill Data",
  "Generate Bill Documents",
  "Review and Approve",
  "Download / Print",
  "Complete Run",
]);

const BILL_STATUSES = Object.freeze([
  "Draft",
  "Pulling Data",
  "Correction Review Required",
  "Ready for Salesforce Update",
  "Updating Salesforce",
  "Salesforce Update Partially Failed",
  "Corrections Complete",
  "Bill Data Ready",
  "Validation Failed",
  "Ready to Generate",
  "Documents Generated",
  "Pending Approval",
  "Approved",
  "Downloaded",
  "Completed",
  "Cancelled",
]);

let billRunsDiskWritable = true;
let billRunsCache = [];
let billSettingsCache = normalizeSettings(DEFAULT_BILL_SETTINGS);
let billPersistenceReady = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return clone(fallbackValue);
  }
}

function persistJsonFile(filePath, payload) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    console.warn(`Unable to persist bill state file ${filePath}:`, error.message);
    return false;
  }
}

function writeBillRuns(runs) {
  billRunsCache = clone(Array.isArray(runs) ? runs : []);
  const savedPrimary = persistJsonFile(BILL_RUNS_PATH, billRunsCache);
  if (!savedPrimary) {
    billRunsDiskWritable = false;
    persistJsonFile(BILL_RUNS_FALLBACK_PATH, billRunsCache);
  }
  queueStateSync(BILL_RUNS_SUPABASE_KEY, billRunsCache);
}

function writeBillSettings(settings) {
  billSettingsCache = normalizeSettings(settings);
  const savedPrimary = persistJsonFile(BILL_SETTINGS_PATH, billSettingsCache);
  if (!savedPrimary) {
    billRunsDiskWritable = false;
    persistJsonFile(BILL_SETTINGS_FALLBACK_PATH, billSettingsCache);
  }
  queueStateSync(BILL_SETTINGS_SUPABASE_KEY, billSettingsCache);
}

function readBillRuns() {
  if (Array.isArray(billRunsCache) && billRunsCache.length) {
    return clone(billRunsCache);
  }
  const local = safeParseJson(BILL_RUNS_PATH, safeParseJson(BILL_RUNS_FALLBACK_PATH, []));
  billRunsCache = Array.isArray(local) ? local : [];
  return clone(billRunsCache);
}

function readBillSettings() {
  const local = safeParseJson(
    BILL_SETTINGS_PATH,
    safeParseJson(BILL_SETTINGS_FALLBACK_PATH, normalizeSettings(DEFAULT_BILL_SETTINGS))
  );
  billSettingsCache = normalizeSettings(local);
  return clone(billSettingsCache);
}

function isActiveRunStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized && normalized !== "completed" && normalized !== "cancelled";
}

function buildRunId() {
  return `bill_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildEventId() {
  return `bill_event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBillMonth(value) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw new Error("Bill month must use YYYY-MM format.");
  }
  return normalized;
}

function buildRunCode(billMonth, revisionNumber = 1) {
  const normalizedMonth = normalizeBillMonth(billMonth);
  const baseCode = `BILL-${normalizedMonth}`;
  return revisionNumber > 1 ? `${baseCode}-R${revisionNumber}` : baseCode;
}

function getNextRevisionNumber(runs, billMonth) {
  const normalizedMonth = normalizeBillMonth(billMonth);
  const matching = ensureArray(runs).filter((run) => String(run.billMonth || "").trim() === normalizedMonth);
  return matching.length + 1;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function appendRunEvent(run, eventType, details = {}, actor = DEFAULT_ACTOR) {
  const event = {
    id: buildEventId(),
    eventType,
    previousStatus: details.previousStatus || "",
    newStatus: details.newStatus || "",
    details,
    performedBy: String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
    performedAt: new Date().toISOString(),
  };
  run.events = ensureArray(run.events);
  run.events.push(event);
  return event;
}

function createStageStates() {
  return BILL_WORKFLOW_STAGES.map((stage, index) => ({
    key: `stage_${index + 1}`,
    title: stage,
    status: index === 0 ? "current" : "pending",
  }));
}

function summarizeRun(run) {
  return {
    id: run.id,
    runCode: run.runCode,
    billMonth: run.billMonth,
    processingDate: run.processingDate,
    scheduledProcessingDate: run.scheduledProcessingDate,
    status: run.status,
    approvalStatus: run.approvalStatus,
    generationStatus: run.generationStatus,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    activeStage: run.activeStage,
    duplicateOverrideReason: run.duplicateOverrideReason || "",
  };
}

function getRunIndex(runs, runId) {
  return runs.findIndex((run) => String(run.id || "").trim() === String(runId || "").trim());
}

function getBillSettings() {
  return readBillSettings();
}

function saveBillSettings(input = {}) {
  const nextSettings = normalizeSettings({
    ...readBillSettings(),
    ...input,
  });
  writeBillSettings(nextSettings);
  return nextSettings;
}

function listBillRuns(filters = {}) {
  const runs = readBillRuns()
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const billMonth = String(filters.billMonth || "").trim();
  if (!billMonth) {
    return runs.map(summarizeRun);
  }
  return runs
    .filter((run) => String(run.billMonth || "").trim() === billMonth)
    .map(summarizeRun);
}

function findActiveRunConflict(runs, billMonth) {
  return ensureArray(runs).find(
    (run) => String(run.billMonth || "").trim() === billMonth && isActiveRunStatus(run.status)
  ) || null;
}

function createBillRun(input = {}) {
  const runs = readBillRuns();
  const settings = readBillSettings();
  const billMonth = normalizeBillMonth(input.billMonth);
  const createdBy = String(input.createdBy || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const dates = calculateBillDates(billMonth, settings);
  const requestedProcessingDate = String(input.scheduledProcessingDate || dates.processingDate).trim() || dates.processingDate;
  const existingConflict = findActiveRunConflict(runs, billMonth);
  const allowDuplicate = Boolean(input.allowDuplicateOverride);
  const overrideReason = String(input.duplicateOverrideReason || "").trim();

  if (existingConflict && !allowDuplicate) {
    const error = new Error(`An active bill run already exists for ${billMonth}.`);
    error.code = "duplicate_active_run";
    error.conflict = summarizeRun(existingConflict);
    throw error;
  }

  if (existingConflict && allowDuplicate && !overrideReason) {
    throw new Error("A duplicate run override reason is required.");
  }

  const revisionNumber = getNextRevisionNumber(runs, billMonth);
  const run = {
    id: buildRunId(),
    runCode: buildRunCode(billMonth, revisionNumber),
    billMonth,
    processingDate: dates.processingDate,
    scheduledProcessingDate: requestedProcessingDate,
    createdBy,
    notes: String(input.notes || "").trim(),
    status: "Draft",
    correctionStatus: "Draft",
    generationStatus: "Draft",
    approvalStatus: "Draft",
    versionNumber: 1,
    duplicateOverrideReason: overrideReason,
    activeStage: BILL_WORKFLOW_STAGES[0],
    stages: createStageStates(),
    dates,
    counts: {
      bill1: 0,
      bill2: 0,
      bill3: 0,
      bill4: 0,
      bill3Notices: 0,
      bill4Notices: 0,
      totalDocuments: 0,
      totalRecipients: 0,
      validationErrors: 0,
    },
    corrections: {
      bill2: [],
      bill4: [],
    },
    validations: [],
    documents: [],
    approvals: [],
    sourceSnapshotTimestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  };

  appendRunEvent(
    run,
    existingConflict ? "duplicate-run-created" : "run-created",
    {
      previousStatus: "",
      newStatus: run.status,
      billMonth,
      runCode: run.runCode,
      duplicateOverrideReason: overrideReason,
    },
    createdBy
  );
  runs.push(run);
  writeBillRuns(runs);
  return clone(run);
}

function getBillRun(runId) {
  const run = readBillRuns().find((entry) => String(entry.id || "").trim() === String(runId || "").trim());
  if (!run) {
    throw new Error("Bill run not found.");
  }
  return clone(run);
}

function updateBillRun(runId, changes = {}) {
  const runs = readBillRuns();
  const index = getRunIndex(runs, runId);
  if (index === -1) {
    throw new Error("Bill run not found.");
  }

  const run = runs[index];
  const actor = String(changes.actor || changes.updatedBy || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const previousStatus = run.status;

  if (changes.status) {
    const nextStatus = String(changes.status || "").trim();
    if (!BILL_STATUSES.includes(nextStatus)) {
      throw new Error("Invalid bill run status.");
    }
    run.status = nextStatus;
  }
  if (changes.activeStage) {
    run.activeStage = String(changes.activeStage || "").trim() || run.activeStage;
    run.stages = ensureArray(run.stages).map((stage) => ({
      ...stage,
      status:
        stage.title === run.activeStage
          ? "current"
          : BILL_WORKFLOW_STAGES.indexOf(stage.title) < BILL_WORKFLOW_STAGES.indexOf(run.activeStage)
            ? "complete"
            : "pending",
    }));
  }
  if (typeof changes.notes === "string") {
    run.notes = changes.notes.trim();
  }
  if (changes.approvalStatus) {
    run.approvalStatus = String(changes.approvalStatus).trim();
  }
  if (changes.generationStatus) {
    run.generationStatus = String(changes.generationStatus).trim();
  }
  if (changes.correctionStatus) {
    run.correctionStatus = String(changes.correctionStatus).trim();
  }
  if (changes.corrections && typeof changes.corrections === "object") {
    run.corrections = { ...run.corrections, ...clone(changes.corrections) };
  }
  if (changes.counts && typeof changes.counts === "object") {
    run.counts = { ...run.counts, ...clone(changes.counts) };
  }
  run.updatedAt = new Date().toISOString();
  appendRunEvent(
    run,
    "run-updated",
    {
      previousStatus,
      newStatus: run.status,
      activeStage: run.activeStage,
      notesUpdated: typeof changes.notes === "string",
    },
    actor
  );
  writeBillRuns(runs);
  return clone(run);
}

function deleteBillRun(runId, actor = DEFAULT_ACTOR) {
  const runs = readBillRuns();
  const index = getRunIndex(runs, runId);
  if (index === -1) {
    throw new Error("Bill run not found.");
  }

  const run = runs[index];
  const performedBy = String(actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const deletedRun = clone(run);
  appendRunEvent(
    deletedRun,
    "run-deleted",
    {
      previousStatus: run.status || "",
      newStatus: "Deleted",
      runCode: run.runCode || "",
    },
    performedBy
  );
  runs.splice(index, 1);
  writeBillRuns(runs);
  return {
    deletedRun,
    runs: runs.map(summarizeRun),
  };
}

function getBillDashboard() {
  const runs = readBillRuns();
  const settings = readBillSettings();
  const activeRuns = runs.filter((run) => isActiveRunStatus(run.status));
  const latestRun = runs
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;

  return {
    summary: {
      totalRuns: runs.length,
      activeRuns: activeRuns.length,
      completedRuns: runs.filter((run) => String(run.status || "").trim() === "Completed").length,
      pendingApprovalRuns: runs.filter((run) => String(run.status || "").trim() === "Pending Approval").length,
    },
    latestRun: latestRun ? summarizeRun(latestRun) : null,
    activeRuns: activeRuns.map(summarizeRun),
    settings,
    workflowStages: BILL_WORKFLOW_STAGES,
    statuses: BILL_STATUSES,
  };
}

async function initializeBillRunPersistence() {
  if (billPersistenceReady) {
    return;
  }
  billPersistenceReady = true;

  ensureDir(BILL_DATA_DIR);
  const [remoteRuns, remoteSettings] = await Promise.all([
    loadStateObject(BILL_RUNS_SUPABASE_KEY, safeParseJson(BILL_RUNS_PATH, [])),
    loadStateObject(BILL_SETTINGS_SUPABASE_KEY, safeParseJson(BILL_SETTINGS_PATH, normalizeSettings(DEFAULT_BILL_SETTINGS))),
  ]);

  billRunsCache = Array.isArray(remoteRuns) ? remoteRuns : [];
  billSettingsCache = normalizeSettings(remoteSettings);
  writeBillRuns(billRunsCache);
  writeBillSettings(billSettingsCache);
}

module.exports = {
  BILL_STATUSES,
  BILL_WORKFLOW_STAGES,
  buildRunCode,
  createBillRun,
  deleteBillRun,
  getBillDashboard,
  getBillRun,
  getBillSettings,
  initializeBillRunPersistence,
  listBillRuns,
  saveBillSettings,
  updateBillRun,
};
