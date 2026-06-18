function formatReportMonth(monthValue) {
  const [year, month] = String(monthValue).split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

module.exports = {
  formatReportMonth,
};
