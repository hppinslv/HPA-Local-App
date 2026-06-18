const { formatReportMonth } = require("../../../../services/monthlyReportServiceHelpers");
const { buildFinalRows } = require("./buildFinalRows");
const { combineTransactions, summarizeTransactions } = require("./combineTransactions");
const { fetchReports } = require("./fetchReports");
const { normalizeDatasets } = require("./normalize");
const { validateReport } = require("./validate");

async function buildAmalgamatedPremiumRemittanceReport({
  reportMonth,
  sourceMode = "live",
  uploadedFiles = {},
  monthlySummaryPremiumTotal = null,
}) {
  const sourceResult = await fetchReports({
    reportMonth,
    sourceMode,
    uploadedFiles,
  });
  const datasets = normalizeDatasets(sourceResult.rawDatasets);
  const combinedTransactions = combineTransactions(datasets.payments, datasets.credits);
  const summarizedTransactions = summarizeTransactions(combinedTransactions).filter(
    (row) => String(row.certificateNumber || "").trim() !== ""
  );
  const finalData = buildFinalRows(reportMonth, datasets, summarizedTransactions);
  const validationResult = validateReport({
    datasets,
    combinedTransactions,
    summarizedTransactions,
    finalRows: finalData.rows,
    monthlySummaryPremiumTotal,
  });

  return {
    reportType: "amalgamated-premium-remittance",
    reportName: "Amalgamated Premium Remittance",
    reportMonth,
    reportMonthLabel: formatReportMonth(reportMonth),
    generatedAt: new Date().toISOString(),
    source: sourceResult.source,
    sourceMode,
    sourceSheets: sourceResult.sourceSheets,
    rows: finalData.rows,
    columns: finalData.finalColumns,
    totals: finalData.totals,
    issues: validationResult.issues,
    warnings: validationResult.warnings,
    blockingErrors: validationResult.blockingErrors,
    validation: validationResult.validation,
    summary: validationResult.summary,
  };
}

module.exports = {
  buildAmalgamatedPremiumRemittanceReport,
};
