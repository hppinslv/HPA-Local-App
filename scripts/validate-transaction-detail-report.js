const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  getMonthlyReportType,
} = require("../services/reportCatalog");
const {
  DETAIL_COLUMNS,
  buildDetailWorkbook,
  buildTransactionDetailReport,
} = require("../services/transactionDetailReportService");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runPowerShell(command) {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "PowerShell command failed.");
  }
}

function main() {
  const reportType = getMonthlyReportType("transaction-detail");
  assert(reportType, "transaction-detail report type is missing.");

  const configuredIds = reportType.salesforceReports.map((entry) => entry.reportId);
  assert(
    configuredIds.includes("00Of4000008DtM5EAK") &&
      configuredIds.includes("00O5G000008KqHSUA0") &&
      configuredIds.includes("00O5G000008KqHXUA0"),
    "Not all three transaction detail Salesforce report IDs are configured."
  );

  const mockSourceData = {
    source: "validation-fixture",
    configuredReports: reportType.salesforceReports,
    rawTabs: [
      {
        key: "paymentSummary",
        rows: [
          {
            certificateNumber: "100001",
            transactionDate: "2026-05-03",
            typeReceived: "3",
            payType: "BILL",
            amount: 125.5,
            checkNumber: "5001",
            authCode: "AUTH123",
            approval: "APPROVAL",
            gatewayTxnId: "GTX-1",
            gatewayResponseMessage: "Success",
          },
        ],
      },
      {
        key: "creditsSummary",
        rows: [
          {
            certificateNumber: "100002",
            transactionDate: "2026-05-05",
            type: "Credit Card",
            payType: "CC",
            amount: -42.25,
            checkNumber: "",
            approval: "CB-77",
            reasonForCredit: "Duplicate Payment",
          },
        ],
      },
      {
        key: "policyType",
        rows: [
          { certificateNumber: "100001", policyType: "2 Member", members: "2" },
          { certificateNumber: "100002", policyType: "1 Member", members: "1" },
        ],
      },
    ],
  };

  const report = buildTransactionDetailReport("2026-05", mockSourceData);
  assert(report.rows.length === 2, "Payment and credit rows did not combine correctly.");
  assert(
    report.rows[0].policyType === "2 Member" && report.rows[1].policyType === "1 Member",
    "Policy type lookup did not populate from the policy type report."
  );
  assert(
    report.systemChecks?.[0]?.status === "passed",
    "System check did not pass for the validation fixture."
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-detail-validate-"));
  const workbookPath = path.join(tempDir, "transaction-detail.xlsx");
  const workbookZipPath = path.join(tempDir, "transaction-detail.zip");
  const unzipDir = path.join(tempDir, "unzipped");

  buildDetailWorkbook(report, workbookPath);
  assert(fs.existsSync(workbookPath), "Workbook was not generated.");
  fs.copyFileSync(workbookPath, workbookZipPath);

  runPowerShell(
    `Expand-Archive -LiteralPath '${workbookZipPath}' -DestinationPath '${unzipDir}' -Force`
  );

  const sheetXml = fs.readFileSync(
    path.join(unzipDir, "xl", "worksheets", "sheet5.xml"),
    "utf8"
  );

  assert(sheetXml.includes("Reason_for_Credit__c"), "Sheet1 is missing the reason column.");

  const headerCount = DETAIL_COLUMNS.filter((column) => sheetXml.includes(column)).length;
  assert(
    headerCount === DETAIL_COLUMNS.length,
    "Sheet1 does not contain the expected transaction detail columns."
  );

  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("Validation passed:");
  console.log("1. all 3 report IDs are configured");
  console.log("2. payment and credit rows combine correctly");
  console.log("3. policy type lookup populates from the policy type report");
  console.log("4. final XLSX contains Sheet1 with the expected columns");
}

main();
