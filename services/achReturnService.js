const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  fetchRawSalesforceReportRows,
  getConnectedSalesforceToken,
  runSoqlQuery,
  salesforceRequest,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_PATH = path.join(DATA_DIR, "ach-return-sessions.json");
const ROW_PATH = path.join(DATA_DIR, "ach-return-rows.json");
const SESSION_SUPABASE_KEY = "ach-return-sessions.json";
const ROW_SUPABASE_KEY = "ach-return-rows.json";
const EXPORT_DIR = path.join(os.tmpdir(), "hpa-ach-return-exports");
const DEFAULT_ACTOR = "Local User";
const ACH_RETURN_PAYMENT_DETAIL_REPORT_ID = "00OQm000003QDEPMA4";
const IMPORT_BATCH_SIZE = 200;

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

function normalizeCertificateNumber(value) {
  return normalizeText(value)
    .replace(/,/g, "")
    .replace(/\s+/g, "");
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeAmount(value) {
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "amount")) {
      return normalizeAmount(value.amount);
    }
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      return normalizeAmount(value.value);
    }
  }
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

function buildAchReturnDuplicateFingerprint(row = {}) {
  return [
    normalizeText(row.originalPaymentId || row.matched_payment?.salesforcePaymentId),
    normalizeText(row.identifier1),
    normalizeText(row.traceNumber),
    normalizeText(row.returnCode || row.reasonCode),
    normalizeDateText(row.creditDate || row.batchDate || row.dateRefunded),
    normalizeAmount(row.creditAmount ?? row.amount),
    normalizeText(row.certificateNumber),
  ].join("|");
}

function extractDuplicateSalesforceRecordId(errorMessages = []) {
  const messages = Array.isArray(errorMessages) ? errorMessages : [errorMessages];
  for (const message of messages) {
    const text = normalizeText(message);
    if (!text) continue;
    const match = text.match(/duplicate value found: .*?id:\s*([a-zA-Z0-9]{15,18})/i);
    if (match) {
      return match[1];
    }
  }
  return "";
}

function findValueByLabels(row, labels, options = {}) {
  const preferLabel = Boolean(options.preferLabel);

  const getPreferredValue = (matchedKey) => {
    if (!matchedKey) {
      return "";
    }

    if (preferLabel) {
      const labelCandidates = [`${matchedKey}__label`, `${matchedKey} label`];
      const labelKey = labelCandidates.find(
        (entry) => row[entry] !== undefined && String(row[entry]).trim() !== ""
      );
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

function formatDateMmDdYyyy(value) {
  const normalized = normalizeDateText(value);
  if (!normalized) return "";
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return normalized;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function formatRollbackMonthsValue(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "";
  }
  return String(parsed).padStart(2, "0");
}

function parseRollbackMonths(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  const parsed = Number(candidate);
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(Math.round(parsed));
  }

  const textMatch = candidate.match(/(\d+)\s*month/i);
  if (textMatch) return String(Number(textMatch[1]));

  const compactMatch = candidate.match(/^p(\d+)$/i);
  if (compactMatch) return String(Number(compactMatch[1]));

  return "";
}

function resolveDuesFromPaymentMatch(row) {
  const candidates = [
    row.dues,
    row.dues_amount,
    row.dues_collected,
    row.duesCollected,
    row.aha_dues,
    row.ahaDues,
    row.ahaDuesAmount,
    row.payment_dues,
    row.paymentDues,
    row.raw_json?.Dues,
    row.raw_json?.Dues__c,
    row.raw_json?.Dues_Collected__c,
    row.raw_json?.DuesCollected__c,
    row.raw_json?.Dues_Collected,
    row.raw_json?.AHA_Dues__c,
    row.raw_json?.AhaDues__c,
    row.raw_json?.AhaDues,
    row.raw_json?.AHA_DUES__c,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeAmount(candidate);
    if (parsed !== null) return parsed;
  }
  return "";
}

function resolvePremiumFromPaymentMatch(row) {
  const candidates = [
    row.premium,
    row.premium_amount,
    row.premiumAmount,
    row.payment_premium,
    row.paymentPremium,
    row.gross_premium,
    row.grossPremium,
    row.total_premium,
    row.totalPremium,
    row.raw_json?.Premium,
    row.raw_json?.Premium__c,
    row.raw_json?.Total_Premium__c,
    row.raw_json?.Gross_Premium__c,
    row.raw_json?.Payment_Premium__c,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeAmount(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function escapeSoqlString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

async function runPaymentMatchQuery(tokenRecord, needle) {
  const whereClause = `
WHERE Gateway_Txn_ID__c = '${escapeSoqlString(needle)}'
   OR Issuer_Response_Text__c = '${escapeSoqlString(needle)}'
   OR Name = '${escapeSoqlString(needle)}'
LIMIT 10
`.trim();

  const selectFieldSets = [
    [
      "Id",
      "Name",
      "Policy__c",
      "Certificate__c",
      "Amount_Received__c",
      "Date_Received__c",
      "Pay_Type__c",
      "Gateway_Txn_ID__c",
      "Issuer_Response_Text__c",
      "Months__c",
      "Months_Pay__c",
      "Months_Paid__c",
      "Number_of_Months__c",
      "Num_Months__c",
      "Month_Count__c",
      "Payment_Method__c",
      "Payment_Method__r.Name",
      "Dues__c",
      "Dues_Collected__c",
      "DuesCollected__c",
      "AHA_Dues__c",
      "Aha_Dues__c",
      "Premium__c",
      "Total_Premium__c",
      "Gross_Premium__c",
      "Payment_Premium__c",
      "Customer_Name__c",
      "Certificate__r.Name",
    ],
    [
      "Id",
      "Name",
      "Policy__c",
      "Certificate__c",
      "Amount_Received__c",
      "Date_Received__c",
      "Pay_Type__c",
      "Gateway_Txn_ID__c",
      "Issuer_Response_Text__c",
      "Months__c",
      "Months_Paid__c",
      "Number_of_Months__c",
      "Payment_Method__c",
      "Payment_Method__r.Name",
      "Dues__c",
      "Dues_Collected__c",
      "AHA_Dues__c",
      "Premium__c",
      "Total_Premium__c",
      "Gross_Premium__c",
      "Customer_Name__c",
      "Certificate__r.Name",
    ],
    [
      "Id",
      "Name",
      "Policy__c",
      "Certificate__c",
      "Amount_Received__c",
      "Date_Received__c",
      "Pay_Type__c",
      "Payment_Method__c",
      "Payment_Method__r.Name",
      "Gateway_Txn_ID__c",
      "Issuer_Response_Text__c",
      "Certificate__r.Name",
    ],
  ];

  let lastError = null;
  for (const fields of selectFieldSets) {
    try {
      const soql = `
SELECT ${fields.join(", ")}
FROM Payments__c
${whereClause}
`.trim();
      return await runSoqlQuery(tokenRecord, soql);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to query Salesforce payment details.");
}

function buildAchReturnReportDetailMap(rows = []) {
  const map = new Map();

  for (const row of rows) {
    const paymentId = normalizeText(
      findValueByLabels(row, ["Payments: ID", "Payments ID", "Payment ID", "Payment Id", "Id", "Record ID"])
    );
    const paymentIdLabel = normalizeText(
      findValueByLabels(row, ["Payments: ID"], { preferLabel: true })
    );
    const paymentName = normalizeText(
      findValueByLabels(row, ["Payment Name", "Name"], { preferLabel: true })
    );
    const gatewayTxnId = normalizeText(
      findValueByLabels(row, ["Gateway Txn ID", "Gateway Txn Id", "Transaction/Reference Number"])
    );
    const issuerResponse = normalizeText(
      findValueByLabels(row, ["Issuer Response Text", "Approval"])
    );

    const detail = {
      premium: normalizeAmount(findValueByLabels(row, ["Premium"])),
      dues: normalizeAmount(findValueByLabels(row, ["Dues Collected", "Dues"])),
      rollbackMonths: parseRollbackMonths(
        findValueByLabels(row, ["Months Paid", "Months Pay", "Months"])
      ),
      paymentAmount: normalizeAmount(findValueByLabels(row, ["Amount Received", "Amount"])),
      paymentDate: normalizeDateText(findValueByLabels(row, ["Date Received"])),
      paymentMethod: normalizeText(
        findValueByLabels(row, ["Pay Type", "Payment Method"], { preferLabel: true })
      ),
      checkNumber: normalizeText(findValueByLabels(row, ["Check #", "Check No"])),
      certificateNumber: normalizeText(
        findValueByLabels(row, ["Certificate", "Certificate Number"], { preferLabel: true })
      ),
      policyId: normalizeText(findValueByLabels(row, ["Policy", "Policy ID", "Policy Id"])),
      paymentName,
      paymentId,
      paymentIdLabel,
      gatewayTxnId,
      issuerResponse,
      raw: clone(row),
    };

    [paymentId, paymentIdLabel, paymentName, gatewayTxnId, issuerResponse]
      .map((entry) => normalizeText(entry).toLowerCase())
      .filter(Boolean)
      .forEach((key) => {
        if (!map.has(key)) {
          map.set(key, detail);
        }
      });
  }

  return map;
}

async function fetchAchReturnReportDetailMap() {
  const report = await fetchRawSalesforceReportRows(ACH_RETURN_PAYMENT_DETAIL_REPORT_ID);
  return buildAchReturnReportDetailMap(report.rows || []);
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

function mergePaymentMatchDetail(baseMatch, reportDetail, needle) {
  if (!reportDetail) {
    return baseMatch;
  }

  return {
    ...baseMatch,
    policyId: baseMatch.policyId || reportDetail.policyId || "",
    certificateNumber: baseMatch.certificateNumber || reportDetail.certificateNumber || "",
    rollbackMonths: baseMatch.rollbackMonths || reportDetail.rollbackMonths || "",
    dues:
      baseMatch.dues !== "" && baseMatch.dues !== null && baseMatch.dues !== undefined
        ? baseMatch.dues
        : reportDetail.dues ?? "",
    premium:
      baseMatch.premium !== null && baseMatch.premium !== undefined
        ? baseMatch.premium
        : reportDetail.premium ?? null,
    paymentAmount:
      baseMatch.paymentAmount !== null && baseMatch.paymentAmount !== undefined
        ? baseMatch.paymentAmount
        : reportDetail.paymentAmount ?? null,
    paymentDate: baseMatch.paymentDate || reportDetail.paymentDate || "",
    paymentMethod: baseMatch.paymentMethod || reportDetail.paymentMethod || "",
    paymentMethodId: baseMatch.paymentMethodId || reportDetail.paymentMethodId || "",
    certificateRecordId: baseMatch.certificateRecordId || reportDetail.certificateRecordId || "",
    transactionReference:
      baseMatch.transactionReference
      || reportDetail.gatewayTxnId
      || reportDetail.issuerResponse
      || normalizeText(needle),
    checkNumber: baseMatch.checkNumber || reportDetail.checkNumber || "",
    raw: {
      ...(reportDetail.raw && typeof reportDetail.raw === "object" ? reportDetail.raw : {}),
      ...(baseMatch.raw && typeof baseMatch.raw === "object" ? baseMatch.raw : {}),
    },
  };
}

function findReportDetailForPaymentMatch(reportDetailMap, entry, needle) {
  const directMatch = [
    entry.salesforcePaymentId,
    entry.transactionReference,
    entry.matchKey.startsWith("remote:") ? entry.matchKey.slice("remote:".length) : "",
    entry.raw?.Id,
    needle,
  ]
    .map((candidate) => normalizeText(candidate).toLowerCase())
    .filter(Boolean)
    .map((key) => reportDetailMap.get(key))
    .find(Boolean);

  if (directMatch) {
    return directMatch;
  }

  const entryPolicyId = normalizeText(entry.policyId).toLowerCase();
  const entryPaymentDate = normalizeDateText(entry.paymentDate);
  const entryAmount = normalizeAmount(entry.paymentAmount);
  const entryCertificate = normalizeText(entry.certificateNumber).toLowerCase();

  for (const detail of reportDetailMap.values()) {
    if (!detail || typeof detail !== "object") {
      continue;
    }
    const detailPolicyId = normalizeText(detail.policyId).toLowerCase();
    const detailPaymentDate = normalizeDateText(detail.paymentDate);
    const detailAmount = normalizeAmount(detail.paymentAmount);
    const detailCertificate = normalizeText(detail.certificateNumber).toLowerCase();

    const policyMatches = entryPolicyId && detailPolicyId && entryPolicyId === detailPolicyId;
    const dateMatches = entryPaymentDate && detailPaymentDate && entryPaymentDate === detailPaymentDate;
    const amountMatches =
      entryAmount !== null &&
      detailAmount !== null &&
      Math.abs(Number(entryAmount) - Number(detailAmount)) < 0.0001;
    const certificateMatches =
      entryCertificate && detailCertificate && entryCertificate === detailCertificate;

    if ((policyMatches || certificateMatches) && dateMatches && amountMatches) {
      return detail;
    }
  }

  return null;
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
  let session = sessions.find(
    (entry) => !entry.exported_at && !["imported", "imported_with_errors"].includes(String(entry.final_status || ""))
  );
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
  session.ready_count = rows.filter((entry) => (entry.validation_status || entry.status) === "ready").length;
  session.error_count = rows.filter((entry) => (entry.validation_status || entry.status) === "error").length;
  session.imported_row_count = rows.filter((entry) => entry.import_result_status === "imported").length;
  session.salesforce_failed_row_count = rows.filter((entry) => entry.import_result_status === "salesforce_failed").length;
  session.status = session.exported_at ? "exported" : (session.row_count ? "draft" : "empty");
  session.updated_at = new Date().toISOString();
  writeSessions(sessions);
  return serializeSession(session, true);
}

function validateImportableRow(row) {
  const issues = [];
  const matchedPaymentPolicyId = normalizeText(row.matched_payment?.policyId || row.matched_payment?.policy_id);
  const effectivePolicyId = normalizeText(matchedPaymentPolicyId || row.policyId);
  if (!effectivePolicyId) issues.push("Missing Policy lookup.");
  if (
    matchedPaymentPolicyId
    && normalizeText(row.policyId)
    && normalizeText(row.policyId) !== matchedPaymentPolicyId
  ) {
    issues.push("Policy mismatch: ACH credit must use the same Policy as the matched payment.");
  }
  if (!normalizeText(row.certificateRecordId)) issues.push("Missing Certificate lookup.");
  if (normalizeAmount(row.creditAmount) === null) issues.push("Missing Amount.");
  if (!normalizeDateText(row.creditDate)) issues.push("Missing Credit Date.");
  if (!normalizeText(row.creditReasonCode)) issues.push("Missing Credit Reason Code.");
  if (!normalizeText(row.status)) issues.push("Missing Status.");
  return issues;
}

function buildAchRefundSalesforceRecord(row) {
  const matchedPaymentPolicyId = normalizeText(row.matched_payment?.policyId || row.matched_payment?.policy_id);
  const effectivePolicyId = normalizeText(matchedPaymentPolicyId || row.policyId);
  return {
    attributes: { type: "Refund__c" },
    Name: normalizeText(row.refundName) || undefined,
    Policy__c: effectivePolicyId || undefined,
    Certificate__c: normalizeText(row.certificateRecordId) || undefined,
    Type__c: "ACH",
    Payment_Method__c: normalizeText(row.paymentMethodId) || undefined,
    Check_No__c: normalizeText(row.checkNo) || undefined,
    Claim__c: normalizeText(row.claimId) || undefined,
    Credit_Date__c: normalizeDateText(row.creditDate) || undefined,
    Premium__c: normalizeAmount(row.premium),
    Dues__c: normalizeAmount(row.dues),
    Policy_Selected__c: normalizeText(row.policySelected) || undefined,
    Credit_Reason_Code__c: normalizeText(row.creditReasonCode) || undefined,
    Rollback_Months__c: formatRollbackMonthsValue(row.rollbackMonths) || undefined,
    Death_Claim_Months_Credited__c:
      Number.isFinite(Number(row.deathClaimMonthsCredited)) ? Number(row.deathClaimMonthsCredited) : undefined,
    Settlement_Amount__c: normalizeAmount(row.creditAmount),
    Reason_for_Credit__c: normalizeText(row.reasonForCredit || row.notes) || undefined,
    Date_Refunded__c: normalizeDateText(row.dateRefunded) || undefined,
    Contact__c: normalizeText(row.contactId) || undefined,
    Status__c: normalizeText(row.status) || undefined,
    X0_Month_Credit__c: Boolean(row.zeroMonthCredit),
    Credit_QC__c: Boolean(row.creditQc),
    Credit_Batch_ID_Approval__c: normalizeText(row.creditBatchId) || undefined,
    Gateway_Response_Code__c: normalizeText(row.gatewayResponseCode || row.reasonCode) || undefined,
    Gateway_Response_Message__c: normalizeText(row.gatewayResponseMessage || row.returnReason) || undefined,
    Gateway_Txn_ID__c: normalizeText(row.identifier1) || undefined,
    Original_Gateway_Txn_ID__c: normalizeText(row.originalPaymentId) || undefined,
    Orig_Amount__c: normalizeAmount(row.creditAmount),
    Auth_Amount__c: normalizeAmount(row.creditAmount),
    Txn_Date_Time__c: normalizeDateText(row.creditDate)
      ? `${normalizeDateText(row.creditDate)}T00:00:00.000Z`
      : undefined,
  };
}

async function insertSalesforceRecords(tokenRecord, rows) {
  const response = await salesforceRequest(
    tokenRecord,
    "/services/data/v61.0/composite/sobjects",
    {
      method: "POST",
      body: JSON.stringify({
        allOrNone: false,
        records: rows.map((row) => buildAchRefundSalesforceRecord(row)),
      }),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload[0]?.message || payload.message || "Salesforce ACH refund import failed.");
  }
  return payload;
}

async function confirmAchReturnImport(sessionId, { confirmedBy = DEFAULT_ACTOR } = {}) {
  const sessions = readSessions();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("ACH return session not found.");
  }

  const rows = readRows();
  const sessionRows = rows
    .filter((entry) => entry.session_id === sessionId)
    .sort((a, b) => Number(a.row_number || 0) - Number(b.row_number || 0));

  const importableRows = [];
  const seenFingerprints = new Set();
  sessionRows.forEach((row) => {
    row.import_result_status = "";
    row.import_result_message = "";
    row.imported_salesforce_id = "";
    row.imported_salesforce_created = false;
    const blockingIssues = validateImportableRow(row);
    if ((row.validation_status || row.status) === "error" || blockingIssues.length) {
      row.import_result_status = "validation_failed";
      row.import_result_message = blockingIssues.join(" ") || row.issue_reason || "Row failed validation.";
      return;
    }
    const duplicateFingerprint = buildAchReturnDuplicateFingerprint(row);
    if (duplicateFingerprint && seenFingerprints.has(duplicateFingerprint)) {
      row.import_result_status = "duplicate_skipped";
      row.import_result_message = "Duplicate ACH reversal row already exists in this batch. This copy was skipped.";
      return;
    }
    if (duplicateFingerprint) {
      seenFingerprints.add(duplicateFingerprint);
    }
    importableRows.push(row);
  });

  logAchReturnEvent("Confirm import requested", {
    sessionId,
    confirmedBy: normalizeText(confirmedBy || DEFAULT_ACTOR),
    sessionRowCount: sessionRows.length,
    importableRowCount: importableRows.length,
  });

  if (!importableRows.length) {
    writeRows(rows);
    session.attempted_import_count = 0;
    session.successful_import_count = 0;
    session.salesforce_failed_row_count = 0;
    session.import_confirmed_at = new Date().toISOString();
    session.import_confirmed_by = normalizeText(confirmedBy || DEFAULT_ACTOR);
    session.final_status = "validation_failed";
    writeSessions(sessions);
    logAchReturnEvent("Confirm import finished with no importable rows", {
      sessionId,
      finalStatus: session.final_status,
    });
    return updateSessionCounts(sessionId);
  }

  const tokenRecord = await getConnectedSalesforceToken();
  let successfulRows = 0;
  let failedRows = 0;

  for (let startIndex = 0; startIndex < importableRows.length; startIndex += IMPORT_BATCH_SIZE) {
    const batchRows = importableRows.slice(startIndex, startIndex + IMPORT_BATCH_SIZE);
    logAchReturnEvent("Submitting ACH refund batch to Salesforce", {
      sessionId,
      batchStartIndex: startIndex,
      batchRowCount: batchRows.length,
    });
    const payload = await insertSalesforceRecords(tokenRecord, batchRows);
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
        const duplicateRecordId = extractDuplicateSalesforceRecordId(errors);
        if (duplicateRecordId) {
          row.import_result_status = "already_exists";
          row.import_result_message = `Salesforce already has this ACH credit: ${duplicateRecordId}`;
          row.imported_salesforce_id = duplicateRecordId;
          row.imported_salesforce_created = false;
          successfulRows += 1;
        } else {
          row.import_result_status = "salesforce_failed";
          row.import_result_message = errors.join(" | ") || "Salesforce rejected this row.";
          row.imported_salesforce_id = "";
          row.imported_salesforce_created = false;
          failedRows += 1;
        }
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
  writeSessions(sessions);
  logAchReturnEvent("Confirm import finished", {
    sessionId,
    attemptedImportCount: importableRows.length,
    successfulRows,
    failedRows,
    finalStatus: session.final_status,
  });
  return updateSessionCounts(sessionId);
}

async function confirmCurrentAchReturnImport({ confirmedBy = DEFAULT_ACTOR } = {}) {
  const currentSession = getCurrentAchReturnSession();
  if (!currentSession?.id) {
    throw new Error("Open or save an ACH return batch before importing.");
  }

  return confirmAchReturnImport(currentSession.id, { confirmedBy });
}

function extractLabelValueMap(emailBody = "") {
  const text = String(emailBody || "").replace(/\r/g, "").trim();
  const values = new Map();
  if (!text) {
    return values;
  }

  const labelAliases = [
    "payer name",
    "amount",
    "return code",
    "trace number",
    "batch date",
    "business unit name",
    "merchant legal name",
    "merchant dba name",
    "merchant id",
    "ach transaction id",
    "identifier 1",
    "identifier 2",
    "identifier 3",
    "identifier 4",
  ];

  const escapedLabels = labelAliases
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pairRegex = new RegExp(
    `(?:^|\\s)(${escapedLabels})\\s*:\\s*([\\s\\S]*?)(?=\\s+(?:${escapedLabels})\\s*:|$)`,
    "gi"
  );

  const seenPairs = [];
  const normalizedText = ` ${text} `;
  for (const match of normalizedText.matchAll(pairRegex)) {
    const key = String(match[1] || "").trim().toLowerCase();
    const value = String(match[2] || "").trim();
    if (!key || values.has(key)) continue;
    values.set(key, value);
    seenPairs.push(key);
  }

  if (seenPairs.length > 0) {
    return values;
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9 /()#.-]+?)\s*:\s*(.*)$/);
    if (!match) continue;
    values.set(match[1].trim().toLowerCase(), match[2].trim());
  }

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
  const certificateNumber = normalizeText(
    row.certificate_number
    || row.corrected_certificate_number
    || row.suggested_certificate_number
    || row.certificateNumber
    || row.certificateNo
    || row.raw_json?.certificateNumber
    || row.raw_json?.Certificate_Number__c
    || row.raw_json?.CertificateNumber__c
    || row.raw_json?.Certificate__c
    || row.raw_json?.Certificate
    || row.raw_json?.Certificate__r?.Name
  );
  const rollbackMonths = parseRollbackMonths(
    row.months
    || row.months_pay
    || row.monthsPay
    || row.months_paid
    || row.monthsPaid
    || row.id3
    || row.raw_json?.ID3
    || row.raw_json?.id3
    || row.raw_json?.Months__c
    || row.raw_json?.Months_Pay__c
    || row.raw_json?.Months_Paid__c
  );
  const paymentDues = resolveDuesFromPaymentMatch(row);
  const premiumAmount = resolvePremiumFromPaymentMatch(row);

  return {
    matchKey: `local:${row.id}`,
    source: "Local Payment Import",
    matchedField,
    salesforcePaymentId: normalizeText(row.imported_salesforce_id),
    policyId: normalizeText(row.matched_policy_id),
    certificateRecordId: normalizeText(
      row.matched_certificate_record_id
      || row.raw_json?.Certificate__c
      || row.raw_json?.Payments_For_Certificate__c
    ),
    certificateNumber,
    rollbackMonths,
    dues: paymentDues,
    premium: Number.isFinite(premiumAmount) ? premiumAmount : null,
    customerName: normalizeText(
      row.payor_name
      || row.customer_name
      || row.matched_customer_name
      || row.raw_json?.ID2
      || row.raw_json?.Customer__c
      || row.raw_json?.Customer_Name__c
      || row.raw_json?.Name
    ),
    paymentAmount: normalizeAmount(row.amount),
    paymentDate: normalizeDateText(row.transaction_date || row.date_received),
    paymentMethodId: normalizeText(row.payment_method_id || row.raw_json?.Payment_Method__c || ""),
    paymentMethod: normalizeText(
      row.payment_method
      || row.raw_json?.Payment_Method__r?.Name
      || row.raw_json?.PaymentMethod
      || ""
    ),
    checkNumber: normalizeText(row.check_number || row.raw_json?.Check__c || row.raw_json?.["Check #"] || ""),
    transactionReference: normalizeText(row.source_record_id || row.transaction_id || row.batch_id || row.raw_json?.Identifier1 || row.raw_json?.Gateway_Txn_ID__c),
    authCode: normalizeText(row.auth_code),
    raw: clone(row),
  };
}

async function findPaymentMatches(identifier1) {
  const needle = normalizeText(identifier1);
  if (!needle) return [];

  logAchReturnEvent("Original payment lookup started", { identifier1: needle });
  let reportDetailMap = new Map();
  try {
    reportDetailMap = await fetchAchReturnReportDetailMap();
  } catch (error) {
    logAchReturnEvent(
      "ACH return payment detail report lookup failed",
      error instanceof Error ? error.message : String(error || "")
    );
  }

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
        row.identifier_1,
        row.identifier1,
        row.identifier_2,
        row.identifier2,
        row.raw_json?.Identifier1,
        row.raw_json?.Identifier_2,
        row.raw_json?.ID1,
        row.raw_json?.ID2,
        row.raw_json?.Identifier_1,
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
        ["identifier_1", row.identifier_1],
        ["identifier1", row.identifier1],
        ["identifier_2", row.identifier_2],
        ["identifier2", row.identifier2],
        ["Identifier1", row.raw_json?.Identifier1],
        ["Identifier_2", row.raw_json?.Identifier_2],
        ["ID1", row.raw_json?.ID1],
        ["ID2", row.raw_json?.ID2],
      ].find(([, value]) => normalizeText(value) === needle)?.[0] || "local";
      return buildPaymentMatchFromLocalRow(row, matchedField);
    });

  const tokenRecord = await getConnectedSalesforceToken();
  let remoteMatches = [];
  try {
    const records = await runPaymentMatchQuery(tokenRecord, needle);
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
      certificateRecordId: normalizeText(record.Certificate__c),
      certificateNumber: normalizeText(
        record.Certificate__r?.Name
        || record.Certificate__c
        || record.CertificateNumber__c
        || record.Certificate_Number__c
        || record.CertificateName__c
      ),
      rollbackMonths: parseRollbackMonths(
        record.Months__c
        || record.Months_Pay__c
        || record.Months_Paid__c
        || record.Number_of_Months__c
        || record.Num_Months__c
        || record.Month_Count__c
      ),
      dues: normalizeAmount(
        record.Dues__c
        || record.Dues_Collected__c
        || record.DuesCollected__c
        || record.AHA_Dues__c
        || record.Aha_Dues__c
      ),
      premium: normalizeAmount(
        record.Premium__c
        || record.Total_Premium__c
        || record.Gross_Premium__c
        || record.Payment_Premium__c
      ),
      customerName: normalizeText(record.Customer_Name__c || record.Customer__c || record.Name || ""),
      paymentAmount: normalizeAmount(record.Amount_Received__c),
      paymentDate: normalizeDateText(record.Date_Received__c),
      paymentMethodId: normalizeText(record.Payment_Method__c),
      paymentMethod: normalizeText(record.Payment_Method__r?.Name || record.Pay_Type__c),
      checkNumber: normalizeText(record.Check__c || record.Check_Number__c || ""),
      transactionReference: normalizeText(record.Gateway_Txn_ID__c || record.Issuer_Response_Text__c || record.Name),
      authCode: "",
      raw: clone(record),
    }));
  } catch (error) {
    logAchReturnEvent("Salesforce payment lookup fallback failed", error instanceof Error ? error.message : String(error || ""));
  }

  const merged = new Map();
  [...localMatches, ...remoteMatches].forEach((entry) => {
    const reportDetail = findReportDetailForPaymentMatch(reportDetailMap, entry, needle);
    const nextEntry = mergePaymentMatchDetail(entry, reportDetail, needle);
    const key = normalizeText(entry.salesforcePaymentId || entry.transactionReference || entry.matchKey);
    if (!key || merged.has(key)) return;
    merged.set(key, nextEntry);
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
  const returnCode = normalizeText(parsed.returnCode);
  const returnReason = normalizeText(parsed.returnReason);
  const returnCodeLine = returnCode ? `Return Code: ${returnCode}${returnReason ? ` (${returnReason})` : ""}` : "";
  const reasonForCredit = [returnCode, returnReason ? `(${returnReason})` : "", parsed.identifier1, parsed.identifier3]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const refundNameDate = formatDateMmDdYyyy(parsed.batchDate);
  const refundName = `${normalizeText(matchedPayment.certificateNumber)} - ACH - Returned Check - ${refundNameDate || formatDateMmDdYyyy(new Date().toISOString())}`;
  const enteredDate = formatDateMmDdYyyy(new Date().toISOString());
  const creditDate = formatDateMmDdYyyy(parsed.batchDate) || parsed.batchDate || "";
  const creditBatchId = parsed.achTransactionId || parsed.traceNumber || "";
  const creditAmount = normalizeAmount(parsed.amount) || 0;
  const creditReasonCode = "Direct Debit (M&T Bank or UMB Bank) - Returned Items";
  const creditReason = "Direct Debit (M&T Bank or UMB Bank) - Returned Items";

  return {
    policyId: matchedPayment.policyId || "",
    certificateRecordId: matchedPayment.certificateRecordId || "",
    certificateNumber: matchedPayment.certificateNumber || "",
    certificateType: "ACH",
    originalPaymentId: matchedPayment.salesforcePaymentId || "",
    paymentMethodId: matchedPayment.paymentMethodId || "",
    paymentMethod: matchedPayment.paymentMethod || "",
    checkNo: matchedPayment.checkNumber || "",
    claimId: "",
    creditAmount,
    creditDate,
    dateEntered: formatDateMmDdYyyy(new Date().toISOString()),
    dateRefunded: enteredDate,
    premium: Number.isFinite(matchedPayment.premium) ? matchedPayment.premium : "",
    dues: matchedPayment.dues,
    duesCollected: matchedPayment.dues,
    creditReasonCode,
    creditReason,
    rollbackMonths: formatRollbackMonthsValue(matchedPayment.rollbackMonths) || "",
    deathClaimMonthsCredited: "",
    policySelected: "",
    discrepancy: "",
    reasonCode: returnCode || "",
    reasonForCredit: reasonForCredit || returnCodeLine,
    refundName,
    returnCode: returnCode,
    returnReason: returnReason,
    status: "Completed",
    creditType: "ACH",
    traceNumber: parsed.traceNumber || "",
    achTransactionId: parsed.achTransactionId || "",
    creditBatchId,
    identifier1: parsed.identifier1 || "",
    zeroMonthCredit: false,
    creditQc: false,
    importStatus: "Complete",
    payerName: parsed.payerName || "",
    notes: returnCodeLine,
    exportStatus: "ready",
    gatewayResponseCode: returnCode || "",
    gatewayResponseMessage: returnReason || "",
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
  if (!pendingCredit.certificateRecordId && pendingCredit.certificateNumber) {
    const certificateIdMap = await fetchCertificateRecordIdsForCertificates([pendingCredit.certificateNumber]);
    pendingCredit.certificateRecordId = normalizeText(
      certificateIdMap.get(normalizeCertificateNumber(pendingCredit.certificateNumber).toLowerCase()) || ""
    );
  }
  const session = ensureActiveSession(actor);
  const rows = readRows();
  const duplicateFingerprint = buildAchReturnDuplicateFingerprint({
    ...pendingCredit,
    matched_payment: selectedMatch,
  });
  const existingDuplicate = rows.find((entry) => (
    entry.session_id === session.id
    && buildAchReturnDuplicateFingerprint(entry) === duplicateFingerprint
  ));
  if (existingDuplicate) {
    const duplicateSession = updateSessionCounts(session.id);
    duplicateSession.duplicateDetected = true;
    duplicateSession.duplicateRowId = existingDuplicate.id;
    duplicateSession.duplicateFingerprint = duplicateFingerprint;
    return duplicateSession;
  }
  const validationStatus = pendingCredit.policyId
    && pendingCredit.certificateRecordId
    && pendingCredit.creditAmount > 0
    && pendingCredit.creditDate
    && pendingCredit.returnCode
    ? "ready"
    : "error";
  const row = {
    id: createRowId(session.id),
    session_id: session.id,
    row_number: rows.filter((entry) => entry.session_id === session.id).length + 1,
    created_at: new Date().toISOString(),
    created_by: normalizeText(actor || DEFAULT_ACTOR) || DEFAULT_ACTOR,
    validation_status: validationStatus,
    issue_reason: "",
    parsed_details: clone(preview.parsed),
    matched_payment: clone(selectedMatch),
    ...pendingCredit,
  };
  row.policyId = normalizeText(row.matched_payment?.policyId || row.matched_payment?.policy_id || row.policyId);
  row.issue_reason = row.validation_status === "ready"
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
  const session = readSessions().find(
    (entry) => !entry.exported_at && !["imported", "imported_with_errors"].includes(String(entry.final_status || ""))
  );
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
  const rows = (session.rows || []).filter((entry) => (entry.validation_status || entry.status) === "ready");
  if (!rows.length) {
    throw new Error("No ACH reversal rows are ready to export.");
  }

  const headers = [
    "Refund_Name",
    "Policy__c",
    "Certificate__c",
    "Certificate_Number",
    "Type__c",
    "Payment_Method__c",
    "Payment_Method_Name",
    "Check_No__c",
    "Claim__c",
    "Credit_Date",
    "Premium",
    "Dues_Collected",
    "Dues",
    "Policy_Selected",
    "Discrepancy",
    "Credit_Reason_Code",
    "Rollback_Months",
    "Death_Claim_Months_Credited",
    "Amount",
    "Reason_for_Credit",
    "Date_Refunded",
    "Contact__c",
    "Status",
    "Zero_Month_Credit",
    "Credit_QC",
    "Credit_Batch_ID_Approval",
    "Original_Payment__c",
    "Reason_Code",
    "Return_Reason",
    "Trace_Number",
    "ACH_Transaction_ID",
    "Identifier_1",
    "Payer_Name",
    "Notes",
    "Import_Result_Status",
    "Imported_Salesforce_ID",
  ];

  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => ([
      row.refundName,
      row.policyId,
      row.certificateRecordId,
      row.certificateNumber,
      row.creditType || row.certificateType,
      row.paymentMethodId || "",
      row.paymentMethod,
      row.checkNo || "",
      row.claimId || "",
      row.creditDate,
      row.premium,
      row.duesCollected,
      row.dues,
      row.policySelected || "",
      row.discrepancy || "",
      row.creditReasonCode || row.returnCode || "",
      row.rollbackMonths,
      row.deathClaimMonthsCredited || "",
      row.creditAmount,
      row.reasonForCredit || row.notes || "",
      row.dateRefunded || "",
      row.contactId || "",
      row.status,
      row.zeroMonthCredit ? "TRUE" : "FALSE",
      row.creditQc ? "TRUE" : "FALSE",
      row.creditBatchId || "",
      row.originalPaymentId,
      row.reasonCode,
      row.returnReason || "",
      row.traceNumber,
      row.achTransactionId || "",
      row.identifier1,
      row.payerName,
      row.notes,
      row.import_result_status || "",
      row.imported_salesforce_id || "",
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
  confirmAchReturnImport,
  confirmCurrentAchReturnImport,
  createAchReturnRow,
  exportAchReturnSession,
  getAchReturnSession,
  getCurrentAchReturnSession,
  initializeAchReturnPersistence,
  listAchReturnSessions,
  previewAchReturn,
  removeAchReturnRow,
};
