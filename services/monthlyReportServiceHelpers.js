function formatReportMonth(monthValue) {
  const [year, month] = String(monthValue).split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function formatReportMonthFilePrefix(monthValue) {
  const [year, month] = String(monthValue || "").trim().split("-");
  const normalizedYear = String(year || "").trim();
  const normalizedMonth = String(month || "").trim().padStart(2, "0");
  if (!/^\d{4}$/.test(normalizedYear) || !/^\d{2}$/.test(normalizedMonth)) {
    return "0000.00";
  }
  return `${normalizedYear}.${normalizedMonth}`;
}

function formatCompletionMonthFilePrefix(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return formatReportMonthFilePrefix("");
  }

  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}.${month}`;
}

module.exports = {
  formatReportMonth,
  formatCompletionMonthFilePrefix,
  formatReportMonthFilePrefix,
};
