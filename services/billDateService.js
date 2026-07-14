const DEFAULT_BILL_SETTINGS = Object.freeze({
  normalProcessingDay: 14,
  paymentDueDay: 1,
  lapseDeadlineDay: 14,
  maximumTotalCoverage: 503000,
  requiredNonContributoryCoverage: 3000,
  maximumContributoryCoverage: 500000,
});

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function toDateParts(monthValue) {
  const normalized = String(monthValue || "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error("Bill month must use YYYY-MM format.");
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error("Bill month must use a valid YYYY-MM value.");
  }
  return { year, monthIndex };
}

function clampDay(year, monthIndex, day) {
  const requestedDay = Number(day);
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  if (!Number.isFinite(requestedDay) || requestedDay <= 0) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(requestedDay)), lastDay);
}

function buildLocalDate(year, monthIndex, day) {
  return new Date(year, monthIndex, clampDay(year, monthIndex, day), 12, 0, 0, 0);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate(), 12, 0, 0, 0);
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatSlashDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function formatLongDate(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatUpperMonth(date, includeYear = false) {
  const month = MONTH_NAMES[date.getMonth()].toUpperCase();
  return includeYear ? `${month}, ${date.getFullYear()}` : month;
}

function getOrdinalSuffix(day) {
  const normalizedDay = Number(day);
  if (!Number.isInteger(normalizedDay) || normalizedDay <= 0) {
    throw new Error("Ordinal day must be a positive integer.");
  }
  const mod100 = normalizedDay % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return "th";
  }
  switch (normalizedDay % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatOrdinalDay(day) {
  const normalizedDay = Number(day);
  if (!Number.isInteger(normalizedDay) || normalizedDay <= 0) {
    throw new Error("Ordinal day must be a positive integer.");
  }
  return `${normalizedDay}${getOrdinalSuffix(normalizedDay)}`;
}

function formatOrdinalLongDate(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${formatOrdinalDay(date.getDate())}, ${date.getFullYear()}`;
}

function normalizeSettings(overrides = {}) {
  return {
    ...DEFAULT_BILL_SETTINGS,
    ...Object.fromEntries(
      Object.entries(overrides || {}).map(([key, value]) => [key, Number.isFinite(Number(value)) ? Number(value) : value])
    ),
  };
}

function calculateBillDates(billMonth, settings = {}) {
  const resolvedSettings = normalizeSettings(settings);
  const { year, monthIndex } = toDateParts(billMonth);
  const processingDate = buildLocalDate(year, monthIndex, resolvedSettings.normalProcessingDay);
  const paymentDueDate = buildLocalDate(year, monthIndex, resolvedSettings.paymentDueDay);
  const nextMonth = addMonths(paymentDueDate, 1);
  const previousMonth = addMonths(paymentDueDate, -1);
  const twoMonthsBack = addMonths(paymentDueDate, -2);
  const lapseDeadlineDate = buildLocalDate(nextMonth.getFullYear(), nextMonth.getMonth(), resolvedSettings.lapseDeadlineDay);
  const bill4LapsedEffectiveDate = buildLocalDate(previousMonth.getFullYear(), previousMonth.getMonth(), 1);
  const bill4ReinstatementReferenceDate = buildLocalDate(nextMonth.getFullYear(), nextMonth.getMonth(), 1);

  return {
    processingDate: formatIsoDate(processingDate),
    processingDateDisplay: formatSlashDate(processingDate),
    processingDateLong: formatLongDate(processingDate),
    processingDateOrdinalLong: formatOrdinalLongDate(processingDate),
    bill1DueDate: formatIsoDate(paymentDueDate),
    bill1DueDateDisplay: formatSlashDate(paymentDueDate),
    bill2OriginalOverdueMonth: formatUpperMonth(previousMonth, true),
    bill2UpcomingMonth: formatUpperMonth(nextMonth, true),
    bill3FirstOverdueMonth: formatUpperMonth(twoMonthsBack, true),
    bill3SecondOverdueMonth: formatUpperMonth(previousMonth, true),
    bill3NextDueDate: formatIsoDate(nextMonth),
    bill3NextDueDateDisplay: formatLongDate(nextMonth),
    bill3LapseDeadline: formatIsoDate(lapseDeadlineDate),
    bill3LapseDeadlineDisplay: formatLongDate(lapseDeadlineDate),
    bill3LapseDeadlineOrdinalDisplay: formatOrdinalLongDate(lapseDeadlineDate),
    bill4LapsedEffectiveDate: formatIsoDate(bill4LapsedEffectiveDate),
    bill4LapsedEffectiveDateDisplay: formatLongDate(bill4LapsedEffectiveDate),
    bill4ReinstatementReferenceDate: formatIsoDate(bill4ReinstatementReferenceDate),
    bill4ReinstatementReferenceDateDisplay: formatLongDate(bill4ReinstatementReferenceDate),
    documentMonthLabel: formatUpperMonth(paymentDueDate, true),
    documentMonthShortLabel: formatUpperMonth(paymentDueDate, false),
    processingMonthLabel: `${MONTH_NAMES[monthIndex]} ${year}`,
    billMonth,
    settings: resolvedSettings,
  };
}

module.exports = {
  DEFAULT_BILL_SETTINGS,
  calculateBillDates,
  formatOrdinalDay,
  normalizeSettings,
};
