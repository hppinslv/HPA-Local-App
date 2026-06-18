const { fetchFlexibleSalesforceReportData } = require("../services/salesforceClient");

async function main() {
  const reportId = process.argv[2];
  if (!reportId) {
    throw new Error("Usage: node scripts/debug-analysis-grouped-report.js <reportId>");
  }

  const result = await fetchFlexibleSalesforceReportData(reportId, {
    keyCodes: ["n"],
    dateRange: {
      startDate: "2026-01-01",
      endDate: "2026-05-31",
    },
  });

  const describe = result.describePayload || {};
  const report = describe.reportMetadata || {};
  const payload = result.rawReportPayload || {};

  console.log(JSON.stringify({
    reportName: report.name,
    detailColumns: report.detailColumns,
    aggregates: report.aggregates,
    groupingsDown: payload.groupingsDown?.groupings?.slice(0, 3),
    groupingsAcross: payload.groupingsAcross?.groupings?.slice(0, 3),
    factMapKeys: Object.keys(payload.factMap || {}).slice(0, 20),
    sampleFactEntries: Object.entries(payload.factMap || {}).slice(0, 5).map(([key, value]) => ({
      key,
      aggregates: value?.aggregates,
      rowsCount: Array.isArray(value?.rows) ? value.rows.length : 0,
    })),
    firstRow: result.rows?.[0] || null,
    columns: result.columns,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
