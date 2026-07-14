const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadFreshBillServices(tempDir) {
  process.env.HPA_BILL_DATA_DIR = tempDir;
  const billRunPath = require.resolve("../services/billRunService");
  const billDatePath = require.resolve("../services/billDateService");
  delete require.cache[billRunPath];
  delete require.cache[billDatePath];
  return {
    billRunService: require("../services/billRunService"),
    billDateService: require("../services/billDateService"),
  };
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpa-bills-test-"));
}

test("createBillRun generates the base run code for the first month run", () => {
  const tempDir = createTempDir();
  const { billRunService } = loadFreshBillServices(tempDir);
  const run = billRunService.createBillRun({
    billMonth: "2026-07",
    createdBy: "Melinda",
  });

  assert.equal(run.runCode, "BILL-2026-07");
  assert.equal(run.status, "Draft");
  assert.equal(run.activeStage, "Create Monthly Run");
  assert.equal(run.dates.processingDate, "2026-07-14");
});

test("duplicate active runs are blocked without an override", () => {
  const tempDir = createTempDir();
  const { billRunService } = loadFreshBillServices(tempDir);
  billRunService.createBillRun({
    billMonth: "2026-07",
    createdBy: "Melinda",
  });

  assert.throws(
    () =>
      billRunService.createBillRun({
        billMonth: "2026-07",
        createdBy: "Melinda",
      }),
    /active bill run already exists/i
  );
});

test("duplicate runs require an override reason and create rerun codes", () => {
  const tempDir = createTempDir();
  const { billRunService } = loadFreshBillServices(tempDir);
  billRunService.createBillRun({
    billMonth: "2026-07",
    createdBy: "Melinda",
  });

  const rerun = billRunService.createBillRun({
    billMonth: "2026-07",
    createdBy: "Melinda",
    allowDuplicateOverride: true,
    duplicateOverrideReason: "Original run used the wrong date mapping.",
  });

  assert.equal(rerun.runCode, "BILL-2026-07-R2");
  assert.equal(rerun.duplicateOverrideReason, "Original run used the wrong date mapping.");
});

test("updateBillRun persists status transitions and audit events", () => {
  const tempDir = createTempDir();
  const { billRunService } = loadFreshBillServices(tempDir);
  const created = billRunService.createBillRun({
    billMonth: "2026-08",
    createdBy: "Melinda",
  });

  const updated = billRunService.updateBillRun(created.id, {
    status: "Pending Approval",
    activeStage: "Review and Approve",
    actor: "Reviewer A",
  });

  assert.equal(updated.status, "Pending Approval");
  assert.equal(updated.activeStage, "Review and Approve");
  assert.equal(updated.events.at(-1).performedBy, "Reviewer A");
  assert.equal(updated.events.at(-1).newStatus, "Pending Approval");
});

test("calculateBillDates handles year rollover and ordinals", () => {
  const tempDir = createTempDir();
  const { billDateService } = loadFreshBillServices(tempDir);
  const dates = billDateService.calculateBillDates("2026-12", {
    normalProcessingDay: 14,
    paymentDueDay: 1,
    lapseDeadlineDay: 14,
  });

  assert.equal(dates.processingDate, "2026-12-14");
  assert.equal(dates.bill2UpcomingMonth, "JANUARY, 2027");
  assert.equal(dates.bill3LapseDeadline, "2027-01-14");
  assert.equal(dates.processingDateOrdinalLong, "December 14th, 2026");
  assert.equal(billDateService.formatOrdinalDay(21), "21st");
  assert.equal(billDateService.formatOrdinalDay(22), "22nd");
  assert.equal(billDateService.formatOrdinalDay(23), "23rd");
  assert.equal(billDateService.formatOrdinalDay(31), "31st");
});
