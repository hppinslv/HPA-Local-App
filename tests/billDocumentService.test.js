const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Office generator renders the six ordered PDFs and audit package", { skip: process.env.HPA_RUN_OFFICE_TESTS !== "true", timeout: 10 * 60 * 1000 }, async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-billing-doc-test-"));
  process.env.HPA_BILL_OUTPUT_DIR = outputRoot;
  delete require.cache[require.resolve("../services/billWorkflowService")];
  const { runOfficeGenerator, validateGeneratedBillingPdfs } = require("../services/billWorkflowService");
  const common = {
    "Certificate Number: Certificate Name": "00150209",
    "Member 1": "TEST MEMBER", "Member 2": "",
    "Certificate Number: Billing Street": "1 TEST WAY",
    "Certificate Number: Billing City": "TEST CITY",
    "Certificate Number: Billing State/Province": "NV",
    "Certificate Number: Billing Zip/Postal Code": "89101",
    "Bill For": "TEST PERIOD", P1: 10, P2: 20, P3: 30, P6: 60, P12: 120,
  };
  const item = (group, values) => ({ group, recordId: `${group}-record`, certificateNumber: "00150209", certificateNumeric: "150209", values });
  try {
    const datasets = {
      bill1: { rows: [item("bill1", common)] },
      bill2: { rows: [item("bill2", { ...common, "Bill Due": "12/1/2026", "Bill 2 Next (+1)": "JANUARY, 2027" })] },
      bill3: { rows: [item("bill3", { ...common, "Bill For Long": "December 2026", "Bill Due": "12/1/2026", "Bill 3 Next (+1)": "January 2027", "Bill 3 Next (+2)": "February 2027", Lapse: "January 14, 2027" })] },
      bill4: { rows: [item("bill4", { ...common, "Bill 4 Due": "12/1/2026", "Bill Due": "12/1/2026", "Bill For Long": "December 1, 2026", "Coverage Production": 503000, "Rate Text": "will be" })] },
    };
    const generated = runOfficeGenerator({
      run: { id: "test-run", runCode: "BILL-TEST", billMonth: "2026-12", dates: { bill3FirstOverdueMonth: "OCTOBER, 2026", bill3LapseDeadlineDisplay: "January 14, 2027" } },
      corrections: { bill2: [], bill4: [], summary: { updated: 0, unchanged: 0, coverageReductions: 0 } },
      datasets,
      bill4Pairing: { valid: true },
    });
    assert.equal(generated.valid, true, (generated.errors || []).join(" "));
    const names = generated.artifacts.map((artifact) => artifact.fileName);
    for (const required of ["Bill1_2026-12.pdf", "Bill2_2026-12.pdf", "Bill3_2026-12.pdf", "Bill4_2026-12.pdf", "Bill3_Important_Notice_2026-12.pdf", "Bill4_Important_Notice_2026-12.pdf", "Bill_Spreadsheet_2026-12.xlsx", "Bill_Corrections_2026-12.xlsx", "Billing_Reconciliation_2026-12.xlsx", "Billing_Run_Summary_2026-12.pdf", "Billing_Package_2026-12.zip"]) assert.ok(names.includes(required), required);
    assert.equal(generated.recordCounts.bill3Notices, 1);
    assert.equal(generated.recordCounts.bill4Notices, 1);
    const validation = await validateGeneratedBillingPdfs(generated, datasets);
    assert.equal(validation.valid, true, validation.errors.join(" "));
    assert.ok(Object.values(validation.details).every((detail) => detail.pages === 1));
  } finally {
    if (process.env.HPA_KEEP_OFFICE_TEST_OUTPUT === "true") console.log(`Synthetic billing QA output: ${outputRoot}`);
    else fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
