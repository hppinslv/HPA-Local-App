const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLabel } = require("../services/salesforceClient");
const { BILLING_REPORTS, retrieveBillingReports, sortAndValidateRows, validateBill4Pairing } = require("../services/billSpreadsheetService");

function raw(certificate, id, extra = {}) {
  const values = {
    "Certificate Number: Certificate Name": certificate, "Policy ID": id,
    "Member 1": "Test Member", "Certificate Number: Billing Street": "1 Test Way",
    "Certificate Number: Billing City": "Test City", "Certificate Number: Billing State/Province": "NV",
    "Certificate Number: Billing Zip/Postal Code": "89101", "Bill For": "Test Period",
    P1: 1, P2: 2, P3: 3, P6: 6, P12: 12,
    ...extra,
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [normalizeLabel(key), value]));
}

test("certificate sorting is numeric while original formatting is retained", () => {
  const result = sortAndValidateRows("bill1", [raw("260647", "c"), raw("00150209", "a"), raw("150218", "b")]);
  assert.deepEqual(result.rows.map((row) => row.certificateNumber), ["00150209", "150218", "260647"]);
  assert.equal(result.sortingVerified, true);
});

test("duplicates are distinguished by record ID and flagged", () => {
  const result = sortAndValidateRows("bill1", [raw("150209", "b"), raw("150209", "a")]);
  assert.deepEqual(result.rows.map((row) => row.recordId), ["a", "b"]);
  assert.equal(result.errors.filter((entry) => /Duplicate/.test(entry.error)).length, 2);
});

test("all four authoritative reports remain separate and retain Salesforce amounts", async () => {
  const seen = [];
  const datasets = await retrieveBillingReports({ fetchReport: async (id) => {
    seen.push(id);
    const group = Object.entries(BILLING_REPORTS).find(([, reportId]) => reportId === id)[0];
    const extras = group === "bill2" ? { "Bill Due": "12/1/2026", "Bill 2 Next (+1)": "January 2027" }
      : group === "bill3" ? { "Bill For Long": "December 2026", "Bill Due": "12/1/2026", "Bill 3 Next (+1)": "January 2027", "Bill 3 Next (+2)": "February 2027", Lapse: "January 14, 2027" }
        : group === "bill4" ? { "Bill 4 Due": "12/1/2026", "Bill Due": "12/1/2026", "Bill For Long": "December 2026", "Coverage Production": 503000, "Rate Text": "will be" } : {};
    return { reportName: group, rows: [raw("150209", `${group}-id`, extras)] };
  } });
  assert.deepEqual(seen, Object.values(BILLING_REPORTS));
  assert.equal(datasets.bill1.rows[0].values.P12, 12);
  assert.equal(datasets.bill4.rows[0].values["Coverage Production"], 503000);
});

test("missing Salesforce amounts are reported rather than calculated", () => {
  const row = raw("150209", "a");
  delete row[normalizeLabel("P6")];
  const result = sortAndValidateRows("bill1", [row]);
  assert.match(result.errors.map((entry) => entry.error).join(" "), /P6 is missing/);
});

test("Bill 4 pairing validates certificate and record identity, not list length", () => {
  const rows = sortAndValidateRows("bill4", [raw("150209", "a", { "Coverage Production": 100 })]).rows;
  assert.equal(validateBill4Pairing(rows, rows.map((row) => ({ ...row }))).valid, true);
  assert.equal(validateBill4Pairing(rows, [{ ...rows[0], recordId: "wrong" }]).valid, false);
});
