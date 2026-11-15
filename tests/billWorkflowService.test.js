const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLabel } = require("../services/salesforceClient");
const { BILL2_CORRECTION_REPORT_ID, BILL4_CORRECTION_REPORT_ID } = require("../services/billCorrectionServiceV2");
const { BILLING_REPORTS } = require("../services/billSpreadsheetService");

function row(values) { return Object.fromEntries(Object.entries(values).map(([key, value]) => [normalizeLabel(key), value])); }

test("billing writes are disabled unless deployment approval enables them", async () => {
  const previous = process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED;
  delete process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED;
  const { runCorrections } = require("../services/billWorkflowService");
  await assert.rejects(() => runCorrections({ billMonth: "2026-12" }), /writes are disabled/i);
  if (previous === undefined) delete process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED;
  else process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED = previous;
});

test("monthly workflow gates reports after verified corrections and generates from sorted fresh data", async () => {
  const previous = process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED;
  process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED = "true";
  const { runMonthlyBilling } = require("../services/billWorkflowService");
  const records = {
    b2: { Pay_Type__c: "ACH" },
    b4: { Contrib__c: 300000, NonContrib__c: 7000, Premium__c: 25 },
  };
  const gateway = {
    async read(id) { return { ...records[id] }; },
    async update(id, changes) { Object.assign(records[id], changes); },
  };
  const calls = [];
  const common = (certificate, id) => row({
    "Certificate Number: Certificate Name": certificate, "Policy ID": id,
    "Member 1": "Test Member", "Certificate Number: Billing Street": "1 Test Way",
    "Certificate Number: Billing City": "Test City", "Certificate Number: Billing State/Province": "NV",
    "Certificate Number: Billing Zip/Postal Code": "89101", "Bill For": "Test Period",
    P1: 1, P2: 2, P3: 3, P6: 6, P12: 12,
  });
  const fetchReport = async (id) => {
    calls.push(id);
    if (id === BILL2_CORRECTION_REPORT_ID) return { reportName: "b2 correction", rows: [row({ "Policy ID": "b2", "Pay Type": "ACH" })] };
    if (id === BILL4_CORRECTION_REPORT_ID) return { reportName: "b4 correction", rows: [row({ "Policy ID": "b4", "Orig Contrib AD&D Coverage Amt": 300000, "Orig Non-Contrib AD&D Coverage Amt": 7000 })] };
    const group = Object.entries(BILLING_REPORTS).find(([, reportId]) => reportId === id)[0];
    const extras = group === "bill2" ? { "Bill Due": "12/1/2026", "Bill 2 Next (+1)": "January 2027" }
      : group === "bill3" ? { "Bill For Long": "December 2026", "Bill Due": "12/1/2026", "Bill 3 Next (+1)": "January 2027", "Bill 3 Next (+2)": "February 2027", Lapse: "January 14, 2027" }
        : group === "bill4" ? { "Bill 4 Due": "12/1/2026", "Bill Due": "12/1/2026", "Bill For Long": "December 2026", "Coverage Production": 307000, "Rate Text": "will be" } : {};
    return { reportName: group, rows: [common("260647", `${group}-2`), common("150209", `${group}-1`)].map((item) => ({ ...item, ...row(extras) })) };
  };
  const stages = [];
  try {
    const result = await runMonthlyBilling({ id: "run", runCode: "BILL-2026-12", billMonth: "2026-12", dates: { bill3LapseDeadlineDisplay: "January 14, 2027" } }, {
      progress: async (stage) => stages.push(stage),
      validatePdfs: false,
      dependencies: { fetchReport, gateway, fields: { contrib: "Contrib__c", nonContrib: "NonContrib__c", premium: "Premium__c" } },
      generatePackage: ({ datasets }) => ({ valid: true, artifacts: [], outputDirectory: "test", pageCounts: {}, first: datasets.bill1.rows[0].certificateNumber }),
    });
    assert.equal(records.b2.Pay_Type__c, "Monthly Billing");
    assert.deepEqual([records.b4.Contrib__c, records.b4.NonContrib__c, records.b4.Premium__c], [304000, 3000, 25]);
    assert.equal(result.datasets.bill1.rows[0].certificateNumber, "150209");
    assert.deepEqual(calls.slice(0, 2).sort(), [BILL2_CORRECTION_REPORT_ID, BILL4_CORRECTION_REPORT_ID].sort());
    assert.ok(calls.indexOf(BILLING_REPORTS.bill1) > 1);
    assert.equal(stages.at(-1), "Ready to Download");
  } finally {
    if (previous === undefined) delete process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED;
    else process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED = previous;
  }
});
