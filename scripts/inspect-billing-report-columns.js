const { BILLING_REPORTS, sortAndValidateRows } = require("../services/billSpreadsheetService");
const { fetchRawSalesforceReportRows } = require("../services/salesforceClient");

async function main() {
  const results = {};
  for (const [group, reportId] of Object.entries(BILLING_REPORTS)) {
    const report = await fetchRawSalesforceReportRows(reportId, { failOnTruncatedReport: true });
    const row = report.rows?.[0] || {};
    const validation = sortAndValidateRows(group, report.rows || []);
    const amountStats = Object.fromEntries(["P1", "P2", "P3", "P6", "P12"].map((field) => {
      const values = (report.rows || []).map((entry) => {
        const raw = entry[field] ?? entry[field.toLowerCase()];
        return Number(raw && typeof raw === "object" ? raw.amount : raw);
      }).filter(Number.isFinite);
      return [field, {
        count: values.length,
        positive: values.filter((value) => value > 0).length,
        zero: values.filter((value) => value === 0).length,
        negative: values.filter((value) => value < 0).length,
        minimum: values.length ? Math.min(...values) : null,
        maximum: values.length ? Math.max(...values) : null,
      }];
    }));
    results[group] = {
      reportId,
      reportName: report.reportName,
      rowCount: report.rows?.length || 0,
      validRowCount: validation.rows.length,
      errorCount: validation.errors.length,
      errorSamples: validation.errors.slice(0, 5),
      amountStats,
      identityColumns: Object.fromEntries(
        Object.entries(row).filter(([key]) => /certificate|policy|record|account|(^|\s)id($|\s)|name/i.test(key)),
      ),
      billingValueColumns: Object.fromEntries(
        Object.entries(row).filter(([key]) => /^(?:P1|P2|P3|P6|P12|Bill Due|Bill 2 Next \(\+1\)|Bill 3 Next \(\+1\)|Bill 3 Next \(\+2\)|Lapse|Coverage Production|Rate Text)(?:__label)?$/.test(key)),
      ),
      allColumns: Object.keys(row),
    };
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
