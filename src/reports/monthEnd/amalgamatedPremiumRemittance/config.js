const {
  AHA_RATE,
  AMAL_RATE,
  FINAL_COLUMN_DEFS,
  FIXED_ORIG_EFFECTIVE_DATE,
  REPORT_ID,
  SALESFORCE_REPORTS,
  SHEET_NAMES,
  SOURCE_FILE_FIELDS,
  SOURCE_KEYS,
} = require("./types");

function formatShortMonth(reportMonth) {
  const [year, month] = String(reportMonth || "").split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function getDynamicColumnLabels(reportMonth) {
  const monthLabel = formatShortMonth(reportMonth);
  return {
    monthsPaidLabel: `Months Paid for in ${monthLabel}`,
    premiumCollectedLabel: `Premium Collected in ${monthLabel}`,
  };
}

function buildFinalColumns(reportMonth) {
  const dynamicLabels = getDynamicColumnLabels(reportMonth);
  return FINAL_COLUMN_DEFS.map((column) => {
    if (column.label === "__MONTHS_PAID_LABEL__") {
      return { ...column, label: dynamicLabels.monthsPaidLabel };
    }

    if (column.label === "__PREMIUM_COLLECTED_LABEL__") {
      return { ...column, label: dynamicLabels.premiumCollectedLabel };
    }

    return { ...column };
  });
}

module.exports = {
  AHA_RATE,
  AMAL_RATE,
  FIXED_ORIG_EFFECTIVE_DATE,
  REPORT_ID,
  SALESFORCE_REPORTS,
  SHEET_NAMES,
  SOURCE_FILE_FIELDS,
  SOURCE_KEYS,
  buildFinalColumns,
  formatShortMonth,
  getDynamicColumnLabels,
};
