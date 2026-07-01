"use strict";

const UI = {
  navButtons: ".nav-link",
  reportTypeButtons: '[data-report-picker]',
};

const MONTHLY_REPORT_LABELS = {
  "transaction-summary": "Transaction Summary",
  "transaction-detail": "Transaction Detail",
  "amalgamated-premium-remittance": "Amalgamated Remittance",
  "final-summary-letter": "Final Summary Letter",
};

const MONTHLY_ALL_REPORT_LABEL = "All Reports";
const MONTHLY_RUN_BUTTON_TYPES = [
  "transaction-summary",
  "transaction-detail",
  "amalgamated-premium-remittance",
];
const MONTHLY_SELECTABLE_REPORT_TYPES = [
  ...MONTHLY_RUN_BUTTON_TYPES,
  "final-summary-letter",
];
const MONTHLY_ALL_REPORT_TYPES = [
  "transaction-summary",
  "transaction-detail",
  "amalgamated-premium-remittance",
  "final-summary-letter",
];
const MONTHLY_STALE_RUN_MS = 10 * 60 * 1000;
const SCORE_HISTORY_DEFAULT_DAY_RANGE = 30;
const SCORE_HISTORY_VISIBLE_PERIODS = ["Current Month", "Last Month", "Last Year"];
const SCORE_HISTORY_VISIBLE_PAYMENT_TYPES = ["ACH", "Credit Card", "Check"];

const DEFAULT_ANALYSIS_REPORT_ID = "00OQm000003PIxhMAG";
const ANALYSIS_CONVERTED_RATE_PREMIUM_BASIS = 14.86;
const ANALYSIS_SETUP_STORAGE_KEY = "hpa.analysis.currentSetupId";
const ANALYSIS_SETUP_DRAFT_STORAGE_KEY = "hpa.analysis.currentSetupDraft";
const ANALYSIS_KEY_CODE_GROUPS = ["NHCL", "RFC"];
const ANALYSIS_KEY_CODE_OPTIONS = [
  { value: "N", label: "N" },
  { value: "RFC", label: "RFC" },
  { value: "N,RFC", label: "N + RFC" },
];
const APPLICATION_DEFAULTS = Object.freeze({
  dues: "19.95",
  freeCoverageAmount: "3000",
  onePersonPer1000: "0.22",
  twoPersonPer1000: "0.33",
});
const UI_STATE_STORAGE_KEY = "hpa.ui.currentState";
const ACH_RETURN_DRAFT_STORAGE_KEY = "hpa.achReturns.currentDraft";
const MAILING_DATA_HISTORY_STORAGE_KEY = "hpa.mailingData.history";
const COMPARISON_DEBUG_QUERY_PARAM = "debugComparisonPicker";
const ANALYSIS_REVIEW_POPUP_QUERY_PARAM = "analysisReviewPopup";
const IMPORT_SESSION_POPUP_QUERY_PARAM = "importSessionPopup";
const ANALYSIS_REVIEW_SYNC_CHANNEL_NAME = "hpa-analysis-review-sync-v1";
const ANALYSIS_REVIEW_SYNC_STORAGE_KEY = "hpa.analysis.review.syncState";
const ANALYSIS_HISTORY_VISIBLE_FROM = "2026-06-15T00:00:00.000Z";
let comparisonSetupAutosaveHandle = null;
let comparisonSetupAutosaveInFlight = null;
let analysisReviewPopupWindowRef = null;

function getDefaultAnalysisName() {
  return new Date().toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

const state = {
  route: "dashboard",
  analysis: {
    panel: "home",
    subtab: "runs",
    mailingListType: "dnm",
    navExpanded: true,
    search: "",
    runName: "",
    runNotes: "",
    currentSetupId: "",
    currentSetupStatus: "",
    currentRunId: "",
    currentReportId: "",
    runPollHandle: null,
    resultMode: "",
    resultRun: null,
    resultReport: null,
    tableSorts: {},
    reportPulls: [],
    comparisonRequests: [],
    comparisonLinks: [],
    comparisonResults: [],
    savedReports: [],
    selectedComparisonId: "",
    lastEditedComparisonId: "",
    reviewTableSort: { key: "soldRate", direction: "desc" },
    reviewSoldRateOperator: ">",
    reviewSoldRateMin: "",
    reviewInForceRateOperator: ">",
    reviewInForceRateValue: "",
    reviewConvertedRateOperator: "!=",
    reviewConvertedRateValue: "",
    reviewMailedOperator: ">",
    reviewMailedMin: "",
    reviewBulkMetric: "soldRate",
    reviewBulkThresholdValue: "",
    reviewBulkPreview: null,
    reviewPageSize: 100,
    reviewPageNumber: 1,
    selectedNavigatorScfs: [],
    activeNavigatorScfFilter: [],
    reviewPrimaryReportIds: {},
    reviewSelectedScfs: {},
    reviewExcludedScfs: {},
    reviewBaselineLists: [],
    reviewWorkingLists: [],
    reviewZeroRateRemovals: [],
    reviewZeroRemovalDiagnostics: null,
    reviewSummary: null,
    reviewSummaryMode: "review",
    reviewSummaryNotes: "",
    reviewSummaryApproved: false,
    reviewCompletedByName: "",
    reviewCompletedOnDate: "",
    readOnlyReview: false,
    reviewSyncVersion: 0,
    reportScfMetricCache: {},
    editingReportId: "",
    editingReportTitle: "",
    selectedReportIds: [],
    collapsedPullIds: {},
    setupHydrated: false,
    lastSetupLoadSource: "",
    reviewFloatingPanel: {
      x: 16,
      y: 16,
    },
    mailingListViewTab: "current",
    mailingListHistoryPreview: null,
  },
  monthly: {
    reportType: "transaction-summary",
    reportRunMode: "single",
    runAllMonitorHandle: null,
    runAllIds: [],
    singleRunMonitorHandle: null,
    singleRunId: "",
    refreshOutput: null,
  },
  scoreHistory: {
    latest: null,
    rows: [],
    trendRows: [],
    config: null,
    options: null,
    auth: null,
    selectedSnapshotDate: "",
    filters: {
      from: "",
      to: "",
      reportKey: "",
      scorePeriod: "",
      paymentType: "",
      metricKey: "",
    },
  },
  applications: {
    list: [],
    current: null,
    selectedId: "",
    previewVisible: false,
    showAlignmentBoxes: false,
    loaded: false,
  },
  ccPayments: {
    templates: [],
    selectedTemplateKey: "",
    sessions: [],
    currentSessionId: "",
    currentSession: null,
    filter: "all",
    popup: false,
    launchSessionId: "",
  },
  checkImports: {
    templates: [],
    selectedTemplateKey: "",
    sessions: [],
    currentSessionId: "",
    currentSession: null,
    selectedRowIds: [],
    filter: "all",
    popup: false,
    launchSessionId: "",
  },
  achReturns: {
    sessions: [],
    currentSessionId: "",
    currentSession: null,
    draft: null,
    emailBody: "",
  },
  mailingData: {
    fileSlots: [
      { fileName: "", base64Content: "" },
      { fileName: "", base64Content: "" },
    ],
    mailingMonth: "",
    startingCaseNumber: "",
    nextCaseNumber: "",
    preview: null,
    history: [],
  },
  referenceLists: [],
};

const setStatus = (id, message) => {
  const el = document.getElementById(id);
  if (el) el.textContent = message || "";
};

const el = (id) => document.getElementById(id);
const all = (selector) => Array.from(document.querySelectorAll(selector));
const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const cloneData = (value) => JSON.parse(JSON.stringify(value));
const ensureArray = (value) => (Array.isArray(value) ? value : []);
const buildAchRefundName = (certificateNumber, processedAt = new Date().toISOString()) =>
  `${String(certificateNumber || "").trim() || "-"} - ACH - Returned Check - ${formatShortDate(processedAt) || formatShortDate(new Date().toISOString())}`;
const comparisonDebugEnabled = (() => {
  try {
    return new URLSearchParams(window.location.search).get(COMPARISON_DEBUG_QUERY_PARAM) === "1";
  } catch {
    return false;
  }
})();
let comparisonDebugLogContainer = null;
let comparisonDebugAutoTestRan = false;
let comparisonDebugListenersBound = false;

function logComparisonDebug(...parts) {
  if (!comparisonDebugEnabled) {
    return;
  }
  console.log(...parts);
  if (!(comparisonDebugLogContainer instanceof HTMLElement)) {
    return;
  }
  const line = parts
    .map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
  comparisonDebugLogContainer.textContent += `${line}\n`;
}

function getSelectedAnalysisReportIds() {
  return Array.isArray(state.analysis.selectedReportIds)
    ? state.analysis.selectedReportIds
    : [];
}

function setSelectedAnalysisReportIds(nextIds) {
  state.analysis.selectedReportIds = Array.from(
    new Set(
      ensureArray(nextIds)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    )
  );
}

const normalizeScf = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.slice(-3).padStart(3, "0");
};

const normalizeState = (value) => String(value || "").trim().toUpperCase();

const normalizeIsoDateInput = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const slashIsoMatch = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashIsoMatch) {
    const [, year, month, day] = slashIsoMatch;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return raw;
};

const createClientId = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const formatDate = (value) => {
  if (!value) return "Not set";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatShortDate = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
};

const formatDateOnly = (value) => {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

const getTodayIsoDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const formatCurrencyValue = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "-";
  }
  return numericValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
};

const formatScoreMetricValue = (metricKey, value) => {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (["amount", "total_premium_with_dues"].includes(String(metricKey || "").trim())) {
    return formatCurrencyValue(value);
  }
  if (["active_clients", "record_count"].includes(String(metricKey || "").trim())) {
    return formatWholeNumber(value);
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return esc(String(value));
  }
  return numericValue.toLocaleString("en-US");
};

const formatReportDateStamp = (value) => {
  const d = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${safeDate.getFullYear()}.${String(safeDate.getMonth() + 1).padStart(2, "0")}.${String(safeDate.getDate()).padStart(2, "0")}`;
};

const formatReportRunDateLabel = (value) => {
  const d = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${String(safeDate.getMonth() + 1).padStart(2, "0")}/${String(safeDate.getDate()).padStart(2, "0")}/${safeDate.getFullYear()}`;
};

function resolveAnalysisReportTitlePrefix(value = "") {
  const normalizedValues = ensureArray(value)
    .flatMap((entry) => String(entry || "").split(/[,\n]/))
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter(Boolean)
    .map((entry) => entry === "NHCL" ? "N" : entry);
  const uniqueValues = Array.from(new Set(normalizedValues));
  if (uniqueValues.includes("N") && uniqueValues.includes("RFC")) {
    return "New Home + Refinance";
  }
  const normalized = uniqueValues[0] || "";
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

function getAnalysisReportDisplayName(report) {
  const parameters = report?.parameters || {};
  const derivedLabel = buildAnalysisTitleLabel(
    getAnalysisReportKeyCodeGroup(report) || report?.clientType || parameters.client_type || "",
    parameters.start_date || parameters.startDate || report?.dateRange?.startDate || "",
    parameters.end_date || parameters.endDate || report?.dateRange?.endDate || "",
    report?.created_at || report?.createdAt || ""
  );
  if (derivedLabel) {
    return derivedLabel;
  }

  const rawName = String(report?.report_name || report?.reportName || report?.id || "Report").trim();
  const prefixMatch = rawName.match(/^(RFC|NHCL)\b[\s-]*(.*)$/i);
  if (!prefixMatch) {
    return rawName;
  }

  const prefix = String(prefixMatch[1] || "").trim().toUpperCase();
  let remainder = String(prefixMatch[2] || "").replace(/^\s*-\s*/, "").trim();
  const runMonth = String(report?.run_month || report?.runMonth || "").trim();
  const runYear = String(report?.run_year || report?.runYear || "").trim();
  const trailingRunLabel = runMonth && runYear ? `${runMonth} ${runYear}` : "";
  if (
    trailingRunLabel &&
    remainder.toLowerCase().endsWith(trailingRunLabel.toLowerCase())
  ) {
    remainder = remainder
      .slice(0, remainder.length - trailingRunLabel.length)
      .replace(/\s*-\s*$/, "")
      .trim();
  }

  const dateStamp = formatReportDateStamp(report?.created_at || report?.createdAt || "");
  return remainder ? `${prefix} ${dateStamp} - ${remainder}` : `${prefix} ${dateStamp}`;
}

function getAnalysisReportDateRangeLabel(report) {
  const parameters = report?.parameters || {};
  const startDate = normalizeIsoDateInput(
    parameters.start_date || parameters.startDate || report?.dateRange?.startDate || ""
  );
  const endDate = normalizeIsoDateInput(
    parameters.end_date || parameters.endDate || report?.dateRange?.endDate || ""
  );

  const startLabel = formatAutoAnalysisMonthPart(startDate);
  const endLabel = formatAutoAnalysisMonthPart(endDate);
  if (startLabel && endLabel) {
    return `${startLabel} - ${endLabel}`;
  }

  return getAnalysisReportDisplayName(report);
}

const formatMonthLabel = (value) => {
  if (!value) return "previous month";
  const match = String(value).match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return String(value);
  }

  const [, yearRaw, monthRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw) - 1;
  if (!Number.isInteger(year) || month < 0 || month > 11) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month, 1)));
};

function formatAutoAnalysisMonthPart(value) {
  const normalized = normalizeIsoDateInput(value || "");
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

function buildAutoAnalysisLabel(pull = {}, index = 0) {
  const keyCodeValues = ensureArray(pull.keyCodes).length ? pull.keyCodes : [pull.clientType || ""];
  const startDate = normalizeIsoDateInput(pull.dateRange?.startDate || "");
  const endDate = normalizeIsoDateInput(pull.dateRange?.endDate || "");
  const titleLabel = buildAnalysisTitleLabel(keyCodeValues, startDate, endDate, new Date().toISOString());

  if (titleLabel) {
    return titleLabel;
  }

  const titlePrefix = resolveAnalysisReportTitlePrefix(keyCodeValues);
  if (titlePrefix) {
    return titlePrefix;
  }

  return "Choose Key Code and dates";
}

const getFilenameFromDisposition = (disposition, fallback) => {
  if (!disposition) return fallback;
  const match = disposition.match(
    /filename\*=UTF-8''([^;\n]+)|filename=\"([^\"]+)\"|filename=([^;\n]+)/i
  );
  if (!match) return fallback;
  return decodeURIComponent(match[1] || match[2] || match[3] || fallback);
};

const analysisReviewWindowId = `analysis-review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
if (!(typeof window === "undefined")) {
  if (!("analysisReviewSyncChannel" in window)) {
    window.analysisReviewSyncChannel = null;
  }
  if (!("analysisReviewSyncing" in window)) {
    window.analysisReviewSyncing = false;
  }
}

const getAnalysisReviewSyncChannel = () => {
  if (typeof window === "undefined") return null;
  if (!("analysisReviewSyncChannel" in window)) {
    window.analysisReviewSyncChannel = null;
  }
  return window.analysisReviewSyncChannel;
};

const setAnalysisReviewSyncChannel = (value) => {
  if (typeof window === "undefined") return;
  window.analysisReviewSyncChannel = value || null;
};

const isAnalysisReviewSyncing = () => {
  if (typeof window === "undefined") return false;
  return Boolean(window.analysisReviewSyncing);
};

const setAnalysisReviewSyncing = (value) => {
  if (typeof window === "undefined") return;
  window.analysisReviewSyncing = Boolean(value);
};

const apiRequest = async (url, options = {}) => {
  const init = {
    method: (options.method || "GET").toUpperCase(),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {}),
    },
  };
  if (!["GET", "HEAD"].includes(init.method)) {
    init.body = JSON.stringify(options.body || {});
  }

  const res = await fetch(url, init);
  const raw = await res.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  if (!res.ok) {
    throw new Error(payload.error || payload.message || `${res.status} ${res.statusText}`);
  }
  return payload;
};

const apiDownload = async (url, fallbackFileName) => {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    throw new Error(payload.error || payload.message || payload.raw || `${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const filename = getFilenameFromDisposition(
    res.headers.get("content-disposition"),
    fallbackFileName || "reference-list.xlsx"
  );
  const a = document.createElement("a");
  const urlObj = URL.createObjectURL(blob);
  a.href = urlObj;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(urlObj);
};

const triggerDirectDownload = (url, fallbackFileName) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  if (fallbackFileName) {
    anchor.download = fallbackFileName;
  }
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function createEmptyApplication() {
  return {
    id: "",
    customerMailingInformation: "",
    lender: "",
    coverageAmount: "",
    caseNumber: "",
    createdAt: "",
    updatedAt: "",
  };
}

function normalizeApplicationText(value) {
  return String(value || "").trim();
}

function parseApplicationNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const negativeByParens = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return negativeByParens ? -parsed : parsed;
}

function formatApplicationCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "$0.00";
  }
  return numericValue.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatApplicationWholeDollarCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "$0";
  }
  return numericValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatApplicationNumber(value, fractionDigits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "";
  }
  return numericValue.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatApplicationDate(value) {
  const normalized = normalizeIsoDateInput(value || "");
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return normalized;
  }
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

function calculateApplicationMetrics(application = {}) {
  const coverageAmount = parseApplicationNumber(application.coverageAmount);
  const dues = parseApplicationNumber(APPLICATION_DEFAULTS.dues) ?? 19.95;
  const onePersonPer1000 = parseApplicationNumber(APPLICATION_DEFAULTS.onePersonPer1000) ?? 0.22;
  const twoPersonPer1000 = parseApplicationNumber(APPLICATION_DEFAULTS.twoPersonPer1000) ?? 0.33;
  const coverageDividedBy1000 = Number.isFinite(coverageAmount) ? coverageAmount / 1000 : null;
  const coverageOverFreeBase = Number.isFinite(coverageDividedBy1000)
    ? coverageDividedBy1000 - 3
    : null;
  const onePersonPremium = Number.isFinite(coverageOverFreeBase)
    ? Number((coverageOverFreeBase * onePersonPer1000 + dues).toFixed(2))
    : null;
  const twoPersonPremium = Number.isFinite(coverageOverFreeBase)
    ? Number((coverageOverFreeBase * twoPersonPer1000 + dues).toFixed(2))
    : null;

  return {
    coverageAmount,
    dues,
    onePersonPer1000,
    twoPersonPer1000,
    freeCoverageAmount: parseApplicationNumber(APPLICATION_DEFAULTS.freeCoverageAmount) ?? 3000,
    coverageDividedBy1000,
    coverageOverFreeBase,
    onePersonPremium,
    twoPersonPremium,
  };
}

function syncApplicationCalculatedFields() {
  if (!state.applications.current) {
    state.applications.current = createEmptyApplication();
  }

  return calculateApplicationMetrics(state.applications.current);
}

function createApplicationPayload() {
  const current = state.applications.current || createEmptyApplication();
  return {
    id: current.id || "",
    customerMailingInformation: normalizeApplicationText(current.customerMailingInformation),
    lender: normalizeApplicationText(current.lender),
    coverageAmount: parseApplicationNumber(current.coverageAmount),
    caseNumber: normalizeApplicationText(current.caseNumber),
  };
}

function validateCurrentApplication() {
  const payload = createApplicationPayload();
  const errors = [];
  if (!payload.customerMailingInformation) {
    errors.push("Customer Mailing Information is required.");
  }
  if (!Number.isFinite(payload.coverageAmount)) {
    errors.push("Coverage Amount is required.");
  } else if (payload.coverageAmount < 10000 || payload.coverageAmount > 503000) {
    errors.push("Coverage Amount must be between 10,000 and 503,000.");
  } else if (payload.coverageAmount % 1000 !== 0) {
    errors.push("Coverage Amount must be in increments of 1,000.");
  }
  const metrics = calculateApplicationMetrics(payload);
  if (!Number.isFinite(metrics.onePersonPremium) || !Number.isFinite(metrics.twoPersonPremium)) {
    errors.push("Premiums must calculate before printing.");
  }
  return {
    isValid: errors.length === 0,
    errors,
  };
}

function hydrateApplicationFromServer(entry = {}) {
  state.applications.current = {
    id: String(entry.id || "").trim(),
    customerMailingInformation: String(
      entry.customer_mailing_information
      || entry.customerMailingInformation
      || ""
    ).trim(),
    lender: String(entry.lender || "").trim(),
    coverageAmount: String(entry.coverage_amount ?? entry.coverageAmount ?? ""),
    caseNumber: String(entry.case_number || entry.caseNumber || "").trim(),
    createdAt: String(entry.created_at || "").trim(),
    updatedAt: String(entry.updated_at || "").trim(),
  };
  state.applications.selectedId = state.applications.current.id || "";
  syncApplicationCalculatedFields();
}

function renderApplicationPreview() {
  const current = state.applications.current || createEmptyApplication();
  const metrics = syncApplicationCalculatedFields();
  const previewPanel = el("applications-preview-panel");
  if (previewPanel) {
    previewPanel.classList.toggle("is-hidden", !state.applications.previewVisible);
  }
  const printPage = previewPanel?.querySelector(".application-print-page");
  if (printPage instanceof HTMLElement) {
    printPage.classList.toggle("show-alignment-boxes", Boolean(state.applications.showAlignmentBoxes));
  }

  const values = {
    mailing: current.customerMailingInformation,
    lender: current.lender ? `Lender: ${current.lender}` : "",
    coverage: Number.isFinite(metrics.coverageAmount) ? formatApplicationWholeDollarCurrency(metrics.coverageAmount) : "",
    onePersonPremium: Number.isFinite(metrics.onePersonPremium) ? formatApplicationCurrency(metrics.onePersonPremium) : "",
    twoPersonPremium: Number.isFinite(metrics.twoPersonPremium) ? formatApplicationCurrency(metrics.twoPersonPremium) : "",
    caseNumber: current.caseNumber ? `Case Number: ${current.caseNumber}` : "Case Number:",
  };

  all("[data-app-print-field]").forEach((node) => {
    const key = node.getAttribute("data-app-print-field");
    node.textContent = key ? values[key] || "" : "";
  });
}

function buildApplicationPrintWindowDocument() {
  const previewRoot = document.querySelector("#applications-preview-panel .application-print-root");
  if (!(previewRoot instanceof HTMLElement)) {
    throw new Error("Application print template is not available.");
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Print Application</title>
    <link rel="stylesheet" href="./applications-print.css" />
  </head>
  <body class="application-print-window">
    <div class="applications-preview-stage">
      ${previewRoot.outerHTML}
    </div>
    <script>
      window.addEventListener("load", () => {
        window.setTimeout(() => {
          window.focus();
          window.print();
        }, 150);
      });
      window.addEventListener("afterprint", () => {
        window.close();
      });
    </script>
  </body>
</html>`;
}

function renderApplicationsList() {
  const tbody = el("applications-list-body");
  if (!tbody) {
    return;
  }

  const rows = Array.isArray(state.applications.list) ? state.applications.list : [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No saved applications yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((entry) => `
      <tr>
        <td>${esc(String(entry.customer_mailing_information || "").split(/\r?\n/)[0] || "Unnamed application")}</td>
        <td>${esc(entry.lender || "-")}</td>
        <td>${esc(formatApplicationCurrency(entry.coverage_amount || 0))}</td>
        <td>${esc(formatApplicationCurrency(entry.one_person_premium || 0))}</td>
        <td>${esc(formatApplicationCurrency(entry.two_person_premium || 0))}</td>
        <td>${esc(formatDate(entry.updated_at || entry.created_at || ""))}</td>
        <td>
          <div class="applications-row-actions">
            <button class="secondary-button" data-action="open-application" data-application-id="${esc(entry.id)}">Open</button>
            <button class="secondary-button" data-action="delete-application" data-application-id="${esc(entry.id)}">Delete</button>
          </div>
        </td>
      </tr>
    `)
    .join("");
}

function renderApplicationForm() {
  if (!state.applications.current) {
    state.applications.current = createEmptyApplication();
  }

  const current = state.applications.current;
  const metrics = syncApplicationCalculatedFields();

  all("[data-application-field]").forEach((field) => {
    const key = field.getAttribute("data-application-field");
    if (!key) return;
    const nextValue = current[key] ?? "";
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
      if (field.value !== String(nextValue)) {
        field.value = String(nextValue);
      }
    }
  });

  const coverageSummary = el("applications-summary-coverage-amount");
  if (coverageSummary) {
    coverageSummary.textContent = Number.isFinite(metrics.coverageAmount)
      ? formatApplicationCurrency(metrics.coverageAmount)
      : "$0.00";
  }
  const onePersonSummary = el("applications-summary-one-person-premium");
  if (onePersonSummary) {
    onePersonSummary.textContent = Number.isFinite(metrics.onePersonPremium)
      ? formatApplicationCurrency(metrics.onePersonPremium)
      : "$0.00";
  }
  const onePersonSidebarSummary = el("applications-summary-one-person-premium-sidebar");
  if (onePersonSidebarSummary) {
    onePersonSidebarSummary.textContent = Number.isFinite(metrics.onePersonPremium)
      ? formatApplicationCurrency(metrics.onePersonPremium)
      : "$0.00";
  }
  const twoPersonSummary = el("applications-summary-two-person-premium");
  if (twoPersonSummary) {
    twoPersonSummary.textContent = Number.isFinite(metrics.twoPersonPremium)
      ? formatApplicationCurrency(metrics.twoPersonPremium)
      : "$0.00";
  }
  const twoPersonSidebarSummary = el("applications-summary-two-person-premium-sidebar");
  if (twoPersonSidebarSummary) {
    twoPersonSidebarSummary.textContent = Number.isFinite(metrics.twoPersonPremium)
      ? formatApplicationCurrency(metrics.twoPersonPremium)
      : "$0.00";
  }
  const caseSummary = el("applications-summary-case-number");
  if (caseSummary) {
    caseSummary.textContent = current.caseNumber || "Blank";
  }
  const alignmentToggle = el("applications-show-alignment-toggle");
  if (alignmentToggle instanceof HTMLInputElement) {
    alignmentToggle.checked = Boolean(state.applications.showAlignmentBoxes);
  }

  renderApplicationPreview();
  renderApplicationsList();
}

async function loadApplications(preferredId = "") {
  const payload = await apiRequest("/api/applications");
  state.applications.list = Array.isArray(payload.applications) ? payload.applications : [];
  state.applications.loaded = true;

  const desiredId = String(preferredId || state.applications.selectedId || "").trim();
  if (desiredId) {
    const match = state.applications.list.find((entry) => entry.id === desiredId);
    if (match) {
      hydrateApplicationFromServer(match);
    }
  }

  if (!state.applications.current) {
    state.applications.current = createEmptyApplication();
  }

  renderApplicationForm();
}

async function openApplicationById(applicationId) {
  const normalizedId = String(applicationId || "").trim();
  if (!normalizedId) {
    return;
  }

  const payload = await apiRequest(`/api/applications/${encodeURIComponent(normalizedId)}`);
  hydrateApplicationFromServer(payload.application || {});
  state.applications.previewVisible = false;
  renderApplicationForm();
  setStatus("applications-status", "Application loaded.");
}

async function saveCurrentApplication(statusMessage = "Application saved.") {
  const validation = validateCurrentApplication();
  if (!validation.isValid) {
    setStatus("applications-status", validation.errors.join(" "));
    return null;
  }

  const response = await apiRequest("/api/applications", {
    method: "POST",
    body: createApplicationPayload(),
  });
  state.applications.list = Array.isArray(response.applications) ? response.applications : state.applications.list;
  if (response.application) {
    hydrateApplicationFromServer(response.application);
  }
  renderApplicationForm();
  setStatus("applications-status", statusMessage);
  return response.application || null;
}

async function deleteApplicationById(applicationId) {
  const normalizedId = String(applicationId || "").trim();
  if (!normalizedId) {
    return;
  }

  const response = await apiRequest(`/api/applications/${encodeURIComponent(normalizedId)}`, {
    method: "DELETE",
  });
  state.applications.list = Array.isArray(response.applications) ? response.applications : [];
  if (state.applications.selectedId === normalizedId) {
    state.applications.current = createEmptyApplication();
    state.applications.selectedId = "";
    state.applications.previewVisible = false;
  }
  renderApplicationForm();
  setStatus("applications-status", "Application deleted.");
}

function startNewApplication(clearStatus = true) {
  state.applications.current = createEmptyApplication();
  state.applications.selectedId = "";
  state.applications.previewVisible = false;
  renderApplicationForm();
  if (clearStatus) {
    setStatus("applications-status", "New application ready.");
  }
}

function bindApplicationEvents() {
  const form = el("applications-form");
  form?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const field = target.getAttribute("data-application-field");
    if (!field) {
      return;
    }

    if (!state.applications.current) {
      state.applications.current = createEmptyApplication();
    }

    state.applications.current[field] = String(target.value || "");

    syncApplicationCalculatedFields();
    renderApplicationForm();
  });

  el("applications-new-button")?.addEventListener("click", () => {
    startNewApplication();
  });

  el("applications-clear-button")?.addEventListener("click", () => {
    startNewApplication(false);
    setStatus("applications-status", "Form cleared.");
  });

  el("applications-show-alignment-toggle")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    state.applications.showAlignmentBoxes = target.checked;
    renderApplicationPreview();
  });

  el("applications-save-button")?.addEventListener("click", async () => {
    setStatus("applications-status", "Saving application...");
    try {
      await saveCurrentApplication();
    } catch (error) {
      setStatus("applications-status", `Unable to save application: ${error.message}`);
    }
  });

  el("applications-preview-button")?.addEventListener("click", async () => {
    const validation = validateCurrentApplication();
    if (!validation.isValid) {
      setStatus("applications-status", validation.errors.join(" "));
      return;
    }
    try {
      await saveCurrentApplication("Application saved and preview updated.");
      state.applications.previewVisible = true;
      renderApplicationForm();
      document.getElementById("applications-preview-panel")?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    } catch (error) {
      setStatus("applications-status", `Unable to preview application: ${error.message}`);
    }
  });

  el("applications-print-button")?.addEventListener("click", async () => {
    const validation = validateCurrentApplication();
    if (!validation.isValid) {
      setStatus("applications-status", validation.errors.join(" "));
      return;
    }
    const printWindow = window.open("", "hpa-application-print", "width=950,height=1200");
    if (!printWindow) {
      setStatus("applications-status", "Print window was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    try {
      await saveCurrentApplication("Application saved. Opening print dialog...");
      state.applications.previewVisible = true;
      renderApplicationForm();
      printWindow.document.open();
      printWindow.document.write(buildApplicationPrintWindowDocument());
      printWindow.document.close();
    } catch (error) {
      try {
        printWindow.close();
      } catch {}
      setStatus("applications-status", `Unable to print application: ${error.message}`);
    }
  });

  el("applications-list-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.getAttribute("data-action");
    const applicationId = target.getAttribute("data-application-id");
    if (!action || !applicationId) {
      return;
    }

    if (action === "open-application") {
      setStatus("applications-status", "Loading application...");
      try {
        await openApplicationById(applicationId);
      } catch (error) {
        setStatus("applications-status", `Unable to load application: ${error.message}`);
      }
      return;
    }

    if (action === "delete-application") {
      setStatus("applications-status", "Deleting application...");
      try {
        await deleteApplicationById(applicationId);
      } catch (error) {
        setStatus("applications-status", `Unable to delete application: ${error.message}`);
      }
    }
  });
}

function setRoute(route) {
  const normalizedRoute = String(route || "").trim();
  if (!normalizedRoute) return;

  all('[data-view]').forEach((tab) => {
    tab.classList.toggle("is-active", tab.getAttribute("data-view") === normalizedRoute);
  });
  all(".nav-link").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-route") === normalizedRoute);
  });
  state.route = normalizedRoute;
  persistUiState();

  if (normalizedRoute === "analysis") {
    showAnalysisPanel(state.analysis.panel || "home");
    ensureVisibleAnalysisPanel();
    const activeAnalysisPanel = state.analysis.panel || "home";
    const activeAnalysisSubtab = state.analysis.subtab || "runs";
    if (activeAnalysisPanel === "previous") {
      loadAnalysisSetups().catch((error) => {
        setStatus("analysis-setup-status", `Unable to load analysis list: ${error.message}`);
      });
    } else if (
      activeAnalysisPanel === "compare"
      || activeAnalysisPanel === "compare-review"
      || (activeAnalysisPanel === "workspace" && activeAnalysisSubtab === "runs")
    ) {
      loadAnalysisSetupView().catch((error) => {
        setStatus("analysis-comparison-status", `Unable to load analysis setup: ${error.message}`);
      });
    } else if (activeAnalysisPanel === "workspace" && activeAnalysisSubtab === "mailing-lists") {
      loadAndRenderMailingList(state.analysis.mailingListType || "dnm").catch((error) => {
        setStatus("mailing-list-status", `Unable to load mailing list: ${error.message}`);
      });
    }
    return;
  }

  if (normalizedRoute === "cc-payment-imports") {
    Promise.all([loadCcPaymentImportTemplates(), loadCcPaymentImportSessions(state.ccPayments.launchSessionId || "")]).catch((error) => {
      setStatus("cc-payment-status", `Unable to load credit card payment imports: ${error.message}`);
    });
    return;
  }

  if (normalizedRoute === "check-imports") {
    Promise.all([loadCheckImportTemplates(), loadCheckImportSessions(state.checkImports.launchSessionId || "")]).catch((error) => {
      setStatus("check-import-status", `Unable to load check imports: ${error.message}`);
    });
    return;
  }

  if (normalizedRoute === "ach-returns") {
    loadAchReturnData(state.achReturns.currentSessionId || "").catch((error) => {
      setStatus("ach-return-status", `Unable to load ACH returns: ${error.message}`);
    });
    return;
  }

  if (normalizedRoute === "mailing-data") {
    loadMailingDataPage().catch((error) => {
      setStatus("mailing-data-status", `Unable to load Mailing Data: ${error.message}`);
    });
    return;
  }

  if (normalizedRoute === "applications") {
    loadApplications().catch((error) => {
      setStatus("applications-status", `Unable to load applications: ${error.message}`);
    });
    return;
  }

  if (normalizedRoute === "monthly-reports") {
    state.monthly.refreshOutput?.();
  }

  if (normalizedRoute === "report-history") {
    state.monthly.refreshHistory?.();
    return;
  }

  if (normalizedRoute === "score-history") {
    loadScoreHistoryPage().catch((error) => {
      setStatus("score-history-status", `Unable to load SCORE history: ${error.message}`);
    });
  }
}

function setAnalysisSubtab(tabName) {
  const normalizedTab = tabName === "mailing-lists" ? "mailing-lists" : "runs";
  const workspaceVisible = state.analysis.panel === "workspace";
  all("[data-analysis-subtab-panel]").forEach((panel) => {
    panel.classList.toggle(
      "is-active",
      workspaceVisible && panel.getAttribute("data-analysis-subtab-panel") === normalizedTab
    );
  });
  state.analysis.subtab = normalizedTab;
  persistUiState();
  updateAnalysisWorkflowButtons();
  updateAnalysisLeftSubmenuActiveState();
}

function getActiveAnalysisWorkflow() {
  if (state.analysis.panel === "compare-review") {
    return "run-analysis";
  }
  if (state.analysis.panel === "compare" || state.analysis.panel === "home") {
    return "set-up-comparisons";
  }
  if (state.analysis.panel === "workspace" && state.analysis.subtab === "runs") {
    return "run-reports";
  }
  return "";
}

function updateAnalysisWorkflowButtons() {
  const activeWorkflow = getActiveAnalysisWorkflow();
  all("[data-analysis-workflow]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.getAttribute("data-analysis-workflow") === activeWorkflow
    );
  });
}

function setMailingListTab(tabName) {
  const normalizedType = String(tabName || state.analysis.mailingListType || "dnm").toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    return;
  }
  all("[data-mailing-list-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.getAttribute("data-mailing-list-tab") === normalizedType);
  });
  state.analysis.mailingListType = normalizedType;
  persistUiState();
  updateAnalysisLeftSubmenuActiveState();
}

function updateAnalysisLeftSubmenuActiveState() {
  const shouldHighlight =
    state.route === "analysis"
    && state.analysis.panel === "workspace"
    && state.analysis.subtab === "mailing-lists";
  const activeType = shouldHighlight ? String(state.analysis.mailingListType || "dnm").toLowerCase() : "";
  all(".analysis-left-submenu-link[data-list-type]").forEach((button) => {
    button.classList.toggle("is-active", button.getAttribute("data-list-type") === activeType);
  });
  updateAnalysisLeftSubmenuExpandedUi();
}

function setAnalysisLeftSubmenuExpanded(expanded, options = {}) {
  state.analysis.navExpanded = Boolean(expanded);
  if (options.persist !== false) {
    persistUiState();
  }
  updateAnalysisLeftSubmenuExpandedUi();
}

function toggleAnalysisLeftSubmenu() {
  setAnalysisLeftSubmenuExpanded(!state.analysis.navExpanded);
}

function updateAnalysisLeftSubmenuExpandedUi() {
  const navGroup = document.querySelector('[data-nav-group="analysis"]');
  const toggleButton = document.querySelector('[data-action="toggle-analysis-submenu"]');
  const expanded = state.analysis.navExpanded !== false;
  navGroup?.classList.toggle("is-collapsed", !expanded);
  if (toggleButton instanceof HTMLElement) {
    toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggleButton.title = expanded ? "Collapse Analysis menu" : "Expand Analysis menu";
  }
}

function show(element, visible) {
  if (!element) return;
  element.classList.toggle("is-hidden", !visible);
}

function persistAnalysisSetupId(setupId) {
  try {
    if (!setupId) {
      window.localStorage.removeItem(ANALYSIS_SETUP_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(ANALYSIS_SETUP_STORAGE_KEY, setupId);
  } catch {
    // Best-effort persistence only.
  }
}

function readPersistedAnalysisSetupId() {
  try {
    return String(window.localStorage.getItem(ANALYSIS_SETUP_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function clearPersistedAnalysisSetupDraft() {
  try {
    window.localStorage.removeItem(ANALYSIS_SETUP_DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort persistence only.
  }
}

function persistAnalysisSetupDraft() {
  try {
    const runName = String(el("analysis-run-name")?.value || state.analysis.runName || "").trim();
    const runNotes = String(el("analysis-run-notes")?.value || state.analysis.runNotes || "").trim();
    const payload = {
      setupId: String(state.analysis.currentSetupId || "").trim(),
      runName,
      runNotes,
      reportPulls: cloneData(state.analysis.reportPulls || []),
      comparisonLinks: cloneData(state.analysis.comparisonLinks || []),
      comparisonRequests: cloneData(state.analysis.comparisonRequests || []),
      selectedComparisonId: String(state.analysis.selectedComparisonId || "").trim(),
      lastEditedComparisonId: String(state.analysis.lastEditedComparisonId || "").trim(),
      reviewPrimaryReportIds: cloneData(state.analysis.reviewPrimaryReportIds || {}),
      reviewSelectedScfs: cloneData(state.analysis.reviewSelectedScfs || {}),
      reviewZeroRateRemovals: cloneData(state.analysis.reviewZeroRateRemovals || []),
      reviewCompletedByName: String(state.analysis.reviewCompletedByName || "").trim(),
      reviewCompletedOnDate: String(state.analysis.reviewCompletedOnDate || "").trim(),
      updatedAt: new Date().toISOString(),
    };

    const hasContent =
      payload.runName ||
      payload.runNotes ||
      payload.reportPulls.length ||
      payload.comparisonLinks.length > 1 ||
      (payload.comparisonLinks.length === 1 && getComparisonSelectedReportIds(payload.comparisonLinks[0]).length);

    if (!hasContent) {
      clearPersistedAnalysisSetupDraft();
      return;
    }

    window.localStorage.setItem(ANALYSIS_SETUP_DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort persistence only.
  }
}

function readPersistedAnalysisSetupDraft() {
  try {
    const raw = window.localStorage.getItem(ANALYSIS_SETUP_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function restorePersistedAnalysisSetupDraft(setupId = "") {
  const draft = readPersistedAnalysisSetupDraft();
  if (!draft) {
    return false;
  }

  const draftSetupId = String(draft.setupId || "").trim();
  const normalizedSetupId = String(setupId || state.analysis.currentSetupId || "").trim();
  if (draftSetupId && normalizedSetupId && draftSetupId !== normalizedSetupId) {
    return false;
  }

  if (Array.isArray(draft.reportPulls) && draft.reportPulls.length) {
    state.analysis.reportPulls = draft.reportPulls.map((pull, index) => ({
      ...createEmptyPull(index),
      ...pull,
      dateRange: pull.dateRange
        ? {
            startDate: normalizeIsoDateInput(pull.dateRange.startDate || ""),
            endDate: normalizeIsoDateInput(pull.dateRange.endDate || ""),
          }
        : null,
    }));
  }

  if (Array.isArray(draft.comparisonLinks) && draft.comparisonLinks.length) {
    state.analysis.comparisonLinks = draft.comparisonLinks.map((link, index) =>
      createComparisonLink(index, link)
    );
    state.analysis.comparisonRequests = syncComparisonRequestsFromLinks();
  } else if (Array.isArray(draft.comparisonRequests) && draft.comparisonRequests.length) {
    state.analysis.comparisonRequests = cloneData(draft.comparisonRequests);
    state.analysis.comparisonLinks = state.analysis.comparisonRequests.map((entry, index) =>
      createComparisonLink(index, entry)
    );
  }

  if (draft.runName !== undefined) {
    state.analysis.runName = String(draft.runName || "");
  }
  if (draft.runNotes !== undefined) {
    state.analysis.runNotes = String(draft.runNotes || "");
  }
  if (draft.reviewPrimaryReportIds && typeof draft.reviewPrimaryReportIds === "object") {
    state.analysis.reviewPrimaryReportIds = normalizeReviewSyncMap(draft.reviewPrimaryReportIds);
  }
  if (draft.reviewSelectedScfs && typeof draft.reviewSelectedScfs === "object") {
    state.analysis.reviewSelectedScfs = normalizeReviewSyncMap(draft.reviewSelectedScfs);
  }
  if (Array.isArray(draft.reviewZeroRateRemovals)) {
    state.analysis.reviewZeroRateRemovals = normalizeReviewZeroRateRemovals(draft.reviewZeroRateRemovals);
  }
  if (draft.reviewCompletedByName !== undefined) {
    state.analysis.reviewCompletedByName = String(draft.reviewCompletedByName || "").trim();
  }
  if (draft.reviewCompletedOnDate !== undefined) {
    state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(draft.reviewCompletedOnDate || "") || getTodayIsoDate();
  }
  state.analysis.selectedComparisonId = String(draft.selectedComparisonId || state.analysis.selectedComparisonId || "").trim();
  state.analysis.lastEditedComparisonId = String(draft.lastEditedComparisonId || state.analysis.lastEditedComparisonId || "").trim();
  state.analysis.lastSetupLoadSource = "local-draft";
  return true;
}

function ensureReviewCompletionFields() {
  state.analysis.reviewCompletedByName = String(state.analysis.reviewCompletedByName || "").trim();
  state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate();
}

function logComparisonSetupPersistenceContext(reason = "compare-review-open") {
  const selectedComparisonIds = ensureArray(state.analysis.comparisonRequests)
    .map((entry) => String(entry?.id || "").trim())
    .filter(Boolean);
  const selectedComparisonId = String(state.analysis.selectedComparisonId || "").trim();
  const selectedPrimaryReportId = selectedComparisonId
    ? String(state.analysis.reviewPrimaryReportIds?.[selectedComparisonId] || "").trim()
    : "";
  const selectedPrimaryReport = ensureArray(state.analysis.savedReports).find(
    (report) => String(report?.id || "").trim() === selectedPrimaryReportId
  ) || null;
  console.info("[analysis-comparison-persistence]", {
    reason,
    analysisId: String(state.analysis.currentRunId || state.analysis.currentSetupId || "").trim(),
    setupId: String(state.analysis.currentSetupId || "").trim(),
    savedComparisonSetupId: selectedComparisonId,
    selectedPrimaryReportId,
    selectedComparisonIds,
    selectedPrimaryReportExists: Boolean(selectedPrimaryReport),
    selectedPrimaryReportRowCount: Array.isArray(selectedPrimaryReport?.rows) ? selectedPrimaryReport.rows.length : 0,
    loadSource: String(state.analysis.lastSetupLoadSource || "runtime-state").trim() || "runtime-state",
  });
}

function isCurrentAnalysisReadOnly() {
  return state.analysis.readOnlyReview === true;
}

function isCompletedAnalysisSetup(entry = {}) {
  return String(entry?.status || "").trim().toLowerCase() === "complete"
    && !String(entry?.completionUndoneAt || entry?.completion_undone_at || "").trim();
}

function syncAnalysisReadOnlyState(entry = {}) {
  const setupLikeEntry = {
    ...entry,
    status:
      entry?.setupStatus !== undefined && entry?.setupStatus !== null
        ? entry.setupStatus
        : entry?.status,
    completedAt:
      entry?.setupCompletedAt !== undefined && entry?.setupCompletedAt !== null
        ? entry.setupCompletedAt
        : entry?.completedAt,
    completionUndoneAt:
      entry?.setupCompletionUndoneAt !== undefined && entry?.setupCompletionUndoneAt !== null
        ? entry.setupCompletionUndoneAt
        : entry?.completionUndoneAt,
    completion_undone_at:
      entry?.setupCompletionUndoneAt !== undefined && entry?.setupCompletionUndoneAt !== null
        ? entry.setupCompletionUndoneAt
        : entry?.completion_undone_at,
  };
  state.analysis.currentSetupStatus = String(setupLikeEntry?.status || "").trim();
  state.analysis.readOnlyReview = isCompletedAnalysisSetup(setupLikeEntry);
}

function shouldDisplayAnalysisHistoryEntry(entry = {}) {
  if (!entry?.archived) {
    return true;
  }
  const createdAt = entry?.created_at || entry?.createdAt || "";
  const createdTime = Date.parse(createdAt) || 0;
  const visibleFromTime = Date.parse(ANALYSIS_HISTORY_VISIBLE_FROM) || 0;
  return createdTime >= visibleFromTime;
}

function persistUiState() {
  try {
    window.localStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({
        route: state.route || "dashboard",
        analysis: {
          panel: state.analysis.panel || "home",
          subtab: state.analysis.subtab || "runs",
          mailingListType: state.analysis.mailingListType || "dnm",
          navExpanded: state.analysis.navExpanded !== false,
        },
        achReturns: {
          currentSessionId: state.achReturns.currentSessionId || "",
        },
      })
    );
  } catch {
    // Best-effort persistence only.
  }
}

function readPersistedUiState() {
  try {
    const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readLaunchStateFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const route = String(params.get("route") || "").trim().toLowerCase();
    const sessionId = String(params.get("sessionId") || "").trim();
    const panel = String(params.get("analysisPanel") || "").trim().toLowerCase();
    const subtab = String(params.get("analysisSubtab") || "").trim().toLowerCase();
    const mailingListType = String(params.get("mailingListType") || "").trim().toLowerCase();
    const analysisSetupId = String(params.get("analysisSetupId") || "").trim();
    const comparisonId = String(params.get("comparisonId") || "").trim();
    const primaryReportId = String(params.get("primaryReportId") || "").trim();
    const reviewScf = normalizeScf(params.get("reviewScf") || "");
    const reviewSummaryMode = String(params.get("reviewSummaryMode") || "").trim().toLowerCase();
    const isReviewPopup = params.get(ANALYSIS_REVIEW_POPUP_QUERY_PARAM) === "1";
    const isImportSessionPopup = params.get(IMPORT_SESSION_POPUP_QUERY_PARAM) === "1";
    return {
      route: ["dashboard", "analysis", "mailing-data", "applications", "monthly-reports", "report-history", "score-history", "settings", "cc-payment-imports", "check-imports", "ach-returns"].includes(route)
        ? route
        : "",
      importSession: {
        route: ["cc-payment-imports", "check-imports", "ach-returns"].includes(route) ? route : "",
        sessionId,
        popup: isImportSessionPopup,
      },
      analysis: {
        panel: ["home", "previous", "workspace", "compare", "compare-review"].includes(panel)
          ? panel
          : "",
        subtab: subtab === "mailing-lists" ? "mailing-lists" : subtab === "runs" ? "runs" : "",
        mailingListType: ["dnm", "nhcl", "rfc"].includes(mailingListType) ? mailingListType : "",
        setupId: analysisSetupId,
        comparisonId,
        primaryReportId,
        reviewScf,
        reviewSummaryMode: ["review", "summary"].includes(reviewSummaryMode) ? reviewSummaryMode : "",
        popup: isReviewPopup,
      },
    };
  } catch {
    return null;
  }
}

function persistAchReturnDraftState() {
  try {
    const draft = state.achReturns.draft ? cloneData(state.achReturns.draft) : null;
    const emailBody = String(state.achReturns.emailBody || "");
    if (!draft && !emailBody.trim()) {
      window.localStorage.removeItem(ACH_RETURN_DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      ACH_RETURN_DRAFT_STORAGE_KEY,
      JSON.stringify({
        draft,
        emailBody,
      })
    );
  } catch {
    // Best-effort persistence only.
  }
}

function readPersistedAchReturnDraftState() {
  try {
    const raw = window.localStorage.getItem(ACH_RETURN_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function clearPersistedAchReturnDraftState() {
  try {
    window.localStorage.removeItem(ACH_RETURN_DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort persistence only.
  }
}

function readPersistedMailingDataHistory() {
  try {
    const raw = window.localStorage.getItem(MAILING_DATA_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistMailingDataHistory(historyEntries) {
  try {
    window.localStorage.setItem(
      MAILING_DATA_HISTORY_STORAGE_KEY,
      JSON.stringify(Array.isArray(historyEntries) ? historyEntries : [])
    );
  } catch {
    // Best-effort persistence only.
  }
}

function getCurrentComparisonReviewSetupId() {
  return String(state.analysis.currentSetupId || readPersistedAnalysisSetupId() || "").trim();
}

function normalizeReviewSyncMap(source) {
  const raw = source && typeof source === "object" ? source : {};
  const output = {};
  Object.keys(raw).forEach((key) => {
    const normalizedKey = String(key || "").trim();
    const value = String(raw[key] || "").trim();
    if (normalizedKey && value) {
      output[normalizedKey] = value;
    }
  });
  return output;
}

function normalizeReviewSyncScfMap(source) {
  const raw = source && typeof source === "object" ? source : {};
  const output = {};
  Object.keys(raw).forEach((key) => {
    const normalizedKey = String(key || "").trim();
    const values = Array.from(
      new Set(
        ensureArray(raw[key])
          .map((entry) => normalizeScf(entry))
          .filter(Boolean)
      )
    );
    if (normalizedKey && values.length) {
      output[normalizedKey] = values;
    }
  });
  return output;
}

function normalizeReviewZeroRateRemovals(source) {
  return ensureArray(source).map((entry) => {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const removedScfs = Array.from(new Set(
      ensureArray(entry.removedScfs).map((scf) => normalizeScf(scf)).filter(Boolean)
    ));
    const foundZeroRateScfs = Array.from(new Set(
      ensureArray(entry.foundZeroRateScfs).map((scf) => normalizeScf(scf)).filter(Boolean)
    ));
    const skippedAlreadyRemovedScfs = Array.from(new Set(
      ensureArray(entry.skippedAlreadyRemovedScfs).map((scf) => normalizeScf(scf)).filter(Boolean)
    ));
    const skippedDnmScfs = Array.from(new Set(
      ensureArray(entry.skippedDnmScfs).map((scf) => normalizeScf(scf)).filter(Boolean)
    ));
    if (!removedScfs.length && !foundZeroRateScfs.length && !skippedAlreadyRemovedScfs.length && !skippedDnmScfs.length) {
      return null;
    }
    return {
      id: String(entry.id || "").trim() || createClientId("zero_rate_removal"),
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
}

function normalizeReviewZeroRemovalDiagnostics(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const sampleRows = ensureArray(source.zeroRemovalSampleRows || source.sampleRows).map((entry) => {
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
  }).filter((entry) => entry.scf);
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
    zeroRemovalSampleRows: sampleRows.slice(0, 10),
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
}

function normalizeReviewSyncLists(source) {
  const rows = ensureArray(source || []);
  return rows
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      return {
        type: String(entry.type || "").trim(),
        items: ensureArray(entry.items).map((item) => ({
          scf: String(item?.scf || "").trim(),
          state: String(item?.state || "").trim(),
          scope: String(item?.scope || "").trim(),
          reason: String(item?.reason || "").trim(),
          addedAt: String(item?.addedAt || "").trim(),
          addedBy: String(item?.addedBy || "").trim(),
        })).filter((entry) => entry.scf),
        count: Number(entry.count || 0),
        stateGroups: ensureArray(entry.stateGroups).map((group) => ({
          label: String(group?.label || "").trim(),
          state: String(group?.state || "").trim(),
          isActive: Boolean(group?.isActive),
          scfs: ensureArray(group?.scfs).map((rawScf) => String(rawScf || "").trim()).filter(Boolean),
        })),
        updatedAt: String(entry.updatedAt || "").trim(),
      };
    })
    .filter((entry) => entry.type);
}

function isAnalysisReviewSyncReady() {
  return state.route === "analysis" || isAnalysisReviewPopupWindow();
}

function getAnalysisReviewSyncPayload(reason = "state-change") {
  ensureReviewCompletionFields();
  const setupId = getCurrentComparisonReviewSetupId();
  const currentComparisonId = String(state.analysis.selectedComparisonId || "").trim();
  const nextVersion = Number(state.analysis.reviewSyncVersion || 0) + 1;
  state.analysis.reviewSyncVersion = nextVersion;
  return {
    type: "analysis-review-sync",
    source: analysisReviewWindowId,
    reason,
    ts: Date.now(),
    setupId,
    selectedComparisonId: currentComparisonId,
    lastEditedComparisonId: String(state.analysis.lastEditedComparisonId || currentComparisonId).trim(),
    reviewPrimaryReportIds: normalizeReviewSyncMap(state.analysis.reviewPrimaryReportIds),
    reviewSelectedScfs: normalizeReviewSyncMap(state.analysis.reviewSelectedScfs),
    reviewExcludedScfs: normalizeReviewSyncScfMap(state.analysis.reviewExcludedScfs),
    reviewBaselineLists: normalizeReviewSyncLists(state.analysis.reviewBaselineLists),
    reviewWorkingLists: normalizeReviewSyncLists(state.analysis.reviewWorkingLists),
    reviewZeroRateRemovals: normalizeReviewZeroRateRemovals(state.analysis.reviewZeroRateRemovals),
    reviewZeroRemovalDiagnostics: normalizeReviewZeroRemovalDiagnostics(state.analysis.reviewZeroRemovalDiagnostics),
    reviewSummary: state.analysis.reviewSummary ? cloneData(state.analysis.reviewSummary) : null,
    reviewSummaryMode: String(state.analysis.reviewSummaryMode || "review").trim() || "review",
    reviewSummaryNotes: String(state.analysis.reviewSummaryNotes || "").trim(),
    reviewSummaryApproved: Boolean(state.analysis.reviewSummaryApproved),
    reviewCompletedByName: String(state.analysis.reviewCompletedByName || "").trim(),
    reviewCompletedOnDate: String(state.analysis.reviewCompletedOnDate || "").trim(),
    reviewTableSort: cloneData(state.analysis.reviewTableSort || { key: "soldRate", direction: "desc" }),
    reviewSoldRateOperator: String(state.analysis.reviewSoldRateOperator || ">").trim() || ">",
    reviewSoldRateMin: String(state.analysis.reviewSoldRateMin || ""),
    reviewInForceRateOperator: String(state.analysis.reviewInForceRateOperator || ">").trim() || ">",
    reviewInForceRateValue: String(state.analysis.reviewInForceRateValue || ""),
    reviewConvertedRateOperator: String(state.analysis.reviewConvertedRateOperator || "!=").trim() || "!=",
    reviewConvertedRateValue: String(state.analysis.reviewConvertedRateValue || ""),
    reviewMailedOperator: String(state.analysis.reviewMailedOperator || ">").trim() || ">",
    reviewMailedMin: String(state.analysis.reviewMailedMin || ""),
    reviewBulkMetric: String(state.analysis.reviewBulkMetric || "soldRate").trim(),
    reviewBulkThresholdValue: String(state.analysis.reviewBulkThresholdValue || ""),
    reviewPageSize: String(state.analysis.reviewPageSize || 100),
    reviewPageNumber: Number(state.analysis.reviewPageNumber || 1) || 1,
    selectedNavigatorScfs: ensureArray(state.analysis.selectedNavigatorScfs).map((entry) => normalizeScf(entry)).filter(Boolean),
    activeNavigatorScfFilter: ensureArray(state.analysis.activeNavigatorScfFilter).map((entry) => normalizeScf(entry)).filter(Boolean),
    reviewSyncVersion: nextVersion,
    panel: state.analysis.panel || "home",
    route: state.route || "dashboard",
  };
}

function scheduleReviewStateAutosave(reason = "review-state-change") {
  if (isCurrentAnalysisReadOnly()) {
    return;
  }
  persistAnalysisSetupDraft();
  const hasSetupContext =
    String(state.analysis.currentSetupId || "").trim()
    || (Array.isArray(state.analysis.reportPulls) && state.analysis.reportPulls.length > 0);
  if (!hasSetupContext) {
    return;
  }
  scheduleComparisonSetupAutosave({
    delayMs: 600,
    statusMessage: "Review changes saved automatically.",
  });
}

function applyAnalysisReviewSync(message) {
  if (!message || typeof message !== "object" || message.source === analysisReviewWindowId) return;
  if (!message.type || message.type !== "analysis-review-sync") return;
  const messageVersion = Number(message.reviewSyncVersion || 0);
  const messageTs = Number(message.ts || 0);
  if (!Number.isFinite(messageVersion) || !Number.isFinite(messageTs)) {
    return;
  }

  const messageSetupId = String(message.setupId || "").trim();
  const currentSetupId = getCurrentComparisonReviewSetupId();
  if (messageSetupId && currentSetupId && messageSetupId !== currentSetupId) return;
  if (messageVersion <= Number(state.analysis.reviewSyncVersion || 0)) return;

  setAnalysisReviewSyncing(true);
  try {
    state.analysis.lastEditedComparisonId = String(message.lastEditedComparisonId || message.selectedComparisonId || "").trim();
    state.analysis.selectedComparisonId = String(message.selectedComparisonId || state.analysis.selectedComparisonId || "").trim();
    state.analysis.reviewPrimaryReportIds = normalizeReviewSyncMap(message.reviewPrimaryReportIds);
    state.analysis.reviewSelectedScfs = normalizeReviewSyncMap(message.reviewSelectedScfs);
    state.analysis.reviewExcludedScfs = normalizeReviewSyncScfMap(message.reviewExcludedScfs);
    state.analysis.reviewBaselineLists = normalizeReviewSyncLists(message.reviewBaselineLists);
    state.analysis.reviewWorkingLists = normalizeReviewSyncLists(message.reviewWorkingLists);
    state.analysis.reviewZeroRateRemovals = normalizeReviewZeroRateRemovals(message.reviewZeroRateRemovals);
    state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics(message.reviewZeroRemovalDiagnostics);
    state.analysis.reviewSummary = message.reviewSummary ? cloneData(message.reviewSummary) : null;
    state.analysis.reviewSummaryMode = String(message.reviewSummaryMode || "review").trim() || "review";
    state.analysis.reviewSummaryNotes = String(message.reviewSummaryNotes || "").trim();
    state.analysis.reviewSummaryApproved = Boolean(message.reviewSummaryApproved);
    state.analysis.reviewCompletedByName = String(message.reviewCompletedByName || "").trim();
    state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(message.reviewCompletedOnDate || "") || getTodayIsoDate();
    state.analysis.reviewTableSort = message.reviewTableSort && typeof message.reviewTableSort === "object"
      ? cloneData(message.reviewTableSort)
      : { key: "soldRate", direction: "desc" };
    state.analysis.reviewSoldRateOperator = String(message.reviewSoldRateOperator || ">").trim() || ">";
    state.analysis.reviewSoldRateMin = String(message.reviewSoldRateMin || "");
    state.analysis.reviewInForceRateOperator = String(message.reviewInForceRateOperator || ">").trim() || ">";
    state.analysis.reviewInForceRateValue = String(message.reviewInForceRateValue || "");
    state.analysis.reviewConvertedRateOperator = String(message.reviewConvertedRateOperator || "!=").trim() || "!=";
    state.analysis.reviewConvertedRateValue = String(
      message.reviewConvertedRateValue
      || (String(message.reviewConvertedRateMode || "any").trim() === "notZero" ? "0" : "")
    );
    state.analysis.reviewMailedOperator = String(message.reviewMailedOperator || ">").trim() || ">";
    state.analysis.reviewMailedMin = String(message.reviewMailedMin || "");
    state.analysis.reviewBulkMetric = String(message.reviewBulkMetric || "soldRate").trim();
    state.analysis.reviewBulkThresholdValue = String(message.reviewBulkThresholdValue || "");
    state.analysis.reviewPageSize = String(message.reviewPageSize || 100);
    state.analysis.reviewPageNumber = Number(message.reviewPageNumber || 1) || 1;
    state.analysis.selectedNavigatorScfs = ensureArray(message.selectedNavigatorScfs).map((entry) => normalizeScf(entry)).filter(Boolean);
    state.analysis.activeNavigatorScfFilter = ensureArray(message.activeNavigatorScfFilter).map((entry) => normalizeScf(entry)).filter(Boolean);
    state.analysis.reviewSyncVersion = messageVersion;
  } finally {
    setAnalysisReviewSyncing(false);
  }

  if (state.route === "analysis" && state.analysis.panel === "compare-review") {
    renderAnalysisComparisonReviewPanel();
  }
}

function broadcastAnalysisReviewState(reason = "state-change") {
  if (!isAnalysisReviewSyncReady() || isAnalysisReviewSyncing()) {
    return;
  }

  try {
    const payload = getAnalysisReviewSyncPayload(reason);
    const syncChannel = getAnalysisReviewSyncChannel();
    if (syncChannel) {
      syncChannel.postMessage(payload);
    }
    if (window && window.localStorage) {
      window.localStorage.setItem(ANALYSIS_REVIEW_SYNC_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // Best effort sync; keep runtime behavior resilient.
  }
}

function setupAnalysisReviewSync() {
  if ("BroadcastChannel" in window) {
    try {
      const syncChannel = new BroadcastChannel(ANALYSIS_REVIEW_SYNC_CHANNEL_NAME);
      setAnalysisReviewSyncChannel(syncChannel);
      syncChannel.onmessage = (event) => {
        applyAnalysisReviewSync(event.data);
      };
    } catch {
      setAnalysisReviewSyncChannel(null);
    }
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== ANALYSIS_REVIEW_SYNC_STORAGE_KEY || !event.newValue) return;
    try {
      const message = JSON.parse(event.newValue);
      applyAnalysisReviewSync(message);
    } catch {
      // Ignore malformed sync payloads.
    }
  });
}

async function openAnalysisWorkspace() {
  state.analysis.panel = "workspace";
  state.analysis.subtab = "runs";
  setRoute("analysis");

  const persistedSetupId = state.analysis.currentSetupId || readPersistedAnalysisSetupId();
  if (persistedSetupId && !state.analysis.setupHydrated) {
    try {
      const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(persistedSetupId)}`);
      loadSetupIntoWorkspace(response.setup || {});
    } catch (error) {
      setStatus("analysis-status-detail", `Unable to restore analysis setup: ${error.message}`);
    }
  }

  showAnalysisPanel("workspace");
  try {
    await loadAnalysisReports();
  } catch (error) {
    setStatus("analysis-status-detail", `Unable to load analysis reports: ${error.message}`);
  }
}

function getComparisonReviewResultFromEntry(entry = {}) {
  const results = entry?.results || {};
  const comparisonReview = results?.comparisonReview || null;
  if (!comparisonReview || typeof comparisonReview !== "object") {
    return null;
  }
  const savedSummary = comparisonReview.summary && typeof comparisonReview.summary === "object"
    ? comparisonReview.summary
    : null;
  const hasReviewSnapshots =
    ensureArray(entry?.reviewState?.reviewBaselineLists).length > 0
    || ensureArray(entry?.reviewState?.reviewWorkingLists).length > 0;
  const rebuiltSummary = hasReviewSnapshots
    ? buildComparisonReviewSummaryFromSnapshots(
        entry.reviewState?.reviewBaselineLists || [],
        entry.reviewState?.reviewWorkingLists || [],
        savedSummary?.runNotes || entry?.notes || ""
      )
    : null;
  const normalizedSummary = rebuiltSummary
    ? {
        ...(savedSummary || {}),
        ...rebuiltSummary,
        runNotes: String(savedSummary?.runNotes || rebuiltSummary.runNotes || "").trim(),
      }
    : savedSummary;
  return {
    ...comparisonReview,
    summary: normalizedSummary
      ? {
          ...normalizedSummary,
          completedAt: comparisonReview.completedAt || normalizedSummary.completedAt || null,
          completedByName: comparisonReview.completedByName || normalizedSummary.completedByName || "",
          completedOnDate: comparisonReview.completedOnDate || normalizedSummary.completedOnDate || "",
          canUndoLatestCompletion: comparisonReview.canUndoLatestCompletion === true || normalizedSummary.canUndoLatestCompletion === true,
        }
      : comparisonReview.summary,
  };
}

function resolveAnalysisLandingFromEntry(entry = {}) {
  const comparisonReview = getComparisonReviewResultFromEntry(entry);
  if (comparisonReview?.summary) {
    return {
      panel: "compare-review",
      summaryMode: isCompletedAnalysisSetup(entry) ? "summary" : "review",
    };
  }

  if (Array.isArray(entry?.comparisonRequests) && entry.comparisonRequests.length) {
    return { panel: "compare-review", summaryMode: "review" };
  }

  if (Array.isArray(entry?.reportPulls) && entry.reportPulls.length) {
    return { panel: "home", summaryMode: "review" };
  }

  return { panel: "previous", summaryMode: "review" };
}

function choosePreferredAnalysisSetup(setups = [], options = {}) {
  const normalizedSetups = ensureArray(setups).filter((entry) => !entry?.archived);
  if (!normalizedSetups.length) {
    return null;
  }

  const preferredId = String(options.preferredId || state.analysis.currentSetupId || readPersistedAnalysisSetupId() || "").trim();
  const defaultName = getDefaultAnalysisName().toLowerCase();

  const scoreSetup = (setup) => {
    const setupId = String(setup?.id || "").trim();
    const runName = String(setup?.run_name || setup?.runName || "").trim().toLowerCase();
    const comparisonCount = Array.isArray(setup?.comparisonRequests) ? setup.comparisonRequests.length : 0;
    const pullCount = Array.isArray(setup?.reportPulls) ? setup.reportPulls.length : 0;
    let score = 0;
    if (setupId && preferredId && setupId === preferredId) {
      score += 1000;
    }
    if (runName === defaultName) {
      score += 100;
    }
    if (comparisonCount > 0) {
      score += 50 + comparisonCount;
    }
    if (pullCount > 0) {
      score += 10 + Math.min(pullCount, 5);
    }
    return score;
  };

  return [...normalizedSetups].sort((a, b) => {
    const scoreDiff = scoreSetup(b) - scoreSetup(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const aTime = Date.parse(a.updated_at || a.updatedAt || a.created_at || a.createdAt || "") || 0;
    const bTime = Date.parse(b.updated_at || b.updatedAt || b.created_at || b.createdAt || "") || 0;
    return bTime - aTime;
  })[0] || null;
}

async function openAnalysisLanding() {
  setAnalysisLeftSubmenuExpanded(true);
  setRoute("analysis");
  const setupsPayload = await apiRequest("/api/analysis/setups");
  const setup = choosePreferredAnalysisSetup(setupsPayload.setups || [], {
    preferredId: state.analysis.currentSetupId || readPersistedAnalysisSetupId(),
  });

  if (!setup) {
    showAnalysisPanel("previous");
    await loadAnalysisSetups();
    return;
  }

  const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(setup.id)}`);
  const fullSetup = response.setup || {};
  loadSetupIntoWorkspace(fullSetup);

  const landing = resolveAnalysisLandingFromEntry(fullSetup);
  state.analysis.reviewSummaryMode = landing.summaryMode;

  if (landing.panel === "compare-review") {
    showAnalysisPanel("compare-review");
    return;
  }

  if (landing.panel === "home") {
    await loadAnalysisSetupView();
    showAnalysisPanel("home");
    return;
  }

  showAnalysisPanel("previous");
  await loadAnalysisSetups();
}

async function openAnalysisList() {
  state.analysis.panel = "previous";
  setRoute("analysis");
  showAnalysisPanel("previous");
  try {
    await loadAnalysisSetups();
  } catch (error) {
    setStatus("analysis-setup-status", `Unable to load analyses: ${error.message}`);
  }
}

function openMailingListsPopup(listType = "dnm") {
  const normalizedType = String(listType || "dnm").toLowerCase();
  const popupUrl = new URL(window.location.href);
  popupUrl.searchParams.set("route", "analysis");
  popupUrl.searchParams.set("analysisPanel", "workspace");
  popupUrl.searchParams.set("analysisSubtab", "mailing-lists");
  popupUrl.searchParams.set("mailingListType", normalizedType);
  const popupWindow = window.open(
    popupUrl.toString(),
    `hpa-mailing-lists-${normalizedType}`,
    "popup=yes,width=1380,height=920,resizable=yes,scrollbars=yes"
  );
  if (!popupWindow) {
    state.analysis.panel = "workspace";
    state.analysis.subtab = "mailing-lists";
    state.analysis.mailingListType = ["dnm", "nhcl", "rfc"].includes(normalizedType)
      ? normalizedType
      : "dnm";
    setRoute("analysis");
    showAnalysisPanel("workspace");
    setAnalysisSubtab("mailing-lists");
    void loadAndRenderMailingList(state.analysis.mailingListType);
    setStatus(
      "analysis-comparison-selection-status",
      "Popup was blocked, so the mailing list opened in this window instead."
    );
    return false;
  }
  popupWindow.focus();
  return true;
}

function isAnalysisReviewPopupWindow() {
  try {
    return new URLSearchParams(window.location.search || "").get(ANALYSIS_REVIEW_POPUP_QUERY_PARAM) === "1";
  } catch {
    return false;
  }
}

function isImportSessionPopupWindow() {
  try {
    return new URLSearchParams(window.location.search || "").get(IMPORT_SESSION_POPUP_QUERY_PARAM) === "1";
  } catch {
    return false;
  }
}

function openImportSessionPopup(route, sessionId) {
  const normalizedRoute = String(route || "").trim();
  const normalizedSessionId = String(sessionId || "").trim();
  if (!["cc-payment-imports", "check-imports", "ach-returns"].includes(normalizedRoute) || !normalizedSessionId) {
    return false;
  }

  const popupUrl = new URL(window.location.href);
  popupUrl.searchParams.set("route", normalizedRoute);
  popupUrl.searchParams.set("sessionId", normalizedSessionId);
  popupUrl.searchParams.set(IMPORT_SESSION_POPUP_QUERY_PARAM, "1");

  const popupWindow = window.open(
    popupUrl.toString(),
    `hpa-import-session-${normalizedRoute}-${normalizedSessionId}`,
    "popup=yes,width=1650,height=1000,resizable=yes,scrollbars=yes"
  );

  if (!popupWindow) {
    return false;
  }

  popupWindow.focus();
  return true;
}

function openComparisonReviewPopup() {
  syncComparisonRequestsFromLinks();
  const context = ensureComparisonReviewSelection();
  if (!context?.comparison) {
    setStatus("analysis-comparison-selection-status", "Choose a comparison before opening a detached review window.");
    return false;
  }

  const setupId = String(state.analysis.currentSetupId || readPersistedAnalysisSetupId() || "").trim();
  if (!setupId) {
    setStatus("analysis-comparison-selection-status", "Save this analysis first, then open the detached review window.");
    return false;
  }

  const popupUrl = new URL(window.location.href);
  popupUrl.searchParams.set("route", "analysis");
  popupUrl.searchParams.set("analysisPanel", "compare-review");
  popupUrl.searchParams.set("analysisSetupId", setupId);
  popupUrl.searchParams.set("comparisonId", String(context.comparison.id || "").trim());
  popupUrl.searchParams.set("primaryReportId", String(context.primaryReport?.id || "").trim());
  popupUrl.searchParams.set("reviewScf", String(context.selectedScf || state.analysis.reviewSelectedScfs[context.comparison.id] || "").trim());
  popupUrl.searchParams.set("reviewSummaryMode", String(state.analysis.reviewSummaryMode || "review"));
  popupUrl.searchParams.set(ANALYSIS_REVIEW_POPUP_QUERY_PARAM, "1");

  if (analysisReviewPopupWindowRef && analysisReviewPopupWindowRef.closed) {
    analysisReviewPopupWindowRef = null;
  }

  if (analysisReviewPopupWindowRef && !analysisReviewPopupWindowRef.closed) {
    analysisReviewPopupWindowRef.focus();
    setStatus(
      "analysis-comparison-selection-status",
      "Detached review window is already open."
    );
    return true;
  }

  const popupWindow = window.open(
    popupUrl.toString(),
    `hpa-analysis-review-${setupId}-${Date.now()}`,
    "popup=yes,width=1600,height=1000,resizable=yes,scrollbars=yes"
  );

  if (!popupWindow) {
    setStatus(
      "analysis-comparison-selection-status",
      "The review window was blocked by the browser. Allow popups for this site and try again."
    );
    return false;
  }

  analysisReviewPopupWindowRef = popupWindow;
  popupWindow.focus();
  setStatus(
    "analysis-comparison-selection-status",
    "Detached review window opened. You can drag that browser window to another monitor."
  );
  return true;
}

function ensureVisibleAnalysisPanel() {
  const panelMap = {
    home: el("analysis-home-panel"),
    previous: el("analysis-previous-panel"),
    workspace: el("analysis-workspace"),
    compare: el("analysis-compare-panel"),
    "compare-review": el("analysis-comparison-review-panel"),
  };
  const panels = Object.values(panelMap).filter(Boolean);

  if (!panels.length) return;
  if (panels.some((panel) => !panel.classList.contains("is-hidden"))) return;

  const requestedPanel = panelMap[state.analysis.panel] ? state.analysis.panel : "home";
  Object.entries(panelMap).forEach(([key, node]) => {
    show(node, key === requestedPanel);
  });
  state.analysis.panel = requestedPanel;
}

function getReferenceListFromCache(type) {
  const normalized = (type || "").toLowerCase();
  return state.referenceLists.find((item) => item.type === normalized) || null;
}

function getWorkingReferenceList(type) {
  const normalized = String(type || "").trim().toLowerCase();
  const source = Array.isArray(state.analysis.reviewWorkingLists) && state.analysis.reviewWorkingLists.length
    ? state.analysis.reviewWorkingLists
    : state.referenceLists;
  return source.find((item) => item.type === normalized) || null;
}

function backfillMissingReviewListTypes() {
  const expectedTypes = ["nhcl", "rfc", "dnm", "candidate"];
  const baselineSource = Array.isArray(state.analysis.reviewBaselineLists) && state.analysis.reviewBaselineLists.length
    ? state.analysis.reviewBaselineLists
    : state.referenceLists;
  const workingSource = Array.isArray(state.analysis.reviewWorkingLists) && state.analysis.reviewWorkingLists.length
    ? state.analysis.reviewWorkingLists
    : [];

  if (!Array.isArray(baselineSource) || !baselineSource.length) {
    return;
  }

  const baselineTypes = new Set(baselineSource.map((entry) => String(entry?.type || "").trim().toLowerCase()).filter(Boolean));
  const workingTypes = new Set(workingSource.map((entry) => String(entry?.type || "").trim().toLowerCase()).filter(Boolean));

  let baselineChanged = false;
  let workingChanged = false;
  const nextBaseline = cloneData(baselineSource);
  const nextWorking = cloneData(workingSource);

  expectedTypes.forEach((type) => {
    if (!baselineTypes.has(type)) {
      const liveMatch = ensureArray(state.referenceLists).find((entry) => String(entry?.type || "").trim().toLowerCase() === type);
      if (liveMatch) {
        nextBaseline.push(cloneData(liveMatch));
        baselineTypes.add(type);
        baselineChanged = true;
      }
    }
  });

  expectedTypes.forEach((type) => {
    if (workingTypes.has(type)) {
      return;
    }
    const baselineMatch = nextBaseline.find((entry) => String(entry?.type || "").trim().toLowerCase() === type);
    if (baselineMatch) {
      nextWorking.push(cloneData(baselineMatch));
      workingTypes.add(type);
      workingChanged = true;
    }
  });

  if (baselineChanged) {
    state.analysis.reviewBaselineLists = nextBaseline;
  }
  if (workingChanged) {
    state.analysis.reviewWorkingLists = nextWorking;
  }
}

function ensureComparisonReviewWorkingLists() {
  if (
    Array.isArray(state.analysis.reviewBaselineLists)
    && state.analysis.reviewBaselineLists.length
    && Array.isArray(state.analysis.reviewWorkingLists)
    && state.analysis.reviewWorkingLists.length
  ) {
    backfillMissingReviewListTypes();
    return;
  }

  const baseline = cloneData(state.referenceLists || []);
  state.analysis.reviewBaselineLists = baseline;
  state.analysis.reviewWorkingLists = cloneData(baseline);
  backfillMissingReviewListTypes();
}

function hasReviewWorkingListSeedData() {
  return (
    Array.isArray(state.analysis.reviewBaselineLists)
    && state.analysis.reviewBaselineLists.length > 0
    && Array.isArray(state.analysis.reviewWorkingLists)
    && state.analysis.reviewWorkingLists.length > 0
  );
}

async function loadReferenceLists() {
  const payload = await apiRequest("/api/analysis/reference-lists");
  state.referenceLists = payload.lists || [];
  return state.referenceLists;
}

function renderMailingListMeta(list) {
  const name = el("mailing-list-name");
  const source = el("mailing-list-source");
  const updated = el("mailing-list-updated");
  const count = el("mailing-list-count");
  const dnmStateManager = el("dnm-state-manager");
  const importRow = el("mailing-list-import-row");
  const dnmHeader = el("mailing-list-import-instructions");
  const importBtn = el("mailing-list-export-button");
  const mailerExportBtn = el("mailing-list-mailer-export-button");
  const dnmExportBtn = el("dnm-export-button");

  if (name) name.textContent = list?.name || "Mailing List";
  if (source) source.textContent = `Source: ${list?.sourceName || "Managed in app"}`;
  if (updated) updated.textContent = `Updated: ${formatDate(list?.updatedAt)}`;
  if (count) count.textContent = `Count: ${list?.count || 0}`;

  const isDnm = list?.type === "dnm";
  show(dnmStateManager, isDnm);
  show(importRow, !isDnm);

  if (dnmHeader) {
    dnmHeader.textContent = isDnm
      ? "DNM states are managed from the state selector."
      : "Import the current list from NHCL or RFC spreadsheet format.";
  }

  if (isDnm) {
    show(importBtn, false);
    show(mailerExportBtn, false);
    show(dnmExportBtn, true);
    if (dnmExportBtn) dnmExportBtn.textContent = "Export DNM List";
  } else {
    show(importBtn, true);
    show(mailerExportBtn, true);
    show(dnmExportBtn, false);
    if (importBtn) {
      importBtn.textContent = `Export ${(list?.name || list?.type || "list").toUpperCase()} List`;
    }
    if (mailerExportBtn) {
      mailerExportBtn.textContent = `Export ${String(list?.type || "list").toUpperCase()} for Mailer`;
    }
  }
}

async function openAnalysisMailingList(listType) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  if (!["dnm", "nhcl", "rfc"].includes(normalizedType)) {
    return;
  }
  setAnalysisLeftSubmenuExpanded(true);
  state.analysis.panel = "workspace";
  state.analysis.subtab = "mailing-lists";
  state.analysis.mailingListType = normalizedType;
  persistUiState();
  setRoute("analysis");
  showAnalysisPanel("workspace");
  setAnalysisSubtab("mailing-lists");
  setMailingListTab(normalizedType);
  await loadAndRenderMailingList(normalizedType);
}

function renderDnmStateSelect(list) {
  const select = el("dnm-state-select");
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option("Select a state", ""));
  const states = list?.availableStateGroups || [];
  states.forEach((stateGroup) => {
    select.appendChild(new Option(stateGroup.label || stateGroup.state, stateGroup.key));
  });
  select.disabled = states.length === 0;
}

function updateMailingListViewTabs() {
  const activeTab = String(state.analysis.mailingListViewTab || "current").trim().toLowerCase() === "history"
    ? "history"
    : "current";
  state.analysis.mailingListViewTab = activeTab;
  all("[data-mailing-list-view-tab]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.getAttribute("data-mailing-list-view-tab") === activeTab
    );
  });
  show(el("mailing-list-current-panel"), activeTab === "current");
  show(el("mailing-list-history-panel"), activeTab === "history");
}

function buildBucketedMailingRows(items = []) {
  const maxRowsByBucket = {};
  const bucketMap = new Map();

  for (let digit = 0; digit <= 9; digit += 1) {
    bucketMap.set(String(digit), []);
  }

  items.forEach((entry) => {
    const scf = normalizeScf(entry.scf);
    if (!scf) return;
    const digit = scf.charAt(0);
    if (!bucketMap.has(digit)) return;
    bucketMap.get(digit).push({
      scf,
      state: normalizeState(entry.state || entry.scope || ""),
    });
  });

  for (let digit = 0; digit <= 9; digit += 1) {
    const key = String(digit);
    const sorted = bucketMap.get(key).sort((a, b) => a.scf.localeCompare(b.scf));
    bucketMap.set(key, sorted);
    maxRowsByBucket[key] = sorted.length;
  }

  const maxRows = Math.max(...Object.values(maxRowsByBucket), 0);
  return { bucketMap, maxRows };
}

function renderMailingListRowsInto(list, options = {}) {
  const tbody = options.tbodyId ? el(options.tbodyId) : el("mailing-list-body");
  const head = options.headId ? el(options.headId) : el("mailing-list-table-head");
  if (!tbody) return;
  const query = String(options.query ?? state.analysis.search ?? "").toLowerCase();
  const isDnm = list?.type === "dnm";
  const allowRemoval = options.allowRemoval !== false;
  const emptyMessage = String(options.emptyMessage || "").trim();

  if (head) {
    head.innerHTML = isDnm
      ? "<tr><th>State</th><th>SCFs</th><th></th></tr>"
      : "<tr>" +
        Array.from({ length: 10 }, (_, digit) => `<th>${digit}</th>`).join("") +
        "</tr>";
  }

  tbody.innerHTML = "";
  if (isDnm) {
    const groups = Array.isArray(list?.stateGroups) ? list.stateGroups : [];
    const filteredGroups = groups
      .filter((group) => group.isActive)
      .filter((group) => {
        const stateName = String(group.state || group.label || "").toLowerCase();
        const scfText = String(group.scfText || "").toLowerCase();
        return !query || stateName.includes(query) || scfText.includes(query);
      })
      .sort((a, b) => String(a.state || a.label || "").localeCompare(String(b.state || b.label || "")));

    if (!filteredGroups.length) {
      const row = document.createElement("tr");
      row.innerHTML =
        '<td colspan="3" class="empty-cell">' +
        (query ? "No matches for this search." : emptyMessage || "No states in this list.") +
        "</td>";
      tbody.appendChild(row);
      return;
    }

    filteredGroups.forEach((group) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(group.state || group.label || "")}</td><td>${esc(group.scfText || "")}</td>
        <td class="table-action-cell">${
          allowRemoval
            ? `<button data-action="delete-dnm-state" data-state-key="${esc(group.key || "")}"
        class="secondary-button table-action-button">Remove State</button>`
            : ""
        }</td>`;
      tbody.appendChild(tr);
    });
    return;
  }

  const items = Array.isArray(list?.items) ? list.items : [];
  const filtered = items
    .filter((entry) => {
      const scf = String(entry.scf || "").toLowerCase();
      const st = String(entry.state || entry.scope || "").toLowerCase();
      return !query || scf.includes(query) || st.includes(query);
    })
    .sort((a, b) => String(a.scf).localeCompare(String(b.scf)));

  if (!filtered.length) {
    const row = document.createElement("tr");
    row.innerHTML =
      `<td colspan="${isDnm ? 3 : 10}" class="empty-cell">` +
      (query ? "No matches for this search." : emptyMessage || "No records in this list.") +
      "</td>";
    tbody.appendChild(row);
    return;
  }

  const { bucketMap, maxRows } = buildBucketedMailingRows(filtered);
  for (let rowOffset = 0; rowOffset < maxRows; rowOffset += 1) {
    const tr = document.createElement("tr");
    tr.innerHTML = Array.from({ length: 10 }, (_, digit) => {
      const entry = bucketMap.get(String(digit))?.[rowOffset];
      if (!entry) {
        return "<td></td>";
      }
      const displayValue = entry.state ? `${entry.scf} ${entry.state}` : entry.scf;
      const removeMarkup = allowRemoval
        ? `<button data-action="delete-list-item" data-scf="${esc(entry.scf)}" class="secondary-button mailing-list-grid-remove">Remove</button>`
        : "";
      return (
        `<td class="mailing-list-grid-cell">` +
        `<div class="mailing-list-grid-entry">` +
        `<span class="mailing-list-grid-text">${esc(displayValue)}</span>` +
        removeMarkup +
        `</div>` +
        `</td>`
      );
    }).join("");
    tbody.appendChild(tr);
  }
}

function renderMailingListRows(list) {
  renderMailingListRowsInto(list, {
    headId: "mailing-list-table-head",
    tbodyId: "mailing-list-body",
    query: state.analysis.search || "",
    allowRemoval: true,
  });
}

function getMailingListHistoryActionLabel(actionType) {
  const normalized = String(actionType || "").trim().toLowerCase();
  const labels = {
    "analysis-complete": "Analysis Complete",
    "import-replace": "Import Replace",
    "manual-add": "Manual Add",
    "manual-remove": "Manual Remove",
    "manual-add-state": "Add State",
    "manual-remove-state": "Remove State",
    "restore-analysis-delete": "Restore on Delete",
    "undo-analysis-complete": "Undo Analysis Complete",
  };
  return labels[normalized] || normalized || "Update";
}

function legacyRenderMailingListHistoryPreview(listType, preview = null) {
  const container = el("mailing-list-history-preview");
  if (!container) {
    return;
  }
  if (!preview || !preview.snapshotType) {
    container.innerHTML = '<div class="empty-state-block">Choose a history snapshot to preview what the list looked like.</div>';
    return;
  }

  const items = Array.isArray(preview.items) ? preview.items : [];
  container.innerHTML = `
    <article class="panel analysis-review-summary-card">
      <h4>${esc(preview.snapshotType === "before" ? "Before Snapshot" : "After Snapshot")} · ${esc(preview.changedAt ? formatDate(preview.changedAt) : "")}</h4>
      <p>${esc(getMailingListHistoryActionLabel(preview.actionType))}${preview.sourceName ? ` · ${esc(preview.sourceName)}` : ""}</p>
      ${buildMailingListPreviewMarkup(listType, items)}
    </article>
  `;
}

function renderMailingListHistory(list) {
  const tbody = el("mailing-list-history-body");
  if (!tbody) {
    return;
  }
  const history = Array.isArray(list?.history) ? list.history : [];
  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No history yet.</td></tr>';
    renderMailingListHistoryPreview(list?.type || "", null);
    return;
  }

  tbody.innerHTML = history
    .slice(0, 20)
    .map((entry) => `
      <tr>
        <td>${esc(formatDate(entry.changedAt || entry.changed_at || ""))}</td>
        <td>${esc(getMailingListHistoryActionLabel(entry.actionType))}</td>
        <td>${esc(entry.sourceName || entry.actor || "-")}</td>
        <td>${Number((entry.beforeItems || []).length || 0)}</td>
        <td>${Number((entry.afterItems || []).length || 0)}</td>
        <td class="action-row">
          <button class="secondary-button table-action-button" data-mailing-history-preview="before" data-history-id="${esc(entry.id || "")}">Preview Before</button>
          <button class="secondary-button table-action-button" data-mailing-history-preview="after" data-history-id="${esc(entry.id || "")}">Preview After</button>
        </td>
      </tr>
    `)
    .join("");

  const preview = state.analysis.mailingListHistoryPreview;
  if (preview && history.some((entry) => entry.id === preview.historyId)) {
    renderMailingListHistoryPreview(list?.type || "", preview);
    return;
  }
  renderMailingListHistoryPreview(list?.type || "", null);
}

function renderMailingListHistoryPreview(listType, preview = null) {
  const title = el("mailing-list-history-preview-title");
  const source = el("mailing-list-history-preview-source");
  const updated = el("mailing-list-history-preview-updated");
  const count = el("mailing-list-history-preview-count");
  const head = el("mailing-list-history-preview-head");
  const body = el("mailing-list-history-preview-body");
  if (!title || !source || !updated || !count || !body) {
    return;
  }
  if (!preview || !preview.snapshotType) {
    title.textContent = "Choose a snapshot";
    source.textContent = "Select Before or After to preview the list.";
    updated.textContent = "";
    count.textContent = "";
    if (head) {
      head.innerHTML = "<tr><th>SCF</th><th>State</th></tr>";
    }
    body.innerHTML = '<tr><td colspan="2" class="empty-cell">Choose a history snapshot to preview what the list looked like.</td></tr>';
    return;
  }

  const items = Array.isArray(preview.items) ? preview.items : [];
  title.textContent = preview.snapshotType === "before" ? "Before Snapshot" : "After Snapshot";
  source.textContent = `${getMailingListHistoryActionLabel(preview.actionType)}${preview.sourceName ? ` · ${preview.sourceName}` : ""}`;
  updated.textContent = preview.changedAt ? `Changed: ${formatDate(preview.changedAt)}` : "";
  count.textContent = `Count: ${items.length}`;
  renderMailingListRowsInto(
    {
      type: listType,
      items,
      stateGroups: preview.stateGroups || [],
    },
    {
      headId: "mailing-list-history-preview-head",
      tbodyId: "mailing-list-history-preview-body",
      query: "",
      allowRemoval: false,
      emptyMessage: "No items in this snapshot.",
    }
  );
}

async function removeDnmState(stateKey) {
  const key = String(stateKey || "").trim();
  if (!key) return;
  if (!confirm("Remove this state from the Do Not Mail list?")) return;
  try {
    await apiRequest(`/api/analysis/reference-lists/dnm/states/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    await loadAndRenderMailingList("dnm");
    setStatus("mailing-list-status", "State removed.");
  } catch (error) {
    setStatus("mailing-list-status", `Unable to remove state: ${error.message}`);
  }
}

function renderMailingList(list) {
  renderMailingListMeta(list);
  renderDnmStateSelect(list);
  renderMailingListRows(list);
  renderMailingListHistory(list);
  updateMailingListViewTabs();
}

async function loadAndRenderMailingList(type) {
  const normalizedType = (type || "").toLowerCase();
  setStatus("mailing-list-status", "Loading mailing list...");
  try {
    const payload = await apiRequest(`/api/analysis/reference-lists/${normalizedType}`);
    state.analysis.mailingListType = normalizedType;
    state.analysis.mailingListHistoryPreview = null;
    state.referenceLists = state.referenceLists.filter((item) => item.type !== normalizedType);
    state.referenceLists.push(payload.list);
    renderMailingList(payload.list);
    updateMailingTabButtons(normalizedType);
    setStatus("mailing-list-status", `${normalizedType.toUpperCase()} list loaded.`);
  } catch (error) {
    setStatus("mailing-list-status", `Unable to load ${normalizedType.toUpperCase()}: ${error.message}`);
  }
}

function updateMailingTabButtons(type) {
  all("[data-mailing-list-tab]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.getAttribute("data-mailing-list-tab") === type
    );
  });
  updateAnalysisLeftSubmenuActiveState();
}

async function exportCurrentMailingList() {
  const type = state.analysis.mailingListType;
  const btn = type === "dnm" ? el("dnm-export-button") : el("mailing-list-export-button");
  if (!btn) return;
  btn.disabled = true;
  setStatus("mailing-list-status", `Exporting ${type.toUpperCase()}...`);
  try {
    await apiDownload(`/api/analysis/reference-lists/${type}/export`, `${type}.xlsx`);
    setStatus("mailing-list-status", `${type.toUpperCase()} export ready.`);
  } catch (error) {
    setStatus("mailing-list-status", `Export failed: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function addMailingListEntry() {
  const scfRaw = el("mailing-list-add-scf")?.value || "";
  const scf = normalizeScf(scfRaw);
  const stateValue = (el("mailing-list-state")?.value || "").trim();
  if (!scf) {
    setStatus("mailing-list-status", "Add a valid 3-digit SCF first.");
    return;
  }

  const button = el("mailing-list-add-button");
  if (button) button.disabled = true;
  setStatus("mailing-list-status", "Saving...");
  try {
    await apiRequest(`/api/analysis/reference-lists/${state.analysis.mailingListType}/items`, {
      method: "POST",
      body: {
        scfs: [scf],
        state: stateValue,
        actor: "Local User",
        sourceName: "manual-list-manager",
      },
    });
    if (el("mailing-list-add-scf")) el("mailing-list-add-scf").value = "";
    if (el("mailing-list-state")) el("mailing-list-state").value = "";
    await loadAndRenderMailingList(state.analysis.mailingListType);
  } catch (error) {
    setStatus("mailing-list-status", `Add failed: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function addDnmState() {
  const key = (el("dnm-state-select")?.value || "").trim();
  if (!key) {
    setStatus("mailing-list-status", "Pick a state to add.");
    return;
  }
  try {
    await apiRequest(`/api/analysis/reference-lists/dnm/states/${encodeURIComponent(key)}`, {
      method: "POST",
      body: {
        reason: (el("mailing-list-reason")?.value || "").trim(),
        sourceName: (el("mailing-list-source-name")?.value || "").trim() || "manual-list-manager",
        actor: "Local User",
      },
    });
    await loadAndRenderMailingList("dnm");
    setStatus("mailing-list-status", "State added.");
  } catch (error) {
    setStatus("mailing-list-status", `Unable to add state: ${error.message}`);
  }
}

async function removeMailingListItem(scf) {
  const type = state.analysis.mailingListType;
  const formatted = normalizeScf(scf);
  if (!formatted) return;
  if (!confirm(`Remove SCF ${formatted} from ${type.toUpperCase()} list?`)) return;
  try {
    await apiRequest(`/api/analysis/reference-lists/${type}/items/${encodeURIComponent(formatted)}`, {
      method: "DELETE",
    });
    await loadAndRenderMailingList(type);
    setStatus("mailing-list-status", `Removed SCF ${formatted}.`);
  } catch (error) {
    setStatus("mailing-list-status", `Unable to remove: ${error.message}`);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",")[1] : value);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function importReferenceList() {
  const listType = state.analysis.mailingListType;
  if (!["nhcl", "rfc"].includes(listType)) {
    setStatus("mailing-list-status", "Import is only available for NHCL and RFC.");
    return;
  }
  const input = el("mailing-list-import-input");
  const file = input?.files?.[0];
  if (!file) return;
  setStatus("mailing-list-status", "Importing...");
  try {
    const base64Content = await fileToBase64(file);
    const payload = await apiRequest("/api/analysis/reference-lists/import", {
      method: "POST",
      body: {
        listType,
        fileName: file.name,
        base64Content,
        actor: "Local User",
      },
    });
    await loadReferenceLists();
    await loadAndRenderMailingList(listType);
    const result = payload.result || {};
    setStatus(
      "mailing-list-status",
      `Import complete. Added ${result.addedCount || 0}, skipped duplicates ${
        result.skippedDuplicateCount || 0
      }, skipped Do Not Mail ${result.skippedDoNotMailCount || 0}, total ${
        result.totalSavedCount || 0
      }.`
    );
  } catch (error) {
    setStatus("mailing-list-status", `Import failed: ${error.message}`);
  } finally {
    if (input) input.value = "";
  }
}

function getCurrentCcPaymentSession() {
  return state.ccPayments.currentSession || null;
}

function getSelectedCcPaymentTemplate() {
  const templates = Array.isArray(state.ccPayments.templates) ? state.ccPayments.templates : [];
  const selectedKey = String(state.ccPayments.selectedTemplateKey || "").trim();
  return (
    templates.find((entry) => entry.key === selectedKey) ||
    templates[0] ||
    null
  );
}

function renderCcPaymentTemplatePicker() {
  const select = el("cc-payment-template-select");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  const templates = Array.isArray(state.ccPayments.templates) ? state.ccPayments.templates : [];
  const selectedTemplate =
    getSelectedCcPaymentTemplate() ||
    null;
  const selectedKey = selectedTemplate?.key || "";
  state.ccPayments.selectedTemplateKey = selectedKey;

  select.innerHTML = templates.length
    ? templates
        .map(
          (template) => `<option value="${esc(template.key)}"${template.key === selectedKey ? " selected" : ""}>${esc(template.name)}</option>`
        )
        .join("")
    : '<option value="">No templates loaded</option>';

  const session = getCurrentCcPaymentSession();
  const activeTemplate = session?.template?.key ? session.template : selectedTemplate;
  if (activeTemplate?.salesforceObjectApiName) {
    setStatus(
      "cc-payment-template-status",
      `${activeTemplate.name} -> ${activeTemplate.salesforceObjectApiName} (${activeTemplate.operationType || "insert"})`
    );
  } else {
    setStatus("cc-payment-template-status", "No active import template loaded.");
  }
}

function updateCcPaymentFilterButtons() {
  all("[data-cc-filter]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.getAttribute("data-cc-filter") === state.ccPayments.filter
    );
  });
}

function getMailingDataUploads() {
  return ensureArray(state.mailingData.fileSlots)
    .map((entry) => ({
      fileName: String(entry?.fileName || "").trim(),
      base64Content: String(entry?.base64Content || "").trim(),
    }))
    .filter((entry) => entry.fileName && entry.base64Content);
}

function renderMailingDataPage() {
  const monthInput = el("mailing-data-month");
  if (monthInput && monthInput.value !== String(state.mailingData.mailingMonth || "")) {
    monthInput.value = String(state.mailingData.mailingMonth || "");
  }

  const caseInput = el("mailing-data-starting-case-number");
  if (caseInput && caseInput.value !== String(state.mailingData.startingCaseNumber || "")) {
    caseInput.value = String(state.mailingData.startingCaseNumber || "");
  }

  const file1Name = el("mailing-data-file-1-name");
  const file2Name = el("mailing-data-file-2-name");
  if (file1Name) {
    file1Name.textContent = state.mailingData.fileSlots[0]?.fileName
      ? `Selected: ${state.mailingData.fileSlots[0].fileName}`
      : "No ZIP file selected yet.";
  }
  if (file2Name) {
    file2Name.textContent = state.mailingData.fileSlots[1]?.fileName
      ? `Selected: ${state.mailingData.fileSlots[1].fileName}`
      : "No ZIP file selected yet.";
  }

  const previewBody = el("mailing-data-preview-body");
  const previewSummary = el("mailing-data-preview-summary");
  const preview = state.mailingData.preview;
  if (previewBody) {
    if (!preview?.uploads?.length) {
      previewBody.innerHTML = '<tr><td colspan="8" class="empty-cell">Run preview to see the combined workbook details.</td></tr>';
    } else {
      previewBody.innerHTML = preview.uploads.map((upload) => `
        <tr>
          <td>${esc(upload.fileName || "")}</td>
          <td>${esc(upload.keyCode || "")}</td>
          <td>${esc(Number(upload.recordCount || 0).toLocaleString())}</td>
          <td>${esc(upload.startingSequence || "")}</td>
          <td>${esc(upload.endingSequence || "")}</td>
          <td>${esc(upload.startingCaseNumber || "")}</td>
          <td>${esc(upload.endingCaseNumber || "")}</td>
          <td>${esc(formatShortDate(upload.mailDate || preview.mailDate || ""))}</td>
        </tr>
      `).join("");
    }
  }

  if (previewSummary) {
    if (!preview) {
      previewSummary.innerHTML = "";
    } else {
      previewSummary.innerHTML = `
        <div class="summary-chip"><strong>Output File</strong><span>${esc(preview.outputFileName || "")}</span></div>
        <div class="summary-chip"><strong>Total Records</strong><span>${esc(Number(preview.totalRecords || 0).toLocaleString())}</span></div>
        <div class="summary-chip"><strong>Starting Case</strong><span>${esc(preview.startingCaseNumber || "")}</span></div>
        <div class="summary-chip"><strong>Ending Case</strong><span>${esc(preview.endingCaseNumber || "")}</span></div>
        <div class="summary-chip"><strong>Mail Date</strong><span>${esc(formatShortDate(preview.mailDate || ""))}</span></div>
      `;
    }
  }

  const historyBody = el("mailing-data-history-body");
  if (historyBody) {
    const history = ensureArray(state.mailingData.history);
    if (!history.length) {
      historyBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No Mailing Data history yet.</td></tr>';
    } else {
      historyBody.innerHTML = history.map((entry) => `
        <tr>
          <td>${esc(formatDate(entry.generatedAt || ""))}</td>
          <td>${esc(entry.outputFileName || "")}</td>
          <td>${esc(entry.mailingMonthLabel || entry.mailingMonth || "")}</td>
          <td>${esc(Number(entry.totalRecords || 0).toLocaleString())}</td>
          <td>${esc(entry.startingCaseNumber || "")}</td>
          <td>${esc(entry.endingCaseNumber || "")}</td>
          <td class="table-action-cell">
            <button class="secondary-button table-action-button" data-mailing-data-download="${esc(entry.id || "")}">Download</button>
            ${history[0]?.id === entry.id
              ? `<button class="secondary-button table-action-button" data-mailing-data-delete="${esc(entry.id || "")}">Delete Most Recent</button>`
              : ""}
          </td>
        </tr>
      `).join("");
    }
  }
}

async function loadMailingDataPage() {
  const payload = await apiRequest("/api/mailing-data");
  const serverHistory = Array.isArray(payload.history) ? payload.history : [];
  const persistedHistory = readPersistedMailingDataHistory();
  state.mailingData.history = serverHistory.length ? serverHistory : persistedHistory;
  if (state.mailingData.history.length) {
    persistMailingDataHistory(state.mailingData.history);
  }
  const fallbackNextCaseNumber = state.mailingData.history.reduce((maxValue, entry) => {
    const candidate = Number(entry?.endingCaseNumber || 0);
    return Number.isFinite(candidate) && candidate > maxValue ? candidate : maxValue;
  }, 65782402) + 1;
  state.mailingData.nextCaseNumber = String(payload.nextCaseNumber || fallbackNextCaseNumber || "");
  if (!state.mailingData.startingCaseNumber && state.mailingData.nextCaseNumber) {
    state.mailingData.startingCaseNumber = state.mailingData.nextCaseNumber;
  }
  if (!state.mailingData.mailingMonth) {
    state.mailingData.mailingMonth = todayIsoDate().slice(0, 7);
  }
  renderMailingDataPage();
}

async function runMailingDataPreview() {
  const uploads = getMailingDataUploads();
  if (!uploads.length) {
    setStatus("mailing-data-status", "Select the ZIP files first.");
    return;
  }
  setStatus("mailing-data-progress-status", "Extracting zip...");
  setStatus("mailing-data-status", "Preparing Mailing Data preview...");
  try {
    const payload = await apiRequest("/api/mailing-data/preview", {
      method: "POST",
      body: {
        uploads,
        mailingMonth: state.mailingData.mailingMonth,
        startingCaseNumber: state.mailingData.startingCaseNumber,
      },
    });
    state.mailingData.preview = payload.preview || null;
    state.mailingData.nextCaseNumber = String(payload.nextCaseNumber || state.mailingData.nextCaseNumber || "");
    renderMailingDataPage();
    setStatus("mailing-data-progress-status", "Complete");
    setStatus("mailing-data-status", "Mailing Data preview is ready.");
  } catch (error) {
    setStatus("mailing-data-progress-status", "");
    setStatus("mailing-data-status", `Preview failed: ${error.message}`);
  }
}

async function generateMailingDataWorkbook() {
  const uploads = getMailingDataUploads();
  if (!uploads.length) {
    setStatus("mailing-data-status", "Select the ZIP files first.");
    return;
  }
  setStatus("mailing-data-progress-status", "Building workbook...");
  setStatus("mailing-data-status", "Generating Mailing Data workbook...");
  try {
    const payload = await apiRequest("/api/mailing-data/generate", {
      method: "POST",
      body: {
        uploads,
        mailingMonth: state.mailingData.mailingMonth,
        startingCaseNumber: state.mailingData.startingCaseNumber,
      },
    });
    state.mailingData.history = payload.history || [];
    persistMailingDataHistory(state.mailingData.history);
    state.mailingData.preview = null;
    state.mailingData.nextCaseNumber = String(payload.nextCaseNumber || state.mailingData.nextCaseNumber || "");
    state.mailingData.startingCaseNumber = String(
      payload.nextCaseNumber || state.mailingData.nextCaseNumber || state.mailingData.startingCaseNumber || ""
    );
    state.mailingData.fileSlots = [
      { fileName: "", base64Content: "" },
      { fileName: "", base64Content: "" },
    ];
    const entry = payload.historyEntry || null;
    renderMailingDataPage();
    setStatus("mailing-data-progress-status", "Complete");
    setStatus("mailing-data-status", entry
      ? `${entry.outputFileName} generated successfully.`
      : "Mailing Data workbook generated successfully.");
    if (entry?.id) {
      await apiDownload(`/api/mailing-data/${encodeURIComponent(entry.id)}/download`, entry.outputFileName || "mailing-data.xlsx");
    }
  } catch (error) {
    setStatus("mailing-data-progress-status", "");
    setStatus("mailing-data-status", `Generation failed: ${error.message}`);
  }
}

function bindMailingDataEvents() {
  const bindUploadInput = (inputId, slotIndex) => {
    el(inputId)?.addEventListener("change", async (event) => {
      const input = event.target;
      const file = input?.files?.[0];
      if (!file) return;
      try {
        const base64Content = await fileToBase64(file);
        state.mailingData.fileSlots[slotIndex] = {
          fileName: file.name,
          base64Content,
        };
        state.mailingData.preview = null;
        renderMailingDataPage();
        setStatus("mailing-data-status", `${file.name} selected.`);
      } catch (error) {
        setStatus("mailing-data-status", `Unable to read ${file.name}: ${error.message}`);
      } finally {
        if (input) input.value = "";
      }
    });
  };

  bindUploadInput("mailing-data-file-1", 0);
  bindUploadInput("mailing-data-file-2", 1);

  el("mailing-data-month")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    state.mailingData.mailingMonth = target.value || "";
    state.mailingData.preview = null;
  });

  el("mailing-data-starting-case-number")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    state.mailingData.startingCaseNumber = target.value || "";
    state.mailingData.preview = null;
  });

  el("mailing-data-next-case-button")?.addEventListener("click", () => {
    state.mailingData.startingCaseNumber = state.mailingData.nextCaseNumber || state.mailingData.startingCaseNumber;
    state.mailingData.preview = null;
    renderMailingDataPage();
    setStatus("mailing-data-status", `Starting case number set to ${state.mailingData.startingCaseNumber}.`);
  });

  el("mailing-data-preview-button")?.addEventListener("click", () => {
    void runMailingDataPreview();
  });

  el("mailing-data-generate-button")?.addEventListener("click", () => {
    void generateMailingDataWorkbook();
  });

  el("mailing-data-history-body")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const deleteEntryId = target.getAttribute("data-mailing-data-delete");
    if (deleteEntryId) {
      const entry = ensureArray(state.mailingData.history).find((item) => item.id === deleteEntryId);
      if (!entry) {
        setStatus("mailing-data-status", "Unable to find that Mailing Data run.");
        return;
      }
      if (!confirm(`Delete the most recent Mailing Data run ${entry.outputFileName || ""}?`)) {
        return;
      }
      void apiRequest(`/api/mailing-data/${encodeURIComponent(deleteEntryId)}`, {
        method: "DELETE",
        body: {},
      }).then((payload) => {
        state.mailingData.history = payload.history || [];
        persistMailingDataHistory(state.mailingData.history);
        state.mailingData.nextCaseNumber = String(payload.nextCaseNumber || state.mailingData.nextCaseNumber || "");
        state.mailingData.preview = null;
        const resetToDeletedStart = confirm(
          `Do you want to reset the Starting Case Number back to ${entry.startingCaseNumber}?`
        );
        if (resetToDeletedStart) {
          state.mailingData.startingCaseNumber = String(entry.startingCaseNumber || "");
        } else if (!state.mailingData.startingCaseNumber) {
          state.mailingData.startingCaseNumber = state.mailingData.nextCaseNumber || "";
        }
        renderMailingDataPage();
        setStatus("mailing-data-status", "Most recent Mailing Data run deleted.");
      }).catch((error) => {
        setStatus("mailing-data-status", `Delete failed: ${error.message}`);
      });
      return;
    }
    const entryId = target.getAttribute("data-mailing-data-download");
    if (!entryId) return;
    const entry = ensureArray(state.mailingData.history).find((item) => item.id === entryId);
    void apiDownload(
      `/api/mailing-data/${encodeURIComponent(entryId)}/download`,
      entry?.outputFileName || "mailing-data.xlsx"
    ).catch((error) => {
      setStatus("mailing-data-status", `Download failed: ${error.message}`);
    });
  });
}

function getCcPaymentFilteredRows() {
  const session = getCurrentCcPaymentSession();
  const rows = Array.isArray(session?.rows) ? session.rows.slice() : [];
  const filter = state.ccPayments.filter || "all";
  const filtered = rows.filter((row) => {
    if (filter === "ready") {
      return row.status === "ready";
    }
    if (filter === "missing_policy") {
      return Array.isArray(row.issue_details) && row.issue_details.some((issue) => issue.code === "missing_policy_id");
    }
    if (filter === "errors") {
      return row.status === "error";
    }
    if (filter === "warnings") {
      return row.status === "warning";
    }
    return true;
  });

  const severityRank = (row) => (row.status === "error" ? 0 : row.status === "warning" ? 1 : 2);
  return filtered.sort((a, b) => {
    const severityDiff = severityRank(a) - severityRank(b);
    if (severityDiff !== 0) return severityDiff;
    return Number(a.row_number || 0) - Number(b.row_number || 0);
  });
}

function renderCcPaymentSummary() {
  const session = getCurrentCcPaymentSession();
  el("cc-payment-summary-total").textContent = String(session?.row_count || 0);
  el("cc-payment-summary-ready").textContent = String(session?.ready_count || 0);
  el("cc-payment-summary-missing-policy").textContent = String(session?.missing_policy_count || 0);
  el("cc-payment-summary-errors").textContent = String(session?.error_count || 0);
  el("cc-payment-summary-warnings").textContent = String(session?.warning_count || 0);

  const validationMessage = el("cc-payment-validation-message");
  if (!validationMessage) return;

  if (!session) {
    validationMessage.textContent = "Upload a file to begin validation, or open a session from Import History.";
    return;
  }

  if (["imported", "imported_with_errors"].includes(String(session.final_status || ""))) {
    validationMessage.textContent = `This import is complete. ${Number(session.imported_row_count || session.successful_import_count || 0)} row(s) were imported into Salesforce. Open it from Import History any time.`;
    return;
  }

  if (Number(session.missing_policy_count || 0) > 0) {
    validationMessage.textContent =
      "These rows are missing a Policy ID. Fix them before confirming the Salesforce import.";
    return;
  }

  if (Number(session.error_count || 0) > 0) {
    validationMessage.textContent = "Resolve the blocking validation errors before confirming import.";
    return;
  }

  if (Number(session.warning_count || 0) > 0) {
    validationMessage.textContent = "Warnings are present. Review flagged rows before confirming import.";
    return;
  }

  validationMessage.textContent = "All rows are ready for Salesforce import.";
}

function renderCcPaymentHistory() {
  const tbody = el("cc-payment-history-body");
  if (!tbody) return;
  const sessions = Array.isArray(state.ccPayments.sessions) ? state.ccPayments.sessions : [];
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">No credit card payment import sessions yet.</td></tr>';
    return;
  }

  tbody.innerHTML = sessions
    .map((session) => `
      <tr class="${state.ccPayments.currentSessionId === session.id ? "is-selected-row" : ""}">
        <td>${esc(formatDate(session.uploaded_at || session.uploadedAt))}</td>
        <td>${esc(session.original_filename || "")}</td>
        <td>${Number(session.row_count || 0)}</td>
        <td>${Number(session.imported_row_count || session.successful_import_count || 0)}</td>
        <td>${Number(session.ready_count || 0)}</td>
        <td>${Number(session.error_count || 0)}</td>
        <td>${Number(session.warning_count || 0)}</td>
        <td>${esc(formatDate(session.exported_at || session.exportedAt))}</td>
        <td>${esc(session.uploaded_by || "")}</td>
        <td class="table-action-cell">
          <button class="secondary-button table-action-button" data-cc-open-session="${esc(session.id)}">Open</button>
          ${
            Number(session.imported_row_count || session.successful_import_count || 0) > 0
              ? ""
              : `<button class="secondary-button table-action-button danger-button" data-cc-delete-session="${esc(session.id)}">Delete</button>`
          }
        </td>
      </tr>
    `)
    .join("");
}

function renderCcPaymentReviewTable() {
  const tbody = el("cc-payment-review-body");
  if (!tbody) return;
  const session = getCurrentCcPaymentSession();
  if (!session) {
    tbody.innerHTML = '<tr><td colspan="19" class="empty-cell">No credit card payment import session loaded.</td></tr>';
    return;
  }
  const isImportedSession = ["imported", "imported_with_errors"].includes(String(session.final_status || ""));

  const rows = getCcPaymentFilteredRows();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="20" class="empty-cell">No rows match the selected filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const payorName = row.payor_name || row.customer_name || "";
      const expectedAmountNote = row.expected_amount !== null && row.expected_amount !== undefined
        ? `<div class="cc-row-note">Expected ${esc(row.expected_amount_label || "premium")}: ${esc(formatApplicationCurrency(row.expected_amount))}</div>`
        : "";
      const importResultNote = row.import_result_message
        ? `<div class="cc-row-note">Import: ${esc(row.import_result_message)}</div>`
        : row.imported_salesforce_id
          ? `<div class="cc-row-note">Salesforce ID: ${esc(row.imported_salesforce_id)}</div>`
          : "";
      const issueColumn = `${esc(row.issue_reason || "")}${importResultNote}`;
      return `
        <tr class="cc-import-row is-${esc(row.status || "ready")}">
          <td>${esc(row.type || "")}</td>
          <td>${esc(row.pay_type || "")}</td>
          <td>
            <div class="field-stack">
              <strong>${esc(row.certificate_number || "")}</strong>
              ${isImportedSession ? "" : `<input class="field-input cc-inline-input" data-cc-row-field="certificate_number" data-cc-row-id="${esc(row.id)}" value="${esc(row.certificate_number || "")}" />`}
            </div>
          </td>
          <td>
            <div class="field-stack">
              <strong>${esc(row.matched_policy_id || "-")}</strong>
              ${isImportedSession ? "" : `<input class="field-input cc-inline-input" data-cc-row-field="manual_policy_id" data-cc-row-id="${esc(row.id)}" value="${esc(row.manual_policy_id || row.matched_policy_id || "")}" placeholder="Enter Policy ID" />`}
            </div>
          </td>
          <td>${esc(row.payment_name || "")}</td>
          <td>${esc(row.source_record_id || "")}</td>
          <td>${esc(row.date_received || "")}</td>
          <td>${esc(row.months || "")}</td>
          <td>
            <div class="field-stack">
              <strong>${esc(row.amount || "")}</strong>
              ${expectedAmountNote}
            </div>
          </td>
          <td>${esc(row.date_received || row.transaction_date || "")}</td>
          <td>${esc(row.batch_close_date || "")}</td>
          <td>${esc(row.transaction_id || "")}</td>
          <td>${esc(row.batch_id || "")}</td>
          <td>${esc(row.auth_code || "")}</td>
          <td>${esc(row.bill_type || "")}</td>
          <td>${esc(row.id2 || "")}</td>
          <td>${esc(payorName)}</td>
          <td><span class="cc-status-pill is-${esc(row.status || "ready")}">${esc((row.status || "ready").replace("_", " "))}</span></td>
          <td>${issueColumn}</td>
          <td class="table-action-cell">
            ${isImportedSession ? '<span class="cc-row-note">Read only</span>' : '<span class="cc-row-note">Edit rows, then save all.</span>'}
          </td>
        </tr>
      `;
    })
    .join("");
}

function updateCcPaymentPolicyStatus() {
  const session = getCurrentCcPaymentSession();
  const policyLookup = session?.policyLookup || {};
  const refreshedAt = policyLookup.refreshedAt || session?.policy_lookup_refreshed_at || "";
  const source = policyLookup.source || "";
  setStatus(
    "cc-payment-policy-status",
    refreshedAt
      ? `Policy lookup refreshed ${formatDate(refreshedAt)} from ${source || "Salesforce"}.`
      : "Policy lookup not refreshed yet."
  );
}

function updateCcPaymentExportState() {
  const session = getCurrentCcPaymentSession();
  const saveAllButton = el("cc-payment-save-all-button");
  const exportButton = el("cc-payment-export-button");
  const hasBlockingErrors = Number(session?.error_count || 0) > 0;
  const alreadyImported = ["imported", "imported_with_errors"].includes(String(session?.final_status || ""));
  const pendingEditCount = session && !alreadyImported ? collectCcPaymentRowEdits(session).length : 0;
  if (saveAllButton) {
    saveAllButton.disabled = !session || alreadyImported || pendingEditCount <= 0;
    saveAllButton.textContent = pendingEditCount > 0
      ? `Save All Corrections (${pendingEditCount})`
      : "Save All Corrections";
  }
  if (!exportButton) return;
  exportButton.disabled = !session || hasBlockingErrors || alreadyImported;
  exportButton.textContent = alreadyImported ? "Import Completed" : "Confirm Import";
}

function renderCcPaymentPage() {
  renderCcPaymentTemplatePicker();
  updateCcPaymentFilterButtons();
  renderCcPaymentSummary();
  renderCcPaymentReviewTable();
  renderCcPaymentHistory();
  updateCcPaymentPolicyStatus();
  updateCcPaymentExportState();
}

async function loadCcPaymentImportSession(sessionId) {
  const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(sessionId)}`);
  state.ccPayments.currentSessionId = payload.session?.id || sessionId;
  state.ccPayments.currentSession = payload.session || null;
  if (payload.session?.template?.key) {
    state.ccPayments.selectedTemplateKey = payload.session.template.key;
  }
  renderCcPaymentPage();
}

async function loadCcPaymentImportTemplates() {
  const payload = await apiRequest("/api/cc-payment-import-templates");
  state.ccPayments.templates = Array.isArray(payload.templates) ? payload.templates : [];
  if (!state.ccPayments.selectedTemplateKey) {
    state.ccPayments.selectedTemplateKey = state.ccPayments.templates[0]?.key || "";
  }
  renderCcPaymentTemplatePicker();
}

async function loadCcPaymentImportSessions(preferredSessionId = "") {
  const payload = await apiRequest("/api/cc-payment-imports");
  state.ccPayments.sessions = payload.sessions || [];
  const nextActiveSession = state.ccPayments.sessions.find((session) => !["imported", "imported_with_errors"].includes(String(session.final_status || ""))) || null;
  const targetSessionId =
    preferredSessionId ||
    state.ccPayments.currentSessionId ||
    nextActiveSession?.id ||
    "";
  if (targetSessionId) {
    await loadCcPaymentImportSession(targetSessionId);
    state.ccPayments.launchSessionId = "";
    return;
  }
  state.ccPayments.currentSessionId = "";
  state.ccPayments.currentSession = null;
  state.ccPayments.launchSessionId = "";
  renderCcPaymentPage();
}

async function deleteCcPaymentImportSessionById(sessionId) {
  const normalizedId = String(sessionId || "").trim();
  if (!normalizedId) {
    return;
  }

  const response = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(normalizedId)}`, {
    method: "DELETE",
  });
  state.ccPayments.sessions = Array.isArray(response.sessions) ? response.sessions : [];
  if (state.ccPayments.currentSessionId === normalizedId) {
    state.ccPayments.currentSessionId = "";
    state.ccPayments.currentSession = null;
  }
  await loadCcPaymentImportSessions("");
  setStatus("cc-payment-status", "Import session deleted.");
}

function bindCcPaymentImportEvents() {
  el("cc-payment-upload-button")?.addEventListener("click", () => {
    el("cc-payment-upload-input")?.click();
  });

  el("cc-payment-upload-input")?.addEventListener("change", async (event) => {
    const input = event.target;
    const file = input?.files?.[0];
    if (!file) return;
    const selectedTemplate = getSelectedCcPaymentTemplate();
    if (!selectedTemplate?.key) {
      setStatus("cc-payment-status", "Select an import template first.");
      return;
    }
    setStatus("cc-payment-status", "Uploading credit card payment file...");
    try {
      const base64Content = await fileToBase64(file);
      const payload = await apiRequest("/api/cc-payment-imports/upload", {
        method: "POST",
        body: {
          fileName: file.name,
          base64Content,
          uploadedBy: "Local User",
          templateKey: selectedTemplate.key,
        },
      });
      state.ccPayments.sessions = payload.sessions || [];
      state.ccPayments.currentSession = payload.session || null;
      state.ccPayments.currentSessionId = payload.session?.id || "";
      renderCcPaymentPage();
      setStatus("cc-payment-status", `Uploaded ${file.name}.`);
    } catch (error) {
      setStatus("cc-payment-status", `Upload failed: ${error.message}`);
    } finally {
      if (input) input.value = "";
    }
  });

  el("cc-payment-policy-refresh-button")?.addEventListener("click", async () => {
    const session = getCurrentCcPaymentSession();
    if (!session?.id) {
      setStatus("cc-payment-status", "Upload a credit card payment file first.");
      return;
    }
    setStatus("cc-payment-policy-status", "Refreshing policy lookup from Salesforce...");
    try {
      const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(session.id)}/refresh-policy-lookup`, {
        method: "POST",
        body: {},
      });
      state.ccPayments.currentSession = payload.session || null;
      state.ccPayments.currentSessionId = payload.session?.id || session.id;
      renderCcPaymentPage();
      setStatus("cc-payment-policy-status", "Policy lookup refreshed. Updating review table...");
      await loadCcPaymentImportSessions(state.ccPayments.currentSessionId);
    } catch (error) {
      setStatus("cc-payment-policy-status", `Refresh failed: ${error.message}`);
    }
  });

  el("cc-payment-policy-upload-button")?.addEventListener("click", () => {
    el("cc-payment-policy-upload-input")?.click();
  });

  el("cc-payment-policy-upload-input")?.addEventListener("change", async (event) => {
    const session = getCurrentCcPaymentSession();
    const input = event.target;
    const file = input?.files?.[0];
    if (!session?.id || !file) return;
    setStatus("cc-payment-policy-status", "Uploading policy lookup CSV...");
    try {
      const base64Content = await fileToBase64(file);
      const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(session.id)}/refresh-policy-lookup`, {
        method: "POST",
        body: {
          fileName: file.name,
          base64Content,
        },
      });
      state.ccPayments.currentSession = payload.session || null;
      state.ccPayments.currentSessionId = payload.session?.id || session.id;
      renderCcPaymentPage();
      setStatus("cc-payment-policy-status", "Policy lookup uploaded. Updating review table...");
      await loadCcPaymentImportSessions(state.ccPayments.currentSessionId);
    } catch (error) {
      setStatus("cc-payment-policy-status", `Policy upload failed: ${error.message}`);
    } finally {
      if (input) input.value = "";
    }
  });

  el("cc-payment-revalidate-button")?.addEventListener("click", async () => {
    const session = getCurrentCcPaymentSession();
    if (!session?.id) return;
    setStatus("cc-payment-status", "Revalidating session...");
    try {
      const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(session.id)}/revalidate`, {
        method: "POST",
        body: {},
      });
      state.ccPayments.currentSession = payload.session || null;
      state.ccPayments.currentSessionId = payload.session?.id || session.id;
      renderCcPaymentPage();
      setStatus("cc-payment-status", "Session revalidated.");
    } catch (error) {
      setStatus("cc-payment-status", `Revalidation failed: ${error.message}`);
    }
  });

  el("cc-payment-save-all-button")?.addEventListener("click", async () => {
    const session = getCurrentCcPaymentSession();
    if (!session?.id) return;
    const rowEdits = collectCcPaymentRowEdits(session);
    if (!rowEdits.length) {
      setStatus("cc-payment-status", "There are no unsaved certificate or policy changes.");
      updateCcPaymentExportState();
      return;
    }
    setStatus("cc-payment-status", `Saving ${rowEdits.length} row correction(s)...`);
    try {
      const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(session.id)}/rows/bulk`, {
        method: "PATCH",
        body: {
          rows: rowEdits,
          corrected_by: "Local User",
        },
      });
      state.ccPayments.currentSession = payload.session || null;
      state.ccPayments.currentSessionId = payload.session?.id || session.id;
      renderCcPaymentPage();
      setStatus("cc-payment-status", `Saved ${rowEdits.length} row correction(s).`);
    } catch (error) {
      setStatus("cc-payment-status", `Unable to save corrections: ${error.message}`);
    }
  });

  el("cc-payment-export-button")?.addEventListener("click", async () => {
    const session = getCurrentCcPaymentSession();
    if (!session?.id) return;
    const pendingEditCount = collectCcPaymentRowEdits(session).length;
    if (pendingEditCount > 0) {
      setStatus("cc-payment-status", `Save ${pendingEditCount} pending row correction(s) before confirming the import.`);
      updateCcPaymentExportState();
      return;
    }
    if (!confirm(`Import ${Number(session.ready_count || 0)} valid row(s) into ${session.salesforce_object_api_name || "Salesforce"}?`)) {
      return;
    }
    setStatus("cc-payment-status", "Importing rows into Salesforce...");
    try {
      const payload = await apiRequest(`/api/cc-payment-imports/${encodeURIComponent(session.id)}/confirm-import`, {
        method: "POST",
        body: {
          confirmedBy: "Local User",
        },
      });
      state.ccPayments.currentSession = null;
      state.ccPayments.currentSessionId = "";
      await loadCcPaymentImportSessions("");
      setStatus(
        "cc-payment-status",
        `Salesforce import finished. Success: ${Number(payload.session?.successful_import_count || 0)}. Failed: ${Number(payload.session?.salesforce_failed_row_count || 0)}.`
      );
    } catch (error) {
      setStatus("cc-payment-status", `Import failed: ${error.message}`);
    }
  });

  el("cc-payment-template-select")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    state.ccPayments.selectedTemplateKey = target.value || "";
    renderCcPaymentTemplatePicker();
  });

  all("[data-cc-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ccPayments.filter = button.getAttribute("data-cc-filter") || "all";
      renderCcPaymentPage();
    });
  });

  el("cc-payment-history-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const sessionId = target.getAttribute("data-cc-open-session");
    if (sessionId) {
      setStatus("cc-payment-status", "Opening import session...");
      try {
        if (openImportSessionPopup("cc-payment-imports", sessionId)) {
          setStatus("cc-payment-status", "Import session opened in a new window.");
          return;
        }
        await loadCcPaymentImportSession(sessionId);
        setStatus("cc-payment-status", "Popup was blocked, so the import session opened here.");
      } catch (error) {
        setStatus("cc-payment-status", `Unable to load session: ${error.message}`);
      }
      return;
    }

    const deleteSessionId = target.getAttribute("data-cc-delete-session");
    if (!deleteSessionId) return;
    if (!confirm("Delete this import session and remove its rows from import history?")) {
      return;
    }
    setStatus("cc-payment-status", "Deleting import session...");
    try {
      await deleteCcPaymentImportSessionById(deleteSessionId);
    } catch (error) {
      setStatus("cc-payment-status", `Unable to delete session: ${error.message}`);
    }
  });

  el("cc-payment-review-body")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.hasAttribute("data-cc-row-field")) return;
    updateCcPaymentExportState();
  });
}

function collectCcPaymentRowEdits(session) {
  const rows = Array.isArray(session?.rows) ? session.rows : [];
  return rows
    .map((row) => {
      const certificateInput = document.querySelector(`[data-cc-row-field="certificate_number"][data-cc-row-id="${row.id}"]`);
      const policyInput = document.querySelector(`[data-cc-row-field="manual_policy_id"][data-cc-row-id="${row.id}"]`);
      if (!(certificateInput instanceof HTMLInputElement) && !(policyInput instanceof HTMLInputElement)) {
        return null;
      }
      const nextCertificateNumber = certificateInput instanceof HTMLInputElement ? certificateInput.value || "" : "";
      const nextPolicyId = policyInput instanceof HTMLInputElement ? policyInput.value || "" : "";
      const currentCertificateNumber = row.corrected_certificate_number || row.certificate_number || "";
      const currentPolicyId = row.manual_policy_id || row.matched_policy_id || "";
      if (
        String(nextCertificateNumber).trim() === String(currentCertificateNumber).trim()
        && String(nextPolicyId).trim() === String(currentPolicyId).trim()
      ) {
        return null;
      }
      return {
        id: row.id,
        certificate_number: nextCertificateNumber,
        manual_policy_id: nextPolicyId,
      };
    })
    .filter(Boolean);
}

function getCurrentCheckImportSession() {
  return state.checkImports.currentSession || null;
}

function isCheckImportImportedSession(session) {
  return ["imported", "imported_with_errors"].includes(String(session?.final_status || ""));
}

function getSelectedCheckImportTemplate() {
  const selectedKey = String(state.checkImports.selectedTemplateKey || "").trim();
  return state.checkImports.templates.find((entry) => entry.key === selectedKey) || null;
}

function renderCheckImportTemplatePicker() {
  const select = el("check-import-template-select");
  const status = el("check-import-template-status");
  if (!select) return;

  const templates = Array.isArray(state.checkImports.templates) ? state.checkImports.templates : [];
  if (!templates.length) {
    select.innerHTML = '<option value="">No templates loaded</option>';
    if (status) status.textContent = "Check import template list is empty.";
    return;
  }

  select.innerHTML = templates
    .map((template) => `
      <option value="${esc(template.key)}"${template.key === state.checkImports.selectedTemplateKey ? " selected" : ""}>
        ${esc(template.name || template.key)}
      </option>
    `)
    .join("");

  const selectedTemplate = getSelectedCheckImportTemplate();
  if (status) {
    status.textContent = selectedTemplate
      ? `${selectedTemplate.name || selectedTemplate.key} -> ${selectedTemplate.salesforceObjectApiName || "Salesforce"} (${selectedTemplate.operationType || "insert"})`
      : "Select a template.";
  }
}

function updateCheckImportFilterButtons() {
  all("[data-check-filter]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.getAttribute("data-check-filter") === state.checkImports.filter
    );
  });
}

function getCheckImportFilteredRows() {
  const session = getCurrentCheckImportSession();
  const rows = Array.isArray(session?.rows) ? session.rows.slice() : [];
  const filter = String(state.checkImports.filter || "all");
  const filtered = rows.filter((row) => {
    if (filter === "all") return true;
    if (filter === "ready") return row.status === "ready";
    if (filter === "errors") return row.status === "error";
    if (filter === "warnings") return row.status === "warning";
    if (filter === "missing_certificate") {
      return Array.isArray(row.issue_details) && row.issue_details.some((issue) => issue.code === "missing_certificate");
    }
    if (filter === "missing_policy") {
      return Array.isArray(row.issue_details) && row.issue_details.some((issue) => issue.code === "missing_policy_id");
    }
    return true;
  });
  return filtered.sort((a, b) => {
    const order = { error: 0, warning: 1, ready: 2, excluded: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || Number(a.row_number || 0) - Number(b.row_number || 0);
  });
}

function renderCheckImportSummary() {
  const session = getCurrentCheckImportSession();
  el("check-import-summary-total").textContent = String(Number(session?.row_count || 0));
  el("check-import-summary-amount").textContent = formatApplicationCurrency(Number(session?.total_amount || 0));
  el("check-import-summary-ready").textContent = String(Number(session?.ready_count || 0));
  el("check-import-summary-missing-certificate").textContent = String(Number(session?.missing_certificate_count || 0));
  el("check-import-summary-missing-policy").textContent = String(Number(session?.missing_policy_count || 0));
  el("check-import-summary-discrepancy").textContent = String(Number(session?.discrepancy_count || 0));
  setStatus("check-import-validation-message", session?.validation_message || "Upload a file to begin validation.");
}

function renderCheckImportHistory() {
  const tbody = el("check-import-history-body");
  if (!tbody) return;
  const sessions = Array.isArray(state.checkImports.sessions) ? state.checkImports.sessions : [];
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">No check import sessions yet.</td></tr>';
    return;
  }

  tbody.innerHTML = sessions
    .map((session) => `
      <tr>
        <td>${esc(formatDate(session.uploaded_at))}</td>
        <td>${esc(session.original_filename || "")}</td>
        <td>${esc(session.row_count || 0)}</td>
        <td>${esc(session.imported_row_count || session.successful_import_count || 0)}</td>
        <td>${esc(session.ready_count || 0)}</td>
        <td>${esc(session.error_count || 0)}</td>
        <td>${esc(session.warning_count || 0)}</td>
        <td>${esc(formatApplicationCurrency(Number(session.total_amount || 0)))}</td>
        <td>${esc(session.uploaded_by || "")}</td>
        <td class="table-action-cell">
          <button class="secondary-button table-action-button" data-check-open-session="${esc(session.id)}">Open</button>
          ${isCheckImportImportedSession(session) ? "" : `<button class="secondary-button table-action-button" data-check-delete-session="${esc(session.id)}">Delete</button>`}
        </td>
      </tr>
    `)
    .join("");
}

function sanitizeCheckImportSelection() {
  const session = getCurrentCheckImportSession();
  const rowIds = new Set(Array.isArray(session?.rows) ? session.rows.map((row) => row.id) : []);
  state.checkImports.selectedRowIds = ensureArray(state.checkImports.selectedRowIds).filter((rowId) => rowIds.has(rowId));
  if (isCheckImportImportedSession(session)) {
    state.checkImports.selectedRowIds = [];
  }
}

function getCheckImportSelectedRowIds() {
  sanitizeCheckImportSelection();
  return ensureArray(state.checkImports.selectedRowIds);
}

function getCheckImportSelectableFilteredRows() {
  const session = getCurrentCheckImportSession();
  if (!session || isCheckImportImportedSession(session)) {
    return [];
  }
  return getCheckImportFilteredRows();
}

function toggleCheckImportRowSelection(rowId, selected) {
  const selectedIds = new Set(getCheckImportSelectedRowIds());
  if (selected) selectedIds.add(rowId);
  else selectedIds.delete(rowId);
  state.checkImports.selectedRowIds = Array.from(selectedIds);
}

function toggleCheckImportVisibleSelection(selected) {
  const selectedIds = new Set(getCheckImportSelectedRowIds());
  getCheckImportSelectableFilteredRows().forEach((row) => {
    if (selected) selectedIds.add(row.id);
    else selectedIds.delete(row.id);
  });
  state.checkImports.selectedRowIds = Array.from(selectedIds);
}

function updateCheckImportSelectionUi() {
  sanitizeCheckImportSelection();
  const session = getCurrentCheckImportSession();
  const selectedIds = getCheckImportSelectedRowIds();
  const filteredRows = getCheckImportSelectableFilteredRows();
  const selectedVisibleCount = filteredRows.filter((row) => selectedIds.includes(row.id)).length;
  const selectAll = el("check-import-select-all");
  const selectVisibleButton = el("check-import-select-visible-button");
  const clearSelectionButton = el("check-import-clear-selection-button");
  const deleteSelectedButton = el("check-import-delete-selected-button");
  const selectionStatus = el("check-import-selection-status");
  const importedSession = isCheckImportImportedSession(session);

  if (selectAll instanceof HTMLInputElement) {
    selectAll.checked = Boolean(filteredRows.length) && selectedVisibleCount === filteredRows.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < filteredRows.length;
    selectAll.disabled = !filteredRows.length || importedSession;
  }
  if (selectVisibleButton) {
    selectVisibleButton.disabled = !filteredRows.length || importedSession;
  }
  if (clearSelectionButton) {
    clearSelectionButton.disabled = !selectedIds.length;
  }
  if (deleteSelectedButton) {
    deleteSelectedButton.disabled = !selectedIds.length || importedSession;
    deleteSelectedButton.textContent = selectedIds.length
      ? `Delete Selected Rows (${selectedIds.length})`
      : "Delete Selected Rows";
  }
  if (selectionStatus) {
    selectionStatus.textContent = !session
      ? ""
      : importedSession
        ? "Imported sessions are read only."
        : selectedIds.length
          ? `${selectedIds.length} row(s) selected.`
          : "Select rows to delete them in one step.";
  }
}

function renderCheckImportReviewTable() {
  const tbody = el("check-import-review-body");
  if (!tbody) return;
  const session = getCurrentCheckImportSession();
  if (!session) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty-cell">No check import session loaded.</td></tr>';
    updateCheckImportSelectionUi();
    return;
  }
  const isImportedSession = isCheckImportImportedSession(session);

  const rows = getCheckImportFilteredRows();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty-cell">No rows match the selected filter.</td></tr>';
    updateCheckImportSelectionUi();
    return;
  }

  tbody.innerHTML = rows.map((row) => `
    <tr class="cc-import-row is-${esc(row.status || "ready")}">
      <td class="table-selection-cell">
        ${isImportedSession ? "" : `<input type="checkbox" data-check-select-row="${esc(row.id)}"${getCheckImportSelectedRowIds().includes(row.id) ? " checked" : ""} aria-label="Select row ${esc(row.row_number || row.id)}" />`}
      </td>
      <td><span class="cc-status-pill is-${esc(row.status || "ready")}">${esc((row.status || "ready").replaceAll("_", " "))}</span></td>
      <td>${esc(row.deposit_date || "")}</td>
      <td>
        <div class="field-stack">
          <strong>${esc(row.certificate_number || "")}</strong>
          ${isImportedSession ? "" : `<input class="field-input cc-inline-input" data-check-row-field="certificate_number" data-check-row-id="${esc(row.id)}" value="${esc(row.certificate_number || "")}" />`}
        </div>
      </td>
      <td>
        <div class="field-stack">
          <strong>${esc(row.matched_certificate_record_id || "-")}</strong>
          <div class="cc-row-note">${esc(row.matched_policy_id || "No related policy ID")}</div>
        </div>
      </td>
      <td>
        <div class="field-stack">
          <strong>${esc(row.check_amount || "")}</strong>
          ${row.expected_amount !== null && row.expected_amount !== undefined ? `<div class="cc-row-note">Selected match: ${esc(formatApplicationCurrency(row.expected_amount))}</div>` : ""}
          ${row.premium_comparison_label ? `<div class="cc-row-note">${esc(row.premium_comparison_label)}</div>` : ""}
        </div>
      </td>
      <td>${esc(row.remitter_name || "")}</td>
      <td>${esc(row.check_number || "")}</td>
      <td>${esc(row.transaction_id || "")}</td>
      <td>${esc(row.member_1_name || "")}</td>
      <td>${esc(row.member_2_name || "")}</td>
      <td>
        <div class="field-stack">
          <strong>${esc(String(row.months ?? "").trim() !== "" ? row.months : "-")}</strong>
          ${isImportedSession ? "" : `<input class="field-input cc-inline-input" data-check-row-field="months" data-check-row-id="${esc(row.id)}" type="number" min="0" step="1" value="${esc(String(row.corrected_months ?? "").trim() !== "" ? row.corrected_months : (String(row.months ?? "").trim() !== "" ? row.months : ""))}" placeholder="Months" />`}
        </div>
      </td>
      <td>${esc(row.issue_reason || "")}</td>
      <td class="table-action-cell">
        ${isImportedSession
          ? '<span class="cc-row-note">Read only</span>'
          : `<span class="cc-row-note">Edit rows, then save all.</span>
        <button class="secondary-button table-action-button" data-check-toggle-exclude="${esc(row.id)}">${row.excluded ? "Include" : "Exclude"}</button>`}
      </td>
    </tr>
  `).join("");
  updateCheckImportSelectionUi();
}

function updateCheckImportPolicyStatus() {
  const session = getCurrentCheckImportSession();
  const refreshedAt = session?.policyLookup?.refreshedAt || session?.policy_lookup_refreshed_at || "";
  const source = session?.policyLookup?.source || "";
  const count = Number(session?.policyLookup?.items?.length || 0);
  setStatus(
    "check-import-policy-status",
    !count
      ? "Certificate lookup data failed to load. Cannot validate check imports."
      :
    refreshedAt
      ? `Certificate lookup refreshed ${formatDate(refreshedAt)} from ${source || "Salesforce"} with ${count.toLocaleString("en-US")} record(s).`
      : "Certificate lookup not refreshed yet."
  );
}

function updateCheckImportButtons() {
  const session = getCurrentCheckImportSession();
  const saveAllButton = el("check-import-save-all-button");
  const confirmButton = el("check-import-confirm-button");
  const exportButton = el("check-import-export-errors-button");
  if (saveAllButton) {
    const alreadyImported = isCheckImportImportedSession(session);
    const pendingEditCount = session && !alreadyImported ? collectCheckImportRowEdits(session).length : 0;
    saveAllButton.disabled = !session || alreadyImported || pendingEditCount <= 0;
    saveAllButton.textContent = pendingEditCount > 0
      ? `Save All Corrections (${pendingEditCount})`
      : "Save All Corrections";
  }
  if (confirmButton) {
    const alreadyImported = isCheckImportImportedSession(session);
    const readyCount = Number(session?.ready_count || 0);
    confirmButton.disabled = !session || readyCount <= 0 || Boolean(session?.footer_mismatch) || alreadyImported;
    confirmButton.textContent = alreadyImported
      ? "Import Completed"
      : readyCount > 0
        ? `Confirm Import (${readyCount})`
        : "Confirm Import";
  }
  if (exportButton) {
    exportButton.disabled = !session || (!Number(session?.error_count || 0) && !Number(session?.warning_count || 0));
  }
}

function renderCheckImportPage() {
  sanitizeCheckImportSelection();
  renderCheckImportTemplatePicker();
  updateCheckImportFilterButtons();
  renderCheckImportSummary();
  renderCheckImportReviewTable();
  renderCheckImportHistory();
  updateCheckImportPolicyStatus();
  updateCheckImportButtons();
}

async function loadCheckImportSession(sessionId) {
  const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(sessionId)}`);
  const resolvedSession = payload.session || null;
  const resolvedRows = Array.isArray(resolvedSession?.rows) ? resolvedSession.rows : [];
  if (!resolvedSession || !resolvedSession.id || !resolvedRows.length) {
    state.checkImports.currentSessionId = "";
    state.checkImports.currentSession = null;
    state.checkImports.selectedRowIds = [];
    renderCheckImportPage();
    setStatus("check-import-status", "That check import session is no longer available. Showing current server state.");
    return;
  }

  state.checkImports.currentSessionId = resolvedSession.id;
  state.checkImports.currentSession = resolvedSession;
  state.checkImports.selectedRowIds = [];
  if (resolvedSession.template?.key) {
    state.checkImports.selectedTemplateKey = resolvedSession.template.key;
  }
  renderCheckImportPage();
}

async function loadCheckImportTemplates() {
  const payload = await apiRequest("/api/check-import-templates");
  state.checkImports.templates = Array.isArray(payload.templates) ? payload.templates : [];
  if (!state.checkImports.selectedTemplateKey) {
    state.checkImports.selectedTemplateKey = state.checkImports.templates[0]?.key || "";
  }
  renderCheckImportTemplatePicker();
}

async function loadCheckImportSessions(preferredSessionId = "") {
  const payload = await apiRequest("/api/check-imports");
  state.checkImports.sessions = payload.sessions || [];
  const nextActiveSession = state.checkImports.sessions.find((session) => !["imported", "imported_with_errors"].includes(String(session.final_status || ""))) || null;
  const targetSessionId = preferredSessionId || state.checkImports.currentSessionId || nextActiveSession?.id || "";
  if (targetSessionId) {
    await loadCheckImportSession(targetSessionId);
    state.checkImports.launchSessionId = "";
    return;
  }
  state.checkImports.currentSessionId = "";
  state.checkImports.currentSession = null;
  state.checkImports.selectedRowIds = [];
  state.checkImports.launchSessionId = "";
  renderCheckImportPage();
}

async function deleteCheckImportSessionById(sessionId) {
  const normalizedId = String(sessionId || "").trim();
  if (!normalizedId) {
    return;
  }

  const response = await apiRequest(`/api/check-imports/${encodeURIComponent(normalizedId)}`, {
    method: "DELETE",
  });
  state.checkImports.sessions = Array.isArray(response.sessions) ? response.sessions : [];
  if (state.checkImports.currentSessionId === normalizedId) {
    state.checkImports.currentSessionId = "";
    state.checkImports.currentSession = null;
    state.checkImports.selectedRowIds = [];
  }
  await loadCheckImportSessions("");
  setStatus("check-import-status", "Import session deleted.");
}

async function deleteSelectedCheckImportRows() {
  const session = getCurrentCheckImportSession();
  if (!session?.id) return;
  const rowIds = getCheckImportSelectedRowIds();
  if (!rowIds.length) {
    setStatus("check-import-status", "Select one or more rows to delete.");
    return;
  }
  const confirmationMessage = rowIds.length === 1
    ? "Delete the selected row from this unimported batch?"
    : `Delete ${rowIds.length} selected rows from this unimported batch?`;
  if (!confirm(confirmationMessage)) {
    return;
  }

  const selectedCount = rowIds.length;
  setStatus("check-import-status", `Deleting ${selectedCount} row(s)...`);
  const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(session.id)}/rows/bulk-delete`, {
    method: "POST",
    body: { rowIds },
  });
  state.checkImports.currentSession = payload.session || null;
  state.checkImports.currentSessionId = payload.session?.id || session.id;
  state.checkImports.selectedRowIds = [];
  renderCheckImportPage();
  setStatus("check-import-status", `${selectedCount} row(s) deleted.`);
}

function collectCheckImportRowEdits(session) {
  const rows = Array.isArray(session?.rows) ? session.rows : [];
  return rows
    .filter((row) => !row.excluded)
    .map((row) => {
      const certificateInput = document.querySelector(`[data-check-row-field="certificate_number"][data-check-row-id="${row.id}"]`);
      const monthsInput = document.querySelector(`[data-check-row-field="months"][data-check-row-id="${row.id}"]`);
      if (!(certificateInput instanceof HTMLInputElement) && !(monthsInput instanceof HTMLInputElement)) {
        return null;
      }
      const nextCertificateNumber = certificateInput instanceof HTMLInputElement ? certificateInput.value || "" : "";
      const nextMonths = monthsInput instanceof HTMLInputElement ? monthsInput.value || "" : "";
      const currentCertificateNumber = row.corrected_certificate_number || row.certificate_number || "";
      const currentMonths = String(row.corrected_months ?? "").trim() !== "" ? String(row.corrected_months) : String(row.months ?? "");
      if (
        String(nextCertificateNumber).trim() === String(currentCertificateNumber).trim()
        && String(nextMonths).trim() === String(currentMonths).trim()
      ) {
        return null;
      }
      return {
        id: row.id,
        certificate_number: nextCertificateNumber,
        months: nextMonths,
      };
    })
    .filter(Boolean);
}

function bindCheckImportEvents() {
  el("check-import-upload-button")?.addEventListener("click", () => {
    el("check-import-upload-input")?.click();
  });

  el("check-import-upload-input")?.addEventListener("change", async (event) => {
    const input = event.target;
    const file = input?.files?.[0];
    if (!file) return;
    const selectedTemplate = getSelectedCheckImportTemplate();
    if (!selectedTemplate?.key) {
      setStatus("check-import-status", "Select an import template first.");
      return;
    }
    setStatus("check-import-status", "Uploading check import file...");
    try {
      const base64Content = await fileToBase64(file);
      const payload = await apiRequest("/api/check-imports/upload", {
        method: "POST",
        body: {
          fileName: file.name,
          base64Content,
          uploadedBy: "Local User",
          templateKey: selectedTemplate.key,
        },
      });
      state.checkImports.sessions = payload.sessions || [];
      state.checkImports.currentSession = payload.session || null;
      state.checkImports.currentSessionId = payload.session?.id || "";
      renderCheckImportPage();
      setStatus("check-import-status", `Uploaded ${file.name}.`);
    } catch (error) {
      setStatus("check-import-status", `Upload failed: ${error.message}`);
    } finally {
      if (input) input.value = "";
    }
  });

  el("check-import-policy-refresh-button")?.addEventListener("click", async () => {
    const session = getCurrentCheckImportSession();
    if (!session?.id) {
      setStatus("check-import-status", "Upload a check import file first.");
      return;
    }
    setStatus("check-import-policy-status", "Refreshing policy lookup from Salesforce...");
    try {
      const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(session.id)}/refresh-policy-lookup`, {
        method: "POST",
        body: {},
      });
      state.checkImports.currentSession = payload.session || null;
      state.checkImports.currentSessionId = payload.session?.id || session.id;
      renderCheckImportPage();
      setStatus("check-import-policy-status", "Policy lookup refreshed. Updating review table...");
      await loadCheckImportSessions(state.checkImports.currentSessionId);
    } catch (error) {
      setStatus("check-import-policy-status", `Refresh failed: ${error.message}`);
    }
  });

  el("check-import-revalidate-button")?.addEventListener("click", async () => {
    const session = getCurrentCheckImportSession();
    if (!session?.id) return;
    setStatus("check-import-status", "Revalidating session...");
    try {
      const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(session.id)}/revalidate`, {
        method: "POST",
        body: {},
      });
      state.checkImports.currentSession = payload.session || null;
      state.checkImports.currentSessionId = payload.session?.id || session.id;
      renderCheckImportPage();
      setStatus("check-import-status", "Session revalidated.");
    } catch (error) {
      setStatus("check-import-status", `Revalidation failed: ${error.message}`);
    }
  });

  el("check-import-save-all-button")?.addEventListener("click", async () => {
    const session = getCurrentCheckImportSession();
    if (!session?.id) return;
    const rowEdits = collectCheckImportRowEdits(session);
    if (!rowEdits.length) {
      setStatus("check-import-status", "There are no unsaved certificate or months changes.");
      return;
    }
    setStatus("check-import-status", `Saving ${rowEdits.length} row correction(s)...`);
    try {
      const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(session.id)}/rows/bulk`, {
        method: "PATCH",
        body: {
          rows: rowEdits,
          corrected_by: "Local User",
        },
      });
      state.checkImports.currentSession = payload.session || null;
      state.checkImports.currentSessionId = payload.session?.id || session.id;
      renderCheckImportPage();
      setStatus("check-import-status", `Saved ${rowEdits.length} row correction(s).`);
    } catch (error) {
      setStatus("check-import-status", `Unable to save corrections: ${error.message}`);
    }
  });

  el("check-import-confirm-button")?.addEventListener("click", async () => {
    const session = getCurrentCheckImportSession();
    if (!session?.id) return;
    const pendingEditCount = collectCheckImportRowEdits(session).length;
    if (pendingEditCount > 0) {
      setStatus("check-import-status", `Save ${pendingEditCount} pending row correction(s) before confirming the import.`);
      updateCheckImportButtons();
      return;
    }
    const readyCount = Number(session.ready_count || 0);
    const errorCount = Number(session.error_count || 0);
    const warningCount = Number(session.warning_count || 0);
    const confirmMessage = [
      `Import ${readyCount} ready row(s) into ${session.salesforce_object_api_name || "Salesforce"}?`,
      errorCount > 0 ? `${errorCount} row(s) with errors will be skipped.` : "",
      warningCount > 0 ? `${warningCount} warning row(s) will still import.` : "",
    ].filter(Boolean).join(" ");
    if (!confirm(confirmMessage)) {
      return;
    }
    setStatus("check-import-status", "Importing rows into Salesforce...");
    try {
      const payload = await apiRequest(`/api/check-imports/${encodeURIComponent(session.id)}/confirm-import`, {
        method: "POST",
        body: { confirmedBy: "Local User" },
      });
      state.checkImports.currentSession = null;
      state.checkImports.currentSessionId = "";
      await loadCheckImportSessions("");
      setStatus(
        "check-import-status",
        `Salesforce import finished. Success: ${Number(payload.session?.successful_import_count || 0)}. Failed: ${Number(payload.session?.salesforce_failed_row_count || 0)}.`
      );
    } catch (error) {
      setStatus("check-import-status", `Import failed: ${error.message}`);
    }
  });

  el("check-import-export-errors-button")?.addEventListener("click", async () => {
    const session = getCurrentCheckImportSession();
    if (!session?.id) return;
    try {
      const response = await fetch(`/api/check-imports/${encodeURIComponent(session.id)}/export-errors`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Unable to export rejected rows.");
      }
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `check-import-rejections-${session.id}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      setStatus("check-import-status", "Rejected rows exported.");
    } catch (error) {
      setStatus("check-import-status", `Export failed: ${error.message}`);
    }
  });

  el("check-import-template-select")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.checkImports.selectedTemplateKey = target.value || "";
    renderCheckImportTemplatePicker();
  });

  all("[data-check-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.checkImports.filter = button.getAttribute("data-check-filter") || "all";
      renderCheckImportPage();
    });
  });

  el("check-import-select-visible-button")?.addEventListener("click", () => {
    toggleCheckImportVisibleSelection(true);
    renderCheckImportReviewTable();
  });

  el("check-import-clear-selection-button")?.addEventListener("click", () => {
    state.checkImports.selectedRowIds = [];
    renderCheckImportReviewTable();
  });

  el("check-import-delete-selected-button")?.addEventListener("click", async () => {
    try {
      await deleteSelectedCheckImportRows();
    } catch (error) {
      setStatus("check-import-status", `Unable to delete selected rows: ${error.message}`);
    }
  });

  el("check-import-select-all")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    toggleCheckImportVisibleSelection(target.checked);
    renderCheckImportReviewTable();
  });

  el("check-import-history-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const sessionId = target.getAttribute("data-check-open-session");
    if (sessionId) {
      setStatus("check-import-status", "Opening import session...");
      try {
        if (openImportSessionPopup("check-imports", sessionId)) {
          setStatus("check-import-status", "Import session opened in a new window.");
          return;
        }
        await loadCheckImportSession(sessionId);
        setStatus("check-import-status", "Popup was blocked, so the import session opened here.");
      } catch (error) {
        setStatus("check-import-status", `Unable to load session: ${error.message}`);
      }
      return;
    }

    const deleteSessionId = target.getAttribute("data-check-delete-session");
    if (!deleteSessionId) return;
    if (!confirm("Delete this unimported batch and remove its rows from import history?")) {
      return;
    }
    setStatus("check-import-status", "Deleting import session...");
    try {
      await deleteCheckImportSessionById(deleteSessionId);
    } catch (error) {
      setStatus("check-import-status", `Unable to delete session: ${error.message}`);
    }
  });

  el("check-import-review-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const session = getCurrentCheckImportSession();
    if (!session?.id) return;

    const selectedRowId = target.getAttribute("data-check-select-row");
    if (selectedRowId && target instanceof HTMLInputElement) {
      toggleCheckImportRowSelection(selectedRowId, target.checked);
      updateCheckImportSelectionUi();
      return;
    }

    const excludeRowId = target.getAttribute("data-check-toggle-exclude");
    if (!excludeRowId) return;
    const row = (session.rows || []).find((entry) => entry.id === excludeRowId);
    try {
      const payload = await apiRequest(
        `/api/check-imports/${encodeURIComponent(session.id)}/rows/${encodeURIComponent(excludeRowId)}`,
        {
          method: "PATCH",
          body: {
            excluded: !row?.excluded,
            corrected_by: "Local User",
          },
        }
      );
      state.checkImports.currentSession = payload.session || null;
      state.checkImports.currentSessionId = payload.session?.id || session.id;
      renderCheckImportPage();
      setStatus("check-import-status", row?.excluded ? "Row included again." : "Row excluded from import.");
    } catch (error) {
      setStatus("check-import-status", `Unable to update row: ${error.message}`);
    }
  });

  el("check-import-review-body")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.hasAttribute("data-check-row-field")) return;
    updateCheckImportButtons();
  });
}

function getCurrentAchReturnSession() {
  return state.achReturns.currentSession || null;
}

function isAchReturnImportedSession(session) {
  return ["imported", "imported_with_errors"].includes(String(session?.final_status || ""));
}

function resolveMatchTextValue(selectedMatch, valueGetters) {
  for (const valueGetter of valueGetters) {
    const rawValue = typeof valueGetter === "function" ? valueGetter() : "";
    const value = String(rawValue || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveMatchAmount(selectedMatch, valueGetters) {
  for (const valueGetter of valueGetters) {
    const rawValue = typeof valueGetter === "function" ? valueGetter() : "";
    const text = String(rawValue || "").trim();
    if (!text) continue;
    const numeric = Number(text.replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function buildAchReturnPendingCredit(parsed, selectedMatch) {
  if (!selectedMatch) {
    return null;
  }

  const returnCode = resolveMatchTextValue(selectedMatch, [() => parsed?.returnCode]);
  const returnReason = resolveMatchTextValue(selectedMatch, [() => parsed?.returnReason]);

  const certificateNumber = resolveMatchTextValue(selectedMatch, [
    () => selectedMatch?.certificateNumber,
    () => selectedMatch?.certificate,
    () => selectedMatch?.raw?.certificate_number,
    () => selectedMatch?.raw?.Certificate__c,
    () => selectedMatch?.raw?.Certificate__r?.Name,
    () => selectedMatch?.raw?.CertificateName__c,
    () => selectedMatch?.raw?.Certificate_Number__c,
    () => selectedMatch?.raw?.CertificateNumber__c,
  ]);

  const customerName = resolveMatchTextValue(selectedMatch, [
    () => selectedMatch?.customerName,
    () => selectedMatch?.customer,
    () => selectedMatch?.raw?.customer_name,
    () => selectedMatch?.raw?.payor_name,
    () => selectedMatch?.raw?.Customer__c,
    () => selectedMatch?.raw?.Customer_Name__c,
    () => selectedMatch?.raw?.Name,
  ]);

  const premium = resolveMatchAmount(selectedMatch, [() => selectedMatch?.premium]);

  const dues = resolveMatchAmount(selectedMatch, [
    () => selectedMatch?.dues,
    () => selectedMatch?.raw?.dues,
    () => selectedMatch?.raw?.dues_amount,
    () => selectedMatch?.raw?.aha_dues,
    () => selectedMatch?.raw?.AHA_Dues__c,
    () => selectedMatch?.raw?.Aha_Dues__c,
  ]);

  const rollbackMonths = resolveMatchTextValue(selectedMatch, [
    () => selectedMatch?.rollbackMonths,
    () => selectedMatch?.months,
    () => selectedMatch?.id3,
    () => selectedMatch?.raw?.ID3,
    () => selectedMatch?.raw?.id3,
  ]);

  const creditAmount = Number.isFinite(Number(selectedMatch?.creditAmount))
    ? Number(selectedMatch.creditAmount)
    : Number.isFinite(Number(parsed?.amount))
      ? Number(parsed.amount)
      : null;
  const parsedDate = formatShortDate(parsed?.batchDate || "");
  const reasonForCredit = [returnCode, returnReason ? `(${returnReason})` : "", parsed?.identifier1, parsed?.identifier3]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    policyId: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.policyId, () => selectedMatch?.policy_id]),
    certificateRecordId: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.certificateRecordId]),
    certificateNumber,
    certificateType: "ACH",
    originalPaymentId: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.salesforcePaymentId, () => selectedMatch?.transactionReference]),
    paymentMethodId: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.paymentMethodId]),
    paymentMethod: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.paymentMethod, () => selectedMatch?.payment_method]),
    checkNo: resolveMatchTextValue(selectedMatch, [() => selectedMatch?.checkNumber]),
    claimId: "",
    creditAmount: creditAmount || 0,
    creditDate: parsedDate,
    dateEntered: formatShortDate(new Date().toISOString()),
    dateRefunded: formatShortDate(new Date().toISOString()),
    premium,
    dues,
    duesCollected: dues,
    policySelected: "",
    discrepancy: "",
    creditReasonCode: "Direct Debit (M&T Bank or UMB Bank) - Returned Items",
    creditReason: "Direct Debit (M&T Bank or UMB Bank) - Returned Items",
    rollbackMonths: String(rollbackMonths || "").trim() ? String(rollbackMonths).padStart(2, "0") : "",
    deathClaimMonthsCredited: "",
    reasonCode: returnCode,
    reasonForCredit: reasonForCredit || (returnCode ? `Return Code: ${returnCode}${returnReason ? ` (${returnReason})` : ""}` : "-"),
    refundName: buildAchRefundName(certificateNumber || ""),
    returnCode,
    returnReason,
    status: "Completed",
    creditType: "ACH",
    traceNumber: resolveMatchTextValue(selectedMatch, [() => parsed?.traceNumber]),
    achTransactionId: resolveMatchTextValue(selectedMatch, [() => parsed?.achTransactionId]),
    creditBatchId: resolveMatchTextValue(selectedMatch, [() => parsed?.achTransactionId, () => parsed?.traceNumber, () => selectedMatch?.batchId]),
    identifier1: resolveMatchTextValue(selectedMatch, [() => parsed?.identifier1]),
    zeroMonthCredit: false,
    creditQc: false,
    payerName: resolveMatchTextValue(selectedMatch, [() => parsed?.payerName, () => customerName]),
    notes: returnCode ? `Return Code: ${returnCode}${returnReason ? ` (${returnReason})` : ""}` : "-",
    customerName,
  };
}

function formatAchReturnCurrency(value) {
  return value !== null && value !== undefined && String(value).trim() !== ""
    ? formatApplicationCurrency(value)
    : "-";
}

function formatAchReturnBoolean(value) {
  return value ? "Yes" : "No";
}

function renderAchReturnSpreadsheetRow(row, options = {}) {
  const derivedStatusValue = row.import_result_status
    ? String(row.import_result_status || "").replaceAll("_", " ")
    : row.validation_status === "ready"
      ? "Ready"
      : row.validation_status === "error"
        ? "Error"
        : "";
  const statusValue = options.statusValue || derivedStatusValue || row.status || "";
  const importResult = options.importResult
    || row.import_result_message
    || row.issue_reason
    || (row.validation_status === "ready" ? "Ready to import into Salesforce." : "");
  const visualStatus = options.visualStatus || row.import_result_status || row.validation_status || "ready";
  return `
    <tr class="cc-import-row is-${esc(String(visualStatus || "ready").toLowerCase())}">
      ${options.includeActions ? `<td class="table-action-cell">${options.actionsHtml || ""}</td>` : ""}
      ${options.includeCreated ? `<td>${esc(formatDate(row.created_at || row.creditDate || ""))}</td>` : ""}
      <td>${esc(row.refundName || "")}</td>
      <td>${esc(row.policyId || "")}</td>
      <td>${esc(row.certificateRecordId || "")}</td>
      <td>${esc(row.certificateNumber || "")}</td>
      <td>${esc(row.creditType || row.certificateType || "ACH")}</td>
      <td>${esc(row.paymentMethod || "")}</td>
      <td>${esc(row.creditDate || "")}</td>
      <td>${esc(formatAchReturnCurrency(row.premium))}</td>
      <td>${esc(formatAchReturnCurrency(row.duesCollected))}</td>
      <td>${esc(row.creditReasonCode || "")}</td>
      <td>${esc(row.rollbackMonths || "")}</td>
      <td>${esc(formatAchReturnCurrency(row.creditAmount))}</td>
      <td>${esc(row.reasonForCredit || row.notes || "")}</td>
      <td>${esc(row.dateRefunded || "")}</td>
      <td><span class="cc-status-pill is-${esc(String(visualStatus || "ready").toLowerCase())}">${esc(String(statusValue || "").replaceAll("_", " "))}</span></td>
      <td>${esc(row.creditBatchId || "")}</td>
      ${options.includeImportColumns ? `<td>${esc(importResult)}</td><td>${esc(row.imported_salesforce_id || "")}</td>` : ""}
    </tr>
  `;
}

function renderAchReturnReview() {
  const container = el("ach-return-review-panel");
  if (!container) return;
  const draft = state.achReturns.draft;
  if (!draft) {
    container.innerHTML = '<p class="empty-cell">Parse an ACH return email to begin.</p>';
    return;
  }

  const parsed = draft.parsed || {};
  const matches = Array.isArray(draft.matches) ? draft.matches : [];
  const selectedMatchKey = draft.selectedMatchKey || draft.selectedMatch?.matchKey || "";
  const selectedMatch = matches.find((entry) => entry.matchKey === selectedMatchKey) || draft.selectedMatch || null;
  const pendingCredit = buildAchReturnPendingCredit(parsed, selectedMatch);
  const errors = Array.isArray(draft.errors) ? draft.errors : [];

  const selectedCertificateNumber = resolveMatchTextValue(selectedMatch, [
    () => pendingCredit?.certificateNumber,
    () => selectedMatch?.certificateNumber,
    () => selectedMatch?.certificate,
    () => selectedMatch?.raw?.certificate_number,
    () => selectedMatch?.raw?.Certificate__c,
    () => selectedMatch?.raw?.Certificate_Number__c,
    () => selectedMatch?.raw?.CertificateNumber__c,
  ]);
  const selectedCustomerName = resolveMatchTextValue(selectedMatch, [
    () => selectedMatch?.customerName,
    () => pendingCredit?.customerName,
    () => selectedMatch?.raw?.payor_name,
    () => selectedMatch?.raw?.customer_name,
    () => selectedMatch?.raw?.Customer__c,
    () => selectedMatch?.raw?.Customer_Name__c,
    () => selectedMatch?.raw?.Name,
  ]);
  const selectedPremium = resolveMatchAmount(selectedMatch, [() => selectedMatch?.premium]);
  const selectedDues = resolveMatchAmount(selectedMatch, [
    () => selectedMatch?.dues,
    () => selectedMatch?.raw?.dues,
    () => selectedMatch?.raw?.dues_amount,
    () => selectedMatch?.raw?.AHA_Dues__c,
    () => selectedMatch?.raw?.Aha_Dues__c,
    () => selectedMatch?.raw?.Dues__c,
  ]);
  const selectedRollbackMonths = resolveMatchTextValue(selectedMatch, [
    () => selectedMatch?.rollbackMonths,
    () => selectedMatch?.months,
    () => selectedMatch?.id3,
    () => selectedMatch?.raw?.ID3,
    () => selectedMatch?.raw?.id3,
  ]);

  container.innerHTML = `
    ${errors.length ? `<div class="inline-status">${esc(errors.join(" "))}</div>` : ""}
    <div class="workflow-grid">
      <article class="panel">
        <div class="panel-heading">
          <h3>Parsed ACH Return Details</h3>
        </div>
        <div class="field-stack">
          <p><strong>Payer Name:</strong> ${esc(parsed.payerName || "-")}</p>
          <p><strong>Amount:</strong> ${esc(parsed.amount !== null && parsed.amount !== undefined ? formatApplicationCurrency(parsed.amount) : "-")}</p>
          <p><strong>Return Code:</strong> ${esc(parsed.returnCode || "-")}</p>
          <p><strong>Return Reason:</strong> ${esc(parsed.returnReason || "-")}</p>
          <p><strong>Trace Number:</strong> ${esc(parsed.traceNumber || "-")}</p>
          <p><strong>Batch Date:</strong> ${esc(parsed.batchDate || "-")}</p>
          <p><strong>ACH Transaction ID:</strong> ${esc(parsed.achTransactionId || "-")}</p>
          <p><strong>Identifier 1:</strong> ${esc(parsed.identifier1 || "-")}</p>
          <p><strong>Identifier 2:</strong> ${esc(parsed.identifier2 || "-")}</p>
          <p><strong>Identifier 3:</strong> ${esc(parsed.identifier3 || "-")}</p>
          <p><strong>Identifier 4:</strong> ${esc(parsed.identifier4 || "-")}</p>
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading">
          <h3>Matched Original Payment</h3>
        </div>
        ${
          !matches.length
            ? '<p class="empty-cell">No original payment matched yet.</p>'
            : `
              ${matches.length > 1 ? `
                <label class="field-label" for="ach-return-match-select">Select Original Payment</label>
                <select id="ach-return-match-select" class="field-input">
                  <option value="">Choose a match</option>
                  ${matches.map((entry) => `
                    <option value="${esc(entry.matchKey)}"${entry.matchKey === selectedMatchKey ? " selected" : ""}>
                      ${esc(entry.salesforcePaymentId || entry.transactionReference || entry.matchKey)} | ${esc(entry.customerName || entry.certificateNumber || entry.source)} | ${esc(entry.paymentAmount !== null && entry.paymentAmount !== undefined ? formatApplicationCurrency(entry.paymentAmount) : "-")}
                    </option>
                  `).join("")}
                </select>
              ` : ""}
              ${selectedMatch ? `
              <div class="field-stack">
                  <p><strong>Salesforce Payment Id:</strong> ${esc(selectedMatch.salesforcePaymentId || "-")}</p>
                  <p><strong>Policy Id:</strong> ${esc(selectedMatch.policyId || "-")}</p>
                  <p><strong>Certificate Number:</strong> ${esc(selectedCertificateNumber || "-")}</p>
                  <p><strong>Customer/Account Name:</strong> ${esc(selectedCustomerName || "-")}</p>
                  <p><strong>Payment Amount:</strong> ${esc(selectedMatch.paymentAmount !== null && selectedMatch.paymentAmount !== undefined ? formatApplicationCurrency(selectedMatch.paymentAmount) : "-")}</p>
                  <p><strong>Premium:</strong> ${esc(selectedPremium !== null ? formatApplicationCurrency(selectedPremium) : "-")}</p>
                  <p><strong>Dues:</strong> ${esc(selectedDues !== null ? formatApplicationCurrency(selectedDues) : "-")}</p>
                  <p><strong>Rollback Months:</strong> ${esc(selectedRollbackMonths || "-")}</p>
                  <p><strong>Payment Date:</strong> ${esc(selectedMatch.paymentDate || "-")}</p>
                  <p><strong>Payment Method:</strong> ${esc(selectedMatch.paymentMethod || "-")}</p>
                  <p><strong>Transaction/Reference Number:</strong> ${esc(selectedMatch.transactionReference || "-")}</p>
                </div>
              ` : `<p class="empty-cell">Multiple matches found. Select the correct payment above.</p>`}
            `
        }
      </article>
    </div>
  `;

  const createButton = el("ach-return-create-row-button");
  if (createButton) {
    createButton.disabled = Boolean(errors.length) || !selectedMatch;
    createButton.textContent = "Save Row & Add Another";
  }
}

function renderAchReturnTable() {
  const tbody = el("ach-return-table-body");
  const status = el("ach-return-export-status");
  if (!tbody) return;
  const session = getCurrentAchReturnSession();
  const rows = Array.isArray(session?.rows) ? session.rows : [];
  const isImportedSession = ["imported", "imported_with_errors"].includes(String(session?.final_status || ""));
  const draft = state.achReturns.draft;
  const draftMatches = Array.isArray(draft?.matches) ? draft.matches : [];
  const draftSelectedMatchKey = draft?.selectedMatchKey || draft?.selectedMatch?.matchKey || "";
  const draftSelectedMatch = draftMatches.find((entry) => entry.matchKey === draftSelectedMatchKey) || draft?.selectedMatch || null;
  const draftPendingCredit = draftSelectedMatch ? buildAchReturnPendingCredit(draft?.parsed || {}, draftSelectedMatch) : null;
  const draftErrors = Array.isArray(draft?.errors) ? draft.errors : [];
  const draftCanSave = Boolean(draftPendingCredit) && !draftErrors.length && Boolean(draftSelectedMatch);

  if (!rows.length && !draftPendingCredit) {
    tbody.innerHTML = '<tr><td colspan="19" class="empty-cell">No ACH reversal rows yet.</td></tr>';
    if (status && !String(status.textContent || "").trim()) {
      status.textContent = isAchReturnImportedSession(session)
        ? "This ACH return batch has already been imported. Use ACH Return History to reopen and review it."
        : session?.id
        ? "The current ACH working batch is empty. Parse an email and save the row to add it here."
        : "No ACH working batch yet. Parse an email to begin.";
    }
    return;
  }

  const renderedRows = [];

  if (draftPendingCredit) {
    renderedRows.push(
      renderAchReturnSpreadsheetRow(
        {
          ...draftPendingCredit,
          created_at: new Date().toISOString(),
          issue_reason: draftErrors.join(" "),
        },
        {
          includeCreated: true,
          includeImportColumns: true,
          includeActions: true,
          statusValue: draftErrors.length ? "Draft Error" : "Draft Preview",
          visualStatus: draftErrors.length ? "error" : "warning",
          importResult: draftErrors.length
            ? draftErrors.join(" ")
            : "Parsed and matched. Save Row & Add Another to add it to this ACH return batch.",
          actionsHtml: draftCanSave
            ? '<button class="secondary-button table-action-button" data-ach-save-draft="1">Save Row &amp; Add Another</button>'
            : '<span class="cc-row-note">Finish the match above to save</span>',
        }
      )
    );
  }

  renderedRows.push(
    ...rows.map((row) =>
      renderAchReturnSpreadsheetRow(row, {
        includeCreated: true,
        includeImportColumns: true,
        includeActions: true,
        actionsHtml: isImportedSession
          ? '<span class="cc-row-note">Read only</span>'
          : `<button class="secondary-button table-action-button" data-ach-remove-row="${esc(row.id)}">Delete Row</button>`,
      })
    )
  );

  tbody.innerHTML = renderedRows.join("");
  if (status && draftPendingCredit && !rows.length) {
    status.textContent = "Draft preview is showing in the export table below. Click Save Row to keep it in the working batch.";
  }
}

function renderAchReturnHistory() {
  const tbody = el("ach-return-history-body");
  if (!tbody) return;
  const sessions = (Array.isArray(state.achReturns.sessions) ? state.achReturns.sessions : []).filter((session) =>
    ["imported", "imported_with_errors", "exported"].includes(String(session.final_status || session.status || ""))
  );
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No imported ACH batches yet.</td></tr>';
    return;
  }
  tbody.innerHTML = sessions.map((session) => `
    <tr>
      <td>${esc(formatDate(session.uploaded_at || ""))}</td>
      <td>${esc(session.row_count || 0)}</td>
      <td>${esc(session.ready_count || 0)}</td>
      <td>${esc(session.error_count || 0)}</td>
      <td>${esc(session.imported_row_count || session.successful_import_count || 0)}</td>
      <td>${esc(session.exported_at ? formatDate(session.exported_at) : "Not exported")}</td>
      <td>${esc(session.uploaded_by || "")}</td>
      <td class="table-action-cell">
        <button class="secondary-button table-action-button" data-ach-open-session="${esc(session.id)}">Open</button>
      </td>
    </tr>
  `).join("");
}

function updateAchReturnButtons() {
  const session = getCurrentAchReturnSession();
  const exportButton = el("ach-return-export-button");
  const clearButton = el("ach-return-clear-table-button");
  const confirmButton = el("ach-return-confirm-button");
  const rows = Array.isArray(session?.rows) ? session.rows : [];
  const readyRows = rows.filter((row) => (row.import_result_status || row.validation_status || "") === "ready");
  if (exportButton) {
    exportButton.disabled = !session || readyRows.length <= 0;
  }
  if (clearButton) {
    clearButton.disabled = !session || !Number(session.row_count || 0);
  }
  if (confirmButton) {
    const alreadyImported = ["imported", "imported_with_errors"].includes(String(session?.final_status || ""));
    const readyCount = readyRows.length;
    confirmButton.disabled = !session || readyCount <= 0 || alreadyImported;
    confirmButton.textContent = alreadyImported ? "Import Completed" : readyCount > 0 ? `Confirm Import (${readyCount})` : "Confirm Import";
  }
}

function renderAchReturnPage() {
  const textarea = el("ach-return-email-body");
  if (textarea && textarea.value !== state.achReturns.emailBody) {
    textarea.value = state.achReturns.emailBody || "";
  }
  const topLayout = document.querySelector(".ach-return-top-layout");
  if (topLayout) {
    topLayout.classList.toggle("is-single-panel", !state.achReturns.draft);
  }
  renderAchReturnReview();
  renderAchReturnTable();
  renderAchReturnHistory();
  updateAchReturnButtons();
}

async function loadAchReturnSession(sessionId) {
  const payload = await apiRequest(`/api/ach-returns/${encodeURIComponent(sessionId)}`);
  state.achReturns.currentSession = payload.session || null;
  state.achReturns.currentSessionId = payload.session?.id || "";
  persistUiState();
  renderAchReturnPage();
}

async function loadAchReturnData(preferredSessionId = "") {
  const payload = await apiRequest("/api/ach-returns");
  state.achReturns.sessions = payload.sessions || [];
  state.achReturns.currentSession = payload.currentSession || null;
  state.achReturns.currentSessionId = payload.currentSession?.id || "";
  if (preferredSessionId) {
    const preferredSession = (payload.sessions || []).find((session) => session.id === preferredSessionId);
    if (preferredSession && !isAchReturnImportedSession(preferredSession)) {
      await loadAchReturnSession(preferredSessionId);
      return;
    }
  }
  persistUiState();
  renderAchReturnPage();
}

async function handleAchReturnParse() {
  const emailBody = String(el("ach-return-email-body")?.value || state.achReturns.emailBody || "").trim();
  state.achReturns.emailBody = emailBody;
  if (!emailBody) {
    setStatus("ach-return-status", "Paste the ACH return email body first.");
    return;
  }
  setStatus("ach-return-status", "Parsing ACH return email...");
  console.debug("[ACH Returns] parse started", {
    bodyLength: emailBody.length,
    hasWindow: Boolean(typeof window !== "undefined"),
    timestamp: new Date().toISOString(),
  });
  try {
    let payload = null;
    const parseTargets = ["/api/ach-returns/parse", "/api/ach-returns/parse/"];
    const parseErrors = [];
    for (const parseTarget of parseTargets) {
      try {
        payload = await apiRequest(parseTarget, {
          method: "POST",
          body: { emailBody },
        });
        if (payload) break;
      } catch (parseError) {
        const parseMessage = String(parseError?.message || parseError);
        parseErrors.push(`${parseTarget}: ${parseMessage}`);
      }
    }

    if (!payload) {
      throw new Error(parseErrors[0] || "Unable to call ACH return parse endpoint.");
    }

    state.achReturns.draft = payload.preview || null;
    persistAchReturnDraftState();
    renderAchReturnPage();
    const errors = Array.isArray(payload.preview?.errors) ? payload.preview.errors : [];
    setStatus("ach-return-status", errors.length ? errors.join(" ") : "ACH return parsed successfully.");
  } catch (error) {
    console.error("[ACH Returns] parse failed", error);
    setStatus("ach-return-status", `Unable to parse ACH return email: ${error.message}`);
  }
}

async function handleAchReturnCreateRow() {
  const draft = state.achReturns.draft;
  const emailBody = String(el("ach-return-email-body")?.value || state.achReturns.emailBody || "").trim();
  if (!draft || !emailBody) {
    setStatus("ach-return-status", "Parse an ACH return email first.");
    return;
  }
  const selectedMatchKey = String(
    el("ach-return-match-select")?.value || draft.selectedMatchKey || draft.selectedMatch?.matchKey || ""
  ).trim();
  setStatus("ach-return-status", "Creating ACH reversal row...");
  try {
    const payload = await apiRequest("/api/ach-returns/rows", {
      method: "POST",
      body: {
        emailBody,
        selectedMatchKey,
        actor: "Local User",
      },
    });
    state.achReturns.sessions = payload.sessions || [];
    state.achReturns.currentSession = payload.session || null;
    state.achReturns.currentSessionId = payload.session?.id || "";
    if (payload.session?.duplicateDetected) {
      setStatus("ach-return-status", "This ACH return is already in the Export Table. A duplicate row was not added.");
    } else {
      state.achReturns.draft = null;
      state.achReturns.emailBody = "";
      clearPersistedAchReturnDraftState();
      const rowCount = Number(payload.session?.row_count || 0);
      setStatus(
        "ach-return-status",
        `Reversal credit row saved in the Export Table. ${rowCount || 1} row(s) are staged. Paste the next ACH return to add another, or click Confirm Import when the batch is ready.`
      );
    }
    persistUiState();
    renderAchReturnPage();
  } catch (error) {
    setStatus("ach-return-status", `Unable to create ACH reversal row: ${error.message}`);
  }
}

async function submitAchReturnImport(sessionId, confirmedBy = "Local User") {
  const importErrors = [];

  if (sessionId) {
    try {
      return await apiRequest(`/api/ach-returns/${encodeURIComponent(sessionId)}/confirm-import`, {
        method: "POST",
        body: {
          confirmedBy,
        },
      });
    } catch (error) {
      importErrors.push(error);
    }
  }

  try {
    return await apiRequest("/api/ach-returns/current/confirm-import", {
      method: "POST",
      body: {
        confirmedBy,
      },
    });
  } catch (fallbackError) {
    const primaryError = importErrors[0];
    if (primaryError) {
      throw new Error(`${primaryError.message} Fallback import failed: ${fallbackError.message}`);
    }
    throw fallbackError;
  }
}

async function handleAchReturnConfirmImport() {
  const draft = state.achReturns.draft;
  if (draft) {
    const draftErrors = Array.isArray(draft.errors) ? draft.errors.filter(Boolean) : [];
    const draftMatches = Array.isArray(draft.matches) ? draft.matches : [];
    const selectedMatchKey = String(
      el("ach-return-match-select")?.value || draft.selectedMatchKey || draft.selectedMatch?.matchKey || ""
    ).trim();
    const selectedMatch = draftMatches.find((entry) => entry.matchKey === selectedMatchKey) || draft.selectedMatch || null;
    const draftPendingCredit = selectedMatch ? buildAchReturnPendingCredit(draft.parsed || {}, selectedMatch) : null;
    if (draftErrors.length || !selectedMatch || !draftPendingCredit) {
      setStatus("ach-return-status", "Finish the visible ACH draft before importing. Save Row is required when the draft has errors or no matched payment.");
      setStatus("ach-return-export-status", "Finish the visible ACH draft before importing. Save Row is required when the draft has errors or no matched payment.");
      return;
    }
    await handleAchReturnCreateRow();
  }

  const session = getCurrentAchReturnSession();
  if (!session?.id) {
    setStatus("ach-return-status", "Open or save an ACH return batch before importing.");
    setStatus("ach-return-export-status", "Open or save an ACH return batch before importing.");
    return;
  }
  const rows = Array.isArray(session.rows) ? session.rows : [];
  const readyCount = rows.filter((row) => (row.import_result_status || row.validation_status || "") === "ready").length;
  const errorCount = Number(session.error_count || 0);
  if (readyCount <= 0) {
    setStatus("ach-return-status", "Save at least one ready ACH credit row before importing.");
    setStatus("ach-return-export-status", "Save at least one ready ACH credit row before importing.");
    return;
  }
  if (["imported", "imported_with_errors"].includes(String(session.final_status || ""))) {
    setStatus("ach-return-status", "This ACH return batch has already been imported.");
    setStatus("ach-return-export-status", "This ACH return batch has already been imported.");
    return;
  }
  const importStartMessage = [
    `Importing ${readyCount} ACH credit row(s) into Salesforce...`,
    errorCount > 0 ? `${errorCount} row(s) with errors will be skipped.` : "",
  ].filter(Boolean).join(" ");
  setStatus("ach-return-status", importStartMessage);
  setStatus("ach-return-export-status", importStartMessage);
  try {
    const payload = await submitAchReturnImport(session.id, "Local User");
    state.achReturns.sessions = payload.sessions || [];
    state.achReturns.draft = null;
    state.achReturns.emailBody = "";
    clearPersistedAchReturnDraftState();
    await loadAchReturnData("");
    const finishedMessage = `Salesforce import finished. Success: ${Number(payload.session?.successful_import_count || payload.session?.imported_row_count || 0)}. Failed: ${Number(payload.session?.salesforce_failed_row_count || 0)}. The imported batch has been moved to ACH Return History.`;
    setStatus("ach-return-status", finishedMessage);
    setStatus("ach-return-export-status", finishedMessage);
  } catch (error) {
    setStatus("ach-return-status", `Import failed: ${error.message}`);
    setStatus("ach-return-export-status", `Import failed: ${error.message}`);
  }
}

function handleAchReturnClearDraft() {
  state.achReturns.draft = null;
  state.achReturns.emailBody = "";
  clearPersistedAchReturnDraftState();
  renderAchReturnPage();
  setStatus("ach-return-status", "Draft cleared.");
}

async function handleAchReturnClearTable() {
  setStatus("ach-return-export-status", "Clearing ACH return export table...");
  try {
    const payload = await apiRequest("/api/ach-returns/current/clear", {
      method: "POST",
      body: {},
    });
    state.achReturns.sessions = payload.sessions || [];
    state.achReturns.currentSession = payload.currentSession || null;
    state.achReturns.currentSessionId = payload.currentSession?.id || "";
    state.achReturns.draft = null;
    state.achReturns.emailBody = "";
    clearPersistedAchReturnDraftState();
    persistUiState();
    renderAchReturnPage();
    setStatus("ach-return-export-status", "ACH return export table cleared.");
  } catch (error) {
    setStatus("ach-return-export-status", `Unable to clear ACH return table: ${error.message}`);
  }
}

async function handleAchReturnExport() {
  const session = getCurrentAchReturnSession();
  if (!session?.id) return;
  try {
    await apiDownload(`/api/ach-returns/${encodeURIComponent(session.id)}/export`, `ach-returns-${session.id}.csv`);
    await loadAchReturnData("");
    setStatus("ach-return-export-status", "ACH returns CSV exported.");
  } catch (error) {
    setStatus("ach-return-export-status", `Unable to export ACH returns CSV: ${error.message}`);
  }
}

function bindAchReturnEvents() {
  el("ach-return-email-body")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    state.achReturns.emailBody = target.value || "";
    persistAchReturnDraftState();
  });

  const inFlightActions = new Set();
  const safeHandle = async (handler, actionLabel, statusTarget = "ach-return-status") => {
    if (inFlightActions.has(actionLabel)) {
      return;
    }
    try {
      inFlightActions.add(actionLabel);
      console.debug(`[ACH Returns] ${actionLabel} action invoked`);
      await handler();
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`[ACH Returns] ${actionLabel} action failed`, error);
      setStatus(statusTarget, `${actionLabel} failed: ${message}`);
    } finally {
      inFlightActions.delete(actionLabel);
    }
  };

  const registerAchReturnAction = (id, handler, statusContext = "ach-return-status") => {
    const button = el(id);
    if (!button) return;
    button.dataset.achReturnAction = "1";
    const listener = (event) => {
      event?.preventDefault?.();
      if (button.disabled) return;
      void safeHandle(handler, id, statusContext);
    };
    button.addEventListener("click", listener, { capture: true });
  };

  const bindAchReturnAction = (id, handler) => {
    registerAchReturnAction(id, handler, id === "ach-return-export-button" || id === "ach-return-clear-table-button" ? "ach-return-export-status" : "ach-return-status");
  };

  bindAchReturnAction("ach-return-parse-button", async () => {
    await handleAchReturnParse();
  });
  bindAchReturnAction("ach-return-create-row-button", async () => {
    await handleAchReturnCreateRow();
  });
  bindAchReturnAction("ach-return-clear-draft-button", () => {
    handleAchReturnClearDraft();
  });
  bindAchReturnAction("ach-return-clear-table-button", async () => {
    await handleAchReturnClearTable();
  });
  bindAchReturnAction("ach-return-export-button", async () => {
    await handleAchReturnExport();
  });
  bindAchReturnAction("ach-return-confirm-button", async () => {
    await handleAchReturnConfirmImport();
  });

  window.__hpaHandleAchReturnParse = () => void safeHandle(() => handleAchReturnParse(), "ach-return parse");
  window.__hpaHandleAchReturnCreateRow = () => void safeHandle(() => handleAchReturnCreateRow(), "ach-return create");
  window.__hpaHandleAchReturnClearDraft = () => void safeHandle(() => handleAchReturnClearDraft(), "ach-return clear draft");
  window.__hpaHandleAchReturnExport = () => void safeHandle(() => handleAchReturnExport(), "ach-return export", "ach-return-export-status");
  window.__hpaHandleAchReturnConfirmImport = () => void safeHandle(() => handleAchReturnConfirmImport(), "ach-return confirm import");
  window.__hpaHandleAchReturnClearTable = () =>
    void safeHandle(() => handleAchReturnClearTable(), "ach-return clear table", "ach-return-export-status");

  const achReturnsView = document.querySelector('[data-view="ach-returns"]');
  achReturnsView?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    console.debug("[ACH Returns] delegated click", { id: button.id });
    if (button.dataset.achReturnAction === "1") {
      return;
    }

    if (button.id === "ach-return-parse-button") {
      void handleAchReturnParse();
      return;
    }

    if (button.id === "ach-return-create-row-button") {
      void handleAchReturnCreateRow();
      return;
    }

    if (button.id === "ach-return-clear-draft-button") {
      handleAchReturnClearDraft();
      return;
    }

    if (button.id === "ach-return-clear-table-button") {
      void handleAchReturnClearTable();
      return;
    }

    if (button.id === "ach-return-export-button") {
      void handleAchReturnExport();
      return;
    }

    if (button.id === "ach-return-confirm-button") {
      void handleAchReturnConfirmImport();
    }
  });

  el("ach-return-table-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const saveDraft = target.getAttribute("data-ach-save-draft");
    if (saveDraft) {
      await handleAchReturnCreateRow();
      return;
    }
    const rowId = target.getAttribute("data-ach-remove-row");
    const session = getCurrentAchReturnSession();
    if (!rowId || !session?.id) return;
    if (!confirm("Delete this ACH reversal row from the Export Table?")) {
      return;
    }
    try {
      const payload = await apiRequest(`/api/ach-returns/${encodeURIComponent(session.id)}/rows/${encodeURIComponent(rowId)}`, {
        method: "DELETE",
      });
      state.achReturns.sessions = payload.sessions || [];
      state.achReturns.currentSession = payload.session || null;
      state.achReturns.currentSessionId = payload.session?.id || "";
      persistUiState();
      renderAchReturnPage();
      setStatus("ach-return-export-status", "ACH reversal row removed.");
    } catch (error) {
      setStatus("ach-return-export-status", `Unable to remove ACH reversal row: ${error.message}`);
    }
  });

  el("ach-return-history-body")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const sessionId = target.getAttribute("data-ach-open-session");
    if (!sessionId) return;
    setStatus("ach-return-status", "Opening ACH return session...");
    try {
      await loadAchReturnSession(sessionId);
      setStatus("ach-return-status", "ACH return session opened.");
    } catch (error) {
      setStatus("ach-return-status", `Unable to open ACH return session: ${error.message}`);
    }
  });

  el("ach-return-review-panel")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.id !== "ach-return-match-select") return;
    if (!state.achReturns.draft) return;
    state.achReturns.draft.selectedMatchKey = target.value || "";
    const matches = Array.isArray(state.achReturns.draft.matches) ? state.achReturns.draft.matches : [];
    state.achReturns.draft.selectedMatch = matches.find((entry) => entry.matchKey === state.achReturns.draft.selectedMatchKey) || null;
    persistAchReturnDraftState();
    renderAchReturnPage();
  });
}

function showAnalysisPanel(panelName) {
  state.analysis.panel = panelName;
  persistUiState();
  const homePanel = el("analysis-home-panel");
  const previousPanel = el("analysis-previous-panel");
  const workspacePanel = el("analysis-workspace");
  const comparePanel = el("analysis-compare-panel");
  const compareReviewPanel = el("analysis-comparison-review-panel");
  const workspaceVisible = ["workspace", "compare", "compare-review"].includes(panelName);
  show(homePanel, panelName === "home");
  show(previousPanel, panelName === "previous");
  show(workspacePanel, workspaceVisible);
  show(comparePanel, panelName === "compare");
  show(compareReviewPanel, panelName === "compare-review");
  updateAnalysisWorkflowButtons();

  if (workspaceVisible) {
    setAnalysisSubtab(state.analysis.subtab || "runs");
    setMailingListTab(state.analysis.mailingListType || "dnm");
    if (panelName === "workspace") {
      renderAnalysisWorkspace();
    }
    if (panelName === "workspace" && (state.analysis.subtab || "runs") === "runs") {
      loadAnalysisReports().catch((error) => {
        setStatus("analysis-status-detail", `Unable to load analysis reports: ${error.message}`);
      });
    } else if (panelName === "workspace") {
      loadAndRenderMailingList(state.analysis.mailingListType || "dnm").catch((error) => {
        setStatus("mailing-list-status", `Unable to load mailing list: ${error.message}`);
      });
    }
  }

  if (panelName === "compare") {
    try {
      renderAnalysisComparePanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      setStatus("analysis-comparison-status", `Unable to open comparison setup: ${message}`);
    }
    comparePanel?.scrollIntoView({ behavior: "auto", block: "start" });
    ensureVisibleAnalysisPanel();
    return;
  }

  if (panelName === "compare-review") {
    try {
      logComparisonSetupPersistenceContext("enter-review-analysis");
      renderComparisonReviewPanelShell();
      renderAnalysisComparisonReviewPanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      renderComparisonReviewPanelShell();
      if (compareReviewPanel) {
        const statusText = compareReviewPanel.querySelector("#analysis-comparison-selection-status");
        if (statusText) {
          statusText.textContent = `Unable to open comparison review: ${message}`;
        }
        const results = compareReviewPanel.querySelector("#analysis-comparison-results");
        if (results) {
          results.innerHTML = `<div class="empty-state-block">Comparison review failed to render. ${esc(message)}</div>`;
        }
      }
      setStatus("analysis-comparison-selection-status", `Unable to open comparison review: ${message}`);
    }
    compareReviewPanel?.scrollIntoView({ behavior: "auto", block: "start" });
    ensureVisibleAnalysisPanel();
    return;
  }

  if (panelName === "home") {
    renderAnalysisSetupHome();
    homePanel?.scrollIntoView({ behavior: "auto", block: "start" });
  }

  if (panelName === "previous") {
    loadAnalysisSetups().catch((error) => {
      setStatus("analysis-setup-status", `Unable to load analysis list: ${error.message}`);
    });
    previousPanel?.scrollIntoView({ behavior: "auto", block: "start" });
    ensureVisibleAnalysisPanel();
    return;
  }

  if (panelName === "workspace") {
    workspacePanel?.scrollIntoView({ behavior: "auto", block: "start" });
    ensureVisibleAnalysisPanel();
    return;
  }

  state.analysis.subtab = "runs";
  ensureVisibleAnalysisPanel();
}

function createEmptyPull(index = 0) {
  return {
    id: createClientId("pull"),
    reportId: DEFAULT_ANALYSIS_REPORT_ID,
    analysisLabel: "",
    keyCodes: [],
    years: [],
    dateRange: null,
    scf: "",
    clientType: "",
    notes: "",
  };
}

function normalizeKeyCodeGroup(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "N") {
    return "NHCL";
  }
  return ANALYSIS_KEY_CODE_GROUPS.includes(normalized) ? normalized : "NHCL";
}

function syncAnalysisPullClientTypeWithKeyCodes(pull) {
  if (!pull || !Array.isArray(pull.keyCodes) || !pull.keyCodes.length) {
    if (pull) {
      pull.clientType = "";
    }
    return;
  }
  const normalizedKeyCodes = Array.from(new Set(
    pull.keyCodes
      .map((entry) => String(entry || "").trim().toUpperCase())
      .filter(Boolean)
      .map((entry) => entry === "NHCL" ? "N" : entry)
  ));
  if (normalizedKeyCodes.includes("N") && normalizedKeyCodes.includes("RFC")) {
    pull.clientType = "";
  } else if (normalizedKeyCodes.includes("N")) {
    pull.clientType = "NHCL";
  } else if (normalizedKeyCodes.includes("RFC")) {
    pull.clientType = "RFC";
  } else {
    pull.clientType = "";
  }
}

function getAnalysisReportKeyCodeGroup(report) {
  if (!report || typeof report !== "object") {
    return "";
  }

  const parameterSources = [
    report.parameters?.key_codes,
    report.parameters?.keyCodes,
    report.key_codes,
    report.keyCodes,
  ];
  for (const source of parameterSources) {
    const values = ensureArray(source)
      .map((entry) => String(entry || "").trim().toUpperCase())
      .filter(Boolean);
    const directMatch = values.find((entry) => ANALYSIS_KEY_CODE_GROUPS.includes(entry));
    if (directMatch) {
      return directMatch;
    }
  }

  const scalarSources = [
    report.parameters?.clientType,
    report.parameters?.client_type,
    report.clientType,
    report.client_type,
    report.category,
    report.keyCodeGroup,
    report.key_code_group,
  ];
  for (const source of scalarSources) {
    const normalized = String(source || "").trim().toUpperCase();
    if (ANALYSIS_KEY_CODE_GROUPS.includes(normalized)) {
      return normalized;
    }
  }

  const nameSources = [
    report.name,
    report.report_name,
    report.reportName,
    getAnalysisReportDisplayName(report),
  ];
  for (const source of nameSources) {
    const match = String(source || "").trim().match(/^(NHCL|RFC)\b/i);
    if (match) {
      return String(match[1] || "").trim().toUpperCase();
    }
  }

  return "";
}

function resolveAnalysisComparisonNameFromGroup(keyCodeGroup = "") {
  return String(keyCodeGroup || "").trim().toUpperCase() === "RFC" ? "Refinance" : "New Home";
}

function inferAnalysisComparisonKeyCodeGroupFromPull(pull = {}) {
  const directSources = [
    pull?.keyCodeGroup,
    pull?.key_code_group,
    pull?.clientType,
    pull?.client_type,
  ];

  for (const source of directSources) {
    const normalized = String(source || "").trim().toUpperCase();
    if (ANALYSIS_KEY_CODE_GROUPS.includes(normalized)) {
      return normalized;
    }
    if (normalized === "N") {
      return "NHCL";
    }
  }

  const keyCodes = ensureArray(pull?.keyCodes ?? pull?.key_codes)
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter(Boolean);
  if (keyCodes.includes("RFC")) {
    return "RFC";
  }
  if (keyCodes.includes("NHCL") || keyCodes.includes("N")) {
    return "NHCL";
  }

  const nameSources = [
    pull?.reportName,
    pull?.report_name,
    pull?.analysisLabel,
    pull?.label,
    pull?.name,
  ];
  for (const source of nameSources) {
    const text = String(source || "").trim();
    if (!text) continue;
    if (/^RFC\b/i.test(text) || /^Refinance\b/i.test(text)) {
      return "RFC";
    }
    if (/^NHCL\b/i.test(text) || /^New Home\b/i.test(text)) {
      return "NHCL";
    }
  }

  return "";
}

function deriveComparisonKeyCodeGroupFromReportIds(reportIds = []) {
  const reportMap = getAvailableAnalysisReportMap();
  const groups = Array.from(
    new Set(
      ensureArray(reportIds)
        .map((reportId) => reportMap.get(String(reportId || "").trim()))
        .map((report) => getAnalysisReportKeyCodeGroup(report))
        .filter(Boolean)
    )
  );

  if (!groups.length) {
    return "";
  }

  if (groups.length > 1) {
    return "MIXED";
  }

  return groups[0];
}

function getComparisonReviewMailingListType() {
  const comparisons = Array.isArray(state.analysis.comparisonRequests)
    ? state.analysis.comparisonRequests
    : [];
  const selectedId = String(state.analysis.selectedComparisonId || "").trim();
  const comparison = comparisons.find((entry) => entry.id === selectedId) || comparisons[0] || null;
  const keyGroup = normalizeKeyCodeGroup(comparison?.keyCodeGroup || comparison?.codeList || "");
  return keyGroup === "RFC" ? "rfc" : "nhcl";
}

function getDefaultComparisonName(index = 0) {
  return `Comparison ${index + 1}`;
}

function resolveComparisonName(value, index = 0) {
  return String(value || "").trim() || getDefaultComparisonName(index);
}

function getComparisonDisplayName(comparison = {}, index = 0) {
  return resolveComparisonName(
    comparison.comparisonName || comparison.name || comparison.label || "",
    index
  );
}

function hasCustomComparisonName(comparison = {}, index = 0) {
  const rawName = String(
    comparison.comparisonName || comparison.name || comparison.label || ""
  ).trim();
  return Boolean(rawName) && rawName !== getDefaultComparisonName(index);
}

function getPreferredComparisonId(comparisons = []) {
  const lastEdited = comparisons.find((entry) => entry.id === state.analysis.lastEditedComparisonId);
  if (lastEdited) {
    return lastEdited.id;
  }

  const selected = comparisons.find((entry) => entry.id === state.analysis.selectedComparisonId);
  if (selected) {
    return selected.id;
  }

  const firstCustomNamed = comparisons.find((entry, index) => hasCustomComparisonName(entry, index));
  return firstCustomNamed?.id || comparisons[0]?.id || "";
}

function hasUsableComparisonSelection(entries = []) {
  return ensureArray(entries).some((entry) => getComparisonSelectedReportIds(entry).length >= 2);
}

function buildRecoveredComparisonLinksFromWorkspace() {
  const pullsByGroup = new Map();
  const reportMap = buildComparisonReviewReportMap();

  ensureArray(state.analysis.reportPulls).forEach((pull) => {
    const candidateIds = [
      pull?.savedReportId,
      pull?.id,
      pull?.pullId,
      pull?.pull_id,
    ]
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    const matchedReport = candidateIds
      .map((reportId) => reportMap.get(reportId))
      .find(Boolean);
    const keyCodeGroup = getAnalysisReportKeyCodeGroup(matchedReport) || inferAnalysisComparisonKeyCodeGroupFromPull(pull);
    const selectedReportId = String(
      pull?.savedReportId
      || matchedReport?.id
      || pull?.id
      || ""
    ).trim();
    if (!keyCodeGroup || !selectedReportId) {
      return;
    }
    const existing = pullsByGroup.get(keyCodeGroup) || [];
    existing.push(selectedReportId);
    pullsByGroup.set(keyCodeGroup, existing);
  });

  if (!pullsByGroup.size) {
    ensureArray(state.analysis.savedReports).forEach((report) => {
      const keyCodeGroup = getAnalysisReportKeyCodeGroup(report);
      const reportId = String(report?.id || "").trim();
      if (!keyCodeGroup || !reportId) {
        return;
      }
      const existing = pullsByGroup.get(keyCodeGroup) || [];
      existing.push(reportId);
      pullsByGroup.set(keyCodeGroup, existing);
    });
  }

  return Array.from(pullsByGroup.entries())
    .map(([keyCodeGroup, reportIds], index) => {
      const selectedReportIds = Array.from(new Set(reportIds.filter(Boolean))).slice(0, 5);
      if (selectedReportIds.length < 2) {
        return null;
      }
      return createComparisonLink(index, {
        id: `comparison_${String(keyCodeGroup || index + 1).trim().toLowerCase()}`,
        comparisonName: resolveAnalysisComparisonNameFromGroup(keyCodeGroup),
        keyCodeGroup,
        selectedReportIds,
        reportIds: selectedReportIds,
        reportAId: selectedReportIds[0] || "",
        reportBId: selectedReportIds[1] || "",
      });
    })
    .filter(Boolean);
}

function recoverComparisonSetupFromWorkspace() {
  if (
    hasUsableComparisonSelection(state.analysis.comparisonRequests)
    || hasUsableComparisonSelection(state.analysis.comparisonLinks)
  ) {
    return false;
  }

  const recoveredLinks = buildRecoveredComparisonLinksFromWorkspace();
  if (!recoveredLinks.length) {
    return false;
  }

  state.analysis.comparisonLinks = recoveredLinks;
  state.analysis.comparisonRequests = recoveredLinks.map((entry, index) => createComparisonLink(index, entry));
  if (!state.analysis.selectedComparisonId) {
    state.analysis.selectedComparisonId = recoveredLinks[0]?.id || "";
  }
  if (!state.analysis.lastEditedComparisonId) {
    state.analysis.lastEditedComparisonId = recoveredLinks[0]?.id || "";
  }
  return true;
}

function buildSavedReportIdByPullIdMap(savedReports = state.analysis.savedReports) {
  return new Map(
    ensureArray(savedReports)
      .map((report) => [String(report?.pullId || report?.pull_id || "").trim(), String(report?.id || "").trim()])
      .filter(([pullId, reportId]) => pullId && reportId)
  );
}

function remapAnalysisReportIdentifier(reportId, savedReportIdByPullId = buildSavedReportIdByPullIdMap()) {
  const normalizedId = String(reportId || "").trim();
  if (!normalizedId) {
    return "";
  }
  return String(savedReportIdByPullId.get(normalizedId) || normalizedId).trim();
}

function remapComparisonReportIdsWithSavedReports(collection = [], savedReportIdByPullId = buildSavedReportIdByPullIdMap()) {
  return ensureArray(collection).map((entry, index) => {
    const clonedEntry = entry && typeof entry === "object" ? { ...entry } : createComparisonLink(index);
    const rawIds = Array.isArray(clonedEntry.selectedReportIds) && clonedEntry.selectedReportIds.length
      ? clonedEntry.selectedReportIds
      : Array.isArray(clonedEntry.reportIds) && clonedEntry.reportIds.length
        ? clonedEntry.reportIds
        : [clonedEntry.reportAId, clonedEntry.reportBId];
    const remappedIds = Array.from(
      new Set(
        ensureArray(rawIds)
          .map((reportId) => remapAnalysisReportIdentifier(reportId, savedReportIdByPullId))
          .filter(Boolean)
      )
    ).slice(0, 5);
    clonedEntry.selectedReportIds = remappedIds;
    clonedEntry.reportIds = remappedIds;
    clonedEntry.reportAId = remappedIds[0] || "";
    clonedEntry.reportBId = remappedIds[1] || "";
    return clonedEntry;
  });
}

function hydrateAnalysisWorkspaceFromSavedReports() {
  const savedReportIdByPullId = buildSavedReportIdByPullIdMap();
  if (!savedReportIdByPullId.size && !ensureArray(state.analysis.savedReports).length) {
    return;
  }

  state.analysis.reportPulls = ensureArray(state.analysis.reportPulls).map((pull) => {
    const pullId = String(pull?.id || "").trim();
    const savedReportId = String(pull?.savedReportId || savedReportIdByPullId.get(pullId) || "").trim();
    if (!savedReportId || savedReportId === String(pull?.savedReportId || "").trim()) {
      return pull;
    }
    return {
      ...pull,
      savedReportId,
    };
  });

  state.analysis.comparisonLinks = remapComparisonReportIdsWithSavedReports(
    state.analysis.comparisonLinks,
    savedReportIdByPullId
  );
  state.analysis.comparisonRequests = remapComparisonReportIdsWithSavedReports(
    state.analysis.comparisonRequests,
    savedReportIdByPullId
  );

  state.analysis.reviewPrimaryReportIds = normalizeReviewSyncMap(
    Object.fromEntries(
      Object.entries(state.analysis.reviewPrimaryReportIds || {}).map(([comparisonId, reportId]) => ([
        comparisonId,
        remapAnalysisReportIdentifier(reportId, savedReportIdByPullId),
      ]))
    )
  );

  ensureArray(state.analysis.comparisonRequests).forEach((comparison) => {
    const comparisonId = String(comparison?.id || "").trim();
    if (!comparisonId) {
      return;
    }
    const selectedIds = ensureArray(comparison?.selectedReportIds).length
      ? ensureArray(comparison.selectedReportIds)
      : ensureArray(comparison?.reportIds);
    if (!selectedIds.length) {
      return;
    }
    if (!String(state.analysis.reviewPrimaryReportIds?.[comparisonId] || "").trim()) {
      state.analysis.reviewPrimaryReportIds[comparisonId] = String(selectedIds[0] || "").trim();
    }
  });
}

function focusComparisonReviewSummary() {
  // intentionally no-op: preventing review navigation from forcing page-level scroll.
}

function invalidateComparisonReviewSummary() {
  try {
    state.analysis.reviewSummary = buildComparisonReviewSummaryFromClient();
  } catch {
    state.analysis.reviewSummary = null;
  }
  state.analysis.reviewSummaryMode = "review";
  state.analysis.reviewSummaryApproved = false;
}

function getReviewBaselineListMap() {
  const lists = Array.isArray(state.analysis.reviewBaselineLists)
    ? state.analysis.reviewBaselineLists
    : [];
  const map = new Map();
  lists.forEach((entry) => {
    if (!entry || !entry.type) return;
    const normalizedType = String(entry.type).trim().toLowerCase();
    map.set(normalizedType, ensureArray(entry.items).map((item) => normalizeScf(item?.scf)).filter(Boolean));
  });
  return map;
}

function getReviewWorkingListMap() {
  const lists = Array.isArray(state.analysis.reviewWorkingLists)
    ? state.analysis.reviewWorkingLists
    : [];
  return buildReviewListMapFromSnapshots(lists);
}

function buildReviewListMapFromSnapshots(lists = []) {
  const map = new Map();
  ensureArray(lists).forEach((entry) => {
    if (!entry || !entry.type) return;
    const normalizedType = String(entry.type).trim().toLowerCase();
    map.set(normalizedType, ensureArray(entry.items).map((item) => {
      const scf = normalizeScf(item?.scf);
      if (!scf) return null;
      return {
        scf,
        state: String(item?.state || item?.scope || "").trim(),
      };
    }).filter(Boolean));
  });
  return map;
}

function normalizeSummaryRows(rows) {
  return (ensureArray(rows) || [])
    .map((entry) => ({
      scf: normalizeScf(entry?.scf || entry),
      state: String(entry?.state || "").trim(),
    }))
    .filter((entry) => entry.scf);
}

function buildComparisonReviewSummaryFromSnapshots(baselineLists = [], workingLists = [], runNotesValue = "") {
  const baselineMap = buildReviewListMapFromSnapshots(baselineLists);
  const workingMap = buildReviewListMapFromSnapshots(workingLists);
  const dnmSet = new Set(normalizeSummaryRows(baselineMap.get("dnm") || []).map((entry) => entry.scf));
  const listTypes = ["nhcl", "rfc"];
  const result = {};
  const runNotes = String(runNotesValue || "").trim();

  listTypes.forEach((listType) => {
    const baselineRows = normalizeSummaryRows(baselineMap.get(listType) || []);
    const workingRows = normalizeSummaryRows(workingMap.get(listType) || []);
    const baselineByScf = new Map();
    const workingByScf = new Map();

    baselineRows.forEach((entry) => {
      baselineByScf.set(entry.scf, entry);
    });
    workingRows.forEach((entry) => {
      workingByScf.set(entry.scf, entry);
    });

    const added = [];
    const removed = [];
    const blocked = [];

    workingRows.forEach((entry) => {
      if (!baselineByScf.has(entry.scf)) {
        const blockedReason = dnmSet.has(entry.scf)
          ? "Do Not Mail"
          : "";
        if (blockedReason) {
          blocked.push({ ...entry, reason: blockedReason });
        } else {
          added.push(entry);
        }
      }
    });

    baselineRows.forEach((entry) => {
      if (!workingByScf.has(entry.scf)) {
        removed.push(entry);
      }
    });

    result[listType] = {
      added: added.sort((a, b) => a.scf.localeCompare(b.scf)),
      removed: removed.sort((a, b) => a.scf.localeCompare(b.scf)),
      blocked: blocked.sort((a, b) => a.scf.localeCompare(b.scf)),
      addedCount: added.length,
      removedCount: removed.length,
      blockedCount: blocked.length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    runNotes,
    lists: result,
    summary: {
      nhclAdded: result.nhcl.addedCount,
      nhclRemoved: result.nhcl.removedCount,
      rfcAdded: result.rfc.addedCount,
      rfcRemoved: result.rfc.removedCount,
      blockedCount: result.nhcl.blockedCount + result.rfc.blockedCount,
    },
    violations: [
      ...result.nhcl.blocked,
      ...result.rfc.blocked,
    ],
  };
}

function buildComparisonReviewSummaryFromClient() {
  return buildComparisonReviewSummaryFromSnapshots(
    state.analysis.reviewBaselineLists,
    state.analysis.reviewWorkingLists,
    state.analysis.runNotes
  );
}

function hasReviewListSnapshotItems(lists = []) {
  return ensureArray(lists).some((entry) => ensureArray(entry?.items).length > 0);
}

function getEffectiveComparisonReviewSummary() {
  const savedSummary = state.analysis.reviewSummary && typeof state.analysis.reviewSummary === "object"
    ? cloneData(state.analysis.reviewSummary)
    : null;
  const hasLiveReviewLists =
    hasReviewListSnapshotItems(state.analysis.reviewBaselineLists)
    || hasReviewListSnapshotItems(state.analysis.reviewWorkingLists);

  if (!hasLiveReviewLists) {
    return savedSummary || {};
  }

  try {
    const liveSummary = buildComparisonReviewSummaryFromClient();
    return {
      ...(savedSummary || {}),
      ...liveSummary,
      generatedAt: liveSummary.generatedAt || savedSummary?.generatedAt || new Date().toISOString(),
      runNotes: String(liveSummary.runNotes || savedSummary?.runNotes || state.analysis.runNotes || "").trim(),
      completedAt: savedSummary?.completedAt || liveSummary.completedAt || null,
      completedByName: savedSummary?.completedByName || liveSummary.completedByName || "",
      completedOnDate: savedSummary?.completedOnDate || liveSummary.completedOnDate || "",
      canUndoLatestCompletion: savedSummary?.canUndoLatestCompletion === true || liveSummary.canUndoLatestCompletion === true,
    };
  } catch {
    return savedSummary || {};
  }
}

function buildWorkingCopyCleanupSummary() {
  const diagnostics = normalizeReviewZeroRemovalDiagnostics(state.analysis.reviewZeroRemovalDiagnostics || null);
  const activeActions = getActiveZeroRateRemovalActions().filter((entry) => entry.isPending);
  const entries = activeActions.map((action) => ({
    id: action.id,
    status: "removed",
    listType: String(action.listType || "").trim().toLowerCase(),
    comparisonName: String(action.comparisonName || diagnostics?.comparisonName || "").trim(),
    primaryReportName: String(action.primaryReportName || "").trim(),
    fieldUsed: String(action.fieldUsed || diagnostics?.zeroRemovalFieldUsed || "").trim(),
    checkedCount: Number(action.checkedCount || diagnostics?.totalReportRowsChecked || 0),
    removedCount: Number(action.activeRemovedCount || 0),
    totalMailedRemoved: Number(action.totalMailedRemoved || 0),
    scfs: ensureArray(action.activeRemovedScfs).map((scf) => normalizeScf(scf)).filter(Boolean),
    foundScfs: ensureArray(action.foundZeroRateScfs).map((scf) => normalizeScf(scf)).filter(Boolean),
    skippedAlreadyRemovedScfs: ensureArray(action.skippedAlreadyRemovedScfs).map((scf) => normalizeScf(scf)).filter(Boolean),
    skippedDnmScfs: ensureArray(action.skippedDnmScfs).map((scf) => normalizeScf(scf)).filter(Boolean),
    createdAt: String(action.createdAt || diagnostics?.zeroRemovalLastResult?.checkedAt || "").trim(),
    message: [
      `Removed ${Number(action.activeRemovedCount || 0)} zero-value SCF(s)`,
      action.primaryReportName ? `from ${action.primaryReportName}` : "",
      action.fieldUsed || diagnostics?.zeroRemovalFieldUsed ? `using ${action.fieldUsed || diagnostics?.zeroRemovalFieldUsed}` : "",
    ].filter(Boolean).join(" "),
  }));

  const lastResult = diagnostics?.zeroRemovalLastResult && typeof diagnostics.zeroRemovalLastResult === "object"
    ? diagnostics.zeroRemovalLastResult
    : null;

  if (!entries.length && lastResult && lastResult.status && lastResult.status !== "undone") {
    entries.push({
      id: "",
      status: String(lastResult.status || "").trim(),
      listType: "",
      comparisonName: String(diagnostics?.comparisonName || "").trim(),
      primaryReportName: "",
      fieldUsed: String(diagnostics?.zeroRemovalFieldUsed || "").trim(),
      checkedCount: Number(diagnostics?.totalReportRowsChecked || 0),
      removedCount: Number(lastResult.removedCount || 0),
      totalMailedRemoved: Number(lastResult.totalMailedRemoved || 0),
      scfs: [],
      foundScfs: [],
      skippedAlreadyRemovedScfs: [],
      skippedDnmScfs: [],
      createdAt: String(lastResult.checkedAt || "").trim(),
      message: String(lastResult.message || "").trim(),
    });
  }

  return {
    entries,
    hasVisibleResult: entries.length > 0,
  };
}

function mergeWorkingCopyCleanupIntoSummary(summary, cleanupSummary) {
  const nextSummary = cloneData(summary || {});
  if (!cleanupSummary?.entries?.length) {
    return nextSummary;
  }

  if (!nextSummary.lists || typeof nextSummary.lists !== "object") {
    nextSummary.lists = {};
  }
  ["nhcl", "rfc"].forEach((listType) => {
    if (!nextSummary.lists[listType] || typeof nextSummary.lists[listType] !== "object") {
      nextSummary.lists[listType] = { added: [], removed: [], blocked: [], addedCount: 0, removedCount: 0, blockedCount: 0 };
    }
  });
  if (!nextSummary.summary || typeof nextSummary.summary !== "object") {
    nextSummary.summary = { nhclAdded: 0, nhclRemoved: 0, rfcAdded: 0, rfcRemoved: 0, blockedCount: 0 };
  }

  cleanupSummary.entries
    .filter((entry) => entry.status === "removed" && entry.listType && entry.scfs.length)
    .forEach((entry) => {
      const listType = entry.listType;
      const removedRows = ensureArray(nextSummary.lists?.[listType]?.removed);
      const removedSet = new Set(removedRows.map((row) => normalizeScf(row?.scf)).filter(Boolean));
      entry.scfs.forEach((scf) => {
        if (removedSet.has(scf)) {
          return;
        }
        removedRows.push({
          scf,
          state: "",
          reason: [
            entry.fieldUsed ? `Zero ${entry.fieldUsed} cleanup` : "Zero-value cleanup",
            entry.primaryReportName ? `from ${entry.primaryReportName}` : "",
            "working copy only",
          ].filter(Boolean).join(" | "),
        });
        removedSet.add(scf);
      });
      removedRows.sort((a, b) => String(a?.scf || "").localeCompare(String(b?.scf || "")));
      nextSummary.lists[listType].removed = removedRows;
      nextSummary.lists[listType].removedCount = removedRows.length;
      if (listType === "nhcl") {
        nextSummary.summary.nhclRemoved = removedRows.length;
      } else if (listType === "rfc") {
        nextSummary.summary.rfcRemoved = removedRows.length;
      }
    });

  return nextSummary;
}

function renderWorkingCopyCleanupSummaryCard(cleanupSummary, readOnly = false) {
  if (!cleanupSummary?.entries?.length) {
    return "";
  }

  return `
    <article class="panel analysis-review-summary-card">
      <h4>Working Copy Cleanup Summary</h4>
      <div class="analysis-review-summary-list analysis-review-summary-list-rows">
        ${cleanupSummary.entries.map((entry) => `
          <div class="analysis-review-summary-row-item">
            <strong>${esc(entry.message || "Working copy cleanup result")}</strong>
            ${entry.comparisonName ? `<span>${esc(entry.comparisonName)}</span>` : ""}
            ${entry.primaryReportName ? `<span>${esc(entry.primaryReportName)}</span>` : ""}
            ${entry.fieldUsed ? `<span>Field: ${esc(entry.fieldUsed)}</span>` : ""}
            ${entry.checkedCount ? `<span>Rows checked: ${Number(entry.checkedCount).toLocaleString("en-US")}</span>` : ""}
            <span>Rows removed: ${Number(entry.removedCount || 0).toLocaleString("en-US")}</span>
            <span>Mailed removed: ${Number(entry.totalMailedRemoved || 0).toLocaleString("en-US")}</span>
            ${entry.scfs.length ? `<span>SCFs: ${esc(entry.scfs.join(", "))}</span>` : ""}
            ${entry.skippedAlreadyRemovedScfs.length ? `<span>Already not on working list: ${esc(entry.skippedAlreadyRemovedScfs.join(", "))}</span>` : ""}
            ${entry.skippedDnmScfs.length ? `<span>Already DNM: ${esc(entry.skippedDnmScfs.join(", "))}</span>` : ""}
            ${entry.createdAt ? `<span>${esc(formatDate(entry.createdAt))}</span>` : ""}
            ${entry.id && entry.status === "removed" && !readOnly
              ? `<button class="secondary-button table-action-button" data-zero-rate-undo-action="${esc(entry.id)}">Undo</button>`
              : ""}
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function getReviewWorkingListPayload() {
  return (ensureArray(state.analysis.reviewWorkingLists) || []).map((entry) => ({
    type: entry.type,
    items: normalizeSummaryRows(ensureArray(entry.items)).map((item) => ({
      scf: item.scf,
      state: String(item.state || item.scope || "").trim(),
    })),
  }));
}

function setComparisonSummaryNotes(notes = "") {
  state.analysis.reviewSummaryNotes = String(notes || "").trim();
}

function isAutoAnalysisReviewNote(note = "") {
  return /^Bulk removal decision:|^Review decision:|^Review reset:/i.test(String(note || "").trim());
}

function getManualAnalysisReviewNotes(value = state.analysis.reviewSummaryNotes) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry && !isAutoAnalysisReviewNote(entry))
    .join("\n");
}

function buildZeroRateRemovalReviewNotesText() {
  const zeroRateSummary = buildZeroRateRemovalSummary();
  if (!zeroRateSummary.actions.length) {
    return "";
  }

  const lines = [
    `Pending working-copy removals: ${zeroRateSummary.totalRemovedCount} SCF(s) across ${zeroRateSummary.totalActionCount} action(s).`,
  ];

  zeroRateSummary.actions.forEach((action) => {
    lines.push(
      [
        action.comparisonName || action.comparisonId || "Comparison",
        action.primaryReportName || action.primaryReportId || "Primary report",
        `${String(action.listType || "").toUpperCase()} list`,
        action.removalKind === "zero-quantity"
          ? "Zero mailed quantity"
          : getReviewMetricDisplayName(action.metricKey),
        `${Number(action.activeRemovedCount || 0)} removed`,
        `${Number(action.totalMailedRemoved || 0).toLocaleString("en-US")} mailed removed`,
        action.activeRemovedScfs.join(", "),
      ]
        .filter(Boolean)
        .join(" | ")
    );
  });

  return lines.join("\n");
}

function getEffectiveAnalysisReviewNotes() {
  return getManualAnalysisReviewNotes(state.analysis.reviewSummaryNotes);
}

function ensureComparisonReviewPanelToolbar() {
  const panel = el("analysis-comparison-review-panel");
  if (!panel) {
    return;
  }
  const hasSummarizeButton = !!panel.querySelector("#summarize-comparison-review-button");
  const hasCompleteButton = !!panel.querySelector("#complete-comparison-review-button");

  if (!hasSummarizeButton || !hasCompleteButton) {
    renderComparisonReviewPanelShell();
  }
}

function renderComparisonReviewPanelShell() {
  const panel = el("analysis-comparison-review-panel");
  if (!panel) {
    return;
  }
  const detachedWindow = isAnalysisReviewPopupWindow();
  const readOnly = isCurrentAnalysisReadOnly();

  panel.innerHTML = `
    <section class="analysis-step-indicator-panel">
      <div class="analysis-step-indicator">
        <article class="analysis-step is-complete">
          <span class="analysis-step-number">1</span>
          <div>
            <strong>Pick Reports</strong>
            <p>Report pulls have already been created.</p>
          </div>
        </article>
        <article class="analysis-step is-complete">
          <span class="analysis-step-number">2</span>
          <div>
            <strong>Set Up Comparison</strong>
            <p>Comparison groups are already chosen.</p>
          </div>
        </article>
        <article class="analysis-step is-active">
          <span class="analysis-step-number">3</span>
          <div>
            <strong>Review Analysis</strong>
            <p>Review, summarize, approve, and complete the analysis.</p>
          </div>
        </article>
      </div>
    </section>
    <div class="panel-heading">
      <h3>Step 3: Review Analysis</h3>
      <p>${detachedWindow
        ? "This detached review window can be moved anywhere, including a different monitor."
        : "This is the final review page. Choose a comparison, pick the primary report, work through the SCFs, summarize the results, then approve before completing."}</p>
    </div>
    <div class="action-row analysis-toolbar-actions analysis-review-action-bar">
      <div class="analysis-review-action-copy">
        <strong>Final step</strong>
        <p>${readOnly ? "This completed analysis is locked for review only unless you undo it." : "Approval is required before Complete Analysis becomes available."}</p>
      </div>
      <button id="open-comparison-review-popup-button" class="secondary-button"${detachedWindow ? " disabled" : ""}>${detachedWindow ? "Opened In New Window" : "Open In New Window"}</button>
      <button id="back-to-comparison-setup-button" class="secondary-button">Back to Set Up Comparison</button>
      <button id="reset-analysis-review-button" class="secondary-button"${readOnly ? " disabled" : ""}>Reset Analysis</button>
      <button id="summarize-comparison-review-button" class="secondary-button"${readOnly ? " disabled" : ""}>Summarize Review</button>
      <button id="complete-comparison-review-button" class="primary-button" disabled>Complete Analysis</button>
      <button id="exit-comparison-review-button" class="secondary-button${detachedWindow ? "" : " is-hidden"}">${detachedWindow ? "Close Window" : "Exit"}</button>
    </div>
    <p id="analysis-comparison-selection-status" class="inline-status">Comparison review needs a valid page setup.</p>
    <div id="analysis-comparison-results" class="comparison-results-block">
      <div class="empty-state-block">Choose a comparison to start reviewing SCFs.</div>
    </div>
  `;
}

function getWorkingListEntries(listType) {
  const list = getWorkingReferenceList(listType);
  if (!list) {
    return [];
  }

  return normalizeSummaryRows(list.items || []);
}

function buildSummaryRowSet(sourceRows) {
  const map = new Map();
  ensureArray(sourceRows || []).forEach((entry) => {
    const scf = normalizeScf(entry?.scf || entry);
    if (!scf) {
      return;
    }
    map.set(scf, {
      scf,
      state: String(entry?.state || entry?.scope || "").trim(),
    });
  });
  return map;
}

function buildListDeltasForCompletion(listType) {
  ensureComparisonReviewWorkingLists();
  const listTypeNormalized = String(listType || "").trim().toLowerCase();
  const baselineEntry = (state.analysis.reviewBaselineLists || [])
    .find((entry) => String(entry?.type || "").trim().toLowerCase() === listTypeNormalized);
  const workingEntry = (state.analysis.reviewWorkingLists || [])
    .find((entry) => String(entry?.type || "").trim().toLowerCase() === listTypeNormalized)
    || baselineEntry;
  const baselineRows = buildSummaryRowSet(baselineEntry?.items || []);
  const workingRows = buildSummaryRowSet(workingEntry?.items || []);
  const added = [];
  const removed = [];

  workingRows.forEach((entry, scf) => {
    if (!baselineRows.has(scf)) {
      added.push(entry);
    }
  });

  baselineRows.forEach((entry, scf) => {
    if (!workingRows.has(scf)) {
      removed.push(entry);
    }
  });

  return {
    type: listTypeNormalized,
    added,
    removed,
  };
}

function setComparisonReviewSummary(summary) {
  state.analysis.reviewSummary = summary || null;
  state.analysis.reviewSummaryMode = "summary";
  state.analysis.reviewSummaryApproved = false;
  if (!summary) {
    state.analysis.reviewSummaryMode = "review";
    state.analysis.reviewSummaryApproved = false;
  }
}

function summarizeComparisonReview() {
  try {
    syncComparisonRequestsFromLinks();
    const context = ensureComparisonReviewSelection();
    if (!context?.comparison) {
      setStatus("analysis-comparison-selection-status", "Choose a comparison before summarizing.");
      return;
    }

    const summary = buildComparisonReviewSummaryFromClient();
    setComparisonReviewSummary(summary);
    renderAnalysisComparisonReviewPanel();
    if (el("analysis-review-summary-approved")) {
      el("analysis-review-summary-approved").checked = false;
    }
    state.analysis.reviewSummaryApproved = false;
    broadcastAnalysisReviewState("summarize-comparison-review");
    setStatus(
      "analysis-comparison-selection-status",
      "Review summary generated. Approve to enable Complete."
    );
  } catch (error) {
    setStatus(
      "analysis-comparison-selection-status",
      `Unable to generate summary: ${error.message || "Unknown error"}`
    );
  }
}

async function completeComparisonReview() {
  if (isCurrentAnalysisReadOnly()) {
    setStatus("analysis-comparison-selection-status", "This completed analysis is read-only. Undo the completion to make changes.");
    return;
  }
  clearComparisonSetupAutosave();
  if (comparisonSetupAutosaveInFlight) {
    try {
      await comparisonSetupAutosaveInFlight;
    } catch {
      // Ignore any prior draft autosave failure and continue with completion.
    }
  }
  ensureReviewCompletionFields();
  syncComparisonRequestsFromLinks();
  const completeButton = el("complete-comparison-review-button");
  const summaryMode = state.analysis.reviewSummaryMode || "review";
  let summary = state.analysis.reviewSummary || {};
  const summaryNeedsRefresh = summaryMode !== "summary" || !summary.generatedAt;

  if (summaryNeedsRefresh) {
    try {
      summary = buildComparisonReviewSummaryFromClient();
      setComparisonReviewSummary(summary);
      renderAnalysisComparisonReviewPanel();
      const summaryCheckbox = el("analysis-review-summary-approved");
      if (summaryCheckbox) {
        summaryCheckbox.checked = false;
        state.analysis.reviewSummaryApproved = false;
      }
      broadcastAnalysisReviewState("complete-summary-refresh");
      setStatus(
        "analysis-comparison-selection-status",
        "Review summary has been regenerated. Approve to enable Complete."
      );
    } catch (error) {
      setStatus(
        "analysis-comparison-selection-status",
        `Run summary before completing: ${error.message || "Unable to build summary."}`
      );
      return;
    }
  }

  if (state.analysis.reviewSummaryMode !== "summary") {
    setStatus("analysis-comparison-selection-status", "Open the Summary view before completing.");
    return;
  }

  const approvedNow = state.analysis.reviewSummaryMode === "summary" && Boolean(state.analysis.reviewSummaryApproved);
  const actualSummary = state.analysis.reviewSummary || summary;
  const hasViolations = Boolean(actualSummary.violations?.length);
  const canComplete = !!actualSummary.generatedAt && !hasViolations;
  if (!canComplete) {
    setStatus(
      "analysis-comparison-selection-status",
      "Run a summary and clear all Do Not Mail violations before completing."
    );
    if (completeButton) completeButton.disabled = true;
    return;
  }
  if (!approvedNow) {
    setStatus("analysis-comparison-selection-status", "Approve the summary before continuing.");
    return;
  }
  const reviewerName = String(state.analysis.reviewCompletedByName || "").trim();
  const reviewerDate = normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate();
  if (!reviewerName) {
    setStatus("analysis-comparison-selection-status", "Enter the reviewer name before completing.");
    const reviewerInput = el("analysis-review-completed-by-name");
    if (reviewerInput instanceof HTMLInputElement) {
      reviewerInput.focus();
    }
    return;
  }
  if (completeButton) {
    completeButton.disabled = true;
  }

  try {
    ensureComparisonReviewWorkingLists();
    const changes = ["nhcl", "rfc"].map((type) => buildListDeltasForCompletion(type));
    const totalAdds = changes.reduce((count, change) => count + change.added.length, 0);
    const totalRemoves = changes.reduce((count, change) => count + change.removed.length, 0);
    setComparisonReviewSummary(actualSummary);
    state.analysis.reviewSummaryMode = "summary";
    state.analysis.reviewSummaryApproved = true;

    const completionTimestamp = new Date().toISOString();
    const savedSetupResponse = await apiRequest("/api/analysis/setups", {
      method: "POST",
      body: {
        ...buildAnalysisPayload("complete"),
        id: state.analysis.currentSetupId || undefined,
        commitComparisonSetup: true,
        completedAt: completionTimestamp,
        referenceListChanges: changes,
        referenceListActor: reviewerName,
        referenceListSourceName: state.analysis.runName || getDefaultAnalysisName(),
        referenceListReason:
          state.analysis.reviewSummaryNotes ||
          `Complete comparison review for run ${state.analysis.currentRunId || "local-session"}`,
        results: {
          comparisonReview: {
            summary: actualSummary,
            notes: state.analysis.reviewSummaryNotes || "",
            completedAt: completionTimestamp,
            completedByName: reviewerName,
            completedOnDate: reviewerDate,
            totals: {
              added: totalAdds,
              removed: totalRemoves,
            },
          },
        },
        referenceListsSnapshot: cloneData(state.analysis.reviewBaselineLists || state.referenceLists || []),
      },
    });
    const savedSetup = savedSetupResponse.setup || {};
    state.referenceLists = Array.isArray(savedSetupResponse.lists) ? savedSetupResponse.lists : state.referenceLists;
    state.analysis.currentSetupId = savedSetup.id || state.analysis.currentSetupId;
    persistAnalysisSetupId(state.analysis.currentSetupId);
    state.analysis.reviewSummary = state.analysis.reviewSummary
      ? {
          ...state.analysis.reviewSummary,
          completedAt: completionTimestamp,
          completedByName: reviewerName,
          completedOnDate: reviewerDate,
          canUndoLatestCompletion: true,
        }
      : state.analysis.reviewSummary;
    await loadReferenceLists();
    state.analysis.reviewBaselineLists = cloneData(state.referenceLists || []);
    state.analysis.reviewWorkingLists = cloneData(state.referenceLists || []);
    state.analysis.reviewExcludedScfs = {};
    state.analysis.reviewZeroRateRemovals = [];
    syncAnalysisMeta({
      runName: savedSetup.run_name || savedSetup.runName || state.analysis.runName || getDefaultAnalysisName(),
      notes: savedSetup.notes || state.analysis.runNotes || "",
      createdAt: savedSetup.created_at || savedSetup.createdAt || null,
      updatedAt: savedSetup.updated_at || savedSetup.updatedAt || completionTimestamp,
    });
    setStatus("analysis-status-text", savedSetup.status || "complete");
    setStatus("analysis-status-detail", "Comparison review completed and saved.");
    renderAnalysisComparisonReviewPanel();
    setStatus(
      "analysis-comparison-selection-status",
      `Comparison complete. Added ${totalAdds} and removed ${totalRemoves} SCFs across NHCL/RFC lists.`
    );
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("comparison-complete");
    state.analysis.reviewSummaryMode = "summary";
    showAnalysisPanel("previous");
    await loadAnalysisSetups();
    setStatus("analysis-setup-status", `${savedSetup.run_name || savedSetup.runName || state.analysis.runName || "Analysis"} completed and closed.`);
  } catch (error) {
    setStatus("analysis-comparison-selection-status", `Unable to complete comparison: ${error.message}`);
  } finally {
    if (completeButton) {
      const canNowComplete = !!state.analysis.reviewSummary && !state.analysis.reviewSummary?.violations?.length;
      const approvedNow = Boolean(state.analysis.reviewSummaryApproved);
      completeButton.disabled = !approvedNow || !canNowComplete;
    }
  }
}

async function undoLatestCompletedComparisonReview() {
  const setupId = String(state.analysis.currentSetupId || "").trim();
  if (!setupId) {
    setStatus("analysis-comparison-selection-status", "Open the completed analysis you want to undo first.");
    return;
  }
  if (!confirm("Undo the most recent completed analysis and restore the mailing lists to their previous state?")) {
    return;
  }

  setStatus("analysis-comparison-selection-status", "Undoing the most recent completed analysis...");
  try {
    const actor = String(state.analysis.reviewCompletedByName || "").trim() || "Local User";
    const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(setupId)}/undo-complete`, {
      method: "POST",
      body: { actor },
    });
    const setup = response.setup || {};
    state.referenceLists = Array.isArray(response.lists) ? response.lists : state.referenceLists;
    loadSetupIntoWorkspace(setup);
    state.analysis.reviewSummaryApproved = false;
    await loadReferenceLists();
    renderAnalysisComparisonReviewPanel();
    setStatus("analysis-comparison-selection-status", "The most recent completed analysis was undone and the mailing lists were restored.");
  } catch (error) {
    setStatus("analysis-comparison-selection-status", `Unable to undo the most recent completion: ${error.message}`);
  }
}

async function exportMailerCurrentMailingList() {
  const type = state.analysis.mailingListType;
  if (!["nhcl", "rfc"].includes(type)) {
    setStatus("mailing-list-status", "Mailer export is available for NHCL and RFC only.");
    return;
  }
  const btn = el("mailing-list-mailer-export-button");
  if (!btn) return;
  btn.disabled = true;
  setStatus("mailing-list-status", `Exporting ${type.toUpperCase()} for mailer...`);
  try {
    const exportUrl = `${window.location.origin}/api/analysis/reference-lists/${encodeURIComponent(type)}/export?format=mailer`;
    try {
      triggerDirectDownload(exportUrl, `${type}-mailer.xlsx`);
    } catch {
      await apiDownload(exportUrl, `${type}-mailer.xlsx`);
    }
    setStatus("mailing-list-status", `${type.toUpperCase()} mailer export ready.`);
  } catch (error) {
    setStatus("mailing-list-status", `Mailer export failed: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

function shouldLockSummary() {
  return !state.analysis.currentRunId;
}

function normalizeReviewPageSize(value) {
  if (String(value || "").trim().toLowerCase() === "all") {
    return "all";
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 100;
  }
  return Math.max(1, Math.floor(numericValue));
}

function getComparisonReviewPagination(totalRows, selectedIndex = -1) {
  const total = Math.max(0, Number(totalRows) || 0);
  const pageSize = normalizeReviewPageSize(state.analysis.reviewPageSize);

  if (pageSize === "all") {
    state.analysis.reviewPageNumber = 1;
    return {
      pageSize,
      totalPages: total > 0 ? 1 : 1,
      currentPage: 1,
      startIndex: 0,
      endIndex: total,
    };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(
    totalPages,
    Math.max(1, Number(state.analysis.reviewPageNumber) || 1)
  );
  state.analysis.reviewPageNumber = currentPage;
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  return {
    pageSize,
    totalPages,
    currentPage,
    startIndex,
    endIndex,
  };
}

function focusSelectedReviewRow(scf) {
  const normalizedScf = normalizeScf(scf);
  if (!normalizedScf) {
    return;
  }

  window.requestAnimationFrame(() => {
    const selectedRow = document.querySelector(`[data-review-row-scf="${normalizedScf}"]`);
    if (!(selectedRow instanceof HTMLElement)) {
      return;
    }
    const spreadsheetArea = selectedRow.closest(".analysis-review-spreadsheet-area");
    if (spreadsheetArea instanceof HTMLElement) {
      const rowRect = selectedRow.getBoundingClientRect();
      const areaRect = spreadsheetArea.getBoundingClientRect();
      const rowHeight = rowRect.height;
      const topPadding = 8;
      const bottomPadding = 8;

      if (rowRect.top < areaRect.top + topPadding) {
        spreadsheetArea.scrollTop -= (areaRect.top + topPadding - rowRect.top);
      } else if (rowRect.bottom > areaRect.bottom - bottomPadding) {
        spreadsheetArea.scrollTop += (rowRect.bottom - (areaRect.bottom - bottomPadding));
      } else if (rowHeight > areaRect.height) {
        spreadsheetArea.scrollTop = Math.max(
          0,
          spreadsheetArea.scrollTop + (rowRect.top - areaRect.top) - topPadding
        );
      }
    }
    selectedRow.focus({ preventScroll: true });
  });
}

function getReviewFloatingPanelStyle() {
  const panelState = state.analysis.reviewFloatingPanel || {};
  const x = Number.isFinite(Number(panelState.x)) ? Number(panelState.x) : 16;
  const y = Number.isFinite(Number(panelState.y)) ? Number(panelState.y) : 16;
  return `left:${Math.max(0, x)}px; top:${Math.max(0, y)}px;`;
}

function bindComparisonReviewFloatingPanel() {
  if (isAnalysisReviewPopupWindow()) {
    return;
  }
  const panel = el("analysis-review-floating-panel");
  if (!(panel instanceof HTMLElement) || panel.classList.contains("is-inline-page")) {
    return;
  }
  const handle = el("analysis-review-floating-handle");
  const page = panel?.closest(".analysis-comparison-review-page");
  if (!(panel instanceof HTMLElement) || !(handle instanceof HTMLElement) || !(page instanceof HTMLElement)) {
    return;
  }

  handle.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    if (event.target.closest("button, input, select, textarea, a")) {
      return;
    }

    event.preventDefault();
    const pageRect = page.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = panelRect.left - pageRect.left;
    const originY = panelRect.top - pageRect.top;

    const onMouseMove = (moveEvent) => {
      const nextX = originX + (moveEvent.clientX - startX);
      const nextY = originY + (moveEvent.clientY - startY);
      const maxX = Math.max(0, page.clientWidth - panel.offsetWidth);
      const maxY = Math.max(0, page.clientHeight - 80);
      state.analysis.reviewFloatingPanel = {
        x: Math.min(maxX, Math.max(0, nextX)),
        y: Math.min(maxY, Math.max(0, nextY)),
      };
      panel.style.left = `${state.analysis.reviewFloatingPanel.x}px`;
      panel.style.top = `${state.analysis.reviewFloatingPanel.y}px`;
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });

  el("analysis-review-floating-reset")?.addEventListener("click", () => {
    state.analysis.reviewFloatingPanel = { x: 16, y: 16 };
    panel.style.left = "16px";
    panel.style.top = "16px";
  });
}

function syncReviewPageToSelectedScf(comparisonId, scf) {
  const comparison = getComparisonReviewComparisonById(comparisonId);
  if (!comparison) {
    return;
  }

  const reports = getComparisonReviewReports(comparison);
  if (!reports.length) {
    return;
  }

  const primaryReportId = state.analysis.reviewPrimaryReportIds[comparison.id];
  const primaryReport = reports.find((report) => report.id === primaryReportId) || reports[0];
  if (!primaryReport) {
    return;
  }

  const selectedScf = normalizeScf(scf);
  if (!selectedScf) {
    return;
  }

  const pageSize = normalizeReviewPageSize(state.analysis.reviewPageSize);
  if (pageSize === "all") {
    state.analysis.reviewPageNumber = 1;
    return;
  }

  const sortedFilteredRows = getSortedFilteredPrimaryRows(buildPrimaryNavigatorRows(primaryReport), comparisonId);
  const selectedIndex = sortedFilteredRows.findIndex((entry) => entry.scf === selectedScf);
  if (selectedIndex < 0) {
    return;
  }

  state.analysis.reviewPageNumber = Math.floor(selectedIndex / pageSize) + 1;
}

function selectComparisonReviewScf(comparisonId, scf, options = {}) {
  const normalizedScf = normalizeScf(scf);
  if (!comparisonId || !normalizedScf) {
    return;
  }

  const shouldScrollSummary = options.scrollSummary === true;
  const preservePage = options.preservePage === true;
  state.analysis.reviewSelectedScfs[comparisonId] = normalizedScf;
  if (!preservePage) {
    syncReviewPageToSelectedScf(comparisonId, normalizedScf);
  }
  renderAnalysisComparisonReviewPanel();
  broadcastAnalysisReviewState("comparison-scf-selected");
  if (shouldScrollSummary) {
    focusComparisonReviewSummary();
  }
  focusSelectedReviewRow(normalizedScf);
}

function createComparisonLink(index = 0, source = {}) {
  const now = new Date().toISOString();
  const rawReportIds = Array.isArray(source.selectedReportIds) && source.selectedReportIds.length
    ? source.selectedReportIds
    : Array.isArray(source.reportIds) && source.reportIds.length
      ? source.reportIds
    : [source.reportAId, source.reportBId];
  const reportIds = Array.from(
    new Set(
      rawReportIds
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 5);
  const comparisonName = resolveComparisonName(
    source.name || source.comparisonName || source.label || "",
    index
  );

  return {
    id: String(source.id || createClientId("comparison")).trim(),
    comparisonName,
    name: comparisonName,
    keyCodeGroup: normalizeKeyCodeGroup(source.keyCodeGroup || source.key_code_group || source.clientType),
    reportIds,
    selectedReportIds: reportIds,
    reportAId: reportIds[0] || "",
    reportBId: reportIds[1] || "",
    matchField: String(source.matchField || "SCF Grouping").trim() || "SCF Grouping",
    metricColumns: Array.isArray(source.metricColumns) && source.metricColumns.length
      ? source.metricColumns
      : ["Sum of Mailed", "Sum of Opp Count", "Sum of In Force", "Sum of Converted", "Sold Rate"],
    createdAt: source.createdAt || source.created_at || now,
    updatedAt: source.updatedAt || source.updated_at || now,
  };
}

function normalizeComparisonMetricKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getReportRowsWithScf(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  return rows
    .map((row, index) => {
      const scf = Object.entries(row || {}).reduce((found, [key, rawValue]) => {
        if (found) return found;
        if (String(key).endsWith("__label")) return "";
        if (!normalizeComparisonMetricKey(key).includes("scf")) return "";
        return normalizeScf(rawValue);
      }, "");
      return scf ? { scf, row, index } : null;
    })
    .filter(Boolean);
}

function filterScfEntriesByReportKeyCodeGroup(report, entries = []) {
  const expectedGroup = getAnalysisReportKeyCodeGroup(report);
  if (!expectedGroup) {
    return entries;
  }

  const expectedKeyValue = expectedGroup === "RFC" ? "RFC" : "N";
  const matchingEntries = entries.filter((entry) => {
    const rowKey = String(entry?.row?.["Key"] ?? entry?.row?.key ?? "").trim().toUpperCase();
    return rowKey === expectedKeyValue;
  });

  return matchingEntries.length ? matchingEntries : entries;
}

function getReportEntriesForKeyCodeGroup(report, entries = []) {
  return filterScfEntriesByReportKeyCodeGroup(report, ensureArray(entries));
}

function getReportExportRowsWithScf(report) {
  const rows = Array.isArray(report?.exportRows) ? report.exportRows : [];
  return rows
    .map((row, index) => {
      const scf = Object.entries(row || {}).reduce((found, [key, rawValue]) => {
        if (found) return found;
        if (String(key).endsWith("__label")) return "";
        if (!normalizeComparisonMetricKey(key).includes("scf")) return "";
        return normalizeScf(rawValue);
      }, "");
      return scf ? { scf, row, index } : null;
    })
    .filter(Boolean);
}

function formatNavigatorCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatNavigatorRate(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatWholeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numeric = Number(String(value).replace(/[$,%()\s,]/g, ""));
  if (!Number.isFinite(numeric)) {
    return "-";
  }

  return Math.round(numeric).toLocaleString("en-US");
}

function formatCurrencyMetricValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numeric = Number(String(value).replace(/[$,%()\s,]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "-";
  }

  return numeric.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatRateDecimalValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numeric = Number(String(value).replace(/[$,%()\s,]/g, ""));
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return numeric.toFixed(10);
}

function getAnalysisReportScfMetricCacheKey(reportId, scf) {
  return `${String(reportId || "").trim()}::${normalizeScf(scf)}`;
}

function getCachedAnalysisReportScfMetrics(reportId, scf) {
  const key = getAnalysisReportScfMetricCacheKey(reportId, scf);
  return state.analysis.reportScfMetricCache[key] || null;
}

let analysisComparisonReviewRenderHandle = null;

function isAnalysisReviewControlActive() {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  const reviewPanel = el("analysis-comparison-review-panel");
  if (!(reviewPanel instanceof HTMLElement) || !reviewPanel.contains(activeElement)) {
    return false;
  }

  if (activeElement.matches("select, input, textarea")) {
    return true;
  }
  return false;
}

function scheduleAnalysisComparisonReviewRender(delayMs = 0) {
  if (analysisComparisonReviewRenderHandle) {
    window.clearTimeout(analysisComparisonReviewRenderHandle);
  }
  analysisComparisonReviewRenderHandle = window.setTimeout(() => {
    if (isAnalysisReviewControlActive()) {
      scheduleAnalysisComparisonReviewRender(250);
      return;
    }
    analysisComparisonReviewRenderHandle = null;
    renderAnalysisComparisonReviewPanel();
  }, Math.max(0, Number(delayMs) || 0));
}

async function requestAnalysisReportScfMetrics(reportId, scf) {
  const normalizedReportId = String(reportId || "").trim();
  const normalizedScf = normalizeScf(scf);
  if (!normalizedReportId || !normalizedScf) {
    return null;
  }

  const cacheKey = getAnalysisReportScfMetricCacheKey(normalizedReportId, normalizedScf);
  const cached = state.analysis.reportScfMetricCache[cacheKey];
  if (cached?.status === "ready") {
    return cached.row || null;
  }
  if (cached?.status === "loading" && cached.promise) {
    return cached.promise;
  }

  const requestPromise = apiRequest(
    `/api/analysis/reports/${encodeURIComponent(normalizedReportId)}/scf-metrics?scf=${encodeURIComponent(normalizedScf)}`
  )
    .then((payload) => {
      const nextRow = payload?.metrics?.row || null;
      state.analysis.reportScfMetricCache[cacheKey] = {
        status: "ready",
        row: nextRow,
        source: payload?.metrics?.source || "",
        updatedAt: Date.now(),
      };
      scheduleAnalysisComparisonReviewRender(40);
      return nextRow;
    })
    .catch((error) => {
      state.analysis.reportScfMetricCache[cacheKey] = {
        status: "error",
        row: null,
        error: error instanceof Error ? error.message : String(error || "Unable to load SCF metrics."),
        updatedAt: Date.now(),
      };
      scheduleAnalysisComparisonReviewRender(40);
      return null;
    });

  state.analysis.reportScfMetricCache[cacheKey] = {
    status: "loading",
    row: cached?.row || null,
    promise: requestPromise,
    updatedAt: Date.now(),
  };

  return requestPromise;
}

function reportHasPremiumExportColumns(report) {
  const columns = Array.isArray(report?.exportColumns) ? report.exportColumns : [];
  const labels = new Set(
    columns.map((column) => normalizeComparisonMetricKey(column?.label || column?.normalized || column?.key || ""))
  );
  return (
    labels.has("total monthly premium") &&
    labels.has("in force monthly premium") &&
    labels.has("total converted monthly premiums")
  );
}

function isNavigatorAggregateExportRow(row = {}) {
  if (!row || typeof row !== "object") {
    return false;
  }

  return Object.keys(row).some((key) => {
    const normalized = normalizeComparisonMetricKey(key);
    return (
      normalized === "sum of mailed" ||
      normalized === "sum of opp count" ||
      normalized === "sum of in force" ||
      normalized === "sum of sold" ||
      normalized === "sold rate" ||
      normalized === "in force rate" ||
      normalized === "converted rate"
    );
  });
}

function reportHasDetailExportRows(report) {
  return getReportExportRowsWithScf(report).some((entry) => !isNavigatorAggregateExportRow(entry?.row));
}

function reportNeedsExactScfMetricFetch(report, rowEntry) {
  if (!rowEntry?.scf) {
    return false;
  }
  return true;
}

function parseAnalysisMetricNumber(value) {
  const numeric = Number(String(value ?? "").replace(/[$,%(),\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function resolveNavigatorSoldCount(row = {}, options = {}) {
  const convertedCountFallback = Number(options?.convertedCountFallback || 0);
  const oppCount = getRowMetricNumber(row, "Opp Count");
  if (oppCount > 0) {
    return Math.max(oppCount, convertedCountFallback);
  }
  const explicitSold = getRowMetricNumber(row, "Sold");
  const fallbackSold = explicitSold > 0 ? explicitSold : 0;
  return Math.max(fallbackSold, convertedCountFallback);
}

function resolveNavigatorConvertedCount(row = {}, precomputedConvertedPremium = null, options = {}) {
  const allowPremiumRowInference = options?.allowPremiumRowInference !== false;
  const convertedPremium = precomputedConvertedPremium === null
    ? Math.max(
        getRowMetricNumber(row, "Payments Minus Credits"),
        getRowMetricNumber(row, "Total Converted Monthly Premiums")
      )
    : Number(precomputedConvertedPremium || 0);
  const explicitConvertedCount = Number.isFinite(Number(row?.appConvertedCount))
    ? Number(row.appConvertedCount)
    : Math.max(
        getRowMetricNumber(row, "Sum of Converted"),
        getRowMetricNumber(row, "Converted")
      );
  if (allowPremiumRowInference && convertedPremium > 0) {
    return explicitConvertedCount > 0 ? explicitConvertedCount : 1;
  }
  if (explicitConvertedCount > 0) {
    return explicitConvertedCount;
  }
  return 0;
}

function resolveNavigatorExplicitRate(row = {}, metricLabel) {
  if (!row || typeof row !== "object") {
    return null;
  }
  if (metricLabel === "Sold Rate" && Number.isFinite(Number(row.salesforceSoldRate))) {
    return Number(row.salesforceSoldRate);
  }
  if (metricLabel === "In Force Rate" && Number.isFinite(Number(row.salesforceInForceRate))) {
    return Number(row.salesforceInForceRate);
  }
  if (metricLabel === "Converted Rate" && Number.isFinite(Number(row.appConvertedRate))) {
    return Number(row.appConvertedRate);
  }
  const rawValue = getRowMetricValue(row, metricLabel);
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return null;
  }
  const numericValue = parseAnalysisMetricNumber(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function calculateNavigatorRates({
  mailed = 0,
  soldCount = 0,
  inForceCount = 0,
  convertedCount = 0,
} = {}) {
  const safeMailed = Number(mailed || 0);
  if (!(safeMailed > 0)) {
    return {
      soldRate: 0,
      inForceRate: 0,
      convertedRate: 0,
    };
  }

  return {
    soldRate: (Number(soldCount || 0) / safeMailed) * 100,
    inForceRate: (Number(inForceCount || 0) / safeMailed) * 100,
    convertedRate: (Number(convertedCount || 0) / safeMailed) * 100,
  };
}

function calculateNavigatorConvertedRate({
  convertedCount = 0,
  soldCount = 0,
  inForceCount = 0,
  soldRate = null,
  inForceRate = null,
  convertedRate = null,
  totalConvertedMonthlyPremiums = 0,
  mailed = 0,
} = {}) {
  const explicitConvertedRate = Number(convertedRate);
  if (Number.isFinite(explicitConvertedRate) && explicitConvertedRate > 0) {
    return explicitConvertedRate;
  }

  const safeConvertedCount = Number(convertedCount || 0);
  if (!(safeConvertedCount > 0)) {
    return 0;
  }

  const numericSoldCount = Number(soldCount || 0);
  const numericSoldRate = Number(soldRate);
  if (numericSoldCount > 0 && Number.isFinite(numericSoldRate) && numericSoldRate > 0) {
    return (safeConvertedCount / numericSoldCount) * numericSoldRate;
  }

  const numericInForceCount = Number(inForceCount || 0);
  const numericInForceRate = Number(inForceRate);
  if (numericInForceCount > 0 && Number.isFinite(numericInForceRate) && numericInForceRate > 0) {
    return (safeConvertedCount / numericInForceCount) * numericInForceRate;
  }

  return calculateNavigatorRates({
    mailed,
    convertedCount: safeConvertedCount,
  }).convertedRate;
}

function formatAnalysisCurrency(value) {
  return Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function isSparseAnalysisMetricRow(row = {}) {
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

function normalizeAnalysisMetricRow(row = {}) {
  if (!row || typeof row !== "object") {
    return row;
  }

  const mailed = getRowMetricNumber(row, "Sum of Mailed");
  const inForceCount = getRowMetricNumber(row, "In Force");
  const totalMonthlyPremium = getRowMetricNumber(row, "Total Monthly Premium");
  const inForceMonthlyPremium = getRowMetricNumber(row, "In Force Monthly Premium");
  const totalConvertedMonthlyPremiums = getRowMetricNumber(row, "Total Converted Monthly Premiums");
  const convertedCount = resolveNavigatorConvertedCount(row, totalConvertedMonthlyPremiums, {
    allowPremiumRowInference: false,
  });
  const soldCount = resolveNavigatorSoldCount(row, {
    convertedCountFallback: convertedCount,
  });
  const fallbackRates = calculateNavigatorRates({
    mailed,
    soldCount,
    inForceCount,
    convertedCount,
  });
  const soldRate = resolveNavigatorExplicitRate(row, "Sold Rate");
  const inForceRate = resolveNavigatorExplicitRate(row, "In Force Rate");
  const convertedRate = Number.isFinite(Number(row.appConvertedRate))
      ? Number(row.appConvertedRate)
      : calculateNavigatorConvertedRate({
        convertedCount,
        soldCount,
        inForceCount,
        soldRate,
        inForceRate,
        convertedRate: resolveNavigatorExplicitRate(row, "Converted Rate"),
        totalConvertedMonthlyPremiums,
        mailed,
      });
  const safeSoldRate = Number.isFinite(Number(soldRate)) ? Number(soldRate) : fallbackRates.soldRate;
  const safeInForceRate = Number.isFinite(Number(inForceRate)) ? Number(inForceRate) : fallbackRates.inForceRate;

  const normalizedRow = { ...row };
  normalizedRow["Sum of Total Monthly Premium"] = formatAnalysisCurrency(totalMonthlyPremium);
  normalizedRow["sum of total monthly premium"] = formatAnalysisCurrency(totalMonthlyPremium);
  normalizedRow["Sum of In Force Monthly Premium"] = formatAnalysisCurrency(inForceMonthlyPremium);
  normalizedRow["sum of in force monthly premium"] = formatAnalysisCurrency(inForceMonthlyPremium);
  normalizedRow["Sum of Total Converted Monthly Premiums"] = formatAnalysisCurrency(totalConvertedMonthlyPremiums);
  normalizedRow["sum of total converted monthly premiums"] = formatAnalysisCurrency(totalConvertedMonthlyPremiums);
  normalizedRow["Sum of Opp Count"] = formatNavigatorCount(soldCount);
  normalizedRow["sum of opp count"] = formatNavigatorCount(soldCount);
  normalizedRow["Sum of Sold"] = formatNavigatorCount(soldCount);
  normalizedRow["sum of sold"] = formatNavigatorCount(soldCount);
  normalizedRow["Sum of Converted"] = formatNavigatorCount(convertedCount);
  normalizedRow["sum of converted"] = formatNavigatorCount(convertedCount);
  normalizedRow["Converted"] = formatNavigatorCount(convertedCount);
  normalizedRow["converted"] = formatNavigatorCount(convertedCount);
  normalizedRow["Sold Rate"] = safeSoldRate.toFixed(10);
  normalizedRow["sold rate"] = safeSoldRate.toFixed(10);
  normalizedRow["In Force Rate"] = safeInForceRate.toFixed(10);
  normalizedRow["in force rate"] = safeInForceRate.toFixed(10);
  normalizedRow["Converted Rate"] = convertedRate.toFixed(10);
  normalizedRow["converted rate"] = convertedRate.toFixed(10);
  normalizedRow.salesforceSoldRate = Number.isFinite(Number(row.salesforceSoldRate))
    ? Number(row.salesforceSoldRate)
    : Number.isFinite(Number(soldRate))
      ? Number(soldRate)
      : null;
  normalizedRow.salesforceInForceRate = Number.isFinite(Number(row.salesforceInForceRate))
    ? Number(row.salesforceInForceRate)
    : Number.isFinite(Number(inForceRate))
      ? Number(inForceRate)
      : null;
  normalizedRow.appConvertedRate = convertedRate;
  normalizedRow.appConvertedCount = convertedCount;

  return normalizedRow;
}

function mergePreferredNavigatorRow(baseRow = {}, candidateRow = {}) {
  const mergedRow = {
    ...(baseRow && typeof baseRow === "object" ? baseRow : {}),
    ...(candidateRow && typeof candidateRow === "object" ? candidateRow : {}),
  };

  const metricLabels = [
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
  ];

  metricLabels.forEach((label) => {
    const baseValue = getRowMetricNumber(baseRow, label);
    const candidateValue = getRowMetricNumber(candidateRow, label);
    const candidateRaw = getRowMetricValue(candidateRow, label);
    if (
      (candidateRaw === "" || candidateRaw === null || candidateRaw === undefined || candidateValue === 0) &&
      baseValue > 0
    ) {
      const baseRaw = getRowMetricValue(baseRow, label);
      mergedRow[label] = baseRaw;
      mergedRow[normalizeComparisonMetricKey(label)] = baseRaw;
    }
  });

  const baseScf = getRowMetricValue(baseRow, "SCF Grouping");
  if (baseScf) {
    mergedRow["SCF Grouping"] = baseScf;
    mergedRow["scf grouping"] = baseScf;
  }
  const baseKey = getRowMetricValue(baseRow, "Key");
  if (baseKey) {
    mergedRow["Key"] = baseKey;
    mergedRow["key"] = baseKey;
  }

  return normalizeAnalysisMetricRow(mergedRow);
}

function buildSyntheticNavigatorRow({
  scf,
  mailed = 0,
  oppCount = 0,
  inForce = 0,
  sold = 0,
  salesforceSoldRate = null,
  salesforceInForceRate = null,
  salesforceConvertedRate = null,
  appConvertedRate = null,
  totalMonthlyPremium = 0,
  inForceMonthlyPremium = 0,
  totalConvertedMonthlyPremiums = 0,
  soldRate = null,
  inForceRate = null,
  convertedRate = null,
}) {
  const safeMailed = Number(mailed || 0);
  const safeOppCount = Number(oppCount || 0);
  const safeInForce = Number(inForce || 0);
  const safeSold = Number(sold || 0);
  const safeTotalMonthlyPremium = Number(totalMonthlyPremium || 0);
  const safeInForceMonthlyPremium = Number(inForceMonthlyPremium || 0);
  const safeTotalConvertedMonthlyPremiums = Number(totalConvertedMonthlyPremiums || 0);
  const rateFallbacks = calculateNavigatorRates({
    mailed: safeMailed,
    soldCount: safeOppCount,
    inForceCount: safeInForce,
    convertedCount: safeSold,
  });
  const resolvedSalesforceSoldRate = Number.isFinite(Number(salesforceSoldRate))
    ? Number(salesforceSoldRate)
    : Number.isFinite(Number(soldRate))
      ? Number(soldRate)
      : null;
  const resolvedSalesforceInForceRate = Number.isFinite(Number(salesforceInForceRate))
    ? Number(salesforceInForceRate)
    : Number.isFinite(Number(inForceRate))
      ? Number(inForceRate)
      : null;
  const safeSoldRate = Number.isFinite(Number(resolvedSalesforceSoldRate)) ? Number(resolvedSalesforceSoldRate) : rateFallbacks.soldRate;
  const safeInForceRate = Number.isFinite(Number(resolvedSalesforceInForceRate)) ? Number(resolvedSalesforceInForceRate) : rateFallbacks.inForceRate;
  const safeConvertedRate = Number.isFinite(Number(appConvertedRate))
    ? Number(appConvertedRate)
    : calculateNavigatorConvertedRate({
        convertedCount: safeSold,
        soldCount: safeOppCount,
        inForceCount: safeInForce,
        soldRate: resolvedSalesforceSoldRate,
        inForceRate: resolvedSalesforceInForceRate,
        convertedRate: salesforceConvertedRate ?? convertedRate,
        mailed: safeMailed,
      });

  return {
    "SCF Grouping": scf,
    "scf grouping": scf,
    "Sum of Mailed": formatNavigatorCount(safeMailed),
    "sum of mailed": formatNavigatorCount(safeMailed),
    "Sum of Opp Count": formatNavigatorCount(safeOppCount),
    "sum of opp count": formatNavigatorCount(safeOppCount),
    "Sum of In Force": formatNavigatorCount(safeInForce),
    "sum of in force": formatNavigatorCount(safeInForce),
    "Sum of Sold": formatNavigatorCount(safeOppCount),
    "sum of sold": formatNavigatorCount(safeOppCount),
    "Sum of Converted": formatNavigatorCount(safeSold),
    "sum of converted": formatNavigatorCount(safeSold),
    Converted: formatNavigatorCount(safeSold),
    converted: formatNavigatorCount(safeSold),
    "Sum of Total Monthly Premium": formatAnalysisCurrency(safeTotalMonthlyPremium),
    "sum of total monthly premium": formatAnalysisCurrency(safeTotalMonthlyPremium),
    "Sum of In Force Monthly Premium": formatAnalysisCurrency(safeInForceMonthlyPremium),
    "sum of in force monthly premium": formatAnalysisCurrency(safeInForceMonthlyPremium),
    "Sum of Total Converted Monthly Premiums": formatAnalysisCurrency(safeTotalConvertedMonthlyPremiums),
    "sum of total converted monthly premiums": formatAnalysisCurrency(safeTotalConvertedMonthlyPremiums),
    salesforceSoldRate: resolvedSalesforceSoldRate,
    salesforceInForceRate: resolvedSalesforceInForceRate,
    salesforceConvertedRate: Number.isFinite(Number(salesforceConvertedRate)) ? Number(salesforceConvertedRate) : null,
    appConvertedRate: safeConvertedRate,
    appConvertedCount: safeSold,
    "Sold Rate": safeSoldRate.toFixed(10),
    "sold rate": safeSoldRate.toFixed(10),
    "In Force Rate": safeInForceRate.toFixed(10),
    "in force rate": safeInForceRate.toFixed(10),
    "Converted Rate": safeConvertedRate.toFixed(10),
    "converted rate": safeConvertedRate.toFixed(10),
  };
}

function getComparisonSelectedReportIds(link) {
  return Array.from(
    new Set(
      ensureArray(link?.selectedReportIds ?? link?.reportIds)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 5);
}

function pruneComparisonSelectedReportIds(link, availableReportIds = null) {
  const currentIds = getComparisonSelectedReportIds(link);
  const allowedIds = availableReportIds instanceof Set
    ? availableReportIds
    : new Set(
        getAvailableAnalysisReports()
          .map((report) => String(report.id || "").trim())
          .filter(Boolean)
      );
  const prunedIds = currentIds.filter((reportId) => allowedIds.has(reportId));
  if (prunedIds.length !== currentIds.length) {
    setComparisonSelectedReportIds(link, prunedIds);
  }
  return prunedIds;
}

function setComparisonSelectedReportIds(link, nextIds) {
  const selectedReportIds = Array.from(
    new Set(
      ensureArray(nextIds)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 5);
  link.selectedReportIds = selectedReportIds;
  link.reportIds = selectedReportIds;
  link.reportAId = selectedReportIds[0] || "";
  link.reportBId = selectedReportIds[1] || "";
  return selectedReportIds;
}

function buildExportScfAggregateMap(report) {
  if (!reportHasDetailExportRows(report)) {
    return new Map();
  }

  const exportRows = getReportEntriesForKeyCodeGroup(report, getReportExportRowsWithScf(report));
  const aggregateMap = new Map();

  exportRows.forEach((entry) => {
    const scf = normalizeScf(entry?.scf);
    if (!scf) {
      return;
    }

    const row = entry?.row || {};
    const current = aggregateMap.get(scf) || {
      scf,
      mailed: 0,
      oppCount: 0,
      inForce: 0,
      sold: 0,
      salesforceSoldRate: null,
      salesforceInForceRate: null,
      salesforceConvertedRate: null,
      appConvertedRate: null,
      totalMonthlyPremium: 0,
      inForceMonthlyPremium: 0,
      totalConvertedMonthlyPremiums: 0,
    };

    const rowConvertedPremium = getRowMetricNumber(row, "Total Converted Monthly Premiums");
    const rowConvertedCount = resolveNavigatorConvertedCount(row, rowConvertedPremium, {
      allowPremiumRowInference: true,
    });
    const rowSalesforceSoldRate = resolveNavigatorExplicitRate(row, "Sold Rate");
    const rowSalesforceInForceRate = resolveNavigatorExplicitRate(row, "In Force Rate");
    const rowSalesforceConvertedRate = getRowMetricValue(row, "Converted Rate");
    current.mailed += getRowMetricNumber(row, "Mailed");
    current.oppCount += resolveNavigatorSoldCount(row, {
      convertedCountFallback: rowConvertedCount,
    });
    current.inForce += getRowMetricNumber(row, "In Force");
    current.sold += rowConvertedCount;
    if ((current.salesforceSoldRate === null || current.salesforceSoldRate === 0) && Number.isFinite(Number(rowSalesforceSoldRate)) && Number(rowSalesforceSoldRate) !== 0) {
      current.salesforceSoldRate = Number(rowSalesforceSoldRate);
    }
    if ((current.salesforceInForceRate === null || current.salesforceInForceRate === 0) && Number.isFinite(Number(rowSalesforceInForceRate)) && Number(rowSalesforceInForceRate) !== 0) {
      current.salesforceInForceRate = Number(rowSalesforceInForceRate);
    }
    if ((current.salesforceConvertedRate === null || current.salesforceConvertedRate === 0) && rowSalesforceConvertedRate !== "" && rowSalesforceConvertedRate !== null && rowSalesforceConvertedRate !== undefined && parseAnalysisMetricNumber(rowSalesforceConvertedRate) !== 0) {
      current.salesforceConvertedRate = parseAnalysisMetricNumber(rowSalesforceConvertedRate);
    }
    current.totalMonthlyPremium += getRowMetricNumber(row, "Total Monthly Premium");
    current.inForceMonthlyPremium += getRowMetricNumber(row, "In Force Monthly Premium");
    current.totalConvertedMonthlyPremiums += rowConvertedPremium;
    current.appConvertedRate = calculateNavigatorConvertedRate({
      convertedCount: current.sold,
      soldCount: current.oppCount,
      inForceCount: current.inForce,
      soldRate: current.salesforceSoldRate,
      inForceRate: current.salesforceInForceRate,
      convertedRate: current.salesforceConvertedRate,
      totalConvertedMonthlyPremiums: current.totalConvertedMonthlyPremiums,
      mailed: current.mailed,
    });
    aggregateMap.set(scf, current);
  });

  return aggregateMap;
}

function getUnifiedReportScfEntries(report) {
  const summaryEntries = getReportEntriesForKeyCodeGroup(report, getReportRowsWithScf(report));
  const summaryMap = new Map(summaryEntries.map((entry) => [entry.scf, entry]));
  const exportAggregateMap = buildExportScfAggregateMap(report);
  const combinedScfs = Array.from(
    new Set([
      ...summaryMap.keys(),
      ...exportAggregateMap.keys(),
    ])
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return combinedScfs.map((scf) => {
    const summaryEntry = summaryMap.get(scf);
    const aggregateEntry = exportAggregateMap.get(scf) || null;
    if (aggregateEntry) {
      const summarySoldRate = summaryEntry ? getRowMetricNumber(summaryEntry.row, "Sold Rate") : null;
      const summaryInForceRate = summaryEntry ? getRowMetricNumber(summaryEntry.row, "In Force Rate") : null;
      const summaryConvertedRate = summaryEntry ? getRowMetricNumber(summaryEntry.row, "Converted Rate") : null;
      return {
        scf,
        row: buildSyntheticNavigatorRow({
          ...aggregateEntry,
          salesforceSoldRate: Number.isFinite(Number(summarySoldRate)) ? Number(summarySoldRate) : aggregateEntry.salesforceSoldRate,
          salesforceInForceRate: Number.isFinite(Number(summaryInForceRate)) ? Number(summaryInForceRate) : aggregateEntry.salesforceInForceRate,
          salesforceConvertedRate: Number.isFinite(Number(summaryConvertedRate)) ? Number(summaryConvertedRate) : aggregateEntry.salesforceConvertedRate,
        }),
        source: "export-aggregate",
      };
    }

    if (summaryEntry && !isSparseAnalysisMetricRow(summaryEntry.row)) {
      return {
        scf,
        row: normalizeAnalysisMetricRow(summaryEntry.row),
        source: "summary",
      };
    }

    if (summaryEntry) {
      return {
        scf,
        row: normalizeAnalysisMetricRow(summaryEntry.row),
        source: "summary-sparse",
      };
    }

    return {
      scf,
      row: buildSyntheticNavigatorRow({ scf }),
      source: "synthetic-empty",
    };
  });
}

function findReportScfMatch(report, scf) {
  const normalizedScf = normalizeScf(scf);
  if (!normalizedScf) {
    return null;
  }

  const aggregateMatch = getUnifiedReportScfEntries(report).find((entry) => entry.scf === normalizedScf);
  if (aggregateMatch) {
    return {
      ...aggregateMatch,
      source: aggregateMatch.source || "export-aggregate",
    };
  }

  const summaryEntries = filterScfEntriesByReportKeyCodeGroup(
    report,
    getReportRowsWithScf(report).filter((entry) => entry.scf === normalizedScf)
  );
  const summaryMatch = summaryEntries[0] || null;
  if (summaryMatch) {
    return {
      ...summaryMatch,
      source: "summary",
    };
  }

  const exportEntries = filterScfEntriesByReportKeyCodeGroup(
    report,
    getReportExportRowsWithScf(report).filter((entry) => entry.scf === normalizedScf)
  );
  const exportMatch = exportEntries[0] || null;
  if (exportMatch) {
    return {
      ...exportMatch,
      source: "export",
    };
  }

  return null;
}

function findReportRowByScf(report, scf) {
  return findReportScfMatch(report, scf);
}

function getRowMetricValue(row, metricLabel) {
  const target = normalizeComparisonMetricKey(metricLabel);
  const entries = Object.entries(row || {});
  const exactEntry = entries.find(([key]) => normalizeComparisonMetricKey(key) === target);
  if (exactEntry) {
    return exactEntry[1];
  }
  const fuzzyEntry = entries.find(([key]) => normalizeComparisonMetricKey(key).includes(target));
  return fuzzyEntry ? fuzzyEntry[1] : "";
}

function getMetricLabelAliases(metricLabel) {
  const normalized = normalizeComparisonMetricKey(metricLabel);
  const aliasMap = {
    "opp count": ["Applications Received", "Sum of Opp Count"],
    "sum of opp count": ["Applications Received", "Opp Count"],
    "applications received": ["Sum of Opp Count", "Opp Count"],
    "sold": ["Sum of Sold"],
    "sum of sold": ["Sum of Sold", "Sold"],
    "sum of converted": ["Sum of Converted", "Converted"],
    "in force": ["Inforce (policy currently in effect)", "Sum of In Force"],
    "sum of in force": ["Inforce (policy currently in effect)", "In Force"],
    "inforce policy currently in effect": ["Sum of In Force", "In Force"],
    "total monthly premium": ["Sum of Total Sold", "Sum of Total Monthly Premium"],
    "sum of total monthly premium": ["Sum of Total Sold", "Total Monthly Premium"],
    "sum of total sold": ["Sum of Total Monthly Premium", "Total Monthly Premium"],
    "in force monthly premium": ["Sum of In Force Monthly Premium"],
    "total converted monthly premiums": ["Sum of Total Converted Monthly Premiums"],
  };

  return [metricLabel, ...(aliasMap[normalized] || [])];
}

function getRowMetricRawValueByAliases(row, metricLabels = []) {
  if (!Array.isArray(metricLabels) || !metricLabels.length) {
    return "";
  }

  const expandedMetricLabels = Array.from(
    new Set(metricLabels.flatMap((metricLabel) => getMetricLabelAliases(metricLabel)))
  );

  for (const metricLabel of expandedMetricLabels) {
    const rawValue = getRowMetricValue(row, metricLabel);
    if (rawValue === null || rawValue === undefined) {
      continue;
    }
    if (String(rawValue).trim() === "") {
      continue;
    }
    return rawValue;
  }

  const entries = Object.entries(row || {});
  const fallbackEntry = entries.find(([key, rawValue]) => {
    const normalized = normalizeComparisonMetricKey(key);
    if (normalized.endsWith("__label")) {
      return false;
    }
    if (!normalized.includes("mailed")) {
      return false;
    }
    if (normalized.includes("rate")) {
      return false;
    }
    return !(rawValue === null || rawValue === undefined || String(rawValue).trim() === "");
  });

  if (!fallbackEntry) {
    return "";
  }

  return fallbackEntry[1];
}

function getRowMetricMatchByAliases(row, metricLabels = []) {
  if (!Array.isArray(metricLabels) || !metricLabels.length) {
    return { key: "", value: "" };
  }

  const expandedMetricLabels = Array.from(
    new Set(metricLabels.flatMap((metricLabel) => getMetricLabelAliases(metricLabel)))
  );

  for (const metricLabel of expandedMetricLabels) {
    const target = normalizeComparisonMetricKey(metricLabel);
    const entries = Object.entries(row || {});
    const exactEntry = entries.find(([key, rawValue]) => (
      normalizeComparisonMetricKey(key) === target
      && !(rawValue === null || rawValue === undefined || String(rawValue).trim() === "")
    ));
    if (exactEntry) {
      return { key: exactEntry[0], value: exactEntry[1] };
    }
    const fuzzyEntry = entries.find(([key, rawValue]) => (
      normalizeComparisonMetricKey(key).includes(target)
      && !(rawValue === null || rawValue === undefined || String(rawValue).trim() === "")
    ));
    if (fuzzyEntry) {
      return { key: fuzzyEntry[0], value: fuzzyEntry[1] };
    }
  }

  const fallbackEntry = Object.entries(row || {}).find(([key, rawValue]) => {
    const normalized = normalizeComparisonMetricKey(key);
    if (normalized.endsWith("__label")) {
      return false;
    }
    if (!normalized.includes("mailed")) {
      return false;
    }
    if (normalized.includes("rate")) {
      return false;
    }
    return !(rawValue === null || rawValue === undefined || String(rawValue).trim() === "");
  });

  return fallbackEntry ? { key: fallbackEntry[0], value: fallbackEntry[1] } : { key: "", value: "" };
}

function getTotalMailedFromRow(row) {
  const rawValue = getRowMetricRawValueByAliases(row, [
    "Total Mailed",
    "Sum of Mailed",
    "Mailed",
    "Mailed Count",
    "Mail Count",
    "Total Mail",
    "total_mail",
    "total_mailed",
    "quantity mailed",
    "quantityMailed",
    "mail count",
    "mailing total",
  ]);
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return "";
  }
  return rawValue;
}

function getTotalMailedMatchFromRow(row) {
  return getRowMetricMatchByAliases(row, [
    "Total Mailed",
    "Sum of Mailed",
    "Mailed",
    "Mailed Count",
    "Mail Count",
    "Total Mail",
    "total_mail",
    "total_mailed",
    "quantity mailed",
    "quantityMailed",
    "mail count",
    "mailing total",
  ]);
}

function getRowMetricNumber(row, metricLabel) {
  const rawValue = getRowMetricRawValueByAliases(row, getMetricLabelAliases(metricLabel));
  return parseLooseMetricNumber(rawValue);
}

function parseLooseMetricNumber(value) {
  return parseLooseMetricNumberDetailed(value).numericValue;
}

function parseLooseMetricNumberDetailed(value) {
  if (value === null || value === undefined || value === "") {
    return { numericValue: 0, isBlank: true, isNumeric: false };
  }
  const raw = String(value).trim();
  if (!raw) {
    return { numericValue: 0, isBlank: true, isNumeric: false };
  }
  const isNegative = raw.startsWith("(") && raw.endsWith(")");
  const numeric = Number(raw.replace(/[$,%(),\s]/g, ""));
  if (!Number.isFinite(numeric)) {
    return { numericValue: 0, isBlank: false, isNumeric: false };
  }
  return { numericValue: isNegative ? -numeric : numeric, isBlank: false, isNumeric: true };
}

function getNavigatorEntryMetricNumericValue(entry, metricKey) {
  const normalizedMetricKey = String(metricKey || "soldRate").trim();
  const metricLabel = getReviewMetricDisplayName(normalizedMetricKey);
  const displayValue = getRowMetricDisplayValue(entry?.row || {}, metricLabel);
  const parsedDisplayValue = parseLooseMetricNumber(displayValue);
  if (displayValue !== "-" || parsedDisplayValue !== 0) {
    return parsedDisplayValue;
  }
  return parseLooseMetricNumber(entry?.[normalizedMetricKey]);
}

function isZeroNavigatorMetricEntry(entry, metricKey) {
  const metricLabel = getReviewMetricDisplayName(metricKey);
  const displayValue = String(getRowMetricDisplayValue(entry?.row || {}, metricLabel) || "").trim();
  if (/^0(?:\.0+)?%?$/.test(displayValue)) {
    return true;
  }
  return getNavigatorEntryMetricNumericValue(entry, metricKey) === 0;
}

function getRowMetricDisplayValue(row, metricLabel) {
  const target = normalizeComparisonMetricKey(metricLabel);
  const labelEntry = Object.entries(row || {}).find(([key]) => {
    if (!String(key).endsWith("__label")) return false;
    const baseKey = String(key).slice(0, -7);
    return normalizeComparisonMetricKey(baseKey) === target;
  });
  const rawValue = labelEntry ? labelEntry[1] : getRowMetricValue(row, metricLabel);
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return "-";
  }

  if (target.includes("rate")) {
    return formatRateDecimalValue(rawValue);
  }

  return String(rawValue);
}

function getRowStateValue(row) {
  const entries = Object.entries(row || {});
  const preferredEntry = entries.find(([key]) => {
    const normalized = normalizeComparisonMetricKey(key);
    return normalized === "state" || normalized.endsWith(" state") || normalized.includes("mailing to state");
  });
  if (preferredEntry) {
    return String(preferredEntry[1] || "").trim();
  }
  return "";
}

function getReviewMetricDisplayName(metricKey) {
  const normalized = String(metricKey || "").trim();
  if (normalized === "inForceRate") return "In Force Rate";
  if (normalized === "convertedRate") return "Converted Rate";
  return "Sold Rate";
}

function getReviewBaselineListEntries(listType) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  return ensureArray(
    (state.analysis.reviewBaselineLists || []).find((entry) => String(entry?.type || "").trim().toLowerCase() === normalizedType)?.items || []
  );
}

function getDnmReferenceScfSet() {
  return new Set(
    getReviewBaselineListEntries("dnm")
      .map((entry) => normalizeScf(entry?.scf))
      .filter(Boolean)
  );
}

function inferReviewMetricScale(rows = [], metricKey) {
  const normalizedMetricKey = String(metricKey || "soldRate").trim();
  const numericValues = rows
    .map((entry) => Number(entry?.[normalizedMetricKey]))
    .filter((value) => Number.isFinite(value));
  if (!numericValues.length) {
    return "percent";
  }
  const maxValue = Math.max(...numericValues);
  return maxValue <= 1 ? "decimal" : "percent";
}

function parseReviewRateThreshold(thresholdValue, rows = [], metricKey = "soldRate") {
  const rawValue = String(thresholdValue ?? "").trim();
  if (!rawValue) {
    return null;
  }

  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  const metricScale = inferReviewMetricScale(rows, metricKey);
  let compareValue = numericValue;
  if (metricScale === "percent" && numericValue > 0 && numericValue <= 1) {
    compareValue = numericValue * 100;
  } else if (metricScale === "decimal" && numericValue > 1) {
    compareValue = numericValue / 100;
  }

  const displayPercent = metricScale === "decimal" ? compareValue * 100 : compareValue;
  return {
    rawValue,
    inputValue: numericValue,
    compareValue,
    displayPercent,
    displayLabel: `${displayPercent.toFixed(2)}%`,
    metricScale,
  };
}

function isValidReviewFilterOperator(operator) {
  return [">", ">=", "<", "<=", "=", "!="].includes(String(operator || "").trim());
}

function normalizeReviewFilterOperator(operator, fallback = ">") {
  const normalized = String(operator || "").trim();
  return isValidReviewFilterOperator(normalized) ? normalized : fallback;
}

function compareReviewFilterValues(leftValue, operator, rightValue) {
  const left = Number(leftValue);
  const right = Number(rightValue);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  switch (normalizeReviewFilterOperator(operator)) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
}

function buildPrimaryNavigatorRows(report) {
  return getUnifiedReportScfEntries(report).map((entry) => ({
    scf: entry.scf,
    row: entry.row,
    source: entry.source || "",
    mailed: getRowMetricNumber(entry.row, "Sum of Mailed"),
    soldRate: getRowMetricNumber(entry.row, "Sold Rate"),
    inForceRate: getRowMetricNumber(entry.row, "In Force Rate"),
    convertedRate: getRowMetricNumber(entry.row, "Converted Rate"),
  }));
}

function logPrimaryNavigatorRateTrace(report, rows = [], scfs = ["010", "011", "012", "013", "014", "015"]) {
  const normalizedReportId = String(report?.id || "").trim();
  if (!normalizedReportId || !Array.isArray(rows) || !rows.length) {
    return;
  }

  const targetScfs = new Set(ensureArray(scfs).map((entry) => normalizeScf(entry)).filter(Boolean));
  rows
    .filter((entry) => targetScfs.has(entry.scf))
    .forEach((entry) => {
      const cachedMetrics = getCachedAnalysisReportScfMetrics(normalizedReportId, entry.scf);
      console.debug("Primary navigator rate trace", {
        reportId: normalizedReportId,
        scf: entry.scf,
        source: entry.source || "",
        exactSource: cachedMetrics?.source || "",
        mailed: getRowMetricNumber(entry.row, "Sum of Mailed"),
        soldCount: getRowMetricNumber(entry.row, "Sum of Opp Count"),
        inForceCount: getRowMetricNumber(entry.row, "Sum of In Force"),
        convertedCount: Math.max(
          getRowMetricNumber(entry.row, "Sum of Converted"),
          getRowMetricNumber(entry.row, "Sum of Sold")
        ),
        convertedPremiumTotal: getRowMetricNumber(entry.row, "Sum of Total Converted Monthly Premiums"),
        soldRate: getRowMetricNumber(entry.row, "Sold Rate"),
        inForceRate: getRowMetricNumber(entry.row, "In Force Rate"),
        convertedRate: getRowMetricNumber(entry.row, "Converted Rate"),
      });
    });
}

function mergeExactMetricsIntoNavigatorRows(rows = [], report, scfs, options = {}) {
  const normalizedReportId = String(report?.id || "").trim();
  const requestMissing = options.requestMissing !== false;
  const normalizedScfs = Array.from(
    new Set(
      ensureArray(Array.isArray(scfs) ? scfs : [scfs])
        .map((entry) => normalizeScf(entry))
        .filter(Boolean)
    )
  );
  if (!normalizedScfs.length || !normalizedReportId || !Array.isArray(rows) || !rows.length) {
    return rows;
  }

  return rows.map((entry) => {
    if (!normalizedScfs.includes(entry.scf)) {
      return entry;
    }

    const cachedMetrics = getCachedAnalysisReportScfMetrics(normalizedReportId, entry.scf);
    if (!cachedMetrics) {
      if (requestMissing) {
        requestAnalysisReportScfMetrics(normalizedReportId, entry.scf);
      }
      return entry;
    }

    if (cachedMetrics.status !== "ready" || !cachedMetrics.row) {
      return entry;
    }

    const normalizedRow = mergePreferredNavigatorRow(entry.row, cachedMetrics.row);

    return {
      scf: entry.scf,
      row: normalizedRow,
      source: cachedMetrics.source || entry.source || "",
      mailed: getRowMetricNumber(normalizedRow, "Sum of Mailed"),
      soldRate: getRowMetricNumber(normalizedRow, "Sold Rate"),
      inForceRate: getRowMetricNumber(normalizedRow, "In Force Rate"),
      convertedRate: getRowMetricNumber(normalizedRow, "Converted Rate"),
    };
  });
}

function prefetchAnalysisReportScfMetrics(report, scfs) {
  const normalizedReportId = String(report?.id || "").trim();
  const normalizedScfs = Array.from(
    new Set(
      ensureArray(Array.isArray(scfs) ? scfs : [scfs])
        .map((entry) => normalizeScf(entry))
        .filter(Boolean)
    )
  );
  if (!normalizedReportId || !normalizedScfs.length) {
    return;
  }

  window.setTimeout(() => {
    normalizedScfs.forEach((scf) => {
      requestAnalysisReportScfMetrics(normalizedReportId, scf);
    });
  }, 0);
}

function getSortedFilteredPrimaryRows(rows = [], comparisonId = state.analysis.selectedComparisonId) {
  const soldRateOperator = normalizeReviewFilterOperator(state.analysis.reviewSoldRateOperator, ">");
  const soldRateMinRaw = String(state.analysis.reviewSoldRateMin || "").trim();
  const inForceRateOperator = normalizeReviewFilterOperator(state.analysis.reviewInForceRateOperator, ">");
  const inForceRateValueRaw = String(state.analysis.reviewInForceRateValue || "").trim();
  const convertedRateOperator = normalizeReviewFilterOperator(state.analysis.reviewConvertedRateOperator, "!=");
  const convertedRateValueRaw = String(state.analysis.reviewConvertedRateValue || "").trim();
  const mailedOperator = normalizeReviewFilterOperator(state.analysis.reviewMailedOperator, ">");
  const mailedMinRaw = String(state.analysis.reviewMailedMin || "").trim();
  const parsedSoldRateThreshold = parseLooseMetricNumberDetailed(soldRateMinRaw);
  const parsedInForceRateThreshold = parseLooseMetricNumberDetailed(inForceRateValueRaw);
  const parsedConvertedRateThreshold = parseLooseMetricNumberDetailed(convertedRateValueRaw);
  const parsedMailedMin = parseLooseMetricNumberDetailed(mailedMinRaw);
  const filteredRows = rows.filter((entry) => {
    if (
      !parsedSoldRateThreshold.isBlank
      && parsedSoldRateThreshold.isNumeric
      && !compareReviewFilterValues(getNavigatorEntryMetricNumericValue(entry, "soldRate"), soldRateOperator, parsedSoldRateThreshold.numericValue)
    ) {
      return false;
    }
    if (
      !parsedInForceRateThreshold.isBlank
      && parsedInForceRateThreshold.isNumeric
      && !compareReviewFilterValues(getNavigatorEntryMetricNumericValue(entry, "inForceRate"), inForceRateOperator, parsedInForceRateThreshold.numericValue)
    ) {
      return false;
    }
    if (
      !parsedConvertedRateThreshold.isBlank
      && parsedConvertedRateThreshold.isNumeric
      && !compareReviewFilterValues(getNavigatorEntryMetricNumericValue(entry, "convertedRate"), convertedRateOperator, parsedConvertedRateThreshold.numericValue)
    ) {
      return false;
    }
    if (
      !parsedMailedMin.isBlank
      && parsedMailedMin.isNumeric
      && !compareReviewFilterValues(Number(entry?.mailed || 0), mailedOperator, parsedMailedMin.numericValue)
    ) {
      return false;
    }
    return true;
  });
  const activeNavigatorScfFilterSet = new Set(
    ensureArray(state.analysis.activeNavigatorScfFilter).map((entry) => normalizeScf(entry)).filter(Boolean)
  );
  const navigatorRows = activeNavigatorScfFilterSet.size
    ? filteredRows.filter((entry) => activeNavigatorScfFilterSet.has(normalizeScf(entry?.scf)))
    : filteredRows;

  const sortKey = String(state.analysis.reviewTableSort?.key || "soldRate").trim();
  const sortDirection = state.analysis.reviewTableSort?.direction === "asc" ? "asc" : "desc";
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  return [...navigatorRows].sort((a, b) => {
    if (sortKey === "scf") {
      return a.scf.localeCompare(b.scf) * directionFactor;
    }
    return (Number(a?.[sortKey] || 0) - Number(b?.[sortKey] || 0)) * directionFactor;
  });
}

function getSelectedNavigatorScfSet() {
  return new Set(
    ensureArray(state.analysis.selectedNavigatorScfs)
      .map((entry) => normalizeScf(entry))
      .filter(Boolean)
  );
}

function toggleSelectedNavigatorScf(scf, shouldSelect) {
  const normalizedScf = normalizeScf(scf);
  if (!normalizedScf) {
    return;
  }
  const next = getSelectedNavigatorScfSet();
  if (shouldSelect) {
    next.add(normalizedScf);
  } else {
    next.delete(normalizedScf);
  }
  state.analysis.selectedNavigatorScfs = Array.from(next);
}

function applySelectedNavigatorFilter() {
  const selected = Array.from(getSelectedNavigatorScfSet());
  state.analysis.activeNavigatorScfFilter = selected;
  state.analysis.reviewPageNumber = 1;
  console.info("[analysis-navigator-filter]", {
    action: "apply",
    selectedCount: selected.length,
    scfs: selected,
  });
}

function clearSelectedNavigatorFilter() {
  state.analysis.selectedNavigatorScfs = [];
  state.analysis.activeNavigatorScfFilter = [];
  state.analysis.reviewPageNumber = 1;
  console.info("[analysis-navigator-filter]", {
    action: "clear",
  });
}

function removeWorkingListEntriesBelowRate(listType, rows = [], metricKey, thresholdValue) {
  const normalizedListType = String(listType || "").trim().toLowerCase();
  const normalizedMetricKey = String(metricKey || "soldRate").trim();
  const parsedThreshold = parseReviewRateThreshold(thresholdValue, rows, normalizedMetricKey);
  if (!parsedThreshold) {
    return { removedCount: 0, affectedScfs: [] };
  }

  ensureComparisonReviewWorkingLists();
  const list = getWorkingReferenceList(normalizedListType);
  if (!list) {
    return { removedCount: 0, affectedScfs: [] };
  }

  const scfsToRemove = new Set(
    rows
      .filter((entry) => {
        const metricValue = Number(entry?.[normalizedMetricKey] || 0);
        return metricValue <= parsedThreshold.compareValue;
      })
      .map((entry) => normalizeScf(entry?.scf))
      .filter(Boolean)
  );

  if (!scfsToRemove.size) {
    return { removedCount: 0, affectedScfs: [] };
  }

  const originalItems = Array.isArray(list.items) ? list.items : [];
  const removedItems = originalItems.filter((entry) => scfsToRemove.has(normalizeScf(entry?.scf)));
  const remainingItems = originalItems.filter((entry) => !scfsToRemove.has(normalizeScf(entry?.scf)));
  const removedCount = removedItems.length;
  list.items = remainingItems;
  list.count = remainingItems.length;
  list.updatedAt = new Date().toISOString();
  invalidateComparisonReviewSummary();

  return {
    removedCount,
    affectedScfs: removedItems.map((entry) => normalizeScf(entry?.scf)).filter(Boolean),
  };
}

function removeWorkingListEntriesAtZeroRate(listType, rows = [], metricKey) {
  const normalizedListType = String(listType || "").trim().toLowerCase();
  const normalizedMetricKey = String(metricKey || "soldRate").trim();
  const metricLabel = getReviewMetricDisplayName(normalizedMetricKey);
  const checkedRows = ensureArray(rows);

  ensureComparisonReviewWorkingLists();
  const list = getWorkingReferenceList(normalizedListType);
  const currentScfs = new Set(ensureArray(list?.items).map((entry) => normalizeScf(entry?.scf)).filter(Boolean));
  const dnmScfs = getDnmReferenceScfSet();
  const metricFieldUsage = new Map();
  const sampleRows = checkedRows.slice(0, 20).map((entry) => {
    const scf = normalizeScf(entry?.scf);
    const metricMatch = getRowMetricMatchByAliases(entry?.row || {}, [metricLabel]);
    const displayMetricValue = getRowMetricDisplayValue(entry?.row || {}, metricLabel);
    const rawMetricValue =
      metricMatch.value === null || metricMatch.value === undefined
        ? ""
        : String(metricMatch.value).trim();
    const parsedDisplayMetricValue = parseLooseMetricNumber(displayMetricValue);
    const parsedRawMetricValue = parseLooseMetricNumber(rawMetricValue);
    const isZero = isZeroNavigatorMetricEntry(entry, normalizedMetricKey);
    if (metricMatch.key) {
      metricFieldUsage.set(metricMatch.key, Number(metricFieldUsage.get(metricMatch.key) || 0) + 1);
    }
    return {
      scf,
      metricKey: normalizedMetricKey,
      metricLabel,
      metricFieldKey: String(metricMatch.key || "").trim(),
      displayedMetricValue: String(displayMetricValue || "").trim(),
      rawMetricValue,
      parsedDisplayedMetricValue: parsedDisplayMetricValue,
      parsedRawMetricValue,
      wouldRemove: isZero,
      onWorkingList: currentScfs.has(scf),
      onDoNotMailList: dnmScfs.has(scf),
    };
  }).filter((entry) => entry.scf);
  if (!list) {
    return {
      removedCount: 0,
      removedScfs: [],
      foundZeroRateScfs: [],
      skippedAlreadyRemovedScfs: [],
      skippedDnmScfs: [],
      checkedCount: checkedRows.length,
      totalMailedRemoved: 0,
      diagnostics: {
        totalReportRowsChecked: checkedRows.length,
        zeroRemovalFieldUsed: metricLabel,
        zeroRemovalCandidateCount: 0,
        zeroValueCount: 0,
        blankOrNullCount: 0,
        nonNumericCount: 0,
        zeroRemovalSampleRows: sampleRows,
        zeroRemovalMetricKey: normalizedMetricKey,
        zeroRemovalMetricLabel: metricLabel,
      },
    };
  }
  const foundZeroRateScfs = [];
  const skippedAlreadyRemovedScfs = [];
  const skippedDnmScfs = [];
  const scfsToRemove = [];
  const mailedByScf = new Map();

  checkedRows.forEach((entry) => {
    const scf = normalizeScf(entry?.scf);
    if (!scf || !isZeroNavigatorMetricEntry(entry, normalizedMetricKey)) {
      return;
    }
    foundZeroRateScfs.push(scf);
    mailedByScf.set(scf, Number(entry?.mailed || 0));
    if (!currentScfs.has(scf)) {
      if (dnmScfs.has(scf)) {
        skippedDnmScfs.push(scf);
      } else {
        skippedAlreadyRemovedScfs.push(scf);
      }
      return;
    }
    scfsToRemove.push(scf);
  });

  const uniqueScfsToRemove = new Set(scfsToRemove);

  const originalItems = Array.isArray(list.items) ? list.items : [];
  const removedItems = originalItems.filter((entry) => uniqueScfsToRemove.has(normalizeScf(entry?.scf)));
  const remainingItems = originalItems.filter((entry) => !uniqueScfsToRemove.has(normalizeScf(entry?.scf)));
  const removedCount = removedItems.length;
  const totalMailedRemoved = removedItems.reduce((sum, entry) => sum + Number(mailedByScf.get(normalizeScf(entry?.scf)) || 0), 0);
  if (removedCount > 0) {
    list.items = remainingItems;
    list.count = remainingItems.length;
    list.updatedAt = new Date().toISOString();
    invalidateComparisonReviewSummary();
  }

  const zeroValueCount = foundZeroRateScfs.length;

  return {
    removedCount,
    removedScfs: removedItems.map((entry) => normalizeScf(entry?.scf)).filter(Boolean),
    foundZeroRateScfs: Array.from(new Set(foundZeroRateScfs)),
    skippedAlreadyRemovedScfs: Array.from(new Set(skippedAlreadyRemovedScfs)),
    skippedDnmScfs: Array.from(new Set(skippedDnmScfs)),
    checkedCount: checkedRows.length,
    totalMailedRemoved,
    diagnostics: {
      totalReportRowsChecked: checkedRows.length,
      zeroRemovalFieldUsed: [...metricFieldUsage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || metricLabel,
      zeroRemovalCandidateCount: zeroValueCount,
      zeroValueCount,
      blankOrNullCount: 0,
      nonNumericCount: 0,
      zeroRemovalSampleRows: sampleRows,
      zeroRemovalMetricKey: normalizedMetricKey,
      zeroRemovalMetricLabel: metricLabel,
      zeroRemovalOnWorkingListCount: foundZeroRateScfs.filter((scf) => currentScfs.has(scf)).length,
      zeroRemovalAlreadyOffListCount: skippedAlreadyRemovedScfs.length,
      zeroRemovalAlreadyDnmCount: skippedDnmScfs.length,
    },
  };
}

function isZeroQuantityNavigatorEntry(entry) {
  const mailedInfo = parseLooseMetricNumberDetailed(getTotalMailedFromRow(entry?.row || {}));
  return mailedInfo.isBlank || !mailedInfo.isNumeric || mailedInfo.numericValue === 0;
}

function analyzeZeroQuantityReportRows(report) {
  const entries = getUnifiedReportScfEntries(report);
  const fieldUsage = new Map();
  const candidateRows = entries.map((entry) => {
    const mailedMatch = getTotalMailedMatchFromRow(entry?.row || {});
    const parsed = parseLooseMetricNumberDetailed(mailedMatch.value);
    if (mailedMatch.key) {
      fieldUsage.set(mailedMatch.key, Number(fieldUsage.get(mailedMatch.key) || 0) + 1);
    }
    return {
      scf: normalizeScf(entry?.scf),
      rawMailedValue:
        mailedMatch.value === null || mailedMatch.value === undefined
          ? ""
          : String(mailedMatch.value),
      parsedMailedValue: parsed.numericValue,
      isBlank: parsed.isBlank,
      isNumeric: parsed.isNumeric,
      wouldRemove: parsed.isBlank || !parsed.isNumeric || parsed.numericValue === 0,
    };
  });

  const zeroValueCount = candidateRows.filter((entry) => entry.isNumeric && !entry.isBlank && entry.parsedMailedValue === 0).length;
  const blankOrNullCount = candidateRows.filter((entry) => entry.isBlank).length;
  const nonNumericCount = candidateRows.filter((entry) => !entry.isBlank && !entry.isNumeric).length;
  const sampleRows = candidateRows.slice(0, 10).map((entry) => ({
    scf: entry.scf,
    rawMailedValue: entry.rawMailedValue,
    parsedMailedValue: entry.parsedMailedValue,
    wouldRemove: entry.wouldRemove,
  }));

  const zeroRemovalFieldUsed = [...fieldUsage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  return {
    reportId: String(report?.id || "").trim(),
    totalReportRowsChecked: candidateRows.length,
    zeroRemovalFieldUsed,
    zeroRemovalCandidateCount: candidateRows.filter((entry) => entry.wouldRemove).length,
    zeroValueCount,
    blankOrNullCount,
    nonNumericCount,
    zeroRemovalSampleRows: sampleRows,
    candidateRows,
  };
}

function removeWorkingListEntriesAtZeroQuantity(listType, report) {
  const normalizedListType = String(listType || "").trim().toLowerCase();
  const diagnostics = analyzeZeroQuantityReportRows(report);

  ensureComparisonReviewWorkingLists();
  const list = getWorkingReferenceList(normalizedListType);
  if (!list) {
    return {
      removedCount: 0,
      removedScfs: [],
      foundZeroRateScfs: [],
      skippedAlreadyRemovedScfs: [],
      skippedDnmScfs: [],
      checkedCount: diagnostics.totalReportRowsChecked,
      totalMailedRemoved: 0,
      diagnostics,
    };
  }

  const currentScfs = new Set(ensureArray(list.items).map((entry) => normalizeScf(entry?.scf)).filter(Boolean));
  const dnmScfs = getDnmReferenceScfSet();
  const foundZeroQuantityScfs = [];
  const skippedAlreadyRemovedScfs = [];
  const skippedDnmScfs = [];
  const scfsToRemove = [];
  const mailedByScf = new Map();

  diagnostics.candidateRows.forEach((entry) => {
    const scf = normalizeScf(entry?.scf);
    if (!scf || !entry.wouldRemove) {
      return;
    }
    foundZeroQuantityScfs.push(scf);
    mailedByScf.set(scf, Number(entry.parsedMailedValue || 0));
    if (!currentScfs.has(scf)) {
      if (dnmScfs.has(scf)) {
        skippedDnmScfs.push(scf);
      } else {
        skippedAlreadyRemovedScfs.push(scf);
      }
      return;
    }
    scfsToRemove.push(scf);
  });

  const uniqueScfsToRemove = new Set(scfsToRemove);
  const originalItems = Array.isArray(list.items) ? list.items : [];
  const removedItems = originalItems.filter((entry) => uniqueScfsToRemove.has(normalizeScf(entry?.scf)));
  const remainingItems = originalItems.filter((entry) => !uniqueScfsToRemove.has(normalizeScf(entry?.scf)));
  const removedCount = removedItems.length;
  const totalMailedRemoved = removedItems.reduce(
    (sum, entry) => sum + Number(mailedByScf.get(normalizeScf(entry?.scf)) || 0),
    0
  );
  if (removedCount > 0) {
    list.items = remainingItems;
    list.count = remainingItems.length;
    list.updatedAt = new Date().toISOString();
    invalidateComparisonReviewSummary();
  }

  return {
    removedCount,
    removedScfs: removedItems.map((entry) => normalizeScf(entry?.scf)).filter(Boolean),
    foundZeroRateScfs: Array.from(new Set(foundZeroQuantityScfs)),
    skippedAlreadyRemovedScfs: Array.from(new Set(skippedAlreadyRemovedScfs)),
    skippedDnmScfs: Array.from(new Set(skippedDnmScfs)),
    checkedCount: diagnostics.totalReportRowsChecked,
    totalMailedRemoved,
    diagnostics,
  };
}

function calculateWorkingListEntriesBelowRatePreview(listType, rows = [], metricKey, thresholdValue) {
  const normalizedListType = String(listType || "").trim().toLowerCase();
  const normalizedMetricKey = String(metricKey || "soldRate").trim();
  const parsedThreshold = parseReviewRateThreshold(thresholdValue, rows, normalizedMetricKey);
  if (!parsedThreshold) {
    return null;
  }

  ensureComparisonReviewWorkingLists();
  const list = getWorkingReferenceList(normalizedListType);
  if (!list) {
    return null;
  }

  const currentItems = Array.isArray(list.items) ? list.items : [];
  const currentScfs = new Set(currentItems.map((entry) => normalizeScf(entry?.scf)).filter(Boolean));
  const matchingScfs = rows
    .filter((entry) => {
      const normalizedScf = normalizeScf(entry?.scf);
      if (!normalizedScf) {
        return false;
      }
      const metricValue = Number(entry?.[normalizedMetricKey] || 0);
      return metricValue <= parsedThreshold.compareValue;
    })
    .map((entry) => normalizeScf(entry?.scf))
    .filter(Boolean);
  const affectedScfs = matchingScfs.filter((scf) => currentScfs.has(scf));

  return {
    listType: normalizedListType,
    metricKey: normalizedMetricKey,
    thresholdValue: String(thresholdValue || "").trim(),
    parsedThreshold,
    currentCount: currentItems.length,
    matchedCount: matchingScfs.length,
    affectedCount: affectedScfs.length,
    affectedScfs,
  };
}

function appendAnalysisReviewNote(note) {
  const normalizedNote = String(note || "").trim();
  if (!normalizedNote) return;
  if (isAutoAnalysisReviewNote(normalizedNote)) {
    return;
  }
  const currentNotes = getManualAnalysisReviewNotes(state.analysis.reviewSummaryNotes);
  state.analysis.reviewSummaryNotes = currentNotes
    ? `${currentNotes}\n${normalizedNote}`
    : normalizedNote;
}

function stripAutoAnalysisReviewNotes() {
  state.analysis.reviewSummaryNotes = getManualAnalysisReviewNotes(state.analysis.reviewSummaryNotes);
}

function resetAnalysisWorkingState(options = {}) {
  const readOnly = options.readOnly === true;
  if (readOnly || isCurrentAnalysisReadOnly()) {
    setStatus("analysis-comparison-selection-status", "Completed analyses are read-only. Undo completion before resetting.");
    return false;
  }

  ensureComparisonReviewWorkingLists();
  state.analysis.reviewWorkingLists = cloneData(state.analysis.reviewBaselineLists || []);
  state.analysis.reviewZeroRateRemovals = [];
  state.analysis.reviewZeroRemovalDiagnostics = null;
  state.analysis.reviewBulkPreview = null;
  state.analysis.selectedNavigatorScfs = [];
  state.analysis.activeNavigatorScfFilter = [];
  state.analysis.reviewSoldRateOperator = ">";
  state.analysis.reviewSoldRateMin = "";
  state.analysis.reviewInForceRateOperator = ">";
  state.analysis.reviewInForceRateValue = "";
  state.analysis.reviewConvertedRateOperator = "!=";
  state.analysis.reviewConvertedRateValue = "";
  state.analysis.reviewMailedOperator = ">";
  state.analysis.reviewMailedMin = "";
  state.analysis.reviewSummaryApproved = false;
  stripAutoAnalysisReviewNotes();
  invalidateComparisonReviewSummary();
  scheduleReviewStateAutosave("restore-working-lists");
  broadcastAnalysisReviewState("restore-working-lists");
  setStatus(
    "analysis-comparison-selection-status",
    "Analysis was reset to the starting mailing lists."
  );
  return true;
}

function recordZeroRateRemovalAction(action = {}) {
  const normalizedAction = normalizeReviewZeroRateRemovals([{
    ...action,
    id: String(action.id || "").trim() || createClientId("zero_rate_removal"),
    createdAt: String(action.createdAt || "").trim() || new Date().toISOString(),
  }])[0];
  if (!normalizedAction) {
    return null;
  }
  state.analysis.reviewZeroRateRemovals = [
    ...ensureArray(state.analysis.reviewZeroRateRemovals).filter((entry) => String(entry?.id || "").trim() !== normalizedAction.id),
    normalizedAction,
  ];
  return normalizedAction;
}

function getActiveZeroRateRemovalActions() {
  const workingMaps = new Map(
    ensureArray(state.analysis.reviewWorkingLists).map((entry) => [
      String(entry?.type || "").trim().toLowerCase(),
      new Set(ensureArray(entry?.items).map((item) => normalizeScf(item?.scf)).filter(Boolean)),
    ])
  );
  const baselineMaps = new Map(
    ensureArray(state.analysis.reviewBaselineLists).map((entry) => [
      String(entry?.type || "").trim().toLowerCase(),
      new Set(ensureArray(entry?.items).map((item) => normalizeScf(item?.scf)).filter(Boolean)),
    ])
  );

  return normalizeReviewZeroRateRemovals(state.analysis.reviewZeroRateRemovals).map((action) => {
    const normalizedListType = String(action.listType || "").trim().toLowerCase();
    const workingSet = workingMaps.get(normalizedListType) || new Set();
    const baselineSet = baselineMaps.get(normalizedListType) || new Set();
    const activeRemovedScfs = ensureArray(action.removedScfs).filter((scf) => baselineSet.has(scf) && !workingSet.has(scf));
    return {
      ...action,
      activeRemovedScfs,
      activeRemovedCount: activeRemovedScfs.length,
      isPending: !action.undoneAt && activeRemovedScfs.length > 0,
    };
  });
}

function buildZeroRateRemovalSummary() {
  const actions = getActiveZeroRateRemovalActions().filter((entry) => entry.isPending);
  return {
    actions,
    totalRemovedCount: actions.reduce((sum, entry) => sum + Number(entry.activeRemovedCount || 0), 0),
    totalMailedRemoved: actions.reduce((sum, entry) => sum + Number(entry.totalMailedRemoved || 0), 0),
    totalActionCount: actions.length,
  };
}

function restoreZeroRateRemovalAction(actionId) {
  const normalizedActionId = String(actionId || "").trim();
  if (!normalizedActionId) {
    return { restoredCount: 0, restoredScfs: [] };
  }
  ensureComparisonReviewWorkingLists();
  const action = normalizeReviewZeroRateRemovals(state.analysis.reviewZeroRateRemovals).find((entry) => entry.id === normalizedActionId);
  if (!action) {
    return { restoredCount: 0, restoredScfs: [] };
  }
  const normalizedListType = String(action.listType || "").trim().toLowerCase();
  const list = getWorkingReferenceList(normalizedListType);
  if (!list) {
    return { restoredCount: 0, restoredScfs: [] };
  }
  const baselineRows = getReviewBaselineListEntries(normalizedListType);
  const currentScfs = new Set(ensureArray(list.items).map((entry) => normalizeScf(entry?.scf)).filter(Boolean));
  const activeRemovedScfs = getActiveZeroRateRemovalActions().find((entry) => entry.id === normalizedActionId)?.activeRemovedScfs || [];
  const restoreRows = baselineRows.filter((entry) => activeRemovedScfs.includes(normalizeScf(entry?.scf)) && !currentScfs.has(normalizeScf(entry?.scf)));
  if (!restoreRows.length) {
    state.analysis.reviewZeroRateRemovals = ensureArray(state.analysis.reviewZeroRateRemovals).map((entry) =>
      String(entry?.id || "").trim() === normalizedActionId
        ? { ...entry, undoneAt: entry.undoneAt || new Date().toISOString() }
        : entry
    );
    state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics({
      ...(state.analysis.reviewZeroRemovalDiagnostics || {}),
      zeroRemovalLastResult: null,
    });
    return { restoredCount: 0, restoredScfs: [] };
  }
  list.items = [...ensureArray(list.items), ...restoreRows.map((entry) => ({
    ...entry,
    scope: String(entry?.scope || entry?.state || "").trim(),
  }))];
  list.count = list.items.length;
  list.updatedAt = new Date().toISOString();
  state.analysis.reviewZeroRateRemovals = ensureArray(state.analysis.reviewZeroRateRemovals).map((entry) =>
    String(entry?.id || "").trim() === normalizedActionId
      ? { ...entry, undoneAt: new Date().toISOString() }
      : entry
  );
  state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics({
    ...(state.analysis.reviewZeroRemovalDiagnostics || {}),
    zeroRemovalLastResult: null,
  });
  invalidateComparisonReviewSummary();
  return {
    restoredCount: restoreRows.length,
    restoredScfs: restoreRows.map((entry) => normalizeScf(entry?.scf)).filter(Boolean),
  };
}

function getComparisonReviewComparisonById(comparisonId) {
  const comparisons = Array.isArray(state.analysis.comparisonRequests)
    ? state.analysis.comparisonRequests
    : [];
  return comparisons.find((entry) => entry.id === comparisonId) || null;
}

function buildComparisonReviewReportMap() {
  const reportMap = new Map();

  const addReportAlias = (reportId, report) => {
    const normalizedId = String(reportId || "").trim();
    if (!normalizedId || reportMap.has(normalizedId)) return;
    reportMap.set(normalizedId, report);
  };

  ensureArray(state.analysis.savedReports).forEach((report) => {
    const reportId = String(report?.id || "").trim();
    if (!reportId) return;
    addReportAlias(reportId, report);
    addReportAlias(report?.pullId || report?.pull_id, report);
  });

  ensureArray(state.analysis.reportPulls).forEach((pull) => {
    const savedReportId = String(pull?.savedReportId || "").trim();
    const pullId = String(pull?.id || "").trim();
    if (!savedReportId && !pullId) return;

    const reportName = String(
      pull?.reportName || pull?.analysisLabel || pull?.report_name || savedReportId || pullId
    ).trim();
    const exportRows = Array.isArray(pull?.exportRows) ? pull.exportRows : [];
    const summaryValues = Array.isArray(pull?.summaryValues) ? pull.summaryValues : [];
    const reportRecord = {
      id: savedReportId || pullId,
      report_name: reportName,
      reportName,
      status: String(pull?.status || "complete").trim(),
      result_count: Number(pull?.rawRowCount || pull?.resultCount || pull?.result_count || 0),
      resultCount: Number(pull?.rawRowCount || pull?.resultCount || pull?.result_count || 0),
      input_row_count: Number(pull?.rawRowCount || 0),
      inputRowCount: Number(pull?.rawRowCount || 0),
      export_row_count: Number(pull?.exportRowCount || 0),
      exportRowCount: Number(pull?.exportRowCount || 0),
      rows: ensureArray(pull?.rows),
      columns: ensureArray(pull?.columns),
      summaryValues,
      summary_values: summaryValues,
      exportRows,
      export_rows: exportRows,
      keyCodes: ensureArray(pull?.keyCodes),
      years: ensureArray(pull?.years),
      clientType: String(pull?.clientType || "").trim(),
      scf: normalizeScf(pull?.scf),
      dateRange: pull?.dateRange || null,
    };

    addReportAlias(savedReportId, reportRecord);
    addReportAlias(pullId, reportRecord);
  });

  return reportMap;
}

function getComparisonReviewReports(comparison) {
  if (!comparison) return [];
  const reportMap = buildComparisonReviewReportMap();
  const selectedReportIds = Array.isArray(comparison.selectedReportIds) && comparison.selectedReportIds.length
    ? comparison.selectedReportIds
    : Array.isArray(comparison.reportIds) && comparison.reportIds.length
      ? comparison.reportIds
      : [comparison.reportAId, comparison.reportBId];
  return Array.from(
    new Set(
      selectedReportIds
        .map((reportId) => String(reportId || "").trim())
        .filter(Boolean)
    )
  )
    .map((reportId) => resolveHydratedAnalysisReport(reportMap.get(reportId)))
    .filter(Boolean);
}

function reportHasReviewScfData(report) {
  if (!report || typeof report !== "object") {
    return false;
  }
  if (getReportRowsWithScf(report).length) {
    return true;
  }
  if (getReportExportRowsWithScf(report).length) {
    return true;
  }
  return false;
}

function resolveHydratedAnalysisReport(report) {
  if (!report || typeof report !== "object") {
    return null;
  }
  if (reportHasReviewScfData(report)) {
    return report;
  }

  const reportId = String(report.id || "").trim();
  const pullId = String(report.pullId || report.pull_id || "").trim();
  const reportName = String(report.report_name || report.reportName || report.name || "").trim();
  const keyCodeGroup = getAnalysisReportKeyCodeGroup(report);

  const hydratedMatch = ensureArray(state.analysis.savedReports).find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    if (reportHasReviewScfData(entry) === false) {
      return false;
    }
    const entryId = String(entry.id || "").trim();
    const entryPullId = String(entry.pullId || entry.pull_id || "").trim();
    const entryName = String(entry.report_name || entry.reportName || entry.name || "").trim();
    if (reportId && entryId === reportId) {
      return true;
    }
    if (pullId && entryPullId === pullId) {
      return true;
    }
    if (reportName && entryName === reportName) {
      return true;
    }
    return Boolean(
      keyCodeGroup
      && getAnalysisReportKeyCodeGroup(entry) === keyCodeGroup
      && entryName
      && reportName
      && entryName.includes(reportName)
    );
  });

  return hydratedMatch || report;
}

function ensureComparisonReviewSelection() {
  const comparisons = Array.isArray(state.analysis.comparisonRequests)
    ? state.analysis.comparisonRequests
    : [];
  if (!comparisons.length) {
    state.analysis.selectedComparisonId = "";
    return null;
  }

  const preferredId = getPreferredComparisonId(comparisons);
  const selectedComparison = comparisons.find((entry) => entry.id === preferredId) || comparisons[0];
  state.analysis.selectedComparisonId = selectedComparison.id;

  const reports = getComparisonReviewReports(selectedComparison);
  if (!reports.length) {
    return {
      comparison: selectedComparison,
      reports: [],
      primaryReport: null,
      primaryRows: [],
      selectedScf: "",
      selectedIndex: -1,
    };
  }

  const savedPrimaryId = state.analysis.reviewPrimaryReportIds[selectedComparison.id];
  const primaryReport = reports.find((report) => report.id === savedPrimaryId) || reports[0];
  state.analysis.reviewPrimaryReportIds[selectedComparison.id] = primaryReport.id;

  const primaryRows = getUnifiedReportScfEntries(primaryReport);
  const savedScf = normalizeScf(state.analysis.reviewSelectedScfs[selectedComparison.id] || "");
  const selectedScf = savedScf || (primaryRows[0]?.scf || "");
  state.analysis.reviewSelectedScfs[selectedComparison.id] = selectedScf;
  const selectedIndex = primaryRows.findIndex((entry) => entry.scf === selectedScf);

  return {
    comparison: selectedComparison,
    reports,
    primaryReport,
    primaryRows,
    selectedScf,
    selectedIndex,
  };
}

function getWorkingListEntry(listType, scf) {
  const list = getWorkingReferenceList(listType);
  const normalizedScf = normalizeScf(scf);
  return (list?.items || []).find((entry) => normalizeScf(entry.scf) === normalizedScf) || null;
}

function getBaselineListEntry(listType, scf) {
  const normalizedType = String(listType || "").trim().toLowerCase();
  const normalizedScf = normalizeScf(scf);
  const baselineList = (state.analysis.reviewBaselineLists || []).find(
    (entry) => String(entry?.type || "").trim().toLowerCase() === normalizedType
  );
  return (baselineList?.items || []).find((entry) => normalizeScf(entry.scf) === normalizedScf) || null;
}

function getWorkingListDecisionStatus(listType, scf) {
  const baselineEntry = getBaselineListEntry(listType, scf);
  const workingEntry = getWorkingListEntry(listType, scf);

  if (!baselineEntry && workingEntry) {
    return {
      code: "pending-add",
      label: "Pending add",
      note: "Pending add to the live list when this analysis is completed.",
      baselineEntry,
      workingEntry,
    };
  }

  if (baselineEntry && !workingEntry) {
    return {
      code: "pending-remove",
      label: "Pending remove",
      note: "Pending removal from the live list when this analysis is completed.",
      baselineEntry,
      workingEntry,
    };
  }

  return {
    code: "none",
    label: "",
    note: "",
    baselineEntry,
    workingEntry,
  };
}

function getDoNotMailStatusForScf(scf, stateValue = "") {
  const normalizedScf = normalizeScf(scf);
  const entry = getWorkingListEntry("dnm", normalizedScf);
  if (entry) {
    const scope = String(entry.state || entry.scope || "").trim();
    return {
      isDoNotMail: true,
      entry,
      label: scope || "Do Not Mail",
    };
  }

  const normalizedState = String(stateValue || "").trim().toLowerCase();
  const dnmList = getWorkingReferenceList("dnm");
  const groupedScfMatch = (dnmList?.stateGroups || []).find((group) =>
    Array.isArray(group?.scfs)
    && group.scfs.some((groupScf) => normalizeScf(groupScf) === normalizedScf)
  );
  if (groupedScfMatch) {
    return {
      isDoNotMail: true,
      entry: groupedScfMatch,
      label: groupedScfMatch.label || groupedScfMatch.state || "Do Not Mail",
    };
  }

  const stateGroupMatch = (dnmList?.stateGroups || []).find((group) => {
    if (!group?.isActive) return false;
    const groupNames = [
      String(group.state || "").trim().toLowerCase(),
      String(group.label || "").trim().toLowerCase(),
    ].filter(Boolean);
    return normalizedState && groupNames.includes(normalizedState);
  });

  return {
    isDoNotMail: Boolean(stateGroupMatch),
    entry: stateGroupMatch || null,
    label: stateGroupMatch?.label || stateGroupMatch?.state || "Do Not Mail",
  };
}

function updateWorkingReferenceListEntry(listType, scf, shouldAdd, stateValue = "") {
  const normalizedScf = normalizeScf(scf);
  if (!normalizedScf) return;
  if (shouldAdd && listType !== "dnm") {
    const doNotMailMatch = getDoNotMailStatusForScf(normalizedScf);
    if (doNotMailMatch.isDoNotMail) {
      return;
    }
  }
  ensureComparisonReviewWorkingLists();
  const list = getWorkingReferenceList(listType);
  if (!list) return;

  if (shouldAdd) {
    if (list.items.some((entry) => normalizeScf(entry.scf) === normalizedScf)) {
      return;
    }
    list.items.unshift({
      scf: normalizedScf,
      state: String(stateValue || "").trim(),
      scope: String(stateValue || "").trim(),
      addedAt: new Date().toISOString(),
      addedBy: "Local User",
      reason: "Working analysis review",
      sourceAnalysis: state.analysis.runName || getDefaultAnalysisName(),
    });
    list.count = list.items.length;
    list.updatedAt = new Date().toISOString();
    invalidateComparisonReviewSummary();
    scheduleReviewStateAutosave("working-list-added");
    broadcastAnalysisReviewState("working-list-added");
    return;
  }

  list.items = (list.items || []).filter((entry) => normalizeScf(entry.scf) !== normalizedScf);
  list.count = list.items.length;
  list.updatedAt = new Date().toISOString();
  invalidateComparisonReviewSummary();
  scheduleReviewStateAutosave("working-list-removed");
  broadcastAnalysisReviewState("working-list-removed");
}

function downloadClientFile(fileName, content, contentType) {
  const blob = new Blob([content], { type: contentType });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function exportWorkingComparisonList() {
  const context = ensureComparisonReviewSelection();
  const comparison = context?.comparison;
  if (!comparison) {
    setStatus("analysis-comparison-selection-status", "Choose a comparison first.");
    return;
  }

  const listType = String(comparison.keyCodeGroup || "NHCL").trim().toLowerCase();
  const list = getWorkingReferenceList(listType);
  if (!list) {
    setStatus("analysis-comparison-selection-status", `Working ${listType.toUpperCase()} list is not available.`);
    return;
  }

  const rows = (list.items || [])
    .map((entry) => ({
      SCF: normalizeScf(entry.scf),
      State: String(entry.state || entry.scope || "").trim(),
    }))
    .filter((entry) => entry.SCF)
    .sort((a, b) => a.SCF.localeCompare(b.SCF));
  const csv = [
    "SCF,State",
    ...rows.map((entry) => `${entry.SCF},${String(entry.State || "").replace(/,/g, " ")}`),
  ].join("\n");
  downloadClientFile(
    `${listType}-working-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
    "text/csv;charset=utf-8"
  );
  setStatus(
    "analysis-comparison-selection-status",
    `Downloaded the working ${listType.toUpperCase()} list. Live lists were not changed.`
  );
}

function splitCsvValue(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function syncAnalysisMeta(meta = {}) {
  const runName = el("analysis-run-name");
  const notes = el("analysis-run-notes");
  const created = el("analysis-run-created-date");
  const updated = el("analysis-run-updated-date");

  if (meta.runName !== undefined) {
    state.analysis.runName = meta.runName || "";
  }
  if (meta.notes !== undefined) {
    state.analysis.runNotes = String(meta.notes ?? "");
  }
  if (runName && meta.runName !== undefined) runName.value = meta.runName;
  if (notes && meta.notes !== undefined) notes.value = String(meta.notes ?? "");
  if (created) created.textContent = `Created: ${formatDate(meta.createdAt)}`;
  if (updated) updated.textContent = `Last Saved: ${formatDate(meta.updatedAt)}`;
}

function renderComparisonPullOptions() {
  const selectA = el("comparison-report-a");
  const selectB = el("comparison-report-b");
  if (!selectA || !selectB) return;

  const options = state.analysis.reportPulls.map((pull, index) => ({
    id: pull.id,
    label: pull.analysisLabel || `Report Pull ${index + 1}`,
  }));

  [selectA, selectB].forEach((select) => {
    const previous = select.value;
    select.innerHTML = "";
    select.appendChild(new Option("Select report pull", ""));
    options.forEach((option) => {
      select.appendChild(new Option(option.label, option.id));
    });
    select.value = options.some((option) => option.id === previous) ? previous : "";
  });
}

function isAnalysisPullCollapsed(pullId) {
  return Boolean(state.analysis.collapsedPullIds?.[String(pullId || "").trim()]);
}

function setAnalysisPullCollapsed(pullId, collapsed) {
  const normalizedPullId = String(pullId || "").trim();
  if (!normalizedPullId) {
    return;
  }
  state.analysis.collapsedPullIds = {
    ...(state.analysis.collapsedPullIds || {}),
    [normalizedPullId]: Boolean(collapsed),
  };
}

function collapseAnalysisPullsByDefault(pulls = []) {
  state.analysis.collapsedPullIds = ensureArray(pulls).reduce((next, pull) => {
    const pullId = String(pull?.id || "").trim();
    if (pullId) {
      next[pullId] = true;
    }
    return next;
  }, {});
}

function renderAnalysisPulls() {
  const container = el("analysis-report-pulls");
  if (!container) return;

  container.innerHTML = "";
  if (!state.analysis.reportPulls.length) {
    container.innerHTML = '<div class="empty-state-block">No report pulls yet. Click Add Report Pull to start.</div>';
    renderComparisonPullOptions();
    return;
  }

  state.analysis.reportPulls.forEach((pull, index) => {
    const autoAnalysisLabel = buildAutoAnalysisLabel(pull, index);
    const isCollapsed = isAnalysisPullCollapsed(pull.id);
    const normalizedKeyCode = ensureArray(pull.keyCodes)
      .map((entry) => String(entry || "").trim().toUpperCase())
      .filter(Boolean)
      .map((entry) => entry === "NHCL" ? "N" : entry)
      .join(",");
    const keyCodeOptions = Array.from(
      new Map(
        [
          ...ANALYSIS_KEY_CODE_OPTIONS,
          ...(normalizedKeyCode ? [{ value: normalizedKeyCode, label: normalizedKeyCode }] : []),
        ]
          .filter((option) => option?.value)
          .map((option) => [option.value, option])
      ).values()
    );
    const card = document.createElement("article");
    card.className = `analysis-pull-card${isCollapsed ? " is-collapsed" : ""}`;
    card.setAttribute("data-pull-id", pull.id);
    card.innerHTML = `
      <div class="analysis-pull-head">
        <div class="analysis-pull-title-row">
          <div>
            <span class="field-label">Report Pull ${index + 1}</span>
            <strong>${esc(autoAnalysisLabel)}</strong>
          </div>
          <div class="action-row analysis-pull-head-actions">
            <button
              class="secondary-button table-action-button analysis-pull-collapse-button"
              data-action="toggle-analysis-pull"
              data-pull-id="${esc(pull.id)}"
              aria-expanded="${isCollapsed ? "false" : "true"}"
            >${isCollapsed ? "Expand" : "Collapse"}</button>
            <button class="secondary-button table-action-button" data-action="remove-analysis-pull" data-pull-id="${esc(pull.id)}">Remove</button>
          </div>
        </div>
      </div>
      <div class="analysis-pull-grid"${isCollapsed ? ' hidden' : ""}>
        <div class="field-stack">
          <label class="field-label">Salesforce Report ID</label>
          <input class="field-input" data-pull-field="reportId" data-pull-id="${esc(pull.id)}" type="text" value="${esc(pull.reportId || "")}" />
        </div>
        <div class="field-stack">
          <label class="field-label">Analysis Label</label>
          <div class="field-input analysis-readonly-field" data-derived-field="analysisLabel">${esc(autoAnalysisLabel)}</div>
        </div>
        <div class="field-stack">
          <label class="field-label">Key Codes</label>
          <select class="field-input" data-pull-field="keyCodes" data-pull-id="${esc(pull.id)}">
            <option value=""${normalizedKeyCode ? "" : " selected"}>Select Key Code</option>
            ${keyCodeOptions.map((option) => `
              <option value="${esc(option.value)}"${normalizedKeyCode === option.value ? " selected" : ""}>${esc(option.label)}</option>
            `).join("")}
          </select>
        </div>
        <div class="field-stack">
          <label class="field-label">Selected Years</label>
          <input class="field-input" data-pull-field="years" data-pull-id="${esc(pull.id)}" type="text" value="${esc((pull.years || []).join(", "))}" placeholder="2025, 2026" />
        </div>
        <div class="field-stack">
          <label class="field-label">Start Date</label>
          <input class="field-input" data-pull-field="startDate" data-pull-id="${esc(pull.id)}" type="date" value="${esc(normalizeIsoDateInput(pull.dateRange?.startDate || ""))}" />
        </div>
        <div class="field-stack">
          <label class="field-label">End Date</label>
          <input class="field-input" data-pull-field="endDate" data-pull-id="${esc(pull.id)}" type="date" value="${esc(normalizeIsoDateInput(pull.dateRange?.endDate || ""))}" />
        </div>
        <div class="field-stack">
          <label class="field-label">SCF Filter</label>
          <input class="field-input" data-pull-field="scf" data-pull-id="${esc(pull.id)}" type="text" value="${esc(pull.scf || "")}" />
        </div>
        <div class="field-stack analysis-pull-wide">
          <label class="field-label">Notes</label>
          <textarea class="field-input multiline-input" data-pull-field="notes" data-pull-id="${esc(pull.id)}">${esc(pull.notes || "")}</textarea>
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  renderComparisonPullOptions();
}

function renderAnalysisWorkspace() {
  renderAnalysisPulls();
}

function updateAnalysisPullCardPreview(pullId) {
  const normalizedPullId = String(pullId || "").trim();
  if (!normalizedPullId) {
    return;
  }

  syncAnalysisPullFromForm(normalizedPullId);

  const pullIndex = state.analysis.reportPulls.findIndex((entry) => entry.id === normalizedPullId);
  if (pullIndex === -1) {
    return;
  }

  const pull = state.analysis.reportPulls[pullIndex];
  const card = document.querySelector(`[data-pull-id="${normalizedPullId}"]`);
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const nextLabel = buildAutoAnalysisLabel(pull, pullIndex);
  const title = card.querySelector(".analysis-pull-title-row strong");
  if (title) {
    title.textContent = nextLabel;
  }

  const readonlyLabel = card.querySelector('[data-derived-field="analysisLabel"]');
  if (readonlyLabel) {
    readonlyLabel.textContent = nextLabel;
  }

}

function syncAnalysisPullFromForm(pullId) {
  const normalizedPullId = String(pullId || "").trim();
  if (!normalizedPullId) {
    return null;
  }

  const pull = state.analysis.reportPulls.find((entry) => entry.id === normalizedPullId);
  const card = document.querySelector(`[data-pull-id="${normalizedPullId}"]`);
  if (!pull || !(card instanceof HTMLElement)) {
    return pull || null;
  }

  const keyCodeField = card.querySelector('[data-pull-field="keyCodes"]');
  if (keyCodeField instanceof HTMLSelectElement || keyCodeField instanceof HTMLInputElement) {
    pull.keyCodes = splitCsvValue(keyCodeField.value);
    syncAnalysisPullClientTypeWithKeyCodes(pull);
  }

  const startDateField = card.querySelector('[data-pull-field="startDate"]');
  const endDateField = card.querySelector('[data-pull-field="endDate"]');
  const currentDateRange = pull.dateRange || { startDate: "", endDate: "" };
  if (startDateField instanceof HTMLInputElement) {
    currentDateRange.startDate = normalizeIsoDateInput(startDateField.value || "");
  }
  if (endDateField instanceof HTMLInputElement) {
    currentDateRange.endDate = normalizeIsoDateInput(endDateField.value || "");
  }
  pull.dateRange =
    currentDateRange.startDate || currentDateRange.endDate
      ? { ...currentDateRange }
      : null;

  return pull;
}

function legacyCreateComparisonLink(index = 0) {
  return {
    id: createClientId("comparison"),
    reportAId: "",
    reportBId: "",
    matchField: "SCF Grouping",
    metricColumns: [
      "Sum of Mailed",
      "Sum of Converted",
      "Sold Rate",
      "In Force Rate",
      "Converted Rate",
    ],
    label: `Comparison ${index + 1}`,
    comparisonName: `Comparison ${index + 1}`,
  };
}

function readComparisonMetricColumns(link) {
  if (Array.isArray(link?.metricColumns) && link.metricColumns.length) {
    return link.metricColumns;
  }
  return ["Sum of Mailed", "Sum of Converted", "Sold Rate", "In Force Rate", "Converted Rate"];
}

function legacyRenderComparisonResultCards() {
  const container = el("analysis-comparison-results");
  if (!container) return;
  const selectedId = state.analysis.selectedComparisonId || "";
  const allResults = Array.isArray(state.analysis.comparisonResults)
    ? state.analysis.comparisonResults
    : [];
  const results = selectedId
    ? allResults.filter((comparison) => comparison.id === selectedId)
    : allResults;
  if (!results.length) {
    container.innerHTML = '<div class="empty-state-block">No comparisons yet.</div>';
    return;
  }

  container.innerHTML = results
    .map((comparison, index) => {
      const summary = comparison.summary || {};
      const mismatchRows = Array.isArray(comparison.rows)
        ? comparison.rows.filter((row) => {
            if (!row.inReportA || !row.inReportB) {
              return true;
            }
            return Array.isArray(row.metrics)
              && row.metrics.some((metric) => Number(metric.difference || 0) !== 0);
          }).slice(0, 12)
        : [];

      const mismatchItems = mismatchRows.length
        ? `<ul class="comparison-issue-list">${mismatchRows
            .map((row) => {
              const issueText = !row.inReportA
                ? `Only in ${comparison.reportBLabel}`
                : !row.inReportB
                  ? `Only in ${comparison.reportALabel}`
                  : (row.metrics || [])
                      .filter((metric) => Number(metric.difference || 0) !== 0)
                      .map(
                        (metric) =>
                          `${metric.metricLabel}: ${metric.reportAValue ?? "-"} vs ${metric.reportBValue ?? "-"}`
                      )
                      .join(" | ");
              return `<li><strong>${esc(row.matchValue || "")}</strong> ${esc(issueText || "")}</li>`;
            })
            .join("")}</ul>`
        : "<p>All matched rows are aligned for the selected metrics.</p>";

      const cardClass =
        Number(summary.onlyInReportA || 0) === 0 && Number(summary.onlyInReportB || 0) === 0 && !mismatchRows.length
          ? "comparison-summary-card is-match"
          : "comparison-summary-card is-mismatch";

      return `
        <article class="${cardClass}">
          <h4>${esc(comparison.comparisonName || comparison.reportALabel || `Comparison ${index + 1}`)}</h4>
          <p>${esc(comparison.reportALabel || "")} vs ${esc(comparison.reportBLabel || "")}</p>
          <div class="comparison-summary-meta">
            <span>Matched SCFs: ${Number(summary.inBoth || 0)}</span>
            <span>Only in first: ${Number(summary.onlyInReportA || 0)}</span>
            <span>Only in second: ${Number(summary.onlyInReportB || 0)}</span>
            <span>Match field: ${esc(comparison.matchField || "SCF Grouping")}</span>
          </div>
          ${mismatchItems}
        </article>
      `;
    })
    .join("");
}

function legacyRenderAnalysisComparePanel() {
  const container = el("analysis-comparison-links");
  if (!container) return;

  const reports = Array.isArray(state.analysis.savedReports) ? state.analysis.savedReports : [];
  if (reports.length < 2) {
    container.innerHTML =
      '<div class="empty-state-block">Run at least two analysis reports before building comparisons.</div>';
    legacyRenderComparisonResultCards();
    return;
  }

  if (!state.analysis.comparisonLinks.length) {
    state.analysis.comparisonLinks = [createComparisonLink(0)];
  }

  container.innerHTML = state.analysis.comparisonLinks
    .map((link, index) => {
      const metricText = readComparisonMetricColumns(link).join(", ");
      const options = reports
        .map((report) => {
          const selectedA = report.id === link.reportAId ? " selected" : "";
          const selectedB = report.id === link.reportBId ? " selected" : "";
          const label = `${getAnalysisReportDisplayName(report)} (${report.status || "complete"}, ${getAnalysisReportRowCount(report)} rows)`;
          return {
            a: `<option value="${esc(report.id)}"${selectedA}>${esc(label)}</option>`,
            b: `<option value="${esc(report.id)}"${selectedB}>${esc(label)}</option>`,
          };
        });

      return `
        <article class="analysis-pull-card" data-comparison-id="${esc(link.id)}">
          <div class="analysis-pull-head">
            <div class="analysis-pull-title-row">
              <div>
                <span class="field-label">Comparison ${index + 1}</span>
                <strong>${esc(link.comparisonName || link.label || `Comparison ${index + 1}`)}</strong>
              </div>
              <button class="secondary-button table-action-button" data-action="remove-comparison-link" data-comparison-id="${esc(link.id)}">Remove</button>
            </div>
          </div>
          <div class="analysis-pull-grid">
            <div class="field-stack">
              <label class="field-label">Comparison Name</label>
              <input class="field-input" data-comparison-field="comparisonName" data-comparison-id="${esc(link.id)}" type="text" value="${esc(link.comparisonName || link.label || `Comparison ${index + 1}`)}" placeholder="Enter comparison name" />
            </div>
            <div class="field-stack">
              <label class="field-label">First Report</label>
              <select class="field-input" data-comparison-field="reportAId" data-comparison-id="${esc(link.id)}">
                <option value="">Select first report</option>
                ${options.map((option) => option.a).join("")}
              </select>
            </div>
            <div class="field-stack">
              <label class="field-label">Second Report</label>
              <select class="field-input" data-comparison-field="reportBId" data-comparison-id="${esc(link.id)}">
                <option value="">Select second report</option>
                ${options.map((option) => option.b).join("")}
              </select>
            </div>
            <div class="field-stack">
              <label class="field-label">Match Field</label>
              <input class="field-input" data-comparison-field="matchField" data-comparison-id="${esc(link.id)}" type="text" value="${esc(link.matchField || "SCF Grouping")}" />
            </div>
            <div class="field-stack analysis-pull-wide">
              <label class="field-label">Metrics to Compare</label>
              <input class="field-input" data-comparison-field="metricColumns" data-comparison-id="${esc(link.id)}" type="text" value="${esc(metricText)}" placeholder="Sum of Mailed, Sum of Converted, Sold Rate, In Force Rate, Converted Rate" />
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  legacyRenderComparisonResultCards();
}

function legacyRenderAnalysisComparisonReviewPanel() {
  const select = el("analysis-comparison-select");
  if (!select) {
    legacyRenderComparisonResultCards();
    return;
  }

  const results = Array.isArray(state.analysis.comparisonResults)
    ? state.analysis.comparisonResults
    : [];

  select.innerHTML = "";
  select.appendChild(new Option("Select a comparison", ""));
  results.forEach((comparison, index) => {
    select.appendChild(
      new Option(
        comparison.comparisonName || `${comparison.reportALabel || "Comparison"} vs ${comparison.reportBLabel || index + 1}`,
        comparison.id
      )
    );
  });

  if (results.some((comparison) => comparison.id === state.analysis.selectedComparisonId)) {
    select.value = state.analysis.selectedComparisonId;
  } else {
    state.analysis.selectedComparisonId = results[0]?.id || "";
    select.value = state.analysis.selectedComparisonId;
  }

  legacyRenderComparisonResultCards();
}

function getAvailableAnalysisReports() {
  const reports = Array.isArray(state.analysis.savedReports) ? state.analysis.savedReports : [];
  return reports.map((report) => {
    const rowCount = Number(
      report.input_row_count ||
      report.inputRowCount ||
      report.result_count ||
      report.resultCount ||
      report.export_row_count ||
      report.exportRowCount ||
      0
    );
    const rawStatus = String(report.status || "").trim().toLowerCase();
    const keyCodeGroup = getAnalysisReportKeyCodeGroup(report);
    let status = "not_imported";
    if (rawStatus === "complete") {
      status = rowCount > 0 ? "ready" : "missing_data";
    } else if (rawStatus === "failed") {
      status = "error";
    } else if (rawStatus) {
      status = "missing_data";
    }

    return {
      id: String(report.id || "").trim(),
      name: String(getAnalysisReportDisplayName(report) || report.id || "Untitled report").trim(),
      report_name: String(report.report_name || report.reportName || "").trim(),
      reportName: String(report.reportName || report.report_name || "").trim(),
      salesforceReportId: String(report.parameters?.report_id || "").trim(),
      category: keyCodeGroup || String(report.parameters?.client_type || report.report_type || report.reportType || "").trim(),
      keyCodeGroup,
      key_code_group: keyCodeGroup,
      clientType: String(report.clientType || report.parameters?.clientType || "").trim(),
      client_type: String(report.client_type || report.parameters?.client_type || "").trim(),
      parameters: report.parameters || {},
      importedAt: report.created_at || report.createdAt || null,
      rowCount,
      status,
      statusLabel: status.replace(/_/g, " "),
      message:
        String(report.error_message || report.errorMessage || report.results_summary || report.resultsSummary || "").trim(),
    };
  });
}

function getAvailableAnalysisReportMap() {
  return new Map(getAvailableAnalysisReports().map((report) => [report.id, report]));
}

function getAnalysisReportRowCount(report = {}) {
  return Number(
    report.input_row_count ||
    report.inputRowCount ||
    report.result_count ||
    report.resultCount ||
    report.export_row_count ||
    report.exportRowCount ||
    0
  );
}

function setComparisonSetupNextButtonsDisabled(disabled) {
  ["analysis-home-next-button", "complete-comparison-setup-button"].forEach((id) => {
    const button = el(id);
    if (button) {
      button.disabled = Boolean(disabled);
    }
  });
}

function validateAnalysisComparisonSetup() {
  const errorsById = {};
  const summaryErrors = [];
  const reports = getAvailableAnalysisReports();
  const reportMap = new Map(reports.map((report) => [report.id, report]));
  const availableReportIds = new Set(reports.map((report) => String(report.id || "").trim()).filter(Boolean));
  const readyReports = reports.filter((report) => report.status === "ready");
  const links = Array.isArray(state.analysis.comparisonLinks) ? state.analysis.comparisonLinks : [];

  if (readyReports.length < 2) {
    summaryErrors.push("At least two ready reports are required to build a comparison.");
  }

  if (!links.length) {
    summaryErrors.push("At least one comparison is required.");
  }

  links.forEach((link, index) => {
    const errors = [];
    const selectedIds = pruneComparisonSelectedReportIds(link, availableReportIds);

    if (selectedIds.length < 2) {
      errors.push("Select 2 to 5 reports for this comparison.");
    }

    if (selectedIds.length > 5) {
      errors.push("A comparison can include up to 5 reports.");
    }

    const derivedKeyCodeGroup = deriveComparisonKeyCodeGroupFromReportIds(selectedIds);
    if (selectedIds.length >= 2 && derivedKeyCodeGroup === "MIXED") {
      errors.push("Select reports from only one key code list for each comparison.");
    } else if (selectedIds.length >= 2 && !derivedKeyCodeGroup) {
      errors.push("Selected reports must have an NHCL or RFC key code list.");
    }

    selectedIds.forEach((reportId) => {
      const report = reportMap.get(reportId);
      if (!report) {
        errors.push("One or more selected reports are no longer available.");
        return;
      }
      if (report.status !== "ready") {
        errors.push("Selected reports must be in Ready status.");
      }
    });

    errorsById[link.id] = Array.from(new Set(errors));
  });

  return {
    isValid:
      summaryErrors.length === 0
      && links.length > 0
      && links.every((link) => (errorsById[link.id] || []).length === 0),
    summaryErrors,
    errorsById,
    reports,
  };
}

function renderAvailableReports() {
  const container = el("analysis-available-reports");
  if (!container) return;

  const reports = getAvailableAnalysisReports();
  const readyStatus = el("analysis-ready-report-status");
  const readyCount = reports.filter((report) => report.status === "ready").length;
  if (readyStatus) {
    readyStatus.textContent = reports.length
      ? `${readyCount} ready report${readyCount === 1 ? "" : "s"} available for comparison setup.`
      : "";
  }

  if (!reports.length) {
    container.innerHTML = `
      <div class="empty-state-block">
        No reports have been added to this analysis yet. Go back to the report setup page to add reports.
      </div>
    `;
    return;
  }

  container.innerHTML = reports
    .map((report) => `
      <article class="analysis-report-card">
        <div class="analysis-report-card-head">
          <div>
            <span class="field-label">Available Report</span>
            <strong>${esc(report.name)}</strong>
          </div>
          <span class="analysis-report-status is-${esc(report.status)}">${esc(report.statusLabel)}</span>
        </div>
        <div class="analysis-report-card-meta">
          <span><strong>ID:</strong> ${esc(report.salesforceReportId || "Not available")}</span>
          <span><strong>Type:</strong> ${esc(report.category || "Not available")}</span>
          <span><strong>Created:</strong> ${esc(formatDate(report.importedAt))}</span>
          <span><strong>Rows:</strong> ${Number(report.rowCount || 0)}</span>
        </div>
        ${report.message ? `<p>${esc(report.message)}</p>` : ""}
      </article>
    `)
    .join("");
}

function renderAnalysisSetupHome() {
  const container = el("analysis-comparison-links");
  if (!container) return;
  const readOnly = isCurrentAnalysisReadOnly();

  if (!state.analysis.comparisonLinks.length) {
    state.analysis.comparisonLinks = [createComparisonLink(0)];
  }

  const validation = validateAnalysisComparisonSetup();
  const summary = el("analysis-comparison-validation-summary");
  if (summary) {
    summary.textContent = readOnly
      ? "Completed analyses are read-only. Undo the completion to make changes."
      : validation.summaryErrors.join(" ");
  }

  container.innerHTML = state.analysis.comparisonLinks
    .map((link, index) => {
      const errors = validation.errorsById[link.id] || [];
      const selectedIds = pruneComparisonSelectedReportIds(link);
      logComparisonDebug("render comparison picker", link.id, selectedIds);
      const comparisonName = resolveComparisonName(link.comparisonName || "", index);
      const readyReportCount = validation.reports.filter((report) => report.status === "ready").length;
      const reportCards = validation.reports.length
        ? validation.reports
            .map((report) => {
              const checked = selectedIds.includes(report.id) ? " checked" : "";
              const disabled = readOnly || (report.status !== "ready" && !selectedIds.includes(report.id)) ? " disabled" : "";
              const optionClass = [
                "analysis-report-picker-option",
                selectedIds.includes(report.id) ? "is-selected" : "",
                report.status !== "ready" && !selectedIds.includes(report.id) ? "is-disabled" : "",
              ].filter(Boolean).join(" ");
              return `
                <div
                  class="${optionClass} comparison-report-option"
                  data-comparison-report-option="true"
                  data-comparison-id="${esc(link.id)}"
                  data-report-id="${esc(report.id)}"
                  role="checkbox"
                  aria-checked="${selectedIds.includes(report.id) ? "true" : "false"}"
                  tabindex="${disabled ? "-1" : "0"}"
                >
                  <input
                    type="checkbox"
                    class="comparison-report-checkbox"
                    data-report-checkbox="true"
                    data-comparison-id="${esc(link.id)}"
                    value="${esc(report.id)}"
                    aria-label="Select report ${esc(report.name)}"
                    ${checked}${disabled}
                  />
                  <span class="analysis-report-picker-copy">
                    <strong>${esc(report.name)}</strong>
                    <span>${esc(report.category || "Report")} | ${Number(report.rowCount || 0)} rows | ${esc(report.statusLabel)}</span>
                  </span>
                </div>
              `;
            })
            .join("")
        : `
          <div class="empty-state-block">
            No reports have been added to this analysis yet. Go back to the report setup page to add reports.
          </div>
        `;

      return `
        <article class="analysis-pull-card analysis-comparison-card ${errors.length ? "is-invalid" : ""}" data-comparison-id="${esc(link.id)}">
          <div class="analysis-comparison-card-head">
            <div>
              <span class="field-label">Comparison ${index + 1}</span>
              <strong>${esc(comparisonName)}</strong>
              <p class="analysis-comparison-helper">Choose the reports that should be compared together.</p>
            </div>
            <button class="secondary-button table-action-button" data-action="remove-comparison-link" data-comparison-id="${esc(link.id)}"${readOnly || state.analysis.comparisonLinks.length === 1 ? " disabled" : ""}>Remove Comparison</button>
          </div>
          <div class="analysis-comparison-grid">
            <div class="field-stack">
              <label class="field-label">Comparison Name</label>
              <input class="field-input" data-comparison-field="comparisonName" data-comparison-id="${esc(link.id)}" type="text" value="${esc(comparisonName)}" placeholder="Example: NHCL October vs November"${readOnly ? " disabled" : ""} />
            </div>
            <div class="field-stack analysis-comparison-wide">
              <div class="analysis-comparison-selection-head">
                <div>
                  <span class="field-label">Reports In This Comparison</span>
                  <p class="analysis-selection-count">${selectedIds.length} of 5 selected</p>
                </div>
                <p class="analysis-selection-count">${readyReportCount} ready report pull${readyReportCount === 1 ? "" : "s"} available</p>
              </div>
              <p class="analysis-comparison-helper">Select 2 to 5 reports for this comparison. Only ready report pulls can be added unless they are already selected.</p>
              <div class="analysis-report-picker">
                ${reportCards}
              </div>
            </div>
          </div>
          ${errors.length ? `<p class="analysis-comparison-error">${esc(errors.join(" "))}</p>` : ""}
        </article>
      `;
    })
    .join("");

  if (comparisonDebugEnabled) {
    const existingDebug = el("comparison-debug-log");
    if (!existingDebug) {
      const debugBlock = document.createElement("pre");
      debugBlock.id = "comparison-debug-log";
      debugBlock.className = "analysis-comparison-debug-log";
      container.insertAdjacentElement("afterend", debugBlock);
      comparisonDebugLogContainer = debugBlock;
    } else {
      comparisonDebugLogContainer = existingDebug;
      comparisonDebugLogContainer.textContent = "";
    }
  }

  bindComparisonDebugDocumentLogging(container);
  bindAnalysisComparisonPickerInteractions(container);
  runComparisonDebugAutoTest(container);

  setComparisonSetupNextButtonsDisabled(readOnly || !validation.isValid);

  renderAvailableReports();
}

function toggleComparisonReportSelection(comparisonId, reportId, shouldSelect) {
  if (isCurrentAnalysisReadOnly()) {
    return false;
  }
  const link = state.analysis.comparisonLinks.find((entry) => entry.id === comparisonId);
  if (!link) return false;

  const currentIds = getComparisonSelectedReportIds(link);
  if (shouldSelect) {
    if (currentIds.length >= 5 && !currentIds.includes(reportId)) {
      setStatus("analysis-comparison-status", "A comparison can include up to 5 reports.");
      renderAnalysisSetupHome();
      return false;
    }
    if (!currentIds.includes(reportId)) {
      currentIds.push(reportId);
    }
    setComparisonSelectedReportIds(link, currentIds);
  } else {
    setComparisonSelectedReportIds(
      link,
      currentIds.filter((entry) => entry !== reportId)
    );
  }

  const derivedKeyCodeGroup = deriveComparisonKeyCodeGroupFromReportIds(link.reportIds);
  if (derivedKeyCodeGroup && derivedKeyCodeGroup !== "MIXED") {
    link.keyCodeGroup = derivedKeyCodeGroup;
  }
  state.analysis.lastEditedComparisonId = comparisonId;
  link.updatedAt = new Date().toISOString();
  persistAnalysisSetupDraft();
  renderAnalysisSetupHome();
  scheduleComparisonSetupAutosave({ immediate: true });
  return true;
}

function describeComparisonClickTarget(target) {
  if (!(target instanceof Element)) {
    return null;
  }
  const checkbox = target.closest('[data-report-checkbox="true"]');
  const row = target.closest("[data-comparison-report-option]");
  const rowCheckbox = row?.querySelector('[data-report-checkbox="true"]');
  const targetStyle = window.getComputedStyle(target);
  const rowStyle = row instanceof Element ? window.getComputedStyle(row) : null;
  return {
    tagName: target.tagName,
    className: target.className || "",
    id: target.id || "",
    inputType: target instanceof HTMLInputElement ? target.type : "",
    checked: target instanceof HTMLInputElement ? target.checked : "",
    disabled: target instanceof HTMLInputElement ? target.disabled : "",
    pointerEvents: targetStyle.pointerEvents,
    checkboxReached: checkbox instanceof HTMLInputElement,
    comparisonId: row?.getAttribute("data-comparison-id") || "",
    reportId: row?.getAttribute("data-report-id") || "",
    rowClassName: row instanceof HTMLElement ? row.className : "",
    rowPointerEvents: rowStyle?.pointerEvents || "",
    rowDisabled: rowCheckbox instanceof HTMLInputElement ? rowCheckbox.disabled : "",
  };
}

function bindComparisonDebugDocumentLogging(container) {
  if (!comparisonDebugEnabled || comparisonDebugListenersBound) {
    return;
  }

  const logEvent = (phase, event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!(container instanceof HTMLElement) || !container.contains(target)) {
      return;
    }
    logComparisonDebug(`comparison document ${phase}`, describeComparisonClickTarget(target));
  };

  document.addEventListener("click", (event) => logEvent("click-capture", event), true);
  document.addEventListener("click", (event) => logEvent("click-bubble", event), false);
  comparisonDebugListenersBound = true;
}

function runComparisonDebugAutoTest(container) {
  if (!comparisonDebugEnabled || comparisonDebugAutoTestRan) {
    return;
  }
  comparisonDebugAutoTestRan = true;
  window.setTimeout(() => {
    if (!(container instanceof HTMLElement)) {
      return;
    }
    const firstRow = container.querySelector("[data-comparison-report-option]");
    if (!(firstRow instanceof HTMLElement)) {
      logComparisonDebug("comparison auto test", "no row found");
      return;
    }
    const beforeCount = container.querySelector(".analysis-selection-count")?.textContent || "";
    logComparisonDebug("comparison auto test before", beforeCount, describeComparisonClickTarget(firstRow));
    firstRow.click();
    window.setTimeout(() => {
      const afterCount = el("analysis-comparison-links")?.querySelector(".analysis-selection-count")?.textContent || "";
      logComparisonDebug("comparison auto test after", afterCount);
    }, 0);
  }, 300);
}

function bindAnalysisComparisonPickerInteractions(container) {
  if (!(container instanceof HTMLElement)) {
    return;
  }

  container
    .querySelectorAll("[data-comparison-report-option]")
    .forEach((option) => {
      if (!(option instanceof HTMLElement)) {
        return;
      }

      const checkbox = option.querySelector('[data-report-checkbox="true"]');
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }

      const toggleFromRow = (event) => {
        if (checkbox.disabled) {
          logComparisonDebug("comparison row blocked disabled", describeComparisonClickTarget(event.target));
          return;
        }

        const target = event.target;
        const clickedCheckbox = target instanceof HTMLInputElement && target.hasAttribute("data-report-checkbox");
        if (clickedCheckbox) {
          event.preventDefault();
        }
        const comparisonId = String(checkbox.getAttribute("data-comparison-id") || "").trim();
        const reportId = String(checkbox.value || "").trim();
        if (!comparisonId || !reportId) {
          return;
        }
        const link = state.analysis.comparisonLinks.find((entry) => entry.id === comparisonId);
        const currentlySelected = getComparisonSelectedReportIds(link).includes(reportId);
        const nextSelectedIds = currentlySelected
          ? getComparisonSelectedReportIds(link).filter((entry) => entry !== reportId)
          : [...getComparisonSelectedReportIds(link), reportId].slice(0, 5);
        logComparisonDebug(
          "comparison report row clicked",
          comparisonId,
          reportId,
          currentlySelected,
          nextSelectedIds
        );
        toggleComparisonReportSelection(comparisonId, reportId, !currentlySelected);
      };

      option.addEventListener("click", toggleFromRow);
      option.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        toggleFromRow(event);
      });
    });
}

function refreshAnalysisSetupValidationUi() {
  const validation = validateAnalysisComparisonSetup();
  const summary = el("analysis-comparison-validation-summary");
  if (summary) {
    summary.textContent = validation.summaryErrors.join(" ");
  }
  setComparisonSetupNextButtonsDisabled(!validation.isValid);
}

function hydrateComparisonLinksFromDom() {
  const homePanel = el("analysis-home-panel");
  if (!homePanel) {
    return;
  }

  const availableReportIds = new Set(
    getAvailableAnalysisReports().map((report) => String(report.id || "").trim()).filter(Boolean)
  );

  const comparisonCards = Array.from(
    homePanel.querySelectorAll("[data-comparison-id]")
  );

  comparisonCards.forEach((card) => {
    const comparisonId = String(card.getAttribute("data-comparison-id") || "").trim();
    if (!comparisonId) {
      return;
    }

    const link = state.analysis.comparisonLinks.find((entry) => entry.id === comparisonId);
    if (!link) {
      return;
    }

    const nameInput = card.querySelector('[data-comparison-field="comparisonName"]');
    if (nameInput instanceof HTMLInputElement) {
      link.comparisonName = String(nameInput.value || "").trim();
    }

    const selectedIdsFromDom = Array.from(
      card.querySelectorAll('[data-report-checkbox="true"]:checked')
    )
      .map((input) => (input instanceof HTMLInputElement ? String(input.value || "").trim() : ""))
      .filter((reportId) => Boolean(reportId) && availableReportIds.has(reportId));

    const selectedIds = selectedIdsFromDom.length
      ? selectedIdsFromDom
      : getComparisonSelectedReportIds(link).filter((reportId) => availableReportIds.has(reportId));
    setComparisonSelectedReportIds(link, selectedIds);
    const derivedKeyCodeGroup = deriveComparisonKeyCodeGroupFromReportIds(selectedIds);
    if (derivedKeyCodeGroup && derivedKeyCodeGroup !== "MIXED") {
      link.keyCodeGroup = derivedKeyCodeGroup;
    }
  });
}

function renderAnalysisComparePanel() {
  renderAnalysisSetupHome();
}

function renderReviewSummaryRows(title, rows) {
  if (!rows.length) {
    return `
      <article class="panel analysis-review-summary-card">
        <h4>${esc(title)}</h4>
        <p class="analysis-review-summary-empty">No items.</p>
      </article>
    `;
  }

  return `
    <article class="panel analysis-review-summary-card">
      <h4>${esc(title)} (${rows.length})</h4>
      <div class="analysis-review-summary-list analysis-review-summary-list-rows">
        ${rows
          .map((entry) => `
            <div class="analysis-review-summary-row-item">
              <strong>${esc(entry.scf)}</strong>${entry.state ? ` <span>${esc(entry.state)}</span>` : ""}${entry.reason ? ` <span class="analysis-review-summary-reason">${esc(entry.reason)}</span>` : ""}
            </div>
          `)
          .join("")}
      </div>
    </article>
  `;
}

function renderReviewSummaryPrintListMarkup(title, rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) {
    return `
      <section class="analysis-print-section">
        <h2>${esc(title)}</h2>
        <p>No items.</p>
      </section>
    `;
  }

  return `
    <section class="analysis-print-section">
      <h2>${esc(title)} (${normalizedRows.length})</h2>
      <table class="analysis-print-table">
        <thead>
          <tr>
            <th>SCF</th>
            <th>State</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${normalizedRows
            .map((entry) => `
              <tr>
                <td>${esc(entry?.scf || "")}</td>
                <td>${esc(entry?.state || "")}</td>
                <td>${esc(entry?.reason || "")}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

function buildAnalysisReviewPrintWindowDocument() {
  const cleanupSummary = buildWorkingCopyCleanupSummary();
  const summary = mergeWorkingCopyCleanupIntoSummary(getEffectiveComparisonReviewSummary(), cleanupSummary);
  const listSummary = summary.lists || {};
  const nhcl = listSummary.nhcl || { added: [], removed: [], blocked: [] };
  const rfc = listSummary.rfc || { added: [], removed: [], blocked: [] };
  const reviewerName = String(state.analysis.reviewCompletedByName || "").trim();
  const reviewerDate = normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate();
  const reviewNotes = getEffectiveAnalysisReviewNotes();
  const runNotes = String(summary.runNotes || state.analysis.runNotes || "").trim();
  const analysisName = String(state.analysis.runName || "Analysis Review").trim() || "Analysis Review";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(analysisName)} Print Summary</title>
  <style>
    body {
      font-family: Georgia, "Times New Roman", serif;
      margin: 24px;
      color: #1f1a17;
      line-height: 1.35;
    }
    h1, h2, h3 {
      margin: 0 0 8px;
    }
    h1 {
      font-size: 28px;
    }
    h2 {
      font-size: 18px;
      margin-top: 22px;
    }
    p {
      margin: 6px 0;
    }
    .analysis-print-meta,
    .analysis-print-counts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 18px;
      margin-top: 14px;
    }
    .analysis-print-counts {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .analysis-print-card {
      border: 1px solid #d8c9b8;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 16px;
      break-inside: avoid;
    }
    .analysis-print-section {
      margin-top: 18px;
      break-inside: avoid;
    }
    .analysis-print-notes {
      white-space: pre-wrap;
    }
    .analysis-print-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 14px;
    }
    .analysis-print-table th,
    .analysis-print-table td {
      border: 1px solid #d8c9b8;
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    .analysis-print-table th {
      background: #f5efe7;
    }
    @media print {
      body {
        margin: 12px;
      }
    }
  </style>
</head>
<body>
  <h1>${esc(analysisName)}</h1>
  <p>Printed ${esc(formatDate(new Date().toISOString()))}</p>

  <section class="analysis-print-card">
    <h2>Summary</h2>
    <div class="analysis-print-meta">
      <p><strong>Reviewer:</strong> ${esc(reviewerName || "Not set")}</p>
      <p><strong>Date:</strong> ${esc(formatDateOnly(reviewerDate) || reviewerDate || "Not set")}</p>
    </div>
    <div class="analysis-print-counts">
      <p><strong>NHCL Added:</strong> ${Number(summary.summary?.nhclAdded || 0)}</p>
      <p><strong>NHCL Removed:</strong> ${Number(summary.summary?.nhclRemoved || 0)}</p>
      <p><strong>RFC Added:</strong> ${Number(summary.summary?.rfcAdded || 0)}</p>
      <p><strong>RFC Removed:</strong> ${Number(summary.summary?.rfcRemoved || 0)}</p>
      <p><strong>Blocked Additions:</strong> ${Number(summary.summary?.blockedCount || 0)}</p>
    </div>
  </section>

  ${runNotes
    ? `<section class="analysis-print-card"><h2>Run Notes</h2><div class="analysis-print-notes">${esc(runNotes)}</div></section>`
    : ""}
  ${reviewNotes
    ? `<section class="analysis-print-card"><h2>Review Notes</h2><div class="analysis-print-notes">${esc(reviewNotes)}</div></section>`
    : ""}
  ${cleanupSummary?.entries?.length
    ? `<section class="analysis-print-card"><h2>Working Copy Cleanup Summary</h2><div class="analysis-print-notes">${esc(cleanupSummary.entries.map((entry) => {
        const parts = [
          entry.message,
          entry.comparisonName,
          entry.primaryReportName,
          entry.fieldUsed ? `Field: ${entry.fieldUsed}` : "",
          entry.checkedCount ? `Rows checked: ${entry.checkedCount}` : "",
          `Rows removed: ${entry.removedCount || 0}`,
          `Mailed removed: ${entry.totalMailedRemoved || 0}`,
          entry.scfs.length ? `SCFs: ${entry.scfs.join(", ")}` : "",
        ].filter(Boolean);
        return parts.join(" | ");
      }).join("\n"))}</div></section>`
    : ""}

  ${renderReviewSummaryPrintListMarkup("NHCL - Added", nhcl.added)}
  ${renderReviewSummaryPrintListMarkup("NHCL - Removed", nhcl.removed)}
  ${renderReviewSummaryPrintListMarkup("RFC - Added", rfc.added)}
  ${renderReviewSummaryPrintListMarkup("RFC - Removed", rfc.removed)}
  ${renderReviewSummaryPrintListMarkup("Blocked Additions", [
    ...(Array.isArray(nhcl.blocked) ? nhcl.blocked : []),
    ...(Array.isArray(rfc.blocked) ? rfc.blocked : []),
  ])}

  <script>
    window.addEventListener("load", () => {
      window.print();
    });
  </script>
</body>
</html>`;
}

function openAnalysisReviewPrintSummary() {
  const printWindow = window.open("", "hpa-analysis-review-print", "width=960,height=1200");
  if (!printWindow) {
    throw new Error("Allow pop-ups to print the review summary.");
  }
  printWindow.document.open();
  printWindow.document.write(buildAnalysisReviewPrintWindowDocument());
  printWindow.document.close();
}

function renderAnalysisComparisonSummaryView() {
  const container = el("analysis-comparison-results");
  const cleanupSummary = buildWorkingCopyCleanupSummary();
  const summary = mergeWorkingCopyCleanupIntoSummary(getEffectiveComparisonReviewSummary(), cleanupSummary);
  const readOnly = isCurrentAnalysisReadOnly();
  const listSummary = summary.lists || {};
  const nhcl = listSummary.nhcl || { added: [], removed: [], blocked: [] };
  const rfc = listSummary.rfc || { added: [], removed: [], blocked: [] };
  const canComplete = !!state.analysis.reviewSummary && !summary.violations?.length;
  const approved = Boolean(state.analysis.reviewSummaryApproved);
  const runNotes = String(summary.runNotes || state.analysis.runNotes || "").trim();
  ensureReviewCompletionFields();
  const reviewerName = String(state.analysis.reviewCompletedByName || "").trim();
  const reviewerDate = normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate();
  const canUndoMostRecent = Boolean(summary.canUndoLatestCompletion);
  const reviewNotesValue = getEffectiveAnalysisReviewNotes();
  const runNotesMarkup = runNotes
    ? `<article class="panel analysis-review-summary-notes-card">
        <h4>Run Notes</h4>
        <p>${esc(runNotes).replace(/\n/g, "<br />")}</p>
      </article>`
    : "";

  container.innerHTML = `
    <section class="analysis-review-shell">
      <article class="panel analysis-summary-heading">
        <div class="analysis-review-toolbar">
          <div>
            <h3>Final Review Summary</h3>
            <p>Review what will be added and removed for NHCL and RFC, confirm the notes, then approve before completing.</p>
          </div>
          <div class="action-row">
            <button id="analysis-review-summary-reset-button" class="secondary-button"${readOnly ? " disabled" : ""}>Reset Analysis</button>
            <button id="analysis-review-summary-print-button" class="secondary-button">Print Summary</button>
            <button id="analysis-review-summary-back-button" class="secondary-button"${readOnly ? " disabled" : ""}>Back to Review</button>
          </div>
        </div>
      </article>

      <article class="panel analysis-review-summary-totals-card">
        <div class="analysis-review-summary-counts">
          <span>NHCL Added: ${Number(summary.summary?.nhclAdded || 0)} </span>
          <span>NHCL Removed: ${Number(summary.summary?.nhclRemoved || 0)} </span>
          <span>RFC Added: ${Number(summary.summary?.rfcAdded || 0)} </span>
          <span>RFC Removed: ${Number(summary.summary?.rfcRemoved || 0)} </span>
          <span>Blocked Additions: ${Number(summary.summary?.blockedCount || 0)} </span>
        </div>
      </article>

      ${runNotesMarkup}
      ${renderWorkingCopyCleanupSummaryCard(cleanupSummary, readOnly)}

      <article class="panel analysis-review-finalize-card">
        <h4>Approval Required Before Completion</h4>
        <p>Complete this analysis only when you confirm the review summary is correct. The Complete Analysis button will stay disabled until this box is checked.</p>
        <label class="analysis-review-summary-approve">
          <input id="analysis-review-summary-approved" type="checkbox" ${approved ? "checked" : ""}${readOnly ? " disabled" : ""} />
          I approve this summary and want to move to completed review.
        </label>
        <div class="analysis-pull-grid">
          <div class="field-stack">
            <label class="field-label" for="analysis-review-completed-by-name">Name</label>
            <input id="analysis-review-completed-by-name" class="field-input" type="text" value="${esc(reviewerName)}" placeholder="Required to complete"${readOnly ? " disabled" : ""} />
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-completed-on-date">Date</label>
            <input id="analysis-review-completed-on-date" class="field-input" type="date" value="${esc(reviewerDate)}"${readOnly ? " disabled" : ""} />
          </div>
        </div>
        <div class="field-stack">
          <label class="field-label" for="analysis-review-summary-notes">Review Notes</label>
          <textarea id="analysis-review-summary-notes" class="field-input multiline-input" rows="3"${readOnly ? " disabled" : ""}>${esc(reviewNotesValue)}</textarea>
        </div>
        ${summary.completedAt
          ? `<p class="analysis-comparison-helper">Completed by ${esc(summary.completedByName || reviewerName || "Unknown")} on ${esc(formatDateOnly(summary.completedOnDate || reviewerDate) || "Not set")}.</p>`
          : ""}
        ${readOnly ? '<p class="analysis-comparison-helper">This completed analysis is locked for review only. Undo the completion to make changes.</p>' : ""}
        ${canUndoMostRecent ? '<button id="undo-latest-comparison-complete-button" class="secondary-button">Undo Most Recent Completion</button>' : ""}
      </article>

      <div class="analysis-review-summary-grid">
        ${renderReviewSummaryRows("NHCL - Added", nhcl.added)}
        ${renderReviewSummaryRows("NHCL - Removed", nhcl.removed)}
        ${renderReviewSummaryRows("RFC - Added", rfc.added)}
        ${renderReviewSummaryRows("RFC - Removed", rfc.removed)}
      </div>
    </section>
  `;

  el("analysis-review-summary-back-button")?.addEventListener("click", () => {
    if (readOnly) {
      return;
    }
    state.analysis.reviewSummaryMode = "review";
    state.analysis.reviewSummaryApproved = false;
    scheduleReviewStateAutosave("summary-back");
    broadcastAnalysisReviewState("summary-back");
    setStatus("analysis-comparison-selection-status", "Reloading comparison review...");
    Promise.all([loadAnalysisReports(), loadReferenceLists()])
      .catch(() => null)
      .finally(() => {
        if (!hasReviewWorkingListSeedData()) {
          ensureComparisonReviewWorkingLists();
        }
        renderAnalysisComparisonReviewPanel();
        scheduleAnalysisComparisonReviewRender(20);
      });
  });

  el("analysis-review-summary-reset-button")?.addEventListener("click", () => {
    if (readOnly) {
      return;
    }
    if (!confirm("Reset this analysis and restore the pending mailing lists back to where they were at the beginning?")) {
      return;
    }
    if (!resetAnalysisWorkingState()) {
      return;
    }
    renderAnalysisComparisonSummaryView();
  });

  el("analysis-review-summary-print-button")?.addEventListener("click", () => {
    try {
      openAnalysisReviewPrintSummary();
      setStatus("analysis-comparison-selection-status", "Opening print summary...");
    } catch (error) {
      setStatus(
        "analysis-comparison-selection-status",
        `Unable to print summary: ${error instanceof Error ? error.message : String(error || "Unknown error")}`
      );
    }
  });

  el("analysis-review-summary-approved")?.addEventListener("change", () => {
    if (readOnly) {
      return;
    }
    const approved = el("analysis-review-summary-approved")?.checked === true;
    state.analysis.reviewSummaryApproved = approved;
    const completeButton = el("complete-comparison-review-button");
    const disableReason = summary.violations?.length;
    if (completeButton) {
      completeButton.disabled = !approved || !!disableReason;
      completeButton.title = disableReason
        ? canComplete
          ? "Approval required to continue."
          : "This summary has blocked Do Not Mail additions. Resolve before completing."
        : "Click to complete this review and save the summary.";
    }
    scheduleReviewStateAutosave("summary-approval");
    broadcastAnalysisReviewState("summary-approval");
  });

  const notesInput = el("analysis-review-summary-notes");
  if (notesInput instanceof HTMLTextAreaElement) {
    notesInput.value = reviewNotesValue;
    notesInput.addEventListener("input", () => {
      if (readOnly) {
        return;
      }
      state.analysis.reviewSummaryNotes = String(notesInput.value || "").trim();
      scheduleReviewStateAutosave("summary-notes");
      broadcastAnalysisReviewState("summary-notes");
    });
  }

  all("[data-zero-rate-undo-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (readOnly) {
        return;
      }
      const actionId = String(button.getAttribute("data-zero-rate-undo-action") || "").trim();
      const restoreResult = restoreZeroRateRemovalAction(actionId);
      scheduleReviewStateAutosave("undo-zero-rate-removal");
      renderAnalysisComparisonReviewPanel();
      broadcastAnalysisReviewState("undo-zero-rate-removal");
      setStatus(
        "analysis-comparison-selection-status",
        restoreResult.restoredCount
          ? `Restored ${restoreResult.restoredCount} SCF(s) to the working mailing list from the zero-rate removal action.`
          : "No pending zero-rate removals were restored."
      );
    });
  });

  const reviewerNameInput = el("analysis-review-completed-by-name");
  if (reviewerNameInput instanceof HTMLInputElement) {
    reviewerNameInput.value = reviewerName;
    reviewerNameInput.addEventListener("input", () => {
      if (readOnly) {
        return;
      }
      state.analysis.reviewCompletedByName = reviewerNameInput.value || "";
      scheduleReviewStateAutosave("summary-reviewer-name");
      broadcastAnalysisReviewState("summary-reviewer-name");
    });
  }

  const reviewerDateInput = el("analysis-review-completed-on-date");
  if (reviewerDateInput instanceof HTMLInputElement) {
    reviewerDateInput.value = reviewerDate;
    reviewerDateInput.addEventListener("input", () => {
      if (readOnly) {
        return;
      }
      state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(reviewerDateInput.value || "") || getTodayIsoDate();
      scheduleReviewStateAutosave("summary-reviewer-date");
      broadcastAnalysisReviewState("summary-reviewer-date");
    });
  }

  const canCompleteMode = !!state.analysis.reviewSummary && !state.analysis.reviewSummary?.violations?.length;
  const summaryCheckbox = el("analysis-review-summary-approved");
  const completeButton = el("complete-comparison-review-button");
  if (completeButton) {
    completeButton.disabled = readOnly || !summaryCheckbox?.checked || !canCompleteMode;
    completeButton.title = canCompleteMode
      ? (summaryCheckbox?.checked ? "Complete this review." : "Check approval before complete.")
      : "Run a summary first and clear blocked Do Not Mail additions before completing.";
  }
}

function renderAnalysisComparisonReviewPanel() {
  const container = el("analysis-comparison-results");
  if (!container) return;
  const detachedWindow = isAnalysisReviewPopupWindow();
  const readOnly = isCurrentAnalysisReadOnly();

  ensureComparisonReviewPanelToolbar();

  if (state.analysis.reviewSummaryMode === "summary") {
    renderAnalysisComparisonSummaryView();
    const canComplete = !!state.analysis.reviewSummary && !state.analysis.reviewSummary?.violations?.length;
    const completeButton = el("complete-comparison-review-button");
    const approvedCheckbox = el("analysis-review-summary-approved");
    if (completeButton) {
      completeButton.disabled = readOnly || !approvedCheckbox?.checked || !canComplete;
      completeButton.title = canComplete
        ? (approvedCheckbox?.checked ? "Complete this review." : "Check approval before complete.")
        : "Run a summary first and clear blocked Do Not Mail additions before completing.";
    }
    const summarizeButton = el("summarize-comparison-review-button");
    if (summarizeButton) summarizeButton.textContent = "Resummarize Review";
    return;
  }
  const completeButton = el("complete-comparison-review-button");
  if (completeButton) {
    completeButton.disabled = true;
  }
  if (recoverComparisonSetupFromWorkspace()) {
    scheduleAnalysisComparisonReviewRender(20);
    return;
  }
  const comparisons = syncComparisonRequestsFromLinks();

  if (!comparisons.length || !hasUsableComparisonSelection(comparisons)) {
    container.innerHTML = '<div class="empty-state-block">No comparisons yet.</div>';
    return;
  }

  if (!hasReviewWorkingListSeedData()) {
    container.innerHTML = '<div class="empty-state-block">Loading current mailing lists for review...</div>';
    void loadReferenceLists()
      .then(() => {
        ensureComparisonReviewWorkingLists();
      })
      .catch(() => null)
      .finally(() => {
        scheduleAnalysisComparisonReviewRender(40);
      });
    return;
  }

  ensureComparisonReviewWorkingLists();
  const context = ensureComparisonReviewSelection();
  if (!context?.comparison) {
    container.innerHTML = '<div class="empty-state-block">No comparisons yet.</div>';
    return;
  }

  const { comparison, reports, primaryReport, primaryRows, selectedScf } = context;
  if (
    primaryReport
    && !reportHasReviewScfData(primaryReport)
    && (!Array.isArray(state.analysis.savedReports) || !state.analysis.savedReports.length)
  ) {
    container.innerHTML = '<div class="empty-state-block">Reloading comparison reports...</div>';
    void loadAnalysisReports()
      .catch(() => null)
      .finally(() => {
        scheduleAnalysisComparisonReviewRender(40);
      });
    return;
  }
  if (
    primaryReport
    && Array.isArray(primaryReport?.rows)
    && primaryReport.rows.length > 0
    && Array.isArray(primaryRows)
    && primaryRows.length === 0
  ) {
    const sampleKeys = Object.keys(primaryReport.rows[0] || {}).slice(0, 8);
    container.innerHTML = `<div class="empty-state-block">Saved report rows were loaded, but no SCF field could be detected for the selected primary report. Sample fields: ${esc(sampleKeys.join(", "))}</div>`;
    console.warn("[analysis-primary-report-debug]", {
      setupId: String(state.analysis.currentSetupId || "").trim(),
      selectedComparisonId: comparison?.id || "",
      selectedPrimaryReportId: primaryReport?.id || "",
      selectedPrimaryReportName: primaryReport?.report_name || primaryReport?.reportName || "",
      savedReportRowCount: primaryReport.rows.length,
      sampleKeys,
    });
    return;
  }
  if (!reports.length || !primaryReport) {
    if (recoverComparisonSetupFromWorkspace()) {
      scheduleAnalysisComparisonReviewRender(20);
      return;
    }
    if (Array.isArray(state.analysis.savedReports) && state.analysis.savedReports.length) {
      container.innerHTML = '<div class="empty-state-block">Saved reports were found, but the comparison setup could not be restored. Go back to Set Up Comparison and save the comparison again.</div>';
      return;
    }
    container.innerHTML = '<div class="empty-state-block">Reloading comparison reports...</div>';
    void loadAnalysisReports()
      .catch(() => null)
      .finally(() => {
        scheduleAnalysisComparisonReviewRender(40);
      });
    return;
  }
  const listType = String(comparison.keyCodeGroup || "NHCL").trim().toUpperCase();
  const targetListType = listType.toLowerCase();
  const selectedPrimaryRow = findReportRowByScf(primaryReport, selectedScf)?.row || null;
  const selectedStateValue = getRowStateValue(selectedPrimaryRow);
  const dnmStatus = getDoNotMailStatusForScf(selectedScf, selectedStateValue);
  const targetListEntry = getWorkingListEntry(targetListType, selectedScf);
  let primaryNavigatorRows = buildPrimaryNavigatorRows(primaryReport);
  let sortedFilteredRows = getSortedFilteredPrimaryRows(primaryNavigatorRows, comparison.id);
  let effectiveSelectedScf = selectedScf && sortedFilteredRows.some((entry) => entry.scf === selectedScf)
    ? selectedScf
    : (sortedFilteredRows[0]?.scf || "");
  let selectedIndex = sortedFilteredRows.findIndex((entry) => entry.scf === effectiveSelectedScf);
  let pagination = getComparisonReviewPagination(sortedFilteredRows.length, selectedIndex);
  const visibleNavigatorScfs = sortedFilteredRows
    .slice(pagination.startIndex, pagination.endIndex)
    .map((entry) => entry.scf);
  primaryNavigatorRows = mergeExactMetricsIntoNavigatorRows(
    primaryNavigatorRows,
    primaryReport,
    [effectiveSelectedScf, ...visibleNavigatorScfs],
    { requestMissing: false }
  );
  logPrimaryNavigatorRateTrace(primaryReport, primaryNavigatorRows);
  requestAnalysisReportScfMetrics(primaryReport?.id, effectiveSelectedScf);
  prefetchAnalysisReportScfMetrics(
    primaryReport,
    visibleNavigatorScfs.filter((scf) => scf && scf !== effectiveSelectedScf)
  );
  sortedFilteredRows = getSortedFilteredPrimaryRows(primaryNavigatorRows, comparison.id);
  effectiveSelectedScf = effectiveSelectedScf && sortedFilteredRows.some((entry) => entry.scf === effectiveSelectedScf)
    ? effectiveSelectedScf
    : (sortedFilteredRows[0]?.scf || "");
  if (effectiveSelectedScf && effectiveSelectedScf !== selectedScf) {
    state.analysis.reviewSelectedScfs[comparison.id] = effectiveSelectedScf;
  }
  const effectiveSelectedPrimaryRow = findReportRowByScf(primaryReport, effectiveSelectedScf)?.row || null;
  const effectiveSelectedStateValue = getRowStateValue(effectiveSelectedPrimaryRow);
  const effectiveDnmStatus = getDoNotMailStatusForScf(effectiveSelectedScf, effectiveSelectedStateValue);
  const effectiveTargetListEntry = getWorkingListEntry(targetListType, effectiveSelectedScf);
  const decisionStatus = getWorkingListDecisionStatus(targetListType, effectiveSelectedScf);
  selectedIndex = sortedFilteredRows.findIndex((entry) => entry.scf === effectiveSelectedScf);
  pagination = getComparisonReviewPagination(sortedFilteredRows.length, selectedIndex);
  const visibleRows = sortedFilteredRows.slice(pagination.startIndex, pagination.endIndex);
  const selectedNavigatorEntry = sortedFilteredRows.find((entry) => entry.scf === effectiveSelectedScf) || null;
  const primaryReportDisplayName = primaryReport ? getAnalysisReportDisplayName(primaryReport) : "the selected primary report";
  const soldRateOperatorValue = normalizeReviewFilterOperator(state.analysis.reviewSoldRateOperator, ">");
  const soldRateMinValue = String(state.analysis.reviewSoldRateMin || "").trim();
  const inForceRateOperatorValue = normalizeReviewFilterOperator(state.analysis.reviewInForceRateOperator, ">");
  const inForceRateValue = String(state.analysis.reviewInForceRateValue || "").trim();
  const convertedRateOperatorValue = normalizeReviewFilterOperator(state.analysis.reviewConvertedRateOperator, "!=");
  const convertedRateValue = String(state.analysis.reviewConvertedRateValue || "").trim();
  const mailedOperatorValue = normalizeReviewFilterOperator(state.analysis.reviewMailedOperator, ">");
  const mailedMinValue = String(state.analysis.reviewMailedMin || "").trim();
  const bulkMetric = String(state.analysis.reviewBulkMetric || "soldRate").trim();
  const bulkThresholdValue = String(state.analysis.reviewBulkThresholdValue || "").trim();
  const selectedNavigatorScfSet = getSelectedNavigatorScfSet();
  const activeNavigatorScfFilterSet = new Set(
    ensureArray(state.analysis.activeNavigatorScfFilter).map((entry) => normalizeScf(entry)).filter(Boolean)
  );
  const hasMetricFilters = Boolean(
    soldRateMinValue
    || inForceRateValue
    || convertedRateValue
    || mailedMinValue
  );
  const activeMetricFilters = [
    soldRateMinValue ? `Sold Rate ${soldRateOperatorValue} ${soldRateMinValue}` : "",
    inForceRateValue ? `In Force Rate ${inForceRateOperatorValue} ${inForceRateValue}` : "",
    convertedRateValue ? `Converted Rate ${convertedRateOperatorValue} ${convertedRateValue}` : "",
    mailedMinValue ? `Mailed ${mailedOperatorValue} ${mailedMinValue}` : "",
  ].filter(Boolean);
  const filterSummaryLabel = hasMetricFilters || activeNavigatorScfFilterSet.size
    ? `Filters active${activeMetricFilters.length ? `: ${activeMetricFilters.join(", ")}` : ""}${activeNavigatorScfFilterSet.size ? `${activeMetricFilters.length ? " | " : ": "}Selected SCFs ${activeNavigatorScfFilterSet.size}` : ""}.`
    : "Showing all SCFs. No navigator filters are active.";
  const bulkPreview =
    state.analysis.reviewBulkPreview &&
    state.analysis.reviewBulkPreview.comparisonId === comparison.id &&
    state.analysis.reviewBulkPreview.listType === targetListType
      ? state.analysis.reviewBulkPreview
      : null;

  const reportMetricsMarkup = reports.map((report) => {
    const rowEntry = findReportRowByScf(report, effectiveSelectedScf);
    const fallbackRow = rowEntry?.row || null;
    const needsExactMetrics = reportNeedsExactScfMetricFetch(report, rowEntry);
    const cachedMetrics = needsExactMetrics
      ? getCachedAnalysisReportScfMetrics(report.id, effectiveSelectedScf)
      : null;
    if (needsExactMetrics && !cachedMetrics) {
      requestAnalysisReportScfMetrics(report.id, effectiveSelectedScf);
    }
    const hasExactMetrics = cachedMetrics?.status === "ready";
    const exactRow = hasExactMetrics ? cachedMetrics.row : null;
    const row = normalizeAnalysisMetricRow(exactRow || fallbackRow);
    const isMetricLoading = needsExactMetrics && cachedMetrics?.status === "loading";
    const hasMetricError = cachedMetrics?.status === "error";
    const totalMailed = row ? getTotalMailedFromRow(row) : "";
    const displayedTotalMailed = formatWholeNumber(totalMailed);
    const foundLabel = !row
      ? "SCF not in this report"
      : exactRow
        ? "SCF found"
      : rowEntry?.source === "export" || rowEntry?.source === "export-aggregate"
        ? "SCF found in report rows"
        : "SCF found";
    const soldRateDisplay = row
      ? getRowMetricDisplayValue(row, "Sold Rate")
      : isMetricLoading
        ? "Loading..."
        : "-";
    const soldCountDisplay = row
      ? formatWholeNumber(getRowMetricValue(row, "Sum of Opp Count"))
      : isMetricLoading
        ? "Loading..."
        : "-";
    const inForceRateDisplay = row
      ? getRowMetricDisplayValue(row, "In Force Rate")
      : isMetricLoading
        ? "Loading..."
        : "-";
    const inForceCountDisplay = row
      ? formatWholeNumber(getRowMetricValue(row, "Sum of In Force"))
      : isMetricLoading
        ? "Loading..."
        : "-";
    const convertedRateDisplay = row
      ? getRowMetricDisplayValue(row, "Converted Rate")
      : isMetricLoading
        ? "Loading..."
        : "-";
    const convertedCountDisplay = row
      ? formatWholeNumber(
          Number.isFinite(Number(row?.appConvertedCount))
            ? Number(row.appConvertedCount)
            : Math.max(
                getRowMetricNumber(row, "Sum of Converted"),
                getRowMetricNumber(row, "Converted"),
                getRowMetricNumber(row, "Sum of Sold")
              )
        )
      : isMetricLoading
        ? "Loading..."
        : "-";
    const cardStatusLabel = !row && isMetricLoading
      ? "Loading exact report metrics..."
      : hasMetricError && row
        ? `${foundLabel} (using saved report metrics)`
        : hasMetricError
          ? "Unable to load exact report metrics"
          : isMetricLoading && row
            ? `${foundLabel} (refreshing exact report metrics)`
            : foundLabel;
    return `
      <article class="analysis-review-metric-card">
        <div class="analysis-review-metric-head">
          <strong>${esc(getAnalysisReportDateRangeLabel(report))}</strong>
          <span>${esc(cardStatusLabel)}</span>
        </div>
        <div class="analysis-review-metric-grid">
          <div>
            <span class="field-label">Sold Rate</span>
            <strong>${esc(soldRateDisplay)}</strong>
          </div>
          <div>
            <span class="field-label">Converted Rate</span>
            <strong>${esc(convertedRateDisplay)}</strong>
          </div>
          <div>
            <span class="field-label">In Force Rate</span>
            <strong>${esc(inForceRateDisplay)}</strong>
          </div>
        </div>
        <div class="analysis-review-metric-grid analysis-review-metric-grid-secondary">
          <div>
            <span class="field-label">Total Mailed</span>
            <strong>${esc(displayedTotalMailed)}</strong>
          </div>
        </div>
      </article>
    `;
  }).join("");

  const actionPrompt = !selectedScf
    ? "Choose an SCF from the primary report to start the review."
    : effectiveDnmStatus.isDoNotMail
      ? `SCF ${effectiveSelectedScf} is on Do Not Mail${effectiveDnmStatus.label ? ` (${effectiveDnmStatus.label})` : ""} and cannot be added to ${listType}.`
      : decisionStatus.code === "pending-add"
        ? `SCF ${effectiveSelectedScf} is pending add to ${listType}.`
      : decisionStatus.code === "pending-remove"
        ? `SCF ${effectiveSelectedScf} is pending removal from ${listType}.`
      : effectiveTargetListEntry
        ? `SCF ${effectiveSelectedScf} is already on ${listType}.`
        : `SCF ${effectiveSelectedScf} is not on ${listType}.`;

  const detachedActionButtons = effectiveTargetListEntry
    ? `
            <button id="analysis-review-remove-button" class="primary-button"${readOnly ? " disabled" : ""}>Remove from ${esc(listType)}</button>
          `
    : `
            <button id="analysis-review-add-button" class="primary-button"${readOnly ? " disabled" : ""}>Add to ${esc(listType)}</button>
          `;

  const actionButtons = effectiveDnmStatus.isDoNotMail
    ? `
          <p>SCF ${esc(effectiveSelectedScf)} is on Do Not Mail${effectiveDnmStatus.label ? ` (${esc(effectiveDnmStatus.label)})` : ""} and cannot be added to ${esc(listType)}.</p>
          <p>No actions are available for Do Not Mail SCFs.</p>
        `
  : detachedWindow
    ? detachedActionButtons
    : `
          ${detachedActionButtons}
          <button id="analysis-review-export-button" class="secondary-button">Export Working ${esc(listType)}</button>
          <button id="analysis-review-restore-button" class="secondary-button"${readOnly ? " disabled" : ""}>Reset Analysis</button>
        `
        ;

  container.innerHTML = `
    <section class="analysis-review-shell analysis-comparison-review-page">
      <section id="analysis-review-floating-panel" class="analysis-review-floating-panel${detachedWindow ? " is-detached-window" : " is-inline-page"}" style="">
      <div id="analysis-review-floating-handle" class="analysis-review-floating-handle">
        <div>
          <span class="field-label">Review Workspace</span>
          <strong>${detachedWindow
            ? "This review is detached in its own browser window. Move the whole window anywhere you want."
            : "Drag this SCF review panel anywhere on the screen."}</strong>
        </div>
        ${detachedWindow ? "" : `
        <div class="action-row">
          <button id="analysis-review-open-window-button" class="secondary-button">Open In New Window</button>
          <button id="analysis-review-floating-reset" class="secondary-button">Reset Position</button>
        </div>
        `}
      </div>
      <section class="analysis-review-sticky-panel">
      <article class="panel analysis-review-toolbar-panel">
        <div class="analysis-review-toolbar">
          <div class="field-stack">
            <label class="field-label" for="analysis-review-comparison-select">Comparison</label>
            <select id="analysis-review-comparison-select" class="field-input">
              ${comparisons.map((entry, index) => `
                <option value="${esc(entry.id)}"${entry.id === comparison.id ? " selected" : ""}>
                  ${esc(getComparisonDisplayName(entry, index))}
                </option>
              `).join("")}
            </select>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-primary-report">Primary Report</label>
            <select id="analysis-review-primary-report" class="field-input">
              ${reports.map((report) => `
                <option value="${esc(report.id)}"${report.id === primaryReport?.id ? " selected" : ""}>
                  ${esc(getAnalysisReportDisplayName(report))}
                </option>
              `).join("")}
            </select>
          </div>
          <div class="analysis-review-callout">
            <span class="field-label">Working Copy Only</span>
            <strong>Nothing on this page writes to the live NHCL, RFC, or DNM lists.</strong>
          </div>
        </div>
      </article>

      ${detachedWindow ? "" : `
      <article class="panel analysis-review-bulk-panel">
        <div class="panel-heading analysis-review-summary-heading">
          <h3>Bulk Remove From Working ${esc(listType)}</h3>
          <p>Only <strong>${esc(primaryReportDisplayName)}</strong> drives this action. Other comparison reports do not affect the removal decision, and live lists are not changed here.</p>
        </div>
        <div class="analysis-review-filter-bar">
          <div class="field-stack">
            <label class="field-label" for="analysis-review-bulk-metric">Remove if below</label>
            <select id="analysis-review-bulk-metric" class="field-input">
              <option value="soldRate"${bulkMetric === "soldRate" ? " selected" : ""}>Sold Rate</option>
              <option value="inForceRate"${bulkMetric === "inForceRate" ? " selected" : ""}>In Force Rate</option>
              <option value="convertedRate"${bulkMetric === "convertedRate" ? " selected" : ""}>Converted Rate</option>
            </select>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-bulk-threshold">Percent</label>
            <input id="analysis-review-bulk-threshold" class="field-input" type="text" inputmode="decimal" value="${esc(bulkThresholdValue)}" placeholder="ex: 2.50 or .025" />
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-bulk-calculate-button">Preview impact</label>
            <button id="analysis-review-bulk-calculate-button" class="secondary-button">Calculate</button>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-bulk-remove-button">Working copy cleanup</label>
            <div class="action-row">
              <button id="analysis-review-bulk-remove-button" class="secondary-button"${bulkPreview ? "" : " disabled"}>Remove Below Threshold</button>
              <button id="analysis-review-bulk-remove-zeroes-button" class="secondary-button">Remove All Zeroes</button>
            </div>
          </div>
        </div>
        <div class="analysis-review-bulk-remove">
          <p>
            ${bulkPreview
              ? bulkPreview.affectedCount > 0
                ? `This will remove ${bulkPreview.affectedCount} of the current ${bulkPreview.currentCount} SCFs in the working ${listType} mailing list at or below ${bulkPreview.parsedThreshold.displayLabel} ${esc(getReviewMetricDisplayName(bulkPreview.metricKey))}.`
                : bulkPreview.matchedCount > 0
                  ? `There are ${bulkPreview.matchedCount} SCFs at or below ${bulkPreview.parsedThreshold.displayLabel} ${esc(getReviewMetricDisplayName(bulkPreview.metricKey))}, but they are already not on the working ${listType} mailing list.`
                  : `There are no SCFs at or below ${bulkPreview.parsedThreshold.displayLabel} ${esc(getReviewMetricDisplayName(bulkPreview.metricKey))} in ${esc(primaryReportDisplayName)}.`
              : "Enter a threshold, then click Calculate to preview how many SCFs would be marked for pending removal."}
          </p>
          <div class="action-row">
            <button id="analysis-review-bulk-cancel-button" class="secondary-button"${bulkPreview ? "" : " disabled"}>Cancel</button>
          </div>
        </div>
      </article>
      `}

      <article class="panel analysis-review-summary-panel">
        <div class="panel-heading analysis-review-summary-heading">
          <h3>SCF Review</h3>
          <p class="analysis-review-current-scf">Current SCF: <strong>${esc(effectiveSelectedScf || "Not selected")}</strong></p>
          <div class="field-stack analysis-review-jump-field">
            <label class="field-label" for="analysis-review-jump-scf">Go To SCF</label>
            <div class="action-row">
              <input id="analysis-review-jump-scf" class="field-input analysis-review-jump-input" type="text" inputmode="numeric" maxlength="3" value="${esc(effectiveSelectedScf || "")}" placeholder="955" />
              <button id="analysis-review-jump-button" class="secondary-button">Open SCF</button>
            </div>
          </div>
        </div>
        <div class="analysis-review-arrow-row">
          <button id="analysis-review-arrow-up" class="secondary-button"${selectedIndex <= 0 ? " disabled" : ""}>↑ Previous SCF</button>
          <button id="analysis-review-arrow-down" class="secondary-button"${selectedIndex < 0 || selectedIndex >= sortedFilteredRows.length - 1 ? " disabled" : ""}>↓ Next SCF</button>
        </div>
        <div class="analysis-review-status-grid">
          <article class="analysis-review-status-card${effectiveDnmStatus.isDoNotMail ? " is-dnm-alert" : ""}">
            <span class="field-label">Do Not Mail</span>
            <strong>${effectiveDnmStatus.isDoNotMail ? "Yes" : "No"}</strong>
            <p>${esc(effectiveDnmStatus.isDoNotMail ? effectiveDnmStatus.label : "This SCF is not blocked by Do Not Mail.")}</p>
          </article>
          <article class="analysis-review-status-card">
            <span class="field-label">${esc(listType)} List</span>
            <strong>${esc(
              decisionStatus.code === "pending-add"
                ? "Pending add"
                : decisionStatus.code === "pending-remove"
                  ? "Pending remove"
                  : effectiveTargetListEntry
                    ? "On list"
                    : "Not on list"
            )}</strong>
            <p>${esc(
              decisionStatus.note
              || (effectiveTargetListEntry
                ? (effectiveTargetListEntry.state || effectiveTargetListEntry.scope || "Included in working export.")
                : `This SCF is not currently on the ${listType} working list.`)
            )}</p>
          </article>
          <article class="analysis-review-status-card">
            <span class="field-label">Action</span>
            <strong>${esc(actionPrompt)}</strong>
            <div class="action-row">
              ${actionButtons}
            </div>
          </article>
        </div>
      </article>

      <article class="panel analysis-review-metrics-panel">
        <div class="panel-heading">
          <h3>Comparison Metrics${comparison?.comparisonName ? ` - ${esc(comparison.comparisonName)}` : ""}</h3>
          <p>Rates for SCF <strong>${esc(effectiveSelectedScf || "Not selected")}</strong> across every report in this comparison.</p>
        </div>
        <div class="analysis-review-metrics-grid">
          ${reportMetricsMarkup}
        </div>
      </article>

      </section>
      </section>

      ${detachedWindow ? "" : `
      <section class="analysis-review-spreadsheet-area">
      <article class="panel analysis-review-primary-panel">
        <div class="panel-heading">
          <h3>Primary Report Navigator</h3>
          <p>${esc(primaryReport ? getAnalysisReportDisplayName(primaryReport) : "No primary report selected")}</p>
          <p><strong>${esc(filterSummaryLabel)}</strong></p>
        </div>
        <div class="analysis-review-filter-bar">
          <div class="field-stack">
            <label class="field-label" for="analysis-review-sold-rate-min">Sold Rate Filter</label>
            <div class="action-row">
              <select id="analysis-review-sold-rate-operator" class="field-input">
                ${[">", ">=", "<", "<=", "=", "!="].map((operator) => `
                  <option value="${operator}"${soldRateOperatorValue === operator ? " selected" : ""}>${operator}</option>
                `).join("")}
              </select>
              <input id="analysis-review-sold-rate-min" class="field-input" type="text" inputmode="decimal" value="${esc(soldRateMinValue)}" placeholder="ex: .6" />
            </div>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-in-force-rate-operator">In Force Rate Filter</label>
            <div class="action-row">
              <select id="analysis-review-in-force-rate-operator" class="field-input">
                ${[">", ">=", "<", "<=", "=", "!="].map((operator) => `
                  <option value="${operator}"${inForceRateOperatorValue === operator ? " selected" : ""}>${operator}</option>
                `).join("")}
              </select>
              <input id="analysis-review-in-force-rate-value" class="field-input" type="text" inputmode="decimal" value="${esc(inForceRateValue)}" placeholder="ex: .6" />
            </div>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-converted-rate-operator">Converted Rate Filter</label>
            <div class="action-row">
              <select id="analysis-review-converted-rate-operator" class="field-input">
                ${[">", ">=", "<", "<=", "=", "!="].map((operator) => `
                  <option value="${operator}"${convertedRateOperatorValue === operator ? " selected" : ""}>${operator}</option>
                `).join("")}
              </select>
              <input id="analysis-review-converted-rate-value" class="field-input" type="text" inputmode="decimal" value="${esc(convertedRateValue)}" placeholder="ex: 0" />
            </div>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-mailed-min">Mailed Filter</label>
            <div class="action-row">
              <select id="analysis-review-mailed-operator" class="field-input">
                ${[">", ">=", "<", "<=", "=", "!="].map((operator) => `
                  <option value="${operator}"${mailedOperatorValue === operator ? " selected" : ""}>${operator}</option>
                `).join("")}
              </select>
              <input id="analysis-review-mailed-min" class="field-input" type="text" inputmode="decimal" value="${esc(mailedMinValue)}" placeholder="ex: 200" />
            </div>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-threshold-clear">Reset Filters</label>
            <button id="analysis-review-threshold-clear" class="secondary-button">Show All SCFs</button>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-page-size">Rows Per Page</label>
            <select id="analysis-review-page-size" class="field-input">
              ${["25", "50", "100", "250", "all"].map((value) => `
                <option value="${value}"${String(pagination.pageSize) === value ? " selected" : ""}>
                  ${value === "all" ? "All rows" : `${value} rows`}
                </option>
              `).join("")}
            </select>
          </div>
        </div>
        <div class="analysis-review-navigator">
          <button id="analysis-review-prev-page" class="secondary-button"${pagination.currentPage <= 1 ? " disabled" : ""}>Previous Page</button>
          <p>
            ${sortedFilteredRows.length
              ? `Page ${pagination.currentPage} of ${pagination.totalPages} | Viewing ${pagination.startIndex + 1}-${Math.min(sortedFilteredRows.length, pagination.endIndex)} of ${sortedFilteredRows.length}`
              : "No SCFs available in this report."}
          </p>
          <button id="analysis-review-next-page" class="secondary-button"${pagination.currentPage >= pagination.totalPages ? " disabled" : ""}>Next Page</button>
        </div>
        <div class="analysis-review-filter-bar">
          <div class="field-stack">
            <label class="field-label" for="analysis-review-page-number">Go To Page</label>
            <input id="analysis-review-page-number" class="field-input" type="number" min="1" max="${pagination.totalPages}" value="${pagination.currentPage}" />
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-page-go">Open Page</label>
            <button id="analysis-review-page-go" class="secondary-button">Go</button>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-prev-scf">SCF Navigation</label>
            <div class="action-row">
              <button id="analysis-review-prev-scf" class="secondary-button"${selectedIndex <= 0 ? " disabled" : ""}>Previous SCF</button>
              <button id="analysis-review-next-scf" class="secondary-button"${selectedIndex < 0 || selectedIndex >= sortedFilteredRows.length - 1 ? " disabled" : ""}>Next SCF</button>
            </div>
          </div>
          <div class="field-stack">
            <label class="field-label" for="analysis-review-apply-selected-filter">Selected SCFs</label>
            <div class="action-row">
              <button id="analysis-review-apply-selected-filter" class="secondary-button"${selectedNavigatorScfSet.size ? "" : " disabled"}>Apply Selected Filter</button>
              <button id="analysis-review-clear-selected-filter" class="secondary-button"${(selectedNavigatorScfSet.size || activeNavigatorScfFilterSet.size) ? "" : " disabled"}>Clear Selected Filter</button>
            </div>
          </div>
        </div>
        <div class="analysis-review-table-meta">
          <span>Primary report SCFs: ${primaryNavigatorRows.length}</span>
          <span>Showing after filter: ${sortedFilteredRows.length}</span>
          <span>Selected SCFs: ${selectedNavigatorScfSet.size}</span>
          <span>Selected filter: ${activeNavigatorScfFilterSet.size ? `${activeNavigatorScfFilterSet.size} SCF(s)` : "Off"}</span>
          <span>Current mailed pieces: ${selectedNavigatorEntry ? selectedNavigatorEntry.mailed.toLocaleString("en-US") : "-"}</span>
        </div>
        <div class="table-wrap analysis-review-primary-table">
          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th class="sortable-column" data-review-sort-key="scf">SCF${state.analysis.reviewTableSort.key === "scf" ? (state.analysis.reviewTableSort.direction === "desc" ? " ↓" : " ↑") : ""}</th>
                <th class="sortable-column" data-review-sort-key="mailed">Mailed${state.analysis.reviewTableSort.key === "mailed" ? (state.analysis.reviewTableSort.direction === "desc" ? " ↓" : " ↑") : ""}</th>
                <th class="sortable-column" data-review-sort-key="soldRate">Sold Rate${state.analysis.reviewTableSort.key === "soldRate" ? (state.analysis.reviewTableSort.direction === "desc" ? " ↓" : " ↑") : ""}</th>
                <th class="sortable-column" data-review-sort-key="inForceRate">In Force Rate${state.analysis.reviewTableSort.key === "inForceRate" ? (state.analysis.reviewTableSort.direction === "desc" ? " ↓" : " ↑") : ""}</th>
                <th class="sortable-column" data-review-sort-key="convertedRate">Converted Rate${state.analysis.reviewTableSort.key === "convertedRate" ? (state.analysis.reviewTableSort.direction === "desc" ? " ↓" : " ↑") : ""}</th>
                <th>Review Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${visibleRows.length ? visibleRows.map((entry) => {
                const rowDecisionStatus = getWorkingListDecisionStatus(targetListType, entry.scf);
                const reviewStatusLabel = rowDecisionStatus.code === "pending-add"
                  ? "Pending add"
                  : rowDecisionStatus.code === "pending-remove"
                    ? "Pending remove"
                    : rowDecisionStatus.workingEntry
                      ? "On working list"
                      : "Not on working list";
                return `
                <tr class="${entry.scf === effectiveSelectedScf ? "is-selected-row" : ""}" data-review-row-scf="${esc(entry.scf)}" tabindex="0">
                  <td><input type="checkbox" data-review-select-scf="${esc(entry.scf)}" ${selectedNavigatorScfSet.has(entry.scf) ? "checked" : ""} /></td>
                  <td>${esc(entry.scf)}</td>
                  <td>${entry.mailed.toLocaleString("en-US")}</td>
                  <td>${esc(getRowMetricDisplayValue(entry.row, "Sold Rate"))}</td>
                  <td>${esc(getRowMetricDisplayValue(entry.row, "In Force Rate"))}</td>
                  <td>${esc(getRowMetricDisplayValue(entry.row, "Converted Rate"))}</td>
                  <td>${esc(reviewStatusLabel)}</td>
                  <td><button class="secondary-button table-action-button" data-review-scf="${esc(entry.scf)}">Open</button></td>
                </tr>
              `;
              }).join("") : `<tr><td colspan="8" class="empty-cell">No SCFs were found in the selected primary report for this filter.</td></tr>`}
            </tbody>
          </table>
        </div>
      </article>
      </section>
      `}
    </section>
  `;

  bindComparisonReviewFloatingPanel();

  el("analysis-review-open-window-button")?.addEventListener("click", () => {
    openComparisonReviewPopup();
  });

  el("analysis-review-comparison-select")?.addEventListener("change", (event) => {
    const nextId = String(event.target.value || "").trim();
    state.analysis.selectedComparisonId = nextId;
    state.analysis.lastEditedComparisonId = nextId;
    state.analysis.selectedNavigatorScfs = [];
    state.analysis.activeNavigatorScfFilter = [];
    state.analysis.reviewPageNumber = 1;
    scheduleReviewStateAutosave("comparison-select");
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("comparison-select");
  });

  el("analysis-review-primary-report")?.addEventListener("change", (event) => {
    const nextReportId = String(event.target.value || "").trim();
    state.analysis.reviewPrimaryReportIds[comparison.id] = nextReportId;
    state.analysis.reviewSelectedScfs[comparison.id] = "";
    state.analysis.selectedNavigatorScfs = [];
    state.analysis.activeNavigatorScfFilter = [];
    state.analysis.reviewPageNumber = 1;
    scheduleReviewStateAutosave("primary-report-select");
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("primary-report-select");
    focusComparisonReviewSummary();
  });

  el("analysis-review-page-size")?.addEventListener("change", (event) => {
    state.analysis.reviewPageSize = normalizeReviewPageSize(event.target.value || 100);
    state.analysis.reviewPageNumber = 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("page-size");
    focusComparisonReviewSummary();
    focusSelectedReviewRow(state.analysis.reviewSelectedScfs[comparison.id] || effectiveSelectedScf);
  });

  el("analysis-review-prev-page")?.addEventListener("click", () => {
    if (pagination.currentPage <= 1) return;
    state.analysis.reviewPageNumber = pagination.currentPage - 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("prev-page");
    focusComparisonReviewSummary();
  });

  el("analysis-review-next-page")?.addEventListener("click", () => {
    if (pagination.currentPage >= pagination.totalPages) return;
    state.analysis.reviewPageNumber = pagination.currentPage + 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("next-page");
    focusComparisonReviewSummary();
  });

  el("analysis-review-page-go")?.addEventListener("click", () => {
    const input = el("analysis-review-page-number");
    const rawValue = input?.value || "1";
    const requestedPage = Math.min(
      pagination.totalPages,
      Math.max(1, Math.floor(Number(rawValue) || 1))
    );
    state.analysis.reviewPageNumber = requestedPage;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("go-page");
    focusComparisonReviewSummary();
  });

  el("analysis-review-page-number")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    el("analysis-review-page-go")?.click();
  });

  el("analysis-review-arrow-up")?.addEventListener("click", () => {
    if (selectedIndex <= 0) return;
    selectComparisonReviewScf(comparison.id, sortedFilteredRows[selectedIndex - 1].scf);
  });

  el("analysis-review-arrow-down")?.addEventListener("click", () => {
    if (selectedIndex < 0 || selectedIndex >= sortedFilteredRows.length - 1) return;
    selectComparisonReviewScf(comparison.id, sortedFilteredRows[selectedIndex + 1].scf);
  });

  const jumpToReviewScf = () => {
    const jumpInput = el("analysis-review-jump-scf");
    const requestedScf = normalizeScf(jumpInput?.value || "");
    if (!requestedScf) {
      setStatus("analysis-comparison-selection-status", "Enter a valid 3-digit SCF to open it.");
      return;
    }
    setStatus(
      "analysis-comparison-selection-status",
      primaryNavigatorRows.some((entry) => entry.scf === requestedScf)
        ? `Reviewing SCF ${requestedScf}.`
        : `SCF ${requestedScf} is not in the current primary report. Showing list and Do Not Mail status.`
    );
    selectComparisonReviewScf(comparison.id, requestedScf);
  };

  el("analysis-review-jump-button")?.addEventListener("click", () => {
    jumpToReviewScf();
  });

  el("analysis-review-jump-scf")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    jumpToReviewScf();
  });

  el("analysis-review-prev-scf")?.addEventListener("click", () => {
    if (selectedIndex <= 0) return;
    selectComparisonReviewScf(comparison.id, sortedFilteredRows[selectedIndex - 1].scf);
  });

  el("analysis-review-next-scf")?.addEventListener("click", () => {
    if (selectedIndex < 0 || selectedIndex >= sortedFilteredRows.length - 1) return;
    selectComparisonReviewScf(comparison.id, sortedFilteredRows[selectedIndex + 1].scf);
  });

  all("[data-review-sort-key]").forEach((header) => {
    header.addEventListener("click", () => {
      const sortKey = String(header.getAttribute("data-review-sort-key") || "").trim();
      if (!sortKey) return;
      const current = state.analysis.reviewTableSort;
    state.analysis.reviewTableSort =
      current.key === sortKey && current.direction === "desc"
        ? { key: sortKey, direction: "asc" }
        : { key: sortKey, direction: "desc" };
    state.analysis.reviewPageNumber = 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("sort-change");
    focusComparisonReviewSummary();
    focusSelectedReviewRow(state.analysis.reviewSelectedScfs[comparison.id] || effectiveSelectedScf);
  });
  });

  const commitNavigatorCompositeFilters = (nextValues = {}) => {
    state.analysis.reviewSoldRateOperator = normalizeReviewFilterOperator(
      nextValues.soldRateOperator ?? state.analysis.reviewSoldRateOperator,
      ">"
    );
    state.analysis.reviewSoldRateMin = String(
      nextValues.soldRateValue ?? state.analysis.reviewSoldRateMin ?? ""
    ).trim();
    state.analysis.reviewInForceRateOperator = normalizeReviewFilterOperator(
      nextValues.inForceRateOperator ?? state.analysis.reviewInForceRateOperator,
      ">"
    );
    state.analysis.reviewInForceRateValue = String(
      nextValues.inForceRateValue ?? state.analysis.reviewInForceRateValue ?? ""
    ).trim();
    state.analysis.reviewConvertedRateOperator = normalizeReviewFilterOperator(
      nextValues.convertedRateOperator ?? state.analysis.reviewConvertedRateOperator,
      "!="
    );
    state.analysis.reviewConvertedRateValue = String(
      nextValues.convertedRateValue ?? state.analysis.reviewConvertedRateValue ?? ""
    ).trim();
    state.analysis.reviewMailedOperator = normalizeReviewFilterOperator(
      nextValues.mailedOperator ?? state.analysis.reviewMailedOperator,
      ">"
    );
    state.analysis.reviewMailedMin = String(
      nextValues.mailedValue ?? state.analysis.reviewMailedMin ?? ""
    ).trim();
    state.analysis.reviewPageNumber = 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("navigator-filter");
    focusComparisonReviewSummary();
    focusSelectedReviewRow(state.analysis.reviewSelectedScfs[comparison.id] || effectiveSelectedScf);
  };

  el("analysis-review-sold-rate-operator")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ soldRateOperator: event.target.value || ">" });
  });

  el("analysis-review-sold-rate-min")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ soldRateValue: event.target.value || "" });
  });

  el("analysis-review-sold-rate-min")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitNavigatorCompositeFilters({ soldRateValue: event.target.value || "" });
  });

  el("analysis-review-in-force-rate-operator")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ inForceRateOperator: event.target.value || ">" });
  });

  el("analysis-review-in-force-rate-value")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ inForceRateValue: event.target.value || "" });
  });

  el("analysis-review-in-force-rate-value")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitNavigatorCompositeFilters({ inForceRateValue: event.target.value || "" });
  });

  el("analysis-review-converted-rate-operator")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ convertedRateOperator: event.target.value || "!=" });
  });

  el("analysis-review-converted-rate-value")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ convertedRateValue: event.target.value || "" });
  });

  el("analysis-review-converted-rate-value")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitNavigatorCompositeFilters({ convertedRateValue: event.target.value || "" });
  });

  el("analysis-review-mailed-operator")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ mailedOperator: event.target.value || ">" });
  });

  el("analysis-review-mailed-min")?.addEventListener("change", (event) => {
    commitNavigatorCompositeFilters({ mailedValue: event.target.value || "" });
  });

  el("analysis-review-mailed-min")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitNavigatorCompositeFilters({ mailedValue: event.target.value || "" });
  });

  el("analysis-review-threshold-clear")?.addEventListener("click", () => {
    state.analysis.reviewSoldRateOperator = ">";
    state.analysis.reviewSoldRateMin = "";
    state.analysis.reviewInForceRateOperator = ">";
    state.analysis.reviewInForceRateValue = "";
    state.analysis.reviewConvertedRateOperator = "!=";
    state.analysis.reviewConvertedRateValue = "";
    state.analysis.reviewMailedOperator = ">";
    state.analysis.reviewMailedMin = "";
    state.analysis.reviewPageNumber = 1;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("navigator-filter-clear");
    focusComparisonReviewSummary();
    focusSelectedReviewRow(state.analysis.reviewSelectedScfs[comparison.id] || effectiveSelectedScf);
  });

  all("[data-review-scf]").forEach((button) => {
    button.addEventListener("click", () => {
      const scf = button.getAttribute("data-review-scf");
      if (!scf) return;
      selectComparisonReviewScf(comparison.id, scf, { preservePage: true });
    });
  });

  all("[data-review-row-scf]").forEach((row) => {
    row.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-review-scf], [data-review-select-scf]")) {
        return;
      }
      const scf = row.getAttribute("data-review-row-scf");
      if (!scf) return;
      selectComparisonReviewScf(comparison.id, scf, { preservePage: true });
    });

    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-review-select-scf]")) {
        return;
      }
      event.preventDefault();
      const scf = row.getAttribute("data-review-row-scf");
      if (!scf) return;
      selectComparisonReviewScf(comparison.id, scf, { preservePage: true });
    });
  });

  all("[data-review-select-scf]").forEach((input) => {
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    input.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      const scf = String(target.getAttribute("data-review-select-scf") || "").trim();
      toggleSelectedNavigatorScf(scf, target.checked);
      renderAnalysisComparisonReviewPanel();
      console.info("[analysis-navigator-filter]", {
        action: "select",
        scf: normalizeScf(scf),
        checked: target.checked,
        selectedCount: ensureArray(state.analysis.selectedNavigatorScfs).length,
      });
    });
  });

  el("analysis-review-apply-selected-filter")?.addEventListener("click", () => {
    applySelectedNavigatorFilter();
    renderAnalysisComparisonReviewPanel();
  });

  el("analysis-review-clear-selected-filter")?.addEventListener("click", () => {
    clearSelectedNavigatorFilter();
    renderAnalysisComparisonReviewPanel();
  });

  el("analysis-review-bulk-metric")?.addEventListener("change", (event) => {
    state.analysis.reviewBulkMetric = String(event.target.value || "soldRate").trim();
    state.analysis.reviewBulkPreview = null;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("bulk-metric");
  });

  const commitBulkThresholdValue = (rawValue) => {
    state.analysis.reviewBulkThresholdValue = String(rawValue || "").trim();
    if (state.analysis.reviewBulkPreview) {
      state.analysis.reviewBulkPreview = null;
      renderAnalysisComparisonReviewPanel();
    }
    broadcastAnalysisReviewState("bulk-threshold");
  };

  el("analysis-review-bulk-threshold")?.addEventListener("change", (event) => {
    commitBulkThresholdValue(event.target.value || "");
  });

  el("analysis-review-bulk-threshold")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitBulkThresholdValue(event.target.value || "");
  });

  el("analysis-review-bulk-calculate-button")?.addEventListener("click", () => {
    const thresholdRaw = String(state.analysis.reviewBulkThresholdValue || "").trim();
    const preview = calculateWorkingListEntriesBelowRatePreview(
      targetListType,
      primaryNavigatorRows,
      state.analysis.reviewBulkMetric,
      thresholdRaw
    );
    if (!preview) {
      setStatus(
        "analysis-comparison-selection-status",
        `Enter a valid percent to calculate removals from the working ${listType} list.`
      );
      return;
    }

    state.analysis.reviewBulkPreview = {
      ...preview,
      comparisonId: comparison.id,
    };
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("bulk-calculate");
    setStatus(
      "analysis-comparison-selection-status",
      preview.affectedCount > 0
        ? `Calculated bulk removal preview: ${preview.affectedCount} of ${preview.currentCount} SCF(s) would be marked for pending removal.`
        : preview.matchedCount > 0
          ? `Calculated bulk removal preview: ${preview.matchedCount} SCF(s) match the threshold, but they are already not on the working ${listType} list.`
          : `Calculated bulk removal preview: no SCFs in ${primaryReportDisplayName} are at or below the selected threshold.`
    );
  });

  el("analysis-review-bulk-remove-button")?.addEventListener("click", () => {
    const preview = state.analysis.reviewBulkPreview;
    if (!preview || preview.comparisonId !== comparison.id || preview.listType !== targetListType) {
      setStatus(
        "analysis-comparison-selection-status",
        "Click Calculate first so you can review the impact before removing SCFs."
      );
      return;
    }

    const removalResult = removeWorkingListEntriesBelowRate(
      targetListType,
      primaryNavigatorRows,
      preview.metricKey,
      preview.thresholdValue
    );
    const metricLabel = getReviewMetricDisplayName(preview.metricKey);
    const thresholdLabel = preview.parsedThreshold.displayLabel;
    appendAnalysisReviewNote(
      removalResult.removedCount
        ? `Bulk removal decision: marked ${removalResult.removedCount} ${listType} SCF(s) below ${thresholdLabel} ${metricLabel} for pending removal using ${primaryReportDisplayName} only.`
        : preview.matchedCount > 0
          ? `Bulk removal decision: reviewed ${listType} SCFs at or below ${thresholdLabel} ${metricLabel} using ${primaryReportDisplayName} only; matching SCFs were already not on the working list.`
          : `Bulk removal decision: reviewed ${listType} SCFs at or below ${thresholdLabel} ${metricLabel} using ${primaryReportDisplayName} only; no matching items were found.`
    );
    invalidateComparisonReviewSummary();
    state.analysis.reviewBulkPreview = null;

    scheduleReviewStateAutosave("bulk-remove");
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("bulk-remove");
    setStatus(
      "analysis-comparison-selection-status",
      removalResult.removedCount
        ? `${removalResult.removedCount} SCF(s) were marked for pending removal from the working ${listType} list for falling at or below ${thresholdLabel} ${metricLabel} in ${primaryReportDisplayName} only. They remain visible in the review list.`
        : preview.matchedCount > 0
          ? `Matching SCFs at or below ${thresholdLabel} ${metricLabel} were already not on the working ${listType} list, so nothing else was removed.`
          : `No SCFs in ${primaryReportDisplayName} matched the selected at-or-below ${thresholdLabel} ${metricLabel} threshold.`
    );
  });

  el("analysis-review-bulk-remove-zeroes-button")?.addEventListener("click", () => {
    try {
      setStatus("analysis-comparison-selection-status", "Checking zero-value SCFs...");
      if (!comparison?.id) {
        setStatus("analysis-comparison-selection-status", "Choose a comparison before removing zero-value SCFs.");
        return;
      }
      if (!primaryReport?.id) {
        setStatus("analysis-comparison-selection-status", "Select a primary report before removing zero-value SCFs.");
        return;
      }
      const metricKey = String(state.analysis.reviewBulkMetric || "soldRate").trim();
      const metricLabel = getReviewMetricDisplayName(metricKey);
      const removalResult = removeWorkingListEntriesAtZeroRate(
        targetListType,
        primaryNavigatorRows,
        metricKey
      );
      const diagnostics = removalResult.diagnostics || {};
      const checkedField = String(diagnostics.zeroRemovalFieldUsed || "").trim();
      const checkedRowCount = Number(diagnostics.totalReportRowsChecked || 0);
      const zeroCandidateCount = Number(diagnostics.zeroRemovalCandidateCount || 0);
      const onWorkingListCount = Number(diagnostics.zeroRemovalOnWorkingListCount || 0);
      const alreadyOffListCount = Number(diagnostics.zeroRemovalAlreadyOffListCount || 0);
      const alreadyDnmCount = Number(diagnostics.zeroRemovalAlreadyDnmCount || 0);
      const lastResultMessage = !checkedField
        ? `Could not remove zeroes because ${metricLabel} was not available.`
        : removalResult.removedCount
          ? `Removed ${removalResult.removedCount} zero-value SCF(s) from the working copy using ${checkedField}.`
          : zeroCandidateCount > 0
            ? `Checked ${checkedRowCount} SCFs using ${checkedField}. Found ${zeroCandidateCount} zero-value SCF(s); ${onWorkingListCount} were on the working list, ${alreadyOffListCount} were already off the working list, and ${alreadyDnmCount} were already DNM.`
            : `Checked ${checkedRowCount} SCFs using ${checkedField}. No zero-value SCFs found.`;
      state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics({
        ...diagnostics,
        setupId: String(state.analysis.currentSetupId || "").trim(),
        comparisonName: getComparisonDisplayName(comparison),
        selectedPrimaryReportId: String(primaryReport?.id || "").trim(),
        resolvedSavedReportId: String(primaryReport?.id || "").trim(),
        zeroRemovalLastResult: {
          status: !checkedField ? "error" : removalResult.removedCount ? "removed" : "checked",
          removedCount: Number(removalResult.removedCount || 0),
          totalMailedRemoved: Number(removalResult.totalMailedRemoved || 0),
          message: lastResultMessage,
          checkedAt: new Date().toISOString(),
        },
      });
      console.info("[analysis-zero-rate-removal]", {
        setupId: String(state.analysis.currentSetupId || "").trim(),
        selectedComparisonId: comparison.id,
        selectedComparisonName: getComparisonDisplayName(comparison),
        selectedPrimaryReportId: primaryReport.id,
        resolvedSavedReportId: primaryReport.id,
        selectedPrimaryReportName: primaryReportDisplayName,
        listType: targetListType,
        removalKind: "zero-metric",
        selectedCleanupMetricLabel: metricLabel,
        selectedCleanupMetricKey: metricKey,
        totalScfsChecked: checkedRowCount,
        metricFieldUsed: checkedField,
        zeroMetricScfsFound: removalResult.foundZeroRateScfs,
        zeroValueCount: Number(diagnostics.zeroValueCount || 0),
        blankOrNullCount: Number(diagnostics.blankOrNullCount || 0),
        nonNumericCount: Number(diagnostics.nonNumericCount || 0),
        zeroRemovalSampleRows: diagnostics.zeroRemovalSampleRows || [],
        skippedAlreadyNotOnWorkingList: removalResult.skippedAlreadyRemovedScfs,
        skippedAlreadyDnm: removalResult.skippedDnmScfs,
        removedScfs: removalResult.removedScfs,
        totalMailedRemoved: removalResult.totalMailedRemoved,
      });
      console.info("[analysis-zero-rate-removal-sample]", {
        setupId: String(state.analysis.currentSetupId || "").trim(),
        selectedComparisonId: comparison.id,
        selectedPrimaryReportId: primaryReport.id,
        selectedCleanupMetricLabel: metricLabel,
        selectedCleanupMetricKey: metricKey,
        totalZeroCandidatesFound: zeroCandidateCount,
        firstCheckedRows: ensureArray(diagnostics.zeroRemovalSampleRows || []).slice(0, 20),
      });
      if (checkedField && removalResult.removedCount > 0) {
        recordZeroRateRemovalAction({
          comparisonId: comparison.id,
          comparisonName: getComparisonDisplayName(comparison),
          primaryReportId: primaryReport.id,
          primaryReportName: primaryReportDisplayName,
          listType: targetListType,
          removalKind: "zero-metric",
          metricKey,
          fieldUsed: checkedField,
          checkedCount: removalResult.checkedCount,
          totalMailedRemoved: removalResult.totalMailedRemoved,
          removedScfs: removalResult.removedScfs,
          foundZeroRateScfs: removalResult.foundZeroRateScfs,
          skippedAlreadyRemovedScfs: removalResult.skippedAlreadyRemovedScfs,
          skippedDnmScfs: removalResult.skippedDnmScfs,
        });
      }
      appendAnalysisReviewNote(
        !checkedField
          ? `Bulk removal decision: could not remove zero-value ${listType} SCFs because ${metricLabel} was not available in ${primaryReportDisplayName}.`
          : removalResult.removedCount
            ? `Bulk removal decision: marked ${removalResult.removedCount} ${listType} SCF(s) with 0 ${checkedField} for pending removal using ${primaryReportDisplayName} only.`
            : zeroCandidateCount > 0
              ? `Bulk removal decision: checked ${checkedRowCount} ${listType} SCF(s) using ${checkedField} in ${primaryReportDisplayName}; found ${zeroCandidateCount} zero-value SCF(s), with ${onWorkingListCount} on the working list, ${alreadyOffListCount} already off the working list, and ${alreadyDnmCount} already DNM.`
              : `Bulk removal decision: checked ${checkedRowCount} ${listType} SCF(s) using ${checkedField} in ${primaryReportDisplayName}; no zero-value SCFs were found.`
      );
      invalidateComparisonReviewSummary();
      state.analysis.reviewBulkPreview = null;
      scheduleReviewStateAutosave("bulk-remove-zeroes");
      renderAnalysisComparisonReviewPanel();
      broadcastAnalysisReviewState("bulk-remove-zeroes");
      setStatus("analysis-comparison-selection-status", lastResultMessage);
    } catch (error) {
      console.error("[analysis-zero-rate-removal-error]", error);
      setStatus(
        "analysis-comparison-selection-status",
        `Remove All Zeroes failed: ${error instanceof Error ? error.message : String(error || "Unknown error")}`
      );
    }
  });

  el("analysis-review-bulk-cancel-button")?.addEventListener("click", () => {
    state.analysis.reviewBulkPreview = null;
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("bulk-cancel");
    setStatus("analysis-comparison-selection-status", "Bulk removal preview canceled.");
  });

  el("analysis-review-add-button")?.addEventListener("click", () => {
    if (!effectiveSelectedScf) return;
    if (effectiveDnmStatus.isDoNotMail) {
      setStatus(
        "analysis-comparison-selection-status",
        `SCF ${effectiveSelectedScf} is on Do Not Mail and cannot be added to ${listType}.`
      );
      return;
    }
    updateWorkingReferenceListEntry(
      targetListType,
      effectiveSelectedScf,
      true,
      effectiveSelectedStateValue
    );
    appendAnalysisReviewNote(`Review decision: added SCF ${effectiveSelectedScf} to the working ${listType} list.`);
    scheduleReviewStateAutosave("manual-add");
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("manual-add");
    setStatus(
      "analysis-comparison-selection-status",
      `SCF ${effectiveSelectedScf} was added to the working ${listType} list. Live lists were not changed.`
    );
  });

  el("analysis-review-remove-button")?.addEventListener("click", () => {
    if (!effectiveSelectedScf) return;
    if (effectiveDnmStatus.isDoNotMail) {
      setStatus(
        "analysis-comparison-selection-status",
        `SCF ${effectiveSelectedScf} is on Do Not Mail and cannot be removed from ${listType}.`
      );
      return;
    }
    if (!effectiveTargetListEntry) {
      setStatus(
        "analysis-comparison-selection-status",
        `SCF ${effectiveSelectedScf} is not on the working ${listType} list.`
      );
      return;
    }
    updateWorkingReferenceListEntry(targetListType, effectiveSelectedScf, false);
    appendAnalysisReviewNote(`Review decision: removed SCF ${effectiveSelectedScf} from the working ${listType} list.`);
    scheduleReviewStateAutosave("manual-remove");
    renderAnalysisComparisonReviewPanel();
    broadcastAnalysisReviewState("manual-remove");
    setStatus(
      "analysis-comparison-selection-status",
      `SCF ${effectiveSelectedScf} was removed from the working ${listType} list. Live lists were not changed.`
    );
  });

  el("analysis-review-export-button")?.addEventListener("click", () => {
    if (effectiveDnmStatus.isDoNotMail) {
      setStatus(
        "analysis-comparison-selection-status",
        `SCF ${effectiveSelectedScf} is on Do Not Mail; working list export is not available from this SCF card.`
      );
      return;
    }
    exportWorkingComparisonList();
  });

  el("analysis-review-restore-button")?.addEventListener("click", () => {
    if (!confirm("Reset this analysis and restore the pending mailing lists back to where they were at the beginning?")) {
      return;
    }
    if (!resetAnalysisWorkingState()) {
      return;
    }
    renderAnalysisComparisonReviewPanel();
  });
}

function syncComparisonRequestsFromLinks() {
  state.analysis.comparisonRequests = (state.analysis.comparisonLinks || []).map((link, index) => {
    const reportIds = getComparisonSelectedReportIds(link);
    const derivedKeyCodeGroup = deriveComparisonKeyCodeGroupFromReportIds(reportIds);
    const comparisonName = resolveComparisonName(
      link.comparisonName || link.name || link.label || "",
      index
    );
    const createdAt = link.createdAt || new Date().toISOString();
    return {
      id: link.id || createClientId("comparison"),
      name: comparisonName,
      comparisonName,
      selectedReportIds: reportIds,
      keyCodeGroup:
        derivedKeyCodeGroup && derivedKeyCodeGroup !== "MIXED"
          ? derivedKeyCodeGroup
          : normalizeKeyCodeGroup(link.keyCodeGroup),
      reportIds,
      reportAId: reportIds[0] || "",
      reportBId: reportIds[1] || "",
      createdAt,
      updatedAt: new Date().toISOString(),
      matchField: String(link.matchField || "SCF Grouping").trim() || "SCF Grouping",
      metricColumns: readComparisonMetricColumns(link),
    };
  });
  persistAnalysisSetupDraft();
  return state.analysis.comparisonRequests;
}

async function saveComparisonSetup(statusMessage = "Comparison setup saved.") {
  if (isCurrentAnalysisReadOnly()) {
    throw new Error("Completed analyses are read-only until you undo the completion.");
  }
  const validation = validateAnalysisComparisonSetup();
  if (!validation.isValid) {
    throw new Error(validation.summaryErrors.join(" ").trim() || "Fix the comparison setup before saving.");
  }
  syncComparisonRequestsFromLinks();
  const payload = buildAnalysisPayload("draft");
  payload.commitComparisonSetup = true;
  const response = await apiRequest("/api/analysis/setups", {
    method: "POST",
    body: payload,
  });
  const setup = response.setup || {};
  state.analysis.currentSetupId = setup.id || state.analysis.currentSetupId;
  syncAnalysisReadOnlyState(setup);
  persistAnalysisSetupId(state.analysis.currentSetupId);
  persistAnalysisSetupDraft();
  syncAnalysisMeta({
    runName: setup.run_name || setup.runName || payload.runName,
    notes: setup.notes ?? payload.notes,
    createdAt: setup.created_at || setup.createdAt || null,
    updatedAt: setup.updated_at || setup.updatedAt || null,
  });
  setStatus("analysis-status-text", setup.status || "Draft");
  setStatus("analysis-status-detail", "Analysis setup saved.");
  setStatus("analysis-comparison-status", statusMessage);
  state.analysis.setupHydrated = true;
  state.analysis.lastSetupLoadSource = "persistent-storage";
  return setup;
}

function clearComparisonSetupAutosave() {
  if (comparisonSetupAutosaveHandle) {
    clearTimeout(comparisonSetupAutosaveHandle);
    comparisonSetupAutosaveHandle = null;
  }
}

function scheduleComparisonSetupAutosave(options = {}) {
  const immediate = options.immediate === true;
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 700;
  const statusMessage = String(options.statusMessage || "Comparison setup saved automatically.").trim();

  clearComparisonSetupAutosave();

  const runSave = async () => {
    if (comparisonSetupAutosaveInFlight) {
      try {
        await comparisonSetupAutosaveInFlight;
      } catch {
        // ignore prior autosave error and allow next attempt
      }
    }

    comparisonSetupAutosaveInFlight = saveComparisonSetup(statusMessage)
      .catch((error) => {
        setStatus("analysis-comparison-status", `Unable to auto-save comparison setup: ${error.message}`);
      })
      .finally(() => {
        comparisonSetupAutosaveInFlight = null;
      });

    await comparisonSetupAutosaveInFlight;
  };

  if (immediate) {
    void runSave();
    return;
  }

  comparisonSetupAutosaveHandle = setTimeout(() => {
    comparisonSetupAutosaveHandle = null;
    void runSave();
  }, delayMs);
}

function stopAnalysisRunPolling() {
  if (state.analysis.runPollHandle) {
    clearTimeout(state.analysis.runPollHandle);
    state.analysis.runPollHandle = null;
  }
}

function parseSortableValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-") {
    return { type: "empty", value: "" };
  }

  const numericCandidate = raw.replace(/[$,%(),\s]/g, "");
  const numericValue = Number(numericCandidate);
  if (!Number.isNaN(numericValue) && numericCandidate !== "") {
    const isNegative = raw.startsWith("(") && raw.endsWith(")");
    return { type: "number", value: isNegative ? -numericValue : numericValue };
  }

  const timestamp = Date.parse(raw);
  if (!Number.isNaN(timestamp) && /[-/]/.test(raw)) {
    return { type: "date", value: timestamp };
  }

  return { type: "text", value: raw.toLowerCase() };
}

function getSortedRows(tableId, rows, columns) {
  const sortState = state.analysis.tableSorts[tableId];
  if (!sortState || !Array.isArray(rows) || !Array.isArray(columns) || !columns[sortState.index]) {
    return rows;
  }

  const column = columns[sortState.index];
  const label = typeof column === "string" ? column : column.label;
  const normalized = typeof column === "string" ? "" : column.normalized;

  return [...rows].sort((rowA, rowB) => {
    const valueA = rowA?.[label] ?? rowA?.[normalized] ?? "";
    const valueB = rowB?.[label] ?? rowB?.[normalized] ?? "";
    const parsedA = parseSortableValue(valueA);
    const parsedB = parseSortableValue(valueB);

    let comparison = 0;
    if (parsedA.type === parsedB.type && ["number", "date"].includes(parsedA.type)) {
      comparison = parsedA.value - parsedB.value;
    } else {
      comparison = String(parsedA.value).localeCompare(String(parsedB.value), undefined, { numeric: true });
    }

    return sortState.direction === "desc" ? -comparison : comparison;
  });
}

function bindAnalysisResultSorts() {
  const container = el("analysis-results-container");
  if (!container || container.dataset.sortBound === "true") {
    return;
  }

  container.dataset.sortBound = "true";
  container.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const header = target.closest("[data-sort-table-id][data-sort-column-index]");
    if (!(header instanceof HTMLElement)) return;

    const tableId = header.getAttribute("data-sort-table-id");
    const index = Number.parseInt(header.getAttribute("data-sort-column-index") || "", 10);
    if (!tableId || !Number.isInteger(index)) return;

    const current = state.analysis.tableSorts[tableId];
    state.analysis.tableSorts[tableId] =
      current && current.index === index && current.direction === "desc"
        ? { index, direction: "asc" }
        : { index, direction: "desc" };

    if (state.analysis.resultMode === "run" && state.analysis.resultRun) {
      renderAnalysisResults(state.analysis.resultRun);
      return;
    }

    if (state.analysis.resultMode === "report" && state.analysis.resultReport) {
      renderAnalysisSavedReport(state.analysis.resultReport);
    }
  });
}

async function pollAnalysisRun(runId) {
  if (!runId) {
    stopAnalysisRunPolling();
    return;
  }

  try {
    const response = await apiRequest(`/api/analysis/runs/${encodeURIComponent(runId)}`);
    const run = response.run || {};
    if ((run.id || "") !== runId) {
      stopAnalysisRunPolling();
      return;
    }

    loadRunIntoWorkspace(run);
    await loadAnalysisReports();

    const status = String(run.status || "").toLowerCase();
    if (["complete", "partial", "failed"].includes(status)) {
      stopAnalysisRunPolling();
      return;
    }

    state.analysis.runPollHandle = setTimeout(() => {
      pollAnalysisRun(runId);
    }, 2000);
  } catch (error) {
    setStatus("analysis-status-detail", `Refresh failed: ${error.message}`);
    state.analysis.runPollHandle = setTimeout(() => {
      pollAnalysisRun(runId);
    }, 3000);
  }
}

function renderPullResultCard(pull, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : Array.isArray(pull.rows) ? pull.rows : [];
  const columns = Array.isArray(options.columns)
    ? options.columns
    : Array.isArray(pull.columns)
      ? pull.columns
      : [];
  const tableId = String(options.tableId || pull.id || pull.report_name || pull.analysisLabel || "analysis-table");
  const sortedRows = getSortedRows(tableId, rows, columns);
  const summaryValues = Array.isArray(options.summaryValues)
    ? options.summaryValues
    : Array.isArray(pull.summaryValues)
      ? pull.summaryValues
      : [];
  const analysisLabelHints = {
    "Sold Rate": "salesforce premium formula",
    "In Force Rate": "salesforce in-force premium formula",
    "Converted Rate": "salesforce converted premium formula",
  };
  const renderAnalysisLabelHtml = (label, suffix = "") => {
    const safeLabel = esc(label || "");
    const hint = analysisLabelHints[String(label || "").trim()];
    if (!hint) {
      return `${safeLabel}${suffix}`;
    }
    return `${safeLabel}<span class="analysis-label-hint">(${esc(hint)})</span>${suffix}`;
  };
  const sortState = state.analysis.tableSorts[tableId];
  const columnHeaders = columns.length
    ? columns.map((column, index) => {
        const isSorted = sortState && sortState.index === index;
        const indicator = isSorted ? (sortState.direction === "desc" ? " ↓" : " ↑") : "";
        return `<th class="sortable-column" data-sort-table-id="${esc(tableId)}" data-sort-column-index="${index}">${renderAnalysisLabelHtml(column.label || column, indicator)}</th>`;
      }).join("")
    : "";
  const previewRows = sortedRows.slice(0, 25).map((row) => {
    const cells = columns.length
      ? columns
          .map((column) => {
            const label = typeof column === "string" ? column : column.label;
            const normalized = typeof column === "string" ? "" : column.normalized;
            const value = row?.[label] ?? row?.[normalized] ?? "";
            return `<td>${esc(value)}</td>`;
          })
          .join("")
      : `<td>${esc(JSON.stringify(row || {}))}</td>`;
    return `<tr>${cells}</tr>`;
  }).join("");
  const parameters = options.parameters || pull.parameters || {};
  const filterParts = [];
  if (Array.isArray(parameters.key_codes) && parameters.key_codes.length) {
    filterParts.push(`Key: ${parameters.key_codes.join(", ")}`);
  }
  if (parameters.start_date || parameters.end_date) {
    filterParts.push(`Date: ${parameters.start_date || "?"} to ${parameters.end_date || "?"}`);
  }
  if (parameters.scf_filter) {
    filterParts.push(`SCF: ${parameters.scf_filter}`);
  }
  if (parameters.client_type) {
    filterParts.push(`List Type: ${parameters.client_type}`);
  }
  if (Array.isArray(parameters.selected_years) && parameters.selected_years.length) {
    filterParts.push(`Years: ${parameters.selected_years.join(", ")}`);
  }
  if (parameters.notes) {
    filterParts.push(`Notes: ${parameters.notes}`);
  }

  return `
    <article class="panel">
      <div class="panel-heading">
        <h3>${esc(options.title || pull.analysisLabel || pull.report_name || "Report Pull")}</h3>
        <p>Status: ${esc(options.status || pull.status || "Not run")} | Source rows: ${Number((options.inputRowCount ?? pull.rawRowCount) || 0)} | Exported rows: ${Number(options.exportRowCount ?? pull.exportRowCount ?? rows.length)}</p>
        <p>Report ID: ${esc(options.reportId || pull.reportId || pull.parameters?.report_id || "")}</p>
        ${filterParts.length ? `<p>Filters: ${esc(filterParts.join(" | "))}</p>` : ""}
        ${options.summary ? `<p>${esc(options.summary)}</p>` : ""}
        ${options.warningMessage || pull.warning_message ? `<p class="inline-status">Warning: ${esc(options.warningMessage || pull.warning_message || "")}</p>` : ""}
        ${options.error ? `<p class="inline-status">Error: ${esc(options.error)}</p>` : ""}
        ${options.downloadUrl ? `<p><a href="${esc(options.downloadUrl)}" download>Download export</a></p>` : ""}
      </div>
      ${summaryValues.length ? `
        <div class="analysis-summary-grid">
          ${summaryValues.map((entry) => `
            <div class="analysis-summary-card">
              <span class="field-label">${renderAnalysisLabelHtml(entry.label || "")}</span>
              <strong>${esc(entry.value ?? "")}</strong>
            </div>
          `).join("")}
        </div>
      ` : ""}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>${columnHeaders || "<th>Row Preview</th>"}</tr>
          </thead>
          <tbody>
            ${previewRows || `<tr><td colspan="${Math.max(columns.length, 1)}" class="empty-cell">No rows returned for this report.</td></tr>`}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function renderAnalysisResults(run = null) {
  const container = el("analysis-results-container");
  if (!container) return;
  state.analysis.resultMode = run ? "run" : "";
  state.analysis.resultRun = run || null;
  state.analysis.resultReport = null;

  if (!run || !Array.isArray(run.reportPulls) || run.reportPulls.length === 0) {
    container.innerHTML = '<div class="empty-state-block">No analysis results yet.</div>';
    return;
  }

  const cards = run.reportPulls.map((pull) =>
    renderPullResultCard(pull, { tableId: pull.id || pull.analysisLabel || "analysis-pull" })
  ).join("");

  container.innerHTML = `
    <div class="panel">
      <div class="panel-heading">
        <h3>${esc(run.runName || "Analysis Run")}</h3>
        <p>Status: ${esc(run.status || "")}</p>
        <p>${esc(run.statusDetail || "")}</p>
      </div>
    </div>
    ${cards}
  `;
  bindAnalysisResultSorts();
}

function renderAnalysisSavedReport(report = null) {
  const container = el("analysis-results-container");
  if (!container) return;
  state.analysis.resultMode = report ? "report" : "";
  state.analysis.resultRun = null;
  state.analysis.resultReport = report || null;

  if (!report) {
    renderAnalysisResults(null);
    return;
  }

  container.innerHTML = `
    <div class="panel">
      <div class="panel-heading">
        <h3>${esc(getAnalysisReportDisplayName(report) || "Saved Analysis Report")}</h3>
        <p>Status: ${esc(report.status || "")}</p>
        <p>${esc(report.results_summary || report.resultsSummary || "")}</p>
      </div>
    </div>
    ${renderPullResultCard(report, {
      title: getAnalysisReportDisplayName(report) || "Saved Analysis Report",
      status: report.status || "",
      inputRowCount: report.input_row_count || report.inputRowCount || report.result_count || report.resultCount || 0,
      exportRowCount: report.export_row_count || report.exportRowCount || report.result_count || report.resultCount || 0,
      reportId: report.parameters?.report_id || "",
      parameters: report.parameters || {},
      tableId: report.id || report.report_name || "analysis-report",
      summary: report.results_summary || report.resultsSummary || "",
      error: report.error_message || report.errorMessage || "",
      downloadUrl: report.download_url || report.downloadUrl || "",
      summaryValues: report.summaryValues || [],
      rows: report.rows || [],
      columns: report.columns || [],
    })}
  `;
  bindAnalysisResultSorts();
}

async function renameSavedAnalysisReport(reportId) {
  const report = (state.analysis.savedReports || []).find((entry) => entry.id === reportId);
  if (!reportId || !report) return;
  const trimmedName = String(state.analysis.editingReportTitle || "").trim();
  if (!trimmedName) {
    setStatus("analysis-status-detail", "Report title cannot be blank.");
    return;
  }

  setStatus("analysis-status-detail", "Saving report title...");
  try {
    const response = await apiRequest(`/api/analysis/reports/${encodeURIComponent(reportId)}`, {
      method: "PATCH",
      body: {
        reportName: trimmedName,
      },
    });
    const updatedReport = response.report || null;
    if (updatedReport) {
      state.analysis.savedReports = (response.reports || state.analysis.savedReports || []).map((entry) =>
        entry.id === updatedReport.id ? updatedReport : entry
      );
      if (state.analysis.currentReportId === updatedReport.id) {
        state.analysis.currentReportId = updatedReport.id;
        renderAnalysisSavedReport(updatedReport);
      }
    } else if (Array.isArray(response.reports)) {
      state.analysis.savedReports = response.reports;
    }
    await loadAnalysisReports();
    renderAnalysisComparePanel();
    state.analysis.editingReportId = "";
    state.analysis.editingReportTitle = "";
    setStatus("analysis-status-detail", "Report title updated.");
  } catch (error) {
    setStatus("analysis-status-detail", `Unable to update report title: ${error.message}`);
  }
}

function resetAnalysisWorkspace(clearPersistedSetup = true) {
  clearComparisonSetupAutosave();
  stopAnalysisRunPolling();
  state.analysis.currentSetupId = "";
  state.analysis.currentSetupStatus = "";
  state.analysis.currentRunId = "";
  state.analysis.currentReportId = "";
  state.analysis.reportPulls = [];
  state.analysis.comparisonRequests = [];
  state.analysis.comparisonLinks = [createComparisonLink(0)];
  state.analysis.comparisonResults = [];
  state.analysis.selectedComparisonId = "";
  state.analysis.lastEditedComparisonId = "";
  state.analysis.collapsedPullIds = {};
  collapseAnalysisPullsByDefault(state.analysis.reportPulls);
  state.analysis.reviewPrimaryReportIds = {};
  state.analysis.reviewSelectedScfs = {};
  state.analysis.reviewBaselineLists = [];
  state.analysis.reviewWorkingLists = [];
  state.analysis.reviewZeroRateRemovals = [];
  state.analysis.reviewBulkPreview = null;
  state.analysis.reviewSummary = null;
  state.analysis.reviewSummaryMode = "review";
  state.analysis.reviewSummaryNotes = "";
  state.analysis.reviewCompletedByName = "";
  state.analysis.reviewCompletedOnDate = getTodayIsoDate();
  state.analysis.readOnlyReview = false;
  state.analysis.setupHydrated = false;
  state.analysis.lastSetupLoadSource = "";
  if (clearPersistedSetup) {
    persistAnalysisSetupId("");
  }
  clearPersistedAnalysisSetupDraft();
  syncAnalysisMeta({
    runName: getDefaultAnalysisName(),
    notes: "",
    createdAt: null,
    updatedAt: null,
  });
  setStatus("analysis-status-text", "Draft");
  setStatus("analysis-status-detail", "Add one or more report pulls, then run the analysis.");
  renderAnalysisWorkspace();
  renderAnalysisResults(null);
}

function loadSetupIntoWorkspace(setup) {
  clearComparisonSetupAutosave();
  stopAnalysisRunPolling();
  state.analysis.currentSetupId = setup.id || "";
  syncAnalysisReadOnlyState(setup);
  persistAnalysisSetupId(state.analysis.currentSetupId);
  state.analysis.currentRunId = "";
  state.analysis.currentReportId = "";
  state.analysis.reportPulls = Array.isArray(setup.reportPulls) && setup.reportPulls.length
    ? setup.reportPulls.map((pull, index) => ({
        ...createEmptyPull(index),
        ...pull,
        dateRange: pull.dateRange
          ? {
              startDate: normalizeIsoDateInput(pull.dateRange.startDate || ""),
              endDate: normalizeIsoDateInput(pull.dateRange.endDate || ""),
            }
          : null,
      }))
    : [];
  state.analysis.comparisonRequests = Array.isArray(setup.comparisonRequests)
    ? setup.comparisonRequests
    : [];
  state.analysis.comparisonLinks = state.analysis.comparisonRequests.length
    ? state.analysis.comparisonRequests.map((entry, index) => createComparisonLink(index, entry))
    : [createComparisonLink(0)];
  recoverComparisonSetupFromWorkspace();
  state.analysis.comparisonResults = [];
  state.analysis.selectedComparisonId = String(setup.reviewState?.selectedComparisonId || "").trim();
  state.analysis.lastEditedComparisonId = String(setup.reviewState?.lastEditedComparisonId || "").trim();
  state.analysis.collapsedPullIds = {};
  collapseAnalysisPullsByDefault(state.analysis.reportPulls);
  state.analysis.reviewPrimaryReportIds = normalizeReviewSyncMap(setup.reviewState?.reviewPrimaryReportIds || {});
  state.analysis.reviewSelectedScfs = normalizeReviewSyncMap(setup.reviewState?.reviewSelectedScfs || {});
  state.analysis.reviewExcludedScfs = normalizeReviewSyncScfMap(setup.reviewState?.reviewExcludedScfs || {});
  state.analysis.reviewBaselineLists = normalizeReviewSyncLists(setup.reviewState?.reviewBaselineLists || []);
  state.analysis.reviewWorkingLists = normalizeReviewSyncLists(setup.reviewState?.reviewWorkingLists || []);
  state.analysis.reviewZeroRateRemovals = normalizeReviewZeroRateRemovals(setup.reviewState?.reviewZeroRateRemovals || []);
  state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics(setup.reviewState?.reviewZeroRemovalDiagnostics || null);
  state.analysis.reviewBulkPreview = null;
  const comparisonReview = getComparisonReviewResultFromEntry(setup);
  state.analysis.reviewSummary = comparisonReview?.summary || null;
  state.analysis.reviewSummaryMode = "review";
  state.analysis.reviewSummaryNotes = comparisonReview?.notes || "";
  state.analysis.reviewCompletedByName = String(setup.reviewState?.reviewCompletedByName || comparisonReview?.completedByName || "").trim();
  state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(setup.reviewState?.reviewCompletedOnDate || comparisonReview?.completedOnDate || "") || getTodayIsoDate();
  hydrateAnalysisWorkspaceFromSavedReports();
  state.analysis.setupHydrated = true;
  state.analysis.lastSetupLoadSource = "persistent-storage";
  syncAnalysisMeta({
    runName: setup.run_name || setup.runName || "",
    notes: setup.notes ?? state.analysis.runNotes,
    createdAt: setup.created_at || setup.createdAt || null,
    updatedAt: setup.updated_at || setup.updatedAt || null,
  });
  setStatus("analysis-status-text", setup.status || "Draft");
  setStatus("analysis-status-detail", "Saved analysis setup loaded.");
  renderAnalysisWorkspace();
  renderAnalysisResults(null);
}

function loadRunIntoWorkspace(run) {
  clearComparisonSetupAutosave();
  state.analysis.currentRunId = run.id || "";
  state.analysis.currentSetupId = run.setupId || "";
  syncAnalysisReadOnlyState(run);
  persistAnalysisSetupId(state.analysis.currentSetupId);
  state.analysis.currentReportId = "";
  state.analysis.reportPulls = Array.isArray(run.reportPulls) && run.reportPulls.length
    ? run.reportPulls.map((pull, index) => ({
        ...createEmptyPull(index),
        ...pull,
        dateRange: pull.dateRange
          ? {
              startDate: normalizeIsoDateInput(pull.dateRange.startDate || ""),
              endDate: normalizeIsoDateInput(pull.dateRange.endDate || ""),
            }
          : null,
      }))
    : [];
  state.analysis.comparisonRequests = Array.isArray(run.comparisonRequests)
    ? run.comparisonRequests
    : [];
  state.analysis.comparisonLinks = state.analysis.comparisonRequests.length
    ? state.analysis.comparisonRequests.map((entry, index) => createComparisonLink(index, entry))
    : [createComparisonLink(0)];
  recoverComparisonSetupFromWorkspace();
  state.analysis.comparisonResults = [];
  state.analysis.selectedComparisonId = String(run.reviewState?.selectedComparisonId || "").trim();
  state.analysis.lastEditedComparisonId = String(run.reviewState?.lastEditedComparisonId || "").trim();
  state.analysis.collapsedPullIds = {};
  state.analysis.reviewPrimaryReportIds = normalizeReviewSyncMap(run.reviewState?.reviewPrimaryReportIds || {});
  state.analysis.reviewSelectedScfs = normalizeReviewSyncMap(run.reviewState?.reviewSelectedScfs || {});
  state.analysis.reviewExcludedScfs = normalizeReviewSyncScfMap(run.reviewState?.reviewExcludedScfs || {});
  state.analysis.reviewBaselineLists = normalizeReviewSyncLists(run.reviewState?.reviewBaselineLists || []);
  state.analysis.reviewWorkingLists = normalizeReviewSyncLists(run.reviewState?.reviewWorkingLists || []);
  state.analysis.reviewZeroRateRemovals = normalizeReviewZeroRateRemovals(run.reviewState?.reviewZeroRateRemovals || []);
  state.analysis.reviewZeroRemovalDiagnostics = normalizeReviewZeroRemovalDiagnostics(run.reviewState?.reviewZeroRemovalDiagnostics || null);
  state.analysis.reviewBulkPreview = null;
  const comparisonReview = getComparisonReviewResultFromEntry(run);
  state.analysis.reviewSummary = comparisonReview?.summary || null;
  state.analysis.reviewSummaryMode = "review";
  state.analysis.reviewSummaryNotes = comparisonReview?.notes || "";
  state.analysis.reviewCompletedByName = String(run.reviewState?.reviewCompletedByName || comparisonReview?.completedByName || "").trim();
  state.analysis.reviewCompletedOnDate = normalizeIsoDateInput(run.reviewState?.reviewCompletedOnDate || comparisonReview?.completedOnDate || "") || getTodayIsoDate();
  hydrateAnalysisWorkspaceFromSavedReports();
  syncAnalysisMeta({
    runName: run.runName || "",
    notes: run.notes ?? state.analysis.runNotes,
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
  });
  setStatus("analysis-status-text", run.status || "Complete");
  setStatus("analysis-status-detail", run.statusDetail || "Analysis run loaded.");
  renderAnalysisWorkspace();
  renderAnalysisResults(run);
}

function buildAnalysisPayload(statusOverride) {
  syncComparisonRequestsFromLinks();
  const runName = String(el("analysis-run-name")?.value || state.analysis.runName || "").trim() || getDefaultAnalysisName();
  const notes = String(el("analysis-run-notes")?.value || state.analysis.runNotes || "").trim();
  state.analysis.runName = runName;
  state.analysis.runNotes = notes;
  const reportPulls = state.analysis.reportPulls.map((pull, index) => ({
    id: pull.id,
    savedReportId: String(pull.savedReportId || "").trim(),
    reportName: String(pull.reportName || "").trim(),
    status: String(pull.status || "").trim(),
    resultCount: Number(pull.resultCount || pull.result_count || 0),
    rawRowCount: Number(pull.rawRowCount || 0),
    reportId: String(pull.reportId || "").trim(),
    analysisLabel: buildAutoAnalysisLabel(pull, index),
    keyCodes: Array.isArray(pull.keyCodes) ? pull.keyCodes : [],
    years: Array.isArray(pull.years) ? pull.years : [],
    dateRange:
      pull.dateRange?.startDate && pull.dateRange?.endDate
        ? {
            startDate: normalizeIsoDateInput(pull.dateRange.startDate),
            endDate: normalizeIsoDateInput(pull.dateRange.endDate),
          }
        : null,
    scf: normalizeScf(pull.scf),
    clientType: String(pull.clientType || "").trim(),
    notes: String(pull.notes || "").trim(),
  }));

  return {
    id: state.analysis.currentSetupId || undefined,
    runName,
    status: statusOverride || "draft",
    notes,
    reportPulls,
    comparisonRequests: state.analysis.comparisonRequests,
    reviewState: {
      selectedComparisonId: String(state.analysis.selectedComparisonId || "").trim(),
      lastEditedComparisonId: String(state.analysis.lastEditedComparisonId || "").trim(),
      reviewPrimaryReportIds: normalizeReviewSyncMap(state.analysis.reviewPrimaryReportIds),
      reviewSelectedScfs: normalizeReviewSyncMap(state.analysis.reviewSelectedScfs),
      reviewCompletedByName: String(state.analysis.reviewCompletedByName || "").trim(),
      reviewCompletedOnDate: normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate(),
      reviewExcludedScfs: normalizeReviewSyncScfMap(state.analysis.reviewExcludedScfs),
      reviewBaselineLists: normalizeReviewSyncLists(state.analysis.reviewBaselineLists),
      reviewWorkingLists: normalizeReviewSyncLists(state.analysis.reviewWorkingLists),
      reviewZeroRateRemovals: normalizeReviewZeroRateRemovals(state.analysis.reviewZeroRateRemovals),
      reviewZeroRemovalDiagnostics: normalizeReviewZeroRemovalDiagnostics(state.analysis.reviewZeroRemovalDiagnostics),
    },
    results: state.analysis.reviewSummary
        ? {
          comparisonReview: {
            summary: state.analysis.reviewSummary,
            notes: state.analysis.reviewSummaryNotes || "",
            completedAt: new Date().toISOString(),
            completedByName: String(state.analysis.reviewCompletedByName || "").trim(),
            completedOnDate: normalizeIsoDateInput(state.analysis.reviewCompletedOnDate || "") || getTodayIsoDate(),
          },
        }
      : null,
  };
}

function validateAnalysisPulls() {
  if (!state.analysis.reportPulls.length) {
    return "Add at least one report pull first.";
  }

  for (let index = 0; index < state.analysis.reportPulls.length; index += 1) {
    const pull = state.analysis.reportPulls[index];
    const label = buildAutoAnalysisLabel(pull, index);
    const reportId = String(pull.reportId || "").trim();
    const keyCode = String((pull.keyCodes || [])[0] || "").trim();

    if (!reportId) {
      return `${label} is missing a Salesforce Report ID.`;
    }

    if (!/^[A-Za-z0-9]{15,18}$/.test(reportId)) {
      return `${label} has an invalid Salesforce Report ID.`;
    }

    if (!keyCode) {
      return `${label} is missing a Key Code.`;
    }
  }

  return "";
}

function bindAnalysisSubtabs() {
  all("[data-analysis-workflow]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const target = button.getAttribute("data-analysis-workflow");
      if (target === "run-reports") {
        state.analysis.reviewSummaryMode = "review";
        showAnalysisPanel("workspace");
        setAnalysisSubtab("runs");
        loadAnalysisReports().catch((error) => {
          setStatus("analysis-status-detail", `Unable to load analysis reports: ${error.message}`);
        });
        return;
      }
      if (target === "set-up-comparisons") {
        state.analysis.reviewSummaryMode = "review";
        loadAnalysisSetupView()
          .then(() => {
            showAnalysisPanel("home");
            setStatus("analysis-comparison-status", "Choose the reports and key code list for each comparison.");
          })
          .catch((error) => {
            setStatus("analysis-comparison-status", `Unable to load reports: ${error.message}`);
          });
        return;
      }
      if (target === "run-analysis") {
        state.analysis.reviewSummaryMode = "review";
        state.analysis.reviewSummaryApproved = false;
        Promise.all([loadAnalysisSetupView(), loadReferenceLists()])
          .then(() => {
            if (!Array.isArray(state.analysis.comparisonRequests) || !state.analysis.comparisonRequests.length) {
              showAnalysisPanel("home");
              setStatus("analysis-comparison-status", "Set up at least one comparison before running analysis.");
              return;
            }
            if (!Array.isArray(state.analysis.reviewBaselineLists) || !state.analysis.reviewBaselineLists.length) {
              state.analysis.reviewBaselineLists = cloneData(state.referenceLists || []);
            }
            if (!Array.isArray(state.analysis.reviewWorkingLists) || !state.analysis.reviewWorkingLists.length) {
              state.analysis.reviewWorkingLists = cloneData(state.referenceLists || []);
            }
            if (!Array.isArray(state.analysis.reviewZeroRateRemovals)) {
              state.analysis.reviewZeroRateRemovals = [];
            }
            if (!state.analysis.selectedComparisonId) {
              state.analysis.selectedComparisonId = getPreferredComparisonId(state.analysis.comparisonRequests || []);
            }
            showAnalysisPanel("compare-review");
            setStatus("analysis-comparison-selection-status", "Review the comparison and work from the testing copy of the lists.");
          })
          .catch((error) => {
            setStatus("analysis-comparison-selection-status", `Unable to open comparison review: ${error.message}`);
          });
      }
    });
  });
}

async function loadAnalysisReports(providedRows = null) {
  const tbody = el("analysis-history-body");
  const rows = Array.isArray(providedRows)
    ? providedRows
    : (await apiRequest("/api/analysis/reports")).reports || [];
  state.analysis.reportScfMetricCache = {};
  state.analysis.savedReports = rows;
  hydrateAnalysisWorkspaceFromSavedReports();
  recoverComparisonSetupFromWorkspace();
  const validReportIds = new Set(rows.map((report) => String(report.id || "").trim()).filter(Boolean));
  setSelectedAnalysisReportIds(getSelectedAnalysisReportIds().filter((id) => validReportIds.has(id)));
  if (!tbody) {
    return rows;
  }
  const empty = el("analysis-history-empty-row");
  if (empty) empty.remove();
  tbody.innerHTML = "";
  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="7" class="empty-cell">No analysis reports yet.</td>';
    tbody.appendChild(row);
    updateAnalysisReportSelectionUi();
    return rows;
  }
  rows.forEach((report) => {
    const canDelete = report.canDelete === true || report.can_delete === true;
    const selected = getSelectedAnalysisReportIds().includes(String(report.id || "").trim());
    const titleCell = `<div class="analysis-report-row-title">
         <strong>${esc(getAnalysisReportDisplayName(report))}</strong>
         <span>${esc(report.report_id || report.reportId || report.id || "")}</span>
       </div>`;
    const downloadMarkup = report.download_url || report.downloadUrl
      ? `<a class="secondary-button table-action-button analysis-table-link-button" href="${esc(report.download_url || report.downloadUrl)}" download>Download</a>`
      : '<span class="analysis-report-download-empty">No file</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${canDelete ? `<input type="checkbox" data-select-report="${esc(report.id)}" aria-label="Select report ${esc(getAnalysisReportDisplayName(report))}" ${selected ? "checked" : ""} />` : '<span class="analysis-report-download-empty">Locked</span>'}</td>
      <td>${titleCell}</td>
      <td>${formatDate(report.created_at || report.createdAt)}</td>
      <td>${esc(report.status || "idle")}</td>
      <td>${getAnalysisReportRowCount(report)}</td>
      <td>${downloadMarkup}</td>
      <td class="action-row">
        <button class="secondary-button table-action-button" data-view-report="${esc(report.id)}">View</button>
        ${canDelete
          ? `<button class="secondary-button table-action-button" data-delete-report="${esc(report.id)}">Delete</button>`
          : '<span class="analysis-report-download-empty">History Locked</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });

  all("[data-view-report]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-view-report");
      if (!id) return;
      setStatus("analysis-status-detail", `Loading analysis report ${id}...`);
      const response = await apiRequest(`/api/analysis/reports/${encodeURIComponent(id)}`);
      const report = response.report || {};
      let run = null;
      if (report.run_id || report.runId) {
        const runResponse = await apiRequest(
          `/api/analysis/runs/${encodeURIComponent(report.run_id || report.runId)}`
        );
        run = runResponse.run || null;
      }
      if (run) {
        loadRunIntoWorkspace(run);
      }
      state.analysis.currentReportId = report.id || "";
      state.analysis.subtab = "runs";
      showAnalysisPanel("workspace");
      renderAnalysisSavedReport(report);
      setStatus("analysis-status-detail", `Opened saved analysis report ${getAnalysisReportDisplayName(report) || id}.`);
    });
  });

  all("[data-delete-report]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-delete-report");
      if (!id) return;
      const report = ensureArray(state.analysis.savedReports).find((entry) => String(entry.id || "").trim() === id);
      const reportName = getAnalysisReportDisplayName(report) || id;
      if (!confirm(`Delete this report?\n\n${reportName}`)) {
        return;
      }
      button.disabled = true;
      setStatus("analysis-status-detail", `Deleting analysis report ${reportName}...`);
      try {
        const response = await apiRequest(`/api/analysis/reports/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        state.analysis.savedReports = ensureArray(response.reports);
        setSelectedAnalysisReportIds(getSelectedAnalysisReportIds().filter((entry) => entry !== id));
        if (state.analysis.currentReportId === id) {
          state.analysis.currentReportId = "";
          renderAnalysisResults(null);
        }
        await loadAnalysisReports(state.analysis.savedReports);
        renderAnalysisComparePanel();
        setStatus("analysis-status-detail", `Deleted analysis report ${reportName}.`);
      } catch (error) {
        button.disabled = false;
        setStatus("analysis-status-detail", `Delete failed: ${error.message}`);
      }
    });
  });

  all("[data-select-report]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-select-report");
      if (!id) {
        return;
      }
      const nextIds = new Set(getSelectedAnalysisReportIds());
      if (input.checked) {
        nextIds.add(id);
      } else {
        nextIds.delete(id);
      }
      setSelectedAnalysisReportIds(Array.from(nextIds));
      updateAnalysisReportSelectionUi();
    });
  });

  updateAnalysisReportSelectionUi();
  return rows;
}

async function fetchAnalysisSetupsPayload() {
  const setupsPayload = await apiRequest("/api/analysis/setups");
  return ensureArray(setupsPayload.setups).filter((entry) => shouldDisplayAnalysisHistoryEntry(entry));
}

function updateAnalysisReportSelectionUi() {
  const selectedIds = getSelectedAnalysisReportIds();
  const rows = ensureArray(state.analysis.savedReports);
  const deletableRows = rows.filter((report) => report.canDelete === true || report.can_delete === true);
  const rowIds = deletableRows.map((report) => String(report.id || "").trim()).filter(Boolean);
  const selectedCount = selectedIds.filter((id) => rowIds.includes(id)).length;
  const selectAll = el("analysis-select-all-reports");
  if (selectAll instanceof HTMLInputElement) {
    selectAll.disabled = rowIds.length === 0;
    selectAll.checked = rowIds.length > 0 && selectedCount === rowIds.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < rowIds.length;
  }
  const deleteButton = el("analysis-delete-selected-button");
  if (deleteButton) {
    deleteButton.disabled = selectedCount === 0;
    deleteButton.hidden = rowIds.length === 0;
  }
}

async function deleteSelectedAnalysisReports() {
  const selectedIds = getSelectedAnalysisReportIds();
  if (!selectedIds.length) {
    return;
  }

  const reportNames = ensureArray(state.analysis.savedReports)
    .filter((report) => selectedIds.includes(report.id))
    .map((report) => getAnalysisReportDisplayName(report));
  const message = selectedIds.length === 1
    ? `Delete this report?\n\n${reportNames[0] || selectedIds[0]}`
    : `Delete these ${selectedIds.length} reports?\n\n${reportNames.slice(0, 10).join("\n")}${reportNames.length > 10 ? "\n..." : ""}`;

  if (!confirm(message)) {
    return;
  }

  setStatus("analysis-status-detail", `Deleting ${selectedIds.length} analysis report${selectedIds.length === 1 ? "" : "s"}...`);
  const deleteButton = el("analysis-delete-selected-button");
  if (deleteButton) {
    deleteButton.disabled = true;
  }

  try {
    const response = await apiRequest("/api/analysis/reports/bulk-delete", {
      method: "POST",
      body: { reportIds: selectedIds },
    });
    const deletedIds = ensureArray(response.deletedIds).map((entry) => String(entry || "").trim()).filter(Boolean);
    const deletedIdSet = new Set(deletedIds);
    state.analysis.savedReports = ensureArray(response.reports);
    setSelectedAnalysisReportIds(getSelectedAnalysisReportIds().filter((id) => !deletedIdSet.has(id)));
    if (state.analysis.currentReportId && deletedIdSet.has(state.analysis.currentReportId)) {
      state.analysis.currentReportId = "";
      renderAnalysisResults(null);
    }
    await loadAnalysisReports(ensureArray(response.reports));
    renderAnalysisComparePanel();
    setStatus("analysis-status-detail", `Deleted ${deletedIds.length} analysis report${deletedIds.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus("analysis-status-detail", `Delete failed: ${error.message}`);
    updateAnalysisReportSelectionUi();
  }
}

async function loadAnalysisSetups() {
  const tbody = el("analysis-setup-body");
  if (!tbody) return;
  const normalizedSetups = await fetchAnalysisSetupsPayload();
  const openSetups = normalizedSetups
    .filter((entry) => !entry.archived && !isCompletedAnalysisSetup(entry))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.updatedAt || left.created_at || left.createdAt || "") || 0;
      const rightTime = Date.parse(right.updated_at || right.updatedAt || right.created_at || right.createdAt || "") || 0;
      return rightTime - leftTime;
    });
  const newestOpenSetupId = String(openSetups[0]?.id || "").trim();
  const setups = normalizedSetups.filter((entry) => {
    if (isCompletedAnalysisSetup(entry)) {
      return true;
    }
    if (!newestOpenSetupId) {
      return true;
    }
    return String(entry?.id || "").trim() === newestOpenSetupId;
  });
  const rows = setups.length
    ? setups.map((setup, index) => ({
        id: setup.id,
        sourceType: "setup",
        name: String(setup.run_name || setup.runName || getDefaultAnalysisName()).trim() || getDefaultAnalysisName(),
        stage: isCompletedAnalysisSetup(setup) ? "Completed" : setup.archived ? "History" : "Open",
        status: setup.status || "draft",
        isCompleted: isCompletedAnalysisSetup(setup),
        isArchived: setup.archived === true,
        createdAt: setup.created_at || setup.createdAt || null,
        updatedAt: setup.updated_at || setup.updatedAt || null,
        completedAt: setup.completed_at || setup.completedAt || null,
        reportPullCount: Array.isArray(setup.reportPulls) ? setup.reportPulls.length : 0,
        isTopRow: index === 0,
        canUndoLatestCompletion: setup.canUndoLatestCompletion === true,
      }))
    : [{
        id: "__current_month_analysis__",
        sourceType: "draft",
        name: getDefaultAnalysisName(),
        stage: "Open",
        status: "draft",
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        reportPullCount: 0,
      }];
  const empty = el("analysis-setup-empty-row");
  if (empty) empty.remove();
  tbody.innerHTML = "";

  rows.forEach((entry) => {
    const showUndo = entry.sourceType === "setup" && entry.isTopRow && (entry.canUndoLatestCompletion || entry.isCompleted);
    const showDelete = entry.sourceType === "setup" && !entry.isCompleted;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(entry.name)}</td>
      <td>${esc(entry.stage)}</td>
      <td>${esc(entry.status)}</td>
      <td>${formatDate(entry.createdAt)}</td>
      <td>${formatDate(entry.updatedAt)}</td>
      <td>${formatDate(entry.completedAt)}</td>
      <td>${Number(entry.reportPullCount || 0)}</td>
      <td class="action-row">
        <button class="secondary-button" data-open-analysis-entry="${esc(entry.id)}" data-entry-type="${esc(entry.sourceType)}">Open</button>
        ${showUndo
          ? `<button class="secondary-button" data-undo-analysis-entry="${esc(entry.id)}">Undo</button>`
          : ""}
        ${showDelete
          ? `<button class="secondary-button" data-delete-analysis-entry="${esc(entry.id)}">Delete</button>`
          : ""}
      </td>
    `;
    tbody.appendChild(tr);
  });

  all("[data-open-analysis-entry]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-open-analysis-entry");
      const type = button.getAttribute("data-entry-type");
      if (!id || !type) return;
      setStatus("analysis-setup-status", `Loading analysis ${id}...`);
      if (type === "setup") {
        const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(id)}`);
        const setupEntry = response.setup || {};
        loadSetupIntoWorkspace(setupEntry);
        const landing = resolveAnalysisLandingFromEntry(setupEntry);
        state.analysis.reviewSummaryMode = landing.summaryMode;
        showAnalysisPanel(landing.panel);
      } else {
        resetAnalysisWorkspace();
        showAnalysisPanel("workspace");
      }
      setStatus("analysis-setup-status", `Loaded analysis ${type === "setup" ? id : getDefaultAnalysisName()}.`);
    });
  });

  all("[data-delete-analysis-entry]").forEach((button) => {
    button.addEventListener("click", async () => {
      const setupId = button.getAttribute("data-delete-analysis-entry");
      if (!setupId) return;
      await deleteAnalysisSetupEntry(setupId);
    });
  });

  all("[data-undo-analysis-entry]").forEach((button) => {
    button.addEventListener("click", async () => {
      const setupId = button.getAttribute("data-undo-analysis-entry");
      if (!setupId) return;
      await undoAnalysisSetupEntry(setupId);
    });
  });
}

async function deleteAnalysisSetupEntry(setupId) {
  const normalizedSetupId = String(setupId || "").trim();
  if (!normalizedSetupId) {
    return;
  }

  const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(normalizedSetupId)}`);
  const setup = response.setup || {};
  const setupName = String(setup.run_name || setup.runName || "this analysis").trim() || "this analysis";
  const hasListChanges = Array.isArray(setup.referenceListChanges || setup.reference_list_changes)
    && (setup.referenceListChanges || setup.reference_list_changes).some((change) =>
      (Array.isArray(change?.added) && change.added.length > 0)
      || (Array.isArray(change?.removed) && change.removed.length > 0)
    );
  const isComplete = String(setup.status || "").trim().toLowerCase() === "complete";

  const confirmedDelete = confirm(`Delete ${setupName}?`);
  if (!confirmedDelete) {
    return;
  }

  const revertReferenceLists = isComplete && hasListChanges;

  setStatus("analysis-setup-status", `Deleting ${setupName}...`);
  const result = await apiRequest(`/api/analysis/setups/${encodeURIComponent(normalizedSetupId)}/delete`, {
    method: "POST",
    body: {
      revertReferenceLists,
      actor: "Local User",
    },
  });

  if (state.analysis.currentSetupId === normalizedSetupId) {
    persistAnalysisSetupId("");
    resetAnalysisWorkspace(false);
    state.analysis.currentSetupId = "";
    state.analysis.currentRunId = "";
    state.analysis.currentReportId = "";
    state.analysis.reviewSummary = null;
    state.analysis.reviewSummaryMode = "review";
    state.analysis.reviewSummaryNotes = "";
    state.analysis.reviewSummaryApproved = false;
  }

  state.analysis.savedReports = Array.isArray(result.reports) ? result.reports : state.analysis.savedReports;
  if (Array.isArray(result.lists)) {
    state.referenceLists = result.lists;
  }
  await loadAnalysisSetups();
  setStatus(
    "analysis-setup-status",
    revertReferenceLists && Array.isArray(result?.result?.revertedLists) && result.result.revertedLists.length
      ? `${setupName} deleted and reverted ${result.result.revertedLists.join(", ").toUpperCase()} mailing lists.`
      : `${setupName} deleted.`
  );
}

async function undoAnalysisSetupEntry(setupId) {
  const normalizedSetupId = String(setupId || "").trim();
  if (!normalizedSetupId) {
    return;
  }

  const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(normalizedSetupId)}`);
  const setup = response.setup || {};
  const setupName = String(setup.run_name || setup.runName || "this analysis").trim() || "this analysis";
  if (!confirm(`Undo the most recent completed analysis for ${setupName} and restore the mailing lists to their pre-completion state?`)) {
    return;
  }

  setStatus("analysis-setup-status", `Undoing ${setupName}...`);
  const undoResponse = await apiRequest(`/api/analysis/setups/${encodeURIComponent(normalizedSetupId)}/undo-complete`, {
    method: "POST",
    body: {
      actor: "Local User",
    },
  });

  const restoredSetup = undoResponse.setup || {};
  state.referenceLists = Array.isArray(undoResponse.lists) ? undoResponse.lists : state.referenceLists;
  await loadAnalysisSetups();
  loadSetupIntoWorkspace(restoredSetup);
  const landing = resolveAnalysisLandingFromEntry(restoredSetup);
  state.analysis.reviewSummaryMode = landing.summaryMode;
  showAnalysisPanel(landing.panel);
  setStatus(
    "analysis-setup-status",
    Array.isArray(undoResponse.revertedLists) && undoResponse.revertedLists.length
      ? `${setupName} was reopened and restored ${undoResponse.revertedLists.join(", ").toUpperCase()} mailing lists.`
      : `${setupName} was reopened.`
  );
}

async function loadAnalysisSetupView() {
  setStatus("analysis-setup-status", "Loading analysis...");
  let normalizedSetups = [];
  try {
    const [, setups] = await Promise.all([
      loadAnalysisReports(),
      fetchAnalysisSetupsPayload().catch(() => []),
    ]);
    normalizedSetups = ensureArray(setups);
  } catch (error) {
    setStatus("analysis-comparison-status", `Unable to load available reports: ${error.message}`);
  }

  const persistedSetupId = state.analysis.currentSetupId || readPersistedAnalysisSetupId();
  const preferredSetup = choosePreferredAnalysisSetup(normalizedSetups, {
    preferredId: persistedSetupId,
  });
  const targetSetupId = String(preferredSetup?.id || persistedSetupId || "").trim();
  if (targetSetupId && (!state.analysis.setupHydrated || state.analysis.currentSetupId !== targetSetupId)) {
    try {
      const response = await apiRequest(`/api/analysis/setups/${encodeURIComponent(targetSetupId)}`);
      loadSetupIntoWorkspace(response.setup || {});
      state.analysis.currentSetupId = targetSetupId;
      persistAnalysisSetupId(targetSetupId);
    } catch (error) {
      persistAnalysisSetupId("");
      setStatus("analysis-comparison-status", `Unable to restore saved comparison setup: ${error.message}`);
    }
  } else if (!targetSetupId && !state.analysis.setupHydrated) {
    restorePersistedAnalysisSetupDraft("");
  }

  state.analysis.setupHydrated = true;
  setStatus("analysis-setup-status", targetSetupId ? `Loaded analysis ${targetSetupId}.` : "Analysis ready.");
  if (state.analysis.panel === "compare-review") {
    renderComparisonReviewPanelShell();
    try {
      renderAnalysisComparisonReviewPanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      const comparisonReviewPanel = el("analysis-comparison-review-panel");
      if (comparisonReviewPanel) {
        const statusText = comparisonReviewPanel.querySelector("#analysis-comparison-selection-status");
        if (statusText) {
          statusText.textContent = `Unable to open comparison review: ${message}`;
        }
        const results = comparisonReviewPanel.querySelector("#analysis-comparison-results");
        if (results) {
          results.innerHTML = `<div class="empty-state-block">Comparison review failed to render. ${esc(message)}</div>`;
        }
      }
      setStatus("analysis-comparison-selection-status", `Unable to open comparison review: ${message}`);
    }
    return;
  }
  renderAnalysisSetupHome();
}

function bindAnalysisButtons() {
  const startNew = el("start-new-analysis-button");
  const openPrevious = el("open-previous-analysis-button");
  const viewReports = el("view-analysis-history-button");
  const startNewFromListButton = el("analysis-previous-back-button");
  const backToAnalysisHomeButton = el("back-to-analysis-home-button");
  const addPullButton = el("add-analysis-pull-button");
  const saveSetupButton = el("save-analysis-setup-button");
  const runAnalysisButton = el("run-analysis-button");
  const pullContainer = el("analysis-report-pulls");
  const runNameInput = el("analysis-run-name");
  const runNotesInput = el("analysis-run-notes");
  const continueButton = el("analysis-continue-button");
  const deleteSelectedReportsButton = el("analysis-delete-selected-button");
  const selectAllReportsCheckbox = el("analysis-select-all-reports");
  const compareContainer = el("analysis-comparison-links");
  const addComparisonButton = el("add-comparison-link-button");
  const saveComparisonSetupButton = el("save-comparison-setup-button");
  const analysisHomeNextButton = el("analysis-home-next-button");
  const completeComparisonSetupButton = el("complete-comparison-setup-button");
  const analysisSetupBackButton = el("analysis-setup-back-button");
  const runComparisonsButton = el("run-report-comparisons-button");
  const backToRunsButton = el("back-to-analysis-runs-button");
  const exitComparisonSetupButton = el("exit-comparison-setup-button");
  const saveComparisonReviewButton = el("save-comparison-review-button");
  const backToComparisonSetupButton = el("back-to-comparison-setup-button");
  const backToAnalysisRunsFromReviewButton = el("back-to-analysis-runs-from-review-button");
  const exitComparisonReviewButton = el("exit-comparison-review-button");
  const comparisonReviewPanel = el("analysis-comparison-review-panel");

  startNew?.addEventListener("click", () => {
    state.analysis.subtab = "runs";
    resetAnalysisWorkspace();
    showAnalysisPanel("workspace");
  });
  openPrevious?.addEventListener("click", () => {
    showAnalysisPanel("previous");
    loadAnalysisSetups();
  });
  viewReports?.addEventListener("click", () => {
    state.analysis.subtab = "runs";
    showAnalysisPanel("workspace");
    loadAnalysisReports();
  });
  startNewFromListButton?.addEventListener("click", () => {
    state.analysis.subtab = "runs";
    resetAnalysisWorkspace();
    showAnalysisPanel("workspace");
    setStatus("analysis-setup-status", "Started a new analysis draft.");
  });
  backToAnalysisHomeButton?.addEventListener("click", () => {
    resetAnalysisWorkspace();
    openAnalysisList();
  });

  addPullButton?.addEventListener("click", () => {
    const nextPull = createEmptyPull(state.analysis.reportPulls.length);
    state.analysis.reportPulls.push(nextPull);
    setAnalysisPullCollapsed(nextPull.id, true);
    persistAnalysisSetupDraft();
    renderAnalysisWorkspace();
    setStatus("analysis-status-detail", "Report pull added.");
  });

  runNameInput?.addEventListener("input", () => {
    state.analysis.runName = String(runNameInput.value || "");
    persistAnalysisSetupDraft();
  });

  runNotesInput?.addEventListener("input", () => {
    state.analysis.runNotes = String(runNotesInput.value || "");
    persistAnalysisSetupDraft();
  });

  continueButton?.addEventListener("click", async () => {
    setStatus("analysis-comparison-status", "Loading saved reports...");
    try {
      await loadAnalysisSetupView();
      showAnalysisPanel("home");
      setStatus("analysis-comparison-status", "Choose the reports and key code list for each comparison.");
    } catch (error) {
      setStatus("analysis-comparison-status", `Unable to load reports: ${error.message}`);
    }
  });

  analysisSetupBackButton?.addEventListener("click", () => {
    state.analysis.subtab = "runs";
    showAnalysisPanel("workspace");
  });

  pullContainer?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const pullId = target.getAttribute("data-pull-id");
    const field = target.getAttribute("data-pull-field");
    if (!pullId || !field) return;
    const pull = state.analysis.reportPulls.find((entry) => entry.id === pullId);
    if (!pull) return;

    const value = target.value;
    if (field === "keyCodes") {
      pull.keyCodes = splitCsvValue(value);
      syncAnalysisPullClientTypeWithKeyCodes(pull);
    } else if (field === "years") {
      pull.years = splitCsvValue(value)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((entry) => Number.isInteger(entry));
    } else if (field === "startDate" || field === "endDate") {
      const current = pull.dateRange || { startDate: "", endDate: "" };
      current[field] = normalizeIsoDateInput(value);
      pull.dateRange = current.startDate && current.endDate ? current : { ...current };
    } else if (field === "scf") {
      pull.scf = value;
    } else {
      pull[field] = value;
    }

    if (field === "keyCodes" || field === "startDate" || field === "endDate") {
      updateAnalysisPullCardPreview(pullId);
    }
    persistAnalysisSetupDraft();
  });

  pullContainer?.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement) {
      const pullId = target.getAttribute("data-pull-id");
      const field = target.getAttribute("data-pull-field");
      if (pullId && field) {
        const pull = state.analysis.reportPulls.find((entry) => entry.id === pullId);
        if (pull) {
          const value = target.value;
          if (field === "keyCodes") {
            pull.keyCodes = splitCsvValue(value);
            syncAnalysisPullClientTypeWithKeyCodes(pull);
          } else if (field === "startDate" || field === "endDate") {
            const current = pull.dateRange || { startDate: "", endDate: "" };
            current[field] = normalizeIsoDateInput(value);
            pull.dateRange = current.startDate && current.endDate ? current : { ...current };
          }
          updateAnalysisPullCardPreview(pullId);
        }
      }
    }
  });

  pullContainer?.addEventListener("blur", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const field = target.getAttribute("data-pull-field");
    const pullId = target.getAttribute("data-pull-id");
    if ((field === "startDate" || field === "endDate") && pullId) {
      updateAnalysisPullCardPreview(pullId);
    }
  }, true);

  pullContainer?.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("button[data-action]") : null;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("data-action") === "toggle-analysis-pull") {
      const pullId = target.getAttribute("data-pull-id");
      if (!pullId) return;
      setAnalysisPullCollapsed(pullId, !isAnalysisPullCollapsed(pullId));
      renderAnalysisWorkspace();
      return;
    }
    if (target.getAttribute("data-action") !== "remove-analysis-pull") return;
    const pullId = target.getAttribute("data-pull-id");
    if (!pullId) return;
    state.analysis.reportPulls = state.analysis.reportPulls.filter((entry) => entry.id !== pullId);
    persistAnalysisSetupDraft();
    renderAnalysisWorkspace();
    setStatus("analysis-status-detail", "Report pull removed.");
  });

  saveSetupButton?.addEventListener("click", async () => {
    if (isCurrentAnalysisReadOnly()) {
      setStatus("analysis-status-detail", "Completed analyses are read-only until you undo the completion.");
      return;
    }
    const validationError = validateAnalysisPulls();
    if (validationError) {
      setStatus("analysis-status-detail", validationError);
      return;
    }
    saveSetupButton.disabled = true;
    setStatus("analysis-status-detail", "Saving analysis setup...");
    try {
      const payload = buildAnalysisPayload("draft");
      const response = await apiRequest("/api/analysis/setups", {
        method: "POST",
        body: payload,
      });
      const setup = response.setup || {};
      state.analysis.currentSetupId = setup.id || state.analysis.currentSetupId;
      syncAnalysisReadOnlyState(setup);
      persistAnalysisSetupId(state.analysis.currentSetupId);
      persistAnalysisSetupDraft();
      syncAnalysisMeta({
        runName: setup.run_name || setup.runName || payload.runName,
        notes: setup.notes ?? payload.notes,
        createdAt: setup.created_at || setup.createdAt || null,
        updatedAt: setup.updated_at || setup.updatedAt || null,
      });
      setStatus("analysis-status-text", setup.status || "Draft");
      setStatus("analysis-status-detail", "Analysis setup saved.");
    } catch (error) {
      setStatus("analysis-status-detail", `Save failed: ${error.message}`);
    } finally {
      saveSetupButton.disabled = false;
    }
  });

  runAnalysisButton?.addEventListener("click", async () => {
    if (isCurrentAnalysisReadOnly()) {
      setStatus("analysis-status-detail", "Completed analyses are read-only until you undo the completion.");
      return;
    }
    const validationError = validateAnalysisPulls();
    if (validationError) {
      setStatus("analysis-status-detail", validationError);
      return;
    }
    runAnalysisButton.disabled = true;
    setStatus("analysis-status-text", "Running");
    setStatus("analysis-status-detail", "Starting analysis...");
    try {
      const savePayload = buildAnalysisPayload("draft");
      const saveResponse = await apiRequest("/api/analysis/setups", {
        method: "POST",
        body: savePayload,
      });
      const savedSetup = saveResponse.setup || {};
      state.analysis.currentSetupId = savedSetup.id || state.analysis.currentSetupId;
      syncAnalysisReadOnlyState(savedSetup);
      persistAnalysisSetupId(state.analysis.currentSetupId);
      persistAnalysisSetupDraft();
      const runResponse = await apiRequest("/api/analysis/runs", {
        method: "POST",
        body: {
          ...buildAnalysisPayload("running"),
          setupId: state.analysis.currentSetupId || undefined,
        },
      });
      const run = runResponse.run || {};
      state.analysis.currentRunId = run.id || "";
      syncAnalysisMeta({
        runName: savePayload.runName,
        notes: savePayload.notes ?? state.analysis.runNotes,
        createdAt: savedSetup.created_at || savedSetup.createdAt || null,
        updatedAt: savedSetup.updated_at || savedSetup.updatedAt || null,
      });
      setStatus("analysis-status-text", run.status || "Running");
      setStatus("analysis-status-detail", `Analysis queued: ${run.id || "run created"}.`);
      await loadAnalysisReports();
      if (run.id) {
        stopAnalysisRunPolling();
        pollAnalysisRun(run.id);
      }
    } catch (error) {
      setStatus("analysis-status-text", "Failed");
      setStatus("analysis-status-detail", `Run failed: ${error.message}`);
    } finally {
      runAnalysisButton.disabled = false;
    }
  });

  addComparisonButton?.addEventListener("click", () => {
    if (isCurrentAnalysisReadOnly()) {
      setStatus("analysis-comparison-status", "Completed analyses are read-only until you undo the completion.");
      return;
    }
    if (getAvailableAnalysisReports().filter((report) => report.status === "ready").length < 2) {
      setStatus(
        "analysis-comparison-status",
        "At least two ready reports are required to build a comparison."
      );
      return;
    }
    state.analysis.comparisonLinks.push(
      createComparisonLink(state.analysis.comparisonLinks.length)
    );
    persistAnalysisSetupDraft();
    renderAnalysisComparePanel();
    setStatus("analysis-comparison-status", "Comparison row added.");
    scheduleComparisonSetupAutosave({ immediate: true });
  });

  saveComparisonSetupButton?.addEventListener("click", async () => {
    saveComparisonSetupButton.disabled = true;
    setStatus("analysis-comparison-status", "Saving comparison setup...");
    try {
      await saveComparisonSetup("Comparison setup saved.");
    } catch (error) {
      setStatus("analysis-comparison-status", `Unable to save comparison setup: ${error.message}`);
    } finally {
      saveComparisonSetupButton.disabled = false;
    }
  });

  const handleCompleteComparisonSetup = async (button) => {
    if (isCurrentAnalysisReadOnly()) {
      setStatus("analysis-comparison-status", "Completed analyses are read-only until you undo the completion.");
      return;
    }
    const validation = validateAnalysisComparisonSetup();
    renderAnalysisSetupHome();
    if (!validation.isValid) {
      setStatus("analysis-comparison-status", validation.summaryErrors.join(" ").trim() || "Fix the comparison errors before continuing.");
      return;
    }

    if (button) {
      button.disabled = true;
    }
    setStatus("analysis-comparison-status", "Saving comparison setup...");
    try {
      await saveComparisonSetup("Comparison setup saved.");
      state.analysis.selectedComparisonId = getPreferredComparisonId(state.analysis.comparisonRequests || []);
      await loadReferenceLists();
      state.analysis.reviewBaselineLists = cloneData(state.referenceLists || []);
      state.analysis.reviewWorkingLists = cloneData(state.referenceLists || []);
      state.analysis.reviewExcludedScfs = {};
      state.analysis.reviewZeroRateRemovals = [];
      showAnalysisPanel("compare-review");
      ensureVisibleAnalysisPanel();
      setStatus("analysis-comparison-selection-status", "Review the comparison and work from the testing copy of the lists.");
    } catch (error) {
      setStatus("analysis-comparison-status", `Unable to save comparisons: ${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  };

  analysisHomeNextButton?.addEventListener("click", async () => {
    await handleCompleteComparisonSetup(analysisHomeNextButton);
  });

  completeComparisonSetupButton?.addEventListener("click", async () => {
    await handleCompleteComparisonSetup(completeComparisonSetupButton);
  });

  backToRunsButton?.addEventListener("click", () => {
    showAnalysisPanel("workspace");
  });

  exitComparisonSetupButton?.addEventListener("click", () => {
    showAnalysisPanel("home");
  });

  saveComparisonReviewButton?.addEventListener("click", async () => {
    if (isCurrentAnalysisReadOnly()) {
      setStatus("analysis-comparison-status", "Completed analyses are read-only until you undo the completion.");
      return;
    }
    saveComparisonReviewButton.disabled = true;
    setStatus("analysis-comparison-status", "Saving comparison setup...");
    try {
      await saveComparisonSetup("Comparison setup saved.");
    } catch (error) {
      setStatus("analysis-comparison-status", `Unable to save comparison setup: ${error.message}`);
    } finally {
      saveComparisonReviewButton.disabled = false;
    }
  });

  backToComparisonSetupButton?.addEventListener("click", () => {
    showAnalysisPanel("home");
  });

  backToAnalysisRunsFromReviewButton?.addEventListener("click", () => {
    showAnalysisPanel("workspace");
  });

  exitComparisonReviewButton?.addEventListener("click", () => {
    showAnalysisPanel("home");
  });

  comparisonReviewPanel?.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("button") : null;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.id === "back-to-comparison-setup-button" && !target.disabled) {
      showAnalysisPanel("home");
      return;
    }

    if (target.id === "back-to-analysis-runs-from-review-button" && !target.disabled) {
      showAnalysisPanel("workspace");
      return;
    }

    if (target.id === "exit-comparison-review-button" && !target.disabled) {
      if (isAnalysisReviewPopupWindow()) {
        window.close();
      } else {
        showAnalysisPanel("home");
      }
      return;
    }

    if (target.id === "open-comparison-review-popup-button" && !target.disabled) {
      openComparisonReviewPopup();
      return;
    }

    if (target.id === "summarize-comparison-review-button" && !target.disabled) {
      summarizeComparisonReview();
      return;
    }

    if (target.id === "reset-analysis-review-button" && !target.disabled) {
      if (!confirm("Reset this analysis and restore the pending mailing lists back to where they were at the beginning?")) {
        return;
      }
      if (!resetAnalysisWorkingState()) {
        return;
      }
      renderAnalysisComparisonReviewPanel();
      return;
    }

    if (target.id === "complete-comparison-review-button" && !target.disabled) {
      void completeComparisonReview();
      return;
    }

    if (target.id === "undo-latest-comparison-complete-button" && !target.disabled) {
      void undoLatestCompletedComparisonReview();
    }
  });

  deleteSelectedReportsButton?.addEventListener("click", async () => {
    await deleteSelectedAnalysisReports();
  });

  selectAllReportsCheckbox?.addEventListener("change", () => {
    const reportIds = ensureArray(state.analysis.savedReports)
      .filter((report) => report.canDelete === true || report.can_delete === true)
      .map((report) => String(report.id || "").trim())
      .filter(Boolean);
    if (selectAllReportsCheckbox.checked) {
      setSelectedAnalysisReportIds(reportIds);
    } else {
      setSelectedAnalysisReportIds([]);
    }
    all("[data-select-report]").forEach((input) => {
      input.checked = selectAllReportsCheckbox.checked;
    });
    updateAnalysisReportSelectionUi();
  });

  compareContainer?.addEventListener("input", (event) => {
    if (isCurrentAnalysisReadOnly()) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const comparisonId = target.getAttribute("data-comparison-id");
    const field = target.getAttribute("data-comparison-field");
    if (!comparisonId || !field) return;
    const link = state.analysis.comparisonLinks.find((entry) => entry.id === comparisonId);
    if (!link) return;
    link[field] = target.value;
    link.updatedAt = new Date().toISOString();
    state.analysis.lastEditedComparisonId = comparisonId;
    if (field === "comparisonName") {
      const comparisonCard = target.closest("[data-comparison-id]");
      const comparisonTitle = comparisonCard?.querySelector(".analysis-comparison-card-head strong");
      if (comparisonTitle) {
        const comparisonIndex = state.analysis.comparisonLinks.findIndex((entry) => entry.id === comparisonId);
        comparisonTitle.textContent = resolveComparisonName(target.value, comparisonIndex >= 0 ? comparisonIndex : 0);
      }
    }
    persistAnalysisSetupDraft();
    refreshAnalysisSetupValidationUi();
    scheduleComparisonSetupAutosave({ delayMs: 600 });
  });

  compareContainer?.addEventListener("click", (event) => {
    if (isCurrentAnalysisReadOnly()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("data-action") !== "remove-comparison-link") return;
    const comparisonId = target.getAttribute("data-comparison-id");
    if (!comparisonId) return;
    state.analysis.comparisonLinks = state.analysis.comparisonLinks.filter(
      (entry) => entry.id !== comparisonId
    );
    if (!state.analysis.comparisonLinks.length) {
      state.analysis.comparisonLinks = [createComparisonLink(0)];
    }
    persistAnalysisSetupDraft();
    renderAnalysisComparePanel();
    setStatus("analysis-comparison-status", "Comparison removed.");
    scheduleComparisonSetupAutosave({ immediate: true });
  });

  runComparisonsButton?.addEventListener("click", () => {
    renderAnalysisComparisonReviewPanel();
  });
}

function bindMonthlyActions() {
  const monthInput = el("report-month");
  if (monthInput && !monthInput.value) {
    const now = new Date();
    now.setUTCMonth(now.getUTCMonth() - 1);
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    monthInput.value = month;
  }

  const runReportButton = el("run-report-button");
  const clearMonthlyOutputButton = el("clear-monthly-output-button");
  const allReportsButton = el("monthly-run-all-button");
  const outputEmptyState = el("preview-empty-state");
  const outputResults = el("preview-results");
  const monthlyOutputRunList = el("monthly-output-run-list");
  const reportHistoryBody = el("report-history-body");
  const normalizeSelectableMonthlyReportType = (reportType) => {
    const normalized = String(reportType || "").trim();
    return MONTHLY_SELECTABLE_REPORT_TYPES.includes(normalized)
      ? normalized
      : "transaction-summary";
  };

  const getPreviousMonthValue = () => {
    const previousMonth = new Date();
    previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
    return `${previousMonth.getUTCFullYear()}-${String(previousMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  const normalizeReportMonth = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const compactMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
    const slashMatch = raw.match(/^(\d{4})\/(\d{1,2})$/);
    const monthNameMatch = raw.match(
      /^\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{4})\s*$/i
    );
    const match = compactMatch || slashMatch || monthNameMatch;

    let yearRaw = "";
    let monthRaw = "";

    if (!match) return "";

    if (monthNameMatch) {
      yearRaw = monthNameMatch[2];
      const monthName = monthNameMatch[1].toLowerCase().slice(0, 3);
      const monthLookup = {
        jan: 1,
        feb: 2,
        mar: 3,
        apr: 4,
        may: 5,
        jun: 6,
        jul: 7,
        aug: 8,
        sep: 9,
        oct: 10,
        nov: 11,
        dec: 12,
      };
      monthRaw = monthLookup[monthName] || "";
    } else {
      [, yearRaw, monthRaw] = match;
    }

    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return "";
    }
    return `${year}-${String(month).padStart(2, "0")}`;
  };

  const getCurrentMonthSelection = () => {
    const month = normalizeReportMonth(monthInput?.value);
    if (month) {
      return month;
    }
    const fallback = getPreviousMonthValue();
    if (monthInput) {
      monthInput.value = fallback;
    }
    return fallback;
  };

  const getHistoryArtifact = (run, artifactKinds = []) => {
    if (!run) {
      return null;
    }

    const normalizedKinds = Array.isArray(artifactKinds)
      ? artifactKinds.map((entry) => String(entry || "").trim().toLowerCase())
      : [];
    if (!normalizedKinds.length) {
      return null;
    }

    return ensureArray(run.artifacts).find((artifact) => {
      const kind = String(artifact?.kind || "").trim().toLowerCase();
      return normalizedKinds.includes(kind);
    }) || null;
  };

  const renderReportHistoryRows = (runs) => {
    if (!reportHistoryBody) {
      return;
    }

    const normalizedRuns = ensureArray(runs)
      .map((entry) => ({
        ...entry,
        _sortMonth: String(entry?.reportMonth || "").trim(),
      }))
      .filter((entry) => entry.reportMonth);

    normalizedRuns.sort((left, right) => {
      if (left._sortMonth !== right._sortMonth) {
        return String(right._sortMonth).localeCompare(String(left._sortMonth));
      }
      return (
        new Date(right?.updatedAt || right?.createdAt || 0).getTime() -
        new Date(left?.updatedAt || left?.createdAt || 0).getTime()
      );
    });

    const empty = el("report-history-empty-row");
    if (empty) {
      empty.remove();
    }
    reportHistoryBody.innerHTML = "";

    if (!normalizedRuns.length) {
      const row = document.createElement("tr");
      row.innerHTML = '<td colspan="6" class="empty-cell">No report history yet.</td>';
      reportHistoryBody.appendChild(row);
      return;
    }

    normalizedRuns.forEach((run) => {
      const reportName = esc(run.reportName || MONTHLY_REPORT_LABELS[run.reportType] || "Month-End Report");
      const reportMonth = esc(run.reportMonthLabel || formatRunMonth(run.reportMonth));
      const runDate = esc(formatDate(run.updatedAt || run.createdAt || ""));
      const status = esc(String(run.status || "").trim() || "queued");
      const excelArtifact = getHistoryArtifact(run, ["spreadsheet"]);
      const printArtifact = getHistoryArtifact(run, [
        "print",
        "summary-letter-preview",
      ]) || getHistoryArtifact(run, ["summary-letter", "summary-letter-html"]);

      reportHistoryBody.appendChild(Object.assign(document.createElement("tr"), {
        innerHTML: `
          <td>${reportName}</td>
          <td>${reportMonth}</td>
          <td>${runDate}</td>
          <td>${status}</td>
          <td>${
            excelArtifact
              ? `<a href="${esc(String(excelArtifact.url || ""))}" download="${esc(String(excelArtifact.fileName || "monthly-report.xlsx"))}">${esc(String(excelArtifact.fileName || "Download Excel"))}</a>`
              : "-"
          }</td>
          <td>${
            printArtifact
              ? `<a href="${esc(String(printArtifact.url || ""))}" target="_blank">${esc(String(printArtifact.fileName || "Download"))}</a>`
              : "-"
          }</td>
        `,
      }));
    });
  };

  state.monthly.refreshHistory = async () => {
    try {
      const payload = await apiRequest("/api/monthly-reports");
      const runs = Array.isArray(payload?.runs) ? payload.runs : [];
      renderReportHistoryRows(runs);
      const latest = Array.isArray(runs) && runs.length
        ? runs.filter((entry) => String(entry?.status || "").toLowerCase() !== "running")
            .sort((left, right) => new Date(right?.updatedAt || right?.createdAt || 0).getTime() - new Date(left?.updatedAt || left?.createdAt || 0).getTime())[0]
        : null;
      if (latest && latest.reportMonthLabel) {
        setStatus("report-status-text", `Loaded report history through ${latest.reportMonthLabel}.`);
      }
    } catch (error) {
      if (reportHistoryBody) {
        const row = document.createElement("tr");
        row.innerHTML = `<td colspan="6" class="empty-cell">Unable to load report history: ${esc(error.message)}</td>`;
        reportHistoryBody.innerHTML = "";
        reportHistoryBody.appendChild(row);
      }
    }
  };

  const formatMonthOrDefault = (month) => formatRunMonth(month || getPreviousMonthValue());

  const getRunSortTime = (run) =>
    new Date(run?.updatedAt || run?.createdAt || 0).getTime();

  const isMonthlyRunStillActive = (run) => {
    const status = String(run?.status || "").trim().toLowerCase();
    if (!status || status === "complete" || status === "failed") {
      return false;
    }
    const lastUpdatedAt = getRunSortTime(run);
    if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt <= 0) {
      return false;
    }
    return Date.now() - lastUpdatedAt <= MONTHLY_STALE_RUN_MS;
  };

  const normalizeMonthlyRunForDisplay = (run) => {
    if (!run) {
      return run;
    }
    const artifacts = ensureArray(run?.artifacts).filter(isMonthlyOutputDownloadArtifact);
    if (artifacts.length) {
      return {
        ...run,
        status: "complete",
        statusDetail:
          run?.statusDetail ||
          "Saved report artifacts are available for download.",
      };
    }
    if (isMonthlyRunStillActive(run)) {
      return run;
    }
    const status = String(run?.status || "").trim().toLowerCase();
    if (status !== "running") {
      return run;
    }
    return {
      ...run,
      status: "failed",
      statusDetail:
        "This older report run did not finish. Use the last completed output below or rerun this report.",
    };
  };

  const getMonthlyRunDisplayPriority = (run) => {
    const normalizedRun = normalizeMonthlyRunForDisplay(run);
    const status = String(normalizedRun?.status || "").trim().toLowerCase();
    if (status === "running") return 3;
    if (status === "complete") return 2;
    if (status === "failed") return 1;
    return 0;
  };

  const getArtifactDisplayLabel = (artifact) => {
    const kind = String(artifact?.kind || "").trim().toLowerCase();
    if (kind === "spreadsheet") return "Download Excel";
    if (kind === "print") return String(artifact?.label || "").trim() || "Download PDF";
    return artifact?.label || "Download File";
  };

  const isMonthlyOutputDownloadArtifact = (artifact) => {
    const kind = String(artifact?.kind || "").trim().toLowerCase();
    return kind === "spreadsheet" || kind === "print";
  };

  const buildMonthlyArtifactMarkup = (run, artifact) => {
    const label = getArtifactDisplayLabel(artifact);
    const safeUrl = esc(String(artifact?.url || ""));
    const safeName = esc(String(artifact?.fileName || `${run.reportType || "month-end-report"}.dat`));
    const safeLabel = esc(label);
    const safeFileName = esc(String(artifact?.fileName || "No file"));
    const monthLabel = esc(String(run?.reportMonthLabel || formatMonthOrDefault(run?.reportMonth)));

    return `
      <div class="monthly-output-run-artifact">
        <span class="field-label">${safeLabel}</span>
        <strong>${safeFileName}</strong>
        <p class="monthly-output-run-artifact-copy">Month: ${monthLabel}</p>
        <div class="monthly-output-run-actions">
          <button
            class="secondary-button monthly-output-download-button"
            data-download-url="${safeUrl}"
            data-download-name="${safeName}"
          >
            ${safeLabel}
          </button>
        </div>
      </div>
    `;
  };

  const buildMonthlyRunCardMarkup = (run) => {
    const displayRun = normalizeMonthlyRunForDisplay(run);
    const reportName = esc(String(displayRun?.reportName || MONTHLY_REPORT_LABELS[displayRun?.reportType] || "Month-End Report"));
    const monthLabel = esc(String(displayRun?.reportMonthLabel || formatMonthOrDefault(displayRun?.reportMonth)));
    const status = esc(String(displayRun?.status || "queued"));
    const statusDetail = esc(
      String(
        displayRun?.statusDetail || (String(displayRun?.status || "").toLowerCase() === "complete" ? "Completed." : "Waiting for output.")
      )
    );
    const artifacts = ensureArray(displayRun?.artifacts).filter(isMonthlyOutputDownloadArtifact);
    const artifactMarkup = artifacts.length
      ? artifacts.map((artifact) => buildMonthlyArtifactMarkup(displayRun, artifact)).join("")
      : `<p class="monthly-output-run-empty">Artifacts are not ready yet for ${monthLabel}.</p>`;

    return `
      <article class="monthly-output-run-card">
        <div class="monthly-output-run-heading">
          <div>
            <span class="field-label">Report Output</span>
            <strong>${reportName}</strong>
            <p class="monthly-output-run-meta">Month: ${monthLabel}</p>
          </div>
          <div class="monthly-output-run-status">
            <span class="field-label">Status</span>
            <strong>${status}</strong>
          </div>
        </div>
        <p>${statusDetail}</p>
        <div class="monthly-output-run-list">
          ${artifactMarkup}
        </div>
      </article>
    `;
  };

  const getLatestVisibleRunsForMonth = (runs, month) => {
    const selectedMonth = String(month || "").trim();
    if (!selectedMonth) {
      return [];
    }

    const latestByType = new Map();
    ensureArray(runs)
      .filter((entry) => String(entry?.reportMonth || "").trim() === selectedMonth)
      .sort((left, right) => {
        const priorityDifference = getMonthlyRunDisplayPriority(right) - getMonthlyRunDisplayPriority(left);
        if (priorityDifference) {
          return priorityDifference;
        }
        return getRunSortTime(right) - getRunSortTime(left);
      })
      .forEach((entry) => {
        const typeKey = String(entry?.reportType || "").trim();
        if (typeKey && !latestByType.has(typeKey)) {
          latestByType.set(typeKey, normalizeMonthlyRunForDisplay(entry));
        }
      });

    return [...latestByType.values()].sort((left, right) => {
      const leftIndex = MONTHLY_ALL_REPORT_TYPES.indexOf(String(left?.reportType || "").trim());
      const rightIndex = MONTHLY_ALL_REPORT_TYPES.indexOf(String(right?.reportType || "").trim());
      const normalizedLeftIndex = leftIndex >= 0 ? leftIndex : MONTHLY_ALL_REPORT_TYPES.length;
      const normalizedRightIndex = rightIndex >= 0 ? rightIndex : MONTHLY_ALL_REPORT_TYPES.length;
      return normalizedLeftIndex - normalizedRightIndex || getRunSortTime(right) - getRunSortTime(left);
    });
  };

  const renderMonthlyOutputRuns = (runs, primaryRun = null) => {
    if (!outputResults || !outputEmptyState || !monthlyOutputRunList) {
      return;
    }

    const visibleRuns = ensureArray(runs);
    if (!visibleRuns.length) {
      clearMonthlyOutput();
      return;
    }

    outputEmptyState.classList.add("is-hidden");
    outputResults.classList.remove("is-hidden");
    monthlyOutputRunList.innerHTML = visibleRuns.map((run) => buildMonthlyRunCardMarkup(run)).join("");

    const highlightedRun = primaryRun || visibleRuns[0];
    if (highlightedRun?.reportMonthLabel) {
      const displayLabel = getModeLabel();
      if (state.monthly.reportRunMode === "all") {
        setStatus("report-status-text", `${MONTHLY_ALL_REPORT_LABEL} for ${highlightedRun.reportMonthLabel}`);
      } else {
        setStatus("report-status-text", `${displayLabel} for ${highlightedRun.reportMonthLabel}`);
      }
    }
    setStatus(
      "report-status-detail",
      highlightedRun?.statusDetail || `Showing ${visibleRuns.length} saved month-end report output item(s).`
    );
  };

  const setMonthlyOutput = (run, allRuns = []) => {
    if (!run || !outputResults || !outputEmptyState) return;
    const selectedMonth = String(run.reportMonth || getCurrentMonthSelection()).trim();
    const visibleRuns = getLatestVisibleRunsForMonth(allRuns, selectedMonth);
    renderMonthlyOutputRuns(visibleRuns.length ? visibleRuns : [run], run);
    const reportName = run.reportName || MONTHLY_REPORT_LABELS[run.reportType] || "Month-End Report";

    if (run.reportMonthLabel) {
      const displayLabel = getModeLabel();
      if (state.monthly.reportRunMode === "all") {
        setStatus("report-status-text", `${MONTHLY_ALL_REPORT_LABEL} for ${run.reportMonthLabel}`);
      } else {
        setStatus("report-status-text", `${displayLabel} for ${run.reportMonthLabel}`);
      }
    }
    setStatus("report-status-detail", run.statusDetail || `Latest output: ${reportName}.`);
  };

  const clearMonthlyOutput = () => {
    if (!outputResults || !outputEmptyState) return;
    if (outputResults) {
      outputResults.classList.add("is-hidden");
    }
    outputEmptyState.classList.remove("is-hidden");
    if (monthlyOutputRunList) {
      monthlyOutputRunList.innerHTML = "";
    }
  };

  const attachBatchLetterArtifacts = (run, allRuns, runIds) => {
    if (!run || !Array.isArray(allRuns) || !Array.isArray(runIds) || !runIds.length) {
      return run;
    }

    const runClone = cloneData(run);
    const currentArtifacts = Array.isArray(runClone.artifacts) ? runClone.artifacts : [];
    const hasLetterArtifact = currentArtifacts.some((artifact) =>
      ["summary-letter", "summary-letter-preview", "print"].includes(String(artifact?.kind || "").trim())
    );
    if (hasLetterArtifact) {
      return runClone;
    }

    const matchingLetterRun = allRuns.find((entry) => {
      const runId = String(entry?.id || "").trim();
      return (
        runIds.includes(runId) &&
        String(entry?.reportType || "").trim() === "final-summary-letter" &&
        String(entry?.reportMonth || "").trim() === String(runClone.reportMonth || "").trim()
      );
    });
    if (!matchingLetterRun || !Array.isArray(matchingLetterRun.artifacts) || !matchingLetterRun.artifacts.length) {
      return runClone;
    }

    const letterArtifacts = matchingLetterRun.artifacts.filter((artifact) =>
      ["summary-letter", "summary-letter-preview", "summary-letter-json", "print"].includes(
        String(artifact?.kind || "").trim()
      )
    );
    if (!letterArtifacts.length) {
      return runClone;
    }

    runClone.artifacts = [...currentArtifacts, ...letterArtifacts];
    if (matchingLetterRun.report?.finalSummaryLetter) {
      runClone.report = runClone.report || {};
      runClone.report.finalSummaryLetter = matchingLetterRun.report.finalSummaryLetter;
    }
    return runClone;
  };

  const pickRunForOutput = (runs, preferredId = "") => {
    if (!Array.isArray(runs) || !runs.length) return null;
    if (preferredId) {
      const preferredRun = runs.find((entry) => String(entry.id || "") === String(preferredId));
      if (preferredRun) return preferredRun;
    }

    const mode = state.monthly.reportRunMode;
    const selectedMonth = getCurrentMonthSelection();

    if (mode === "all" && state.monthly.runAllIds.length) {
      const batchRuns = runs.filter((entry) =>
        state.monthly.runAllIds.includes(String(entry.id || ""))
      );
      if (!batchRuns.length) return null;

      const batchSummaryRun = batchRuns.find((entry) =>
        String(entry.reportType || "") === "transaction-summary" &&
        String(entry.reportMonth || "") === selectedMonth
      );
      if (batchSummaryRun) {
        return attachBatchLetterArtifacts(batchSummaryRun, runs, state.monthly.runAllIds);
      }

      const runningRuns = batchRuns.filter((entry) => !["complete", "failed"].includes(String(entry.status || "").toLowerCase()));
      const activeRunningRuns = runningRuns.filter((entry) => isMonthlyRunStillActive(entry));
      if (activeRunningRuns.length) {
        activeRunningRuns.sort(
          (left, right) =>
            new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
        );
        return activeRunningRuns[0];
      }
      const completeRuns = batchRuns.filter((entry) => String(entry.status || "").toLowerCase() === "complete");
      if (completeRuns.length) {
        completeRuns.sort(
          (left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
        );
        return attachBatchLetterArtifacts(completeRuns[0], runs, state.monthly.runAllIds);
      }
      return batchRuns[0];
    }

    const selectedMonthRuns = runs.filter(
      (entry) =>
        (
          String(state.monthly.reportType) === "final-summary-letter"
            ? String(entry.reportType || "") === "transaction-summary"
            : String(entry.reportType || "") === String(state.monthly.reportType)
        ) &&
        String(entry.reportMonth || "") === selectedMonth
    );
    if (selectedMonthRuns.length) {
      selectedMonthRuns.sort((left, right) => {
        const priorityDifference = getMonthlyRunDisplayPriority(right) - getMonthlyRunDisplayPriority(left);
        if (priorityDifference) {
          return priorityDifference;
        }
        return getRunSortTime(right) - getRunSortTime(left);
      });
      return normalizeMonthlyRunForDisplay(selectedMonthRuns[0]);
    }
    return null;
  };

  const findActiveBatchRuns = (runs, month) => {
    const selectedMonth = String(month || "").trim();
    const batchRuns = ensureArray(runs).filter((entry) =>
      String(entry?.options?.source || "").trim().toLowerCase() === "batch"
      && String(entry?.reportMonth || "").trim() === selectedMonth
    );
    if (!batchRuns.length) {
      return [];
    }

    const activeBatchId = batchRuns.find((entry) =>
      isMonthlyRunStillActive(entry)
      && String(entry?.options?.batchId || "").trim()
    )?.options?.batchId;

    if (activeBatchId) {
      return batchRuns.filter((entry) => String(entry?.options?.batchId || "").trim() === String(activeBatchId));
    }
    return [];
  };

  const resumeMonthlyProgressFromRuns = (runs = []) => {
    const selectedMonth = getCurrentMonthSelection();
    const activeBatchRuns = findActiveBatchRuns(runs, selectedMonth);
    const activeBatchIds = activeBatchRuns
      .map((entry) => String(entry?.id || "").trim())
      .filter(Boolean);

    if (activeBatchIds.length) {
      state.monthly.reportRunMode = "all";
      syncReportTypeButtons();
      setRunButtonLabel();
      startAllReportProgressTracking(activeBatchIds, formatRunMonth(selectedMonth));
      return true;
    }

    const activeSingleRun = ensureArray(runs).find((entry) =>
      String(entry?.reportMonth || "").trim() === selectedMonth
      && String(entry?.options?.source || "").trim().toLowerCase() !== "batch"
      && MONTHLY_SELECTABLE_REPORT_TYPES.includes(String(entry?.reportType || "").trim())
      && isMonthlyRunStillActive(entry)
    );

    if (activeSingleRun?.id) {
      state.monthly.reportRunMode = "single";
      state.monthly.reportType = normalizeSelectableMonthlyReportType(
        activeSingleRun.reportType || state.monthly.reportType || "transaction-summary"
      );
      state.monthly.singleRunId = String(activeSingleRun.id || "");
      syncReportTypeButtons();
      setRunButtonLabel();
      setRunningControls(true);
      startSingleReportProgress(
        state.monthly.singleRunId,
        state.monthly.reportType,
        activeSingleRun.reportMonthLabel || formatRunMonth(selectedMonth)
      );
      return true;
    }

    state.monthly.reportType = normalizeSelectableMonthlyReportType(state.monthly.reportType);
    state.monthly.singleRunId = "";
    state.monthly.runAllIds = [];
    setReportRunningState("", false);
    setRunningControls(false);
    syncReportTypeButtons();
    setRunButtonLabel();

    return false;
  };

  const refreshMonthlyOutput = async () => {
    try {
      const payload = await apiRequest("/api/monthly-reports");
      const runs = Array.isArray(payload?.runs) ? payload.runs : [];
      resumeMonthlyProgressFromRuns(runs);
      const run = pickRunForOutput(runs, state.monthly.singleRunId);
      if (run) {
        setMonthlyOutput(run, runs);
        return;
      }
      clearMonthlyOutput();
    } catch (error) {
      setStatus("report-status-detail", `Unable to load report output: ${error.message}`);
      clearMonthlyOutput();
    }
  };

  const stopSingleReportProgress = () => {
    if (state.monthly.singleRunMonitorHandle) {
      clearTimeout(state.monthly.singleRunMonitorHandle);
    }
    state.monthly.singleRunMonitorHandle = null;
  };

  const startSingleReportProgress = (runId, reportType, monthLabel) => {
    stopSingleReportProgress();
    if (!runId) {
      return;
    }
    const poll = async () => {
      try {
        const payload = await apiRequest(`/api/monthly-reports/${encodeURIComponent(runId)}`);
        const run = payload.run || {};
        const allRunsPayload = await apiRequest("/api/monthly-reports");
        const allRuns = Array.isArray(allRunsPayload?.runs) ? allRunsPayload.runs : [run];
        setMonthlyOutput(run, allRuns);
        const status = String(run.status || "").toLowerCase();
        if (status === "complete") {
          setReportRunningState("", false);
          setStatusComplete(
            `${getRunLabel(reportType)} completed for ${monthLabel}`,
            run.statusDetail || "Report generation completed."
          );
          state.monthly.singleRunId = String(runId || "");
          setRunningControls(false);
          setRunButtonLabel();
          stopSingleReportProgress();
          return;
        }
        if (status === "failed") {
          setReportRunningState("", false);
          setStatus("report-status-text", `${getRunLabel(reportType)} Failed`);
          setStatus("report-status-detail", run.statusDetail || "Report generation failed.");
          setRunningControls(false);
          setRunButtonLabel();
          stopSingleReportProgress();
          return;
        }

        state.monthly.singleRunMonitorHandle = setTimeout(
          poll,
          1500
        );
      } catch (error) {
        setStatus("report-status-detail", `Unable to read report progress: ${error.message}`);
        setReportRunningState("", false);
        setRunningControls(false);
        setRunButtonLabel();
        stopSingleReportProgress();
      }
    };

    state.monthly.singleRunMonitorHandle = setTimeout(poll, 1200);
  };

  outputResults?.addEventListener("click", async (event) => {
    const button = event.target instanceof HTMLElement
      ? event.target.closest(".monthly-output-download-button")
      : null;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const url = String(button.dataset.downloadUrl || "").trim();
    const fileName = String(button.dataset.downloadName || "month-end-report").trim();
    if (!url) {
      setStatus("report-status-detail", "No file is available for this run yet.");
      return;
    }

    try {
      await apiDownload(url, fileName);
      setStatus("report-status-detail", `Downloaded ${fileName}.`);
    } catch (error) {
      setStatus("report-status-detail", `Download failed: ${error.message}`);
    }
  });

  const reportTypeButtons = all(UI.reportTypeButtons);
  const getSelectedReportButton = () =>
    reportTypeButtons.find(
      (button) => button.getAttribute("data-report-picker") === normalizeSelectableMonthlyReportType(state.monthly.reportType)
    );

  const getRunLabel = (reportType) => MONTHLY_REPORT_LABELS[reportType] || "Month-end Report";
  const getModeLabel = () => {
    if (state.monthly.reportRunMode === "all") return MONTHLY_ALL_REPORT_LABEL;
    return getRunLabel(normalizeSelectableMonthlyReportType(state.monthly.reportType));
  };
  const formatRunMonth = (month) => {
    return formatMonthLabel(month);
  };
  const setRunButtonLabel = () => {
    if (!runReportButton) return;
    const label = getModeLabel();
    if (state.monthly.reportRunMode === "all") {
      runReportButton.textContent = `Run ${label}`;
    } else {
      const reportLabel = label === "Month-end Report" ? label : `${label} Report`;
      runReportButton.textContent = `Run ${reportLabel}`;
    }
  };
  const setStatusRunning = (label, monthLabel) => {
    const period = formatRunMonth(monthLabel);
    setStatus("report-status-text", `${label} Starting for ${period}`);
    setStatus("report-status-detail", `Starting ${label} for ${period}...`);
  };
  const setStatusComplete = (text, detail) => {
    setStatus("report-status-text", text);
    setStatus("report-status-detail", detail);
  };

  const stopAllReportProgress = () => {
    if (state.monthly.runAllMonitorHandle) {
      clearInterval(state.monthly.runAllMonitorHandle);
    }
    state.monthly.runAllMonitorHandle = null;
  };

  const setRunningControls = (disabled) => {
    if (runReportButton) runReportButton.disabled = disabled;
    if (clearMonthlyOutputButton) clearMonthlyOutputButton.disabled = disabled;
    if (allReportsButton) allReportsButton.disabled = disabled;
    reportTypeButtons.forEach((button) => {
      button.disabled = disabled;
    });
  };

  const updateRunProgress = (runIndex, totalRuns, periodLabel, status) => {
    const reportIndex = Math.min(totalRuns, Math.max(1, runIndex + 1));
    setStatus(
      "report-status-text",
      `Running report ${reportIndex}/${totalRuns} for ${periodLabel}`
    );
    setStatus(
      "report-status-detail",
      status || `Running report ${reportIndex} of ${totalRuns}.`
    );
  };

  const startAllReportProgressTracking = (runIds, periodLabel) => {
    if (!runIds.length) {
      stopAllReportProgress();
      setStatus("report-status-text", "No reports queued.");
      setStatus("report-status-detail", "No batch report IDs were returned.");
      setRunningControls(false);
      return;
    }

    state.monthly.runAllIds = runIds;

    const computeProgress = async () => {
      try {
        const reportPayload = await apiRequest("/api/monthly-reports");
        const allRuns = Array.isArray(reportPayload?.runs) ? reportPayload.runs : [];
        const runById = new Map(allRuns.map((entry) => [entry.id, entry]));
        const resolvedRuns = runIds.map((id) => runById.get(id) || null);
        const summaryRun = resolvedRuns.find(
          (run) => String(run?.reportType || "").toLowerCase() === "transaction-summary"
        );
        const finalLetterRun = resolvedRuns.find(
          (run) => String(run?.reportType || "").toLowerCase() === "final-summary-letter"
        );
        const summaryHasLetter = Array.isArray(summaryRun?.artifacts) && summaryRun.artifacts.some((artifact) =>
          ["summary-letter", "summary-letter-preview"].includes(String(artifact?.kind || "").trim())
        );
        const finalRunHasLetter = Array.isArray(finalLetterRun?.artifacts) && finalLetterRun.artifacts.some((artifact) =>
          ["summary-letter", "summary-letter-preview"].includes(String(artifact?.kind || "").trim())
        );

        if (
          summaryRun &&
          String(summaryRun.status || "").toLowerCase() === "complete" &&
          finalLetterRun &&
          String(finalLetterRun.status || "").toLowerCase() === "running"
        ) {
          if (!summaryHasLetter && !finalRunHasLetter && summaryRun.id) {
            try {
              await apiRequest(`/api/monthly-reports/${encodeURIComponent(summaryRun.id)}/final-summary-letter`, {
                method: "POST",
              });
            } catch {
              // Keep polling; the backend batch monitor may still finish the letter run.
            }
          }
        }

        const activeIndex = resolvedRuns.findIndex((run) => {
          const status = String(run?.status || "").toLowerCase();
          if (!isMonthlyRunStillActive(run)) {
            return false;
          }
          if (
            String(run?.reportType || "").toLowerCase() === "final-summary-letter" &&
            (summaryHasLetter || finalRunHasLetter)
          ) {
            return false;
          }
          return status !== "complete" && status !== "failed";
        });

        const summaryWithLetter = summaryRun
          ? attachBatchLetterArtifacts(summaryRun, allRuns, runIds)
          : null;

        if (activeIndex < 0) {
          if (summaryWithLetter) {
            setMonthlyOutput(summaryWithLetter, allRuns);
          } else {
            const completeRuns = resolvedRuns
              .filter((run) => String(run?.status || "").toLowerCase() === "complete")
              .sort(
                (left, right) =>
                  new Date(right?.updatedAt || 0).getTime() - new Date(left?.updatedAt || 0).getTime()
              );
            if (completeRuns.length) {
              setMonthlyOutput(completeRuns[0], allRuns);
            } else if (resolvedRuns.length) {
              setMonthlyOutput(resolvedRuns[resolvedRuns.length - 1], allRuns);
            }
          }
          const failedCount = resolvedRuns.filter(
            (run) => String(run?.status || "").toLowerCase() === "failed"
          ).length;
          setReportRunningState("", false);
          stopAllReportProgress();
          setRunningControls(false);
          if (failedCount) {
            setStatus(
              "report-status-text",
              `${MONTHLY_ALL_REPORT_LABEL} Completed with ${failedCount} failure(s) for ${periodLabel}`
            );
            setStatus(
              "report-status-detail",
              `Batch complete for ${periodLabel}. ${failedCount} report did not complete successfully.`
            );
          } else {
            setStatus(
              "report-status-text",
              `${MONTHLY_ALL_REPORT_LABEL} Completed for ${periodLabel}`
            );
            setStatus(
              "report-status-detail",
              `All ${resolvedRuns.length} reports are complete for ${periodLabel}.`
            );
          }
          return;
        }

        const activeRun = resolvedRuns[activeIndex] || {};
        const activeReportType = activeRun.reportType || MONTHLY_ALL_REPORT_TYPES[activeIndex];
        const activeReportLabel = getRunLabel(activeReportType);
        const activeStatus = activeRun.statusDetail || "Report is running.";
        setReportRunningState(activeReportType, true);
        updateRunProgress(
          activeIndex,
          runIds.length,
          periodLabel,
          `Running report ${activeIndex + 1} of ${runIds.length}: ${activeReportLabel}` +
            ` (${activeStatus})`
        );
        if (summaryWithLetter) {
          setMonthlyOutput(summaryWithLetter, allRuns);
        } else {
          setMonthlyOutput(
            activeRun.status === "running" ? activeRun : resolvedRuns[runIds.length - 1] || activeRun,
            allRuns
          );
        }
      } catch (error) {
        setStatus("report-status-text", "Unable to fetch batch progress");
        setStatus("report-status-detail", `Batch progress tracking failed: ${error.message}`);
      }
    };

    if (state.monthly.runAllMonitorHandle) {
      clearInterval(state.monthly.runAllMonitorHandle);
    }
    void computeProgress();
    state.monthly.runAllMonitorHandle = setInterval(computeProgress, 1500);
  };

  const startSingleReportRun = async (type, month, period, button) => {
    if (!type) return;

    if (!runReportButton) return;
    setRunningControls(true);
    runReportButton.textContent = "Run in Progress";
    setStatusRunning(getRunLabel(type), period);
    setReportRunningState(type, true);
    if (button) {
      button.classList.add("is-running-report");
    }

    try {
      const response = await apiRequest("/api/monthly-reports/run", {
        method: "POST",
        body: { reportType: type, reportMonth: month },
      });
      state.monthly.singleRunId = String((response.run || {}).id || "");
      const run = response.run || {};
      const runPeriod = run.reportMonthLabel || formatRunMonth(run.reportMonth || month);
      setMonthlyOutput(run, [run]);
      startSingleReportProgress((response.run || {}).id, type, runPeriod);
      setStatusComplete(
        `${getRunLabel(type)} running for ${runPeriod}`,
        `Running ${getRunLabel(type)} for ${runPeriod}: ${(response.run || {}).id || "accepted"}`
      );
    } catch (error) {
      setStatus("report-status-text", "Run Failed");
      setStatus("report-status-detail", `Run failed: ${error.message}`);
      setReportRunningState(type, false);
      setRunningControls(false);
      setRunButtonLabel();
      stopSingleReportProgress();
    }
  };

  const startFinalSummaryLetterRun = async (month, period, button) => {
    if (!runReportButton) return;
    setRunningControls(true);
    runReportButton.textContent = "Run in Progress";
    setStatusRunning(getRunLabel("final-summary-letter"), period);
    setReportRunningState("final-summary-letter", true);
    if (button) {
      button.classList.add("is-running-report");
    }

    try {
      const payload = await apiRequest("/api/monthly-reports");
      const runs = Array.isArray(payload?.runs) ? payload.runs : [];
      const summaryRun = [...runs]
        .filter((entry) =>
          String(entry?.reportType || "").trim() === "transaction-summary"
          && String(entry?.reportMonth || "").trim() === String(month || "").trim()
          && String(entry?.status || "").trim().toLowerCase() === "complete"
        )
        .sort(
          (left, right) =>
            new Date(right?.updatedAt || right?.createdAt || 0).getTime()
            - new Date(left?.updatedAt || left?.createdAt || 0).getTime()
        )[0];

      if (!summaryRun?.id) {
        throw new Error("Run Transaction Summary for this month first, then generate the final summary letter.");
      }

      const response = await apiRequest(
        `/api/monthly-reports/${encodeURIComponent(summaryRun.id)}/final-summary-letter`,
        {
          method: "POST",
        }
      );
      const updatedRun = response?.run || summaryRun;
      const refreshedPayload = await apiRequest("/api/monthly-reports");
      const allRuns = Array.isArray(refreshedPayload?.runs) ? refreshedPayload.runs : [updatedRun];
      state.monthly.singleRunId = String(updatedRun?.id || "");
      setMonthlyOutput(updatedRun, allRuns);
      setStatusComplete(
        `${getRunLabel("final-summary-letter")} completed for ${period}`,
        updatedRun?.statusDetail || "Final summary letter generated."
      );
      setReportRunningState("", false);
      setRunningControls(false);
      setRunButtonLabel();
    } catch (error) {
      setStatus("report-status-text", "Run Failed");
      setStatus("report-status-detail", `Run failed: ${error.message}`);
      setReportRunningState("", false);
      setRunningControls(false);
      setRunButtonLabel();
    }
  };

  state.monthly.refreshOutput = refreshMonthlyOutput;

  const startAllReportsRun = async (month, period) => {
    setRunningControls(true);
    stopSingleReportProgress();
    stopAllReportProgress();
    setStatus("report-status-text", `Starting ${MONTHLY_ALL_REPORT_LABEL} for ${period}`);
    setStatus("report-status-detail", "Preparing month-end package.");

    try {
      const response = await apiRequest("/api/monthly-reports/run-all", {
        method: "POST",
        body: { reportMonth: month },
      });
      const batchPeriod = response?.batch?.reportMonthLabel || formatRunMonth(response?.batch?.reportMonth || month);
      const runIds = Array.isArray(response?.batch?.runs)
        ? response.batch.runs
            .map((entry) => (entry && entry.id ? String(entry.id) : ""))
            .filter(Boolean)
        : [];
      const count = runIds.length;
      setStatusComplete(
        `${MONTHLY_ALL_REPORT_LABEL} Started for ${batchPeriod}`,
        count ? `Batch started for ${batchPeriod}. ${count} report(s) queued.` : "Batch started."
      );
      if (!count) {
        setRunningControls(false);
        clearMonthlyOutput();
        return;
      }
      const initialRuns = Array.isArray(response?.batch?.runs) ? response.batch.runs : [];
      const initialSummaryRun = initialRuns.find(
        (entry) => String(entry?.reportType || "").toLowerCase() === "transaction-summary"
      ) || initialRuns[0];
      if (initialSummaryRun) {
        setMonthlyOutput(initialSummaryRun, initialRuns);
      }
      startAllReportProgressTracking(runIds, batchPeriod);
    } catch (error) {
      setRunningControls(false);
      setStatus("report-status-text", "Run Failed");
      setStatus("report-status-detail", `Run failed: ${error.message}`);
    }
  };

  const syncReportTypeButtons = () => {
    const selectedType = normalizeSelectableMonthlyReportType(state.monthly.reportType);
    state.monthly.reportType = selectedType;
    reportTypeButtons.forEach((button) => {
      const isSelected = button.getAttribute("data-report-picker") === selectedType;
      button.classList.toggle("is-active-report", isSelected);
    });
    if (allReportsButton) {
      allReportsButton.classList.toggle("is-active-report", state.monthly.reportRunMode === "all");
    }
  };

  const setReportRunningState = (reportType, running) => {
    reportTypeButtons.forEach((button) => {
      const isMatch = button.getAttribute("data-report-picker") === reportType;
      button.classList.toggle("is-running-report", running && isMatch);
    });
    if (allReportsButton && reportType) {
      allReportsButton.classList.toggle(
        "is-running-report",
        running &&
          state.monthly.reportRunMode === "all" &&
          !MONTHLY_RUN_BUTTON_TYPES.includes(reportType)
      );
    }
  };

  allReportsButton?.addEventListener("click", () => {
    state.monthly.reportRunMode = "all";
    setRunButtonLabel();
    syncReportTypeButtons();
    setStatus("report-status-text", "Ready");
    setStatus("report-status-detail", "All Reports mode selected. Saved output for the selected month will stay available until you explicitly clear that month.");
    state.monthly.singleRunId = "";
    stopSingleReportProgress();
    setReportRunningState("", false);
    setRunningControls(false);
    setRunButtonLabel();
    void refreshMonthlyOutput();
  });

  all(UI.reportTypeButtons).forEach((button) => {
    button.addEventListener("click", () => {
      state.monthly.reportRunMode = "single";
      stopSingleReportProgress();
      const reportType = button.getAttribute("data-report-picker");
      if (!reportType) return;
      state.monthly.reportType = reportType;
      setRunButtonLabel();
      syncReportTypeButtons();
      state.monthly.singleRunId = "";
      setStatus(
        "report-status-text",
        "Ready"
      );
      setStatus(
        "report-status-detail",
        `${getRunLabel(reportType)} settings selected. Saved output for the selected month remains available until you explicitly clear that month.`
      );
      void refreshMonthlyOutput();
    });
  });

  syncReportTypeButtons();
  setRunButtonLabel();
  void refreshMonthlyOutput();

  monthInput?.addEventListener("change", () => {
    state.monthly.singleRunId = "";
    stopSingleReportProgress();
    stopAllReportProgress();
    setReportRunningState("", false);
    setRunningControls(false);
    setRunButtonLabel();
    void refreshMonthlyOutput();
  });

  clearMonthlyOutputButton?.addEventListener("click", async () => {
    const month = getCurrentMonthSelection();
    try {
      const result = await apiRequest("/api/monthly-reports/clear-month", {
        method: "POST",
        body: { reportMonth: month },
      });
      state.monthly.singleRunId = "";
      state.monthly.runAllIds = [];
      stopSingleReportProgress();
      stopAllReportProgress();
      setReportRunningState("", false);
      setRunningControls(false);
      clearMonthlyOutput();
      setStatus(
        "report-status-text",
        `Cleared output for ${result?.reportMonthLabel || formatRunMonth(month)}`
      );
      setStatus(
        "report-status-detail",
        `${Number(result?.removedCount || 0)} saved run(s) removed for ${result?.reportMonthLabel || formatRunMonth(month)}.`
      );
      void refreshMonthlyOutput();
    } catch (error) {
      setStatus("report-status-detail", `Unable to clear current month output: ${error.message}`);
    }
  });

  runReportButton?.addEventListener("click", async () => {
    const type = normalizeSelectableMonthlyReportType(state.monthly.reportType);
    state.monthly.reportType = type;
    const month = getCurrentMonthSelection();
    const period = formatRunMonth(month);
    const button = getSelectedReportButton();
    if (!button) return;
    if (state.monthly.reportRunMode === "all") {
      await startAllReportsRun(month, period);
      return;
    }
    if (type === "final-summary-letter") {
      await startFinalSummaryLetterRun(month, period, button);
      return;
    }
    await startSingleReportRun(type, month, period, button);
  });
  window.addEventListener("beforeunload", stopAllReportProgress);
  window.addEventListener("beforeunload", stopSingleReportProgress);
  window.addEventListener("beforeunload", persistAnalysisSetupDraft);
  window.addEventListener("pagehide", persistAnalysisSetupDraft);

}

function bindNavigation() {
  all(UI.navButtons).forEach((button) => {
    button.addEventListener("click", () => {
      const route = button.getAttribute("data-route");
      if (route) setRoute(route);
    });
  });
}

function bindPrimaryNavigation() {
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const routeButton = target.closest("[data-route]");
    if (routeButton instanceof HTMLElement) {
      const route = routeButton.getAttribute("data-route");
      if (route) {
        if (route === "analysis") {
          openAnalysisList().catch((error) => {
            setStatus("analysis-setup-status", `Unable to open analyses: ${error.message}`);
          });
        } else {
          setRoute(route);
        }
      }
      return;
    }

    const actionButton = target.closest("[data-action]");
    if (!(actionButton instanceof HTMLElement)) {
      if (target.closest("#run-all-month-end-button")) {
        setRoute("monthly-reports");
      }
      return;
    }

    const action = actionButton.getAttribute("data-action");
    if (action === "toggle-analysis-submenu") {
      event.preventDefault();
      toggleAnalysisLeftSubmenu();
      return;
    }

    if (action === "open-analysis") {
      openAnalysisLanding().catch((error) => {
        setStatus("analysis-setup-status", `Unable to open analysis: ${error.message}`);
      });
      return;
    }

    if (action === "open-history") {
      setRoute("report-history");
      return;
    }

    if (action === "open-reference-list") {
      const listType = actionButton.getAttribute("data-list-type");
      if (!listType) return;
      await openAnalysisMailingList(listType);
      return;
    }
  });

  el("run-all-month-end-button")?.addEventListener("click", () => {
    setRoute("monthly-reports");
  });
}

function bindDashboardActions() {
  all('[data-action="open-analysis"]').forEach((button) =>
    button.addEventListener("click", async () => {
      await openAnalysisLanding();
    })
  );
  all('[data-action="open-reference-list"]').forEach((button) =>
    button.addEventListener("click", async () => {
      const listType = button.getAttribute("data-list-type");
      await openAnalysisMailingList(listType);
    })
  );
  el("run-all-month-end-button")?.addEventListener("click", () => {
    setRoute("monthly-reports");
  });
}

function bindMailingListEvents() {
  all("[data-mailing-list-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      loadAndRenderMailingList(button.getAttribute("data-mailing-list-tab"));
    });
  });
  el("mailing-list-export-button")?.addEventListener("click", exportCurrentMailingList);
  el("mailing-list-mailer-export-button")?.addEventListener("click", exportMailerCurrentMailingList);
  el("dnm-export-button")?.addEventListener("click", exportCurrentMailingList);
  el("mailing-list-add-button")?.addEventListener("click", addMailingListEntry);
  el("dnm-state-add-button")?.addEventListener("click", addDnmState);
  el("mailing-list-import-button")?.addEventListener("click", () => {
    if (!["nhcl", "rfc"].includes(state.analysis.mailingListType)) {
      setStatus("mailing-list-status", "Import is available for NHCL and RFC only.");
      return;
    }
    el("mailing-list-import-input")?.click();
  });
  el("mailing-list-import-input")?.addEventListener("change", importReferenceList);
  all("[data-mailing-list-view-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.analysis.mailingListViewTab = button.getAttribute("data-mailing-list-view-tab") === "history"
        ? "history"
        : "current";
      updateMailingListViewTabs();
    });
  });
  el("mailing-list-search")?.addEventListener("input", (event) => {
    state.analysis.search = String(event.target.value || "");
    renderMailingListRows(getReferenceListFromCache(state.analysis.mailingListType) || {});
  });
  el("mailing-list-body")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("data-action") === "delete-dnm-state") {
      removeDnmState(target.getAttribute("data-state-key"));
      return;
    }
    if (target.getAttribute("data-action") === "delete-list-item") {
      removeMailingListItem(target.getAttribute("data-scf"));
    }
  });
  el("mailing-list-history-body")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const snapshotType = target.getAttribute("data-mailing-history-preview");
    const historyId = target.getAttribute("data-history-id");
    if (!snapshotType || !historyId) {
      return;
    }
    const list = getReferenceListFromCache(state.analysis.mailingListType) || {};
    const historyEntry = Array.isArray(list.history)
      ? list.history.find((entry) => String(entry.id || "").trim() === String(historyId).trim())
      : null;
    if (!historyEntry) {
      return;
    }
    state.analysis.mailingListHistoryPreview = {
      historyId,
      snapshotType,
      actionType: historyEntry.actionType,
      sourceName: historyEntry.sourceName || historyEntry.actor || "",
      changedAt: historyEntry.changedAt || historyEntry.changed_at || "",
      items: snapshotType === "before" ? historyEntry.beforeItems || [] : historyEntry.afterItems || [],
    };
    state.analysis.mailingListViewTab = "history";
    updateMailingListViewTabs();
    renderMailingListHistoryPreview(state.analysis.mailingListType, state.analysis.mailingListHistoryPreview);
  });
}

function bindReportHistoryButton() {
  all('[data-action="open-history"]').forEach((button) => {
    button.addEventListener("click", () => {
      setRoute("report-history");
    });
  });
}

function getDefaultScoreHistoryDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (SCORE_HISTORY_DEFAULT_DAY_RANGE - 1));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function ensureScoreHistoryFilters() {
  const defaults = getDefaultScoreHistoryDateRange();
  state.scoreHistory.filters = {
    from: state.scoreHistory.filters?.from || defaults.from,
    to: state.scoreHistory.filters?.to || defaults.to,
    reportKey: state.scoreHistory.filters?.reportKey || "",
    scorePeriod: state.scoreHistory.filters?.scorePeriod || "",
    paymentType: state.scoreHistory.filters?.paymentType || "",
    metricKey: state.scoreHistory.filters?.metricKey || "",
  };
  return state.scoreHistory.filters;
}

function buildScoreHistoryQuery(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim()) {
      params.set(key, String(value).trim());
    }
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

function getScoreHistoryMetricFormat(metricKey) {
  const reports = ensureArray(state.scoreHistory.config?.reports);
  for (const report of reports) {
    const metric = ensureArray(report.expectedMetrics).find((entry) => entry.key === metricKey);
    if (metric?.format) {
      return metric.format;
    }
  }
  return ["amount", "total_premium_with_dues"].includes(String(metricKey || "").trim())
    ? "currency"
    : ["active_clients", "record_count"].includes(String(metricKey || "").trim())
      ? "whole"
      : "number";
}

function getScoreHistoryReportLink(reportKey) {
  const instanceUrl = String(state.scoreHistory.auth?.instanceUrl || "").trim().replace(/\/+$/, "");
  if (!instanceUrl) {
    return "";
  }
  const report = ensureArray(state.scoreHistory.config?.reports).find((entry) => entry.reportKey === reportKey);
  const reportId = String(report?.salesforceReportId || "").trim();
  if (!reportId) {
    return "";
  }
  return `${instanceUrl}/lightning/r/Report/${encodeURIComponent(reportId)}/view`;
}

function syncScoreHistoryReportLinks() {
  [
    "score",
    "moneyReceived",
    "moneyReceivedByPayType",
    "applicationsReceived",
  ].forEach((reportKey) => {
    const link = el(`score-history-report-link-${reportKey}`);
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    const href = getScoreHistoryReportLink(reportKey);
    if (href) {
      link.href = href;
      link.classList.remove("is-disabled");
      link.removeAttribute("aria-disabled");
      link.tabIndex = 0;
      return;
    }
    link.href = "#";
    link.classList.add("is-disabled");
    link.setAttribute("aria-disabled", "true");
    link.tabIndex = -1;
  });
}

function formatScoreHistoryMetric(metricKey, value) {
  const format = getScoreHistoryMetricFormat(metricKey);
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (format === "currency") {
    return formatCurrencyValue(value);
  }
  if (format === "whole") {
    return formatWholeNumber(value);
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US")
    : String(value);
}

function formatScoreHistoryPeriodDisplay(scorePeriod) {
  const order = SCORE_HISTORY_VISIBLE_PERIODS;
  const index = order.indexOf(String(scorePeriod || "").trim());
  if (index === -1) {
    return String(scorePeriod || "").trim();
  }
  return `${index + 1}. ${scorePeriod}`;
}

function formatScoreHistoryPaymentTypeDisplay(paymentType) {
  const normalized = String(paymentType || "").trim();
  if (normalized === "Check") {
    return "Checks";
  }
  return normalized;
}

function groupScoreHistoryRowsBySnapshot(rows) {
  const snapshotMap = new Map();
  ensureArray(rows).forEach((row) => {
    const key = String(row.snapshot_date || "").trim();
    if (!key) {
      return;
    }
    if (!snapshotMap.has(key)) {
      snapshotMap.set(key, {
        snapshotDate: key,
        capturedAt: row.captured_at || "",
        salesforceAsOfText: row.salesforce_as_of_text || "",
        reportLabels: new Set(),
        rows: [],
      });
    }
    const entry = snapshotMap.get(key);
    entry.rows.push(row);
    if (row.report_label) {
      entry.reportLabels.add(row.report_label);
    }
    if (String(row.captured_at || "") > String(entry.capturedAt || "")) {
      entry.capturedAt = row.captured_at || entry.capturedAt;
    }
    if (!entry.salesforceAsOfText && row.salesforce_as_of_text) {
      entry.salesforceAsOfText = row.salesforce_as_of_text;
    }
  });

  return Array.from(snapshotMap.values())
    .map((entry) => ({
      ...entry,
      reportLabels: Array.from(entry.reportLabels).sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => String(right.snapshotDate).localeCompare(String(left.snapshotDate)));
}

function getSelectedScoreHistorySnapshotGroup() {
  const groups = groupScoreHistoryRowsBySnapshot(state.scoreHistory.rows);
  const selectedDate = String(state.scoreHistory.selectedSnapshotDate || "").trim();
  return groups.find((entry) => entry.snapshotDate === selectedDate) || groups[0] || null;
}

function fillSelectOptions(selectId, options, selectedValue, placeholderLabel) {
  const select = el(selectId);
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  const optionHtml = [
    `<option value="">${esc(placeholderLabel)}</option>`,
    ...ensureArray(options).map((option) => {
      const value = typeof option === "string" ? option : option.key;
      const label = typeof option === "string" ? option : option.label;
      return `<option value="${esc(String(value || ""))}">${esc(String(label || value || ""))}</option>`;
    }),
  ];
  select.innerHTML = optionHtml.join("");
  select.value = selectedValue || "";
}

function syncScoreHistoryFilterInputs() {
  const filters = ensureScoreHistoryFilters();
  const fromInput = el("score-history-filter-from");
  const toInput = el("score-history-filter-to");
  if (fromInput) fromInput.value = filters.from || "";
  if (toInput) toInput.value = filters.to || "";
}

function readScoreHistoryFilterInputs() {
  state.scoreHistory.filters = {
    from: normalizeIsoDateInput(el("score-history-filter-from")?.value || ""),
    to: normalizeIsoDateInput(el("score-history-filter-to")?.value || ""),
    reportKey: "",
    scorePeriod: "",
    paymentType: "",
    metricKey: "",
  };
  return state.scoreHistory.filters;
}

function buildScoreHistoryLatestMetricMap(rows) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const key = [
      row.payment_type || "",
      row.score_period || "",
      row.metric_key || "",
    ].join("::");
    map.set(key, row);
  });
  return map;
}

function renderScoreHistorySingleGroupingTable(bodyId, rows, metricColumns, emptyMessage) {
  const tbody = el(bodyId);
  if (!tbody) {
    return;
  }
  const metricMap = buildScoreHistoryLatestMetricMap(rows);
  const scorePeriods = SCORE_HISTORY_VISIBLE_PERIODS;
  const renderedRows = scorePeriods
    .map((scorePeriod) => {
      const values = metricColumns.map((metric) => {
        const match = metricMap.get(["", scorePeriod, metric.key].join("::"));
        return `<td>${esc(formatScoreHistoryMetric(metric.key, match?.metric_value))}</td>`;
      });
      return `<tr><td>${esc(formatScoreHistoryPeriodDisplay(scorePeriod))}</td>${values.join("")}</tr>`;
    })
    .filter(Boolean);

  const hasAnyValues = scorePeriods.some((scorePeriod) =>
    metricColumns.some((metric) => metricMap.has(["", scorePeriod, metric.key].join("::")))
  );

  tbody.innerHTML = hasAnyValues
    ? renderedRows.join("")
    : `<tr><td colspan="${metricColumns.length + 1}" class="empty-cell">${esc(emptyMessage)}</td></tr>`;
}

function renderScoreHistoryPayTypeTable(bodyId, rows, emptyMessage) {
  const tbody = el(bodyId);
  if (!tbody) {
    return;
  }
  const paymentTypes = SCORE_HISTORY_VISIBLE_PAYMENT_TYPES;
  const scorePeriods = SCORE_HISTORY_VISIBLE_PERIODS;
  const metricMap = buildScoreHistoryLatestMetricMap(rows);
  const renderedRows = [];
  let hiddenPaymentTypeCount = 0;

  paymentTypes.forEach((paymentType) => {
    const paymentRows = [];
    scorePeriods.forEach((scorePeriod) => {
      const match = metricMap.get([paymentType, scorePeriod, "amount"].join("::"));
      paymentRows.push(`
        <tr>
          <td>${esc(formatScoreHistoryPeriodDisplay(scorePeriod))}</td>
          <td>${esc(formatScoreHistoryMetric("amount", match?.metric_value))}</td>
        </tr>
      `);
    });
    paymentRows[0] = paymentRows[0].replace(
      "<tr>\n          <td>",
      `<tr>\n          <td rowspan="${paymentRows.length}">${esc(formatScoreHistoryPaymentTypeDisplay(paymentType))}</td>\n          <td>`
    );
    renderedRows.push(...paymentRows);
  });

  const additionalPaymentTypes = Array.from(
    new Set(
      ensureArray(rows)
        .map((row) => String(row.payment_type || "").trim())
        .filter((paymentType) => paymentType && !paymentTypes.includes(paymentType))
    )
  );
  hiddenPaymentTypeCount = additionalPaymentTypes.length;

  const hasAnyValues = paymentTypes.some((paymentType) =>
    scorePeriods.some((scorePeriod) => metricMap.has([paymentType, scorePeriod, "amount"].join("::")))
  ) || additionalPaymentTypes.length > 0;

  tbody.innerHTML = hasAnyValues
    ? renderedRows.join("")
    : `<tr><td colspan="3" class="empty-cell">${esc(emptyMessage)}</td></tr>`;

  const note = el("score-history-paytype-note");
  if (note) {
    note.textContent = hiddenPaymentTypeCount
      ? `Additional payment type${hiddenPaymentTypeCount === 1 ? "" : "s"} captured but hidden here: ${additionalPaymentTypes.join(", ")}.`
      : "";
  }
}

function renderScoreHistoryLatest() {
  const selectedSnapshot = getSelectedScoreHistorySnapshotGroup();
  const latest = state.scoreHistory.latest || {};
  const reports = selectedSnapshot
    ? {
        score: { rows: ensureArray(selectedSnapshot.rows).filter((row) => row.report_key === "score") },
        moneyReceived: { rows: ensureArray(selectedSnapshot.rows).filter((row) => row.report_key === "moneyReceived") },
        moneyReceivedByPayType: { rows: ensureArray(selectedSnapshot.rows).filter((row) => row.report_key === "moneyReceivedByPayType") },
        applicationsReceived: { rows: ensureArray(selectedSnapshot.rows).filter((row) => row.report_key === "applicationsReceived") },
      }
    : (latest.reports || {});
  renderScoreHistorySingleGroupingTable(
    "score-history-latest-score-body",
    reports.score?.rows || [],
    [
      { key: "active_clients", label: "Active Clients" },
      { key: "total_premium_with_dues", label: "Total Premium With Dues" },
    ],
    "No SCORE snapshot captured yet."
  );
  renderScoreHistorySingleGroupingTable(
    "score-history-latest-money-body",
    reports.moneyReceived?.rows || [],
    [{ key: "amount", label: "Amount" }],
    "No Money Received snapshot captured yet."
  );
  renderScoreHistoryPayTypeTable(
    "score-history-latest-paytype-body",
    reports.moneyReceivedByPayType?.rows || [],
    "No payment type snapshot captured yet."
  );
  renderScoreHistorySingleGroupingTable(
    "score-history-latest-applications-body",
    reports.applicationsReceived?.rows || [],
    [{ key: "record_count", label: "Record Count" }],
    "No Applications Received snapshot captured yet."
  );

  if (el("score-history-last-date")) {
    el("score-history-last-date").textContent = selectedSnapshot?.snapshotDate
      ? formatDateOnly(selectedSnapshot.snapshotDate)
      : "Not captured yet";
  }
  if (el("score-history-last-captured-at")) {
    el("score-history-last-captured-at").textContent = selectedSnapshot?.capturedAt
      ? `Captured ${formatDate(selectedSnapshot.capturedAt)}`
      : "Not captured yet";
  }
  if (el("score-history-last-as-of")) {
    el("score-history-last-as-of").textContent = selectedSnapshot?.salesforceAsOfText
      ? selectedSnapshot.salesforceAsOfText
      : "Salesforce As Of not available";
  }
  if (el("score-history-hero-kicker")) {
    el("score-history-hero-kicker").textContent = selectedSnapshot?.snapshotDate
      ? `Viewing saved snapshot for ${formatDateOnly(selectedSnapshot.snapshotDate)}`
      : "Daily dashboard snapshot";
  }
  syncScoreHistoryReportLinks();
}

function renderScoreHistoryTable() {
  const tbody = el("score-history-table-body");
  if (!tbody) {
    return;
  }
  const snapshotGroups = groupScoreHistoryRowsBySnapshot(state.scoreHistory.rows);
  if (!snapshotGroups.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No SCORE history yet.</td></tr>';
    return;
  }

  tbody.innerHTML = snapshotGroups.map((snapshot) => `
    <tr>
      <td>${esc(formatDateOnly(snapshot.snapshotDate))}</td>
      <td>${esc(snapshot.reportLabels.join(", "))}</td>
      <td>${esc(snapshot.salesforceAsOfText || "-")}</td>
      <td>${esc(formatDate(snapshot.capturedAt || ""))}</td>
      <td><button class="secondary-button table-action-button" data-score-history-open="${esc(snapshot.snapshotDate)}">Open</button></td>
    </tr>
  `).join("");
}

async function loadScoreHistoryPage() {
  const filters = ensureScoreHistoryFilters();
  const query = buildScoreHistoryQuery(filters);
  const [latestPayload, listPayload, authPayload] = await Promise.all([
    apiRequest("/api/score-dashboard-snapshots/latest"),
    apiRequest(`/api/score-dashboard-snapshots${query}`),
    apiRequest("/api/salesforce/auth-status"),
  ]);

  state.scoreHistory.latest = latestPayload || null;
  state.scoreHistory.rows = ensureArray(listPayload?.rows);
  state.scoreHistory.options = listPayload?.options || null;
  state.scoreHistory.config = listPayload?.config || latestPayload?.config || null;
  state.scoreHistory.auth = authPayload?.auth || null;
  state.scoreHistory.filters = {
    ...filters,
    ...(listPayload?.filters || {}),
  };
  state.scoreHistory.selectedSnapshotDate =
    state.scoreHistory.selectedSnapshotDate
    && groupScoreHistoryRowsBySnapshot(state.scoreHistory.rows).some(
      (entry) => entry.snapshotDate === state.scoreHistory.selectedSnapshotDate
    )
      ? state.scoreHistory.selectedSnapshotDate
      : String(latestPayload?.snapshotDate || "");

  syncScoreHistoryFilterInputs();
  renderScoreHistoryLatest();
  renderScoreHistoryTable();
}

async function captureScoreHistorySnapshot(options = {}) {
  const navigate = options.navigate !== false;
  if (navigate) {
    setRoute("score-history");
  }
  setStatus("score-history-status", "Capturing SCORE snapshot...");
  try {
    const result = await apiRequest("/api/score-dashboard-snapshots/capture", {
      method: "POST",
      body: {},
    });
    const failedLabels = ensureArray(result.errors).map((entry) => entry.reportLabel).filter(Boolean);
    if (result.failedReports) {
      setStatus(
        "score-history-status",
        `Captured ${result.totalMetricsSaved} metric(s). ${result.failedReports} report(s) failed: ${failedLabels.join(", ")}.`
      );
    } else {
      setStatus(
        "score-history-status",
        `Captured ${result.totalMetricsSaved} metric(s) from ${result.successfulReports} report(s).`
      );
    }
    state.scoreHistory.selectedSnapshotDate = String(result.snapshotDate || "");
    await loadScoreHistoryPage();
  } catch (error) {
    const message = /oauth|authentication failed|reconnect salesforce|expired access\/refresh token|token refresh failed/i.test(error.message)
      ? "Salesforce authentication failed. Check Salesforce connection settings."
      : error.message;
    setStatus("score-history-status", message);
  }
}

function bindScoreHistoryEvents() {
  el("score-history-capture-button")?.addEventListener("click", async () => {
    await captureScoreHistorySnapshot({ navigate: false });
  });
  el("dashboard-score-capture-button")?.addEventListener("click", async () => {
    await captureScoreHistorySnapshot({ navigate: true });
  });
  el("score-history-apply-filters-button")?.addEventListener("click", async () => {
    readScoreHistoryFilterInputs();
    await loadScoreHistoryPage();
  });
  el("score-history-reset-filters-button")?.addEventListener("click", async () => {
    state.scoreHistory.filters = {
      ...getDefaultScoreHistoryDateRange(),
      reportKey: "",
      scorePeriod: "",
      paymentType: "",
      metricKey: "",
    };
    syncScoreHistoryFilterInputs();
    await loadScoreHistoryPage();
  });
  el("score-history-export-button")?.addEventListener("click", async () => {
    readScoreHistoryFilterInputs();
    const query = buildScoreHistoryQuery(state.scoreHistory.filters);
    try {
      await apiDownload(`/api/score-dashboard-snapshots/export${query}`, "score-dashboard-history.csv");
    } catch (error) {
      setStatus("score-history-status", `Unable to export SCORE history: ${error.message}`);
    }
  });
  el("score-history-table-body")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const snapshotDate = target.getAttribute("data-score-history-open");
    if (!snapshotDate) {
      return;
    }
    state.scoreHistory.selectedSnapshotDate = snapshotDate;
    renderScoreHistoryLatest();
    const top = document.querySelector(".score-history-hero");
    top?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function initSalesforceStatus() {
  fetch("/api/salesforce/auth-status")
    .then((r) => r.json())
    .then((payload) => {
      const auth = payload.auth || {};
      const isConnected = Boolean(
        auth.isAuthenticated ?? auth.connected
      );
      if (el("salesforce-auth-heading"))
        el("salesforce-auth-heading").textContent = isConnected ? "Connected" : "Not Connected";
      if (el("salesforce-auth-copy"))
        el("salesforce-auth-copy").textContent = isConnected
          ? "Salesforce is connected."
          : auth.resolvedRedirectUri
            ? `Connect Salesforce so live report pulls are available. Callback: ${auth.resolvedRedirectUri}`
            : "Connect Salesforce so live report pulls are available.";
    })
    .catch(() => {
      if (el("salesforce-auth-heading")) el("salesforce-auth-heading").textContent = "Not Connected";
    });
}

async function init() {
  bindPrimaryNavigation();
  bindDashboardActions();
  setupAnalysisReviewSync();
  bindAnalysisButtons();
  bindAnalysisSubtabs();
  bindMailingListEvents();
  bindApplicationEvents();
  bindCcPaymentImportEvents();
  bindCheckImportEvents();
  bindAchReturnEvents();
  bindMailingDataEvents();
  bindMonthlyActions();
  bindScoreHistoryEvents();
  if (!state.applications.current) {
    state.applications.current = createEmptyApplication();
  }

  const persistedUiState = readPersistedUiState();
  const persistedAchReturnDraftState = readPersistedAchReturnDraftState();
  const launchState = readLaunchStateFromUrl();
    if (persistedUiState?.analysis) {
      state.analysis.panel = String(persistedUiState.analysis.panel || state.analysis.panel);
      state.analysis.subtab =
        persistedUiState.analysis.subtab === "mailing-lists" ? "mailing-lists" : "runs";
      state.analysis.mailingListType = ["dnm", "nhcl", "rfc"].includes(
        String(persistedUiState.analysis.mailingListType || "").toLowerCase()
      )
        ? String(persistedUiState.analysis.mailingListType || "").toLowerCase()
        : "dnm";
      state.analysis.navExpanded = persistedUiState.analysis.navExpanded !== false;
    }
    if (persistedUiState?.achReturns?.currentSessionId) {
      state.achReturns.currentSessionId = String(persistedUiState.achReturns.currentSessionId || "").trim();
    }
    if (persistedAchReturnDraftState) {
      state.achReturns.draft = persistedAchReturnDraftState.draft || null;
      state.achReturns.emailBody = String(persistedAchReturnDraftState.emailBody || "");
    }

  if (launchState?.analysis) {
    if (launchState.analysis.panel) {
      state.analysis.panel = launchState.analysis.panel;
    }
    if (launchState.analysis.subtab) {
      state.analysis.subtab = launchState.analysis.subtab;
    }
    if (launchState.analysis.mailingListType) {
      state.analysis.mailingListType = launchState.analysis.mailingListType;
    }
    if (launchState.analysis.setupId) {
      state.analysis.currentSetupId = launchState.analysis.setupId;
      persistAnalysisSetupId(launchState.analysis.setupId);
    }
    if (launchState.analysis.comparisonId) {
      state.analysis.selectedComparisonId = launchState.analysis.comparisonId;
      state.analysis.lastEditedComparisonId = launchState.analysis.comparisonId;
    }
    if (launchState.analysis.primaryReportId && launchState.analysis.comparisonId) {
      state.analysis.reviewPrimaryReportIds[launchState.analysis.comparisonId] = launchState.analysis.primaryReportId;
    }
    if (launchState.analysis.reviewScf && launchState.analysis.comparisonId) {
      state.analysis.reviewSelectedScfs[launchState.analysis.comparisonId] = launchState.analysis.reviewScf;
    }
    if (launchState.analysis.reviewSummaryMode) {
      state.analysis.reviewSummaryMode = launchState.analysis.reviewSummaryMode;
    }
    if (launchState.analysis.popup) {
      document.body.classList.add("analysis-review-popup-window");
    }
  }

  if (launchState?.importSession?.route === "cc-payment-imports") {
    state.ccPayments.launchSessionId = launchState.importSession.sessionId || "";
    state.ccPayments.popup = launchState.importSession.popup === true;
  }

  if (launchState?.importSession?.route === "check-imports") {
    state.checkImports.launchSessionId = launchState.importSession.sessionId || "";
    state.checkImports.popup = launchState.importSession.popup === true;
  }

  if (launchState?.importSession?.route === "ach-returns") {
    state.achReturns.currentSessionId = launchState.importSession.sessionId || "";
  }

  const initialRoute = String(launchState?.route || persistedUiState?.route || "dashboard").trim() || "dashboard";
  resetAnalysisWorkspace(false);
  if (launchState?.analysis?.setupId) {
    state.analysis.currentSetupId = launchState.analysis.setupId;
  }
  if (launchState?.analysis?.comparisonId) {
    state.analysis.selectedComparisonId = launchState.analysis.comparisonId;
    state.analysis.lastEditedComparisonId = launchState.analysis.comparisonId;
  }
  if (launchState?.analysis?.primaryReportId && launchState?.analysis?.comparisonId) {
    state.analysis.reviewPrimaryReportIds[launchState.analysis.comparisonId] = launchState.analysis.primaryReportId;
  }
  if (launchState?.analysis?.reviewScf && launchState?.analysis?.comparisonId) {
    state.analysis.reviewSelectedScfs[launchState.analysis.comparisonId] = launchState.analysis.reviewScf;
  }
  if (launchState?.analysis?.reviewSummaryMode) {
    state.analysis.reviewSummaryMode = launchState.analysis.reviewSummaryMode;
  }
  setRoute(initialRoute);
  updateAnalysisLeftSubmenuExpandedUi();
  if (initialRoute === "analysis") {
    const requestedAnalysisPanel = state.analysis.panel || "home";
    if (["home", "compare", "compare-review"].includes(requestedAnalysisPanel) || launchState?.analysis?.setupId) {
      try {
        await loadAnalysisSetupView();
        if (launchState?.analysis?.comparisonId) {
          state.analysis.selectedComparisonId = launchState.analysis.comparisonId;
          state.analysis.lastEditedComparisonId = launchState.analysis.comparisonId;
        }
        if (launchState?.analysis?.primaryReportId && launchState?.analysis?.comparisonId) {
          state.analysis.reviewPrimaryReportIds[launchState.analysis.comparisonId] = launchState.analysis.primaryReportId;
        }
        if (launchState?.analysis?.reviewScf && launchState?.analysis?.comparisonId) {
          state.analysis.reviewSelectedScfs[launchState.analysis.comparisonId] = launchState.analysis.reviewScf;
        }
        if (launchState?.analysis?.reviewSummaryMode) {
          state.analysis.reviewSummaryMode = launchState.analysis.reviewSummaryMode;
        }
        if (comparisonDebugEnabled && requestedAnalysisPanel === "home") {
          setStatus("analysis-comparison-status", "Comparison debug mode loaded.");
        }
      } catch (error) {
        const failureMessage = comparisonDebugEnabled && requestedAnalysisPanel === "home"
          ? `Comparison debug load failed: ${error.message}`
          : `Unable to load saved analysis setup: ${error.message}`;
        setStatus("analysis-comparison-status", failureMessage);
      }
    }
    showAnalysisPanel(requestedAnalysisPanel);
    if (requestedAnalysisPanel === "compare-review" && launchState?.analysis?.popup) {
      setStatus(
        "analysis-comparison-selection-status",
        "Detached review window opened. Move this browser window wherever you want."
      );
    }
  }
  try {
    await loadReferenceLists();
  } catch (error) {
    setStatus("mailing-list-status", `Unable to load reference lists: ${error.message}`);
  }
  initSalesforceStatus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
