const fs = require("fs");
const path = require("path");
const {
  fetchRawSalesforceReportRows,
  getConnectedSalesforceToken,
  runSoqlQuery,
  salesforceRequest,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_PATH = path.join(DATA_DIR, "certificate-lookup-cache.json");
const CACHE_SUPABASE_KEY = "certificate-lookup-cache.json";
const POLICY_REPORT_ID = "00OQm0000016PuPMAU";
const PREMIUM_REPORT_ID = "00OQm000003Q6cjMAC";
const ACTIVE_POLICY_STATUSES = new Set(["in force", "payment issue", "payment issues", "follow up"]);
const DEFAULT_ACTIVE_POLICY_STATUS = "In Force";
const SALESFORCE_API_VERSION = "v61.0";
const REFRESH_HOUR = Math.max(0, Math.min(23, Number(process.env.CERTIFICATE_LOOKUP_REFRESH_HOUR || 5) || 5));
const REFRESH_MINUTE = Math.max(0, Math.min(59, Number(process.env.CERTIFICATE_LOOKUP_REFRESH_MINUTE || 0) || 0));

let cacheState = null;
let cacheDiskWritable = true;
let policyStatusFieldApiNameCache = null;
let policyStatusValueLabelMapCache = null;
let refreshScheduleTimeout = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStorage() {
  ensureDir(DATA_DIR);
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

function writeJson(filePath, payload) {
  ensureStorage();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCertificateNumber(value) {
  const text = normalizeText(value)
    .replace(/,/g, "")
    .replace(/[-\s]+/g, "");
  const numericSpreadsheetMatch = text.match(/^(\d+)\.0+$/);
  if (numericSpreadsheetMatch) {
    return numericSpreadsheetMatch[1];
  }
  return text === "-" ? "" : text;
}

function normalizePolicyId(value) {
  return normalizeText(value);
}

function normalizePolicyStatus(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeAmount(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const negativeByParens = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negativeByParens ? -parsed : parsed;
}

function normalizeSalesforceId(value) {
  const text = normalizeText(value);
  return /^[a-zA-Z0-9]{15,18}$/.test(text) ? text : "";
}

function coerceActivePolicyStatus(value) {
  const status = normalizePolicyStatus(value);
  return status || DEFAULT_ACTIVE_POLICY_STATUS;
}

function normalizeFieldToken(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function escapeSoqlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function getLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDefaultCache() {
  return {
    reportId: POLICY_REPORT_ID,
    refreshedAt: null,
    source: "not-loaded",
    items: [],
  };
}

function readCache() {
  ensureStorage();
  if (!cacheState || typeof cacheState !== "object") {
    cacheState = safeParseJson(CACHE_PATH, buildDefaultCache());
  }
  return cacheState;
}

function setCertificateLookupCache(nextCache, options = {}) {
  const { persist = true } = options;
  cacheState = clone(nextCache && typeof nextCache === "object" ? nextCache : buildDefaultCache());
  try {
    if (persist && cacheDiskWritable) {
      writeJson(CACHE_PATH, cacheState);
    }
    if (persist) {
      queueStateSync(CACHE_SUPABASE_KEY, cacheState);
    }
  } catch (error) {
    if (cacheDiskWritable) {
      console.warn("Unable to persist shared certificate lookup cache to disk, switching to in-memory mode:", error.message);
    }
    cacheDiskWritable = false;
  }
  return cacheState;
}

async function initializeCertificateLookupPersistence() {
  const loadedCache = await loadStateObject(CACHE_SUPABASE_KEY, safeParseJson(CACHE_PATH, buildDefaultCache()));
  cacheState = loadedCache && typeof loadedCache === "object"
    ? loadedCache
    : buildDefaultCache();
  setCertificateLookupCache(cacheState);
  return cacheState;
}

function getCertificateLookupCache() {
  return clone(readCache());
}

function buildPolicyLookupEntriesFromRows(rows, sourceReportId = POLICY_REPORT_ID) {
  const entries = [];
  const seen = new Set();

  rows.forEach((row) => {
    const certificateNumber = normalizeCertificateNumber(
      row["Certificate: Certificate Name"] ||
      row["Certificate Name"] ||
      row.Certificate ||
      row["Certificate Number"] ||
      row["Certificate Field"] ||
      row["Cert Number"]
    );
    const policyId = normalizePolicyId(
      row["Policy ID"] ||
      row.Policy ||
      row["Policy Id"] ||
      ""
    );
    const certificateRecordId = normalizeSalesforceId(
      row["Certificate Record ID"] ||
      row["Certificate ID"] ||
      row["Certificate Record Id"] ||
      row["Certificate: ID"] ||
      row["Account ID"] ||
      ""
    );
    const policyStatus = coerceActivePolicyStatus(
      row["Policy Status"] ||
      row["Policy: Policy Status"] ||
      row["Policy: Status"] ||
      row.Status ||
      ""
    );

    if (!certificateNumber || !policyId) return;
    const key = `${certificateNumber.toLowerCase()}::${policyId.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      certificate_number: certificateNumber,
      policy_id: policyId,
      certificate_record_id: certificateRecordId,
      p1: normalizeAmount(row.P1),
      p2: normalizeAmount(row.P2),
      p3: normalizeAmount(row.P3),
      p6: normalizeAmount(row.P6),
      p12: normalizeAmount(row.P12),
      member_1_name: normalizeText(row["Member 1"] || row["Member 1 Name"] || ""),
      member_2_name: normalizeText(row["Member 2"] || row["Member 2 Name"] || ""),
      policy_status: policyStatus,
      refreshed_at: new Date().toISOString(),
      source_report_id: sourceReportId,
    });
  });

  return entries;
}

function mergeLookupEntries(...entryGroups) {
  const merged = new Map();

  entryGroups.flat().forEach((entry) => {
    const certificateNumber = normalizeCertificateNumber(entry?.certificate_number);
    const policyId = normalizePolicyId(entry?.policy_id);
    if (!certificateNumber || !policyId) {
      return;
    }
    const key = `${certificateNumber.toLowerCase()}::${policyId.toLowerCase()}`;
    const previous = merged.get(key) || {};
    merged.set(key, {
      certificate_number: certificateNumber,
      policy_id: policyId,
      certificate_record_id: normalizeSalesforceId(entry?.certificate_record_id)
        || normalizeSalesforceId(previous.certificate_record_id)
        || "",
      p1: entry?.p1 ?? previous.p1 ?? null,
      p2: entry?.p2 ?? previous.p2 ?? null,
      p3: entry?.p3 ?? previous.p3 ?? null,
      p6: entry?.p6 ?? previous.p6 ?? null,
      p12: entry?.p12 ?? previous.p12 ?? null,
      member_1_name: normalizeText(entry?.member_1_name || previous.member_1_name || ""),
      member_2_name: normalizeText(entry?.member_2_name || previous.member_2_name || ""),
      policy_status: normalizePolicyStatus(entry?.policy_status || previous.policy_status || ""),
      refreshed_at: entry?.refreshed_at || previous.refreshed_at || new Date().toISOString(),
      source_report_id: entry?.source_report_id || previous.source_report_id || "",
    });
  });

  return Array.from(merged.values());
}

function chunkArray(items, chunkSize = 200) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

async function getPolicyStatusFieldApiName(tokenRecord) {
  if (policyStatusFieldApiNameCache !== null && policyStatusValueLabelMapCache !== null) {
    return policyStatusFieldApiNameCache;
  }

  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/sobjects/Policy__c/describe`,
    { method: "GET" }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload[0]?.message || payload.message || "Unable to describe Policy__c.");
  }

  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const preferredCandidates = [
    "Policy_Status__c",
    "PolicyStatus__c",
    "Status__c",
  ];
  const preferredMap = new Map(preferredCandidates.map((entry) => [normalizeFieldToken(entry), entry]));
  const matchedPreferredField = fields.find((field) => preferredMap.has(normalizeFieldToken(field?.name)));
  if (matchedPreferredField?.name) {
    policyStatusFieldApiNameCache = matchedPreferredField.name;
    policyStatusValueLabelMapCache = new Map(
      Array.isArray(matchedPreferredField.picklistValues)
        ? matchedPreferredField.picklistValues.map((entry) => [normalizeText(entry?.value), normalizeText(entry?.label)])
        : []
    );
    return policyStatusFieldApiNameCache;
  }

  const matchedLabelField = fields.find((field) => {
    const normalizedName = normalizeFieldToken(field?.name);
    const normalizedLabel = normalizeFieldToken(field?.label);
    return normalizedName.includes("policystatus")
      || normalizedLabel.includes("policystatus")
      || (normalizedName === "statusc" && normalizedLabel === "status")
      || (normalizedName.endsWith("statusc") && normalizedLabel.includes("status"));
  });

  policyStatusFieldApiNameCache = matchedLabelField?.name || "";
  policyStatusValueLabelMapCache = new Map(
    Array.isArray(matchedLabelField?.picklistValues)
      ? matchedLabelField.picklistValues.map((entry) => [normalizeText(entry?.value), normalizeText(entry?.label)])
      : []
  );
  return policyStatusFieldApiNameCache;
}

function mapPolicyStatusValueToLabel(value) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return "";
  }
  const mappedLabel = policyStatusValueLabelMapCache?.get(normalizedValue);
  return normalizePolicyStatus(mappedLabel || normalizedValue);
}

async function fetchPolicyDetailEntriesForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(new Set((certificateNumbers || []).map(normalizeCertificateNumber).filter(Boolean)));
  if (!uniqueCertificates.length) {
    return [];
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const policyStatusFieldApiName = await getPolicyStatusFieldApiName(tokenRecord);
  const policyStatusSelect = policyStatusFieldApiName ? `, ${policyStatusFieldApiName}` : "";
  const allRecords = [];

  for (const chunk of chunkArray(uniqueCertificates, 150)) {
    const soql = `
SELECT Id, Account__c, Account__r.Name, Member_1_Name__c, Member_2_Name__c, Member_1_Contact_Id__r.Name, Member_2_Contact_Id__r.Name, P1__c, P2__c, P3__c, P6__c, P12__c${policyStatusSelect}
FROM Policy__c
WHERE Account__r.Name IN (${chunk.map((entry) => `'${escapeSoqlString(entry)}'`).join(", ")})
`.trim();
    const records = await runSoqlQuery(tokenRecord, soql);
    allRecords.push(...records);
  }

  return allRecords.map((record) => ({
    certificate_number: normalizeCertificateNumber(record.Account__r?.Name),
    policy_id: normalizePolicyId(record.Id),
    certificate_record_id: normalizeSalesforceId(record.Account__c),
    p1: normalizeAmount(record.P1__c),
    p2: normalizeAmount(record.P2__c),
    p3: normalizeAmount(record.P3__c),
    p6: normalizeAmount(record.P6__c),
    p12: normalizeAmount(record.P12__c),
    member_1_name: normalizeText(record.Member_1_Name__c || record.Member_1_Contact_Id__r?.Name),
    member_2_name: normalizeText(record.Member_2_Name__c || record.Member_2_Contact_Id__r?.Name),
    policy_status: mapPolicyStatusValueToLabel(record[policyStatusFieldApiName] || ""),
    refreshed_at: new Date().toISOString(),
    source_report_id: policyStatusFieldApiName ? `Policy__c.${policyStatusFieldApiName}` : "Policy__c",
  }));
}

async function fetchCertificateRecordIdsForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(new Set((certificateNumbers || []).map(normalizeCertificateNumber).filter(Boolean)));
  if (!uniqueCertificates.length) {
    return new Map();
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const mappedEntries = [];
  for (const chunk of chunkArray(uniqueCertificates, 150)) {
    const soql = `
SELECT Id, Name
FROM Account
WHERE Name IN (${chunk.map((entry) => `'${escapeSoqlString(entry)}'`).join(", ")})
`.trim();
    const records = await runSoqlQuery(tokenRecord, soql);
    mappedEntries.push(
      ...records
        .map((record) => [normalizeCertificateNumber(record.Name).toLowerCase(), normalizeSalesforceId(record.Id)])
        .filter(([certificateNumber, certificateRecordId]) => Boolean(certificateNumber && certificateRecordId))
    );
  }
  return new Map(mappedEntries);
}

async function fetchBaseReportEntries() {
  const report = await fetchRawSalesforceReportRows(POLICY_REPORT_ID);
  const reportRows = Array.isArray(report.rows) ? report.rows : [];
  return buildPolicyLookupEntriesFromRows(reportRows, POLICY_REPORT_ID);
}

async function fetchPremiumLookupEntries() {
  const report = await fetchRawSalesforceReportRows(PREMIUM_REPORT_ID);
  const reportRows = Array.isArray(report.rows) ? report.rows : [];
  return buildPolicyLookupEntriesFromRows(reportRows, PREMIUM_REPORT_ID);
}

function buildCertificateIdEntries(certificateNumbers, certificateRecordIdMap) {
  return certificateNumbers.map((certificateNumber) => ({
    certificate_number: certificateNumber,
    policy_id: "__certificate_record_only__",
    certificate_record_id: normalizeSalesforceId(certificateRecordIdMap.get(certificateNumber.toLowerCase()) || ""),
    refreshed_at: new Date().toISOString(),
    source_report_id: "Account.Name",
  })).filter((entry) => entry.certificate_record_id);
}

async function refreshCertificateLookupCacheFromSalesforce() {
  const baseEntries = await fetchBaseReportEntries();
  if (!baseEntries.length) {
    throw new Error("The Salesforce policy lookup report returned no certificate-to-policy matches.");
  }
  const premiumEntries = await fetchPremiumLookupEntries();
  const certificateNumbers = Array.from(
    new Set([...baseEntries, ...premiumEntries].map((entry) => normalizeCertificateNumber(entry.certificate_number)).filter(Boolean))
  );
  const targetedPolicyEntries = await fetchPolicyDetailEntriesForCertificates(certificateNumbers);
  const certificateRecordIdMap = await fetchCertificateRecordIdsForCertificates(certificateNumbers);

  const nextCache = {
    reportId: POLICY_REPORT_ID,
    refreshedAt: new Date().toISOString(),
    source: "salesforce-report+premium-report+policy-soql+certificate-soql",
    items: mergeLookupEntries(
      baseEntries,
      premiumEntries,
      targetedPolicyEntries
    ).map((entry) => ({
      ...entry,
      certificate_record_id: normalizeSalesforceId(
        certificateRecordIdMap.get(normalizeCertificateNumber(entry.certificate_number).toLowerCase()) || entry.certificate_record_id || ""
      ),
    })),
  };

  setCertificateLookupCache(nextCache);
  return getCertificateLookupCache();
}

async function refreshCertificateLookupCacheForCertificates(certificateNumbers = []) {
  const normalizedCertificateNumbers = Array.from(
    new Set((certificateNumbers || []).map(normalizeCertificateNumber).filter(Boolean))
  );
  if (!normalizedCertificateNumbers.length) {
    return getCertificateLookupCache();
  }

  const currentCache = readCache();
  const targetedPolicyEntries = await fetchPolicyDetailEntriesForCertificates(normalizedCertificateNumbers);
  const certificateRecordIdMap = await fetchCertificateRecordIdsForCertificates(normalizedCertificateNumbers);
  const nextItems = mergeLookupEntries(
    currentCache.items || [],
    targetedPolicyEntries
  ).map((entry) => {
    const certificateRecordId = normalizeSalesforceId(
      certificateRecordIdMap.get(normalizeCertificateNumber(entry.certificate_number).toLowerCase()) || entry.certificate_record_id || ""
    );
    return {
      ...entry,
      certificate_record_id: certificateRecordId,
    };
  });

  const nextCache = {
    ...currentCache,
    refreshedAt: new Date().toISOString(),
    source: currentCache.source && currentCache.source !== "not-loaded"
      ? currentCache.source
      : "policy-soql+certificate-soql",
    items: nextItems,
  };

  setCertificateLookupCache(nextCache);
  return getCertificateLookupCache();
}

function getNextScheduledRefreshTime(now = new Date()) {
  const nextRun = new Date(now);
  nextRun.setHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  return nextRun;
}

function hasSuccessfulRefreshForDate(dateKey) {
  const refreshedAt = normalizeText(readCache()?.refreshedAt || "");
  if (!refreshedAt) {
    return false;
  }
  const refreshedDate = new Date(refreshedAt);
  if (Number.isNaN(refreshedDate.getTime())) {
    return false;
  }
  return getLocalDateKey(refreshedDate) === dateKey;
}

function scheduleNextCertificateLookupRefresh(logger = console) {
  if (refreshScheduleTimeout) {
    clearTimeout(refreshScheduleTimeout);
    refreshScheduleTimeout = null;
  }

  const now = new Date();
  const nextRun = getNextScheduledRefreshTime(now);
  const delayMs = Math.max(1000, nextRun.getTime() - now.getTime());
  logger.log(
    `Certificate lookup refresh scheduler armed for ${nextRun.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })}.`
  );

  refreshScheduleTimeout = setTimeout(async () => {
    refreshScheduleTimeout = null;
    try {
      const result = await refreshCertificateLookupCacheFromSalesforce();
      logger.log(`Scheduled certificate lookup refresh complete: ${Number(result.items?.length || 0).toLocaleString("en-US")} row(s).`);
    } catch (error) {
      logger.warn(`Scheduled certificate lookup refresh failed: ${error.message}`);
    } finally {
      scheduleNextCertificateLookupRefresh(logger);
    }
  }, delayMs);
}

async function maybeRunStartupCertificateLookupRefresh(logger = console) {
  const now = new Date();
  const scheduledTime = new Date(now);
  scheduledTime.setHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);
  if (now.getTime() < scheduledTime.getTime()) {
    return;
  }
  const todayKey = getLocalDateKey(now);
  if (hasSuccessfulRefreshForDate(todayKey)) {
    return;
  }
  logger.log("No successful certificate lookup refresh found for today after the scheduled time. Running startup catch-up refresh.");
  try {
    const result = await refreshCertificateLookupCacheFromSalesforce();
    logger.log(`Startup certificate lookup refresh complete: ${Number(result.items?.length || 0).toLocaleString("en-US")} row(s).`);
  } catch (error) {
    logger.warn(`Startup certificate lookup refresh failed: ${error.message}`);
  }
}

module.exports = {
  POLICY_REPORT_ID,
  PREMIUM_REPORT_ID,
  getCertificateLookupCache,
  initializeCertificateLookupPersistence,
  maybeRunStartupCertificateLookupRefresh,
  normalizeCertificateNumber,
  refreshCertificateLookupCacheForCertificates,
  refreshCertificateLookupCacheFromSalesforce,
  scheduleNextCertificateLookupRefresh,
  setCertificateLookupCache,
};
