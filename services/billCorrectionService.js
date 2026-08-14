const {
  fetchRawSalesforceReportRows,
  getConnectedSalesforceToken,
  normalizeLabel,
  salesforceRequest,
} = require("./salesforceClient");

const POLICY_REPORT_ID = "00OQm0000016PuPMAU";
const MONTHLY_BILLING_PAY_TYPE = "Monthly Bill";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function value(row, labels) {
  for (const label of labels) {
    const key = normalizeLabel(label);
    const candidate = row?.[key] ?? row?.[`${key} label`];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
  }
  return "";
}

function billTwoDate(billMonth) {
  const match = String(billMonth || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("Bill month must use YYYY-MM format.");
  return `${Number(match[2])}/${1}/${match[1]}`;
}

function isBillTwoRow(row, billMonth) {
  const billingName = String(value(row, ["Billing Name", "Name"])).toLowerCase();
  const targetDate = billTwoDate(billMonth).toLowerCase();
  return billingName.includes("bill_2") && billingName.includes(targetDate);
}

async function pullBill2Corrections(billMonth) {
  const report = await fetchRawSalesforceReportRows(POLICY_REPORT_ID);
  const rows = (report.rows || [])
    .filter((row) => isBillTwoRow(row, billMonth))
    .map((row) => ({
      policyId: String(value(row, ["Policy ID", "Policy Id", "Id", "Record ID"])).trim(),
      policyName: String(value(row, ["Policy Name", "Policy"])).trim(),
      billingName: String(value(row, ["Billing Name", "Name"])).trim(),
      payType: String(value(row, ["Pay Type", "Pay_Type__c"])).trim(),
      targetPayType: MONTHLY_BILLING_PAY_TYPE,
      sourceReportId: POLICY_REPORT_ID,
    }))
    .filter((row) => row.policyId && row.payType.toLowerCase() === "cc");

  return { reportId: POLICY_REPORT_ID, reportName: report.reportName, rows };
}

async function applyBill2Corrections(rows) {
  const tokenRecord = await getConnectedSalesforceToken();
  const results = [];
  for (const row of rows || []) {
    const policyId = String(row.policyId || "").trim();
    if (!policyId) continue;
    try {
      const response = await salesforceRequest(
        tokenRecord,
        `/services/data/v61.0/sobjects/Policy__c/${encodeURIComponent(policyId)}`,
        { method: "PATCH", body: JSON.stringify({ Pay_Type__c: MONTHLY_BILLING_PAY_TYPE }) }
      );
      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); } catch { /* ignore malformed error bodies */ }
        throw new Error(payload[0]?.message || payload.message || "Salesforce rejected the pay type update.");
      }
      results.push({ ...clone(row), status: "Updated" });
    } catch (error) {
      results.push({ ...clone(row), status: "Failed", error: error.message || String(error) });
    }
  }
  return results;
}

module.exports = { applyBill2Corrections, pullBill2Corrections, MONTHLY_BILLING_PAY_TYPE, POLICY_REPORT_ID };
