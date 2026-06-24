const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  fetchRawSalesforceReportRows,
  getConnectedSalesforceToken,
  runSoqlQuery,
  salesforceRequest,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_PATH = path.join(DATA_DIR, "check-import-sessions.json");
const ROW_PATH = path.join(DATA_DIR, "check-import-rows.json");
const POLICY_CACHE_PATH = path.join(DATA_DIR, "check-import-policy-lookup-cache.json");
const SESSION_SUPABASE_KEY = "check-import-sessions.json";
const ROW_SUPABASE_KEY = "check-import-rows.json";
const POLICY_CACHE_SUPABASE_KEY = "check-import-policy-lookup-cache.json";
const EXPORT_DIR = path.join(os.tmpdir(), "hpa-check-import-exports");
const POLICY_REPORT_ID = "00OQm0000016PuPMAU";
const PREMIUM_REPORT_ID = "00OQm000003Q6cjMAC";
const DEFAULT_ACTOR = "Local User";
const IMPORT_TEMPLATE_KEY = "check-payments";
const IMPORT_BATCH_SIZE = 200;
const ACTIVE_POLICY_STATUSES = new Set(["in force", "payment issues", "follow up"]);
const ACTIVE_POLICY_STATUS_LABEL = "In Force, Payment Issues, or Follow Up";
const DEFAULT_ACTIVE_POLICY_STATUS = "In Force";
const SALESFORCE_API_VERSION = "v61.0";
const CHECK_HEADER_ROW = [
  "Transaction Type",
  "Deposit Date",
  "Customer Batch Number",
  "Sequence Number",
  "Bank Number",
  "Account Number",
  "Check Number",
  "Check Amount",
  "Remitter Name",
  "Doc Count",
  "Transaction ID",
  "Certificate Field",
];

const IMPORT_TEMPLATES = [
  {
    key: IMPORT_TEMPLATE_KEY,
    name: "Check Import",
    importType: "check-imports",
    salesforceObjectApiName: "TPA__c",
    operationType: "insert",
    uploadedFileColumnNames: [
      "Deposit Date",
      "Check Amount",
      "Check Number",
      "Transaction ID",
      "Certificate Field",
      "Remitter Name",
      "Member 1",
      "Member 2",
      "No Of Months",
    ],
    salesforceFieldApiNames: [
      "Certificate_Number__c",
      "Date_Received__c",
      "Amount_Received__c",
      "Months__c",
      "Check__c",
    ],
    requiredFields: [
      "Certificate_Number__c",
      "Date_Received__c",
      "Amount_Received__c",
      "Months__c",
    ],
    active: true,
  },
];

let sessionCache = null;
let rowCache = null;
let policyCache = null;
let sessionDiskWritable = true;
let rowDiskWritable = true;
let policyCacheDiskWritable = true;
let policyStatusFieldApiNameCache = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStorage() {
  ensureDir(DATA_DIR);
  ensureDir(EXPORT_DIR);
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
    .replace(/\s+/g, "");
  return text === "-" ? "" : text;
}

function normalizePolicyId(value) {
  return normalizeText(value);
}

function normalizePolicyStatus(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function isActivePolicyStatus(value) {
  return ACTIVE_POLICY_STATUSES.has(normalizePolicyStatus(value).toLowerCase());
}

function describePolicyStatus(value) {
  const status = normalizePolicyStatus(value);
  return status || "unknown";
}

function coerceActivePolicyStatus(value) {
  const status = normalizePolicyStatus(value);
  return status || DEFAULT_ACTIVE_POLICY_STATUS;
}

function logCheckImportEvent(message, details = null) {
  if (details && typeof details === "object") {
    console.log(`[check-import] ${message}`, details);
    return;
  }
  console.log(`[check-import] ${message}${details ? ` ${details}` : ""}`);
}

function normalizePersonName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left) return right.length;
  if (!right) return left.length;
  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
    }
  }
  return matrix[left.length][right.length];
}

function arePersonNamesSimilar(left, right) {
  const normalizedLeft = normalizePersonName(left).replace(/\s+/g, "");
  const normalizedRight = normalizePersonName(right).replace(/\s+/g, "");
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (
    Math.min(normalizedLeft.length, normalizedRight.length) >= 5 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return true;
  }
  return levenshteinDistance(normalizedLeft, normalizedRight) <= 1;
}

function normalizeAmount(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const negativeByParens = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negativeByParens ? -parsed : parsed;
}

function normalizeDateText(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const month = String(slash[1]).padStart(2, "0");
    const day = String(slash[2]).padStart(2, "0");
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTimeText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    const date = normalizeDateText(text);
    return date ? `${date}T00:00:00.000Z` : "";
  }
  return parsed.toISOString();
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return "";
  return numericValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeSoqlString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function normalizeFieldToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isSameAmount(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

function getPremiumFieldForMonths(months) {
  const numericMonths = Number(months);
  if (numericMonths === 1) return "p1";
  if (numericMonths === 2) return "p2";
  if (numericMonths === 3) return "p3";
  if (numericMonths === 6) return "p6";
  if (numericMonths === 12) return "p12";
  return "";
}

function getExpectedPremiumAmount(entry, months) {
  if (!entry || typeof entry !== "object") return null;
  const field = getPremiumFieldForMonths(months);
  if (!field) return null;
  const value = Number(entry[field]);
  return Number.isFinite(value) ? value : null;
}

function getPremiumComparisonOptions(entry) {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  return [1, 2, 3, 6, 12]
    .map((months) => ({
      months,
      expectedAmount: getExpectedPremiumAmount(entry, months),
    }))
    .filter((option) => Number.isFinite(option.expectedAmount));
}

function buildPremiumComparisonLabel(entry) {
  const options = getPremiumComparisonOptions(entry);
  if (!options.length) {
    return "";
  }
  return options
    .map((option) => `P${option.months}: ${formatCurrency(option.expectedAmount)}`)
    .join(" | ");
}

function createSessionId() {
  return `check_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRowId(sessionId, rowNumber) {
  return `${sessionId}_row_${rowNumber}`;
}

function getCheckImportTemplate(templateKey = IMPORT_TEMPLATE_KEY) {
  const normalizedKey = String(templateKey || IMPORT_TEMPLATE_KEY).trim();
  return IMPORT_TEMPLATES.find((entry) => entry.key === normalizedKey && entry.active) || null;
}

function listCheckImportTemplates() {
  return IMPORT_TEMPLATES.filter((entry) => entry.active).map((entry) => clone(entry));
}

function runPowerShell(command) {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "PowerShell command failed.");
  }

  return result.stdout;
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  return rows.map((entry) => entry.map((value) => String(value || "").trim()));
}

function buildPolicyLookupDefault() {
  return {
    reportId: POLICY_REPORT_ID,
    refreshedAt: null,
    source: "not-loaded",
    items: [],
  };
}

function readSessions() {
  ensureStorage();
  if (!Array.isArray(sessionCache)) {
    sessionCache = safeParseJson(SESSION_PATH, []);
  }
  return sessionCache;
}

function writeSessions(nextSessions) {
  sessionCache = clone(nextSessions);
  try {
    if (sessionDiskWritable) {
      writeJson(SESSION_PATH, sessionCache);
    }
    queueStateSync(SESSION_SUPABASE_KEY, sessionCache);
  } catch (error) {
    if (sessionDiskWritable) {
      console.warn("Unable to persist check import sessions to disk, switching to in-memory mode:", error.message);
    }
    sessionDiskWritable = false;
  }
}

function readRows() {
  ensureStorage();
  if (!Array.isArray(rowCache)) {
    rowCache = safeParseJson(ROW_PATH, []);
  }
  return rowCache;
}

function writeRows(nextRows) {
  rowCache = clone(nextRows);
  try {
    if (rowDiskWritable) {
      writeJson(ROW_PATH, rowCache);
    }
    queueStateSync(ROW_SUPABASE_KEY, rowCache);
  } catch (error) {
    if (rowDiskWritable) {
      console.warn("Unable to persist check import rows to disk, switching to in-memory mode:", error.message);
    }
    rowDiskWritable = false;
  }
}

function readPolicyCache() {
  ensureStorage();
  if (!policyCache || typeof policyCache !== "object") {
    policyCache = safeParseJson(POLICY_CACHE_PATH, buildPolicyLookupDefault());
  }
  return policyCache;
}

function writePolicyCache(nextCache) {
  policyCache = clone(nextCache);
  try {
    if (policyCacheDiskWritable) {
      writeJson(POLICY_CACHE_PATH, policyCache);
    }
    queueStateSync(POLICY_CACHE_SUPABASE_KEY, policyCache);
  } catch (error) {
    if (policyCacheDiskWritable) {
      console.warn("Unable to persist check import policy cache to disk, switching to in-memory mode:", error.message);
    }
    policyCacheDiskWritable = false;
  }
}

async function initializeCheckImportPersistence() {
  const [loadedSessions, loadedRows, loadedPolicyCache] = await Promise.all([
    loadStateObject(SESSION_SUPABASE_KEY, safeParseJson(SESSION_PATH, [])),
    loadStateObject(ROW_SUPABASE_KEY, safeParseJson(ROW_PATH, [])),
    loadStateObject(POLICY_CACHE_SUPABASE_KEY, safeParseJson(POLICY_CACHE_PATH, buildPolicyLookupDefault())),
  ]);

  sessionCache = Array.isArray(loadedSessions) ? loadedSessions : [];
  rowCache = Array.isArray(loadedRows) ? loadedRows : [];
  policyCache = loadedPolicyCache && typeof loadedPolicyCache === "object"
    ? loadedPolicyCache
    : buildPolicyLookupDefault();

  writeSessions(sessionCache);
  writeRows(rowCache);
  writePolicyCache(policyCache);
}

function __setCheckImportStateForTests({ sessions = [], rows = [], policyCache: nextPolicyCache = null } = {}) {
  sessionCache = clone(Array.isArray(sessions) ? sessions : []);
  rowCache = clone(Array.isArray(rows) ? rows : []);
  policyCache = clone(
    nextPolicyCache && typeof nextPolicyCache === "object"
      ? nextPolicyCache
      : buildPolicyLookupDefault()
  );
  sessionDiskWritable = false;
  rowDiskWritable = false;
  policyCacheDiskWritable = false;
}

function buildPolicyLookupEntriesFromRows(rows) {
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
    const certificateRecordId = normalizeText(
      row["Certificate Record ID"] ||
      row["Certificate ID"] ||
      row["Certificate Record Id"] ||
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
      source_report_id: POLICY_REPORT_ID,
    });
  });

  return entries;
}

function mergeLookupEntries(...entryGroups) {
  const merged = new Map();

  entryGroups.flat().forEach((entry) => {
    const certificateNumber = normalizeCertificateNumber(entry?.certificate_number);
    if (!certificateNumber) return;
    const key = certificateNumber.toLowerCase();
    const previous = merged.get(key) || {};
    merged.set(key, {
      certificate_number: certificateNumber,
      policy_id: normalizePolicyId(entry?.policy_id || previous.policy_id || ""),
      certificate_record_id: normalizeText(entry?.certificate_record_id || previous.certificate_record_id || ""),
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

async function refreshPolicyLookupFromSalesforce() {
  const report = await fetchRawSalesforceReportRows(POLICY_REPORT_ID);
  const reportRows = Array.isArray(report.rows) ? report.rows : [];
  const items = buildPolicyLookupEntriesFromRows(reportRows);
  if (!items.length) {
    throw new Error("The Salesforce policy lookup report returned no certificate-to-policy matches.");
  }
  logCheckImportEvent(`Loaded ${items.length.toLocaleString("en-US")} certificate records for TPA lookup.`);
  const nextCache = {
    reportId: POLICY_REPORT_ID,
    refreshedAt: new Date().toISOString(),
    source: "salesforce-report",
    items,
  };
  writePolicyCache(nextCache);
  return nextCache;
}

async function fetchPremiumLookupFromSalesforce() {
  const report = await fetchRawSalesforceReportRows(PREMIUM_REPORT_ID);
  const reportRows = Array.isArray(report.rows) ? report.rows : [];
  return buildPolicyLookupEntriesFromRows(reportRows);
}

async function getPolicyStatusFieldApiName(tokenRecord) {
  if (policyStatusFieldApiNameCache !== null) {
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
  const preferredMap = new Map(
    preferredCandidates.map((entry) => [normalizeFieldToken(entry), entry])
  );

  const matchedPreferredField = fields.find((field) => {
    return preferredMap.has(normalizeFieldToken(field?.name));
  });
  if (matchedPreferredField?.name) {
    policyStatusFieldApiNameCache = matchedPreferredField.name;
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
  return policyStatusFieldApiNameCache;
}

async function fetchPolicyDetailEntriesForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(
    new Set((certificateNumbers || []).map((entry) => normalizeCertificateNumber(entry)).filter(Boolean))
  );

  if (!uniqueCertificates.length) return [];

  const tokenRecord = await getConnectedSalesforceToken();
  const policyStatusFieldApiName = await getPolicyStatusFieldApiName(tokenRecord);
  const policyStatusSelect = policyStatusFieldApiName ? `, ${policyStatusFieldApiName}` : "";
  const soql = `
SELECT Id, Account__c, Account__r.Name, Member_1_Name__c, Member_2_Name__c, Member_1_Contact_Id__r.Name, Member_2_Contact_Id__r.Name, P1__c, P2__c, P3__c, P6__c, P12__c${policyStatusSelect}
FROM Policy__c
WHERE Account__r.Name IN (${uniqueCertificates.map((entry) => `'${escapeSoqlString(entry)}'`).join(", ")})
`.trim();
  const records = await runSoqlQuery(tokenRecord, soql);
  return records.map((record) => ({
    certificate_number: normalizeCertificateNumber(record.Account__r?.Name),
    policy_id: normalizePolicyId(record.Id),
    certificate_record_id: normalizeText(record.Account__c),
    p1: normalizeAmount(record.P1__c),
    p2: normalizeAmount(record.P2__c),
    p3: normalizeAmount(record.P3__c),
    p6: normalizeAmount(record.P6__c),
    p12: normalizeAmount(record.P12__c),
    member_1_name: normalizeText(record.Member_1_Name__c || record.Member_1_Contact_Id__r?.Name),
    member_2_name: normalizeText(record.Member_2_Name__c || record.Member_2_Contact_Id__r?.Name),
    policy_status: normalizePolicyStatus(record[policyStatusFieldApiName] || ""),
    refreshed_at: new Date().toISOString(),
    source_report_id: policyStatusFieldApiName ? `Policy__c.${policyStatusFieldApiName}` : "Policy__c",
  }));
}

async function fetchCertificateRecordIdsForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(
    new Set((certificateNumbers || []).map((entry) => normalizeCertificateNumber(entry)).filter(Boolean))
  );

  if (!uniqueCertificates.length) return new Map();

  const tokenRecord = await getConnectedSalesforceToken();
  const soql = `
SELECT Id, Name
FROM Account
WHERE Name IN (${uniqueCertificates.map((entry) => `'${escapeSoqlString(entry)}'`).join(", ")})
`.trim();
  const records = await runSoqlQuery(tokenRecord, soql);
  return new Map(
    records
      .map((record) => [
        normalizeCertificateNumber(record.Name).toLowerCase(),
        normalizeText(record.Id),
      ])
      .filter(([certificateNumber, certificateRecordId]) => Boolean(certificateNumber && certificateRecordId))
  );
}

async function findNameAmountMatchForRow(row) {
  const paymentAmount = normalizeAmount(row.check_amount);
  if (!Number.isFinite(paymentAmount)) return null;

  const nameCandidates = Array.from(
    new Set([row.remitter_name, row.member_1_name, row.member_2_name].map((entry) => normalizeText(entry)).filter(Boolean))
  );
  if (!nameCandidates.length) return null;

  const tokenRecord = await getConnectedSalesforceToken();
  const escapedNames = nameCandidates.map((entry) => `'${escapeSoqlString(entry)}'`).join(", ");
  const soql = `
SELECT Id, Account__c, Account__r.Name, Member_1_Name__c, Member_2_Name__c, Member_1_Contact_Id__r.Name, Member_2_Contact_Id__r.Name, P1__c, P2__c, P3__c, P6__c, P12__c
FROM Policy__c
WHERE (${[
      "Member_1_Name__c",
      "Member_2_Name__c",
      "Member_1_Contact_Id__r.Name",
      "Member_2_Contact_Id__r.Name",
    ].map((fieldName) => `${fieldName} IN (${escapedNames})`).join(" OR ")})
`.trim();
  const records = await runSoqlQuery(tokenRecord, soql);
  const matches = records.flatMap((record) => {
    const member1Name = normalizeText(record.Member_1_Name__c || record.Member_1_Contact_Id__r?.Name);
    const member2Name = normalizeText(record.Member_2_Name__c || record.Member_2_Contact_Id__r?.Name);
    const matchedField = nameCandidates.find((entry) => arePersonNamesSimilar(entry, member1Name))
      ? "Member 1"
      : nameCandidates.find((entry) => arePersonNamesSimilar(entry, member2Name))
        ? "Member 2"
        : "";
    if (!matchedField) return [];

    const policyEntry = {
      certificate_number: normalizeCertificateNumber(record.Account__r?.Name),
      policy_id: normalizePolicyId(record.Id),
      certificate_record_id: normalizeText(record.Account__c),
      p1: normalizeAmount(record.P1__c),
      p2: normalizeAmount(record.P2__c),
      p3: normalizeAmount(record.P3__c),
      p6: normalizeAmount(record.P6__c),
      p12: normalizeAmount(record.P12__c),
      member_1_name: member1Name,
      member_2_name: member2Name,
      policy_status: "",
    };
    const options = getPremiumComparisonOptions(policyEntry);
    return options.map((entry) => ({
      ...policyEntry,
      matched_name_field: matchedField,
      months: entry.months,
      expected_amount: entry.expectedAmount,
      exact: isSameAmount(entry.expectedAmount, paymentAmount),
      difference: Math.abs(Number(entry.expectedAmount || 0) - paymentAmount),
      comparison_label: buildPremiumComparisonLabel(policyEntry),
    }));
  });

  if (!matches.length) {
    return null;
  }

  matches.sort((left, right) =>
    Number(right.exact) - Number(left.exact) ||
    Number(left.difference || 0) - Number(right.difference || 0) ||
    String(left.certificate_number || "").localeCompare(String(right.certificate_number || ""))
  );

  const best = matches[0];
  const equivalentBestMatches = matches.filter((entry) =>
    entry.certificate_number &&
    entry.certificate_number !== best.certificate_number &&
    Boolean(entry.exact) === Boolean(best.exact) &&
    Math.abs(Number(entry.difference || 0) - Number(best.difference || 0)) < 0.01
  );

  if (equivalentBestMatches.length) {
    return {
      match_count: 1 + equivalentBestMatches.length,
      candidate_certificates: [best, ...equivalentBestMatches].map((entry) => entry.certificate_number).filter(Boolean),
    };
  }

  return { ...best, match_count: 1 };
}

function extractBatchDetailCsvFromZip(fileName, base64Content) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".csv") {
    return Buffer.from(String(base64Content || ""), "base64").toString("utf8");
  }
  if (extension !== ".zip") {
    throw new Error("Check imports currently support CashPro ZIP files or a direct batchDetail.csv.");
  }

  const buffer = Buffer.from(String(base64Content || ""), "base64");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-check-import-upload-"));
  const zipPath = path.join(tempDir, "cashpro.zip");
  const extractDir = path.join(tempDir, "unzipped");
  fs.writeFileSync(zipPath, buffer);
  runPowerShell(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`);

  try {
    const output = runPowerShell(`Get-ChildItem -LiteralPath '${extractDir}' -Recurse -Filter 'batchDetail.csv' | Select-Object -ExpandProperty FullName`);
    const csvPath = String(output || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (!csvPath || !fs.existsSync(csvPath)) {
      throw new Error("The uploaded ZIP did not contain batchDetail.csv.");
    }
    return fs.readFileSync(csvPath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findHeaderRowIndex(csvRows) {
  return csvRows.findIndex((row) =>
    CHECK_HEADER_ROW.every((header, index) => normalizeText(row[index]) === header)
  );
}

function parseCheckUploadRows(fileName, base64Content) {
  const text = extractBatchDetailCsvFromZip(fileName, base64Content);
  const csvRows = parseCsv(text);
  const headerRowIndex = findHeaderRowIndex(csvRows);
  if (headerRowIndex < 0) {
    throw new Error("The uploaded file did not contain the expected CashPro batch detail header row.");
  }

  const headers = csvRows[headerRowIndex];
  const dataRows = [];
  let footerTransactionCount = null;
  let footerGrandTotalCount = null;
  let footerGrandTotalAmount = null;

  for (let index = headerRowIndex + 1; index < csvRows.length; index += 1) {
    const row = csvRows[index];
    const firstCell = normalizeText(row[0]);
    if (!row.some((value) => normalizeText(value))) {
      continue;
    }

    if (firstCell.startsWith("Transaction Count:")) {
      footerTransactionCount = Number(String(firstCell).split(":")[1]) || null;
      continue;
    }
    if (firstCell.startsWith("Grand Total Transaction Count:")) {
      footerGrandTotalCount = Number(String(firstCell).split(":")[1]) || null;
      continue;
    }
    if (firstCell.startsWith("Grand Total Amount:")) {
      footerGrandTotalAmount = normalizeAmount(String(firstCell).split(":")[1]);
      continue;
    }
    if (firstCell === "Currency" || normalizeText(row[1]) === "USD") {
      continue;
    }

    const objectRow = { __rowNumber: index + 1 };
    headers.forEach((header, headerIndex) => {
      objectRow[String(header || "").trim()] = row[headerIndex] ?? "";
    });

    if (normalizeText(objectRow["Transaction Type"]).toLowerCase() === "check") {
      dataRows.push(objectRow);
    }
  }

  return {
    rows: dataRows,
    meta: {
      footerTransactionCount,
      footerGrandTotalCount,
      footerGrandTotalAmount,
    },
  };
}

function buildImportRow(sessionId, sourceRow, sessionMeta = {}) {
  const rowNumber = Number(sourceRow.__rowNumber || 0);
  return {
    id: createRowId(sessionId, rowNumber),
    session_id: sessionId,
    row_number: rowNumber,
    transaction_type: normalizeText(sourceRow["Transaction Type"]),
    deposit_date: normalizeDateText(sourceRow["Deposit Date"]),
    customer_batch_number: normalizeText(sourceRow["Customer Batch Number"]),
    sequence_number: normalizeText(sourceRow["Sequence Number"]),
    bank_number: normalizeText(sourceRow["Bank Number"]),
    account_number: normalizeText(sourceRow["Account Number"]),
    check_number: normalizeText(sourceRow["Check Number"]),
    check_amount: normalizeText(sourceRow["Check Amount"]),
    remitter_name: normalizeText(sourceRow["Remitter Name"]),
    doc_count: normalizeText(sourceRow["Doc Count"]),
    transaction_id: normalizeText(sourceRow["Transaction ID"]),
    certificate_number: normalizeCertificateNumber(sourceRow["Certificate Field"]),
    corrected_certificate_number: "",
    matched_policy_id: "",
    matched_certificate_record_id: "",
    member_1_name: "",
    member_2_name: "",
    months: "",
    corrected_months: "",
    inferred_certificate_number: "",
    inferred_policy_id: "",
    inferred_policy_status: "",
    inferred_certificate_record_id: "",
    inferred_member_1_name: "",
    inferred_member_2_name: "",
    inferred_months: "",
    inferred_expected_amount: null,
    inferred_premium_comparison_label: "",
    inferred_match_source: "",
    status: "pending",
    issue_reason: "",
    issue_details: [],
    expected_amount: null,
    premium_comparison_label: "",
    discrepancy_note: "",
    import_result_status: "",
    import_result_message: "",
    imported_salesforce_id: "",
    imported_salesforce_created: false,
    raw_json: clone(sourceRow),
    manual_policy_id: "",
    manually_corrected: false,
    corrected_by: "",
    corrected_at: "",
    excluded: false,
    excluded_at: "",
    excluded_by: "",
    footer_transaction_count: sessionMeta.footerTransactionCount || null,
    footer_grand_total_count: sessionMeta.footerGrandTotalCount || null,
    footer_grand_total_amount: sessionMeta.footerGrandTotalAmount ?? null,
  };
}

function duplicateHistoryMap(currentSessionId = "") {
  const map = new Map();
  readRows().forEach((row) => {
    if (row.session_id === currentSessionId) return;
    const transactionId = normalizeText(row.transaction_id);
    if (!transactionId) return;
    map.set(transactionId.toLowerCase(), row.session_id);
  });
  return map;
}

function summarizeIssues(issues) {
  if (!issues.length) return "";
  return issues.map((issue) => issue.message).join(" | ");
}

function buildRowStatus(issues, excluded = false) {
  if (excluded) return "excluded";
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "ready";
}

function buildSessionStatus(counts) {
  if (counts.errorCount > 0) return "needs_attention";
  if (counts.readyCount === 0 && counts.rowCount > 0) return "pending";
  if (counts.importedAt) return "imported";
  return "ready";
}

function buildLookupMaps(cache) {
  const byCertificate = new Map();
  const byPolicyId = new Map();
  const byCertificateRecordId = new Map();
  (cache?.items || []).forEach((entry) => {
    const certificateNumber = normalizeCertificateNumber(entry.certificate_number).toLowerCase();
    const policyId = normalizePolicyId(entry.policy_id).toLowerCase();
    const certificateRecordId = normalizeText(entry.certificate_record_id).toLowerCase();
    if (certificateNumber && policyId) {
      const entries = byCertificate.get(certificateNumber) || [];
      entries.push(entry);
      byCertificate.set(certificateNumber, entries);
    }
    if (policyId) byPolicyId.set(policyId, entry);
    if (certificateRecordId) byCertificateRecordId.set(certificateRecordId, entry);
  });
  return { byCertificate, byPolicyId, byCertificateRecordId };
}

function selectPolicyEntryForCertificate({ certificateNumber, entries = [] } = {}) {
  const normalizedCertificate = normalizeCertificateNumber(certificateNumber);
  const uniqueEntries = Array.from(
    new Map(
      (entries || [])
        .filter((entry) => normalizePolicyId(entry?.policy_id))
        .map((entry) => [normalizePolicyId(entry.policy_id).toLowerCase(), entry])
    ).values()
  );
  const activeEntries = uniqueEntries.filter((entry) => isActivePolicyStatus(entry.policy_status));

  if (activeEntries.length === 1) {
    return { entry: activeEntries[0], issue: null };
  }

  if (activeEntries.length > 1) {
    return {
      entry: null,
      issue: {
        severity: "error",
        code: "multiple_active_policies",
        message: `Certificate ${normalizedCertificate} has multiple ${ACTIVE_POLICY_STATUS_LABEL} policies. Resolve the active policy in Salesforce before importing.`,
      },
    };
  }

  if (uniqueEntries.length) {
    return {
      entry: null,
      issue: {
        severity: "error",
        code: "no_active_policy_status",
        message: `Certificate ${normalizedCertificate} is not on report ${POLICY_REPORT_ID} with an active policy status. Only ${ACTIVE_POLICY_STATUS_LABEL} policies can be imported.`,
      },
    };
  }

  return { entry: null, issue: null };
}

function deriveMonthsAndExpectedAmount(policyEntry, paymentAmount) {
  if (!policyEntry || !Number.isFinite(paymentAmount)) {
    return { months: "", expectedAmount: null, exact: false, comparisonLabel: "" };
  }
  const options = getPremiumComparisonOptions(policyEntry);
  const comparisonLabel = buildPremiumComparisonLabel(policyEntry);
  for (const option of options) {
    if (isSameAmount(option.expectedAmount, paymentAmount)) {
      return { months: option.months, expectedAmount: option.expectedAmount, exact: true, comparisonLabel };
    }
  }
  if (!options.length) {
    return { months: "", expectedAmount: null, exact: false, comparisonLabel };
  }
  const closest = options.reduce((best, option) => {
    if (!best) return option;
    return Math.abs(option.expectedAmount - paymentAmount) < Math.abs(best.expectedAmount - paymentAmount)
      ? option
      : best;
  }, null);
  return {
    months: closest?.months || "",
    expectedAmount: closest?.expectedAmount ?? null,
    exact: false,
    comparisonLabel,
  };
}

function buildPaymentName(row) {
  return `${normalizeCertificateNumber(row.certificate_number)} - Check - ${normalizeText(row.check_number)} - ${normalizeDateText(row.deposit_date)}`.trim();
}

function buildMissingCertificateMessage(certificateNumber) {
  return certificateNumber
    ? `No certificate record found for Cert Number ${certificateNumber}. Correct the certificate number or exclude this row.`
    : "Missing certificate / Cert Number.";
}

function revalidateSession(sessionId) {
  const sessions = readSessions();
  const rows = readRows();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }

  const sessionRows = rows.filter((entry) => entry.session_id === sessionId);
  const transactionCounts = new Map();
  sessionRows.forEach((row) => {
    const transactionId = normalizeText(row.transaction_id).toLowerCase();
    if (!transactionId || row.excluded) return;
    transactionCounts.set(transactionId, (transactionCounts.get(transactionId) || 0) + 1);
  });

  const priorTransactions = duplicateHistoryMap(sessionId);
  const policyCacheState = readPolicyCache();
  const { byCertificate } = buildLookupMaps(policyCacheState);
  const hasLookupData = Array.isArray(policyCacheState?.items) && policyCacheState.items.length > 0;

  let readyCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let missingCertificateCount = 0;
  let missingPolicyCount = 0;
  let discrepancyCount = 0;
  let totalAmount = 0;

  sessionRows.forEach((row) => {
    const certificateNumber = normalizeCertificateNumber(row.corrected_certificate_number || row.certificate_number);
    const paymentAmount = normalizeAmount(row.check_amount);
    const directCertificateEntries = byCertificate.get(certificateNumber.toLowerCase()) || [];
    const directSelection = selectPolicyEntryForCertificate({
      certificateNumber,
      entries: directCertificateEntries,
    });
    const directPolicyEntry = directSelection.entry;
    const inferredPolicyEntry = row.inferred_certificate_number
      ? {
        certificate_number: normalizeCertificateNumber(row.inferred_certificate_number),
        policy_id: normalizePolicyId(row.inferred_policy_id),
        certificate_record_id: normalizeText(row.inferred_certificate_record_id),
        p1: normalizeAmount(row.inferred_p1),
        p2: normalizeAmount(row.inferred_p2),
        p3: normalizeAmount(row.inferred_p3),
        p6: normalizeAmount(row.inferred_p6),
        p12: normalizeAmount(row.inferred_p12),
        member_1_name: normalizeText(row.inferred_member_1_name),
        member_2_name: normalizeText(row.inferred_member_2_name),
        policy_status: normalizePolicyStatus(row.inferred_policy_status),
      }
      : null;
    const policyEntry =
      directPolicyEntry ||
      (!directCertificateEntries.length && inferredPolicyEntry && isActivePolicyStatus(inferredPolicyEntry.policy_status)
        ? inferredPolicyEntry
        : null);
    const matchedPolicyId = normalizePolicyId(policyEntry?.policy_id || "");
    const matchedCertificateRecordId = normalizeText(policyEntry?.certificate_record_id || "");
    const issues = [];

    logCheckImportEvent("Row lookup started", {
      rowId: row.id,
      importedCertNumber: row.certificate_number || "",
      normalizedCertNumber: certificateNumber,
    });

    if (!row.excluded && Number.isFinite(paymentAmount)) {
      totalAmount += paymentAmount;
    }

    if (!hasLookupData) {
      issues.push({
        severity: "error",
        code: "lookup_data_missing",
        message: "Certificate lookup data failed to load. Cannot validate check imports.",
      });
    }

    if (!certificateNumber) {
      issues.push({ severity: "error", code: "missing_certificate", message: buildMissingCertificateMessage("") });
      missingCertificateCount += 1;
    } else if (directSelection.issue) {
      issues.push(directSelection.issue);
      missingCertificateCount += 1;
    } else if (!matchedCertificateRecordId) {
      issues.push({
        severity: "error",
        code: "missing_certificate_record_id",
        message: `Certificate ${certificateNumber} was not found on report ${POLICY_REPORT_ID}. Correct the certificate number or exclude this row.`,
      });
      missingCertificateCount += 1;
      logCheckImportEvent("Certificate not found", {
        rowId: row.id,
        normalizedCertNumber: certificateNumber,
      });
    } else {
      logCheckImportEvent("Certificate found with Salesforce Id", {
        rowId: row.id,
        normalizedCertNumber: certificateNumber,
        certificateRecordId: matchedCertificateRecordId,
      });
      if (!directPolicyEntry && inferredPolicyEntry?.certificate_number) {
        issues.push({
          severity: "warning",
          code: "inferred_certificate_match",
          message: `Matched by ${row.inferred_match_source || "name and premium comparison"} to Cert Number ${inferredPolicyEntry.certificate_number}. Review before importing.`,
        });
      }
    }

    if (!matchedCertificateRecordId) {
      missingPolicyCount += 1;
    }

    if (paymentAmount === null) {
      issues.push({ severity: "error", code: "invalid_amount", message: "Missing or invalid Check Amount." });
    }

    if (!normalizeDateText(row.deposit_date)) {
      issues.push({ severity: "error", code: "missing_deposit_date", message: "Missing Deposit Date." });
    }

    const transactionId = normalizeText(row.transaction_id);
    if (!transactionId) {
      issues.push({ severity: "error", code: "missing_transaction_id", message: "Missing Transaction ID." });
    } else {
      if ((transactionCounts.get(transactionId.toLowerCase()) || 0) > 1) {
        issues.push({ severity: "error", code: "duplicate_transaction_in_file", message: "Duplicate Transaction ID in uploaded file." });
      }
      if (priorTransactions.has(transactionId.toLowerCase())) {
        issues.push({ severity: "warning", code: "duplicate_transaction_in_history", message: "Transaction ID already exists in import history." });
      }
    }

    const matchedPremium = matchedCertificateRecordId
      ? deriveMonthsAndExpectedAmount(policyEntry, paymentAmount)
      : { months: "", expectedAmount: null, exact: false, comparisonLabel: "" };
    const hasManualMonths = row.corrected_months !== null && row.corrected_months !== undefined && String(row.corrected_months).trim() !== "";
    const manualMonths = hasManualMonths ? String(row.corrected_months).trim() : "";
    row.months = manualMonths !== ""
      ? manualMonths
      : matchedPremium.months !== ""
        ? String(matchedPremium.months)
        : "";
    row.expected_amount = matchedPremium.expectedAmount;
    row.premium_comparison_label = matchedPremium.comparisonLabel || "";
    row.member_1_name = normalizeText(policyEntry?.member_1_name || "");
    row.member_2_name = normalizeText(policyEntry?.member_2_name || "");

    if (matchedCertificateRecordId && paymentAmount !== null) {
      const selectedExpectedAmount = getExpectedPremiumAmount(policyEntry, row.months);
      row.expected_amount = selectedExpectedAmount ?? matchedPremium.expectedAmount;
      if (String(row.months || "").trim() === "") {
        discrepancyCount += 1;
        issues.push({ severity: "error", code: "amount_discrepancy", message: "Unable to determine No Of Months from the premium comparison." });
      } else if (!Number.isFinite(selectedExpectedAmount) || !isSameAmount(selectedExpectedAmount, paymentAmount)) {
        discrepancyCount += 1;
        issues.push({
          severity: "warning",
          code: "amount_discrepancy",
          message: `Check amount does not exactly match the selected month option. ${row.premium_comparison_label || "Review P1/P2/P3/P6/P12 before importing."}`,
        });
      }
    }

    row.discrepancy_note = String(row.months || "").trim() !== ""
      ? (row.premium_comparison_label || "")
      : (matchedCertificateRecordId && paymentAmount !== null ? "No exact month match found." : "");

    row.certificate_number = certificateNumber;
    row.matched_policy_id = matchedPolicyId;
    row.matched_policy_status = normalizePolicyStatus(policyEntry?.policy_status || "");
    row.matched_certificate_record_id = matchedCertificateRecordId;
    row.payment_name = buildPaymentName(row);

    row.issue_details = issues;
    row.issue_reason = summarizeIssues(issues);
    row.status = buildRowStatus(issues, row.excluded);
    row.manually_corrected = Boolean(row.corrected_certificate_number);

    logCheckImportEvent(
      row.status === "ready" || row.status === "warning"
        ? "Row validation passed"
        : "Row validation failed with reason",
      {
        rowId: row.id,
        status: row.status,
        issueReason: row.issue_reason,
      }
    );

    if (row.status === "ready") readyCount += 1;
    if (row.status === "warning") {
      readyCount += 1;
      warningCount += 1;
    }
    if (row.status === "error") errorCount += 1;
  });

  const activeRowCount = sessionRows.filter((row) => !row.excluded).length;
  const footerCount = Number(session.footer_transaction_count || session.footer_grand_total_count || 0) || null;
  const footerAmount = normalizeAmount(session.footer_grand_total_amount);
  const footerMismatch = Boolean(
    (footerCount !== null && footerCount !== activeRowCount) ||
    (Number.isFinite(footerAmount) && !isSameAmount(footerAmount, totalAmount))
  );

  if (footerMismatch) {
    errorCount += 1;
  }

  session.row_count = sessionRows.length;
  session.active_row_count = activeRowCount;
  session.ready_count = readyCount;
  session.error_count = errorCount;
  session.warning_count = warningCount;
  session.total_amount = totalAmount;
  session.missing_certificate_count = missingCertificateCount;
  session.missing_policy_count = missingPolicyCount;
  session.discrepancy_count = discrepancyCount;
  session.footer_mismatch = footerMismatch;
  session.footer_transaction_count = session.footer_transaction_count || session.footer_grand_total_count || null;
  session.footer_grand_total_amount = session.footer_grand_total_amount ?? null;
  session.policy_lookup_refreshed_at = readPolicyCache().refreshedAt || session.policy_lookup_refreshed_at || null;
  session.status = buildSessionStatus({
    rowCount: session.row_count,
    readyCount,
    errorCount,
    importedAt: session.import_completed_at,
  });
  session.final_status = errorCount > 0
    ? "validation_failed"
    : session.successful_import_count > 0
      ? (session.salesforce_failed_row_count > 0 ? "imported_with_errors" : "imported")
      : "ready_to_import";
  session.validation_message = !hasLookupData
    ? "Certificate lookup data failed to load. Cannot validate check imports."
    : footerMismatch
    ? "Footer totals do not match the parsed check rows."
    : errorCount > 0
      ? "Fix all blocking errors before importing."
      : "All non-excluded rows are ready to import.";
  session.updated_at = new Date().toISOString();

  writeRows(rows);
  writeSessions(sessions);
  return getCheckImportSession(sessionId);
}

function serializeSession(session, includeRows = false) {
  const template = getCheckImportTemplate(session.import_template_key || IMPORT_TEMPLATE_KEY) || {};
  const rows = includeRows
    ? readRows()
        .filter((entry) => entry.session_id === session.id)
        .sort((a, b) => Number(a.row_number || 0) - Number(b.row_number || 0))
    : undefined;

  return {
    ...clone(session),
    import_template_name: template.name || session.import_template_name || "",
    salesforce_object_api_name: template.salesforceObjectApiName || session.salesforce_object_api_name || "",
    operation_type: template.operationType || session.operation_type || "",
    template: clone(template),
    policyLookup: clone(readPolicyCache()),
    rows,
  };
}

function listCheckImportSessions() {
  return readSessions()
    .slice()
    .sort((a, b) => (Date.parse(b.uploaded_at || 0) || 0) - (Date.parse(a.uploaded_at || 0) || 0))
    .map((entry) => serializeSession(entry, false));
}

function getCheckImportSession(sessionId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }
  return serializeSession(session, true);
}

function isCheckImportSessionImported(session) {
  if (!session || typeof session !== "object") {
    return false;
  }
  const importedRowCount = Number(session.imported_row_count || session.successful_import_count || 0);
  return importedRowCount > 0 || ["imported", "imported_with_errors"].includes(String(session.final_status || ""));
}

function deleteCheckImportSession(sessionId) {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    throw new Error("Check import session not found.");
  }

  const sessions = readSessions();
  const session = sessions.find((entry) => entry.id === normalizedSessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }
  if (isCheckImportSessionImported(session)) {
    throw new Error("Imported sessions cannot be deleted from history.");
  }

  const remainingSessions = sessions.filter((entry) => entry.id !== normalizedSessionId);
  const remainingRows = readRows().filter((entry) => entry.session_id !== normalizedSessionId);
  writeRows(remainingRows);
  writeSessions(remainingSessions);

  return {
    deletedSessionId: normalizedSessionId,
    sessions: listCheckImportSessions(),
  };
}

async function createCheckImportSession({ fileName, base64Content, uploadedBy = DEFAULT_ACTOR, templateKey = IMPORT_TEMPLATE_KEY }) {
  if (!fileName || !base64Content) {
    throw new Error("Upload a CashPro ZIP first.");
  }

  const template = getCheckImportTemplate(templateKey);
  if (!template) {
    throw new Error("Import template not found.");
  }

  const parsed = parseCheckUploadRows(fileName, base64Content);
  if (!parsed.rows.length) {
    throw new Error("The uploaded file did not contain any check rows.");
  }

  const sessionId = createSessionId();
  const timestamp = new Date().toISOString();
  const session = {
    id: sessionId,
    original_filename: String(fileName || "").trim(),
    import_template_key: template.key,
    import_template_name: template.name,
    salesforce_object_api_name: template.salesforceObjectApiName,
    operation_type: template.operationType,
    uploaded_at: timestamp,
    updated_at: timestamp,
    uploaded_by: String(uploadedBy || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR,
    policy_lookup_refreshed_at: readPolicyCache().refreshedAt || null,
    status: "pending",
    row_count: parsed.rows.length,
    active_row_count: parsed.rows.length,
    ready_count: 0,
    error_count: 0,
    warning_count: 0,
    total_amount: 0,
    missing_certificate_count: 0,
    missing_policy_count: 0,
    discrepancy_count: 0,
    attempted_import_count: 0,
    successful_import_count: 0,
    salesforce_failed_row_count: 0,
    imported_row_count: 0,
    final_status: "pending_review",
    footer_transaction_count: parsed.meta.footerTransactionCount || parsed.meta.footerGrandTotalCount || null,
    footer_grand_total_amount: parsed.meta.footerGrandTotalAmount ?? null,
    footer_mismatch: false,
    validation_message: "Upload complete.",
  };

  const rows = parsed.rows.map((row) => buildImportRow(sessionId, row, parsed.meta));
  const allSessions = readSessions();
  const allRows = readRows();
  allSessions.unshift(session);
  allRows.push(...rows);
  writeSessions(allSessions);
  writeRows(allRows);
  await hydrateCheckImportSession(sessionId);
  return revalidateSession(sessionId);
}

async function hydrateCheckImportSession(sessionId) {
  const rows = readRows();
  const policyCacheState = readPolicyCache();
  const { byCertificate } = buildLookupMaps(policyCacheState);
  let didChange = false;

  for (const row of rows) {
    if (row.session_id !== sessionId || row.excluded) continue;
    const certificateNumber = normalizeCertificateNumber(row.corrected_certificate_number || row.certificate_number);
    const directSelection = selectPolicyEntryForCertificate({
      certificateNumber,
      entries: certificateNumber ? (byCertificate.get(certificateNumber.toLowerCase()) || []) : [],
    });
    const directPolicyEntry = directSelection.entry;
    if (directPolicyEntry?.certificate_record_id) {
      row.inferred_certificate_number = "";
      row.inferred_policy_id = "";
      row.inferred_policy_status = "";
      row.inferred_certificate_record_id = "";
      row.inferred_member_1_name = "";
      row.inferred_member_2_name = "";
      row.inferred_months = "";
      row.inferred_expected_amount = null;
      row.inferred_premium_comparison_label = "";
      row.inferred_match_source = "";
      row.inferred_p1 = null;
      row.inferred_p2 = null;
      row.inferred_p3 = null;
      row.inferred_p6 = null;
      row.inferred_p12 = null;
      continue;
    }

    if (directSelection.issue) {
      row.inferred_certificate_number = "";
      row.inferred_policy_id = "";
      row.inferred_policy_status = "";
      row.inferred_certificate_record_id = "";
      row.inferred_member_1_name = "";
      row.inferred_member_2_name = "";
      row.inferred_months = "";
      row.inferred_expected_amount = null;
      row.inferred_premium_comparison_label = "";
      row.inferred_match_source = "";
      row.inferred_p1 = null;
      row.inferred_p2 = null;
      row.inferred_p3 = null;
      row.inferred_p6 = null;
      row.inferred_p12 = null;
      continue;
    }

    const fallbackMatch = await findNameAmountMatchForRow(row);
    if (!fallbackMatch?.certificate_record_id) {
      row.inferred_certificate_number = "";
      row.inferred_policy_id = "";
      row.inferred_policy_status = "";
      row.inferred_certificate_record_id = "";
      row.inferred_member_1_name = "";
      row.inferred_member_2_name = "";
      row.inferred_months = "";
      row.inferred_expected_amount = null;
      row.inferred_premium_comparison_label = "";
      row.inferred_match_source = "";
      row.inferred_p1 = null;
      row.inferred_p2 = null;
      row.inferred_p3 = null;
      row.inferred_p6 = null;
      row.inferred_p12 = null;
      continue;
    }

    didChange = true;
    row.inferred_certificate_number = normalizeCertificateNumber(fallbackMatch.certificate_number);
    row.inferred_policy_id = normalizePolicyId(fallbackMatch.policy_id);
    row.inferred_policy_status = normalizePolicyStatus(fallbackMatch.policy_status);
    row.inferred_certificate_record_id = normalizeText(fallbackMatch.certificate_record_id);
    row.inferred_member_1_name = normalizeText(fallbackMatch.member_1_name);
    row.inferred_member_2_name = normalizeText(fallbackMatch.member_2_name);
    row.inferred_months = fallbackMatch.months !== "" ? String(fallbackMatch.months) : "";
    row.inferred_expected_amount = fallbackMatch.expected_amount ?? null;
    row.inferred_premium_comparison_label = normalizeText(fallbackMatch.comparison_label);
    row.inferred_match_source = fallbackMatch.exact
      ? `${fallbackMatch.matched_name_field || "member"} exact amount match`
      : `${fallbackMatch.matched_name_field || "member"} closest amount match`;
    row.inferred_p1 = fallbackMatch.p1 ?? null;
    row.inferred_p2 = fallbackMatch.p2 ?? null;
    row.inferred_p3 = fallbackMatch.p3 ?? null;
    row.inferred_p6 = fallbackMatch.p6 ?? null;
    row.inferred_p12 = fallbackMatch.p12 ?? null;

    logCheckImportEvent("Fallback certificate/month match found", {
      rowId: row.id,
      inferredCertificateNumber: row.inferred_certificate_number,
      inferredCertificateRecordId: row.inferred_certificate_record_id,
      inferredMonths: row.inferred_months,
      inferredMatchSource: row.inferred_match_source,
    });
  }

  if (didChange) {
    writeRows(rows);
  }
}

async function refreshCheckImportPolicyLookupFromSalesforce(sessionId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }

  const sessionCertificateNumbers = readRows()
    .filter((entry) => entry.session_id === sessionId)
    .map((entry) => normalizeCertificateNumber(entry.corrected_certificate_number || entry.certificate_number))
    .filter(Boolean);
  if (!sessionCertificateNumbers.length) {
    throw new Error("No certificate numbers were found in this check import session.");
  }

  const targetedPolicyEntries = await fetchPolicyDetailEntriesForCertificates(sessionCertificateNumbers);
  const certificateRecordIdMap = await fetchCertificateRecordIdsForCertificates(sessionCertificateNumbers);
  const certificateIdEntries = sessionCertificateNumbers.map((certificateNumber) => ({
    certificate_number: certificateNumber,
    certificate_record_id: normalizeText(certificateRecordIdMap.get(certificateNumber.toLowerCase()) || ""),
    refreshed_at: new Date().toISOString(),
    source_report_id: "Account.Name",
  }));
  const existingCache = readPolicyCache();

  const nextCache = {
    reportId: POLICY_REPORT_ID,
    refreshedAt: new Date().toISOString(),
    source: "policy-soql+certificate-soql",
    items: mergeLookupEntries(
      existingCache.items,
      targetedPolicyEntries,
      certificateIdEntries
    ),
  };

  writePolicyCache(nextCache);
  session.policy_lookup_refreshed_at = nextCache.refreshedAt;
  writeSessions(readSessions());
  await hydrateCheckImportSession(sessionId);
  return revalidateSession(sessionId);
}

function applyCheckImportRowUpdates(row, updates = {}) {
  const previousCorrectedCertificateNumber = normalizeCertificateNumber(row.corrected_certificate_number || row.certificate_number);
  if (Object.prototype.hasOwnProperty.call(updates, "certificate_number")) {
    row.corrected_certificate_number = normalizeCertificateNumber(updates.certificate_number);
    logCheckImportEvent("Manual Cert Number correction saved", {
      rowId: row.id,
      correctedCertNumber: row.corrected_certificate_number,
    });
  }
  if (Object.prototype.hasOwnProperty.call(updates, "months")) {
    const parsedMonths = Number(String(updates.months || "").trim());
    row.corrected_months = Number.isFinite(parsedMonths) && parsedMonths >= 0 ? String(parsedMonths) : "";
  } else if (
    Object.prototype.hasOwnProperty.call(updates, "certificate_number")
    && row.corrected_certificate_number !== previousCorrectedCertificateNumber
  ) {
    // When the certificate changes and months were not manually edited this save,
    // clear the override so the refreshed policy lookup can recompute months.
    row.corrected_months = "";
  }
  if (Object.prototype.hasOwnProperty.call(updates, "excluded")) {
    row.excluded = Boolean(updates.excluded);
    row.excluded_at = row.excluded ? new Date().toISOString() : "";
    row.excluded_by = row.excluded ? normalizeText(updates.corrected_by || DEFAULT_ACTOR) : "";
    logCheckImportEvent("Row excluded", {
      rowId: row.id,
      excluded: row.excluded,
    });
  }
  row.corrected_by = normalizeText(updates.corrected_by || DEFAULT_ACTOR);
  row.corrected_at = new Date().toISOString();
}

async function refreshManualCertificateLookup(certificateNumbers = []) {
  const normalizedCertificateNumbers = Array.from(
    new Set((certificateNumbers || []).map((entry) => normalizeCertificateNumber(entry)).filter(Boolean))
  );
  if (!normalizedCertificateNumbers.length) {
    return;
  }

  const targetedPolicyEntries = await fetchPolicyDetailEntriesForCertificates(normalizedCertificateNumbers);
  const certificateRecordIdMap = await fetchCertificateRecordIdsForCertificates(normalizedCertificateNumbers);
  const certificateIdEntries = normalizedCertificateNumbers.map((certificateNumber) => ({
    certificate_number: certificateNumber,
    certificate_record_id: normalizeText(certificateRecordIdMap.get(certificateNumber.toLowerCase()) || ""),
    refreshed_at: new Date().toISOString(),
    source_report_id: POLICY_REPORT_ID,
  }));
  const currentCache = readPolicyCache();
  const knownCertificatePolicyKeys = new Set(
    (currentCache.items || []).map((entry) =>
      `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`
    )
  );
  const nextCache = {
    ...currentCache,
    refreshedAt: new Date().toISOString(),
    source: "manual-certificate-refresh",
    items: mergeLookupEntries(
      currentCache.items,
      targetedPolicyEntries.filter((entry) =>
        knownCertificatePolicyKeys.has(
          `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`
        )
      ),
      certificateIdEntries
    ),
  };
  writePolicyCache(nextCache);
}

async function updateCheckImportRows(sessionId, rowUpdates = [], defaultCorrectedBy = DEFAULT_ACTOR) {
  const rows = readRows();
  const changedCertificateNumbers = [];

  rowUpdates.forEach((entry) => {
    const row = rows.find((candidate) => candidate.session_id === sessionId && candidate.id === entry?.id);
    if (!row) {
      throw new Error("Check import row not found.");
    }
    applyCheckImportRowUpdates(row, {
      ...entry,
      corrected_by: entry?.corrected_by || defaultCorrectedBy,
    });
    const correctedCertificateNumber = normalizeCertificateNumber(row.corrected_certificate_number || row.certificate_number);
    if (correctedCertificateNumber) {
      logCheckImportEvent("Certificate lookup started", {
        rowId: row.id,
        importedCertNumber: row.certificate_number || "",
        normalizedCertNumber: correctedCertificateNumber,
      });
      changedCertificateNumbers.push(correctedCertificateNumber);
    }
  });

  writeRows(rows);
  await refreshManualCertificateLookup(changedCertificateNumbers);
  await hydrateCheckImportSession(sessionId);
  return revalidateSession(sessionId);
}

async function updateCheckImportRow(sessionId, rowId, updates = {}) {
  return updateCheckImportRows(
    sessionId,
    [{ id: rowId, ...updates }],
    normalizeText(updates.corrected_by || DEFAULT_ACTOR)
  );
}

async function deleteCheckImportRows(sessionId, rowIds = []) {
  const normalizedSessionId = normalizeText(sessionId);
  const normalizedRowIds = Array.from(
    new Set((Array.isArray(rowIds) ? rowIds : []).map((entry) => normalizeText(entry)).filter(Boolean))
  );
  if (!normalizedSessionId) {
    throw new Error("Check import session not found.");
  }
  if (!normalizedRowIds.length) {
    throw new Error("Select at least one row to delete.");
  }

  const sessions = readSessions();
  const session = sessions.find((entry) => entry.id === normalizedSessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }
  if (isCheckImportSessionImported(session)) {
    throw new Error("Imported rows cannot be deleted from history.");
  }

  const rows = readRows();
  const sessionRowIds = new Set(
    rows
      .filter((entry) => entry.session_id === normalizedSessionId)
      .map((entry) => entry.id)
  );
  const missingRowId = normalizedRowIds.find((entry) => !sessionRowIds.has(entry));
  if (missingRowId) {
    throw new Error("Check import row not found.");
  }

  const remainingRows = rows.filter((entry) => {
    return !(entry.session_id === normalizedSessionId && normalizedRowIds.includes(entry.id));
  });
  writeRows(remainingRows);

  return revalidateSession(normalizedSessionId);
}

function buildCheckSalesforceRecord(row, template) {
  const salesforceRecord = {
    attributes: { type: template.salesforceObjectApiName },
    Certificate_Number__c: row.matched_policy_id || undefined,
    Date_Received__c: normalizeDateText(row.deposit_date),
    Amount_Received__c: normalizeAmount(row.check_amount),
    Months__c: Number.isFinite(Number(row.months)) ? Number(row.months) : undefined,
    Check__c: normalizeText(row.check_number) || undefined,
  };
  logCheckImportEvent("Export row created for TPA__c", {
    rowId: row.id,
    certificateLookupId: salesforceRecord.Certificate_Number__c || "",
    depositDate: salesforceRecord.Date_Received__c || "",
    amountReceived: salesforceRecord.Amount_Received__c,
    months: salesforceRecord.Months__c || "",
  });
  return salesforceRecord;
}

function validateImportableRow(row) {
  const issues = [];
  if (!normalizeText(row.matched_policy_id)) issues.push("Missing Certificate_Number__c lookup.");
  if (normalizeAmount(row.check_amount) === null) issues.push("Missing Amount_Received__c.");
  if (!normalizeDateText(row.deposit_date)) issues.push("Missing Date_Received__c.");
  if (String(row.months ?? "").trim() === "") issues.push("Missing Months__c.");
  return issues;
}

async function insertSalesforceRecords(tokenRecord, template, rows) {
  const response = await salesforceRequest(
    tokenRecord,
    "/services/data/v61.0/composite/sobjects",
    {
      method: "POST",
      body: JSON.stringify({
        allOrNone: false,
        records: rows.map((row) => buildCheckSalesforceRecord(row, template)),
      }),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload[0]?.message || payload.message || "Salesforce composite import failed.");
  }
  return payload;
}

async function confirmCheckImport(sessionId, { confirmedBy = DEFAULT_ACTOR } = {}) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Check import session not found.");
  }

  const template = getCheckImportTemplate(session.import_template_key || IMPORT_TEMPLATE_KEY);
  if (!template) {
    throw new Error("Import template not found.");
  }
  session.import_template_name = template.name;
  session.salesforce_object_api_name = template.salesforceObjectApiName;
  session.operation_type = template.operationType;

  if (session.footer_mismatch) {
    throw new Error("Footer totals do not match the parsed check rows.");
  }

  const rows = readRows();
  const sessionRows = rows
    .filter((entry) => entry.session_id === sessionId && !entry.excluded)
    .sort((a, b) => Number(a.row_number || 0) - Number(b.row_number || 0));

  const importableRows = [];
  sessionRows.forEach((row) => {
    row.import_result_status = "";
    row.import_result_message = "";
    row.imported_salesforce_id = "";
    row.imported_salesforce_created = false;
    const blockingIssues = validateImportableRow(row);
    if (row.status === "error" || blockingIssues.length) {
      row.import_result_status = "validation_failed";
      row.import_result_message = blockingIssues.join(" ") || row.issue_reason || "Row failed validation.";
      return;
    }
    importableRows.push(row);
  });

  if (!importableRows.length) {
    writeRows(rows);
    session.attempted_import_count = 0;
    session.successful_import_count = 0;
    session.salesforce_failed_row_count = 0;
    session.import_confirmed_at = new Date().toISOString();
    session.import_confirmed_by = normalizeText(confirmedBy || DEFAULT_ACTOR);
    session.final_status = "validation_failed";
    writeSessions(readSessions());
    return revalidateSession(sessionId);
  }

  const tokenRecord = await getConnectedSalesforceToken();
  let successfulRows = 0;
  let failedRows = 0;

  for (let startIndex = 0; startIndex < importableRows.length; startIndex += IMPORT_BATCH_SIZE) {
    const batchRows = importableRows.slice(startIndex, startIndex + IMPORT_BATCH_SIZE);
    const payload = await insertSalesforceRecords(tokenRecord, template, batchRows);
    const results = Array.isArray(payload) ? payload : Array.isArray(payload.results) ? payload.results : [];

    batchRows.forEach((row, rowIndex) => {
      const result = results[rowIndex] || {};
      const errors = Array.isArray(result.errors)
        ? result.errors.map((entry) => entry.message || entry.statusCode || String(entry)).filter(Boolean)
        : [];
      if (result.success) {
        row.import_result_status = "imported";
        row.import_result_message = result.created ? "Inserted into Salesforce." : "Updated in Salesforce.";
        row.imported_salesforce_id = normalizeText(result.id);
        row.imported_salesforce_created = Boolean(result.created);
        successfulRows += 1;
      } else {
        row.import_result_status = "salesforce_failed";
        row.import_result_message = errors.join(" | ") || "Salesforce rejected this row.";
        failedRows += 1;
      }
    });
  }

  writeRows(rows);
  session.attempted_import_count = importableRows.length;
  session.successful_import_count = successfulRows;
  session.salesforce_failed_row_count = failedRows;
  session.imported_row_count = successfulRows;
  session.import_confirmed_at = new Date().toISOString();
  session.import_completed_at = new Date().toISOString();
  session.import_confirmed_by = normalizeText(confirmedBy || DEFAULT_ACTOR);
  session.final_status = failedRows > 0 ? "imported_with_errors" : "imported";
  session.updated_at = new Date().toISOString();
  writeSessions(readSessions());
  return revalidateSession(sessionId);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function exportCheckImportErrors(sessionId) {
  const session = getCheckImportSession(sessionId);
  const rows = (session.rows || []).filter((row) => ["error", "warning"].includes(String(row.status || "")));
  const headers = [
    "Status",
    "Deposit Date",
    "Cert Number",
    "Certificate Record ID",
    "Check Amount",
    "Remitter Name",
    "Check Number",
    "Transaction ID",
    "Member 1",
    "Member 2",
    "No Of Months",
    "Issue Reason",
  ];
  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => [
      row.status,
      row.deposit_date,
      row.certificate_number,
      row.matched_certificate_record_id,
      row.check_amount,
      row.remitter_name,
      row.check_number,
      row.transaction_id,
      row.member_1_name,
      row.member_2_name,
      row.months,
      row.issue_reason,
    ].map(csvEscape).join(",")),
  ].join("\r\n");

  const fileName = `check-import-rejections-${sessionId}.csv`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(filePath, csv, "utf8");
  return {
    fileName,
    filePath,
    contentType: "text/csv; charset=utf-8",
  };
}

module.exports = {
  __setCheckImportStateForTests,
  POLICY_REPORT_ID,
  PREMIUM_REPORT_ID,
  confirmCheckImport,
  createCheckImportSession,
  deleteCheckImportRows,
  deleteCheckImportSession,
  exportCheckImportErrors,
  getCheckImportSession,
  initializeCheckImportPersistence,
  listCheckImportSessions,
  listCheckImportTemplates,
  refreshCheckImportPolicyLookupFromSalesforce,
  revalidateSession,
  updateCheckImportRow,
  updateCheckImportRows,
};
