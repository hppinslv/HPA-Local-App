const { fetchFlexibleSalesforceReportData } = require("../services/salesforceClient");

async function main() {
  const reportId = String(process.argv[2] || "").trim() || "00OQm000003PIxhMAG";
  const keyCode = String(process.argv[3] || "").trim() || "N";
  const startDate = String(process.argv[4] || "").trim() || "2026-01-01";
  const endDate = String(process.argv[5] || "").trim() || "2026-05-31";

  const result = await fetchFlexibleSalesforceReportData(reportId, {
    keyCodes: [keyCode],
    dateRange: {
      startDate,
      endDate,
    },
  });

  console.log(JSON.stringify({
    reportId,
    keyCode,
    startDate,
    endDate,
    sourcePath: result.diagnostics?.sourcePath || "",
    groupedReportUnavailableReason: result.groupedReportUnavailableReason || "",
    debugPayloadPath: result.diagnostics?.debugPayloadPath || "",
    rowDebugTrace: result.diagnostics?.rowDebugTrace || null,
    summaryValues: result.summaryValues || [],
    firstRows: Array.isArray(result.rows) ? result.rows.slice(0, 5) : [],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
