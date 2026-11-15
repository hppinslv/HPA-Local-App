const {
  fetchRawSalesforceReportRows,
  fetchSObjectDescribe,
  getConnectedSalesforceToken,
  normalizeLabel,
  salesforceRequest,
} = require("./salesforceClient");

const BILL2_CORRECTION_REPORT_ID = "00O5G000008lD4oUAE";
const BILL4_CORRECTION_REPORT_ID = "00O5G000008lD4tUAE";
const POLICY_OBJECT = "Policy__c";
const BILL2_PAYMENT_TYPE_FIELD = "Pay_Type__c";
const BILL2_PREMIUM_FIELD = "Total_Monthly_Premium__c";
const MONTHLY_BILLING_PAY_TYPE = "3";
const MONTHLY_BILLING_PAY_TYPE_LABEL = "Monthly Billing";
const TARGET_NON_CONTRIB = 3000;
const INCORRECT_NON_CONTRIB = 7000;
const MAX_CONTRIB = 500000;
const MAX_TOTAL = 503000;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function value(row, labels) {
  for (const label of labels) {
    const key = normalizeLabel(label);
    const candidate = row?.[key] ?? row?.[`${key} label`];
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      if (typeof candidate === "object" && Number.isFinite(Number(candidate.amount))) return Number(candidate.amount);
      if (typeof candidate === "object" && candidate.value !== undefined) return candidate.value;
      return candidate;
    }
  }
  return "";
}

function requiredText(row, labels, fieldName) {
  const result = String(value(row, labels)).trim();
  if (!result) throw new Error(`${fieldName} is missing.`);
  return result;
}

function parseMoneyStrict(input, fieldName) {
  if (input === null || input === undefined || String(input).trim() === "") throw new Error(`${fieldName} is missing.`);
  const normalized = typeof input === "number" ? input : Number(String(input).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  if (!Number.isFinite(normalized)) throw new Error(`${fieldName} is not numeric.`);
  if (normalized < 0) throw new Error(`${fieldName} cannot be negative.`);
  return normalized;
}

function isMonthlyBillingValue(input) {
  const value = String(input ?? "").trim().toLowerCase();
  return value === MONTHLY_BILLING_PAY_TYPE || value === "monthly bill" || value === "monthly billing";
}

function sameStoredValue(left, right) {
  if (left === null || left === undefined || left === "") return right === null || right === undefined || right === "";
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  return String(left) === String(right);
}

function buildBill2CorrectionRow(row) {
  const policyId = requiredText(row, ["Policy ID", "Policy Id", "Record ID", "Id"], "Policy ID");
  const payType = String(value(row, ["Pay Type", BILL2_PAYMENT_TYPE_FIELD])).trim();
  return {
    policyId,
    policyName: String(value(row, ["Policy Name", "Policy"])).trim(),
    certificateNumber: String(value(row, ["Certificate Number", "Certificate Name"])).trim(),
    billingName: String(value(row, ["Billing Name", "Name"])).trim(),
    payType,
    targetPayType: MONTHLY_BILLING_PAY_TYPE_LABEL,
    targetPayTypeValue: MONTHLY_BILLING_PAY_TYPE,
    sourceReportId: BILL2_CORRECTION_REPORT_ID,
    status: isMonthlyBillingValue(payType) ? "Unchanged" : "Ready",
  };
}

function calculateBill4Correction(contribInput, nonContribInput) {
  const originalContrib = parseMoneyStrict(contribInput, "Original Contrib");
  const originalNonContrib = parseMoneyStrict(nonContribInput, "Original Non-Contrib");
  const originalTotal = originalContrib + originalNonContrib;
  if (originalNonContrib !== INCORRECT_NON_CONTRIB) {
    return { requiresUpdate: false, originalContrib, originalNonContrib, originalTotal, newContrib: originalContrib, newNonContrib: originalNonContrib, newTotal: originalTotal, coverageDecreased: false };
  }
  const newNonContrib = TARGET_NON_CONTRIB;
  const newContrib = Math.min(originalTotal - newNonContrib, MAX_CONTRIB);
  if (newContrib < 0) throw new Error("Calculated Contrib cannot be negative.");
  const newTotal = newContrib + newNonContrib;
  return { requiresUpdate: true, originalContrib, originalNonContrib, originalTotal, newContrib, newNonContrib, newTotal, coverageDecreased: newTotal < originalTotal };
}

function buildBill4CorrectionRow(row) {
  const base = {
    policyId: requiredText(row, ["Policy ID", "Policy Id", "Record ID", "Id"], "Policy ID"),
    policyName: String(value(row, ["Policy Name", "Policy"])).trim(),
    certificateNumber: String(value(row, ["Certificate Number", "Certificate Name"])).trim(),
    billingName: String(value(row, ["Billing Name", "Name"])).trim(),
    rateText: String(value(row, ["Rate Text"])).trim(),
    sourceReportId: BILL4_CORRECTION_REPORT_ID,
  };
  try {
    const amounts = calculateBill4Correction(
      value(row, ["Orig Contrib AD&D Coverage Amt", "Contrib AD&D Coverage Amt", "Contrib"]),
      value(row, ["Orig Non-Contrib AD&D Coverage Amt", "Non-Contrib AD&D Coverage Amt", "Non-Contrib"])
    );
    return { ...base, ...amounts, status: amounts.requiresUpdate ? "Ready" : "Unchanged" };
  } catch (error) {
    return { ...base, status: "Data Error", error: error.message || String(error) };
  }
}

async function pullBill2Corrections(_billMonth, dependencies = {}) {
  const report = await (dependencies.fetchReport || fetchRawSalesforceReportRows)(BILL2_CORRECTION_REPORT_ID, { failOnTruncatedReport: true });
  const rows = (report.rows || []).map((row) => {
    try { return buildBill2CorrectionRow(row); }
    catch (error) { return { status: "Data Error", error: error.message || String(error), sourceReportId: BILL2_CORRECTION_REPORT_ID }; }
  });
  return { reportId: BILL2_CORRECTION_REPORT_ID, reportName: report.reportName, retrieved: true, rowCount: rows.length, rows };
}

async function pullBill4Corrections(_billMonth, dependencies = {}) {
  const report = await (dependencies.fetchReport || fetchRawSalesforceReportRows)(BILL4_CORRECTION_REPORT_ID, { failOnTruncatedReport: true });
  const rows = (report.rows || []).map((row) => {
    try { return buildBill4CorrectionRow(row); }
    catch (error) { return { status: "Data Error", error: error.message || String(error), sourceReportId: BILL4_CORRECTION_REPORT_ID }; }
  });
  return { reportId: BILL4_CORRECTION_REPORT_ID, reportName: report.reportName, retrieved: true, rowCount: rows.length, rows };
}

async function parseResponsePayload(response) {
  if (response.status === 204) return null;
  try { return await response.json(); } catch { return null; }
}

function responseError(payload, fallback) { return payload?.[0]?.message || payload?.message || fallback; }

async function createDefaultGateway() {
  const tokenRecord = await getConnectedSalesforceToken();
  return {
    async read(policyId, fields) {
      const query = fields.length ? `?fields=${encodeURIComponent(fields.join(","))}` : "";
      const response = await salesforceRequest(tokenRecord, `/services/data/v61.0/sobjects/${POLICY_OBJECT}/${encodeURIComponent(policyId)}${query}`, { method: "GET" });
      const payload = await parseResponsePayload(response);
      if (!response.ok) throw new Error(responseError(payload, "Unable to read the Salesforce policy."));
      return payload || {};
    },
    async update(policyId, changes) {
      const response = await salesforceRequest(tokenRecord, `/services/data/v61.0/sobjects/${POLICY_OBJECT}/${encodeURIComponent(policyId)}`, { method: "PATCH", body: JSON.stringify(changes) });
      const payload = await parseResponsePayload(response);
      if (!response.ok) throw new Error(responseError(payload, "Salesforce rejected the policy update."));
    },
  };
}

function normalizeFieldLabel(input) { return normalizeLabel(input).replace(/[^a-z0-9]/g, ""); }

function resolveDescribeField(describe, candidates, purpose, { requireUpdateable = false } = {}) {
  const candidateKeys = candidates.map(normalizeFieldLabel);
  const matches = (Array.isArray(describe?.fields) ? describe.fields : []).filter((field) => [field.name, field.label].map(normalizeFieldLabel).some((key) => candidateKeys.includes(key)));
  const eligible = requireUpdateable ? matches.filter((field) => field.updateable !== false && field.calculated !== true) : matches;
  if (eligible.length !== 1) throw new Error(`Unable to resolve one unambiguous Salesforce field for ${purpose}.`);
  return eligible[0].name;
}

async function resolveBill4Fields(dependencies = {}) {
  if (dependencies.fields) return dependencies.fields;
  const describe = dependencies.fetchDescribe
    ? await dependencies.fetchDescribe(POLICY_OBJECT)
    : await fetchSObjectDescribe(await getConnectedSalesforceToken(), POLICY_OBJECT);
  return {
    contrib: resolveDescribeField(describe, ["Orig Contrib AD&D Coverage Amt", "Contrib AD&D Coverage Amt", "Orig_Contrib_AD_D_Coverage_Amt__c"], "Bill 4 Contrib", { requireUpdateable: true }),
    nonContrib: resolveDescribeField(describe, ["Orig Non-Contrib AD&D Coverage Amt", "Non-Contrib AD&D Coverage Amt", "Orig_Non_Contrib_AD_D_Coverage_Amt__c"], "Bill 4 Non-Contrib", { requireUpdateable: true }),
    premium: resolveDescribeField(describe, ["Total Monthly Premium", "Total_Monthly_Premium__c"], "Bill 4 stored monthly premium", { requireUpdateable: true }),
  };
}

async function applyBill2Corrections(rows, dependencies = {}) {
  const gateway = dependencies.gateway || await createDefaultGateway();
  const results = [];
  for (const input of rows || []) {
    const row = clone(input);
    if (!row.policyId || row.status === "Data Error") { results.push(row); continue; }
    try {
      const before = await gateway.read(row.policyId, [BILL2_PAYMENT_TYPE_FIELD, BILL2_PREMIUM_FIELD]);
      const originalPayType = String(before[BILL2_PAYMENT_TYPE_FIELD] ?? "").trim();
      const premiumBefore = before[BILL2_PREMIUM_FIELD];
      let updatePerformed = false;
      if (originalPayType !== MONTHLY_BILLING_PAY_TYPE) {
        await gateway.update(row.policyId, { [BILL2_PAYMENT_TYPE_FIELD]: MONTHLY_BILLING_PAY_TYPE });
        updatePerformed = true;
      }
      const after = await gateway.read(row.policyId, [BILL2_PAYMENT_TYPE_FIELD, BILL2_PREMIUM_FIELD]);
      const verifiedPayType = String(after[BILL2_PAYMENT_TYPE_FIELD] ?? "").trim();
      const premiumAfter = after[BILL2_PREMIUM_FIELD];
      if (verifiedPayType !== MONTHLY_BILLING_PAY_TYPE) throw new Error(`Verification returned ${verifiedPayType || "a blank value"}.`);
      if (!sameStoredValue(premiumBefore, premiumAfter)) throw new Error("Monthly premium changed during the Bill 2 payment-type correction.");
      results.push({ ...row, payType: originalPayType, verifiedPayType, premiumBefore, premiumAfter, updatePerformed, status: updatePerformed ? "Updated and Verified" : "Unchanged and Verified" });
    } catch (error) {
      results.push({ ...row, status: "Failed", error: error.message || String(error), verified: false });
    }
  }
  return results;
}

async function applyBill4Corrections(rows, dependencies = {}) {
  let gateway = dependencies.gateway || null;
  let fields = dependencies.fields || null;
  const results = [];
  for (const input of rows || []) {
    const row = clone(input);
    if (!row.policyId || row.status === "Data Error") { results.push(row); continue; }
    if (row.requiresUpdate === false) {
      results.push({ ...row, updatePerformed: false, status: "Unchanged and Verified" });
      continue;
    }
    try {
      if (!gateway) gateway = await createDefaultGateway();
      if (!fields) fields = await resolveBill4Fields(dependencies);
      const before = await gateway.read(row.policyId, [fields.contrib, fields.nonContrib, fields.premium]);
      const amounts = calculateBill4Correction(before[fields.contrib], before[fields.nonContrib]);
      const premiumBefore = parseMoneyStrict(before[fields.premium], "Existing premium");
      let updatePerformed = false;
      if (amounts.requiresUpdate) {
        await gateway.update(row.policyId, { [fields.contrib]: amounts.newContrib, [fields.nonContrib]: amounts.newNonContrib });
        updatePerformed = true;
      }
      let after = await gateway.read(row.policyId, [fields.contrib, fields.nonContrib, fields.premium]);
      const premiumAfterCoverageUpdate = parseMoneyStrict(after[fields.premium], "Premium after coverage update");
      let premiumRestored = false;
      if (premiumAfterCoverageUpdate !== premiumBefore) {
        await gateway.update(row.policyId, { [fields.premium]: premiumBefore });
        premiumRestored = true;
        after = await gateway.read(row.policyId, [fields.contrib, fields.nonContrib, fields.premium]);
      }
      const verifiedContrib = parseMoneyStrict(after[fields.contrib], "Verified Contrib");
      const verifiedNonContrib = parseMoneyStrict(after[fields.nonContrib], "Verified Non-Contrib");
      const premiumAfter = parseMoneyStrict(after[fields.premium], "Verified premium");
      if (verifiedContrib !== amounts.newContrib || verifiedNonContrib !== amounts.newNonContrib) throw new Error("Saved coverage values did not match the approved calculation.");
      if (premiumAfter !== premiumBefore) throw new Error("Monthly premium changed during the Bill 4 correction.");
      results.push({ ...row, ...amounts, premiumBefore, premiumAfterCoverageUpdate, premiumAfter, premiumRestored, verifiedContrib, verifiedNonContrib, updatePerformed, status: updatePerformed ? "Updated and Verified" : "Unchanged and Verified" });
    } catch (error) {
      results.push({ ...row, status: "Failed", error: error.message || String(error), verified: false });
    }
  }
  return results;
}

function summarizeCorrectionResults(bill2, bill4) {
  const all = [...(bill2 || []), ...(bill4 || [])];
  const failures = all.filter((row) => ["Failed", "Data Error"].includes(row.status));
  return {
    complete: failures.length === 0,
    total: all.length,
    updated: all.filter((row) => row.status === "Updated and Verified").length,
    unchanged: all.filter((row) => row.status === "Unchanged and Verified").length,
    failed: failures.length,
    coverageReductions: (bill4 || []).filter((row) => row.coverageDecreased).length,
  };
}

module.exports = {
  BILL2_CORRECTION_REPORT_ID, BILL4_CORRECTION_REPORT_ID, BILL2_PAYMENT_TYPE_FIELD, BILL2_PREMIUM_FIELD,
  INCORRECT_NON_CONTRIB, MAX_CONTRIB, MAX_TOTAL, MONTHLY_BILLING_PAY_TYPE,
  POLICY_OBJECT, TARGET_NON_CONTRIB, applyBill2Corrections, applyBill4Corrections,
  buildBill2CorrectionRow, buildBill4CorrectionRow, calculateBill4Correction,
  parseMoneyStrict, pullBill2Corrections, pullBill4Corrections, resolveBill4Fields,
  summarizeCorrectionResults,
};
