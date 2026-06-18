const fs = require("fs");
const os = require("os");
const path = require("path");
const { getConnectedSalesforceToken, runSoqlQuery } = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_PATH = path.join(DATA_DIR, "ach-return-sessions.json");
const ROW_PATH = path.join(DATA_DIR, "ach-return-rows.json");
const SESSION_SUPABASE_KEY = "ach-return-sessions.json";
const ROW_SUPABASE_KEY = "ach-return-rows.json";
const EXPORT_DIR = path.join(os.tmpdir(), "hpa-ach-return-exports");
const DEFAULT_ACTOR = "Local User";

let sessionCache = null;
let rowCache = null;

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

function normalizeAmount(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
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

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function logAchReturnEvent(message, details = null) {
  if (details && typeof details === "object") {
    console.log(`[ach-returns] ${message}`, details);
    return;
  }
  console.log(`[ach-returns] ${message}${details ? ` ${details}` : ""}`);
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
  writeJson(SESSION_PATH, sessionCache);
  queueStateSync(SESSION_SUPABASE_KEY, sessionCache);
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
  writeJson(ROW_PATH, rowCache);
  queueStateSync(ROW_SUPABASE_KEY, rowCache);
}

async function initializeAchReturnPersistence() {
  const [loadedSessions, loadedRows] = await Promise.all([
    loadStateObject(SESSION_SUPABASE_KEY, safeParseJson(SESSION_PATH, [])),
    loadStateObject(ROW_SUPABASE_KEY, safeParseJson(ROW_PATH, [])),
  ]);

  sessionCache = Array.isArray(loadedSessions) ? loadedSessions : [];
  rowCache = Array.isArray(loadedRows) ? loadedRows : [];

  writeSessions(sessionCache);
  writeRows(rowCache);
}

function createSessionId() {
  return `ach_return_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRowId(sessionId) {
  const currentRows = readRows().filter((entry) => entry.session_id === sessionId).length + 1;
  return `${sessionId}_row_${currentRows}`;
}

function ensureActiveSession(actor = DEFAULT_ACTOR) {
  const sessions = readSessions();
  let session = sessions.find((entry) => !entry.exported_at);
  if (!session) {
    const timestamp = new Date().toISOString();
    session = {
      id: createSessionId(),
      uploaded_at: timestamp,
      updated_at: timestamp,
      uploaded_by: normalizeText(actor || DEFAULT_ACTOR) || DEFAULT_ACTOR,
      status: "draft",
      row_count: 0,
      ready_count: 0,
      error_count: 0,
      exported_at: "",
      export_filename: "",
    };
    sessions.unshift(session);
    writeSessions(sessions);
  }
  return session;
}

function serializeSession(session, includeRows = false) {
  const rows = includeRows
    ? readRows()
        .filter((entry) => entry.session_id === session.id)
        .sort((a, b) => (Date.parse(a.created_at || 0) || 0) - (Date.parse(b.created_at || 0) || 0))
    : undefined;
  return {
    ...clone(session),
    rows,
  };
}

function updateSessionCounts(sessionId) {
  const sessions = readSessions();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("ACH return session not found.");
  }
  const rows = readRows().filter((entry) => entry.session_id === sessionId);
  session.row_count = rows.length;
  session.ready_count = rows.filter((entry) => entry.status === "ready").length;
  session.error_count = rows.filter((entry) => entry.status === "error").length;
  session.status = session.exported_at ? "exported" : (session.row_count ? "draft" : "empty");
  session.updated_at = new Date().toISOString();
  writeSessions(sessions);
  return serializeSession(session, true);
}

function extractLabelValueMap(emailBody = "") {
  const lines = String(emailBody || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const values = new Map();
  lines.forEach((line) => {
    const match = line.match(/^([A-Za-z0-9 /()#.-]+?)\s*:\s*(.*)$/);
    if (!match) return;
    values.set(match[1].trim().toLowerCase(), match[2].trim());
  });
  return values;
}

function parseReturnCode(value) {
  const text = normalizeText(value);
  if (!text) {
    return { returnCode: "", returnReason: "" };
  }
  const match = text.match(/^([A-Z]\d{2})\s*(?:\((.*?)\))?$/i);
  if (!match) {
    return { returnCode: text, returnReason: "" };
  }
  return {
    returnCode: normalizeText(match[1]).toUpperCase(),
    returnReason: normalizeText(match[2] || ""),
  };
}

function parseAchReturnEmail(emailBody = "") {
  const values = extractLabelValueMap(emailBody);
  const amountText = normalizeText(values.get("amount"));
  const amount = normalizeAmount(amountText);
  const { returnCode, returnReason } = parseReturnCode(values.get("return code"));

  const parsed = {
    payerName: normalizeText(values.get("payer name")),
    amount,
    amountText,
    returnCode,
    returnReason,
    traceNumber: normalizeText(values.get("trace number")),
    batchDate: normalizeDateText(values.get("batch date")),
    businessUnitName: normalizeText(values.get("business unit name")),
    merchantLegalName: normalizeText(values.get("merchant legal name")),
    merchantDbaName: normalizeText(values.get("merchant dba name")),
    merchantId: normalizeText(values.get("merchant id")),
    achTransactionId: normalizeText(values.get("ach transaction id")),
    identifier1: normalizeText(values.get("identifier 1")),
    identifier2: normalizeText(values.get("identifier 2")),
    identifier3: normalizeText(values.get("identifier 3")),
    identifier4: normalizeText(values.get("identifier 4")),
    emailBody: String(emailBody || "").trim(),
  };

  const errors = [];
  if (!parsed.identifier1) {
    errors.push("Identifier 1 is required.");
  }
  if (amount === null) {
    errors.push("Amount is required.");
  }
  if (!parsed.batchDate) {
    errors.push("Batch Date is required.");
  }

  if (!errors.length) {
    logAchReturnEvent("Email parsed successfully", {
      identifier1: parsed.identifier1,
      amount: parsed.amount,
      returnCode: parsed.returnCode,
      batchDate: parsed.batchDate,
    });
  }

  return { parsed, errors };
}

function maskIdentifier(value) {
  const text = normalizeText(value);
  if (text.length <= 4) return text;
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function buildPaymentMatchFromLocalRow(row, matchedField) {
  return {
    matchKey: `local:${row.id}`,
    source: "Local Payment Import",
    matchedField,
    salesforcePaymentId: normalizeText(row.imported_salesforce_id),
    policyId: normalizeText(row.matched_policy_id),
    certificateNumber: normalizeText(row.certificate_number),
    customerName: normalizeText(row.payor_name || row.customer_name || row.raw_json?.ID2 || ""),
    paymentAmount: normalizeAmount(row.amount),
    paymentDate: normalizeDateText(row.transaction_date || row.date_received),
    paymentMethod: normalizeText(row.payment_method || row.raw_json?.PaymentMethod || ""),
    transactionReference: normalizeText(row.source_record_id || row.transaction_id || row.batch_id),
    authCode: normalizeText(row.auth_code),
    raw: clone(row),
  };
}

async function findPaymentMatches(identifier1) {
  const needle = normalizeText(identifier1);
  if (!needle) return [];

  logAchReturnEvent("Original payment lookup started", { identifier1: needle });

  const localRows = safeParseJson(path.join(DATA_DIR, "cc-payment-import-rows.json"), []);
  const localMatches = localRows
    .filter((row) => {
      const candidates = [
        row.source_record_id,
        row.transaction_id,
        row.batch_id,
        row.imported_salesforce_id,
        row.raw_json?.RecordID,
        row.raw_json?.TransactionID,
        row.raw_json?.OriginalTransactionID,
        row.raw_json?.ReferenceTransactionID,
      ].map((entry) => normalizeText(entry));
      return candidates.some((entry) => entry === needle);
    })
    .map((row) => {
      const matchedField = [
        ["source_record_id", row.source_record_id],
        ["transaction_id", row.transaction_id],
        ["batch_id", row.batch_id],
        ["imported_salesforce_id", row.imported_salesforce_id],
        ["RecordID", row.raw_json?.RecordID],
        ["TransactionID", row.raw_json?.TransactionID],
        ["OriginalTransactionID", row.raw_json?.OriginalTransactionID],
        ["ReferenceTransactionID", row.raw_json?.ReferenceTransactionID],
      ].find(([, value]) => normalizeText(value) === needle)?.[0] || "local";
      return buildPaymentMatchFromLocalRow(row, matchedField);
    });

  const tokenRecord = await getConnectedSalesforceToken();
  let remoteMatches = [];
  try {
    const soql = `
SELECT Id, Name, Policy__c, Certificate__c, Amount_Received__c, Date_Received__c, Pay_Type__c, Gateway_Txn_ID__c, Issuer_Response_Text__c
FROM Payments__c
WHERE Gateway_Txn_ID__c = '${escapeSoqlString(needle)}'
   OR Issuer_Response_Text__c = '${escapeSoqlString(needle)}'
   OR Name = '${escapeSoqlString(needle)}'
LIMIT 10
`.trim();
    const records = await runSoqlQuery(tokenRecord, soql);
    remoteMatches = records.map((record) => ({
      matchKey: `remote:${normalizeText(record.Id)}`,
      source: "Salesforce Payments",
      matchedField: normalizeText(record.Gateway_Txn_ID__c) === needle
        ? "Gateway_Txn_ID__c"
        : normalizeText(record.Issuer_Response_Text__c) === needle
          ? "Issuer_Response_Text__c"
          : "Name",
      salesforcePaymentId: normalizeText(record.Id),
      policyId: normalizeText(record.Policy__c),
      certificateNumber: "",
      customerName: "",
      paymentAmount: normalizeAmount(record.Amount_Received__c),
      paymentDate: normalizeDateText(record.Date_Received__c),
      paymentMethod: normalizeText(record.Pay_Type__c),
      transactionReference: normalizeText(record.Gateway_Txn_ID__c || record.Issuer_Response_Text__c || record.Name),
      authCode: "",
      raw: clone(record),
    }));
  } catch (error) {
    logAchReturnEvent("Salesforce payment lookup fallback failed", error instanceof Error ? error.message : String(error || ""));
  }

  const merged = new Map();
  [...localMatches, ...remoteMatches].forEach((entry) => {
    const key = normalizeText(entry.salesforcePaymentId || entry.transactionReference || entry.matchKey);
    if (!key || merged.has(key)) return;
    merged.set(key, entry);
  });
  const results = Array.from(merged.values());
  if (results.length === 1) {
    logAchReturnEvent("Original payment matched", {
      identifier1: needle,
      paymentId: results[0].salesforcePaymentId,
      source: results[0].source,
    });
  } else if (results.length > 1) {
    logAchReturnEvent("Multiple matches found", {
      identifier1: needle,
      matchCount: results.length,
    });
  } else {
    logAchReturnEvent("No match found", { identifier1: needle });
  }
  return results;
}

function buildPendingReversalCredit(parsed, matchedPayment) {
  const notes = `ACH Return posted by Global Payments. Return Code ${parsed.returnCode || ""}${parsed.returnReason ? ` - ${parsed.returnReason}` : ""}. Trace Number ${parsed.traceNumber || ""}. ACH Transaction ID ${parsed.achTransactionId || ""}. Identifier 1 ${parsed.identifier1 || ""}. Amount ${formatCurrency(parsed.amount)}.`;
  return {
    policyId: matchedPayment.policyId || "",
    certificateNumber: matchedPayment.certificateNumber || "",
    originalPaymentId: matchedPayment.salesforcePaymentId || "",
    creditAmount: parsed.amount,
    creditDate: parsed.batchDate,
    creditType: "ACH Return",
    returnCode: parsed.returnCode || "",
    returnReason: parsed.returnReason || "",
    traceNumber: parsed.traceNumber || "",
    achTransactionId: parsed.achTransactionId || "",
    identifier1: parsed.identifier1 || "",
    payerName: parsed.payerName || "",
    notes,
    exportStatus: "ready",
  };
}

async function previewAchReturn(emailBody = "") {
  const { parsed, errors } = parseAchReturnEmail(emailBody);
  if (errors.length) {
    return {
      parsed,
      matches: [],
      selectedMatch: null,
      pendingCredit: null,
      errors,
    };
  }

  const matches = await findPaymentMatches(parsed.identifier1);
  if (!matches.length) {
    return {
      parsed,
      matches: [],
      selectedMatch: null,
      pendingCredit: null,
      errors: [`No original payment found for Identifier 1: ${parsed.identifier1}. Please research manually.`],
    };
  }

  const selectedMatch = matches.length === 1 ? matches[0] : null;
  return {
    parsed,
    matches,
    selectedMatch,
    pendingCredit: selectedMatch ? buildPendingReversalCredit(parsed, selectedMatch) : null,
    errors: [],
  };
}

async function createAchReturnRow({ emailBody = "", selectedMatchKey = "", actor = DEFAULT_ACTOR } = {}) {
  const preview = await previewAchReturn(emailBody);
  if (preview.errors.length) {
    throw new Error(preview.errors[0]);
  }

  const matches = preview.matches || [];
  const selectedMatch = matches.length === 1
    ? matches[0]
    : matches.find((entry) => entry.matchKey === selectedMatchKey);
  if (!selectedMatch) {
    throw new Error("Select the correct original payment before creating the import row.");
  }

  const pendingCredit = buildPendingReversalCredit(preview.parsed, selectedMatch);
  const session = ensureActiveSession(actor);
  const rows = readRows();
  const row = {
    id: createRowId(session.id),
    session_id: session.id,
    created_at: new Date().toISOString(),
    created_by: normalizeText(actor || DEFAULT_ACTOR) || DEFAULT_ACTOR,
    status: pendingCredit.policyId && pendingCredit.originalPaymentId && pendingCredit.creditAmount > 0 && pendingCredit.creditDate && pendingCredit.identifier1 && pendingCredit.returnCode
      ? "ready"
      : "error",
    issue_reason: "",
    parsed_details: clone(preview.parsed),
    matched_payment: clone(selectedMatch),
    ...pendingCredit,
  };
  row.issue_reason = row.status === "ready"
    ? ""
    : "Missing one or more required ACH reversal export fields.";
  rows.push(row);
  writeRows(rows);
  logAchReturnEvent("Reversal credit row created", {
    sessionId: session.id,
    rowId: row.id,
    identifier1: row.identifier1,
    originalPaymentId: row.originalPaymentId,
  });
  return updateSessionCounts(session.id);
}

function listAchReturnSessions() {
  return readSessions()
    .slice()
    .sort((a, b) => (Date.parse(b.updated_at || 0) || 0) - (Date.parse(a.updated_at || 0) || 0))
    .map((entry) => serializeSession(entry, false));
}

function getAchReturnSession(sessionId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("ACH return session not found.");
  }
  return serializeSession(session, true);
}

function getCurrentAchReturnSession() {
  const session = readSessions().find((entry) => !entry.exported_at);
  return session ? serializeSession(session, true) : null;
}

function removeAchReturnRow(sessionId, rowId) {
  const session = readSessions().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("ACH return session not found.");
  }
  const nextRows = readRows().filter((entry) => !(entry.session_id === sessionId && entry.id === rowId));
  writeRows(nextRows);
  return updateSessionCounts(sessionId);
}

function clearCurrentAchReturnSession() {
  const session = readSessions().find((entry) => !entry.exported_at);
  if (!session) {
    return null;
  }
  const nextRows = readRows().filter((entry) => entry.session_id !== session.id);
  writeRows(nextRows);
  const sessions = readSessions().filter((entry) => entry.id !== session.id);
  writeSessions(sessions);
  return null;
}

function exportAchReturnSession(sessionId) {
  const session = getAchReturnSession(sessionId);
  const rows = (session.rows || []).filter((entry) => entry.status === "ready");
  if (!rows.length) {
    throw new Error("No ACH reversal rows are ready to export.");
  }

  const headers = [
    "Policy__c",
    "Certificate_Number",
    "Original_Payment__c",
    "Credit_Amount",
    "Credit_Date",
    "Credit_Type",
    "Reason_for_Credit__c",
    "Return_Code",
    "Trace_Number",
    "ACH_Transaction_ID",
    "Identifier_1",
    "Payer_Name",
    "Notes",
  ];

  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => ([
      row.policyId,
      row.certificateNumber,
      row.originalPaymentId,
      row.creditAmount,
      row.creditDate,
      row.creditType,
      [row.returnCode, row.returnReason].filter(Boolean).join(" - "),
      row.returnCode,
      row.traceNumber,
      row.achTransactionId,
      row.identifier1,
      row.payerName,
      row.notes,
    ].map(csvEscape).join(","))),
  ].join("\r\n");

  const fileName = `ach-returns-${sessionId}.csv`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(filePath, csv, "utf8");

  const sessions = readSessions();
  const target = sessions.find((entry) => entry.id === sessionId);
  if (target) {
    target.exported_at = new Date().toISOString();
    target.export_filename = fileName;
    target.updated_at = new Date().toISOString();
    target.status = "exported";
    writeSessions(sessions);
  }

  logAchReturnEvent("Export completed", {
    sessionId,
    rowCount: rows.length,
    fileName,
  });

  return {
    fileName,
    filePath,
    contentType: "text/csv; charset=utf-8",
  };
}

module.exports = {
  clearCurrentAchReturnSession,
  createAchReturnRow,
  exportAchReturnSession,
  getAchReturnSession,
  getCurrentAchReturnSession,
  initializeAchReturnPersistence,
  listAchReturnSessions,
  previewAchReturn,
  removeAchReturnRow,
};
