const fs = require("fs");
const path = require("path");
const { getSalesforceConfig } = require("./config");
const {
  getAuthStatus,
  getStoredToken,
  storeTokenRecord,
} = require("./salesforceAuthService");
const {
  DEFAULT_MONTHLY_REPORT_TYPE,
  getMonthlyReportType,
} = require("./reportCatalog");

const SALESFORCE_API_VERSION = "v61.0";
const DEFAULT_SALESFORCE_REQUEST_TIMEOUT_MS = 45000;
const salesforceDescribeCache = new Map();
const ANALYSIS_DEBUG_FILE_PREFIX = "debug-analysis-salesforce-report";

function parseSalesforceRequestTimeoutMs(candidate) {
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SALESFORCE_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(parsed));
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = parseSalesforceRequestTimeoutMs(process.env.SALESFORCE_REQUEST_TIMEOUT_MS);
  let timeoutId = null;
  let timeoutController = null;

  try {
    if (typeof AbortController !== "undefined") {
      timeoutController = new AbortController();
      timeoutId = setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs);
      return await fetch(url, {
        ...options,
        signal: timeoutController.signal,
      });
    }

    return await fetch(url, options);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Salesforce request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getMonthDateRange(reportMonth) {
  const [yearString, monthString] = String(reportMonth || "").split("-");
  const year = Number(yearString);
  const month = Number(monthString);

  if (!year || !month) {
    throw new Error(`Invalid report month: ${reportMonth}`);
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function sanitizeDebugToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

const ANALYSIS_METRIC_LABELS = {
  mailed: ["Sum of Mailed", "Sum of Mail", "Mailed"],
  oppCount: ["Sum of Opp Count", "Applications Received", "Opp Count", "Application Count"],
  inForce: ["Sum of In Force", "Inforce (policy currently in effect)", "In Force"],
  sold: ["Sum of Sold", "Sold"],
  convertedCount: ["Sum of Converted", "Converted"],
  totalMonthlyPremium: ["Sum of Total Monthly Premium", "Sum of Total Sold", "Total Monthly Premium"],
  inForceMonthlyPremium: ["Sum of In Force Monthly Premium", "In Force Monthly Premium"],
  totalConvertedMonthlyPremiums: ["Payments Minus Credits", "Payments_Minus_Credits__c", "Sum of Total Converted Monthly Premiums", "Sum of Total Converted Monthly Premium", "Total Converted Monthly Premiums", "Total Converted Monthly Premium"],
};

const CONVERTED_DIRECT_CANDIDATE_KEYS = [
  "Sum of Converted",
  "Converted",
  "Converted Count",
  "converted",
  "converted_count",
  "sum_converted",
  "sumOfConverted",
  "HPATotal_Converted__c",
  "HPATotal_Converted_Count__c",
];

const CONVERTED_PAYMENT_FALLBACK_KEYS = [
  "Payment Received",
  "Payment Received Count",
  "Payment_Received__c",
  "payment_received",
];

function getAnalysisMetricValue(row = {}, labels = []) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (Object.prototype.hasOwnProperty.call(row, label)) {
      return row[label];
    }
    if (normalized && Object.prototype.hasOwnProperty.call(row, normalized)) {
      return row[normalized];
    }
  }

  return undefined;
}

function setAnalysisMetricAliases(row = {}, labels = [], value) {
  labels.forEach((label) => {
    row[label] = value;
    const normalized = normalizeLabel(label);
    if (normalized) {
      row[normalized] = value;
    }
  });
}

function hasAnalysisMetricValue(row = {}, labels = []) {
  return labels.some((label) => {
    const normalized = normalizeLabel(label);
    const directValue = Object.prototype.hasOwnProperty.call(row, label) ? row[label] : undefined;
    const normalizedValue =
      normalized && Object.prototype.hasOwnProperty.call(row, normalized) ? row[normalized] : undefined;

    return (
      (directValue !== undefined && directValue !== null && String(directValue).trim() !== "") ||
      (normalizedValue !== undefined && normalizedValue !== null && String(normalizedValue).trim() !== "")
    );
  });
}

function resolveAnalysisConvertedPremiumValue(row = {}, precomputedConvertedPremium = null) {
  return getConvertedPremiumAmount(row, precomputedConvertedPremium);
}

function parseMoneyNumber(value) {
  return parseNumber(value ?? 0);
}

function getConvertedPremiumAmount(row = {}, precomputedConvertedPremium = null) {
  return precomputedConvertedPremium === null
    ? parseMoneyNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.totalConvertedMonthlyPremiums) ?? 0)
    : parseMoneyNumber(precomputedConvertedPremium);
}

function getConvertedCountForSourceRow(row = {}, precomputedConvertedPremium = null) {
  return getConvertedPremiumAmount(row, precomputedConvertedPremium) > 0 ? 1 : 0;
}

function resolveAnalysisSoldOpportunityCount(row = {}, options = {}) {
  applyAnalysisMetricAliases(row);
  const convertedCountFallback = parseNumber(options?.convertedCountFallback ?? 0);
  const oppCount = parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.oppCount) ?? 0);
  if (oppCount > 0) {
    return Math.max(oppCount, convertedCountFallback);
  }

  const explicitSold = parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.sold) ?? 0);
  const fallbackSold = explicitSold > 0 ? explicitSold : 0;
  return Math.max(fallbackSold, convertedCountFallback);
}

function resolveAnalysisConvertedCount(row = {}, precomputedConvertedPremium = null, options = {}) {
  applyAnalysisMetricAliases(row);
  const allowPremiumRowInference = options?.allowPremiumRowInference !== false;
  const resolvedConverted = resolveConvertedValue(row);
  const explicitConvertedCount = Number.isFinite(resolvedConverted.numericValue)
    ? Number(resolvedConverted.numericValue)
    : null;
  const convertedPremium = resolveAnalysisConvertedPremiumValue(row, precomputedConvertedPremium);
  if (explicitConvertedCount !== null && explicitConvertedCount > 0) {
    return explicitConvertedCount;
  }
  if (allowPremiumRowInference) {
    return getConvertedCountForSourceRow(row, convertedPremium);
  }
  if (explicitConvertedCount !== null) {
    return 0;
  }
  return 0;
}

function resolveAnalysisExplicitRate(row = {}, labels = []) {
  applyAnalysisMetricAliases(row);
  if (!hasAnalysisMetricValue(row, labels)) {
    return null;
  }
  const numericValue = parseNumber(getAnalysisMetricValue(row, labels) ?? 0);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function calculateAnalysisCountRates({
  mailed = 0,
  soldCount = 0,
  inForceCount = 0,
  convertedCount = 0,
} = {}) {
  const safeMailed = parseNumber(mailed);
  if (!(safeMailed > 0)) {
    return {
      soldRate: 0,
      inForceRate: 0,
      convertedRate: 0,
    };
  }

  return {
    soldRate: (parseNumber(soldCount) / safeMailed) * 100,
    inForceRate: (parseNumber(inForceCount) / safeMailed) * 100,
    convertedRate: (parseNumber(convertedCount) / safeMailed) * 100,
  };
}

function calculateAnalysisConvertedRate({
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

  const safeConvertedCount = parseNumber(convertedCount);
  if (!(safeConvertedCount > 0)) {
    return 0;
  }

  const soldRateNumber = Number(soldRate);
  const soldCountNumber = parseNumber(soldCount);
  if (soldCountNumber > 0 && Number.isFinite(soldRateNumber) && soldRateNumber > 0) {
    return (safeConvertedCount / soldCountNumber) * soldRateNumber;
  }

  const inForceRateNumber = Number(inForceRate);
  const inForceCountNumber = parseNumber(inForceCount);
  if (inForceCountNumber > 0 && Number.isFinite(inForceRateNumber) && inForceRateNumber > 0) {
    return (safeConvertedCount / inForceCountNumber) * inForceRateNumber;
  }

  return calculateAnalysisCountRates({
    mailed,
    convertedCount: safeConvertedCount,
  }).convertedRate;
}

function shouldPreferCandidateAnalysisMetric(currentValue, candidateValue) {
  const hasCurrent =
    currentValue !== undefined &&
    currentValue !== null &&
    String(currentValue).trim() !== "";
  const hasCandidate =
    candidateValue !== undefined &&
    candidateValue !== null &&
    String(candidateValue).trim() !== "";

  if (!hasCandidate) {
    return false;
  }
  if (!hasCurrent) {
    return true;
  }

  const currentNumber = parseNumber(currentValue);
  const candidateNumber = parseNumber(candidateValue);
  return currentNumber === 0 && candidateNumber !== 0;
}

function applyAnalysisMetricAliases(row = {}) {
  const metricGroups = Object.values(ANALYSIS_METRIC_LABELS);
  metricGroups.forEach((labels) => {
    const value = getAnalysisMetricValue(row, labels);
    if (value !== undefined) {
      setAnalysisMetricAliases(row, labels, value);
    }
  });
  return row;
}

function looksLikeDateLabel(label) {
  return (
    label.includes("date received") ||
    label.includes("date refunded") ||
    label.includes("refund date") ||
    label.includes("date returned") ||
    label === "date" ||
    label.startsWith("date ")
  );
}

function looksLikePremiumLabel(label) {
  return label === "premium" || label.includes("gross premium");
}

function looksLikeDuesLabel(label) {
  return label.includes("dues");
}

function looksLikeAmountLabel(label) {
  return (
    label.includes("amount received") ||
    label.includes("settlement amount") ||
    label === "amount" ||
    label.includes("total submitted") ||
    label.includes("submitted")
  );
}

function looksLikeMonthsLabel(label) {
  return (
    label.includes("months paid") ||
    label.includes("rollback months") ||
    label.includes("number of months")
  );
}

function looksLikeCertificateLabel(label) {
  return (
    label.includes("number of certificates") ||
    label.includes("certificate count") ||
    label.includes("total certificates")
  );
}

function parseNumber(value) {
  if (value && typeof value === "object") {
    if (typeof value.amount === "number" && Number.isFinite(value.amount)) {
      return value.amount;
    }

    if (typeof value.value === "number" && Number.isFinite(value.value)) {
      return value.value;
    }
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const stringValue = String(value || "").trim();
  if (!stringValue) {
    return 0;
  }

  const isNegativeByParens =
    stringValue.startsWith("(") && stringValue.endsWith(")");
  const cleaned = stringValue.replace(/[$,%()\s,]/g, "");
  const parsed = Number(cleaned);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return isNegativeByParens ? -parsed : parsed;
}

function parseConvertedNumber(value, options = {}) {
  const allowPaymentReceivedFallback = options?.allowPaymentReceivedFallback !== false;

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value && typeof value === "object") {
    if (typeof value.amount === "number" && Number.isFinite(value.amount)) {
      return value.amount;
    }
    if (typeof value.value === "number" && Number.isFinite(value.value)) {
      return value.value;
    }
  }

  const stringValue = String(value).trim();
  if (!stringValue) {
    return null;
  }

  const lowered = stringValue.toLowerCase();
  if (allowPaymentReceivedFallback) {
    if (["received", "paid", "payment received", "yes", "true", "y"].includes(lowered)) {
      return 1;
    }
    if (["not received", "no", "false", "n"].includes(lowered)) {
      return 0;
    }
  }

  const isNegativeByParens = stringValue.startsWith("(") && stringValue.endsWith(")");
  const cleaned = stringValue.replace(/[$,%()\s,]/g, "");
  if (!cleaned) {
    return null;
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return isNegativeByParens ? -parsed : parsed;
}

function findConvertedRowKey(row = {}, candidateKeys = []) {
  const normalizedTargets = candidateKeys.map((key) => normalizeLabel(key)).filter(Boolean);
  return Object.keys(row || {}).find((key) => normalizedTargets.includes(normalizeLabel(key))) || null;
}

function isConvertedAmountFieldKey(key = "") {
  const normalized = normalizeLabel(key);
  return (
    normalized.includes("premium") ||
    normalized.includes("payment minus credits") ||
    normalized.includes("payments minus credits") ||
    normalized.includes("monthly premium")
  );
}

function resolveConvertedValue(row = {}) {
  const directKey = findConvertedRowKey(row, CONVERTED_DIRECT_CANDIDATE_KEYS);
  if (directKey) {
    return {
      key: directKey,
      rawValue: row[directKey],
      numericValue: parseConvertedNumber(row[directKey], { allowPaymentReceivedFallback: false }),
      sourceType: "direct",
      usedPaymentReceivedFallback: false,
    };
  }

  const paymentKey = findConvertedRowKey(row, CONVERTED_PAYMENT_FALLBACK_KEYS);
  if (paymentKey) {
    return {
      key: paymentKey,
      rawValue: row[paymentKey],
      numericValue: parseConvertedNumber(row[paymentKey], { allowPaymentReceivedFallback: true }),
      sourceType: "payment-received-fallback",
      usedPaymentReceivedFallback: true,
    };
  }

  const fuzzyKey = Object.keys(row || {}).find((key) => {
    const keyText = String(key || "");
    if (!/converted|payment.*received/i.test(keyText)) {
      return false;
    }
    return !isConvertedAmountFieldKey(keyText);
  }) || null;
  if (fuzzyKey) {
    const isPaymentFallback = /payment.*received/i.test(String(fuzzyKey || ""));
    return {
      key: fuzzyKey,
      rawValue: row[fuzzyKey],
      numericValue: parseConvertedNumber(row[fuzzyKey], { allowPaymentReceivedFallback: isPaymentFallback }),
      sourceType: isPaymentFallback ? "payment-received-fallback" : "fuzzy-direct",
      usedPaymentReceivedFallback: isPaymentFallback,
    };
  }

  return {
    key: null,
    rawValue: null,
    numericValue: null,
    sourceType: "missing",
    usedPaymentReceivedFallback: false,
  };
}

function buildConvertedResolutionRecord(row = {}, index = null) {
  const resolution = resolveConvertedValue(row);
  return {
    index,
    scf: row?.["SCF Grouping"] ?? row?.["scf grouping"] ?? row?.SCF ?? row?.scf ?? "",
    key: row?.["Key"] ?? row?.key ?? "",
    convertedKey: resolution.key,
    convertedRawValue: resolution.rawValue,
    convertedNumericValue: resolution.numericValue,
    sourceType: resolution.sourceType,
    usedPaymentReceivedFallback: resolution.usedPaymentReceivedFallback,
    availableKeys: Object.keys(row || {}),
  };
}

function buildConvertedDebugSummary(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const resolutionRecords = list.map((row, index) => buildConvertedResolutionRecord(row, index));
  const warnings = resolutionRecords
    .filter((entry) => !entry.convertedKey)
    .slice(0, 10)
    .map((entry) => `[Converted Debug] No converted source field found for row ${entry.index}; keys=${entry.availableKeys.join(", ")}`);

  return {
    totalRowsChecked: resolutionRecords.length,
    rowsWithConvertedSource: resolutionRecords.filter((entry) => Boolean(entry.convertedKey)).length,
    rowsWithConvertedNumericValue: resolutionRecords.filter((entry) => Number.isFinite(entry.convertedNumericValue)).length,
    convertedTotalFromSource: resolutionRecords.reduce(
      (sum, entry) => sum + (Number.isFinite(entry.convertedNumericValue) ? Number(entry.convertedNumericValue) : 0),
      0
    ),
    convertedResolutionSamples: resolutionRecords.slice(0, 5),
    warnings,
  };
}

function parseDateValue(rawValue, fallbackLabel) {
  if (typeof rawValue === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(rawValue)) {
      return rawValue.slice(0, 10);
    }

    const parsed = new Date(rawValue);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const parsedFallback = new Date(fallbackLabel);
  if (!Number.isNaN(parsedFallback.getTime())) {
    return parsedFallback.toISOString().slice(0, 10);
  }

  throw new Error(`Unable to parse Salesforce report date value: ${fallbackLabel}`);
}

async function refreshAccessTokenIfNeeded(tokenRecord) {
  if (tokenRecord?.accessToken) {
    return tokenRecord;
  }

  throw new Error("Salesforce is not connected. Connect Salesforce before running the report.");
}

async function refreshAccessToken(tokenRecord) {
  if (!tokenRecord?.refreshToken) {
    throw new Error(
      "Salesforce access token expired and no refresh token is available. Reconnect Salesforce."
    );
  }

  const config = getSalesforceConfig();
  const tokenUrl = new URL("/services/oauth2/token", config.loginUrl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: tokenRecord.refreshToken,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Salesforce token refresh failed.");
  }

  const updatedToken = {
    ...tokenRecord,
    accessToken: payload.access_token,
    instanceUrl: payload.instance_url || tokenRecord.instanceUrl,
    issuedAt: payload.issued_at || tokenRecord.issuedAt,
    signature: payload.signature || tokenRecord.signature,
    tokenType: payload.token_type || tokenRecord.tokenType,
    refreshToken: payload.refresh_token || tokenRecord.refreshToken,
  };

  storeTokenRecord(updatedToken);
  return updatedToken;
}

async function salesforceRequest(tokenRecord, pathName, options = {}) {
  const requestUrl = new URL(pathName, `${tokenRecord.instanceUrl}/`);
  const headers = {
    Authorization: `Bearer ${tokenRecord.accessToken}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetchWithTimeout(requestUrl, {
    ...options,
    headers,
  });

  if (response.status !== 401) {
    return response;
  }

  const refreshedToken = await refreshAccessToken(tokenRecord);
  const retryHeaders = {
    ...headers,
    Authorization: `Bearer ${refreshedToken.accessToken}`,
  };

  return fetchWithTimeout(requestUrl, {
    ...options,
    headers: retryHeaders,
  });
}

async function fetchReportDescribe(tokenRecord, reportId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}/describe`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to describe Salesforce report ${reportId}.`
    );
  }

  return payload;
}

async function fetchSObjectDescribe(tokenRecord, objectName) {
  const cacheKey = String(objectName || "").trim();
  if (!cacheKey) {
    throw new Error("Salesforce object name is required for describe.");
  }

  if (salesforceDescribeCache.has(cacheKey)) {
    return salesforceDescribeCache.get(cacheKey);
  }

  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/sobjects/${encodeURIComponent(cacheKey)}/describe`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
      payload.message ||
      `Unable to describe Salesforce object ${cacheKey}.`
    );
  }

  salesforceDescribeCache.set(cacheKey, payload);
  return payload;
}

function replaceLeadingRelationshipToken(path, fromToken, toToken) {
  const candidate = String(path || "").trim();
  if (!candidate || !fromToken || !toToken) {
    return candidate;
  }

  if (candidate === fromToken) {
    return toToken;
  }

  const prefix = `${fromToken}.`;
  if (candidate.startsWith(prefix)) {
    return `${toToken}.${candidate.slice(prefix.length)}`;
  }

  return candidate;
}

async function resolveRelationshipNameForObjectReference(tokenRecord, objectName, referenceObjectName) {
  const baseObjectName = String(objectName || "").trim();
  const targetObjectName = String(referenceObjectName || "").trim();

  if (!baseObjectName || !targetObjectName || baseObjectName === targetObjectName) {
    return "";
  }

  const describePayload = await fetchSObjectDescribe(tokenRecord, baseObjectName);
  const fields = Array.isArray(describePayload?.fields) ? describePayload.fields : [];
  const candidates = fields.filter((field) =>
    Array.isArray(field?.referenceTo) &&
    field.referenceTo.includes(targetObjectName) &&
    String(field?.relationshipName || "").trim()
  );

  if (!candidates.length) {
    return "";
  }

  if (candidates.length === 1) {
    return String(candidates[0].relationshipName || "").trim();
  }

  const normalizedTarget = normalizeLabel(targetObjectName);
  const preferred =
    candidates.find((field) => normalizeLabel(field.relationshipName).includes(normalizedTarget)) ||
    candidates.find((field) => normalizeLabel(field.name).includes(normalizedTarget)) ||
    candidates[0];

  return String(preferred?.relationshipName || "").trim();
}

async function normalizeSoqlRelationshipPath(tokenRecord, objectName, soqlField) {
  const fieldPath = String(soqlField || "").trim();
  if (!fieldPath || !fieldPath.includes(".")) {
    return fieldPath;
  }

  const [leadingSegment] = fieldPath.split(".");
  if (!leadingSegment || leadingSegment.endsWith("__r")) {
    return fieldPath;
  }

  const resolvedRelationshipName = await resolveRelationshipNameForObjectReference(
    tokenRecord,
    objectName,
    leadingSegment
  );

  if (!resolvedRelationshipName || resolvedRelationshipName === leadingSegment) {
    return fieldPath;
  }

  return replaceLeadingRelationshipToken(fieldPath, leadingSegment, resolvedRelationshipName);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceFieldReferenceInClause(clause, fromField, toField) {
  const sourceClause = String(clause || "");
  if (!sourceClause || !fromField || !toField || fromField === toField) {
    return sourceClause;
  }

  return sourceClause.replace(
    new RegExp(`\\b${escapeRegExp(fromField)}\\b`, "g"),
    toField
  );
}

async function normalizeSoqlPlanRelationships(tokenRecord, plan) {
  const objectName = String(plan?.objectName || "").trim();
  const inputFields = Array.isArray(plan?.fields) ? plan.fields : [];

  if (!objectName || !inputFields.length) {
    return plan;
  }

  const replacements = [];
  const normalizedFields = [];

  for (const field of inputFields) {
    const originalField = String(field?.soqlField || "").trim();
    const normalizedField = await normalizeSoqlRelationshipPath(
      tokenRecord,
      objectName,
      originalField
    );
    if (originalField && normalizedField && originalField !== normalizedField) {
      replacements.push({ from: originalField, to: normalizedField });
    }
    normalizedFields.push({
      ...field,
      soqlField: normalizedField || originalField,
    });
  }

  if (!replacements.length) {
    return plan;
  }

  const normalizedWhereClauses = (Array.isArray(plan.whereClauses) ? plan.whereClauses : []).map((clause) =>
    replacements.reduce(
      (updatedClause, replacement) =>
        replaceFieldReferenceInClause(updatedClause, replacement.from, replacement.to),
      clause
    )
  );

  const normalizedDateField = replacements.reduce(
    (updatedField, replacement) =>
      replaceFieldReferenceInClause(updatedField, replacement.from, replacement.to),
    String(plan.dateField || "").trim()
  );

  const normalizedFieldLookup = new Map(normalizedFields.map((field) => [String(field?.soqlField || "").trim(), field]));
  const normalizePlanFieldRef = (fieldRef) => {
    const originalSoqlField = String(fieldRef?.soqlField || "").trim();
    const updatedField = normalizedFields.find((field) => String(field?.key || "") === String(fieldRef?.key || ""));
    if (updatedField) {
      return updatedField;
    }
    return normalizedFieldLookup.get(originalSoqlField) || fieldRef;
  };

  const normalizeMetricRef = (metric) => {
    if (!metric?.field) {
      return metric;
    }
    return {
      ...metric,
      field: normalizePlanFieldRef(metric.field),
    };
  };

  return {
    ...plan,
    dateField: normalizedDateField,
    whereClauses: normalizedWhereClauses,
    fields: normalizedFields,
    scfField: plan.scfField ? normalizePlanFieldRef(plan.scfField) : plan.scfField,
    keyField: plan.keyField ? normalizePlanFieldRef(plan.keyField) : plan.keyField,
    metrics: Array.isArray(plan.metrics) ? plan.metrics.map(normalizeMetricRef) : plan.metrics,
  };
}

function buildReportMetadataAttempts(reportMetadata, dateRange) {
  const baseMetadata = {
    ...reportMetadata,
  };

  if (!baseMetadata.standardDateFilter) {
    return [baseMetadata];
  }

  const baseFilter = {
    ...baseMetadata.standardDateFilter,
  };

  const attemptWithCustomDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      durationValue: "CUSTOM",
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  };

  const attemptWithoutDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  };
  delete attemptWithoutDuration.standardDateFilter.durationValue;

  const attemptWithCurrentDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      durationValue: baseFilter.durationValue || "CURRENT_FISCAL_QUARTER",
    },
  };

  return [
    attemptWithCustomDuration,
    attemptWithoutDuration,
    attemptWithCurrentDuration,
  ];
}

async function executeReport(tokenRecord, reportId, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const reportMetadata = describePayload.reportMetadata || {};
  const dateRange = getMonthDateRange(reportMonth);
  const attempts = buildReportMetadataAttempts(reportMetadata, dateRange);
  const errors = [];

  for (const requestMetadata of attempts) {
    const response = await salesforceRequest(
      tokenRecord,
      `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
      {
        method: "POST",
        body: JSON.stringify({
          reportMetadata: requestMetadata,
        }),
      }
    );

    const payload = await response.json();
    if (response.ok) {
      return payload;
    }

    errors.push(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  throw new Error(errors[errors.length - 1] || `Unable to run Salesforce report ${reportId}.`);
}

async function executeReportForDateRange(tokenRecord, reportId, dateRange) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const reportMetadata = describePayload.reportMetadata || {};
  const attempts = buildReportMetadataAttempts(reportMetadata, dateRange);
  const errors = [];

  for (const requestMetadata of attempts) {
    const response = await salesforceRequest(
      tokenRecord,
      `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
      {
        method: "POST",
        body: JSON.stringify({
          reportMetadata: requestMetadata,
        }),
      }
    );

    const payload = await response.json();
    if (response.ok) {
      return {
        describePayload,
        reportPayload: payload,
      };
    }

    errors.push(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  throw new Error(errors[errors.length - 1] || `Unable to run Salesforce report ${reportId}.`);
}

async function executeReportWithoutDateOverride(tokenRecord, reportId) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  return executeReportWithDescribeMetadata(tokenRecord, reportId, describePayload.reportMetadata || {}, describePayload);
}

async function executeSavedReport(tokenRecord, reportId) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  return {
    describePayload,
    reportPayload: payload,
  };
}

async function fetchDashboard(tokenRecord, dashboardId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}`
  );
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to load Salesforce dashboard ${dashboardId}.`
    );
    error.statusCode = response.status;
    error.salesforcePayload = payload;
    error.salesforcePath = `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}`;
    throw error;
  }

  return payload;
}

async function fetchDashboardResults(tokenRecord, dashboardId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}/results`
  );
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to load Salesforce dashboard results ${dashboardId}.`
    );
    error.statusCode = response.status;
    error.salesforcePayload = payload;
    error.salesforcePath = `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}/results`;
    throw error;
  }

  return payload;
}

async function executeReportWithDescribeMetadata(tokenRecord, reportId, reportMetadata, describePayload = null) {
  const resolvedDescribePayload = describePayload || await fetchReportDescribe(tokenRecord, reportId);
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
    {
      method: "POST",
      body: JSON.stringify({
        reportMetadata: reportMetadata || {},
      }),
    }
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  return {
    describePayload: resolvedDescribePayload,
    reportPayload: payload,
  };
}

async function executeAsyncReportWithDescribeMetadata(tokenRecord, reportId, reportMetadata, describePayload = null) {
  const resolvedDescribePayload = describePayload || await fetchReportDescribe(tokenRecord, reportId);
  const createResponse = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}/instances`,
    {
      method: "POST",
      body: JSON.stringify({
        reportMetadata: reportMetadata || {},
      }),
    }
  );
  const createPayload = await createResponse.json();

  if (!createResponse.ok) {
    throw new Error(
      createPayload[0]?.message ||
        createPayload.message ||
        `Unable to start Salesforce async report ${reportId}.`
    );
  }

  const instancePath = String(createPayload.url || "").trim();
  if (!instancePath) {
    throw new Error(`Salesforce async report ${reportId} did not return an instance URL.`);
  }

  let lastPayload = createPayload;
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const statusValue = String(
      lastPayload?.attributes?.status ||
      lastPayload?.status ||
      ""
    ).trim().toLowerCase();
    if (statusValue === "success") {
      return {
        describePayload: resolvedDescribePayload,
        reportPayload: lastPayload,
      };
    }
    if (statusValue === "error" || statusValue === "failure") {
      throw new Error(
        lastPayload?.attributes?.errorMessage ||
        lastPayload?.errorMessage ||
        `Salesforce async report ${reportId} failed.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollResponse = await salesforceRequest(tokenRecord, instancePath, {
      method: "GET",
    });
    lastPayload = await pollResponse.json();

    if (!pollResponse.ok) {
      throw new Error(
        lastPayload?.[0]?.message ||
        lastPayload?.message ||
        `Unable to poll Salesforce async report ${reportId}.`
      );
    }
  }

  throw new Error(`Salesforce async report ${reportId} did not complete in time.`);
}

function getDetailRows(reportPayload) {
  const factMap = reportPayload.factMap || {};
  const primaryRows = factMap["T!T"]?.rows || factMap["0!T"]?.rows || [];
  if (primaryRows.length) {
    return primaryRows;
  }

  return Object.entries(factMap)
    .filter(([, value]) => Array.isArray(value?.rows) && value.rows.length > 0)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB, undefined, { numeric: true }))
    .flatMap(([, value]) => value.rows);
}

function getNestedValue(source, pathParts) {
  return pathParts.reduce((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    return current[segment];
  }, source);
}

function mapColumnLabels(reportPayload) {
  const detailColumns = reportPayload.reportMetadata?.detailColumns || [];
  const detailInfo = reportPayload.reportExtendedMetadata?.detailColumnInfo || {};

  return detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    return {
      key: columnKey,
      label: info.label || columnKey,
      normalized: normalizeLabel(info.label || columnKey),
      dataType: info.dataType || null,
    };
  });
}

function getRootObjectName(columnName) {
  const value = String(columnName || "").trim();
  if (!value) {
    return "";
  }

  return value.split(".")[0] || "";
}

function normalizeScf(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  return digits.slice(-3).padStart(3, "0");
}

function isAnalysisAggregateRow(row = {}) {
  if (!row || typeof row !== "object") {
    return false;
  }

  const keys = Object.keys(row);
  return keys.some((key) => {
    const normalized = normalizeLabel(key);
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

function isAnalysisDetailExportRow(row = {}) {
  if (!row || typeof row !== "object") {
    return false;
  }

  const scf = normalizeScf(
    row["SCF Grouping"] ??
    row["scf grouping"] ??
    row["SCF"] ??
    row.scf ??
    ""
  );
  if (!scf) {
    return false;
  }

  return !isAnalysisAggregateRow(row);
}

function hasAnalysisDetailExportRows(rows = []) {
  return Array.isArray(rows) && rows.some((row) => isAnalysisDetailExportRow(row));
}

function translateReportFieldToSoql(columnName, rootObject = null, preserveLeadingObject = false) {
  let translated = String(columnName || "").trim();

  if (!preserveLeadingObject && rootObject && translated.startsWith(`${rootObject}.`)) {
    translated = translated.slice(rootObject.length + 1);
  } else if (!preserveLeadingObject) {
    translated = translated.replace(/^[A-Za-z0-9_]+\./, "");
  }

  return translated
    .replace(/^FK_([A-Za-z0-9_]+)__c\./, "$1__r.")
    .replace(/__c\./g, "__r.");
}

function resolvePlanFieldsForObject(fields = [], objectName = "") {
  const normalizedObjectName = String(objectName || "").trim();
  return fields.map((field) => {
    const fullyQualifiedName = field?.fullyQualifiedName || field?.key || "";
    const rootObject = String(field?.rootObject || "").trim();
    const preserveLeadingObject = Boolean(
      normalizedObjectName &&
      rootObject &&
      rootObject !== normalizedObjectName
    );

    return {
      ...field,
      soqlField: translateReportFieldToSoql(
        fullyQualifiedName,
        normalizedObjectName,
        preserveLeadingObject
      ),
    };
  });
}

function mapDescribeFields(describePayload) {
  const detailColumns = describePayload.reportMetadata?.detailColumns || [];
  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};

  return detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    const fullyQualifiedName = info.fullyQualifiedName || columnKey;
    const rootObject = getRootObjectName(fullyQualifiedName);
    return {
      key: columnKey,
      label: info.label || columnKey,
      normalized: normalizeLabel(info.label || columnKey),
      dataType: info.dataType || null,
      filterValues: Array.isArray(info.filterValues) ? info.filterValues : [],
      fullyQualifiedName,
      rootObject,
      soqlField: translateReportFieldToSoql(fullyQualifiedName, rootObject),
    };
  });
}

function inferSoqlFieldDataType(fieldName) {
  const normalized = String(fieldName || "").trim().toLowerCase();

  if (
    normalized.endsWith("createddate") ||
    normalized.endsWith("lastmodifieddate") ||
    normalized.endsWith("systemmodstamp")
  ) {
    return "datetime";
  }

  return null;
}

function formatSoqlBoundaryValue(dateValue, dataType, boundary) {
  if (String(dataType || "").toLowerCase() === "datetime") {
    return boundary === "end"
      ? `${dateValue}T23:59:59Z`
      : `${dateValue}T00:00:00Z`;
  }

  return dateValue;
}

function buildRowObjectFromSoqlRecord(record, fields) {
  const rowObject = {};

  fields.forEach((field) => {
    const rawValue = getNestedValue(record, String(field.soqlField || "").split("."));
    rowObject[field.label] = rawValue ?? "";
    rowObject[field.normalized] = rawValue ?? "";

    if (
      String(field.dataType || "").toLowerCase() === "picklist" &&
      rawValue !== undefined &&
      rawValue !== null &&
      String(rawValue).trim() !== ""
    ) {
      const match = (field.filterValues || []).find((entry) => {
        return String(entry.apiName || "").trim() === String(rawValue).trim();
      });
      const displayValue = match?.label || match?.name || rawValue;
      rowObject[`${field.label}__label`] = displayValue;
      rowObject[`${field.normalized} label`] = displayValue;
    }
  });

  return applyAnalysisMetricAliases(rowObject);
}

function isNumericColumn(column) {
  return ["currency", "double", "int", "percent"].includes(column?.dataType);
}

function normalizeDetailRow(row, columnMap) {
  const normalized = {
    date: null,
    grossPremium: 0,
    ahaDues: 0,
    totalSubmitted: 0,
    numberOfMonths: 1,
    numberOfCertificates: 1,
  };
  const matched = {
    date: false,
    grossPremium: false,
    ahaDues: false,
    totalSubmitted: false,
    numberOfMonths: false,
    numberOfCertificates: false,
  };
  const numericCells = [];

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    const label = column.normalized;
    const rawValue = cell.value ?? cell.label;
    const parsedNumeric = parseNumber(rawValue);

    if (isNumericColumn(column)) {
      numericCells.push({
        index,
        label,
        value: parsedNumeric,
      });
    }

    if (!normalized.date && looksLikeDateLabel(label)) {
      normalized.date = parseDateValue(rawValue, cell.label);
      matched.date = true;
      return;
    }

    if (looksLikePremiumLabel(label)) {
      normalized.grossPremium = parsedNumeric;
      matched.grossPremium = true;
      return;
    }

    if (looksLikeDuesLabel(label)) {
      normalized.ahaDues = parsedNumeric;
      matched.ahaDues = true;
      return;
    }

    if (looksLikeAmountLabel(label)) {
      normalized.totalSubmitted = parsedNumeric;
      matched.totalSubmitted = true;
      return;
    }

    if (looksLikeMonthsLabel(label)) {
      normalized.numberOfMonths = parsedNumeric;
      matched.numberOfMonths = true;
      return;
    }

    if (looksLikeCertificateLabel(label)) {
      normalized.numberOfCertificates = parsedNumeric;
      matched.numberOfCertificates = true;
    }
  });

  if (!normalized.date) {
    throw new Error("Salesforce report row is missing a recognizable date column.");
  }

  if (!matched.grossPremium && numericCells[0]) {
    normalized.grossPremium = numericCells[0].value;
  }

  if (!matched.ahaDues && numericCells[1]) {
    normalized.ahaDues = numericCells[1].value;
  }

  if (!matched.totalSubmitted && numericCells[2]) {
    normalized.totalSubmitted = numericCells[2].value;
  }

  if (!matched.numberOfMonths && numericCells[3]) {
    normalized.numberOfMonths = numericCells[3].value || normalized.numberOfMonths;
  }

  if (!matched.numberOfCertificates && numericCells[4]) {
    normalized.numberOfCertificates =
      numericCells[4].value || normalized.numberOfCertificates;
  }

  if (
    !matched.totalSubmitted &&
    normalized.totalSubmitted === 0 &&
    (normalized.grossPremium !== 0 || normalized.ahaDues !== 0)
  ) {
    normalized.totalSubmitted = normalized.grossPremium + normalized.ahaDues;
  }

  return normalized;
}

function normalizeSummaryReportPayload(tabConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) =>
    normalizeDetailRow(row, columnMap)
  );

  return {
    key: tabConfig.key,
    tabName: tabConfig.tabName,
    transactionType: tabConfig.transactionType,
    rows,
  };
}

function escapeSoqlLiteral(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function findReportColumnInfo(describePayload, columnName) {
  const target = String(columnName || "").trim();
  if (!target) {
    return null;
  }

  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};
  if (detailInfo[target]) {
    return detailInfo[target];
  }

  const categories = describePayload.reportTypeMetadata?.categories || [];
  for (const category of categories) {
    for (const [key, column] of Object.entries(category.columns || {})) {
      if (
        key === target ||
        column?.fullyQualifiedName === target ||
        column?.entityColumnName === target
      ) {
        return column;
      }
    }
  }

  return null;
}

function normalizeFilterValues(filter, describePayload) {
  const rawValues = String(filter?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawValues.length === 0) {
    return rawValues;
  }

  const columnInfo = findReportColumnInfo(describePayload, filter?.column);
  const filterValues = Array.isArray(columnInfo?.filterValues) ? columnInfo.filterValues : [];

  if (
    String(columnInfo?.dataType || "").toLowerCase() !== "picklist" ||
    filterValues.length === 0
  ) {
    return rawValues;
  }

  return rawValues.map((value) => {
    const match = filterValues.find((entry) => {
      return (
        String(entry.apiName || "").trim().toLowerCase() === value.toLowerCase() ||
        String(entry.label || "").trim().toLowerCase() === value.toLowerCase() ||
        String(entry.name || "").trim().toLowerCase() === value.toLowerCase()
      );
    });

    return match?.apiName || value;
  });
}

function buildAggregateQueryPlan(describePayload) {
  const reportMetadata = describePayload.reportMetadata || {};
  const detailColumns = reportMetadata.detailColumns || [];
  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};

  if (detailColumns.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName = String(detailColumns[0]).split(".")[0];
  const fields = detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    const label = info.label || columnKey;
    return {
      key: columnKey,
      label,
      normalized: normalizeLabel(label),
      soqlField: translateReportFieldToSoql(columnKey),
    };
  });

  const dateField = fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const premiumField = fields.find((field) => looksLikePremiumLabel(field.normalized))?.soqlField;
  const duesField = fields.find((field) => looksLikeDuesLabel(field.normalized))?.soqlField;
  const amountField = fields.find((field) => looksLikeAmountLabel(field.normalized))?.soqlField;
  const monthsField = fields.find((field) => looksLikeMonthsLabel(field.normalized))?.soqlField;

  if (!dateField || !premiumField || !duesField || !monthsField) {
    throw new Error(
      `Unable to map required Salesforce fields for report ${reportMetadata.name || reportMetadata.id}.`
    );
  }

  return {
    objectName,
    dateField,
    premiumField,
    duesField,
    amountField,
    monthsField,
    reportMetadata,
  };
}

function buildFilterClause(filter, describePayload, rootObject = null) {
  const operator = String(filter?.operator || "").trim();
  if (!operator) {
    return null;
  }

  const translatedField = translateReportFieldToSoql(filter.column, rootObject);
  const values = normalizeFilterValues(filter, describePayload);

  if (operator === "equals") {
    if (values.length > 1) {
      return `${translatedField} IN (${values
        .map((value) => `'${escapeSoqlLiteral(value)}'`)
        .join(", ")})`;
    }

    if (values.length === 1) {
      return `${translatedField} = '${escapeSoqlLiteral(values[0])}'`;
    }
  }

  if (operator === "notContain" && values.length > 0) {
    return null;
  }

  return null;
}

function findFieldByLikelyLabels(fields, labels = []) {
  const targets = labels.map((label) => normalizeLabel(label)).filter(Boolean);
  if (!targets.length) {
    return null;
  }

  return (
    fields.find((field) => targets.includes(normalizeLabel(field.label))) ||
    fields.find((field) =>
      targets.some((target) => normalizeLabel(field.label).includes(target))
    ) ||
    null
  );
}

function buildAnalysisDetailSoqlPlan(describePayload, filters = {}) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getGroupingColumns({ reportExtendedMetadata: describePayload.reportExtendedMetadata }).map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType || "string",
      fullyQualifiedName: column.key,
      rootObject: getRootObjectName(column.key),
      soqlField: translateReportFieldToSoql(column.key, getRootObjectName(column.key)),
    })),
  ];

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);
  const resolvedFields = resolvePlanFieldsForObject(fields, objectName);

  const dateRange = resolveAnalysisDateRange(filters);
  const fallbackDateField = resolvedFields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    fallbackDateField;
  const dateFieldInfo =
    resolvedFields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  const whereClauses = [];
  if (dateRange?.startDate && dateField) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(dateRange.startDate, dateFieldInfo.dataType, "start")}`
    );
  }
  if (dateRange?.endDate && dateField) {
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(dateRange.endDate, dateFieldInfo.dataType, "end")}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  const keyField = findFieldByLikelyLabels(fields, ["Key", "Key Code", "Report Key"]);
  const scfField = findFieldByLikelyLabels(fields, ["SCF Grouping", "SCF"]);
  const resolvedKeyField = findFieldByLikelyLabels(resolvedFields, ["Key", "Key Code", "Report Key"]);
  const resolvedScfField = findFieldByLikelyLabels(resolvedFields, ["SCF Grouping", "SCF"]);
  const keyFilters = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (resolvedKeyField?.soqlField && keyFilters.length > 0) {
    if (keyFilters.length === 1) {
      whereClauses.push(`${resolvedKeyField.soqlField} = '${escapeSoqlLiteral(keyFilters[0])}'`);
    } else {
      whereClauses.push(
        `${resolvedKeyField.soqlField} IN (${keyFilters
          .map((value) => `'${escapeSoqlLiteral(value)}'`)
          .join(", ")})`
      );
    }
  }

  const normalizedScf = String(filters.scf || "").trim();
  if (resolvedScfField?.soqlField && normalizedScf) {
    whereClauses.push(`${resolvedScfField.soqlField} = '${escapeSoqlLiteral(normalizedScf)}'`);
  }

  return {
    objectName,
    dateField,
    whereClauses,
    fields: resolvedFields,
  };
}

function buildAnalysisAggregateSoqlPlan(describePayload, filters = {}) {
  const detailPlan = buildAnalysisDetailSoqlPlan(describePayload, filters);
  const fields = detailPlan.fields || [];
  const scfField = findFieldByLikelyLabels(fields, ["SCF Grouping", "SCF"]);
  const keyField = findFieldByLikelyLabels(fields, ["Key", "Key Code", "Report Key"]);

  if (!scfField?.soqlField || !keyField?.soqlField) {
    throw new Error("Analysis report is missing required SCF or Key fields.");
  }

  const metricFieldConfigs = [
    { key: "mailed", labels: ["Mailed", "Sum of Mailed"], aggregateLabel: "Sum of Mailed", dataType: "double" },
    { key: "oppCount", labels: ["Opp Count", "Sum of Opp Count", "Applications Received", "Application Count"], aggregateLabel: "Sum of Opp Count", dataType: "double" },
    { key: "inForce", labels: ["In Force", "Sum of In Force"], aggregateLabel: "Sum of In Force", dataType: "double" },
    { key: "sold", labels: ["Sold", "Sum of Sold"], aggregateLabel: "Sum of Sold", dataType: "double" },
    { key: "totalMonthlyPremium", labels: ["Total Monthly Premium", "Sum of Total Monthly Premium", "Monthly Premium", "Sold Premium"], aggregateLabel: "Sum of Total Monthly Premium", dataType: "currency" },
    { key: "inForceMonthlyPremium", labels: ["In Force Monthly Premium", "Sum of In Force Monthly Premium"], aggregateLabel: "Sum of In Force Monthly Premium", dataType: "currency" },
    { key: "totalConvertedMonthlyPremiums", labels: ["Total Converted Monthly Premiums", "Sum of Total Converted Monthly Premiums", "Converted Monthly Premium"], aggregateLabel: "Sum of Total Converted Monthly Premiums", dataType: "currency" },
  ];

  const metrics = metricFieldConfigs.map((config) => ({
    ...config,
    field: findFieldByLikelyLabels(fields, config.labels),
  }));

  return {
    ...detailPlan,
    scfField,
    keyField,
    metrics,
  };
}

function buildRawDetailSoqlPlan(describePayload) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = mapDescribeFields(describePayload);

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);
  const resolvedFields = resolvePlanFieldsForObject(fields, objectName);

  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    resolvedFields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField ||
    "";
  const dateFieldInfo =
    resolvedFields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  const whereClauses = [];
  const startDate = String(reportMetadata.standardDateFilter?.startDate || "").trim();
  const endDate = String(reportMetadata.standardDateFilter?.endDate || "").trim();

  if (dateField && startDate) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(startDate, dateFieldInfo.dataType, "start")}`
    );
  }
  if (dateField && endDate) {
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(endDate, dateFieldInfo.dataType, "end")}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  return {
    objectName,
    dateField,
    whereClauses,
    fields: resolvedFields,
  };
}

function buildAggregateSoql(describePayload, reportMonth) {
  const dateRange = getMonthDateRange(reportMonth);
  const plan = buildAggregateQueryPlan(describePayload);
  const standardDateField =
    translateReportFieldToSoql(plan.reportMetadata.standardDateFilter?.column) || plan.dateField;
  const whereClauses = [
    `${standardDateField} >= ${dateRange.startDate}`,
    `${standardDateField} <= ${dateRange.endDate}`,
  ];

  (plan.reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  const selectedAmountField = plan.amountField || plan.premiumField;
  const soql = `
SELECT ${plan.dateField}, SUM(${plan.premiumField}), SUM(${plan.duesField}), SUM(${selectedAmountField}), SUM(${plan.monthsField}), COUNT(Id)
FROM ${plan.objectName}
WHERE ${whereClauses.join("\nAND ")}
GROUP BY ${plan.dateField}
ORDER BY ${plan.dateField}
`.trim();

  return {
    soql,
    plan,
  };
}

async function runSoqlQuery(tokenRecord, soql) {
  let nextPath = `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const records = [];

  while (nextPath) {
    const response = await salesforceRequest(tokenRecord, nextPath, { method: "GET" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload[0]?.message || payload.message || "Salesforce SOQL query failed."
      );
    }

    records.push(...(payload.records || []));
    nextPath = payload.nextRecordsUrl || null;
  }

  return records;
}

async function fetchAnalysisAggregateRows(tokenRecord, describePayload, filters = {}) {
  const plan = await normalizeSoqlPlanRelationships(
    tokenRecord,
    buildAnalysisAggregateSoqlPlan(describePayload, filters)
  );
  let activeMetrics = plan.metrics.filter((metric) => metric.field?.soqlField);
  let metricAliases = [];
  let records = [];
  let lastError = null;

  while (activeMetrics.length >= 0) {
    const selectParts = [
      `${plan.scfField.soqlField} scfGrouping`,
      `${plan.keyField.soqlField} reportKey`,
    ];
    metricAliases = [];

    activeMetrics.forEach((metric) => {
      const alias = metric.key;
      metricAliases.push({ ...metric, alias });
      selectParts.push(`SUM(${metric.field.soqlField}) ${alias}`);
    });

    const whereClause = plan.whereClauses.length ? `\nWHERE ${plan.whereClauses.join("\nAND ")}` : "";
    const soql = `
SELECT ${selectParts.join(",\n       ")}
FROM ${plan.objectName}${whereClause}
GROUP BY ${plan.scfField.soqlField}, ${plan.keyField.soqlField}
ORDER BY ${plan.scfField.soqlField}, ${plan.keyField.soqlField}
`.trim();

    try {
      records = await runSoqlQuery(tokenRecord, soql);
      break;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (message.includes("can not be grouped in a query call")) {
        const detailFields = [
          plan.scfField,
          plan.keyField,
          ...activeMetrics.map((metric) => metric.field).filter(Boolean),
        ];
        const detailPlan = {
          objectName: plan.objectName,
          dateField: plan.dateField,
          whereClauses: [...plan.whereClauses],
          fields: detailFields,
        };
        const detailResult = await runDetailSoqlWithFallback(tokenRecord, detailPlan);
        const detailRows = detailResult.records.map((record) => buildRowObjectFromSoqlRecord(record, detailResult.fields));
        const aggregated = buildFlatRowsFromDetailExport(detailRows);
        return {
          columns: aggregated.columns,
          rows: aggregated.rows,
          summaryValues: aggregated.summaryValues,
        };
      }

      const invalidField = extractInvalidSoqlField(error);
      if (!invalidField) {
        throw error;
      }

      const nextMetrics = activeMetrics.filter((metric) => {
        const fieldName = String(metric.field?.soqlField || "").trim();
        return fieldName !== invalidField && !fieldName.startsWith(`${invalidField}.`);
      });

      if (nextMetrics.length === activeMetrics.length) {
        throw error;
      }

      activeMetrics = nextMetrics;
      if (activeMetrics.length === 0) {
        const baseWhereClause = plan.whereClauses.length ? `\nWHERE ${plan.whereClauses.join("\nAND ")}` : "";
        records = await runSoqlQuery(tokenRecord, `
SELECT ${plan.scfField.soqlField} scfGrouping,
       ${plan.keyField.soqlField} reportKey
FROM ${plan.objectName}${baseWhereClause}
GROUP BY ${plan.scfField.soqlField}, ${plan.keyField.soqlField}
ORDER BY ${plan.scfField.soqlField}, ${plan.keyField.soqlField}
`.trim());
        metricAliases = [];
        break;
      }
    }
  }

  if (!Array.isArray(records)) {
    throw lastError || new Error("Unable to query aggregate analysis rows.");
  }

  const rows = records.map((record) => {
    const scf = normalizeScf(record.scfGrouping ?? record[plan.scfField.soqlField] ?? "");
    const key = String(record.reportKey ?? record[plan.keyField.soqlField] ?? "").trim();
    const row = {
      "SCF Grouping": scf,
      "scf grouping": scf,
      "Key": key,
      "key": key,
    };

    metricAliases.forEach((metric) => {
      const numericValue = parseNumber(record[metric.alias]);
      row[metric.aggregateLabel] = numericValue;
      row[normalizeLabel(metric.aggregateLabel)] = numericValue;
    });

    fillAnalysisRateFallbacks(row);
    return row;
  }).filter((row) => row["SCF Grouping"]);

  return {
    columns: [
      { key: "SCF Grouping", label: "SCF Grouping", normalized: "scf grouping", dataType: "string" },
      { key: "Key", label: "Key", normalized: "key", dataType: "string" },
      ...metricAliases.map((metric) => ({
        key: metric.aggregateLabel,
        label: metric.aggregateLabel,
        normalized: normalizeLabel(metric.aggregateLabel),
        dataType: metric.dataType,
      })),
      { key: "Sold Rate", label: "Sold Rate", normalized: "sold rate", dataType: "double" },
      { key: "In Force Rate", label: "In Force Rate", normalized: "in force rate", dataType: "double" },
      { key: "Converted Rate", label: "Converted Rate", normalized: "converted rate", dataType: "double" },
    ],
    rows,
    summaryValues: buildAnalysisSummaryValuesFromRows(rows),
  };
}

async function fetchAnalysisOpportunityAggregateRows(tokenRecord, filters = {}) {
  const dateRange = resolveAnalysisDateRange(filters);
  const whereClauses = [
    "HPA_Mailer_Conversion__c != null",
  ];

  if (dateRange?.startDate) {
    whereClauses.push(
      `HPA_Mailer_Conversion__r.HPA_Mail_Date__c >= ${formatSoqlBoundaryValue(dateRange.startDate, "date", "start")}`
    );
  }
  if (dateRange?.endDate) {
    whereClauses.push(
      `HPA_Mailer_Conversion__r.HPA_Mail_Date__c <= ${formatSoqlBoundaryValue(dateRange.endDate, "date", "end")}`
    );
  }

  const keyFilters = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => normalizeAnalysisKeyCodeValue(value).toUpperCase()).filter(Boolean)
    : [];
  if (keyFilters.length === 1) {
    whereClauses.push(`HPA_Key__c = '${escapeSoqlLiteral(keyFilters[0])}'`);
  } else if (keyFilters.length > 1) {
    whereClauses.push(
      `HPA_Key__c IN (${keyFilters
        .map((value) => `'${escapeSoqlLiteral(value)}'`)
        .join(", ")})`
    );
  }

  const normalizedScf = normalizeScf(filters.scf);
  if (normalizedScf) {
    whereClauses.push(`HPA_SCF__c = '${escapeSoqlLiteral(normalizedScf)}'`);
  }

  const soql = `
SELECT HPA_SCF__c,
       HPA_Key__c,
       HPA_In_Force__c,
       Monthly_Premium_Formula__c,
       HPA_In_Force_Monthly_Premium__c,
       HPATotal_Converted_Monthly_Premiums__c,
       Payments_Minus_Credits__c
FROM Opportunity
WHERE ${whereClauses.join("\nAND ")}
ORDER BY HPA_SCF__c, HPA_Key__c
`.trim();

  const records = await runSoqlQuery(tokenRecord, soql);
  const detailRows = records.map((record) => ({
    "SCF Grouping": normalizeScf(record.HPA_SCF__c ?? ""),
    "Key": String(record.HPA_Key__c ?? "").trim(),
    "In Force": parseNumber(record.HPA_In_Force__c),
    "Total Monthly Premium": parseNumber(record.Monthly_Premium_Formula__c),
    "In Force Monthly Premium": parseNumber(record.HPA_In_Force_Monthly_Premium__c),
    "Total Converted Monthly Premiums": parseNumber(record.HPATotal_Converted_Monthly_Premiums__c),
    "Payments Minus Credits": parseNumber(record.Payments_Minus_Credits__c),
  })).filter((row) => row["SCF Grouping"]);

  return buildFlatRowsFromDetailExport(detailRows);
}

async function fetchAggregateReportRows(tokenRecord, reportConfig, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const { soql, plan } = buildAggregateSoql(describePayload, reportMonth);
  const records = await runSoqlQuery(tokenRecord, soql);

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows: records.map((record) => ({
      date: record[plan.dateField],
      grossPremium: parseNumber(record.expr0),
      ahaDues: parseNumber(record.expr1),
      totalSubmitted: parseNumber(record.expr2),
      numberOfMonths: parseNumber(record.expr3),
      numberOfCertificates: parseNumber(record.expr4),
    })),
  };
}

function getCellValue(cell) {
  return cell?.value ?? cell?.label ?? "";
}

function buildRowObject(row, columnMap) {
  const result = {};

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    result[column.label] = getCellValue(cell);
    result[column.normalized] = getCellValue(cell);

    if (cell?.label !== undefined && cell?.label !== null && String(cell.label).trim() !== "") {
      result[`${column.label}__label`] = cell.label;
      result[`${column.normalized} label`] = cell.label;
    }
  });

  return applyAnalysisMetricAliases(result);
}

function buildDisplayRowObject(row, columnMap) {
  const result = {};

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    const displayValue =
      cell?.label !== undefined && cell?.label !== null ? cell.label : getCellValue(cell);
    result[column.label] = displayValue ?? "";
    result[column.normalized] = displayValue ?? "";
    const rawValue = getCellValue(cell);
    if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== "") {
      result[`${column.label}__value`] = rawValue;
      result[`${column.normalized} value`] = rawValue;
    }
  });

  return applyAnalysisMetricAliases(result);
}

function getGroupingColumns(reportPayload) {
  const groupingInfo = reportPayload.reportExtendedMetadata?.groupingColumnInfo || {};
  return Object.values(groupingInfo)
    .filter((entry) => Number.isInteger(entry.groupingLevel))
    .sort((a, b) => a.groupingLevel - b.groupingLevel)
    .map((entry) => ({
      key: entry.fullyQualifiedName || entry.entityColumnName || entry.label,
      label: entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping",
      normalized: normalizeLabel(entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping"),
      groupingLevel: entry.groupingLevel,
      dataType: entry.dataType || "string",
    }));
}

function getAggregateColumns(reportPayload) {
  const aggregateIds = reportPayload.reportMetadata?.aggregates || [];
  const aggregateInfo = reportPayload.reportExtendedMetadata?.aggregateColumnInfo || {};
  return aggregateIds.map((aggregateId) => {
    const info = aggregateInfo[aggregateId] || {};
    return {
      key: aggregateId,
      label: info.label || aggregateId,
      normalized: normalizeLabel(info.label || aggregateId),
      dataType: info.dataType || null,
    };
  });
}

function buildSummaryAggregateValues(reportPayload, aggregateColumns) {
  const totalEntry = reportPayload.factMap?.["T!T"] || reportPayload.factMap?.["0!T"] || null;
  const aggregates = Array.isArray(totalEntry?.aggregates) ? totalEntry.aggregates : [];
  if (!aggregates.length) {
    return [];
  }

  return aggregateColumns.map((column, index) => ({
    key: column.key,
    label: column.label,
    value: aggregates[index]?.label ?? "",
  }));
}

function buildAnalysisSummaryValuesFromRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const totals = safeRows.reduce((acc, row) => {
    acc.mailed += parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.mailed) ?? 0);
    acc.oppCount += resolveAnalysisSoldOpportunityCount(row, {
      convertedCountFallback: 0,
    });
    acc.inForce += parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.inForce) ?? 0);
    acc.sold += resolveAnalysisConvertedCount(row, null, {
      allowPremiumRowInference: false,
    });
    acc.totalMonthlyPremium += parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.totalMonthlyPremium) ?? 0);
    acc.inForceMonthlyPremium += parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.inForceMonthlyPremium) ?? 0);
    acc.totalConvertedMonthlyPremiums += getConvertedPremiumAmount(row);
    return acc;
  }, {
    mailed: 0,
    oppCount: 0,
    inForce: 0,
    sold: 0,
    totalMonthlyPremium: 0,
    inForceMonthlyPremium: 0,
    totalConvertedMonthlyPremiums: 0,
  });

  const averageMonthlyPremium = totals.oppCount > 0
    ? totals.totalMonthlyPremium / totals.oppCount
    : 0;

  return [
    { key: "Sum of Mailed", label: "Sum of Mailed", value: Math.round(totals.mailed).toLocaleString("en-US") },
    { key: "Sum of Opp Count", label: "Sum of Opp Count", value: Math.round(totals.oppCount).toLocaleString("en-US") },
    { key: "Sum of In Force", label: "Sum of In Force", value: Math.round(totals.inForce).toLocaleString("en-US") },
    { key: "Sum of Sold", label: "Sum of Sold", value: Math.round(totals.sold).toLocaleString("en-US") },
    { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", value: totals.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", value: totals.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", value: totals.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
  ];
}

function fillAnalysisRateFallbacks(row = {}) {
  const hasExplicitSoldRate = hasAnalysisMetricValue(row, ["Sold Rate"]);
  const hasExplicitInForceRate = hasAnalysisMetricValue(row, ["In Force Rate"]);
  const hasExplicitConvertedRate = hasAnalysisMetricValue(row, ["Converted Rate"]);
  applyAnalysisMetricAliases(row);
  const mailed = parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.mailed) ?? 0);
  const inForce = parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.inForce) ?? 0);
  const totalMonthlyPremium = parseNumber(getAnalysisMetricValue(row, ANALYSIS_METRIC_LABELS.totalMonthlyPremium) ?? 0);
  const totalConvertedMonthlyPremiums = resolveAnalysisConvertedPremiumValue(row);
  const convertedCount = resolveAnalysisConvertedCount(row, totalConvertedMonthlyPremiums, {
    allowPremiumRowInference: false,
  });
  const soldCount = resolveAnalysisSoldOpportunityCount(row, {
    convertedCountFallback: convertedCount,
  });
  const explicitSoldRate = resolveAnalysisExplicitRate(row, ["Sold Rate"]);
  const explicitInForceRate = resolveAnalysisExplicitRate(row, ["In Force Rate"]);
  const explicitConvertedRate = resolveAnalysisExplicitRate(row, ["Converted Rate"]);
  const fallbackCountRates = calculateAnalysisCountRates({
    mailed,
    soldCount,
    inForceCount: inForce,
    convertedCount,
  });
  const nextSoldRate = explicitSoldRate ?? fallbackCountRates.soldRate;
  const nextInForceRate = explicitInForceRate ?? fallbackCountRates.inForceRate;
  const nextConvertedRate = calculateAnalysisConvertedRate({
    convertedCount,
    soldCount,
    inForceCount: inForce,
    soldRate: explicitSoldRate,
    inForceRate: explicitInForceRate,
    convertedRate: explicitConvertedRate,
    totalConvertedMonthlyPremiums,
    mailed,
  });

  setAnalysisMetricAliases(
    row,
    ANALYSIS_METRIC_LABELS.oppCount,
    Math.round(soldCount).toLocaleString("en-US")
  );
  setAnalysisMetricAliases(
    row,
    ANALYSIS_METRIC_LABELS.sold,
    Math.round(convertedCount).toLocaleString("en-US")
  );
  setAnalysisMetricAliases(
    row,
    ANALYSIS_METRIC_LABELS.convertedCount,
    Math.round(convertedCount).toLocaleString("en-US")
  );
  row.salesforceSoldRate = explicitSoldRate;
  row.salesforceInForceRate = explicitInForceRate;
  row.salesforceConvertedRate = explicitConvertedRate;
  row.appConvertedRate = nextConvertedRate;

  if (!hasExplicitSoldRate) {
    row["Sold Rate"] = nextSoldRate.toFixed(10);
    row["sold rate"] = nextSoldRate.toFixed(10);
  }
  if (!hasExplicitInForceRate) {
    row["In Force Rate"] = nextInForceRate.toFixed(10);
    row["in force rate"] = nextInForceRate.toFixed(10);
  }
  if (!hasExplicitConvertedRate || Number.isFinite(nextConvertedRate)) {
    row["Converted Rate"] = nextConvertedRate.toFixed(10);
    row["converted rate"] = nextConvertedRate.toFixed(10);
  }
  const averageMonthlyPremium = soldCount > 0 ? totalMonthlyPremium / soldCount : 0;
  row.averageMonthlyPremium = averageMonthlyPremium;
  return row;
}

function resolveFactMapGroupingKey(path = []) {
  const segments = (Array.isArray(path) ? path : [])
    .map((entry) => String(entry?.key || "").trim())
    .filter(Boolean);

  if (!segments.length) {
    return "";
  }

  const leafKey = segments[segments.length - 1];
  return leafKey || segments.join("_");
}

function buildGroupedReportRows(reportPayload) {
  const groupingColumns = getGroupingColumns(reportPayload);
  const aggregateColumns = getAggregateColumns(reportPayload);
  const downGroups = reportPayload.groupingsDown?.groupings || [];
  const factMap = reportPayload.factMap || {};

  if (!groupingColumns.length || !aggregateColumns.length || !downGroups.length) {
    return null;
  }

  const rows = [];
  const visitGrouping = (group, path = []) => {
    const nextPath = [...path, group];
    const children = Array.isArray(group.groupings) ? group.groupings : [];
    if (children.length > 0) {
      children.forEach((child) => visitGrouping(child, nextPath));
      return;
    }

    const groupingKey = resolveFactMapGroupingKey(nextPath);
    const factKey = `${groupingKey}!T`;
    const factEntry = factMap[factKey];
    const factAggregates = Array.isArray(factEntry?.aggregates) ? factEntry.aggregates : [];
    if (!factAggregates.length) {
      return;
    }

    const row = {};
    groupingColumns.forEach((column, index) => {
      const grouping = nextPath[index];
      const value = grouping?.label ?? "";
      row[column.label] = value;
      row[column.normalized] = value;
    });

    aggregateColumns.forEach((column, index) => {
      const value = factAggregates[index]?.label ?? "";
      row[column.label] = value;
      row[column.normalized] = value;
    });

    fillAnalysisRateFallbacks(row);
    rows.push(row);
  };

  downGroups.forEach((group) => visitGrouping(group, []));

  rows.sort((rowA, rowB) => {
    const soldRateA = parseNumber(rowA["Sold Rate"] ?? rowA["sold rate"]);
    const soldRateB = parseNumber(rowB["Sold Rate"] ?? rowB["sold rate"]);
    if (soldRateB !== soldRateA) {
      return soldRateB - soldRateA;
    }

    const scfA = String(rowA["SCF Grouping"] ?? rowA["scf grouping"] ?? "");
    const scfB = String(rowB["SCF Grouping"] ?? rowB["scf grouping"] ?? "");
    return scfA.localeCompare(scfB, undefined, { numeric: true });
  });

  return {
    columns: [
      ...groupingColumns.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
      ...aggregateColumns,
    ],
    rows,
    summaryValues: buildSummaryAggregateValues(reportPayload, aggregateColumns),
  };
}

function buildGroupingPathLookup(groups = [], path = [], lookup = new Map()) {
  groups.forEach((group) => {
    const nextPath = [...path, group];
    const children = Array.isArray(group.groupings) ? group.groupings : [];
    if (children.length > 0) {
      buildGroupingPathLookup(children, nextPath, lookup);
      return;
    }
    const groupingKey = resolveFactMapGroupingKey(nextPath);
    lookup.set(groupingKey, nextPath);
  });
  return lookup;
}

function buildDetailExportRows(reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const groupingColumns = getGroupingColumns(reportPayload);
  const groupingLookup = buildGroupingPathLookup(reportPayload.groupingsDown?.groupings || []);
  const factMap = reportPayload.factMap || {};
  const rows = [];

  Object.entries(factMap)
    .filter(([, value]) => Array.isArray(value?.rows) && value.rows.length > 0)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB, undefined, { numeric: true }))
    .forEach(([factKey, value]) => {
      const groupingKey = String(factKey).replace(/!T$/, "");
      const groupingPath = groupingLookup.get(groupingKey) || [];
      value.rows.forEach((row) => {
        const output = buildDisplayRowObject(row, columnMap);
        groupingColumns.forEach((column, index) => {
          const grouping = groupingPath[index];
          const label = grouping?.label || "";
          output[column.label] = label;
          output[column.normalized] = label;
        });
        rows.push(output);
      });
    });

  return {
    columns: [
      ...columnMap.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
      ...groupingColumns.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
    ],
    rows,
  };
}

async function enrichAnalysisDetailRowsWithMailerGrouping(tokenRecord, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return list;
  }

  const ids = Array.from(new Set(
    list
      .filter((row) => !normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? ""))
      .map((row) =>
        String(
          row["Mailer Conversion Name__value"] ??
          row["mailer conversion name value"] ??
          row["Mailer Conversion Name"] ??
          row["mailer conversion name"] ??
          ""
        ).trim()
      )
      .filter((value) => /^a1f/i.test(value))
  ));

  if (!ids.length) {
    return list;
  }

  const lookup = new Map();
  const chunkSize = 200;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const soql = `
SELECT Id, HPA_SCF_Grouping__c, HPA_Report_Key__c
FROM HPA_Mailer_Conversion__c
WHERE Id IN (${chunk.map((value) => `'${escapeSoqlLiteral(value)}'`).join(", ")})
`.trim();
    const records = await runSoqlQuery(tokenRecord, soql);
    records.forEach((record) => {
      lookup.set(String(record.Id || "").trim(), {
        scf: normalizeScf(record.HPA_SCF_Grouping__c ?? ""),
        key: String(record.HPA_Report_Key__c ?? "").trim(),
      });
    });
  }

  return list.map((row) => {
    const currentScf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? "");
    if (currentScf) {
      return row;
    }
    const mailerId = String(
      row["Mailer Conversion Name__value"] ??
      row["mailer conversion name value"] ??
      ""
    ).trim();
    const match = lookup.get(mailerId);
    if (!match?.scf) {
      return row;
    }

    const enriched = { ...row };
    enriched["SCF Grouping"] = match.scf;
    enriched["scf grouping"] = match.scf;
    if (match.key) {
      enriched["Key"] = match.key;
      enriched["key"] = match.key;
    }
    return enriched;
  });
}

function getAnalysisDebugLabel(filters = {}) {
  const keyCode = Array.isArray(filters.keyCodes) && filters.keyCodes.length
    ? String(filters.keyCodes[0] || "").trim().toUpperCase()
    : "";
  if (keyCode === "N" || keyCode === "NHCL") {
    return "NHCL";
  }
  if (keyCode === "RFC") {
    return "RFC";
  }
  return sanitizeDebugToken(keyCode || "UNKNOWN");
}

function buildAnalysisDebugFilePath(label) {
  return path.join(__dirname, "..", `${ANALYSIS_DEBUG_FILE_PREFIX}-${sanitizeDebugToken(label)}.json`);
}

function getAnalysisDebugFilePath(label) {
  return buildAnalysisDebugFilePath(label);
}

function writeAnalysisDebugJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function buildAnalysisReportPayloadDebugSnapshot(reportId, filters, describePayload, reportPayload) {
  const firstTenRows = getDetailRows(reportPayload)
    .slice(0, 10)
    .map((row, index) => ({
      index,
      dataCells: Array.isArray(row?.dataCells)
        ? row.dataCells.map((cell, cellIndex) => ({
            index: cellIndex,
            label: cell?.label ?? null,
            value: cell?.value ?? null,
          }))
        : [],
    }));

  return {
    generatedAt: new Date().toISOString(),
    reportId,
    filters,
    reportMetadata: reportPayload?.reportMetadata || null,
    describeReportMetadata: describePayload?.reportMetadata || null,
    detailColumns: reportPayload?.reportMetadata?.detailColumns || [],
    detailColumnInfo: reportPayload?.reportExtendedMetadata?.detailColumnInfo || {},
    aggregateColumns: reportPayload?.reportMetadata?.aggregates || [],
    aggregateColumnInfo: reportPayload?.reportExtendedMetadata?.aggregateColumnInfo || {},
    groupingColumnInfo: reportPayload?.reportExtendedMetadata?.groupingColumnInfo || {},
    groupingsDown: reportPayload?.groupingsDown || null,
    groupingsAcross: reportPayload?.groupingsAcross || null,
    factMap: reportPayload?.factMap || {},
    firstTenRows,
  };
}

function buildConvertedDiagnosticsPayload({
  reportId,
  reportName = "",
  describePayload = null,
  reportPayload = null,
  rawDetailRows = [],
  normalizedRows = [],
} = {}) {
  const columnMap = reportPayload ? mapColumnLabels(reportPayload) : [];
  const availableColumns = columnMap.map((column) => ({
    apiName: column.key,
    label: column.label,
    normalized: column.normalized,
  }));
  const allColumnApiNames = availableColumns.map((column) => column.apiName);
  const allColumnLabels = availableColumns.map((column) => column.label);
  const convertedCandidateColumns = availableColumns.filter((column) =>
    /converted|payment.*received/i.test(`${column.apiName} ${column.label}`)
  );
  const convertedSummary = buildConvertedDebugSummary(normalizedRows);

  return {
    reportId,
    reportName: reportName || describePayload?.reportMetadata?.name || reportPayload?.reportMetadata?.name || "",
    allColumnApiNames,
    allColumnLabels,
    availableColumns,
    convertedCandidateColumns,
    sampleRawRows: rawDetailRows.slice(0, 3).map((row, index) => ({
      index,
      dataCells: Array.isArray(row?.dataCells)
        ? row.dataCells.map((cell, cellIndex) => ({
            index: cellIndex,
            label: cell?.label ?? null,
            value: cell?.value ?? null,
          }))
        : [],
    })),
    sampleNormalizedRows: normalizedRows.slice(0, 3),
    convertedResolutionSamples: convertedSummary.convertedResolutionSamples,
    totalRowsChecked: convertedSummary.totalRowsChecked,
    rowsWithConvertedSource: convertedSummary.rowsWithConvertedSource,
    rowsWithConvertedNumericValue: convertedSummary.rowsWithConvertedNumericValue,
    convertedTotalFromSource: convertedSummary.convertedTotalFromSource,
    warnings: convertedSummary.warnings,
  };
}

function findAnalysisRowByScf(rows = [], targetScf = "") {
  const normalizedTargetScf = normalizeScf(targetScf);
  if (normalizedTargetScf) {
    const exact = rows.find((row) => normalizeScf(row?.["SCF Grouping"] ?? row?.["scf grouping"] ?? "") === normalizedTargetScf);
    if (exact) {
      return exact;
    }
  }
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function buildAnalysisRowDebugTrace(groupedRows = [], finalRows = [], targetScf = "047") {
  const groupedRow = findAnalysisRowByScf(groupedRows, targetScf);
  const finalRow = findAnalysisRowByScf(finalRows, targetScf);
  const selectedScf = normalizeScf(
    groupedRow?.["SCF Grouping"] ??
    groupedRow?.["scf grouping"] ??
    finalRow?.["SCF Grouping"] ??
    finalRow?.["scf grouping"] ??
    targetScf
  );

  const fieldMap = [
    { key: "scfGrouping", labels: ["SCF Grouping"] },
    { key: "key", labels: ["Key"] },
    { key: "mailed", labels: ANALYSIS_METRIC_LABELS.mailed },
    { key: "applicationsReceived", labels: ANALYSIS_METRIC_LABELS.oppCount },
    { key: "inForce", labels: ANALYSIS_METRIC_LABELS.inForce },
    { key: "converted", labels: ANALYSIS_METRIC_LABELS.sold },
    { key: "totalSold", labels: ANALYSIS_METRIC_LABELS.totalMonthlyPremium },
    { key: "inForceMonthlyPremium", labels: ANALYSIS_METRIC_LABELS.inForceMonthlyPremium },
    { key: "totalConvertedMonthlyPremiums", labels: ANALYSIS_METRIC_LABELS.totalConvertedMonthlyPremiums },
    { key: "soldRate", labels: ["Sold Rate"] },
    { key: "inForceRate", labels: ["In Force Rate"] },
    { key: "convertedRate", labels: ["Converted Rate"] },
  ];

  const fields = {};
  fieldMap.forEach(({ key, labels }) => {
    fields[key] = {
      salesforceRaw: groupedRow ? getAnalysisMetricValue(groupedRow, labels) : undefined,
      parsedGroupedValue: groupedRow ? getAnalysisMetricValue(applyAnalysisMetricAliases({ ...groupedRow }), labels) : undefined,
      finalDisplayedValue: finalRow ? getAnalysisMetricValue(finalRow, labels) : undefined,
    };
  });

  return {
    targetScfRequested: targetScf,
    selectedScf,
    groupedRowRaw: groupedRow,
    finalRowRaw: finalRow,
    fields,
  };
}

async function buildFullDetailExportRows(tokenRecord, describePayload, filters = {}) {
  const plan = await normalizeSoqlPlanRelationships(
    tokenRecord,
    buildAnalysisDetailSoqlPlan(describePayload, filters)
  );
  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  const rows = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

  return {
    columns: fields.map((field) => ({
      key: field.key || field.soqlField,
      label: field.label || field.soqlField,
      normalized: field.normalized || normalizeLabel(field.label || field.soqlField),
      dataType: field.dataType || null,
    })),
    rows,
  };
}

function shouldFallbackToSoqlForReportPayload(reportPayload) {
  return (
    reportPayload?.allData === false &&
    reportPayload?.hasExceededTabularRowLimit === true
  );
}

function countRowsWithScfValue(rows = []) {
  return rows.filter((row) =>
    Object.entries(row || {}).some(([key, rawValue]) => {
      if (String(key).endsWith("__label")) {
        return false;
      }
      if (!normalizeLabel(key).includes("scf")) {
        return false;
      }
      return String(rawValue || "").trim() !== "";
    })
  ).length;
}

function choosePreferredAnalysisExportRows(primaryExport, fallbackExport) {
  const primaryRows = Array.isArray(primaryExport?.rows) ? primaryExport.rows : [];
  const fallbackRows = Array.isArray(fallbackExport?.rows) ? fallbackExport.rows : [];

  if (!fallbackRows.length) {
    return primaryExport;
  }

  if (!primaryRows.length) {
    return fallbackExport;
  }

  const primaryScfRowCount = countRowsWithScfValue(primaryRows);
  const fallbackScfRowCount = countRowsWithScfValue(fallbackRows);

  if (fallbackScfRowCount > primaryScfRowCount) {
    return fallbackExport;
  }

  if (fallbackScfRowCount === primaryScfRowCount && fallbackRows.length > primaryRows.length) {
    return fallbackExport;
  }

  return primaryExport;
}

function normalizeAnalysisDateValue(value) {
  const normalized = String(value || "").trim().replace(/\//g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function buildFlatReportRows(reportPayload) {
  const grouped = buildGroupedReportRows(reportPayload);
  if (grouped) {
    return grouped;
  }

  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap));

  return {
    columns: columnMap.map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType,
    })),
    rows,
    summaryValues: [],
  };
}

function buildFlatRowsFromDetailExport(exportRows = []) {
  const aggregateMap = new Map();
  let convertedPremiumRowCount = 0;
  let convertedCountTotal = 0;
  exportRows.forEach((row) => {
    const scf = normalizeScf(
      row["SCF Grouping"] ??
      row["scf grouping"] ??
      row["SCF"] ??
      row.scf ??
      ""
    );
    if (!scf) {
      return;
    }

    const keyCode = String(
      row["Key"] ??
      row.key ??
      row["Report Key"] ??
      row["report key"] ??
      ""
    ).trim();
    const aggregateKey = `${scf}::${keyCode}`;
    const rowTotalMonthlyPremium = parseNumber(
      getLikelyColumnValue(row, [
        "Total Monthly Premium",
        "Sum of Total Monthly Premium",
        "Monthly Premium",
        "Sold Premium",
      ]) ?? 0
    );
    const rowInForceMonthlyPremium = parseNumber(
      getLikelyColumnValue(row, [
        "In Force Monthly Premium",
        "Sum of In Force Monthly Premium",
      ]) ?? 0
    );
    const rowConvertedPremium = getConvertedPremiumAmount(row, parseMoneyNumber(
      getLikelyColumnValue(row, [
        "Payments Minus Credits",
        "Payments_Minus_Credits__c",
        "Total Converted Monthly Premiums",
        "Sum of Total Converted Monthly Premiums",
        "Converted Monthly Premium",
      ]) ?? 0
    ));
    const rowConvertedCount = getConvertedCountForSourceRow(row, rowConvertedPremium);
    const rowSoldCount = resolveAnalysisSoldOpportunityCount(row, {
      convertedCountFallback: rowConvertedCount,
    });
    if (rowConvertedCount > 0) {
      convertedPremiumRowCount += 1;
      convertedCountTotal += rowConvertedCount;
    }
    const rowSalesforceSoldRate = resolveAnalysisExplicitRate(row, ["Sold Rate"]);
    const rowSalesforceInForceRate = resolveAnalysisExplicitRate(row, ["In Force Rate"]);
    const rowSalesforceConvertedRate = resolveAnalysisExplicitRate(row, ["Converted Rate"]);
    const rowApplicationPremium = rowTotalMonthlyPremium > 0
      ? rowTotalMonthlyPremium
      : rowConvertedPremium > 0
        ? rowConvertedPremium
        : rowInForceMonthlyPremium > 0
          ? rowInForceMonthlyPremium
          : 0;
    const current = aggregateMap.get(aggregateKey) || {
      scf,
      keyCode,
      mailed: 0,
      oppCount: 0,
      inForce: 0,
      sold: 0,
      totalMonthlyPremium: 0,
      inForceMonthlyPremium: 0,
      totalConvertedMonthlyPremiums: 0,
      applicationPremiumTotal: 0,
      highPremium: null,
      lowPremium: null,
      salesforceSoldRate: null,
      salesforceInForceRate: null,
      salesforceConvertedRate: null,
    };

    current.mailed += parseNumber(
      getLikelyColumnValue(row, [
        "Mailed",
        "Sum of Mailed",
      ]) ?? 0
    );
    current.oppCount += rowSoldCount;
    current.inForce += parseNumber(
      getLikelyColumnValue(row, [
        "In Force",
        "Sum of In Force",
      ]) ?? 0
    );
    current.totalMonthlyPremium += rowTotalMonthlyPremium;
    current.inForceMonthlyPremium += rowInForceMonthlyPremium;
    current.totalConvertedMonthlyPremiums += rowConvertedPremium;
    current.sold += rowConvertedCount;
    if ((current.salesforceSoldRate === null || current.salesforceSoldRate === 0) && Number.isFinite(rowSalesforceSoldRate) && rowSalesforceSoldRate !== 0) {
      current.salesforceSoldRate = rowSalesforceSoldRate;
    }
    if ((current.salesforceInForceRate === null || current.salesforceInForceRate === 0) && Number.isFinite(rowSalesforceInForceRate) && rowSalesforceInForceRate !== 0) {
      current.salesforceInForceRate = rowSalesforceInForceRate;
    }
    if ((current.salesforceConvertedRate === null || current.salesforceConvertedRate === 0) && Number.isFinite(rowSalesforceConvertedRate) && rowSalesforceConvertedRate !== 0) {
      current.salesforceConvertedRate = rowSalesforceConvertedRate;
    }
    if (rowSoldCount > 0 && rowApplicationPremium > 0) {
      current.applicationPremiumTotal += rowApplicationPremium;
      current.highPremium = current.highPremium === null
        ? rowApplicationPremium
        : Math.max(current.highPremium, rowApplicationPremium);
      current.lowPremium = current.lowPremium === null
        ? rowApplicationPremium
        : Math.min(current.lowPremium, rowApplicationPremium);
    }
    aggregateMap.set(aggregateKey, current);
  });

  const rows = Array.from(aggregateMap.values())
    .sort((entryA, entryB) => {
      const soldRateA = Number.isFinite(entryA.salesforceSoldRate)
        ? entryA.salesforceSoldRate
        : calculateAnalysisCountRates({
            mailed: entryA.mailed,
            soldCount: entryA.oppCount,
            inForceCount: entryA.inForce,
            convertedCount: entryA.sold,
          }).soldRate;
      const soldRateB = Number.isFinite(entryB.salesforceSoldRate)
        ? entryB.salesforceSoldRate
        : calculateAnalysisCountRates({
            mailed: entryB.mailed,
            soldCount: entryB.oppCount,
            inForceCount: entryB.inForce,
            convertedCount: entryB.sold,
          }).soldRate;
      if (soldRateB !== soldRateA) {
        return soldRateB - soldRateA;
      }
      if (entryA.scf !== entryB.scf) {
        return entryA.scf.localeCompare(entryB.scf, undefined, { numeric: true });
      }
      return entryA.keyCode.localeCompare(entryB.keyCode, undefined, { numeric: true });
    })
    .map((entry) => {
      const fallbackRates = calculateAnalysisCountRates({
        mailed: entry.mailed,
        soldCount: entry.oppCount,
        inForceCount: entry.inForce,
        convertedCount: entry.sold,
      });
      const soldRate = Number.isFinite(entry.salesforceSoldRate) ? entry.salesforceSoldRate : fallbackRates.soldRate;
      const inForceRate = Number.isFinite(entry.salesforceInForceRate) ? entry.salesforceInForceRate : fallbackRates.inForceRate;
      const convertedRate = calculateAnalysisConvertedRate({
        convertedCount: entry.sold,
        soldCount: entry.oppCount,
        inForceCount: entry.inForce,
        soldRate: entry.salesforceSoldRate,
        inForceRate: entry.salesforceInForceRate,
        convertedRate: entry.salesforceConvertedRate,
        totalConvertedMonthlyPremiums: entry.totalConvertedMonthlyPremiums,
        mailed: entry.mailed,
      });
      const averageSoldPremium = entry.oppCount > 0 ? entry.applicationPremiumTotal / entry.oppCount : 0;

      return {
        "SCF Grouping": entry.scf,
        "scf grouping": entry.scf,
        "Key": entry.keyCode,
        "key": entry.keyCode,
        "Sum of Mailed": Math.round(entry.mailed).toLocaleString("en-US"),
        "sum of mailed": Math.round(entry.mailed).toLocaleString("en-US"),
        "Sum of Opp Count": Math.round(entry.oppCount).toLocaleString("en-US"),
        "sum of opp count": Math.round(entry.oppCount).toLocaleString("en-US"),
        "Sum of Sold": Math.round(entry.sold).toLocaleString("en-US"),
        "sum of sold": Math.round(entry.sold).toLocaleString("en-US"),
        "Sum of In Force": Math.round(entry.inForce).toLocaleString("en-US"),
        "sum of in force": Math.round(entry.inForce).toLocaleString("en-US"),
        "Sum of Converted": Math.round(entry.sold).toLocaleString("en-US"),
        "sum of converted": Math.round(entry.sold).toLocaleString("en-US"),
        "Converted": Math.round(entry.sold).toLocaleString("en-US"),
        "converted": Math.round(entry.sold).toLocaleString("en-US"),
        "Sum of Total Monthly Premium": entry.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of total monthly premium": entry.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "Sum of In Force Monthly Premium": entry.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of in force monthly premium": entry.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "Sum of Total Converted Monthly Premiums": entry.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of total converted monthly premiums": entry.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        averageMonthlyPremium: averageSoldPremium,
        highPremium: entry.highPremium,
        lowPremium: entry.lowPremium,
        salesforceSoldRate: Number.isFinite(entry.salesforceSoldRate) ? entry.salesforceSoldRate : null,
        salesforceInForceRate: Number.isFinite(entry.salesforceInForceRate) ? entry.salesforceInForceRate : null,
        salesforceConvertedRate: Number.isFinite(entry.salesforceConvertedRate) ? entry.salesforceConvertedRate : null,
        appConvertedRate: convertedRate,
        "Sold Rate": soldRate.toFixed(10),
        "sold rate": soldRate.toFixed(10),
        "In Force Rate": inForceRate.toFixed(10),
        "in force rate": inForceRate.toFixed(10),
        "Converted Rate": convertedRate.toFixed(10),
        "converted rate": convertedRate.toFixed(10),
      };
    });

  return {
    columns: [
      { key: "SCF Grouping", label: "SCF Grouping", normalized: "scf grouping", dataType: "string" },
      { key: "Key", label: "Key", normalized: "key", dataType: "string" },
      { key: "Sum of Mailed", label: "Sum of Mailed", normalized: "sum of mailed", dataType: "double" },
      { key: "Sum of Opp Count", label: "Sum of Opp Count", normalized: "sum of opp count", dataType: "double" },
      { key: "Sum of In Force", label: "Sum of In Force", normalized: "sum of in force", dataType: "double" },
      { key: "Sum of Sold", label: "Sum of Sold", normalized: "sum of sold", dataType: "double" },
      { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", normalized: "sum of total monthly premium", dataType: "currency" },
      { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", normalized: "sum of in force monthly premium", dataType: "currency" },
      { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", normalized: "sum of total converted monthly premiums", dataType: "currency" },
      { key: "Sold Rate", label: "Sold Rate", normalized: "sold rate", dataType: "double" },
      { key: "In Force Rate", label: "In Force Rate", normalized: "in force rate", dataType: "double" },
      { key: "Converted Rate", label: "Converted Rate", normalized: "converted rate", dataType: "double" },
    ],
    rows,
    summaryValues: [
      { key: "Sum of Mailed", label: "Sum of Mailed", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.mailed, 0)).toLocaleString("en-US") },
      { key: "Sum of Opp Count", label: "Sum of Opp Count", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.oppCount, 0)).toLocaleString("en-US") },
      { key: "Sum of In Force", label: "Sum of In Force", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.inForce, 0)).toLocaleString("en-US") },
      { key: "Sum of Sold", label: "Sum of Sold", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.sold, 0)).toLocaleString("en-US") },
      { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.totalMonthlyPremium, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
      { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.inForceMonthlyPremium, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
      { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.totalConvertedMonthlyPremiums, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    ],
    convertedPremiumRowCount,
    convertedCountTotal,
  };
}

function summarizeAnalysisExportRows(rows = [], columns = []) {
  const normalizedRows = Array.isArray(rows)
    ? rows.map((row) => applyAnalysisMetricAliases({ ...(row || {}) }))
    : [];

  if (!normalizedRows.length) {
    return {
      columns: Array.isArray(columns) ? columns : [],
      rows: [],
      summaryValues: [],
    };
  }

  if (hasAnalysisDetailExportRows(normalizedRows)) {
    return buildFlatRowsFromDetailExport(normalizedRows);
  }

  const normalizedSummaryRows = normalizedRows.map((row) => fillAnalysisRateFallbacks({ ...(row || {}) }));

  return {
    columns: Array.isArray(columns) ? columns : [],
    rows: normalizedSummaryRows,
    summaryValues: buildAnalysisSummaryValuesFromRows(normalizedSummaryRows),
  };
}

function getAnalysisSummaryRowKey(row = {}) {
  const scf = normalizeScf(
    row["SCF Grouping"] ??
    row["scf grouping"] ??
    row["SCF"] ??
    row.scf ??
    ""
  );
  const keyCode = String(
    row["Key"] ??
    row.key ??
    row["Report Key"] ??
    row["report key"] ??
    ""
  ).trim().toUpperCase();
  return `${scf}::${keyCode}`;
}

function getAnalysisCurrencyMetricNumber(row = {}, labels = []) {
  return parseNumber(getAnalysisMetricValue(row, labels) ?? getLikelyColumnValue(row, labels) ?? 0);
}

function setAnalysisCurrencyMetric(row = {}, canonicalLabel, normalizedLabel, numericValue) {
  const displayValue = Number(numericValue || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
  row[canonicalLabel] = displayValue;
  row[normalizedLabel] = displayValue;
}

function mergeAnalysisPremiumMetrics(baseRow = null, candidateRow = null) {
  if (!baseRow && !candidateRow) {
    return null;
  }

  // Detail-derived summary rows are the better source for analysis counts and
  // rates. Grouped report rows are still useful as a fallback for missing
  // values, especially premium fields that detail rows may omit.
  const mergedRow = { ...(candidateRow || {}), ...(baseRow || {}) };
  applyAnalysisMetricAliases(mergedRow);
  const detailMetricFields = [
    ["Opp Count", "Sum of Opp Count", "Applications Received", "Application Count"],
    ["In Force", "Sum of In Force"],
    ["Converted", "Sum of Converted"],
    ["Sold", "Sum of Sold"],
    ["Sold Rate"],
    ["In Force Rate"],
    ["Converted Rate"],
  ];
  const premiumFields = [
    {
      labels: ["Total Monthly Premium", "Sum of Total Monthly Premium"],
      canonical: "Sum of Total Monthly Premium",
      normalized: "sum of total monthly premium",
      kind: "currency",
    },
    {
      labels: ["In Force Monthly Premium", "Sum of In Force Monthly Premium"],
      canonical: "Sum of In Force Monthly Premium",
      normalized: "sum of in force monthly premium",
      kind: "currency",
    },
    {
      labels: ["Total Converted Monthly Premiums", "Sum of Total Converted Monthly Premiums"],
      canonical: "Sum of Total Converted Monthly Premiums",
      normalized: "sum of total converted monthly premiums",
      kind: "currency",
    },
  ];

  detailMetricFields.forEach((labels) => {
    if (hasAnalysisMetricValue(candidateRow || {}, labels)) {
      const candidateValue = getAnalysisMetricValue(candidateRow || {}, labels);
      setAnalysisMetricAliases(mergedRow, labels, candidateValue);
      return;
    }

    if (hasAnalysisMetricValue(baseRow || {}, labels)) {
      const baseValue = getAnalysisMetricValue(baseRow || {}, labels);
      setAnalysisMetricAliases(mergedRow, labels, baseValue);
    }
  });

  premiumFields.forEach((field) => {
    const baseValue = field.kind === "currency"
      ? getAnalysisCurrencyMetricNumber(baseRow || {}, field.labels)
      : parseNumber(getAnalysisMetricValue(baseRow || {}, field.labels) ?? 0);
    const candidateValue = field.kind === "currency"
      ? getAnalysisCurrencyMetricNumber(candidateRow || {}, field.labels)
      : parseNumber(getAnalysisMetricValue(candidateRow || {}, field.labels) ?? 0);
    const mergedValue = candidateValue > 0 ? candidateValue : baseValue;
    if (field.kind === "currency") {
      setAnalysisCurrencyMetric(mergedRow, field.canonical, field.normalized, mergedValue);
      return;
    }
    const displayValue = Math.round(mergedValue).toLocaleString("en-US");
    setAnalysisMetricAliases(mergedRow, field.labels, displayValue);
  });

  mergedRow.averageMonthlyPremium = Number(candidateRow?.averageMonthlyPremium) > 0
    ? Number(candidateRow.averageMonthlyPremium)
    : Number(baseRow?.averageMonthlyPremium) > 0
      ? Number(baseRow.averageMonthlyPremium)
      : 0;
  mergedRow.highPremium = Number(candidateRow?.highPremium) > 0
    ? Number(candidateRow.highPremium)
    : Number(baseRow?.highPremium) > 0
      ? Number(baseRow.highPremium)
      : null;
  mergedRow.lowPremium = Number(candidateRow?.lowPremium) > 0
    ? Number(candidateRow.lowPremium)
    : Number(baseRow?.lowPremium) > 0
      ? Number(baseRow.lowPremium)
      : null;

  fillAnalysisRateFallbacks(mergedRow);
  return mergedRow;
}

function restorePremiumsFromGroupedRows(summaryRows = [], groupedRows = []) {
  const toArray = (value) => Array.isArray(value) ? value : [];
  const groupedMap = new Map(
    toArray(groupedRows).map((row) => [getAnalysisSummaryRowKey(row), row])
  );

  return toArray(summaryRows).map((row) => {
    const groupedRow = groupedMap.get(getAnalysisSummaryRowKey(row));
    if (!groupedRow) {
      return row;
    }
    return mergeAnalysisPremiumMetrics(row, groupedRow);
  });
}

function mergeAnalysisSummaryDatasets(baseDataset = null, ...candidateDatasets) {
  const datasetList = [baseDataset, ...candidateDatasets].filter(
    (dataset) => dataset && (Array.isArray(dataset.rows) || Array.isArray(dataset.columns))
  );
  if (!datasetList.length) {
    return { columns: [], rows: [], summaryValues: [] };
  }

  const base = datasetList[0];
  const rowMap = new Map();

  (Array.isArray(base?.rows) ? base.rows : []).forEach((row) => {
    rowMap.set(getAnalysisSummaryRowKey(row), { ...row });
  });

  datasetList.slice(1).forEach((dataset) => {
    (Array.isArray(dataset?.rows) ? dataset.rows : []).forEach((row) => {
      const key = getAnalysisSummaryRowKey(row);
      const current = rowMap.get(key) || null;
      rowMap.set(key, mergeAnalysisPremiumMetrics(current, row));
    });
  });

  const mergedRows = Array.from(rowMap.values());
  return {
    columns: Array.isArray(base?.columns) ? base.columns : [],
    rows: mergedRows,
    summaryValues: buildAnalysisSummaryValuesFromRows(mergedRows),
  };
}

function backfillMissingAnalysisMetrics(primaryRows = [], ...candidateRowsCollections) {
  const primaryList = Array.isArray(primaryRows) ? primaryRows.map((row) => ({ ...row })) : [];
  if (!primaryList.length) {
    return primaryList;
  }

  const candidateMaps = candidateRowsCollections
    .filter((rows) => Array.isArray(rows) && rows.length > 0)
    .map((rows) => new Map(rows.map((row) => [getAnalysisSummaryRowKey(row), row])));

  const fieldGroups = [
    ANALYSIS_METRIC_LABELS.mailed,
    ANALYSIS_METRIC_LABELS.oppCount,
    ANALYSIS_METRIC_LABELS.inForce,
    ANALYSIS_METRIC_LABELS.convertedCount,
    ANALYSIS_METRIC_LABELS.sold,
    ANALYSIS_METRIC_LABELS.totalMonthlyPremium,
    ANALYSIS_METRIC_LABELS.inForceMonthlyPremium,
    ANALYSIS_METRIC_LABELS.totalConvertedMonthlyPremiums,
    ["Sold Rate"],
    ["In Force Rate"],
    ["Converted Rate"],
  ];

  return primaryList.map((row) => {
    const merged = applyAnalysisMetricAliases({ ...row });
    const rowKey = getAnalysisSummaryRowKey(merged);

    fieldGroups.forEach((labels) => {
      const currentValue = getAnalysisMetricValue(merged, labels);

      for (const candidateMap of candidateMaps) {
        const candidateRow = candidateMap.get(rowKey);
        if (!candidateRow || !hasAnalysisMetricValue(candidateRow, labels)) {
          continue;
        }

        const candidateValue = getAnalysisMetricValue(candidateRow, labels);
        if (!shouldPreferCandidateAnalysisMetric(currentValue, candidateValue)) {
          continue;
        }
        setAnalysisMetricAliases(merged, labels, candidateValue);
        break;
      }
    });

    fillAnalysisRateFallbacks(merged);
    return merged;
  });
}

function extractAnalysisSummaryMetricValue(summaryValues = [], key) {
  const entry = (Array.isArray(summaryValues) ? summaryValues : []).find((item) => String(item?.key || "").trim() === key);
  return parseNumber(entry?.value ?? 0);
}

function buildAnalysisDollarDiagnostics(reportId, filters, datasets = {}) {
  const merged = datasets.mergedFlattened || { rows: [], summaryValues: [] };
  const grouped = datasets.flattened || { columns: [], rows: [] };
  const fullDetailExport = datasets.fullDetailExport || { columns: [], rows: [] };
  const payloadDetailExport = datasets.reportPayloadDetailExport || { columns: [], rows: [] };
  const preferredExportSummary = datasets.preferredExportSummary || { columns: [], rows: [] };
  const normalizedDetailSummary = datasets.normalizedDetailSummary || { columns: [], rows: [] };

  const availableFieldNames = Array.from(new Set([
    ...(Array.isArray(fullDetailExport.columns) ? fullDetailExport.columns.map((column) => column.label || column.key || "") : []),
    ...(Array.isArray(payloadDetailExport.columns) ? payloadDetailExport.columns.map((column) => column.label || column.key || "") : []),
    ...(Array.isArray(grouped.columns) ? grouped.columns.map((column) => column.label || column.key || "") : []),
  ].filter(Boolean)));

  const expectedAmountFields = [
    "Total Monthly Premium",
    "In Force Monthly Premium",
    "Total Converted Monthly Premiums",
  ];
  const missingExpectedAmountFields = expectedAmountFields.filter((label) =>
    !availableFieldNames.some((fieldName) => normalizeLabel(fieldName).includes(normalizeLabel(label)))
  );

  const sampleSourceRows = [
    ...(Array.isArray(fullDetailExport.rows) ? fullDetailExport.rows.slice(0, 3) : []),
    ...(Array.isArray(payloadDetailExport.rows) ? payloadDetailExport.rows.slice(0, 3) : []),
  ].slice(0, 3);
  const samplePremiumValues = sampleSourceRows.map((row) => ({
    scf: row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row.scf ?? "",
    key: row["Key"] ?? row.key ?? "",
    totalMonthlyPremium: getLikelyColumnValue(row, ["Total Monthly Premium", "Sum of Total Monthly Premium", "Monthly Premium", "Sold Premium"]),
    inForceMonthlyPremium: getLikelyColumnValue(row, ["In Force Monthly Premium", "Sum of In Force Monthly Premium"]),
    totalConvertedMonthlyPremiums: getLikelyColumnValue(row, ["Total Converted Monthly Premiums", "Sum of Total Converted Monthly Premiums", "Converted Monthly Premium"]),
  }));

  const summaryValues = Array.isArray(merged.summaryValues) ? merged.summaryValues : [];
  const soldCount =
    extractAnalysisSummaryMetricValue(summaryValues, "Sum of Sold")
    || extractAnalysisSummaryMetricValue(summaryValues, "Sum of Opp Count");
  const convertedCount =
    extractAnalysisSummaryMetricValue(summaryValues, "Sum of Converted")
    || extractAnalysisSummaryMetricValue(summaryValues, "Sum of Sold");
  const inForceCount = extractAnalysisSummaryMetricValue(summaryValues, "Sum of In Force");
  const totalMonthlyPremium = extractAnalysisSummaryMetricValue(summaryValues, "Sum of Total Monthly Premium");
  const inForceMonthlyPremium = extractAnalysisSummaryMetricValue(summaryValues, "Sum of In Force Monthly Premium");
  const totalConvertedMonthlyPremiums = extractAnalysisSummaryMetricValue(summaryValues, "Sum of Total Converted Monthly Premiums");
  const rowCount = Array.isArray(merged.rows) ? merged.rows.length : 0;

  const suspicious =
    rowCount > 0 &&
    (soldCount > 0 || convertedCount > 0 || inForceCount > 0) &&
    totalMonthlyPremium === 0 &&
    inForceMonthlyPremium === 0 &&
    totalConvertedMonthlyPremiums === 0;

  const warningMessage = suspicious
    ? `Report ${reportId} has ${rowCount} rows and nonzero counts (sold=${soldCount}, converted=${convertedCount}, inForce=${inForceCount}) but all dollar fields aggregated to 0. Missing expected amount fields: ${missingExpectedAmountFields.length ? missingExpectedAmountFields.join(", ") : "none"}.`
    : "";
  const keyDistribution = (Array.isArray(merged.rows) ? merged.rows : []).reduce((acc, row) => {
    const key = String(row["Key"] ?? row.key ?? "").trim() || "(blank)";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    reportId,
    filters,
    rowCount,
    sourceRowCounts: {
      groupedRows: Array.isArray(grouped.rows) ? grouped.rows.length : 0,
      fullDetailRows: Array.isArray(fullDetailExport.rows) ? fullDetailExport.rows.length : 0,
      payloadDetailRows: Array.isArray(payloadDetailExport.rows) ? payloadDetailExport.rows.length : 0,
      normalizedDetailSummaryRows: Array.isArray(normalizedDetailSummary.rows) ? normalizedDetailSummary.rows.length : 0,
      preferredExportSummaryRows: Array.isArray(preferredExportSummary.rows) ? preferredExportSummary.rows.length : 0,
    },
    availableFieldNames,
    expectedAmountFields,
    missingExpectedAmountFields,
    samplePremiumValues,
    keyDistribution,
    summary: {
      soldCount,
      convertedCount,
      inForceCount,
      totalMonthlyPremium,
      inForceMonthlyPremium,
      totalConvertedMonthlyPremiums,
    },
    suspicious,
    warningMessage,
  };
}

function normalizeAnalysisKeyCodeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "nhcl" || normalized === "n") {
    return "N";
  }
  if (normalized === "rfc") {
    return "RFC";
  }
  return String(value || "").trim();
}

function buildAnalysisMetricReportMetadata(describePayload, filters = {}) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getGroupingColumns({ reportExtendedMetadata: describePayload.reportExtendedMetadata }).map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType || "string",
      fullyQualifiedName: column.key,
      rootObject: getRootObjectName(column.key),
      soqlField: translateReportFieldToSoql(column.key, getRootObjectName(column.key)),
    })),
  ];
  const scfField = findFieldByLikelyLabels(fields, ["SCF Grouping", "SCF"]);
  const keyField = findFieldByLikelyLabels(fields, ["Key", "Key Code", "Report Key"]);
  const nextReportFilters = Array.isArray(reportMetadata.reportFilters)
    ? [...reportMetadata.reportFilters]
    : [];
  const startDate = normalizeAnalysisDateValue(filters.dateRange?.startDate || "");
  const endDate = normalizeAnalysisDateValue(filters.dateRange?.endDate || "");
  const normalizedScf = normalizeScf(filters.scf);
  if (scfField?.key && normalizedScf) {
    nextReportFilters.push({
      column: scfField.key,
      operator: "equals",
      value: normalizedScf,
    });
  }
  const keyCodes = Array.isArray(filters.keyCodes)
    ? filters.keyCodes
        .map((value) => normalizeAnalysisKeyCodeValue(value))
        .filter(Boolean)
    : [];
  if (keyField?.key && keyCodes.length > 0) {
    nextReportFilters.push({
      column: keyField.key,
      operator: "equals",
      value: keyCodes.join(","),
    });
  }

  const nextMetadata = {
    ...reportMetadata,
    reportFilters: nextReportFilters,
  };
  if (startDate && endDate && reportMetadata.standardDateFilter?.column) {
    nextMetadata.standardDateFilter = {
      ...(reportMetadata.standardDateFilter || {}),
      durationValue: "CUSTOM",
      startDate,
      endDate,
    };
  }

  return nextMetadata;
}

async function fetchAnalysisReportScfMetrics(reportId, filters = {}) {
  const normalizedReportId = String(reportId || "").trim();
  if (!normalizedReportId) {
    throw new Error("Report ID is required.");
  }

  const normalizedScf = normalizeScf(filters.scf);
  if (!normalizedScf) {
    throw new Error("SCF is required.");
  }

  const exactDataset = await fetchFlexibleSalesforceReportData(normalizedReportId, {
    scf: normalizedScf,
    keyCodes: filters.keyCodes,
    dateRange: filters.dateRange,
    years: filters.years,
  });
  const normalizedKeys = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => normalizeAnalysisKeyCodeValue(value).toUpperCase()).filter(Boolean)
    : [];
  const candidateRows = [
    ...(Array.isArray(exactDataset?.rows) ? exactDataset.rows : []),
    ...(Array.isArray(exactDataset?.exportRows) ? exactDataset.exportRows : []),
  ];
  const rowMap = new Map();
  candidateRows.forEach((row) => {
    const cacheKey = getAnalysisSummaryRowKey(row);
    if (!cacheKey || rowMap.has(cacheKey)) {
      return;
    }
    rowMap.set(cacheKey, row);
  });
  const matchingDetailRows = Array.from(rowMap.values()).filter((row) => {
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
  return {
    reportId: normalizedReportId,
    scf: normalizedScf,
    row: matchingDetailRows.find((row) => !shouldRepairAnalysisRowWithScopedRefetch(row)) || matchingDetailRows[0] || null,
    rows: matchingDetailRows,
  };
}

async function fetchMergedAnalysisRowsForScopedFilters(tokenRecord, reportId, describePayload, filters = {}) {
  const reportMetadata = buildAnalysisMetricReportMetadata(describePayload, {
    scf: filters.scf,
    keyCodes: filters.keyCodes,
    dateRange: filters.dateRange,
  });
  const executed = await executeReportWithDescribeMetadata(
    tokenRecord,
    reportId,
    reportMetadata,
    describePayload
  );
  const groupedDataset = buildGroupedReportRows(executed.reportPayload) || { columns: [], rows: [], summaryValues: [] };
  const detailDataset = buildDetailExportRows(executed.reportPayload);
  const detailSummary = Array.isArray(detailDataset?.rows) && detailDataset.rows.length
    ? summarizeAnalysisExportRows(detailDataset.rows, detailDataset.columns)
    : { columns: [], rows: [], summaryValues: [] };
  const mergedDataset = mergeAnalysisSummaryDatasets(
    groupedDataset.rows.length || groupedDataset.columns.length ? groupedDataset : detailSummary,
    detailSummary
  );
  const mergedRows = backfillMissingAnalysisMetrics(
    groupedDataset.rows.length
      ? restorePremiumsFromGroupedRows(mergedDataset.rows, groupedDataset.rows)
      : mergedDataset.rows,
    groupedDataset.rows,
    detailSummary.rows
  );
  return Array.isArray(mergedRows) ? mergedRows : [];
}

function shouldRepairAnalysisRowWithScopedRefetch(row = {}) {
  const oppCount = parseNumber(row["Sum of Opp Count"] ?? row["sum of opp count"] ?? 0);
  const totalMonthlyPremium = parseNumber(row["Sum of Total Monthly Premium"] ?? row["sum of total monthly premium"] ?? 0);
  const inForceMonthlyPremium = parseNumber(row["Sum of In Force Monthly Premium"] ?? row["sum of in force monthly premium"] ?? 0);
  const convertedPremium = parseNumber(
    row["Sum of Total Converted Monthly Premiums"] ?? row["sum of total converted monthly premiums"] ?? 0
  );
  return oppCount > 0 && totalMonthlyPremium === 0 && inForceMonthlyPremium === 0 && convertedPremium === 0;
}

async function repairSparseAnalysisRowsWithScopedRefetch(
  tokenRecord,
  reportId,
  describePayload,
  rows = [],
  filters = {}
) {
  const repairedRows = [];
  const cachedRows = new Map();

  for (const row of rows) {
    if (!shouldRepairAnalysisRowWithScopedRefetch(row)) {
      repairedRows.push(row);
      continue;
    }

    const scf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row.scf ?? "");
    const keyCode = String(row["Key"] ?? row.key ?? "").trim();
    if (!scf) {
      repairedRows.push(row);
      continue;
    }

    const cacheKey = `${scf}::${keyCode.toUpperCase()}`;
    let repairedRow = cachedRows.get(cacheKey) || null;
    if (!repairedRow) {
      const scopedRows = await fetchMergedAnalysisRowsForScopedFilters(
        tokenRecord,
        reportId,
        describePayload,
        {
          scf,
          keyCodes: keyCode ? [keyCode] : filters.keyCodes,
          dateRange: filters.dateRange,
        }
      );
      repairedRow =
        scopedRows.find((entry) => getAnalysisSummaryRowKey(entry) === cacheKey) ||
        scopedRows[0] ||
        null;
      cachedRows.set(cacheKey, repairedRow);
    }

    repairedRows.push(repairedRow || row);
  }

  return repairedRows;
}

function resolveAnalysisDateRange(filters = {}) {
  const dateRange = filters.dateRange || {};
  const startDate = normalizeAnalysisDateValue(dateRange.startDate);
  const endDate = normalizeAnalysisDateValue(dateRange.endDate);

  if (startDate && endDate) {
    return {
      startDate,
      endDate,
    };
  }

  const years = Array.isArray(filters.years)
    ? filters.years
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value))
    : [];

  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    return {
      startDate: `${minYear}-01-01`,
      endDate: `${maxYear}-12-31`,
    };
  }

  return null;
}

function getLikelyColumnValue(row, candidates) {
  const candidateList = Array.isArray(candidates)
    ? candidates
        .map((entry) => normalizeLabel(String(entry || "").trim()))
        .filter(Boolean)
    : [];

  const entries = Object.entries(row).filter(
    ([key]) => !key.endsWith("__label") && !key.endsWith(" label")
  );

  for (const candidate of candidateList) {
    const exactMatch = entries.find(([key, value]) => {
      const normalizedKey = normalizeLabel(key);
      if (!normalizedKey || normalizedKey === "") {
        return false;
      }

      if (normalizedKey === candidate) {
        return value !== undefined && value !== null && String(value).trim() !== "";
      }

      return false;
    });

    if (exactMatch) {
      return exactMatch[1];
    }
  }

  for (const candidate of candidateList) {
    const fuzzyMatch = entries.find(([key, value]) => {
      const normalizedKey = normalizeLabel(key);
      if (!normalizedKey || normalizedKey === "") {
        return false;
      }

      if (
        normalizedKey.includes(candidate) &&
        normalizedKey !== "code" &&
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
      ) {
        return true;
      }

      return false;
    });

    if (fuzzyMatch) {
      return fuzzyMatch[1];
    }
  }

  return null;
}

function matchesAnyToken(value, tokens) {
  const haystack = normalizeLabel(value);
  return tokens.some((token) => haystack === normalizeLabel(token) || haystack.includes(normalizeLabel(token)));
}

function filterAnalysisRows(rows, filters = {}) {
  const keyCodes = Array.isArray(filters.keyCodes)
    ? filters.keyCodes
        .map((value) => normalizeAnalysisKeyCodeValue(value).toUpperCase())
        .filter(Boolean)
    : [];
  const keyFilters = Array.isArray(filters.keyFilters)
    ? filters.keyFilters
        .map((value) => normalizeAnalysisKeyCodeValue(value).toUpperCase())
        .filter(Boolean)
    : [];
  const scfFilter = String(filters.scf || "").trim();
  const clientType = String(filters.clientType || "").trim();
  const years = Array.isArray(filters.years)
    ? filters.years.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value))
    : [];
  const dateRange = filters.dateRange || {};

  const keyMatchTokens = keyCodes.length > 0 ? keyCodes : [];
  const explicitKeyTokens = keyFilters.length > 0 ? keyFilters : [];
  const combinedKeyFilters = Array.from(new Set([...keyMatchTokens, ...explicitKeyTokens]));

  return rows.filter((row) => {
    if (combinedKeyFilters.length > 0) {
      const keyValue = getLikelyColumnValue(row, [
        "key",
        "key field",
        "key code",
        "keycode",
        "authorization code",
        "auth code",
      ]);

      if (keyValue === null) {
        return false;
      }

      const normalizedRowKey = normalizeAnalysisKeyCodeValue(keyValue).toUpperCase();
      if (!normalizedRowKey || !combinedKeyFilters.includes(normalizedRowKey)) {
        return false;
      }
    }

    if (scfFilter) {
      const scfValue = getLikelyColumnValue(row, ["scf", "sectional center facility"]);
      if (scfValue !== null) {
        const normalizedScfValue = normalizeScf(scfValue);
        if (normalizedScfValue !== normalizeScf(scfFilter)) {
          return false;
        }
      }
    }

    if (clientType) {
      const clientValue = getLikelyColumnValue(row, ["client", "list type", "mailing list"]);
      if (clientValue !== null && !matchesAnyToken(String(clientValue), [clientType])) {
        return false;
      }
    }

    if (years.length > 0 || (dateRange.startDate && dateRange.endDate)) {
      const dateValue = getLikelyColumnValue(row, ["date", "created date", "close date"]);
      if (dateValue === null) {
        return true;
      }

      let parsedDate = null;
      try {
        parsedDate = parseDateValue(dateValue, String(dateValue));
      } catch (error) {
        return false;
      }

      const rowYear = Number(parsedDate.slice(0, 4));
      if (years.length > 0 && !years.includes(rowYear)) {
        return false;
      }

      if (dateRange.startDate && parsedDate < dateRange.startDate) {
        return false;
      }

      if (dateRange.endDate && parsedDate > dateRange.endDate) {
        return false;
      }
    }

    return true;
  });
}

async function getConnectedSalesforceToken() {
  const authStatus = getAuthStatus();

  if (!authStatus.isConfigured) {
    throw new Error("Salesforce OAuth is not configured. Add the Connected App values to .env.");
  }

  let tokenRecord = getStoredToken();
  tokenRecord = await refreshAccessTokenIfNeeded(tokenRecord);
  return tokenRecord;
}

async function fetchFlexibleSalesforceReportData(reportId, filters = {}) {
  const tokenRecord = await getConnectedSalesforceToken();
  const effectiveDateRange = resolveAnalysisDateRange(filters);
  const normalizedFilters = {
    ...filters,
    dateRange: effectiveDateRange || filters.dateRange || null,
  };

  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  let reportPayload = null;
  let groupedReportUnavailableReason = "";
  let flattened = { columns: [], rows: [], summaryValues: [] };
  let fullDetailExport = { columns: [], rows: [] };
  let reportPayloadDetailExport = { columns: [], rows: [] };
  let preferredExport = { columns: [], rows: [] };
  let normalizedDetailSummary = { columns: [], rows: [], summaryValues: [] };
  let preferredExportSummary = { columns: [], rows: [], summaryValues: [] };
  let payloadDetailSummary = { columns: [], rows: [], summaryValues: [] };
  let opportunityAggregateSummary = { columns: [], rows: [], summaryValues: [] };
  let convertedDiagnostics = null;

  try {
    const reportMetadata = buildAnalysisMetricReportMetadata(describePayload, {
      scf: filters.scf,
      keyCodes: filters.keyCodes,
      dateRange: effectiveDateRange,
    });
    const executed = await executeAsyncReportWithDescribeMetadata(
      tokenRecord,
      reportId,
      reportMetadata,
      describePayload
    );
    reportPayload = executed.reportPayload;
    flattened = buildGroupedReportRows(reportPayload) || { columns: [], rows: [], summaryValues: [] };
    const debugLabel = getAnalysisDebugLabel(filters);
    const debugPayloadPath = writeAnalysisDebugJson(
      buildAnalysisDebugFilePath(debugLabel),
      buildAnalysisReportPayloadDebugSnapshot(reportId, normalizedFilters, describePayload, reportPayload)
    );
    fullDetailExport = await buildFullDetailExportRows(tokenRecord, describePayload, {
      scf: filters.scf,
      keyCodes: filters.keyCodes,
      dateRange: effectiveDateRange,
    });
    reportPayloadDetailExport =
      reportPayload && !shouldFallbackToSoqlForReportPayload(reportPayload)
        ? buildDetailExportRows(reportPayload)
        : { columns: [], rows: [] };
    if (Array.isArray(reportPayloadDetailExport.rows) && reportPayloadDetailExport.rows.length) {
      reportPayloadDetailExport = {
        ...reportPayloadDetailExport,
        rows: await enrichAnalysisDetailRowsWithMailerGrouping(tokenRecord, reportPayloadDetailExport.rows),
      };
    }
    convertedDiagnostics = buildConvertedDiagnosticsPayload({
      reportId,
      reportName: describePayload?.reportMetadata?.name || reportId,
      describePayload,
      reportPayload,
      rawDetailRows: getDetailRows(reportPayload),
      normalizedRows: reportPayloadDetailExport.rows,
    });
    payloadDetailSummary = reportPayloadDetailExport.rows.length
      ? summarizeAnalysisExportRows(reportPayloadDetailExport.rows, reportPayloadDetailExport.columns)
      : { columns: [], rows: [], summaryValues: [] };
    preferredExport = choosePreferredAnalysisExportRows(
      fullDetailExport,
      reportPayloadDetailExport
    );
    preferredExportSummary = preferredExport.rows.length
      ? summarizeAnalysisExportRows(preferredExport.rows, preferredExport.columns)
      : { columns: [], rows: [], summaryValues: [] };
    opportunityAggregateSummary = await fetchAnalysisOpportunityAggregateRows(tokenRecord, normalizedFilters);
    normalizedDetailSummary = mergeAnalysisSummaryDatasets(
      preferredExportSummary,
      opportunityAggregateSummary
    );
    preferredExportSummary = normalizedDetailSummary;
    flattened.debugPayloadPath = debugPayloadPath;
  } catch (error) {
    groupedReportUnavailableReason = `Analysis fell back to the Salesforce query path because synchronous report execution was unavailable: ${error instanceof Error ? error.message : String(error || "")}`.trim();
    const aggregateDataset = await fetchAnalysisAggregateRows(tokenRecord, describePayload, filters);
    normalizedDetailSummary = aggregateDataset.rows.length
      ? {
          columns: aggregateDataset.columns,
          rows: aggregateDataset.rows,
          summaryValues: aggregateDataset.summaryValues,
        }
      : { columns: [], rows: [], summaryValues: [] };
    preferredExport = { columns: [], rows: [] };
    preferredExportSummary = normalizedDetailSummary;
    convertedDiagnostics = buildConvertedDiagnosticsPayload({
      reportId,
      reportName: describePayload?.reportMetadata?.name || reportId,
      describePayload,
      reportPayload: null,
      rawDetailRows: [],
      normalizedRows: normalizedDetailSummary.rows,
    });
  }

  const mergedFlattened = mergeAnalysisSummaryDatasets(
    flattened.rows.length || flattened.columns.length ? flattened : normalizedDetailSummary,
    normalizedDetailSummary,
    preferredExportSummary,
    payloadDetailSummary,
    opportunityAggregateSummary
  );
  const finalizedRows = backfillMissingAnalysisMetrics(
    flattened.rows.length
      ? restorePremiumsFromGroupedRows(
          mergedFlattened.rows,
          flattened.rows
        )
      : mergedFlattened.rows,
    flattened.rows,
    opportunityAggregateSummary.rows,
    preferredExportSummary.rows,
    payloadDetailSummary.rows,
    normalizedDetailSummary.rows
  );
  const preferredSummaryValues = buildAnalysisSummaryValuesFromRows(finalizedRows);
  const finalizedFlattened = {
    ...mergedFlattened,
    rows: finalizedRows,
    summaryValues: preferredSummaryValues,
  };
  const rowDebugTrace = buildAnalysisRowDebugTrace(flattened.rows, finalizedFlattened.rows, "047");
  const diagnostics = buildAnalysisDollarDiagnostics(reportId, filters, {
    flattened,
    fullDetailExport,
    reportPayloadDetailExport,
    normalizedDetailSummary,
    preferredExportSummary,
    opportunityAggregateSummary,
    mergedFlattened: finalizedFlattened,
  });
  diagnostics.sourcePath = reportPayload
    ? "salesforce-analytics-report-payload-primary"
    : "salesforce-soql-fallback";
  diagnostics.groupedReportUnavailableReason = groupedReportUnavailableReason;
  diagnostics.debugPayloadPath = flattened.debugPayloadPath || null;
  diagnostics.rowDebugTrace = rowDebugTrace;
  diagnostics.convertedDebug = {
    ...(convertedDiagnostics || buildConvertedDebugSummary([])),
    rowsWithPositiveConvertedPremium: flattened.convertedPremiumRowCount || 0,
    displayedConvertedCountTotal: flattened.convertedCountTotal || 0,
    finalizedSummaryRowsChecked: finalizedFlattened.rows.length,
    finalizedSummaryConvertedTotal: buildConvertedDebugSummary(finalizedFlattened.rows).convertedTotalFromSource,
    finalizedSummaryResolutionSamples: buildConvertedDebugSummary(finalizedFlattened.rows).convertedResolutionSamples,
  };
  if (reportPayload) {
    console.log("Analysis row debug:", JSON.stringify(rowDebugTrace, null, 2));
  }
  if (diagnostics.convertedDebug) {
    console.log("[Converted Debug] Analysis report pull", JSON.stringify({
      reportId,
      reportName: diagnostics.convertedDebug.reportName || describePayload?.reportMetadata?.name || reportId,
      allColumnApiNames: diagnostics.convertedDebug.allColumnApiNames || [],
      allColumnLabels: diagnostics.convertedDebug.allColumnLabels || [],
      convertedCandidateColumns: diagnostics.convertedDebug.convertedCandidateColumns || [],
      sampleNormalizedRows: diagnostics.convertedDebug.sampleNormalizedRows || [],
      convertedResolutionSamples: diagnostics.convertedDebug.convertedResolutionSamples || [],
      totalRowsChecked: diagnostics.convertedDebug.totalRowsChecked || 0,
      rowsWithConvertedSource: diagnostics.convertedDebug.rowsWithConvertedSource || 0,
      rowsWithConvertedNumericValue: diagnostics.convertedDebug.rowsWithConvertedNumericValue || 0,
      rowsWithPositiveConvertedPremium: diagnostics.convertedDebug.rowsWithPositiveConvertedPremium || 0,
      displayedConvertedCountTotal: diagnostics.convertedDebug.displayedConvertedCountTotal || 0,
      convertedTotalFromSource: diagnostics.convertedDebug.convertedTotalFromSource || 0,
      warnings: diagnostics.convertedDebug.warnings || [],
    }, null, 2));
  }
  const availableKeyValues = Array.from(
    new Set(
      finalizedFlattened.rows
        .map((row) => String(row["Key"] || row.key || "").trim())
        .filter(Boolean)
    )
  ).sort();
  const filteredSummaryRows = filterAnalysisRows(finalizedFlattened.rows, filters);
  const filteredExportRows = hasAnalysisDetailExportRows(preferredExport.rows)
    ? filterAnalysisRows(preferredExport.rows, filters)
    : [];

  return {
    reportId,
    filters: normalizedFilters,
    describePayload,
    rawReportPayload: reportPayload,
    groupedReportUnavailableReason,
    columns: finalizedFlattened.columns,
    summaryValues: finalizedFlattened.summaryValues || [],
    rows: filteredSummaryRows,
    exportColumns: filteredExportRows.length ? preferredExport.columns : [],
    exportRows: filteredExportRows,
    unfilteredRowCount: finalizedFlattened.rows.length,
    exportRowCount: filteredExportRows.length,
    availableKeyValues,
    diagnostics,
  };
}

async function fetchRawSalesforceReportRows(reportId) {
  const normalizedReportId = String(reportId || "").trim();
  if (!normalizedReportId) {
    throw new Error("Report ID is required.");
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const { describePayload, reportPayload } = await executeReportWithoutDateOverride(
    tokenRecord,
    normalizedReportId
  );
  const reportName = describePayload?.reportMetadata?.name || normalizedReportId;
  const shouldFallbackToSoql = shouldFallbackToSoqlForReportPayload(reportPayload);

  if (shouldFallbackToSoql) {
    const plan = buildRawDetailSoqlPlan(describePayload);
    const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
    const rows = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

    return {
      reportId: normalizedReportId,
      reportName,
      columns: fields.map((field) => ({
        key: field.key,
        label: field.label,
        normalized: field.normalized,
        dataType: field.dataType,
      })),
      rows,
    };
  }

  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap));

  return {
    reportId: normalizedReportId,
    reportName,
    columns: columnMap.map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType,
    })),
    rows,
  };
}

function firstValue(rowObject, labels) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    const value = rowObject[normalized];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function firstDisplayValue(rowObject, labels) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    const displayValue =
      rowObject[`${normalized} label`] ?? rowObject[`${label}__label`];

    if (
      displayValue !== undefined &&
      displayValue !== null &&
      String(displayValue).trim() !== ""
    ) {
      return displayValue;
    }
  }

  return firstValue(rowObject, labels);
}

function derivePayTypeFromReceived(value) {
  const stringValue = String(value ?? "").trim().toUpperCase();

  if (stringValue === "2" || stringValue === "CC" || stringValue.includes("CREDIT CARD")) {
    return "CC";
  }

  if (
    stringValue === "3" ||
    stringValue === "BILL" ||
    stringValue.includes("BILL") ||
    stringValue.includes("CHECK")
  ) {
    return "BILL";
  }

  return "ACH";
}

function derivePayTypeFromCreditType(value) {
  const stringValue = normalizeLabel(value);

  if (stringValue.includes("credit card")) {
    return "CC";
  }

  if (stringValue.includes("check")) {
    return "BILL";
  }

  return "ACH";
}

function normalizePaymentSummaryPayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizePaymentSummaryRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizeCreditsSummaryPayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizeCreditsSummaryRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizePolicyTypePayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizePolicyTypeRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizeDetailPayload(reportConfig, reportPayload) {
  if (reportConfig.key === "paymentSummary") {
    return normalizePaymentSummaryPayload(reportConfig, reportPayload);
  }

  if (reportConfig.key === "creditsSummary") {
    return normalizeCreditsSummaryPayload(reportConfig, reportPayload);
  }

  if (reportConfig.key === "policyType") {
    return normalizePolicyTypePayload(reportConfig, reportPayload);
  }

  throw new Error(`Unsupported detail report mapping: ${reportConfig.key}`);
}

function normalizePaymentSummaryRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const typeReceived = firstValue(rowObject, ["Type Received"]);
    const gatewayResponseMessage =
      firstValue(rowObject, ["Gateway Response Message"]) ||
      firstValue(rowObject, ["Gateway Response Message2"]);
    const gatewayResponseMessage2 = String(
      firstDisplayValue(rowObject, ["Gateway Response Message2"]) ||
        firstValue(rowObject, ["Gateway Response Message2"])
    ).trim();

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, [
          "Policy: Certificate",
          "Policy: Certificate ID",
          "Policy: Certificate External ID",
          "Certificate",
        ])
      ).trim(),
      transactionDate: parseDateValue(
        firstValue(rowObject, ["Date Received"]),
        String(firstValue(rowObject, ["Date Received"]))
      ),
      typeReceived,
      payType: derivePayTypeFromReceived(typeReceived),
      amount: parseNumber(firstValue(rowObject, ["Amount Received"])),
      checkNumber: String(firstDisplayValue(rowObject, ["Check #"])).trim(),
      authCode: String(firstDisplayValue(rowObject, ["Auth Code"])).trim(),
      approval: String(firstDisplayValue(rowObject, ["Issuer Response Text"])).trim(),
      gatewayTxnId: String(firstDisplayValue(rowObject, ["Gateway Txn ID"])).trim(),
      gatewayResponseMessage: String(
        firstDisplayValue(rowObject, [
          "Gateway Response Message",
          "Gateway Response Message2",
        ]) || gatewayResponseMessage
      ).trim(),
      gatewayResponseMessage2,
      reasonForCredit: gatewayResponseMessage2,
      raw: rowObject,
    };
  });
}

function normalizeCreditsSummaryRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const type = firstValue(rowObject, ["Type"]);
    const amount = Math.abs(parseNumber(firstValue(rowObject, ["Amount"]))) * -1;

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, ["Certificate: Certificate Name", "Certificate"])
      ).trim(),
      transactionDate: parseDateValue(
        firstValue(rowObject, ["Date Refunded"]),
        String(firstValue(rowObject, ["Date Refunded"]))
      ),
      type: String(firstDisplayValue(rowObject, ["Type"]) || type).trim(),
      payType: derivePayTypeFromCreditType(type),
      amount,
      checkNumber: String(firstDisplayValue(rowObject, ["Check No", "Check #"])).trim(),
      approval: String(firstDisplayValue(rowObject, ["Credit Batch ID (Approval)"])).trim(),
      reasonForCredit: String(firstDisplayValue(rowObject, ["Credit Reason Code"])).trim(),
      raw: rowObject,
    };
  });
}

function normalizePolicyTypeRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const policyType = String(
      firstDisplayValue(rowObject, ["Policy Type"]) || firstValue(rowObject, ["Policy Type"])
    ).trim();

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, ["Certificate: Certificate Name", "Certificate"])
      ).trim(),
      policyType,
      members: policyType ? policyType.slice(0, 1) : "",
      raw: rowObject,
    };
  });
}

function getDetailSupplementalFields(reportConfig) {
  if (reportConfig.key === "certs") {
    return [
      {
        label: "Product",
        normalized: normalizeLabel("Product"),
        dataType: "picklist",
        soqlField: "Policy_Record_for_TPA__r.Product__c",
      },
      {
        label: "Policy Type",
        normalized: normalizeLabel("Policy Type"),
        dataType: "picklist",
        soqlField: "Policy_Record_for_TPA__r.Policy_Type__c",
      },
      {
        label: "Effective Date",
        normalized: normalizeLabel("Effective Date"),
        dataType: "date",
        soqlField: "Policy_Record_for_TPA__r.Effective_Date__c",
      },
      {
        label: "Pay To Date",
        normalized: normalizeLabel("Pay To Date"),
        dataType: "date",
        soqlField: "Policy_Record_for_TPA__r.Pay_To_Date__c",
      },
      {
        label: "Orig Rate (1 Person)",
        normalized: normalizeLabel("Orig Rate (1 Person)"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Rate_1__c",
      },
      {
        label: "Orig Rate (2 Person)",
        normalized: normalizeLabel("Orig Rate (2 Person)"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Rate_2__c",
      },
      {
        label: "Total AD&D Coverage",
        normalized: normalizeLabel("Total AD&D Coverage"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Total_AD_D_Coverage__c",
      },
      {
        label: "Free Term Life Coverage Amt",
        normalized: normalizeLabel("Free Term Life Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Free_Coverage__c",
      },
      {
        label: "Orig Contrib AD&D Coverage Amt",
        normalized: normalizeLabel("Orig Contrib AD&D Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Orig_Contrib_AD_D_Coverage_Amt__c",
      },
      {
        label: "Orig Non-Contrib AD&D Coverage Amt",
        normalized: normalizeLabel("Orig Non-Contrib AD&D Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Orig_Non_Contrib_AD_D_Coverage_Amt__c",
      },
    ];
  }

  if (reportConfig.key === "payments") {
    return [
      {
        label: "Certificate",
        normalized: normalizeLabel("Certificate"),
        dataType: "string",
        soqlField: "Certificate__r.Name",
      },
    ];
  }

  if (reportConfig.key !== "paymentSummary") {
    return [];
  }

  return [
    {
      label: "Check #",
      normalized: normalizeLabel("Check #"),
      dataType: "string",
      soqlField: "Check__c",
    },
    {
      label: "Auth Code",
      normalized: normalizeLabel("Auth Code"),
      dataType: "string",
      soqlField: "Auth_Code__c",
    },
    {
      label: "Issuer Response Text",
      normalized: normalizeLabel("Issuer Response Text"),
      dataType: "string",
      soqlField: "Issuer_Response_Text__c",
    },
    {
      label: "Gateway Txn ID",
      normalized: normalizeLabel("Gateway Txn ID"),
      dataType: "string",
      soqlField: "Gateway_Txn_ID__c",
    },
    {
      label: "Gateway Response Message",
      normalized: normalizeLabel("Gateway Response Message"),
      dataType: "string",
      soqlField: "Gateway_Response_Message__c",
    },
    {
      label: "Policy: Certificate ID",
      normalized: normalizeLabel("Policy: Certificate ID"),
      dataType: "string",
      soqlField: "Policy__r.Certificate_ID__c",
    },
    {
      label: "Policy: Certificate External ID",
      normalized: normalizeLabel("Policy: Certificate External ID"),
      dataType: "string",
      soqlField: "Policy__r.Certificate_External_ID__c",
    },
    {
      label: "Policy: Certificate",
      normalized: normalizeLabel("Policy: Certificate"),
      dataType: "string",
      soqlField: "Policy__r.Account__r.Name",
    },
  ];
}

function buildDetailSoql(describePayload, reportConfig, reportMonth) {
  const dateRange = getMonthDateRange(reportMonth);
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getDetailSupplementalFields(reportConfig),
  ];
  const reportMetadata = describePayload.reportMetadata || {};

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const hasExplicitStandardRange =
    reportMetadata.standardDateFilter?.startDate || reportMetadata.standardDateFilter?.endDate;
  const fallbackDateField = fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);
  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    fallbackDateField;
  const dateFieldInfo =
    fields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  if (!dateField && hasExplicitStandardRange) {
    throw new Error("Salesforce report is missing a standard date field.");
  }

  const selectFields = [...new Set(fields.map((field) => field.soqlField).filter(Boolean))];
  const whereClauses = [];

  if (dateField && (hasExplicitStandardRange || fallbackDateField)) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(
        dateRange.startDate,
        dateFieldInfo.dataType,
        "start"
      )}`
    );
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(
        dateRange.endDate,
        dateFieldInfo.dataType,
        "end"
      )}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  return {
    objectName,
    dateField,
    whereClauses,
    fields,
  };
}

function composeDetailSoql(plan, selectedFields) {
  const whereSection = plan.whereClauses.length
    ? `\nWHERE ${plan.whereClauses.join("\nAND ")}`
    : "";
  const orderBySection = plan.dateField ? `\nORDER BY ${plan.dateField}` : "";

  return `
SELECT ${selectedFields.join(", ")}
FROM ${plan.objectName}
${whereSection}
${orderBySection}
`.trim();
}

function extractInvalidSoqlField(error) {
  const message = String(error?.message || "");
  const columnMatch = message.match(/No such column '([^']+)'/);
  if (columnMatch) {
    return columnMatch[1];
  }

  const invalidFieldMatch = message.match(/Invalid field: '([^']+)'/);
  if (invalidFieldMatch) {
    return invalidFieldMatch[1];
  }

  const relationshipMatch = message.match(/Didn't understand relationship '([^']+)'/);
  if (relationshipMatch) {
    return relationshipMatch[1];
  }

  return null;
}

async function runDetailSoqlWithFallback(tokenRecord, plan) {
  let selectedFields = [...new Set(plan.fields.map((field) => field.soqlField).filter(Boolean))];
  let whereClauses = [...(plan.whereClauses || [])];
  let lastError = null;

  while (selectedFields.length > 0) {
    try {
      const records = await runSoqlQuery(
        tokenRecord,
        composeDetailSoql({ ...plan, whereClauses }, selectedFields)
      );
      const allowed = new Set(selectedFields);
      return {
        records,
        fields: plan.fields.filter((field) => allowed.has(field.soqlField)),
      };
      } catch (error) {
        lastError = error;
        const invalidField = extractInvalidSoqlField(error);
        if (!invalidField) {
          throw error;
        }

        const nextFields = selectedFields.filter(
          (fieldName) =>
            fieldName !== invalidField &&
            !String(fieldName).startsWith(`${invalidField}.`)
        );

        if (nextFields.length !== selectedFields.length) {
          selectedFields = nextFields;
          continue;
        }

        const nextWhereClauses = whereClauses.filter(
          (clause) =>
            !String(clause).includes(`${invalidField} `) &&
            !String(clause).includes(`${invalidField}.`) &&
            !String(clause).includes(`${invalidField}=`)
        );
        if (nextWhereClauses.length !== whereClauses.length) {
          whereClauses = nextWhereClauses;
          continue;
        }

        throw error;
      }
    }

  throw lastError || new Error("No queryable detail fields were available for the Salesforce report.");
}

async function fetchFullDetailRows(tokenRecord, reportConfig, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const plan = buildDetailSoql(describePayload, reportConfig, reportMonth);
  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  const rowObjects = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

  if (reportConfig.key === "paymentSummary") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizePaymentSummaryRowObjects(rowObjects),
    };
  }

  if (reportConfig.key === "creditsSummary") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizeCreditsSummaryRowObjects(rowObjects),
    };
  }

  if (reportConfig.key === "policyType") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizePolicyTypeRowObjects(rowObjects),
    };
  }

  throw new Error(`Unsupported detail report mapping: ${reportConfig.key}`);
}

async function fetchFullFlatReportRows(tokenRecord, reportConfig, reportMonth, options = {}) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const plan = buildDetailSoql(describePayload, reportConfig, reportMonth);

  if (options.applyDateFilter === false) {
    plan.whereClauses = (plan.whereClauses || []).filter(
      (clause) => !plan.dateField || !String(clause).includes(plan.dateField)
    );
    plan.dateField = null;
  }

  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  return records.map((record) => buildRowObjectFromSoqlRecord(record, fields));
}

async function fetchReportTypeData(tokenRecord, reportType, reportMonth) {
  const results = [];

  for (const reportConfig of reportType.salesforceReports) {
    try {
      if (reportType.id === "transaction-detail") {
        results.push(await fetchFullDetailRows(tokenRecord, reportConfig, reportMonth));
        continue;
      }

      if (reportType.id === "transaction-summary" && reportConfig.useAggregateQuery) {
        try {
          results.push(
            await fetchAggregateReportRows(tokenRecord, reportConfig, reportMonth)
          );
          continue;
        } catch (error) {
          // Fall through to the regular report API.
        }
      }

      const reportPayload = await executeReport(tokenRecord, reportConfig.reportId, reportMonth);

      if (reportType.id === "transaction-detail") {
        results.push(normalizeDetailPayload(reportConfig, reportPayload));
      } else {
        results.push(normalizeSummaryReportPayload(reportConfig, reportPayload));
      }
    } catch (error) {
      throw new Error(
        `Failed to pull ${reportConfig.transactionType} (${reportConfig.reportId}): ${error.message}`
      );
    }
  }

  return results;
}

async function fetchMonthlySalesforceReportData(
  reportTypeId = DEFAULT_MONTHLY_REPORT_TYPE,
  reportMonth
) {
  const authStatus = getAuthStatus();
  const reportType = getMonthlyReportType(reportTypeId);

  if (!reportType) {
    throw new Error(`Unknown monthly report type: ${reportTypeId}`);
  }

  if (!authStatus.isConfigured) {
    throw new Error("Salesforce OAuth is not configured. Add the Connected App values to .env.");
  }

  let tokenRecord = getStoredToken();
  tokenRecord = await refreshAccessTokenIfNeeded(tokenRecord);

  const rawTabs = await fetchReportTypeData(tokenRecord, reportType, reportMonth);

  return {
    reportType: reportType.id,
    reportName: reportType.name,
    source: "salesforce-live-reports",
    reportMonth,
    configuredReports: reportType.salesforceReports,
    rawTabs,
  };
}

module.exports = {
  backfillMissingAnalysisMetrics,
  buildConvertedDebugSummary,
  buildFlatRowsFromDetailExport,
  summarizeAnalysisExportRows,
  buildFlatReportRows,
  calculateAnalysisCountRates,
  calculateAnalysisConvertedRate,
  buildDetailSoql,
  executeReport,
  executeAsyncReportWithDescribeMetadata,
  executeReportForDateRange,
  executeReportWithDescribeMetadata,
  executeSavedReport,
  executeReportWithoutDateOverride,
  fetchDashboard,
  fetchDashboardResults,
  fetchAnalysisReportScfMetrics,
  fetchFlexibleSalesforceReportData,
  fetchFullFlatReportRows,
  fetchMonthlySalesforceReportData,
  fetchRawSalesforceReportRows,
  fetchReportDescribe,
  getAnalysisDebugFilePath,
  getConnectedSalesforceToken,
  getMonthDateRange,
  hasAnalysisDetailExportRows,
  isAnalysisDetailExportRow,
  mapColumnLabels,
  normalizeLabel,
  normalizeScf,
  parseConvertedNumber,
  parseDateValue,
  parseNumber,
  resolveConvertedValue,
  resolveAnalysisConvertedCount,
  resolveAnalysisDateRange,
  resolveAnalysisSoldOpportunityCount,
  mergeAnalysisSummaryDatasets,
  runSoqlQuery,
  salesforceRequest,
  shouldFallbackToSoqlForReportPayload,
};
