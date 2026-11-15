const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLabel } = require("../services/salesforceClient");

const {
  BILL2_CORRECTION_REPORT_ID,
  BILL2_PAYMENT_TYPE_FIELD,
  BILL2_PREMIUM_FIELD,
  MONTHLY_BILLING_PAY_TYPE,
  applyBill2Corrections,
  applyBill4Corrections,
  buildBill2CorrectionRow,
  buildBill4CorrectionRow,
  calculateBill4Correction,
  pullBill2Corrections,
} = require("../services/billCorrectionServiceV2");

function reportRow(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [normalizeLabel(key), value]));
}

function memoryGateway(records, options = {}) {
  const updates = [];
  return {
    updates,
    async read(id) {
      if (options.readError) throw new Error(options.readError);
      return { ...records[id] };
    },
    async update(id, changes) {
      if (options.updateError) throw new Error(options.updateError);
      updates.push({ id, changes: { ...changes } });
      if (!options.ignoreUpdate) Object.assign(records[id], changes);
    },
  };
}

test("Bill 2 pulls every report row and uses the authoritative report/value", async () => {
  const source = ["CC", "ACH", "Credit Card", "Monthly Billing", "Other"].map((payType, index) => reportRow({ "Policy ID": `p${index}`, "Pay Type": payType }));
  const pulled = await pullBill2Corrections("2026-12", { fetchReport: async (id) => {
    assert.equal(id, BILL2_CORRECTION_REPORT_ID);
    return { reportName: "Bill 2 Correction", rows: source };
  } });
  assert.equal(pulled.rows.length, 5);
  assert.deepEqual(pulled.rows.map((row) => row.targetPayType), Array(5).fill("Monthly Billing"));
  assert.deepEqual(pulled.rows.map((row) => row.targetPayTypeValue), Array(5).fill(MONTHLY_BILLING_PAY_TYPE));
  assert.equal(pulled.rows[3].status, "Unchanged");
});

test("Bill 2 updates all nonmatching types, skips matching values, and verifies rereads", async () => {
  const records = {
    p1: { [BILL2_PAYMENT_TYPE_FIELD]: "2", [BILL2_PREMIUM_FIELD]: 81.42, Other__c: "keep" },
    p2: { [BILL2_PAYMENT_TYPE_FIELD]: "1", [BILL2_PREMIUM_FIELD]: 25.87 },
    p3: { [BILL2_PAYMENT_TYPE_FIELD]: "3", [BILL2_PREMIUM_FIELD]: 54.27 },
  };
  const gateway = memoryGateway(records);
  const rows = ["p1", "p2", "p3"].map((policyId) => ({ policyId, status: "Ready" }));
  const results = await applyBill2Corrections(rows, { gateway });
  assert.equal(gateway.updates.length, 2);
  assert.ok(gateway.updates.every((entry) => Object.keys(entry.changes).length === 1));
  assert.ok(results.every((row) => /Verified$/.test(row.status)));
  assert.equal(records.p1.Other__c, "keep");
});

test("Bill 2 does not report success when the saved value cannot be verified", async () => {
  const records = { p1: { [BILL2_PAYMENT_TYPE_FIELD]: "2", [BILL2_PREMIUM_FIELD]: 42 } };
  const results = await applyBill2Corrections([{ policyId: "p1", status: "Ready" }], { gateway: memoryGateway(records, { ignoreUpdate: true }) });
  assert.equal(results[0].status, "Failed");
  assert.match(results[0].error, /Verification returned/i);
});

test("Bill 2 fails verification if Salesforce automation changes the stored premium", async () => {
  const records = { p1: { [BILL2_PAYMENT_TYPE_FIELD]: "2", [BILL2_PREMIUM_FIELD]: 81.42 } };
  const gateway = {
    async read(id) { return { ...records[id] }; },
    async update(id, changes) {
      Object.assign(records[id], changes);
      records[id][BILL2_PREMIUM_FIELD] = 99;
    },
  };
  const results = await applyBill2Corrections([{ policyId: "p1", status: "Ready" }], { gateway });
  assert.equal(results[0].status, "Failed");
  assert.match(results[0].error, /premium changed/i);
});

test("Bill 4 calculations preserve coverage, cap coverage, and ignore non-7000 values", () => {
  assert.deepEqual(calculateBill4Correction(300000, 7000), {
    requiresUpdate: true, originalContrib: 300000, originalNonContrib: 7000, originalTotal: 307000,
    newContrib: 304000, newNonContrib: 3000, newTotal: 307000, coverageDecreased: false,
  });
  assert.equal(calculateBill4Correction(496000, 7000).newContrib, 500000);
  assert.deepEqual(calculateBill4Correction(500000, 7000), {
    requiresUpdate: true, originalContrib: 500000, originalNonContrib: 7000, originalTotal: 507000,
    newContrib: 500000, newNonContrib: 3000, newTotal: 503000, coverageDecreased: true,
  });
  assert.equal(calculateBill4Correction(400000, 3000).requiresUpdate, false);
});

test("Bill 4 invalid values become explicit data errors", () => {
  const row = buildBill4CorrectionRow(reportRow({ "Policy ID": "p1", "Orig Contrib AD&D Coverage Amt": "bad", "Orig Non-Contrib AD&D Coverage Amt": 7000 }));
  assert.equal(row.status, "Data Error");
  assert.match(row.error, /not numeric/i);
  assert.throws(() => calculateBill4Correction(-1, 7000), /negative/i);
});

test("Bill 4 accepts Salesforce currency cells and skips non-7000 rows without a write", async () => {
  const built = buildBill4CorrectionRow(reportRow({
    "Policy ID": "p1",
    "Orig Contrib AD&D Coverage Amt": { amount: 143000, currency: null },
    "Orig Non-Contrib AD&D Coverage Amt": { amount: 3000, currency: null },
  }));
  assert.equal(built.status, "Unchanged");
  assert.equal(built.originalContrib, 143000);
  const result = await applyBill4Corrections([built], { gateway: { read: async () => { throw new Error("should not read"); }, update: async () => { throw new Error("should not update"); } } });
  assert.equal(result[0].status, "Unchanged and Verified");
  assert.equal(result[0].updatePerformed, false);
});

test("Bill 4 updates only coverage fields, preserves premium, and verifies values", async () => {
  const fields = { contrib: "Contrib__c", nonContrib: "NonContrib__c", premium: "Premium__c" };
  const records = { p1: { Contrib__c: 500000, NonContrib__c: 7000, Premium__c: 42.5, Other__c: "keep" } };
  const gateway = memoryGateway(records);
  const result = await applyBill4Corrections([{ policyId: "p1", status: "Ready" }], { gateway, fields });
  assert.equal(result[0].status, "Updated and Verified");
  assert.equal(result[0].newTotal, 503000);
  assert.equal(result[0].premiumBefore, 42.5);
  assert.equal(result[0].premiumAfter, 42.5);
  assert.deepEqual(Object.keys(gateway.updates[0].changes).sort(), ["Contrib__c", "NonContrib__c"]);
  assert.equal(records.p1.Other__c, "keep");
});

test("Bill 4 restores the stored premium when Salesforce automation recalculates it", async () => {
  const fields = { contrib: "Contrib__c", nonContrib: "NonContrib__c", premium: "Premium__c" };
  const records = { p1: { Contrib__c: 154000, NonContrib__c: 7000, Premium__c: 54.82 } };
  const updates = [];
  const gateway = {
    async read(id) { return { ...records[id] }; },
    async update(id, changes) {
      updates.push({ ...changes });
      Object.assign(records[id], changes);
      if (Object.hasOwn(changes, "Contrib__c")) records[id].Premium__c = 56.14;
    },
  };
  const result = await applyBill4Corrections([{ policyId: "p1", status: "Ready" }], { gateway, fields });
  assert.equal(result[0].status, "Updated and Verified");
  assert.equal(result[0].premiumBefore, 54.82);
  assert.equal(result[0].premiumAfterCoverageUpdate, 56.14);
  assert.equal(result[0].premiumAfter, 54.82);
  assert.equal(result[0].premiumRestored, true);
  assert.deepEqual(updates.at(-1), { Premium__c: 54.82 });
});

test("Bill 4 rejects update and verification failures", async () => {
  const fields = { contrib: "Contrib__c", nonContrib: "NonContrib__c", premium: "Premium__c" };
  const records = { p1: { Contrib__c: 300000, NonContrib__c: 7000, Premium__c: 10 } };
  const failed = await applyBill4Corrections([{ policyId: "p1", status: "Ready" }], { gateway: memoryGateway(records, { updateError: "denied" }), fields });
  assert.equal(failed[0].status, "Failed");
  assert.match(failed[0].error, /denied/);
});

test("row builders retain identity and do not filter payment types", () => {
  const row = buildBill2CorrectionRow(reportRow({ "Policy ID": "p1", "Policy Name": "150209_AMAL", "Pay Type": "Wire" }));
  assert.equal(row.policyId, "p1");
  assert.equal(row.payType, "Wire");
  assert.equal(row.status, "Ready");
});
