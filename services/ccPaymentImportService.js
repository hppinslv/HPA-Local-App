const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  executeReportWithDescribeMetadata,
  fetchReportDescribe,
  fetchRawSalesforceReportRows,
  getConnectedSalesforceToken,
  normalizeLabel,
  runSoqlQuery,
  salesforceRequest,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_PATH = path.join(DATA_DIR, "cc-payment-import-sessions.json");
const ROW_PATH = path.join(DATA_DIR, "cc-payment-import-rows.json");
const POLICY_CACHE_PATH = path.join(DATA_DIR, "cc-payment-policy-lookup-cache.json");
const SESSION_SUPABASE_KEY = "cc-payment-import-sessions.json";
const ROW_SUPABASE_KEY = "cc-payment-import-rows.json";
const POLICY_CACHE_SUPABASE_KEY = "cc-payment-policy-lookup-cache.json";
const EXPORT_DIR = path.join(os.tmpdir(), "hpa-cc-payment-import-exports");
const POLICY_REPORT_ID = "00OQm0000016PuPMAU";
const PREMIUM_REPORT_ID = "00OQm000003Q6cjMAC";
const DEFAULT_ACTOR = "Local User";
const IMPORT_TEMPLATE_KEY = "credit-card-payments";
const IMPORT_BATCH_SIZE = 200;
const ACTIVE_POLICY_STATUSES = new Set(["in force", "payment issues", "follow up"]);
const ACTIVE_POLICY_STATUS_LABEL = "In Force, Payment Issues, or Follow Up";

const IMPORT_TEMPLATES = [
  {
    key: IMPORT_TEMPLATE_KEY,
    name: "Credit Card Payment Import",
    importType: "credit-card-payments",
    salesforceObjectApiName: "Payments__c",
    operationType: "insert",
    externalIdField: "",
    active: true,
    uploadedFileColumnNames: [
      "RecordID",
      "TransactionID",
      "BatchID",
      "AuthCode",
      "TransactionDate",
      "BatchCloseDate",
      "Amount",
      "BillType",
      "ID1",
      "ID2",
      "ID3",
      "PaymentAccount",
      "TransactionType",
      "ReversalCode",
      "ReversalCodeDescription",
      "PaymentMethod",
    ],
    salesforceFieldApiNames: [
      "Name",
      "Policy__c",
      "Certificate__c",
      "Payments_For_Certificate__c",
      "Amount_Received__c",
      "Auth_Amount__c",
      "Date_Received__c",
      "Txn_Date_Time__c",
      "Months_Pay__c",
      "Auth_Code__c",
      "Manual_Payment__c",
      "Pay_Type__c",
      "Type_Received__c",
    ],
    requiredFields: [
      "Policy__c",
      "Certificate__c",
      "Payments_For_Certificate__c",
      "Amount_Received__c",
      "Date_Received__c",
      "Months_Pay__c",
      "Name",
    ],
    defaultValues: {
      Manual_Payment__c: "Yes",
      Pay_Type__c: "3",
      Type_Received__c: "2",
    },
    lookupRules: [
      "Resolve Policy__c from certificate number.",
      "Resolve Certificate__c and Payments_For_Certificate__c from the related certificate account.",
      "If the certificate number is wrong, try Member 1 or Member 2 name plus matching premium amount.",
    ],
    validationRules: [
      "Require certificate number, policy lookup, certificate lookup, amount, transaction date, transaction id, and supported month count.",
      "Flag duplicate uploaded transactions and duplicates already in import history.",
      "Flag amount mismatches against expected P1/P2/P3/P6/P12 premium values.",
    ],
    transformRules: [
      "Map uploaded Amount to Amount_Received__c and Auth_Amount__c.",
      "Map uploaded TransactionDate to Txn_Date_Time__c and Date_Received__c.",
      "Derive Months_Pay__c from ID3.",
      "Build Payment Name from certificate, payment account, and received date.",
    ],
  },
];

let sessionCache = null;
let rowCache = null;
let policyCache = null;
let sessionDiskWritable = true;
let rowDiskWritable = true;
let policyCacheDiskWritable = true;

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
  return normalizeText(value);
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

function buildPolicyStatusLookupValue(row, labels) {
  for (const label of labels) {
    if (row[label] !== undefined && String(row[label]).trim() !== "") {
      return row[label];
    }
    const normalizedCandidate = normalizeLabel(label);
    const key = Object.keys(row).find((entry) => normalizeLabel(entry) === normalizedCandidate);
    if (key && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return "";
}

function describePolicyStatus(value) {
  const status = normalizePolicyStatus(value);
  return status || "unknown";
}

function buildPolicyEntriesByCertificateMap(cache) {
  const map = new Map();
  (cache?.items || []).forEach((entry) => {
    const certificateNumber = normalizeCertificateNumber(entry.certificate_number).toLowerCase();
    const policyId = normalizePolicyId(entry.policy_id);
    if (!certificateNumber || !policyId) return;
    const entries = map.get(certificateNumber) || [];
    entries.push(entry);
    map.set(certificateNumber, entries);
  });
  return map;
}

function selectPolicyEntryForCertificate({ certificateNumber, entries = [], preferredPolicyId = "" } = {}) {
  const normalizedCertificate = normalizeCertificateNumber(certificateNumber);
  const normalizedPreferredPolicyId = normalizePolicyId(preferredPolicyId).toLowerCase();
  const uniqueEntries = Array.from(
    new Map(
      (entries || [])
        .filter((entry) => normalizePolicyId(entry?.policy_id))
        .map((entry) => [normalizePolicyId(entry.policy_id).toLowerCase(), entry])
    ).values()
  );
  const activeEntries = uniqueEntries.filter((entry) => isActivePolicyStatus(entry.policy_status));

  if (normalizedPreferredPolicyId) {
    const preferredEntry = uniqueEntries.find(
      (entry) => normalizePolicyId(entry.policy_id).toLowerCase() === normalizedPreferredPolicyId
    );
    if (!preferredEntry) {
      return {
        entry: null,
        issue: {
          severity: "error",
          code: "manual_policy_not_found",
          message: `Policy ${preferredPolicyId} does not belong to certificate ${normalizedCertificate}.`,
        },
      };
    }
    if (!isActivePolicyStatus(preferredEntry.policy_status)) {
      return {
        entry: null,
        issue: {
          severity: "error",
          code: "policy_not_active_for_import",
          message: `Policy ${preferredEntry.policy_id} for certificate ${normalizedCertificate} is ${describePolicyStatus(preferredEntry.policy_status)}. Only ${ACTIVE_POLICY_STATUS_LABEL} policies can be imported.`,
        },
      };
    }
    return { entry: preferredEntry, issue: null };
  }

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

function normalizePersonName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function formatDateReceived(value) {
  const iso = normalizeDateText(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

function extractLeadingMonths(value) {
  const match = String(value || "").trim().match(/^(\d+)/);
  return match ? Number(match[1]) : "";
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "";
  }
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

function getPremiumFieldForMonths(months) {
  const numericMonths = Number(months);
  if (numericMonths === 1) return "p1";
  if (numericMonths === 2) return "p2";
  if (numericMonths === 3) return "p3";
  if (numericMonths === 6) return "p6";
  if (numericMonths === 12) return "p12";
  return "";
}

function getPremiumLabelForMonths(months) {
  const numericMonths = Number(months);
  if (numericMonths === 1) return "P1";
  if (numericMonths === 2) return "P2";
  if (numericMonths === 3) return "P3";
  if (numericMonths === 6) return "P6";
  if (numericMonths === 12) return "P12";
  return `${numericMonths || ""} month`;
}

function getExpectedPremiumAmount(entry, months) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const field = getPremiumFieldForMonths(months);
  if (!field) {
    return null;
  }
  const value = Number(entry[field]);
  return Number.isFinite(value) ? value : null;
}

function isSameAmount(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

function createSessionId() {
  return `cc_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRowId(sessionId, rowNumber) {
  return `${sessionId}_row_${rowNumber}`;
}

function getCcPaymentImportTemplate(templateKey = IMPORT_TEMPLATE_KEY) {
  const normalizedKey = String(templateKey || IMPORT_TEMPLATE_KEY).trim();
  return IMPORT_TEMPLATES.find((entry) => entry.key === normalizedKey && entry.active) || null;
}

function listCcPaymentImportTemplates() {
  return IMPORT_TEMPLATES.filter((entry) => entry.active).map((entry) => clone(entry));
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

  return result.stdout;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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
      if (!cellRef) continue;

      const column = cellRef[1];
      const rowNumber = Number(cellRef[2]);
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

      if (!rows[rowNumber]) {
        rows[rowNumber] = {};
      }
      rows[rowNumber][column] = String(value).trim();
      if (rowNumber > maxRow) {
        maxRow = rowNumber;
      }
    }
  }

  return Array.from({ length: maxRow }, (_, index) => rows[index + 1] || {}).map((row, index) => ({
    index: index + 1,
    cells: row || {},
  }));
}

function parseXlsxWorksheets(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-cc-import-upload-"));
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
        const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${entry.relId}"[^>]*Target="([^"]+)"`));
        if (!relMatch) {
          return null;
        }
        const worksheetPath = path.join(extractDir, "xl", relMatch[1].replace(/\//g, path.sep));
        if (!fs.existsSync(worksheetPath)) {
          return null;
        }
        return {
          name: entry.name,
          xml: fs.readFileSync(worksheetPath, "utf8"),
          sharedStrings,
        };
      })
      .filter(Boolean);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

  return rows
    .filter((entry) => entry.some((value) => String(value || "").trim() !== ""))
    .map((entry) => entry.map((value) => String(value || "").trim()));
}

function rowsToObjects(csvRows) {
  const [headers = [], ...dataRows] = csvRows;
  return dataRows.map((values, index) => {
    const output = { __rowNumber: index + 2 };
    headers.forEach((header, headerIndex) => {
      output[String(header || "").trim()] = values[headerIndex] ?? "";
    });
    return output;
  });
}

function worksheetRowsToObjects(worksheetRows) {
  if (!Array.isArray(worksheetRows) || !worksheetRows.length) {
    return [];
  }

  const maxColumnFromLetter = (column) =>
    [...String(column || "").toUpperCase()].reduce(
      (acc, char) => acc * 26 + (char.charCodeAt(0) - 64),
      0
    );

  const headerRow = worksheetRows.find((row) => Object.keys(row.cells || {}).length > 0);
  if (!headerRow) {
    return [];
  }

  const orderedColumns = Object.keys(headerRow.cells || {}).sort(
    (a, b) => maxColumnFromLetter(a) - maxColumnFromLetter(b)
  );
  const headers = orderedColumns.map((column) => String(headerRow.cells[column] || "").trim());

  return worksheetRows
    .filter((row) => row.index > headerRow.index)
    .map((row) => {
      const output = { __rowNumber: row.index };
      headers.forEach((header, headerIndex) => {
        if (!header) {
          return;
        }
        const column = orderedColumns[headerIndex];
        output[header] = row.cells?.[column] ?? "";
      });
      return output;
    })
    .filter((row) =>
      Object.entries(row).some(
        ([key, value]) => key !== "__rowNumber" && String(value || "").trim() !== ""
      )
    );
}

function parsePaymentUploadRows(fileName, base64Content) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const buffer = Buffer.from(String(base64Content || ""), "base64");

  if (extension === ".csv" || extension === ".txt") {
    return rowsToObjects(parseCsv(buffer.toString("utf8")));
  }

  if (extension === ".xlsx" || extension === ".xlsm") {
    const worksheets = parseXlsxWorksheets(buffer);
    if (!worksheets.length) {
      return [];
    }
    return worksheetRowsToObjects(parseWorksheetRows(worksheets[0].xml, worksheets[0].sharedStrings));
  }

  throw new Error("Credit card payment imports currently support CSV and XLSX uploads.");
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
      console.warn("Unable to persist CC payment sessions to disk, switching to in-memory mode:", error.message);
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
      console.warn("Unable to persist CC payment rows to disk, switching to in-memory mode:", error.message);
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
      console.warn("Unable to persist CC payment policy cache to disk, switching to in-memory mode:", error.message);
    }
    policyCacheDiskWritable = false;
  }
}

async function initializeCcPaymentImportPersistence() {
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

function __setCcPaymentImportStateForTests({ sessions = [], rows = [], policyCache: nextPolicyCache = null } = {}) {
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

function findValueByLabels(row, labels, options = {}) {
  const preferLabel = Boolean(options.preferLabel);

  const getPreferredValue = (matchedKey) => {
    if (!matchedKey) {
      return "";
    }

    if (preferLabel) {
      const labelCandidates = [
        `${matchedKey}__label`,
        `${matchedKey} label`,
      ];
      const labelKey = labelCandidates.find((entry) => row[entry] !== undefined && String(row[entry]).trim() !== "");
      if (labelKey) {
        return row[labelKey];
      }
    }

    return row[matchedKey];
  };

  for (const label of labels) {
    const direct = row[label];
    if (direct !== undefined && String(direct).trim() !== "") {
      return getPreferredValue(label);
    }
    const normalizedCandidate = normalizeLabel(label);
    const key = Object.keys(row).find((entry) => normalizeLabel(entry) === normalizedCandidate);
    if (key && String(row[key]).trim() !== "") {
      return getPreferredValue(key);
    }
  }
  return "";
}

function buildPolicyLookupEntriesFromRows(rows) {
  const entries = [];
  const seen = new Set();

  rows.forEach((row) => {
    const certificateNumber = normalizeCertificateNumber(
      findValueByLabels(row, [
        "Certificate: Certificate Name",
        "Certificate Name",
        "Certificate",
        "Certificate Number",
        "ID1",
      ], { preferLabel: true })
    );
    const policyId = normalizePolicyId(
      findValueByLabels(row, [
        "Policy ID",
        "Certificate Record ID",
        "Policy",
        "Policy Id",
      ])
    );
    if (!certificateNumber || !policyId) {
      return;
    }
    const key = `${certificateNumber.toLowerCase()}::${policyId.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({
      certificate_number: certificateNumber,
      policy_id: policyId,
      certificate_record_id: normalizeText(
        findValueByLabels(row, [
          "Certificate: Certificate Name",
          "Certificate Record ID",
          "Certificate ID",
        ])
      ),
      p1: null,
      p2: null,
      p3: null,
      p6: null,
      p12: null,
      member_1_name: "",
      member_2_name: "",
      policy_status: normalizePolicyStatus(
        buildPolicyStatusLookupValue(row, [
          "Policy Status",
          "Policy: Policy Status",
          "Policy: Status",
          "Status",
        ])
      ),
      refreshed_at: new Date().toISOString(),
      source_report_id: POLICY_REPORT_ID,
    });
  });

  return entries;
}

function buildPremiumLookupEntriesFromRows(rows) {
  const entries = [];
  const seen = new Set();

  (rows || []).forEach((row) => {
    const certificateNumber = normalizeCertificateNumber(
      findValueByLabels(
        row,
        [
          "Certificate: Certificate Name",
          "Certificate Name",
          "Certificate",
          "Certificate Number",
          "ID1",
        ],
        { preferLabel: true }
      )
    );
    const policyId = normalizePolicyId(
      findValueByLabels(row, ["Policy ID", "Certificate Record ID", "Policy", "Policy Id"])
    );
    if (!certificateNumber || !policyId) {
      return;
    }
    const key = `${certificateNumber.toLowerCase()}::${policyId.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({
      certificate_number: certificateNumber,
      policy_id: policyId,
      certificate_record_id: normalizeText(
        findValueByLabels(
          row,
          [
            "Certificate: Certificate Name",
            "Certificate Record ID",
            "Certificate ID",
          ]
        )
      ),
      p1: normalizeAmount(findValueByLabels(row, ["P1"])),
      p2: normalizeAmount(findValueByLabels(row, ["P2"])),
      p3: normalizeAmount(findValueByLabels(row, ["P3"])),
      p6: normalizeAmount(findValueByLabels(row, ["P6"])),
      p12: normalizeAmount(findValueByLabels(row, ["P12"])),
      member_1_name: normalizeText(findValueByLabels(row, ["Member 1", "Member 1 Name"])),
      member_2_name: normalizeText(findValueByLabels(row, ["Member 2", "Member 2 Name"])),
      policy_status: normalizePolicyStatus(
        buildPolicyStatusLookupValue(row, [
          "Policy Status",
          "Policy: Policy Status",
          "Policy: Status",
          "Status",
        ])
      ),
      refreshed_at: new Date().toISOString(),
      source_report_id: PREMIUM_REPORT_ID,
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

async function fetchPolicyLookupEntriesForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(
    new Set(
      (certificateNumbers || [])
        .map((entry) => normalizeCertificateNumber(entry))
        .filter(Boolean)
    )
  );

  if (!uniqueCertificates.length) {
    return [];
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const describePayload = await fetchReportDescribe(tokenRecord, POLICY_REPORT_ID);
  const baseMetadata = describePayload.reportMetadata || {};
  const entries = [];
  const seen = new Set();

  for (const certificateNumber of uniqueCertificates) {
    const metadata = {
      ...baseMetadata,
      reportFilters: [
        ...(Array.isArray(baseMetadata.reportFilters) ? baseMetadata.reportFilters : []),
        {
          column: "Policy__c.Account__c.Name",
          operator: "equals",
          value: certificateNumber,
          isRunPageEditable: true,
        },
      ],
    };

    const { reportPayload } = await executeReportWithDescribeMetadata(
      tokenRecord,
      POLICY_REPORT_ID,
      metadata,
      describePayload
    );
    const reportRows = Array.isArray(reportPayload?.factMap?.["T!T"]?.rows)
      ? reportPayload.factMap["T!T"].rows
      : [];
    const normalizedRows = reportRows.map((row) => ({
      "Certificate: Certificate Name": row.dataCells?.[0]?.value ?? "",
      "Certificate: Certificate Name__label": row.dataCells?.[0]?.label ?? "",
      "Policy ID": row.dataCells?.[1]?.value ?? "",
      "Policy ID__label": row.dataCells?.[1]?.label ?? "",
    }));

    buildPolicyLookupEntriesFromRows(normalizedRows).forEach((entry) => {
      const key = `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`;
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      entries.push(entry);
    });
  }

  return entries;
}

async function refreshPolicyLookupFromSalesforce() {
  const report = await fetchRawSalesforceReportRows(POLICY_REPORT_ID);
  const reportRows = Array.isArray(report.rows) ? report.rows : [];
  const items = buildPolicyLookupEntriesFromRows(reportRows);
  if (!items.length) {
    throw new Error("The Salesforce policy lookup report returned no certificate-to-policy matches.");
  }
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
  return buildPremiumLookupEntriesFromRows(reportRows);
}

async function fetchPolicyDetailEntriesForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(
    new Set(
      (certificateNumbers || [])
        .map((entry) => normalizeCertificateNumber(entry))
        .filter(Boolean)
    )
  );

  if (!uniqueCertificates.length) {
    return [];
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const soql = `
SELECT Id, Account__c, Account__r.Name, Member_1_Name__c, Member_2_Name__c, Member_1_Contact_Id__r.Name, Member_2_Contact_Id__r.Name, P1__c, P2__c, P3__c, P6__c, P12__c
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
    policy_status: "",
    refreshed_at: new Date().toISOString(),
    source_report_id: PREMIUM_REPORT_ID,
  }));
}

async function fetchCertificateRecordIdsForCertificates(certificateNumbers = []) {
  const uniqueCertificates = Array.from(
    new Set(
      (certificateNumbers || [])
        .map((entry) => normalizeCertificateNumber(entry))
        .filter(Boolean)
    )
  );

  if (!uniqueCertificates.length) {
    return new Map();
  }

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
  const paymentAmount = normalizeAmount(row.amount);
  const premiumField = getPremiumFieldForMonths(row.months);
  if (!Number.isFinite(paymentAmount) || !premiumField) {
    return null;
  }

  const nameCandidates = Array.from(
    new Set(
      [
        row.payor_name,
        row.customer_name,
        row.raw_json?.ID2,
      ]
        .map((entry) => normalizeText(entry))
        .filter(Boolean)
    )
  );

  if (!nameCandidates.length) {
    return null;
  }

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
    ]
    .map((fieldName) => `${fieldName} IN (${escapedNames})`)
    .join(" OR ")})
AND ${premiumField.toUpperCase()}__c = ${paymentAmount.toFixed(2)}
`.trim();
  const records = await runSoqlQuery(tokenRecord, soql);

  const normalizedCandidates = new Set(nameCandidates.map((entry) => normalizePersonName(entry)));
  const matches = records
    .map((record) => {
      const member1Name = normalizeText(record.Member_1_Name__c || record.Member_1_Contact_Id__r?.Name);
      const member2Name = normalizeText(record.Member_2_Name__c || record.Member_2_Contact_Id__r?.Name);
      const member1Normalized = normalizePersonName(member1Name);
      const member2Normalized = normalizePersonName(member2Name);
      const matchedField = normalizedCandidates.has(member1Normalized)
        ? "Member 1"
        : normalizedCandidates.has(member2Normalized)
          ? "Member 2"
          : "";
      const expectedAmount = normalizeAmount(record[`${premiumField.toUpperCase()}__c`]);
      return {
        certificate_number: normalizeCertificateNumber(record.Account__r?.Name),
        policy_id: normalizePolicyId(record.Id),
        certificate_record_id: normalizeText(record.Account__c),
        member_1_name: member1Name,
        member_2_name: member2Name,
        matched_name_field: matchedField,
        expected_amount: expectedAmount,
        policy_status: "",
      };
    })
    .filter((entry) => entry.matched_name_field && isSameAmount(entry.expected_amount, paymentAmount));

  if (matches.length === 1) {
    return {
      ...matches[0],
      match_count: 1,
    };
  }

  if (matches.length > 1) {
    return {
      certificate_number: "",
      policy_id: "",
      member_1_name: "",
      member_2_name: "",
      matched_name_field: "Multiple",
      expected_amount: paymentAmount,
      match_count: matches.length,
      candidate_certificates: matches.map((entry) => entry.certificate_number).filter(Boolean),
    };
  }

  return null;
}

async function enrichSessionRowsForPremiumReview(sessionId, policyCacheState, certificateRecordIdMap = new Map()) {
  const rows = readRows();
  const sessionRows = rows.filter((entry) => entry.session_id === sessionId);
  const premiumEntriesByCertificate = buildPolicyEntriesByCertificateMap(policyCacheState);

  for (const row of sessionRows) {
    const certificateNumber = normalizeCertificateNumber(row.certificate_number);
    const certificateKey = certificateNumber.toLowerCase();
    if (!normalizeText(row.matched_certificate_record_id)) {
      row.matched_certificate_record_id = normalizeText(certificateRecordIdMap.get(certificateKey) || "");
    }
    row.name_amount_match_note = "";
    row.suggested_policy_id = "";
    row.suggested_certificate_number = "";

    const premiumEntry = selectPolicyEntryForCertificate({
      certificateNumber,
      entries: premiumEntriesByCertificate.get(certificateKey) || [],
      preferredPolicyId: normalizePolicyId(row.manual_policy_id),
    }).entry;
    const expectedAmount = getExpectedPremiumAmount(premiumEntry, row.months);
    const paymentAmount = normalizeAmount(row.amount);
    const shouldLookByName =
      !premiumEntry ||
      (Number.isFinite(paymentAmount) && Number.isFinite(expectedAmount) && !isSameAmount(paymentAmount, expectedAmount));

    if (!shouldLookByName) {
      continue;
    }

    const nameAmountMatch = await findNameAmountMatchForRow(row);
    if (!nameAmountMatch) {
      continue;
    }

    if (nameAmountMatch.match_count > 1) {
      row.name_amount_match_note = `Multiple name and payment matches found (${nameAmountMatch.match_count}) for ${formatCurrency(paymentAmount)}.`;
      continue;
    }

    row.suggested_policy_id = nameAmountMatch.policy_id;
    row.suggested_certificate_number = nameAmountMatch.certificate_number;
    row.name_amount_match_note =
      `Name and payment match found on ${nameAmountMatch.matched_name_field}: certificate ${nameAmountMatch.certificate_number}, policy ${nameAmountMatch.policy_id}.`;
  }

  writeRows(rows);
}

function refreshPolicyLookupFromCsv(fileName, base64Content) {
  const text = Buffer.from(String(base64Content || ""), "base64").toString("utf8");
  const rows = rowsToObjects(parseCsv(text));
  const items = buildPolicyLookupEntriesFromRows(rows);
  if (!items.length) {
    throw new Error("The uploaded policy lookup file did not contain Certificate and Policy ID columns.");
  }
  const nextCache = {
    reportId: POLICY_REPORT_ID,
    refreshedAt: new Date().toISOString(),
    source: fileName || "uploaded-policy-lookup.csv",
    items,
  };
  writePolicyCache(nextCache);
  return nextCache;
}

function buildPolicyLookupByPolicyIdMap(cache) {
  const map = new Map();
  (cache?.items || []).forEach((entry) => {
    const policyId = normalizePolicyId(entry.policy_id);
    if (!policyId) {
      return;
    }
    map.set(policyId.toLowerCase(), entry);
  });
  return map;
}

function buildPolicyLookupByCertificateRecordIdMap(cache) {
  const map = new Map();
  (cache?.items || []).forEach((entry) => {
    const certificateRecordId = normalizeText(entry.certificate_record_id);
    if (!certificateRecordId) {
      return;
    }
    map.set(certificateRecordId.toLowerCase(), entry);
  });
  return map;
}

function buildPaymentName(row) {
  const certificateNumber = normalizeCertificateNumber(row.certificate_number);
  const paymentAccount = normalizeText(row.payment_account);
  const dateReceived = formatDateReceived(row.transaction_date);
  return `${certificateNumber} - Online CC - ${paymentAccount} - ${dateReceived}`.trim();
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

function buildRowStatus(issues) {
  if (issues.some((issue) => issue.severity === "error")) {
    return "error";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "warning";
  }
  return "ready";
}

function buildSessionStatus(counts) {
  if (counts.errorCount > 0) return "needs_attention";
  if (counts.readyCount === 0 && counts.rowCount > 0) return "pending";
  if (counts.exportedAt) return "exported";
  return "ready";
}

function revalidateSession(sessionId) {
  const sessions = readSessions();
  const rows = readRows();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  const sessionRows = rows.filter((entry) => entry.session_id === sessionId);
  const transactionCounts = new Map();
  sessionRows.forEach((row) => {
    const transactionId = normalizeText(row.transaction_id).toLowerCase();
    if (!transactionId) return;
    transactionCounts.set(transactionId, (transactionCounts.get(transactionId) || 0) + 1);
  });
  const priorTransactions = duplicateHistoryMap(sessionId);
  const policyCacheState = readPolicyCache();
  const policyEntriesByCertificate = buildPolicyEntriesByCertificateMap(policyCacheState);
  const policyLookupByIdMap = buildPolicyLookupByPolicyIdMap(policyCacheState);

  let readyCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let missingPolicyCount = 0;

  sessionRows.forEach((row) => {
    const certificateNumber = normalizeCertificateNumber(row.certificate_number);
    const amountValue = normalizeAmount(row.amount);
    const manualPolicyId = normalizePolicyId(row.manual_policy_id);
    const certificateEntries = certificateNumber
      ? (policyEntriesByCertificate.get(certificateNumber.toLowerCase()) || [])
      : [];
    const manualPolicyEntry = manualPolicyId
      ? (policyLookupByIdMap.get(manualPolicyId.toLowerCase()) || null)
      : null;
    const policySelection = selectPolicyEntryForCertificate({
      certificateNumber,
      entries: certificateEntries,
      preferredPolicyId: manualPolicyId,
    });
    const policyEntry = policySelection.entry;
    const matchedPolicyId = normalizePolicyId(policyEntry?.policy_id || "");
    const matchedCertificateRecordId = normalizeText(policyEntry?.certificate_record_id || "");
    const expectedAmount = getExpectedPremiumAmount(policyEntry, row.months);
    const premiumLabel = getPremiumLabelForMonths(row.months);
    const issues = [];

    if (!certificateNumber) {
      issues.push({ severity: "error", code: "missing_certificate_number", message: "Missing certificate number / ID1." });
    }

    if (manualPolicyId && manualPolicyEntry && certificateNumber) {
      const manualCertificateNumber = normalizeCertificateNumber(manualPolicyEntry.certificate_number);
      if (manualCertificateNumber && manualCertificateNumber.toLowerCase() !== certificateNumber.toLowerCase()) {
        issues.push({
          severity: "error",
          code: "manual_policy_certificate_mismatch",
          message: `Policy ${manualPolicyId} belongs to certificate ${manualCertificateNumber}, not ${certificateNumber}.`,
        });
      }
    }

    if (policySelection.issue) {
      issues.push(policySelection.issue);
    }

    if (!matchedPolicyId) {
      if (!policySelection.issue) {
        issues.push({
          severity: "error",
          code: "missing_policy_id",
          message: certificateNumber
            ? `Certificate ${certificateNumber} was not found on report ${POLICY_REPORT_ID}.`
            : "Missing Policy ID.",
        });
      }
      missingPolicyCount += 1;
    }

    if (!matchedCertificateRecordId) {
      issues.push({ severity: "error", code: "missing_certificate_record_id", message: "Missing Certificate record lookup." });
    }

    if (normalizeText(row.amount) === "") {
      issues.push({ severity: "error", code: "missing_amount", message: "Missing Amount." });
    } else if (amountValue === null) {
      issues.push({ severity: "error", code: "invalid_amount", message: "Invalid Amount." });
    } else if (Number.isFinite(expectedAmount) && !isSameAmount(amountValue, expectedAmount)) {
      issues.push({
        severity: "warning",
        code: "payment_amount_mismatch",
        message: `Payment amount ${formatCurrency(amountValue)} does not match expected ${premiumLabel} premium ${formatCurrency(expectedAmount)} for certificate ${certificateNumber || "this policy"}.`,
      });
    }

    if (!normalizeDateText(row.transaction_date)) {
      issues.push({ severity: "error", code: "missing_transaction_date", message: "Missing TransactionDate." });
    }

    const transactionId = normalizeText(row.transaction_id);
    if (!transactionId) {
      issues.push({ severity: "error", code: "missing_transaction_id", message: "Missing TransactionID." });
    } else {
      if ((transactionCounts.get(transactionId.toLowerCase()) || 0) > 1) {
        issues.push({ severity: "error", code: "duplicate_transaction_in_file", message: "Duplicate TransactionID in uploaded file." });
      }
      if (priorTransactions.has(transactionId.toLowerCase())) {
        issues.push({ severity: "error", code: "duplicate_transaction_in_history", message: "Duplicate TransactionID already exists in import history." });
      }
    }

    const reversalText = `${row.transaction_type || ""} ${row.reversal_code || ""} ${row.reversal_code_description || ""}`.toLowerCase();
    if (/(reversal|refund|void)/.test(reversalText)) {
      issues.push({ severity: "warning", code: "reversal_review", message: "Reversal/refund/void transaction flagged for review." });
    }

    if (row.name_amount_match_note) {
      issues.push({
        severity: "warning",
        code: "possible_name_amount_match",
        message: row.name_amount_match_note,
      });
    }

    row.certificate_number = certificateNumber;
    row.matched_policy_id = matchedPolicyId;
    row.matched_policy_status = normalizePolicyStatus(policyEntry?.policy_status || "");
    row.matched_certificate_record_id = matchedCertificateRecordId;
    row.payment_name = buildPaymentName({
      certificate_number: certificateNumber,
      payment_account: row.payment_account,
      transaction_date: row.transaction_date,
    });
    row.date_received = formatDateReceived(row.transaction_date);
    row.months = extractLeadingMonths(row.id3);
    row.status = buildRowStatus(issues);
    row.issue_reason = summarizeIssues(issues);
    row.issue_details = issues;
    row.expected_amount = Number.isFinite(expectedAmount) ? expectedAmount : null;
    row.expected_amount_label = Number.isFinite(expectedAmount) ? premiumLabel : "";
    row.manually_corrected = Boolean(row.manual_policy_id || row.corrected_certificate_number);

    if (row.status === "ready") readyCount += 1;
    if (row.status === "warning") {
      readyCount += 1;
      warningCount += 1;
    }
    if (row.status === "error") errorCount += 1;
  });

  session.row_count = sessionRows.length;
  session.ready_count = readyCount;
  session.error_count = errorCount;
  session.warning_count = warningCount;
  session.missing_policy_count = missingPolicyCount;
  session.valid_row_count = readyCount;
  session.failed_validation_row_count = errorCount;
  session.policy_lookup_refreshed_at = readPolicyCache().refreshedAt || session.policy_lookup_refreshed_at || null;
  session.status = buildSessionStatus({
    rowCount: session.row_count,
    readyCount: readyCount,
    errorCount,
    warningCount,
    exportedAt: session.exported_at,
  });
  session.final_status = errorCount > 0
    ? "validation_failed"
    : session.successful_import_count > 0
      ? (session.salesforce_failed_row_count > 0 ? "imported_with_errors" : "imported")
      : "ready_to_import";
  session.updated_at = new Date().toISOString();

  writeRows(rows);
  writeSessions(sessions);
  return getCcPaymentImportSession(sessionId);
}

function serializeSession(session, includeRows = false) {
  const rows = includeRows
    ? readRows()
        .filter((entry) => entry.session_id === session.id)
        .sort((a, b) => Number(a.row_number || 0) - Number(b.row_number || 0))
    : undefined;

  return {
    ...clone(session),
    template: clone(getCcPaymentImportTemplate(session.import_template_key) || {}),
    policyLookup: clone(readPolicyCache()),
    rows,
  };
}

function listCcPaymentImportSessions() {
  return readSessions()
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.uploaded_at || a.updated_at || 0) || 0;
      const bTime = Date.parse(b.uploaded_at || b.updated_at || 0) || 0;
      return bTime - aTime;
    })
    .map((entry) => serializeSession(entry, false));
}

function getCcPaymentImportSession(sessionId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }
  return serializeSession(session, true);
}

function deleteCcPaymentImportSession(sessionId) {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    throw new Error("Credit card payment import session not found.");
  }

  const sessions = readSessions();
  const session = sessions.find((entry) => entry.id === normalizedSessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  const importedRowCount = Number(session.imported_row_count || session.successful_import_count || 0);
  if (importedRowCount > 0) {
    throw new Error("Imported sessions cannot be deleted from history.");
  }

  const remainingSessions = sessions.filter((entry) => entry.id !== normalizedSessionId);
  const remainingRows = readRows().filter((entry) => entry.session_id !== normalizedSessionId);

  writeRows(remainingRows);
  writeSessions(remainingSessions);

  remainingSessions.forEach((entry) => {
    revalidateSession(entry.id);
  });

  return {
    deletedSessionId: normalizedSessionId,
    sessions: listCcPaymentImportSessions(),
  };
}

function buildImportRow(sessionId, sourceRow) {
  const rowNumber = Number(sourceRow.__rowNumber || 0);
  const certificateNumber = normalizeCertificateNumber(sourceRow.ID1);
  const payorName = [
    sourceRow.PayorBusinessName,
    sourceRow.PayorFirstName,
    sourceRow.PayorMiddleName,
    sourceRow.PayorLastName,
  ].map((value) => normalizeText(value)).filter(Boolean).join(" ");
  const customerName = [
    sourceRow.ObligorFirstName,
    sourceRow.ObligorMiddleName,
    sourceRow.ObligorLastName,
  ].map((value) => normalizeText(value)).filter(Boolean).join(" ");

  return {
    id: createRowId(sessionId, rowNumber),
    session_id: sessionId,
    row_number: rowNumber,
    source_record_id: normalizeText(sourceRow.RecordID),
    merchant_name: normalizeText(sourceRow.MerchantName),
    merchant_api_name: normalizeText(sourceRow.MerchantAPIName),
    transaction_id: normalizeText(sourceRow.TransactionID),
    batch_id: normalizeText(sourceRow.BatchID),
    auth_code: normalizeText(sourceRow.AuthCode),
    transaction_date: normalizeDateText(sourceRow.TransactionDate),
    batch_close_date: normalizeDateText(sourceRow.BatchCloseDate),
    amount: normalizeText(sourceRow.Amount),
    bill_type: normalizeText(sourceRow.BillType),
    certificate_number: certificateNumber,
    corrected_certificate_number: "",
    matched_policy_id: "",
    matched_certificate_record_id: "",
    payment_account: normalizeText(sourceRow.PaymentAccount),
    months: extractLeadingMonths(sourceRow.ID3),
    payment_name: "",
    status: "pending",
    issue_reason: "",
    issue_details: [],
    expected_amount: null,
    expected_amount_label: "",
    suggested_policy_id: "",
    suggested_certificate_number: "",
    name_amount_match_note: "",
    import_result_status: "",
    import_result_message: "",
    imported_salesforce_id: "",
    imported_salesforce_created: false,
    raw_json: clone(sourceRow),
    manual_policy_id: "",
    manually_corrected: false,
    corrected_by: "",
    corrected_at: "",
    id1: normalizeText(sourceRow.ID1),
    id2: normalizeText(sourceRow.ID2),
    id3: normalizeText(sourceRow.ID3),
    payor_name: payorName,
    customer_name: customerName,
    transaction_type: normalizeText(sourceRow.TransactionType),
    reversal_code: normalizeText(sourceRow.ReversalCode),
    reversal_code_description: normalizeText(sourceRow.ReversalCodeDescription),
    payment_method: normalizeText(sourceRow.PaymentMethod),
    date_received: "",
    type: "2",
    pay_type: "3",
    manual_payment: "Yes",
  };
}

function createCcPaymentImportSession({ fileName, base64Content, uploadedBy = DEFAULT_ACTOR, templateKey = IMPORT_TEMPLATE_KEY }) {
  if (!fileName || !base64Content) {
    throw new Error("Upload a daily credit card CSV first.");
  }

  const template = getCcPaymentImportTemplate(templateKey);
  if (!template) {
    throw new Error("Import template not found.");
  }

  const csvRows = parsePaymentUploadRows(fileName, base64Content);
  if (!csvRows.length) {
    throw new Error("The uploaded file did not contain any payment rows.");
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
    row_count: csvRows.length,
    ready_count: 0,
    error_count: 0,
    warning_count: 0,
    missing_policy_count: 0,
    attempted_import_count: 0,
    successful_import_count: 0,
    salesforce_failed_row_count: 0,
    imported_row_count: 0,
    failed_validation_row_count: 0,
    final_status: "pending_review",
    destination_object: template.salesforceObjectApiName,
    exported_at: null,
    export_filename: "",
  };

  const rows = csvRows.map((row) => buildImportRow(sessionId, row));
  const allSessions = readSessions();
  const allRows = readRows();
  allSessions.unshift(session);
  allRows.push(...rows);
  writeSessions(allSessions);
  writeRows(allRows);
  return revalidateSession(sessionId);
}

function updateCcPaymentImportRow(sessionId, rowId, updates = {}) {
  const rows = readRows();
  const row = rows.find((entry) => entry.session_id === sessionId && entry.id === rowId);
  if (!row) {
    throw new Error("Credit card payment import row not found.");
  }

  if (Object.prototype.hasOwnProperty.call(updates, "certificate_number")) {
    row.certificate_number = normalizeCertificateNumber(updates.certificate_number);
    row.corrected_certificate_number = row.certificate_number;
    row.name_amount_match_note = "";
    row.suggested_policy_id = "";
    row.suggested_certificate_number = "";
  }

  if (Object.prototype.hasOwnProperty.call(updates, "manual_policy_id")) {
    row.manual_policy_id = normalizePolicyId(updates.manual_policy_id);
  }

  row.corrected_by = normalizeText(updates.corrected_by || DEFAULT_ACTOR);
  row.corrected_at = new Date().toISOString();
  writeRows(rows);
  return revalidateSession(sessionId);
}

function refreshCcPaymentImportPolicyLookup(sessionId, body = {}) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  let nextCache = null;
  if (body.fileName && body.base64Content) {
    nextCache = refreshPolicyLookupFromCsv(body.fileName, body.base64Content);
  } else {
    throw new Error("Salesforce policy lookup refresh must be called through the async route.");
  }

  session.policy_lookup_refreshed_at = nextCache.refreshedAt;
  writeSessions(readSessions());
  return revalidateSession(sessionId);
}

async function refreshCcPaymentImportPolicyLookupFromSalesforce(sessionId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  const baseLookupCache = await refreshPolicyLookupFromSalesforce();
  const premiumEntries = await fetchPremiumLookupFromSalesforce();
  const sessionCertificateNumbers = readRows()
    .filter((entry) => entry.session_id === sessionId)
    .map((entry) => normalizeCertificateNumber(entry.certificate_number))
    .filter(Boolean);
  const targetedLookupEntries = await fetchPolicyLookupEntriesForCertificates(sessionCertificateNumbers);
  const targetedPolicyDetailEntries = await fetchPolicyDetailEntriesForCertificates(sessionCertificateNumbers);
  const certificateRecordIdMap = await fetchCertificateRecordIdsForCertificates(sessionCertificateNumbers);
  const knownCertificatePolicyKeys = new Set(
    (baseLookupCache.items || []).map((entry) =>
      `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`
    )
  );

  const nextCache = {
    reportId: POLICY_REPORT_ID,
    refreshedAt: new Date().toISOString(),
    source: "salesforce-report+premium-report+targeted-certificate-lookups",
    items: mergeLookupEntries(
      baseLookupCache.items,
      premiumEntries,
      targetedLookupEntries.filter((entry) =>
        knownCertificatePolicyKeys.has(
          `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`
        )
      ),
      targetedPolicyDetailEntries.filter((entry) =>
        knownCertificatePolicyKeys.has(
          `${normalizeCertificateNumber(entry.certificate_number).toLowerCase()}::${normalizePolicyId(entry.policy_id).toLowerCase()}`
        )
      )
    ),
  };

  writePolicyCache(nextCache);
  await enrichSessionRowsForPremiumReview(sessionId, nextCache, certificateRecordIdMap);

  session.policy_lookup_refreshed_at = nextCache.refreshedAt;
  writeSessions(readSessions());
  return revalidateSession(sessionId);
}

function normalizeDateTimeText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    const normalizedDate = normalizeDateText(text);
    return normalizedDate ? `${normalizedDate}T00:00:00.000Z` : "";
  }
  return parsed.toISOString();
}

function buildCcPaymentSalesforceRecord(row, template) {
  return {
    attributes: { type: template.salesforceObjectApiName },
    Name: row.payment_name,
    Policy__c: row.matched_policy_id || undefined,
    Certificate__c: row.matched_certificate_record_id || undefined,
    Payments_For_Certificate__c: row.matched_certificate_record_id || undefined,
    Amount_Received__c: normalizeAmount(row.amount),
    Auth_Amount__c: normalizeAmount(row.amount),
    Date_Received__c: normalizeDateText(row.transaction_date || row.date_received),
    Txn_Date_Time__c: normalizeDateTimeText(row.raw_json?.TransactionDate || row.transaction_date),
    Months_Pay__c: Number(row.months || 0) || undefined,
    Auth_Code__c: normalizeText(row.auth_code),
    Gateway_Txn_ID__c: normalizeText(row.transaction_id),
    Issuer_Response_Text__c: normalizeText(row.batch_id),
    Manual_Payment__c: row.manual_payment || template.defaultValues.Manual_Payment__c,
    Pay_Type__c: row.pay_type || template.defaultValues.Pay_Type__c,
    Type_Received__c: row.type || template.defaultValues.Type_Received__c,
  };
}

function validateImportableRow(row) {
  const issues = [];
  if (!normalizePolicyId(row.matched_policy_id)) {
    issues.push("Missing Policy__c lookup.");
  }
  if (!normalizeText(row.matched_certificate_record_id)) {
    issues.push("Missing Certificate__c lookup.");
  }
  if (normalizeAmount(row.amount) === null) {
    issues.push("Missing Amount_Received__c.");
  }
  if (!normalizeDateText(row.transaction_date || row.date_received)) {
    issues.push("Missing Date_Received__c.");
  }
  if (!(Number(row.months || 0) > 0)) {
    issues.push("Missing Months_Pay__c.");
  }
  if (!normalizeText(row.payment_name)) {
    issues.push("Missing Payment Name.");
  }
  return issues;
}

async function insertSalesforceRecords(tokenRecord, template, rows) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/v61.0/composite/sobjects`,
    {
      method: "POST",
      body: JSON.stringify({
        allOrNone: false,
        records: rows.map((row) => buildCcPaymentSalesforceRecord(row, template)),
      }),
    }
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload[0]?.message || payload.message || "Salesforce composite import failed.");
  }

  return payload;
}

async function confirmCcPaymentImport(sessionId, { confirmedBy = DEFAULT_ACTOR } = {}) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  const template = getCcPaymentImportTemplate(session.import_template_key || IMPORT_TEMPLATE_KEY);
  if (!template) {
    throw new Error("Import template not found.");
  }

  const rows = readRows();
  const sessionRows = rows
    .filter((entry) => entry.session_id === sessionId)
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
    const results = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.results)
        ? payload.results
        : [];

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
        row.imported_salesforce_id = "";
        row.imported_salesforce_created = false;
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

function buildExportRows(sessionId) {
  const session = getCcPaymentImportSession(sessionId);
  const blockingRows = (session.rows || []).filter((row) => row.status === "error");
  if (blockingRows.length) {
    throw new Error("Fix all blocking errors before exporting the Payments import file.");
  }

  return (session.rows || []).map((row) => ({
    Type: row.type,
    "Pay Type": row.pay_type,
    "Certificate Record ID": row.matched_policy_id,
    "Manual Payment": row.manual_payment,
    "Payment Name": row.payment_name,
    Amount: normalizeAmount(row.amount),
    "Date Received": row.date_received,
    "# of Months": row.months,
    TransactionID: row.transaction_id,
    BatchID: row.batch_id,
    AuthCode: row.auth_code,
    PaymentAccount: row.payment_account,
    "Source RecordID": row.source_record_id,
    "Certificate Number": row.certificate_number,
    "Payor / Customer": row.payor_name || row.customer_name || "",
  }));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function exportCcPaymentImportSession(sessionId) {
  const rows = buildExportRows(sessionId);
  const headers = Object.keys(rows[0] || {
    Type: "",
    "Pay Type": "",
    "Certificate Record ID": "",
    "Manual Payment": "",
    "Payment Name": "",
    Amount: "",
    "Date Received": "",
    "# of Months": "",
    TransactionID: "",
    BatchID: "",
    AuthCode: "",
    PaymentAccount: "",
    "Source RecordID": "",
  });
  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\r\n");

  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Credit card payment import session not found.");
  }

  const fileName = `cc-payments-import-${sessionId}.csv`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(filePath, csv, "utf8");

  session.exported_at = new Date().toISOString();
  session.export_filename = fileName;
  session.status = "exported";
  session.updated_at = new Date().toISOString();
  writeSessions(readSessions());

  return {
    fileName,
    filePath,
    contentType: "text/csv; charset=utf-8",
  };
}

module.exports = {
  POLICY_REPORT_ID,
  __setCcPaymentImportStateForTests,
  confirmCcPaymentImport,
  createCcPaymentImportSession,
  deleteCcPaymentImportSession,
  exportCcPaymentImportSession,
  getCcPaymentImportSession,
  initializeCcPaymentImportPersistence,
  listCcPaymentImportTemplates,
  listCcPaymentImportSessions,
  refreshCcPaymentImportPolicyLookup,
  refreshCcPaymentImportPolicyLookupFromSalesforce,
  revalidateSession,
  updateCcPaymentImportRow,
};
