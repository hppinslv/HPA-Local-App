const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { fetchMonthlySalesforceReportData } = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");
const {
  DEFAULT_MONTHLY_REPORT_TYPE,
  getMonthlyReportType,
} = require("./reportCatalog");
const {
  buildTransactionDetailReport,
  writeDetailArtifacts,
} = require("./transactionDetailReportService");
const {
  buildAmalgamatedPremiumRemittanceReport,
} = require("../src/reports/monthEnd/amalgamatedPremiumRemittance");
const {
  writeArtifacts: writeAmalgamatedArtifacts,
} = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/exportWorkbook");
const { formatReportMonth, formatReportMonthFilePrefix } = require("./monthlyReportServiceHelpers");
const {
  createPrintableArtifactFromHtml,
  generatePdfFromHtml,
} = require("./pdfPrintService");

const DATA_DIR = path.join(__dirname, "..", "data");
const GENERATED_DIR = path.join(__dirname, "..", "generated-reports");
const REPORT_RUNS_PATH = path.join(GENERATED_DIR, "report-runs.json");
const LEGACY_REPORT_RUNS_PATH = path.join(DATA_DIR, "report-runs.json");
const REPORT_RUNS_SUPABASE_KEY = "monthly-report-runs.json";
const WORKBOOK_TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "AHA HPA Transaction Summary.test.xlsm"
);
const FINAL_SUMMARY_LETTER_TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "Premier - Letter.docx"
);
const FINAL_SUMMARY_LETTER_REPORT_TYPE = "final-summary-letter";
const FINAL_SUMMARY_LETTER_REPORT_NAME = "Final Summary Letter";
const FINAL_SUMMARY_LETTER_RECIPIENT = [
  "Matthew Borella",
  "Premier Worksite Solutions",
  "700 Kinderkamack Road, Suite 205",
  "Oradell, NJ 07649",
];
const FINAL_SUMMARY_SIGNATURE = [
  "Melinda Harris",
  "Office Manager",
  "Home Protection Associates",
  "American Homeowners Association",
];
const STALE_RUNNING_REPORT_MS = 10 * 60 * 1000;

const FIXED_RULES = {
  amalgamatedPremiumRate: 0.41,
  hpaCommissionRate: 0.59,
  ftjFee: 5200,
  estimatedBankFee: 0,
};

const FINAL_REPORT_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "grossPremium", label: "Gross Premium" },
  { key: "amalgamatedPremium", label: "Amalgamated Premium" },
  { key: "hpaCommission", label: "HPA Commission" },
  { key: "ahaDues", label: "AHA Dues" },
  { key: "totalSubmitted", label: "Total Submitted" },
  { key: "numberOfMonths", label: "Number of Months" },
  { key: "numberOfCertificates", label: "Number of Certificates" },
];

const FINAL_REPORT_SECTIONS = [
  {
    sourceTab: "Billing Credits",
    finalLabel: "Totals - Billing - Credits (from TPA)",
    detailLabel: "Billing - Credits (from TPA)",
    signMultiplier: 1,
  },
  {
    sourceTab: "B & DD Refund",
    finalLabel: "Billing & Direct Debit - Refunds",
    detailLabel: "Billing & Direct Debit - Refunds",
    signMultiplier: -1,
  },
  {
    sourceTab: "B BC",
    finalLabel: "Billing - Bounced Checks",
    detailLabel: "Billing - Bounced Checks",
    signMultiplier: -1,
  },
  {
    sourceTab: "DD C",
    finalLabel: "Direct Debit (UMB Bank) - Credits",
    detailLabel: "Direct Debit (UMB Bank) - Credits",
    signMultiplier: 1,
  },
  {
    sourceTab: "DD Returned Items",
    finalLabel: "Direct Debit (UMB Bank) - Returned Items",
    detailLabel: "Direct Debit (UMB Bank) - Returned Items",
    signMultiplier: -1,
  },
  {
    sourceTab: "CC C",
    finalLabel: "Credit Cards (UMB) - Credits",
    detailLabel: "Credit Cards (UMB) - Credits",
    signMultiplier: 1,
  },
  {
    sourceTab: "CC R",
    finalLabel: "Credit Cards (UMB) - Refunds",
    detailLabel: "Credit Cards (UMB) - Refunds",
    signMultiplier: -1,
  },
  {
    sourceTab: "DD RR",
    finalLabel: "Direct Debit (M&T Bank) - Returned Refunds",
    detailLabel: "Direct Debit (M&T Bank) - Returned Refunds",
    signMultiplier: -1,
  },
];

let reportRunsDiskWritable = true;
let reportRunsInMemory = null;
let reportRunsPersistenceReady = false;

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) || clone(fallbackValue);
  } catch (error) {
    console.warn(`Unable to parse local state file ${filePath}:`, error.message);
    return clone(fallbackValue);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactReportPayload(reportType, report) {
  if (!report || typeof report !== "object") {
    return report || null;
  }

  if (reportType === "transaction-summary") {
    return {
      reportMonth: report.reportMonth || null,
      reportMonthLabel: report.reportMonthLabel || null,
      generatedAt: report.generatedAt || null,
      source: report.source || "",
      totals: report.totals || null,
      finalSummaryLetter: report.finalSummaryLetter || null,
    };
  }

  if (reportType === FINAL_SUMMARY_LETTER_REPORT_TYPE) {
    return {
      reportMonth: report.reportMonth || null,
      finalSummaryLetter: report.finalSummaryLetter || null,
    };
  }

  return {
    reportType: report.reportType || reportType || null,
    reportName: report.reportName || null,
    reportMonth: report.reportMonth || null,
    reportMonthLabel: report.reportMonthLabel || null,
    generatedAt: report.generatedAt || null,
    source: report.source || "",
    totals: report.totals || null,
    summary: report.summary || null,
  };
}

function compactRunForStorage(run) {
  if (!run || typeof run !== "object") {
    return run;
  }

  return {
    ...run,
    report: compactReportPayload(run.reportType, run.report),
  };
}

function compactRunsForStorage(runs) {
  return Array.isArray(runs) ? runs.map((run) => compactRunForStorage(run)) : [];
}

function getRunTimestamp(run) {
  const timestamp = new Date(run?.updatedAt || run?.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeStoredRuns(runs) {
  const now = Date.now();
  let changed = false;
  const normalizedRuns = compactRunsForStorage(Array.isArray(runs) ? clone(runs) : []);

  normalizedRuns.forEach((run) => {
    const status = String(run?.status || "").trim().toLowerCase();
    if (status !== "running") {
      return;
    }
    const lastUpdatedAt = getRunTimestamp(run);
    if (!lastUpdatedAt || now - lastUpdatedAt <= STALE_RUNNING_REPORT_MS) {
      return;
    }
    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    run.statusDetail =
      "This report run did not finish and was marked stale. Start the report again to generate a fresh output.";
    changed = true;
  });

  return {
    runs: normalizedRuns,
    changed,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStorage() {
  if (!reportRunsDiskWritable) {
    return;
  }

  ensureDir(GENERATED_DIR);

  if (!fs.existsSync(REPORT_RUNS_PATH)) {
    const seedRuns = fs.existsSync(LEGACY_REPORT_RUNS_PATH)
      ? fs.readFileSync(LEGACY_REPORT_RUNS_PATH, "utf8")
      : "[]\n";
    try {
      fs.writeFileSync(REPORT_RUNS_PATH, seedRuns, "utf8");
    } catch (error) {
      reportRunsDiskWritable = false;
      try {
        reportRunsInMemory = JSON.parse(seedRuns || "[]");
      } catch {
        reportRunsInMemory = [];
      }
    }
  }
}

function readRuns() {
  ensureStorage();

  if (Array.isArray(reportRunsInMemory)) {
    const normalizedMemory = normalizeStoredRuns(reportRunsInMemory);
    if (normalizedMemory.changed) {
      reportRunsInMemory = normalizedMemory.runs;
      writeRuns(reportRunsInMemory);
    }
    return clone(reportRunsInMemory);
  }

  if (!reportRunsDiskWritable) {
    reportRunsInMemory = [];
    return [];
  }

  if (fs.existsSync(REPORT_RUNS_PATH)) {
    try {
      const parsed = safeParseJson(REPORT_RUNS_PATH, []);
      if (Array.isArray(parsed)) {
        const normalizedDiskRuns = normalizeStoredRuns(parsed);
        reportRunsInMemory = normalizedDiskRuns.runs;
        if (normalizedDiskRuns.changed) {
          writeRuns(reportRunsInMemory);
        }
        return clone(reportRunsInMemory);
      }
    } catch {
      reportRunsDiskWritable = false;
    }
  }

  if (!Array.isArray(reportRunsInMemory)) {
    reportRunsInMemory = [];
  }

  return clone(reportRunsInMemory);
}

function writeRuns(runs) {
  const payload = compactRunsForStorage(Array.isArray(runs) ? clone(runs) : []);
  reportRunsInMemory = payload;

  try {
    ensureStorage();

    if (reportRunsDiskWritable) {
      fs.writeFileSync(REPORT_RUNS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
    queueStateSync(REPORT_RUNS_SUPABASE_KEY, payload);
    return;
  } catch (error) {
    if (reportRunsDiskWritable) {
      console.warn("Unable to persist monthly runs to disk, switching to in-memory mode:", error.message);
    }
    reportRunsDiskWritable = false;
  }
}

function updateStoredRun(runId, updater) {
  const runs = readRuns();
  const run = runs.find((entry) => entry.id === runId);
  if (!run) {
    return null;
  }
  updater(run, runs);
  writeRuns(runs);
  return run;
}

async function initializeReportRunPersistence() {
  if (reportRunsPersistenceReady) {
    return;
  }
  reportRunsPersistenceReady = true;

  const localRuns = safeParseJson(REPORT_RUNS_PATH, safeParseJson(LEGACY_REPORT_RUNS_PATH, []));
  const seededRuns = Array.isArray(localRuns) ? localRuns : [];
  let resolvedRuns = seededRuns;

  // In local workflow mode, keep the on-disk month-end history as the source of truth
  // whenever it already has saved rows. This avoids older synced state restoring
  // stale "running" entries after refresh.
  if (!seededRuns.length) {
    const remoteRuns = await loadStateObject(REPORT_RUNS_SUPABASE_KEY, seededRuns);
    if (Array.isArray(remoteRuns)) {
      resolvedRuns = remoteRuns;
    }
  }

  reportRunsInMemory = compactRunsForStorage(resolvedRuns);

  writeRuns(reportRunsInMemory);
}

function getPreviousMonthValue(referenceDate = new Date()) {
  const previousMonth = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth() - 1,
    1
  );
  const year = previousMonth.getFullYear();
  const month = String(previousMonth.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundCount(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toExcelDateNumber(isoDate) {
  const utcMillis = Date.parse(`${isoDate}T00:00:00Z`);
  return Math.floor(utcMillis / 86400000) + 25569;
}

function normalizeSourceRow(row, signMultiplier = 1) {
  const grossPremium = roundCurrency((row.grossPremium || 0) * signMultiplier);
  const ahaDues = roundCurrency((row.ahaDues || 0) * signMultiplier);
  const totalSubmitted = roundCurrency(
    row.totalSubmitted != null
      ? row.totalSubmitted * signMultiplier
      : grossPremium + ahaDues
  );
  const numberOfMonths = roundCount(row.numberOfMonths ?? row.monthsPaid ?? 1);
  const numberOfCertificates = roundCount(
    row.numberOfCertificates ?? row.certificateCount ?? 1
  );

  return {
    date: row.date,
    grossPremium,
    amalgamatedPremium: roundCurrency(
      grossPremium * FIXED_RULES.amalgamatedPremiumRate
    ),
    hpaCommission: roundCurrency(grossPremium * FIXED_RULES.hpaCommissionRate),
    ahaDues,
    totalSubmitted,
    numberOfMonths,
    numberOfCertificates,
  };
}

function createEmptyMetrics() {
  return {
    grossPremium: 0,
    amalgamatedPremium: 0,
    hpaCommission: 0,
    ahaDues: 0,
    totalSubmitted: 0,
    numberOfMonths: 0,
    numberOfCertificates: 0,
  };
}

function addMetrics(target, source) {
  target.grossPremium += source.grossPremium;
  target.amalgamatedPremium += source.amalgamatedPremium;
  target.hpaCommission += source.hpaCommission;
  target.ahaDues += source.ahaDues;
  target.totalSubmitted += source.totalSubmitted;
  target.numberOfMonths += source.numberOfMonths;
  target.numberOfCertificates += source.numberOfCertificates;
  return target;
}

function finalizeMetrics(metrics) {
  return {
    grossPremium: roundCurrency(metrics.grossPremium),
    amalgamatedPremium: roundCurrency(metrics.amalgamatedPremium),
    hpaCommission: roundCurrency(metrics.hpaCommission),
    ahaDues: roundCurrency(metrics.ahaDues),
    totalSubmitted: roundCurrency(metrics.totalSubmitted),
    numberOfMonths: roundCount(metrics.numberOfMonths),
    numberOfCertificates: roundCount(metrics.numberOfCertificates),
  };
}

function isZeroMetrics(metrics) {
  return FINAL_REPORT_COLUMNS.slice(1).every(({ key }) => Number(metrics[key] || 0) === 0);
}

function formatDateLabel(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function buildSection(tab, config) {
  const rowsByDate = new Map();

  tab.rows.forEach((rawRow) => {
    const normalized = normalizeSourceRow(rawRow, config.signMultiplier || 1);
    const existing =
      rowsByDate.get(normalized.date) || {
        date: normalized.date,
        ...createEmptyMetrics(),
      };

    addMetrics(existing, normalized);
    rowsByDate.set(normalized.date, existing);
  });

  const rows = Array.from(rowsByDate.values())
    .map((entry) => ({
      date: entry.date,
      dateLabel: formatDateLabel(entry.date),
      ...finalizeMetrics(entry),
    }))
    .filter((entry) => !isZeroMetrics(entry))
    .sort((left, right) => left.date.localeCompare(right.date));

  const totals = finalizeMetrics(
    rows.reduce((accumulator, row) => addMetrics(accumulator, row), createEmptyMetrics())
  );

  return {
    sourceTab: tab.tabName,
    finalLabel: config.finalLabel,
    detailLabel: config.detailLabel,
    transactionType: tab.transactionType,
    rows,
    totals,
  };
}

function buildFinalReport(reportMonth, sourceData) {
  const sections = FINAL_REPORT_SECTIONS.map((config) => {
    const tab = sourceData.rawTabs.find((entry) => entry.tabName === config.sourceTab);

    if (!tab) {
      return {
        sourceTab: config.sourceTab,
        finalLabel: config.finalLabel,
        transactionType: "",
        rows: [],
        totals: finalizeMetrics(createEmptyMetrics()),
      };
    }

    return buildSection(tab, config);
  });

  const grandTotals = finalizeMetrics(
    sections.reduce((accumulator, section) => addMetrics(accumulator, section.totals), createEmptyMetrics())
  );
  const feeAdjustedHpaCommission = roundCurrency(
    grandTotals.hpaCommission - FIXED_RULES.ftjFee
  );

  return {
    reportMonth,
    reportMonthLabel: formatReportMonth(reportMonth),
    generatedAt: new Date().toISOString(),
    source: sourceData.source,
    configuredReports: sourceData.configuredReports || [],
    columns: FINAL_REPORT_COLUMNS,
    sections,
    totals: {
      ...grandTotals,
      ftjFee: FIXED_RULES.ftjFee,
      estimatedBankFee: FIXED_RULES.estimatedBankFee,
      netHpaCommission: feeAdjustedHpaCommission,
    },
  };
}

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatLetterDate(dateValue = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(dateValue);
}

function formatLetterMonthLabel(reportMonth) {
  const [year, month] = String(reportMonth || "").split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  }).replace(" ", "-");
}

function buildLetterMonthParts(reportMonth) {
  const [year, month] = String(reportMonth || "").split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  const monthName = date.toLocaleDateString("en-US", { month: "long" });
  const yearText = String(year || "");

  return {
    monthName,
    year: yearText,
    longLabel: `${monthName} ${yearText}`.trim(),
    dashLabel: `${monthName}-${yearText}`.trim(),
  };
}

function buildFinalSummaryLetterData(report) {
  const totals = report?.totals || {};
  const fundsReceived = roundCurrency(Number(totals.totalSubmitted || 0));
  const amalgamatedPremium = roundCurrency(Number(totals.amalgamatedPremium || 0));
  const ahaDues = roundCurrency(Number(totals.ahaDues || 0));
  const monthParts = buildLetterMonthParts(report?.reportMonth);
  const letterData = {
    letterDate: formatLetterDate(),
    reportMonthLabel: formatLetterMonthLabel(report?.reportMonth),
    reportMonthName: monthParts.monthName,
    reportMonthYear: monthParts.year,
    reportMonthLongLabel: monthParts.longLabel,
    reportMonthDashLabel: monthParts.dashLabel,
    fundsReceived,
    amalgamatedPremium,
    hpaCommission: roundCurrency(fundsReceived - amalgamatedPremium - ahaDues),
    ahaDues,
    ftjFee: roundCurrency(Number(FIXED_RULES.ftjFee || 0)),
    bankFee: roundCurrency(Number(FIXED_RULES.estimatedBankFee || 0)),
  };

  return letterData;
}

function validateFinalSummaryLetterData(letterData) {
  const currencyKeys = [
    "fundsReceived",
    "amalgamatedPremium",
    "hpaCommission",
    "ahaDues",
    "ftjFee",
    "bankFee",
  ];

  currencyKeys.forEach((key) => {
    if (!Number.isFinite(Number(letterData[key]))) {
      throw new Error(`Final summary letter is missing a valid ${key} value.`);
    }
  });

  if (!String(letterData.reportMonthLabel || "").trim()) {
    throw new Error("Final summary letter is missing the report month.");
  }

  const expectedFundsReceived = roundCurrency(
    Number(letterData.amalgamatedPremium || 0) +
      Number(letterData.hpaCommission || 0) +
      Number(letterData.ahaDues || 0)
  );

  if (roundCurrency(Number(letterData.fundsReceived || 0)) !== expectedFundsReceived) {
    throw new Error(
      "The final letter totals do not reconcile to the month-end summary report. Please review before generating."
    );
  }
}

function buildFinalSummaryLetterLines(letterData) {
  return [
    `Date: ${letterData.letterDate}`,
    "",
    ...FINAL_SUMMARY_LETTER_RECIPIENT,
    "",
    "Dear Matthew:",
    "",
    `Attached are the Monthly Premium Remittance Reports for the month of ${letterData.reportMonthLongLabel}. Our accounting of the funds received totaled ${currency(letterData.fundsReceived)} which agrees to the penny with both the Monthly Reports and our database. Please distribute the funds as follows:`,
    "",
    `AMALGAMATED: ${currency(letterData.amalgamatedPremium)} (41% of Premium collected in ${letterData.reportMonthDashLabel})`,
    `HPA Commission: ${currency(letterData.hpaCommission)} (59% of Premium collected in ${letterData.reportMonthDashLabel})`,
    `AHA Dues: ${currency(letterData.ahaDues)} (Membership dues collected in ${letterData.reportMonthDashLabel})`,
    `FTJ (Fee): ${currency(letterData.ftjFee)} (Taken from HPA Commissions above)`,
    `Total: ${currency(letterData.fundsReceived)}`,
    "",
    "These figures have been carefully reviewed and double-checked with each of the transaction types from which the figures were originally calculated.",
    `Your prompt submission of HPA's Commissions by wire to our Bank of America account is greatly appreciated. I realize the total submitted to HPA might be slightly different than the ${currency(
      letterData.hpaCommission
    )} noted above. This is due to the current agreement between Premier Worksite Solutions and HPA and the current method of reconciliation. I look forward to receiving your documentation explaining the differences for our records. Also, please wire the money for AHA into the Wells Fargo account.`,
    "",
    "Very Sincerely,",
    "",
    ...FINAL_SUMMARY_SIGNATURE,
  ];
}

function buildFinalSummaryLetterHtml(letterData) {
  const lines = buildFinalSummaryLetterLines(letterData);
  const distributionStart = 11;
  const distributionEnd = 15;
  const introLines = lines.slice(0, distributionStart);
  const distributionLines = lines.slice(distributionStart, distributionEnd + 1);
  const closingLines = lines.slice(distributionEnd + 1);

  const distributionRows = distributionLines.map((line, index) => {
    const separatorIndex = line.indexOf(": ");
    const label = separatorIndex >= 0 ? `${line.slice(0, separatorIndex)}:` : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex + 2) : "";
    return {
      label,
      value,
      isTotal: index === distributionLines.length - 1,
    };
  });

  const renderParagraphs = (entries) =>
    entries
      .map((line) => {
        if (!line) {
          return '<p class="spacer"></p>';
        }

        return `<p>${escapeXml(line)}</p>`;
      })
      .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Final Summary Letter - ${escapeXml(letterData.reportMonthLabel)}</title>
    <style>
      body {
        margin: 0;
        background: #f5f1e8;
        color: #2c1a08;
        font-family: "Times New Roman", Georgia, serif;
      }
      .page {
        width: 8.5in;
        min-height: 11in;
        margin: 24px auto;
        padding: 0.9in 0.85in;
        box-sizing: border-box;
        background: #fff;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
      }
      p {
        margin: 0 0 14px;
        font-size: 12pt;
        line-height: 1.45;
      }
      .spacer {
        height: 0.22in;
        margin: 0;
      }
      .distribution {
        margin: 18px 0 22px;
        padding: 0;
      }
      .distribution-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .distribution-table td {
        padding: 0 0 4px;
        font-size: 12pt;
        line-height: 1.3;
        vertical-align: top;
      }
      .distribution-label {
        width: 32%;
        padding-left: 42px;
        white-space: nowrap;
      }
      .distribution-value {
        width: 68%;
        white-space: nowrap;
        text-align: right;
      }
      .distribution-total td {
        padding-top: 4px;
        border-top: 1px solid #2c1a08;
      }
      @media print {
        body {
          background: #fff;
        }
        .page {
          margin: 0;
          box-shadow: none;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      ${renderParagraphs(introLines)}
      <section class="distribution">
        <table class="distribution-table">
          <tbody>
            ${distributionRows
              .map(
                ({ label, value, isTotal }) => `<tr class="${isTotal ? "distribution-total" : ""}">
              <td class="distribution-label">${escapeXml(label)}</td>
              <td class="distribution-value">${escapeXml(value)}</td>
            </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </section>
      ${renderParagraphs(closingLines)}
    </main>
  </body>
</html>`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceFirst(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Could not update final summary letter template for ${label}.`);
  }

  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

function buildTemplateMoneyText(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildTemplateFeeParagraph({
  paraId,
  textId,
  rsidP,
  label,
  suffix,
  amount,
}) {
  const amountText = escapeXml(buildTemplateMoneyText(amount));
  const labelText = escapeXml(label);
  const suffixText = escapeXml(suffix);

  return `<w:p w14:paraId="${paraId}" w14:textId="${textId}" w:rsidR="005150F8" w:rsidRPr="00FE6A12" w:rsidRDefault="00552FDA" w:rsidP="${rsidP}"><w:pPr><w:ind w:left="-14" w:right="0" w:firstLine="720"/><w:rPr><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>${labelText}</w:t></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${suffixText}</w:t></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:tab/></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:tab/></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:tab/></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:tab/></w:r><w:r w:rsidR="00735C7D" w:rsidRPr="00FE6A12"><w:rPr><w:noProof/><w:u w:val="single"/></w:rPr><w:t>$</w:t></w:r><w:r w:rsidR="006A54B9" w:rsidRPr="00FE6A12"><w:rPr><w:noProof/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${amountText}</w:t></w:r><w:r w:rsidR="00D358B4" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r><w:r w:rsidR="005150F8" w:rsidRPr="00FE6A12"><w:rPr><w:u w:val="single"/></w:rPr><w:t>(Taken from HPA Commissions above)</w:t></w:r></w:p>`;
}

function buildFinalSummaryLetterTemplateXml(templateXml, letterData) {
  let xml = templateXml;

  const replaceParagraph = (paraId, updater, label) => {
    const paragraphPattern = new RegExp(
      `(<w:p[^>]*w14:paraId="${paraId}"[\\s\\S]*?<\\/w:p>)`
    );

    xml = replaceFirst(
      xml,
      paragraphPattern,
      (paragraphXml) => updater(paragraphXml),
      label
    );
  };

  replaceParagraph(
    "4088657A",
    (paragraphXml) =>
      replaceFirst(
        paragraphXml,
        /<w:t>6\/2\/2026<\/w:t>/,
        `<w:t>${escapeXml(letterData.letterDate)}</w:t>`,
        "letter date text"
      ),
    "letter date paragraph"
  );

  const simpleParagraphReplacements = [
    ["4DC8D58C", "Premier Worksite Benefits", "Premier Worksite Solutions", "recipient company"],
    ["689DD23E", "700 Kinderkamack Rd", "700 Kinderkamack Road", "recipient address line 1"],
    ["068A8F1D", "Ste. 205", "Suite 205", "recipient address line 2"],
    ["2CB5424A", "Oradell, NJ  07649", "Oradell, NJ 07649", "recipient city/state"],
  ];

  simpleParagraphReplacements.forEach(([paraId, currentText, nextText, label]) => {
    replaceParagraph(
      paraId,
      (paragraphXml) =>
        replaceFirst(
          paragraphXml,
          new RegExp(`<w:t>${escapeRegExp(currentText)}<\\/w:t>`),
          `<w:t>${escapeXml(nextText)}</w:t>`,
          label
        ),
      label
    );
  });

  replaceParagraph(
    "40BCCFF9",
    (paragraphXml) =>
      replaceFirst(
        paragraphXml,
        /<w:t>Matt<\/w:t>/,
        "<w:t>Matthew</w:t>",
        "salutation"
      ),
    "salutation paragraph"
  );

  replaceParagraph(
    "26835B0D",
    (paragraphXml) => {
      let updated = paragraphXml;
      updated = replaceFirst(
        updated,
        /<w:t>May<\/w:t>/,
        `<w:t>${escapeXml(letterData.reportMonthName)}</w:t>`,
        "intro month"
      );
      updated = replaceFirst(
        updated,
        /<w:t xml:space="preserve"> 2026<\/w:t>/,
        `<w:t xml:space="preserve"> ${escapeXml(letterData.reportMonthYear)}</w:t>`,
        "intro year"
      );
      updated = replaceFirst(
        updated,
        /<w:t>289,723\.19<\/w:t>/,
        `<w:t>${escapeXml(buildTemplateMoneyText(letterData.fundsReceived))}</w:t>`,
        "intro funds received"
      );
      return updated;
    },
    "intro paragraph"
  );

  [
    [
      "2D0918BC",
      letterData.amalgamatedPremium,
      "amalgamated distribution",
      /<w:t xml:space="preserve">92,777\.64 <\/w:t>/,
    ],
    [
      "314FCCCB",
      letterData.hpaCommission,
      "hpa commission distribution",
      /<w:t>133,509\.29 \(<\/w:t>/,
    ],
    [
      "4CC0C9CA",
      letterData.ahaDues,
      "aha dues distribution",
      /<w:t>63,436\.26<\/w:t>/,
    ],
  ].forEach(([paraId, amount, label, amountPattern]) => {
    replaceParagraph(
      paraId,
      (paragraphXml) => {
        let updated = paragraphXml;
        updated = replaceFirst(
          updated,
          /<w:t>May<\/w:t>/,
          `<w:t>${escapeXml(letterData.reportMonthName)}</w:t>`,
          `${label} month`
        );
        updated = replaceFirst(
          updated,
          /<w:t>-2026<\/w:t>/,
          `<w:t>-${escapeXml(letterData.reportMonthYear)}</w:t>`,
          `${label} year`
        );
        updated = replaceFirst(
          updated,
          amountPattern,
          paraId === "314FCCCB"
            ? `<w:t>${escapeXml(buildTemplateMoneyText(amount))} (</w:t>`
            : paraId === "2D0918BC"
              ? `<w:t xml:space="preserve">${escapeXml(
                  buildTemplateMoneyText(amount)
                )} </w:t>`
              : `<w:t>${escapeXml(buildTemplateMoneyText(amount))}</w:t>`,
          `${label} amount`
        );
        return updated;
      },
      label
    );
  });

  const feeParagraphPattern = /<w:p[^>]*w14:paraId="50B31CE1"[\s\S]*?<\/w:p>/;
  const ftjParagraph = buildTemplateFeeParagraph({
    paraId: "50B31CE1",
    textId: "3014B063",
    rsidP: "00FE6A12",
    label: "FTJ",
    suffix: " (Fee):",
    amount: letterData.ftjFee,
  });
  xml = replaceFirst(
    xml,
    feeParagraphPattern,
    ftjParagraph,
    "fee distribution paragraph"
  );

  replaceParagraph(
    "0602B083",
    (paragraphXml) =>
      replaceFirst(
        paragraphXml,
        /<w:t>289,723\.19<\/w:t>/,
        `<w:t>${escapeXml(buildTemplateMoneyText(letterData.fundsReceived))}</w:t>`,
        "total distribution amount"
      ),
    "total distribution paragraph"
  );

  replaceParagraph(
    "16862165",
    (paragraphXml) => {
      let updated = paragraphXml;
      updated = replaceFirst(
        updated,
        /<w:t>133,509\.29<\/w:t>/,
        `<w:t>${escapeXml(buildTemplateMoneyText(letterData.hpaCommission))}</w:t>`,
        "closing hpa commission"
      );
      updated = replaceFirst(
        updated,
        /<w:t>Premier Worksite Benefits<\/w:t>/,
        "<w:t>Premier Worksite Solutions</w:t>",
        "closing company name"
      );
      return updated;
    },
    "closing paragraph"
  );

  return xml;
}

function buildDocxDocumentXml(letterData) {
  const lines = buildFinalSummaryLetterLines(letterData);
  const distributionStart = 11;
  const distributionEnd = 15;

  const paragraphXml = lines
    .map((line, index) => {
      if (!line) {
        return '<w:p><w:pPr><w:spacing w:after="160"/></w:pPr></w:p>';
      }

      const isDistribution = index >= distributionStart && index <= distributionEnd;
      const isTotal = index === distributionEnd;
      const text = escapeXml(line);
      const runProps = isDistribution
        ? `<w:rPr>${isTotal ? "<w:b/>" : ""}</w:rPr>`
        : "";
      const paragraphProps = isDistribution
        ? `<w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/></w:pPr>`
        : '<w:pPr><w:spacing w:after="120"/></w:pPr>';

      return `<w:p>${paragraphProps}<w:r>${runProps}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14 wp14">
  <w:body>
    ${paragraphXml}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1260" w:bottom="1440" w:left="1260" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function buildFinalSummaryLetterDocx(letterData, destinationPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-letter-"));
  const docxDir = path.join(tempDir, "docx");
  const zipPath = path.join(tempDir, "letter.zip");
  const templateZipPath = path.join(tempDir, "template.zip");

  if (fs.existsSync(FINAL_SUMMARY_LETTER_TEMPLATE_PATH)) {
    fs.copyFileSync(FINAL_SUMMARY_LETTER_TEMPLATE_PATH, templateZipPath);
    runPowerShell(
      `Expand-Archive -LiteralPath '${templateZipPath}' -DestinationPath '${docxDir}' -Force`
    );
    const templateDocumentPath = path.join(docxDir, "word", "document.xml");
    const templateXml = fs.readFileSync(templateDocumentPath, "utf8");
    fs.writeFileSync(
      templateDocumentPath,
      buildFinalSummaryLetterTemplateXml(templateXml, letterData),
      "utf8"
    );
  } else {
    const relsDir = path.join(docxDir, "_rels");
    const wordDir = path.join(docxDir, "word");
    const wordRelsDir = path.join(wordDir, "_rels");
    const docPropsDir = path.join(docxDir, "docProps");

    ensureDir(relsDir);
    ensureDir(wordDir);
    ensureDir(wordRelsDir);
    ensureDir(docPropsDir);

    fs.writeFileSync(
      path.join(docxDir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(relsDir, ".rels"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(wordRelsDir, "document.xml.rels"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
      "utf8"
    );

    fs.writeFileSync(path.join(wordDir, "document.xml"), buildDocxDocumentXml(letterData), "utf8");

    fs.writeFileSync(
      path.join(docPropsDir, "core.xml"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Final Summary Letter ${escapeXml(letterData.reportMonthLabel)}</dc:title>
  <dc:creator>HPA Automations</dc:creator>
  <cp:lastModifiedBy>HPA Automations</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(docPropsDir, "app.xml"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>HPA Automations</Application>
</Properties>`,
      "utf8"
    );
  }

  runPowerShell(
    `Compress-Archive -Path '${path.join(docxDir, "*")}' -DestinationPath '${zipPath}' -Force`
  );
  fs.rmSync(destinationPath, { force: true });
  fs.writeFileSync(destinationPath, fs.readFileSync(zipPath));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createFinalSummaryLetterArtifacts(runId, report) {
  const runDir = path.join(GENERATED_DIR, runId);
  ensureDir(runDir);

  const letterData = buildFinalSummaryLetterData(report);
  validateFinalSummaryLetterData(letterData);

  const filePrefix = formatReportMonthFilePrefix(report.reportMonth);
  const safeMonthLabel = letterData.reportMonthLabel.replace(/[^A-Za-z0-9-]/g, "-");
  const docxFileName = `Final_Summary_Letter_${safeMonthLabel}.docx`;
  const pdfFileName = `${filePrefix}_Premier - Letter.pdf`;
  const htmlFileName = `${filePrefix}_Premier - Letter.html`;
  const jsonFileName = `${filePrefix}_Premier - Letter.json`;
  const printableHtml = buildFinalSummaryLetterHtml(letterData);

  buildFinalSummaryLetterDocx(letterData, path.join(runDir, docxFileName));
  generatePdfFromHtml(printableHtml, path.join(runDir, pdfFileName));
  fs.writeFileSync(path.join(runDir, htmlFileName), printableHtml, "utf8");
  fs.writeFileSync(
    path.join(runDir, jsonFileName),
    `${JSON.stringify(letterData, null, 2)}\n`,
    "utf8"
  );

  return {
    letterData,
    artifacts: [
      {
        kind: "print",
        label: "Download PDF",
        fileName: pdfFileName,
        contentType: "application/pdf",
      },
    ],
  };
}

function buildTemplateWorkbook(report, destinationPath) {
  if (!fs.existsSync(WORKBOOK_TEMPLATE_PATH)) {
    throw new Error(`Workbook template not found: ${WORKBOOK_TEMPLATE_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-workbook-"));
  const templateZipPath = path.join(tempDir, "template.zip");
  const extractDir = path.join(tempDir, "unzipped");
  const workingZipPath = path.join(tempDir, "output.zip");

  fs.copyFileSync(WORKBOOK_TEMPLATE_PATH, templateZipPath);

  runPowerShell(
    `Expand-Archive -LiteralPath '${templateZipPath}' -DestinationPath '${extractDir}' -Force`
  );

  const worksheetPath = path.join(extractDir, "xl", "worksheets", "sheet20.xml");
  const worksheetXml = fs.readFileSync(worksheetPath, "utf8");
  const patchedWorksheetXml = buildFinalReportWorksheetXml(worksheetXml, report);
  fs.writeFileSync(worksheetPath, patchedWorksheetXml, "utf8");
  stripWorkbookCalcChain(extractDir);

  runPowerShell(
    `Compress-Archive -Path '${path.join(extractDir, "*")}' -DestinationPath '${workingZipPath}' -Force`
  );

  fs.copyFileSync(workingZipPath, destinationPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function stripWorkbookCalcChain(extractDir) {
  const workbookRelsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
  const contentTypesPath = path.join(extractDir, "[Content_Types].xml");
  const calcChainPath = path.join(extractDir, "xl", "calcChain.xml");

  if (fs.existsSync(workbookRelsPath)) {
    fs.writeFileSync(
      workbookRelsPath,
      fs
        .readFileSync(workbookRelsPath, "utf8")
        .replace(
          /<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/calcChain"[^>]*\/>/,
          ""
        ),
      "utf8"
    );
  }

  if (fs.existsSync(contentTypesPath)) {
    fs.writeFileSync(
      contentTypesPath,
      fs
        .readFileSync(contentTypesPath, "utf8")
        .replace(
          /<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/,
          ""
        ),
      "utf8"
    );
  }

  if (fs.existsSync(calcChainPath)) {
    fs.rmSync(calcChainPath, { force: true });
  }
}

function runPowerShell(command) {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "PowerShell command failed.");
  }
}

function buildInlineStringCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(
    value
  )}</t></is></c>`;
}

function buildNumberCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}"><v>${value}</v></c>`;
}

function buildBlankCell(reference, styleId) {
  return `<c r="${reference}" s="${styleId}"/>`;
}

function buildFinalReportWorksheetXml(templateXml, report) {
  const rows = [];
  let currentRow = 1;

  const pushRow = (markup) => {
    rows.push(markup);
    currentRow += 1;
  };

  pushRow(
    `<row r="${currentRow}" spans="1:20" s="4" customFormat="1" ht="30" x14ac:dyDescent="0.25">` +
      buildInlineStringCell("A1", 7, "Transaction Type") +
      buildInlineStringCell("B1", 8, "Date") +
      buildBlankCell("C1", 9) +
      buildInlineStringCell("D1", 3, "Gross Premium") +
      buildBlankCell("E1", 9) +
      buildInlineStringCell("F1", 3, "Amalgamated Premium") +
      buildBlankCell("G1", 9) +
      buildInlineStringCell("H1", 3, "HPA Commision") +
      buildBlankCell("I1", 9) +
      buildInlineStringCell("J1", 3, "AHA Dues") +
      buildBlankCell("K1", 9) +
      buildInlineStringCell("L1", 3, "Total Submitted") +
      buildInlineStringCell("M1", 30, "Number of Months") +
      buildInlineStringCell("N1", 30, "Number of Certificates") +
      buildBlankCell("O1", 9) +
      buildInlineStringCell("P1", 9, "BatchID") +
      buildBlankCell("Q1", 9) +
      buildBlankCell("R1", 9) +
      buildBlankCell("S1", 9) +
      buildBlankCell("T1", 9) +
    `</row>`
  );

  pushRow(
    `<row r="${currentRow}" spans="1:20" s="10" customFormat="1" x14ac:dyDescent="0.25">` +
      buildInlineStringCell(`A${currentRow}`, 14, "Grand Totals") +
      buildBlankCell(`B${currentRow}`, 15) +
      buildBlankCell(`C${currentRow}`, 15) +
      buildNumberCell(`D${currentRow}`, 38, report.totals.grossPremium) +
      buildBlankCell(`E${currentRow}`, 15) +
      buildNumberCell(`F${currentRow}`, 38, report.totals.amalgamatedPremium) +
      buildBlankCell(`G${currentRow}`, 15) +
      buildNumberCell(`H${currentRow}`, 38, report.totals.hpaCommission) +
      buildBlankCell(`I${currentRow}`, 15) +
      buildNumberCell(`J${currentRow}`, 38, report.totals.ahaDues) +
      buildBlankCell(`K${currentRow}`, 15) +
      buildNumberCell(`L${currentRow}`, 38, report.totals.totalSubmitted) +
      buildNumberCell(`M${currentRow}`, 40, report.totals.numberOfMonths) +
      buildNumberCell(`N${currentRow}`, 41, report.totals.numberOfCertificates) +
      buildBlankCell(`O${currentRow}`, 15) +
      buildNumberCell(`P${currentRow}`, 41, report.totals.numberOfCertificates) +
    `</row>`
  );

  pushRow(
    `<row r="${currentRow}" spans="1:20" s="4" customFormat="1" x14ac:dyDescent="0.25">` +
      buildInlineStringCell(`A${currentRow}`, 19, "FTJ Fee") +
      buildBlankCell(`B${currentRow}`, 21) +
      buildBlankCell(`C${currentRow}`, 22) +
      buildBlankCell(`D${currentRow}`, 10) +
      buildBlankCell(`E${currentRow}`, 22) +
      buildBlankCell(`F${currentRow}`, 10) +
      buildBlankCell(`G${currentRow}`, 22) +
      buildNumberCell(`H${currentRow}`, 10, -report.totals.ftjFee) +
      buildBlankCell(`I${currentRow}`, 22) +
      buildBlankCell(`J${currentRow}`, 10) +
      buildBlankCell(`K${currentRow}`, 22) +
      buildBlankCell(`L${currentRow}`, 10) +
      buildBlankCell(`M${currentRow}`, 31) +
      buildBlankCell(`N${currentRow}`, 31) +
    `</row>`
  );

  pushRow(
    `<row r="${currentRow}" spans="1:20" x14ac:dyDescent="0.25">` +
      buildBlankCell(`A${currentRow}`, 19) +
      buildBlankCell(`B${currentRow}`, 23) +
      buildBlankCell(`C${currentRow}`, 24) +
      buildBlankCell(`D${currentRow}`, 39) +
      buildBlankCell(`E${currentRow}`, 24) +
      buildBlankCell(`F${currentRow}`, 39) +
      buildBlankCell(`G${currentRow}`, 24) +
      buildNumberCell(`H${currentRow}`, 39, report.totals.netHpaCommission) +
      buildBlankCell(`I${currentRow}`, 24) +
      buildBlankCell(`J${currentRow}`, 39) +
      buildBlankCell(`K${currentRow}`, 24) +
      buildBlankCell(`L${currentRow}`, 39) +
      buildBlankCell(`M${currentRow}`, 32) +
      buildBlankCell(`N${currentRow}`, 32) +
    `</row>`
  );

  pushRow(
    `<row r="${currentRow}" spans="1:20" x14ac:dyDescent="0.25">` +
      buildBlankCell(`A${currentRow}`, 12) +
      buildBlankCell(`B${currentRow}`, 23) +
      buildBlankCell(`C${currentRow}`, 24) +
      buildBlankCell(`D${currentRow}`, 39) +
      buildBlankCell(`E${currentRow}`, 10) +
      buildBlankCell(`F${currentRow}`, 39) +
      buildBlankCell(`G${currentRow}`, 39) +
      buildBlankCell(`H${currentRow}`, 32) +
      buildBlankCell(`I${currentRow}`, 32) +
    `</row>`
  );

  report.sections.forEach((section) => {
    pushRow(
      `<row r="${currentRow}" spans="1:20" x14ac:dyDescent="0.25">` +
        buildInlineStringCell(`A${currentRow}`, 5, section.finalLabel) +
        buildBlankCell(`B${currentRow}`, 28) +
        buildBlankCell(`C${currentRow}`, 28) +
        buildNumberCell(`D${currentRow}`, 25, section.totals.grossPremium) +
        buildBlankCell(`E${currentRow}`, 28) +
        buildNumberCell(`F${currentRow}`, 25, section.totals.amalgamatedPremium) +
        buildBlankCell(`G${currentRow}`, 28) +
        buildNumberCell(`H${currentRow}`, 25, section.totals.hpaCommission) +
        buildBlankCell(`I${currentRow}`, 28) +
        buildNumberCell(`J${currentRow}`, 25, section.totals.ahaDues) +
        buildBlankCell(`K${currentRow}`, 28) +
        buildNumberCell(`L${currentRow}`, 25, section.totals.totalSubmitted) +
        buildNumberCell(`M${currentRow}`, 42, section.totals.numberOfMonths) +
        buildNumberCell(`N${currentRow}`, 42, section.totals.numberOfCertificates) +
      `</row>`
    );

    section.rows.forEach((entry) => {
      pushRow(
        `<row r="${currentRow}" spans="1:20" x14ac:dyDescent="0.25">` +
          buildInlineStringCell(`A${currentRow}`, 6, section.detailLabel) +
          buildNumberCell(`B${currentRow}`, 2, toExcelDateNumber(entry.date)) +
          buildBlankCell(`C${currentRow}`, 6) +
          buildNumberCell(`D${currentRow}`, 26, entry.grossPremium) +
          buildBlankCell(`E${currentRow}`, 6) +
          buildNumberCell(`F${currentRow}`, 4, entry.amalgamatedPremium) +
          buildBlankCell(`G${currentRow}`, 6) +
          buildNumberCell(`H${currentRow}`, 4, entry.hpaCommission) +
          buildBlankCell(`I${currentRow}`, 6) +
          buildNumberCell(`J${currentRow}`, 4, entry.ahaDues) +
          buildBlankCell(`K${currentRow}`, 6) +
          buildNumberCell(`L${currentRow}`, 4, entry.totalSubmitted) +
          buildNumberCell(`M${currentRow}`, 34, entry.numberOfMonths) +
          buildNumberCell(`N${currentRow}`, 34, entry.numberOfCertificates) +
        `</row>`
      );
    });

    pushRow(
      `<row r="${currentRow}" spans="1:20" x14ac:dyDescent="0.25">` +
        buildBlankCell(`A${currentRow}`, 6) +
        buildBlankCell(`B${currentRow}`, 2) +
        buildBlankCell(`C${currentRow}`, 4) +
        buildBlankCell(`D${currentRow}`, 4) +
        buildBlankCell(`E${currentRow}`, 4) +
        buildBlankCell(`F${currentRow}`, 4) +
        buildBlankCell(`G${currentRow}`, 4) +
        buildBlankCell(`H${currentRow}`, 4) +
        buildBlankCell(`I${currentRow}`, 4) +
        buildBlankCell(`J${currentRow}`, 4) +
        buildBlankCell(`K${currentRow}`, 4) +
        buildBlankCell(`L${currentRow}`, 4) +
        buildBlankCell(`M${currentRow}`, 34) +
        buildBlankCell(`N${currentRow}`, 34) +
        buildBlankCell(`O${currentRow}`, 4) +
        buildBlankCell(`P${currentRow}`, 4) +
        buildBlankCell(`Q${currentRow}`, 4) +
        buildBlankCell(`R${currentRow}`, 4) +
        buildBlankCell(`S${currentRow}`, 4) +
        buildBlankCell(`T${currentRow}`, 4) +
      `</row>`
    );
  });

  return templateXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:T${Math.max(currentRow - 1, 1)}"/>`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${rows.join("")}</sheetData>`);
}

function buildCsv(report) {
  const header = report.columns.map((column) => column.label).join(",");
  const lines = [header];

  const pushMetricsRow = (label, metrics, useLabelOnly = false) => {
    lines.push(
      [
        label,
        useLabelOnly ? "" : metrics.grossPremium,
        useLabelOnly ? "" : metrics.amalgamatedPremium,
        useLabelOnly ? "" : metrics.hpaCommission,
        useLabelOnly ? "" : metrics.ahaDues,
        useLabelOnly ? "" : metrics.totalSubmitted,
        useLabelOnly ? "" : metrics.numberOfMonths,
        useLabelOnly ? "" : metrics.numberOfCertificates,
      ].join(",")
    );
  };

  pushMetricsRow("Grand Totals", report.totals);
  pushMetricsRow("FTJ Fee", createEmptyMetrics(), true);
  lines[lines.length - 1] = `FTJ Fee,,,${-report.totals.ftjFee},,,,`;
  pushMetricsRow("Net HPA Commission", createEmptyMetrics(), true);
  lines[lines.length - 1] = `Net HPA Commission,,,${report.totals.netHpaCommission},,,,`;
  lines.push("");

  report.sections.forEach((section) => {
    pushMetricsRow(section.finalLabel, section.totals);

    section.rows.forEach((row) => {
      lines.push(
        [
          row.dateLabel,
          row.grossPremium,
          row.amalgamatedPremium,
          row.hpaCommission,
          row.ahaDues,
          row.totalSubmitted,
          row.numberOfMonths,
          row.numberOfCertificates,
        ].join(",")
      );
    });

    lines.push("");
  });

  return lines.join("\n");
}

function buildPrintableHtml(report) {
  const formatCount = (value) =>
    Number.isInteger(value) ? String(value) : value.toFixed(2);
  const formatAmount = (value) => {
    const absolute = Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    return value < 0 ? `(${absolute})` : absolute;
  };
  const blankGridColumns = ["J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"];

  const renderAccountingCells = (metrics, isTotalRow = false) => {
    const moneyStyle = isTotalRow ? "money total-money" : "money";
    const countStyle = isTotalRow ? "number total-number" : "number";

    return `
      <td class="currency">${metrics.grossPremium === 0 ? "" : "$"}</td>
      <td class="${moneyStyle}">${metrics.grossPremium === 0 ? "" : formatAmount(metrics.grossPremium)}</td>
      <td class="currency">${metrics.amalgamatedPremium === 0 ? "" : "$"}</td>
      <td class="${moneyStyle}">${metrics.amalgamatedPremium === 0 ? "" : formatAmount(metrics.amalgamatedPremium)}</td>
      <td class="currency">${metrics.hpaCommission === 0 ? "" : "$"}</td>
      <td class="${moneyStyle}">${metrics.hpaCommission === 0 ? "" : formatAmount(metrics.hpaCommission)}</td>
      <td class="currency">${metrics.ahaDues === 0 ? "" : "$"}</td>
      <td class="${moneyStyle}">${metrics.ahaDues === 0 ? "" : formatAmount(metrics.ahaDues)}</td>
      <td class="currency">${metrics.totalSubmitted === 0 ? "" : "$"}</td>
      <td class="${moneyStyle}">${metrics.totalSubmitted === 0 ? "" : formatAmount(metrics.totalSubmitted)}</td>
      <td class="${countStyle}">${metrics.numberOfMonths === 0 ? "" : formatCount(metrics.numberOfMonths)}</td>
      <td class="${countStyle}">${metrics.numberOfCertificates === 0 ? "" : formatCount(metrics.numberOfCertificates)}</td>
    `;
  };

  const renderBlankGridCells = () =>
    blankGridColumns.map(() => '<td class="blank"></td>').join("");

  const rows = [];

  rows.push(`
    <tr class="header-row">
      <td class="text">Transaction Type</td>
      <td class="text">Date</td>
      <td class="currency-header"></td>
      <td class="text center">Gross Premium</td>
      <td class="currency-header"></td>
      <td class="text center">Amalgamated Premium</td>
      <td class="currency-header"></td>
      <td class="text center">HPA Commision</td>
      <td class="currency-header"></td>
      <td class="text center">AHA Dues</td>
      <td class="currency-header"></td>
      <td class="text center">Total Submitted</td>
      <td class="text center">Number of Months</td>
      <td class="text center">Number of Certificates</td>
      <td class="blank"></td>
      <td class="text center">BatchID</td>
      ${blankGridColumns.slice(2).map(() => '<td class="blank"></td>').join("")}
    </tr>
  `);

  rows.push(`
    <tr class="summary-row">
      <td class="text strong">Grand Totals</td>
      <td></td>
      ${renderAccountingCells(report.totals)}
      <td class="blank"></td>
      <td class="number strong">${formatCount(report.totals.numberOfCertificates)}</td>
      ${blankGridColumns.slice(2).map(() => '<td class="blank"></td>').join("")}
    </tr>
  `);

  rows.push(`
    <tr class="fee-row negative-row">
      <td class="text strong">Premier Fee</td>
      <td></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency negative">$</td>
      <td class="money negative">${formatAmount(-report.totals.ftjFee)}</td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="number"></td>
      <td class="number"></td>
      ${renderBlankGridCells()}
    </tr>
  `);

  rows.push(`
    <tr class="net-row">
      <td></td>
      <td></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency">$</td>
      <td class="money">${formatAmount(report.totals.netHpaCommission)}</td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="currency"></td>
      <td class="money"></td>
      <td class="number"></td>
      <td class="number"></td>
      ${renderBlankGridCells()}
    </tr>
  `);

  rows.push(`<tr class="spacer-row">${'<td class="blank"></td>'.repeat(20)}</tr>`);

  report.sections.forEach((section) => {
    rows.push(`
      <tr class="section-total-row negative-row">
        <td class="text strong">${section.finalLabel}</td>
        <td></td>
        ${renderAccountingCells(section.totals, true)}
        ${renderBlankGridCells()}
      </tr>
    `);

    section.rows.forEach((entry) => {
      rows.push(`
        <tr class="detail-row">
          <td class="text">${section.detailLabel}</td>
          <td class="date">${entry.dateLabel}</td>
          ${renderAccountingCells(entry)}
          ${renderBlankGridCells()}
        </tr>
      `);
    });

    rows.push(`<tr class="spacer-row">${'<td class="blank"></td>'.repeat(20)}</tr>`);
  });

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AHA HPA Transaction Summary - ${report.reportMonthLabel}</title>
    <style>
      :root {
        --grid: #a6a6a6;
        --sheet: #d9d9d9;
        --sheet-dark: #217346;
        --negative: #ff0000;
        --text: #000;
      }
      body {
        margin: 0;
        background: #2f2f2f;
        font-family: Calibri, Arial, sans-serif;
        color: var(--text);
      }
      .sheet-shell {
        padding: 18px 16px;
      }
      .sheet-print-area {
        width: fit-content;
        background: #fff;
      }
      .report-meta {
        width: fit-content;
        min-width: 420px;
        margin: 0 0 16px;
        padding: 14px 16px;
        background: #fff;
        border: 1px solid #d6d6d6;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
      }
      .report-meta h1 {
        margin: 0 0 12px;
        font-size: 28px;
        font-family: Georgia, "Times New Roman", serif;
        color: #2c1a08;
      }
      .report-meta p {
        margin: 0 0 8px;
        color: #2c1a08;
        font-size: 16px;
      }
      .report-meta p:last-child {
        margin-bottom: 0;
      }
      .column-bar {
        display: grid;
        grid-template-columns: 320px 80px 44px 132px 44px 132px 44px 118px 44px 104px 44px 118px 128px 138px 56px 86px repeat(5, 54px);
        background: var(--sheet-dark);
        color: #fff;
        border: 1px solid #1b5e35;
        border-bottom: none;
        font-size: 12px;
      }
      .column-bar div {
        padding: 6px 0;
        text-align: center;
        border-right: 1px solid rgba(255,255,255,0.2);
      }
      .column-bar div:last-child {
        border-right: none;
      }
      table {
        border-collapse: collapse;
        table-layout: fixed;
        background: var(--sheet);
        box-shadow: 0 0 0 1px var(--grid) inset;
      }
      col.col-a { width: 320px; }
      col.col-b { width: 80px; }
      col.currency { width: 44px; }
      col.money-wide { width: 132px; }
      col.money-mid { width: 118px; }
      col.money-narrow { width: 104px; }
      col.count-months { width: 128px; }
      col.count-certs { width: 138px; }
      col.blank-small { width: 56px; }
      col.batch { width: 86px; }
      col.blank { width: 54px; }
      td {
        border: 1px solid var(--grid);
        background: var(--sheet);
        font-size: 12px;
        line-height: 1.1;
        padding: 3px 6px;
        white-space: nowrap;
      }
      .text { text-align: left; }
      .center { text-align: center; }
      .date { text-align: left; }
      .currency { text-align: center; }
      .money, .number { text-align: right; }
      .strong { font-weight: 700; }
      .negative-row td,
      .negative,
      .total-money,
      .total-number {
        color: var(--negative);
        font-weight: 700;
      }
      .header-row td {
        font-weight: 700;
        background: #efefef;
      }
      .spacer-row td {
        height: 12px;
      }
      .blank {
        color: transparent;
      }
      @media print {
        @page {
          size: landscape;
          margin: 0.25in;
        }
        body {
          background: #fff;
        }
        .sheet-shell {
          padding: 0;
        }
        .sheet-print-area {
          zoom: 0.54;
          width: calc(100% / 0.54);
          transform-origin: top left;
        }
        .report-meta {
          box-shadow: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="sheet-shell">
      <div class="report-meta">
        <h1>AHA HPA Transaction Summary Report</h1>
        <p><strong>Report Month:</strong> ${report.reportMonthLabel}</p>
        <p><strong>Generated:</strong> ${new Date(report.generatedAt).toLocaleString("en-US")}</p>
        <p><strong>Source:</strong> ${report.source}</p>
      </div>
      <div class="sheet-print-area">
        <div class="column-bar">
          <div>A</div><div>B</div><div>C</div><div>D</div><div>E</div><div>F</div><div>G</div><div>H</div><div>I</div><div>J</div>
          <div>K</div><div>L</div><div>M</div><div>N</div><div>O</div><div>P</div><div>Q</div><div>R</div><div>S</div><div>T</div>
        </div>
        <table>
          <colgroup>
            <col class="col-a" />
            <col class="col-b" />
            <col class="currency" />
            <col class="money-wide" />
            <col class="currency" />
            <col class="money-wide" />
            <col class="currency" />
            <col class="money-mid" />
            <col class="currency" />
            <col class="money-narrow" />
            <col class="currency" />
            <col class="money-mid" />
            <col class="count-months" />
            <col class="count-certs" />
            <col class="blank-small" />
            <col class="batch" />
            <col class="blank" />
            <col class="blank" />
            <col class="blank" />
            <col class="blank" />
          </colgroup>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;
}

function writeArtifacts(runId, report) {
  const runDir = path.join(GENERATED_DIR, runId);
  ensureDir(runDir);

  const filePrefix = formatReportMonthFilePrefix(report.reportMonth);
  const workbookFileName = `${filePrefix}_AHA HPA Transaction Summary.xlsm`;
  const pdfFileName = `${filePrefix}_AHA HPA Transaction Summary.pdf`;
  const htmlFileName = `${filePrefix}_AHA HPA Transaction Summary.html`;
  const jsonFileName = `${filePrefix}_AHA HPA Transaction Summary.json`;
  const printableHtml = buildPrintableHtml(report);

  buildTemplateWorkbook(report, path.join(runDir, workbookFileName));
  const printableArtifact = createPrintableArtifactFromHtml({
    html: printableHtml,
    outputDir: runDir,
    pdfFileName,
    htmlFileName,
  });
  if (printableArtifact.warning) {
    report.printArtifactWarning = printableArtifact.warning;
  }
  fs.writeFileSync(
    path.join(runDir, jsonFileName),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );

  return [
    {
      kind: "spreadsheet",
      label: "Download Workbook",
      fileName: workbookFileName,
      contentType:
        "application/vnd.ms-excel.sheet.macroEnabled.12",
    },
    printableArtifact.artifact,
    {
      kind: "json",
      label: "Download JSON",
      fileName: jsonFileName,
      contentType: "application/json; charset=utf-8",
    },
  ];
}

function writeRunArtifacts(runId, reportType, report) {
  if (reportType === "transaction-detail") {
    const runDir = path.join(GENERATED_DIR, runId);
    ensureDir(runDir);
    return writeDetailArtifacts(runDir, report);
  }

  if (reportType === "amalgamated-premium-remittance") {
    const runDir = path.join(GENERATED_DIR, runId);
    ensureDir(runDir);
    return writeAmalgamatedArtifacts(runDir, report);
  }

  return writeArtifacts(runId, report);
}

function buildReportForType(reportType, reportMonth, sourceDataOrOptions) {
  if (reportType === "transaction-detail") {
    return buildTransactionDetailReport(reportMonth, sourceDataOrOptions);
  }

  if (reportType === "amalgamated-premium-remittance") {
    return buildAmalgamatedPremiumRemittanceReport(sourceDataOrOptions);
  }

  return buildFinalReport(reportMonth, sourceDataOrOptions);
}

function findFirstExistingArtifactFile(runDir, candidates) {
  return candidates.find((fileName) => fs.existsSync(path.join(runDir, fileName))) || null;
}

function findSummaryLetterDocx(runDir) {
  if (!fs.existsSync(runDir)) {
    return null;
  }

  return (
    fs
      .readdirSync(runDir)
      .find(
        (fileName) =>
          /^Final_Summary_Letter_/i.test(String(fileName || "")) &&
          /\.docx$/i.test(String(fileName || ""))
      ) || null
  );
}

function buildRecoveredArtifacts(run) {
  const runDir = path.join(GENERATED_DIR, String(run?.id || "").trim());
  const reportMonth = String(run?.reportMonth || "").trim();
  if (!reportMonth || !fs.existsSync(runDir)) {
    return [];
  }

  const reportMonthLabel = formatReportMonth(reportMonth);
  const filePrefix = formatReportMonthFilePrefix(reportMonth);
  const artifacts = [];
  const pushArtifact = (kind, label, fileName, contentType) => {
    if (!fileName) {
      return;
    }
    artifacts.push({ kind, label, fileName, contentType });
  };

  if (run.reportType === "transaction-detail") {
    pushArtifact(
      "spreadsheet",
      "Download Workbook",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_AHA HPA Transaction Detail.xlsx`,
        `AHA HPA Transaction Detail - ${reportMonthLabel}.xlsx`,
      ]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    pushArtifact(
      "print",
      fs.existsSync(path.join(runDir, `${filePrefix}_AHA HPA Transaction Detail.pdf`))
        || fs.existsSync(path.join(runDir, `aha-hpa-transaction-detail-${reportMonth}.pdf`))
        ? "Download PDF"
        : "Open Print View",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_AHA HPA Transaction Detail.pdf`,
        `${filePrefix}_AHA HPA Transaction Detail.html`,
        `aha-hpa-transaction-detail-${reportMonth}.pdf`,
        `aha-hpa-transaction-detail-${reportMonth}.html`,
      ]),
      fs.existsSync(path.join(runDir, `${filePrefix}_AHA HPA Transaction Detail.pdf`))
        || fs.existsSync(path.join(runDir, `aha-hpa-transaction-detail-${reportMonth}.pdf`))
        ? "application/pdf"
        : "text/html; charset=utf-8"
    );
    pushArtifact(
      "json",
      "Download JSON",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_AHA HPA Transaction Detail.json`,
        `aha-hpa-transaction-detail-${reportMonth}.json`,
      ]),
      "application/json; charset=utf-8"
    );
    return artifacts;
  }

  if (run.reportType === "amalgamated-premium-remittance") {
    pushArtifact(
      "spreadsheet",
      "Download Workbook",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_Amalgamated_Premium_Remittance.xlsx`,
        `Amalgamated_Premium_Remittance_${reportMonth.replace("-", "_")}.xlsx`,
      ]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    pushArtifact(
      "print",
      fs.existsSync(path.join(runDir, `${filePrefix}_Amalgamated_Premium_Remittance.pdf`))
        || fs.existsSync(path.join(runDir, `amalgamated-premium-remittance-${reportMonth}.pdf`))
        ? "Download PDF"
        : "Open Print View",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_Amalgamated_Premium_Remittance.pdf`,
        `${filePrefix}_Amalgamated_Premium_Remittance.html`,
        `amalgamated-premium-remittance-${reportMonth}.pdf`,
        `amalgamated-premium-remittance-${reportMonth}.html`,
      ]),
      fs.existsSync(path.join(runDir, `${filePrefix}_Amalgamated_Premium_Remittance.pdf`))
        || fs.existsSync(path.join(runDir, `amalgamated-premium-remittance-${reportMonth}.pdf`))
        ? "application/pdf"
        : "text/html; charset=utf-8"
    );
    pushArtifact(
      "json",
      "Download JSON",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_Amalgamated_Premium_Remittance.json`,
        `amalgamated-premium-remittance-${reportMonth}.json`,
      ]),
      "application/json; charset=utf-8"
    );
    return artifacts;
  }

  if (run.reportType === FINAL_SUMMARY_LETTER_REPORT_TYPE) {
    const generatedPdfPath = path.join(runDir, `${filePrefix}_Premier - Letter.pdf`);
    if (
      !fs.existsSync(generatedPdfPath) &&
      run?.report?.finalSummaryLetter
    ) {
      try {
        const printableHtml = buildFinalSummaryLetterHtml(run.report.finalSummaryLetter);
        generatePdfFromHtml(printableHtml, generatedPdfPath);
      } catch {
        // Leave the older artifacts in place if PDF recovery is unavailable.
      }
    }
    pushArtifact(
      "print",
      "Download PDF",
      findFirstExistingArtifactFile(runDir, [
        `${filePrefix}_Premier - Letter.pdf`,
        `${filePrefix}_Premier - Letter.html`,
        `final-summary-letter-${reportMonth}.pdf`,
        `final-summary-letter-${reportMonth}.html`,
      ]),
      fs.existsSync(path.join(runDir, `${filePrefix}_Premier - Letter.pdf`))
        || fs.existsSync(path.join(runDir, `final-summary-letter-${reportMonth}.pdf`))
        ? "application/pdf"
        : "text/html; charset=utf-8"
    );
    return artifacts;
  }

  pushArtifact(
    "spreadsheet",
    "Download Workbook",
    findFirstExistingArtifactFile(runDir, [
      `${filePrefix}_AHA HPA Transaction Summary.xlsm`,
      `AHA HPA Transaction Summary - ${reportMonthLabel}.xlsm`,
    ]),
    "application/vnd.ms-excel.sheet.macroEnabled.12"
  );
  pushArtifact(
    "print",
    fs.existsSync(path.join(runDir, `${filePrefix}_AHA HPA Transaction Summary.pdf`))
      || fs.existsSync(path.join(runDir, `aha-hpa-transaction-summary-${reportMonth}.pdf`))
      ? "Download PDF"
      : "Open Print View",
    findFirstExistingArtifactFile(runDir, [
      `${filePrefix}_AHA HPA Transaction Summary.pdf`,
      `${filePrefix}_AHA HPA Transaction Summary.html`,
      `aha-hpa-transaction-summary-${reportMonth}.pdf`,
      `aha-hpa-transaction-summary-${reportMonth}.html`,
    ]),
    fs.existsSync(path.join(runDir, `${filePrefix}_AHA HPA Transaction Summary.pdf`))
      || fs.existsSync(path.join(runDir, `aha-hpa-transaction-summary-${reportMonth}.pdf`))
      ? "application/pdf"
      : "text/html; charset=utf-8"
  );
  pushArtifact(
    "json",
    "Download JSON",
    findFirstExistingArtifactFile(runDir, [
      `${filePrefix}_AHA HPA Transaction Summary.json`,
      `aha-hpa-transaction-summary-${reportMonth}.json`,
    ]),
    "application/json; charset=utf-8"
  );
  pushArtifact(
    "summary-letter",
    "Download Final Summary Letter",
    findSummaryLetterDocx(runDir),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  pushArtifact(
    "summary-letter-preview",
    "Open Final Summary Letter Preview",
    findFirstExistingArtifactFile(runDir, [
      `${filePrefix}_Premier - Letter.pdf`,
      `${filePrefix}_Premier - Letter.html`,
      `final-summary-letter-${reportMonth}.pdf`,
      `final-summary-letter-${reportMonth}.html`,
    ]),
    fs.existsSync(path.join(runDir, `${filePrefix}_Premier - Letter.pdf`))
      || fs.existsSync(path.join(runDir, `final-summary-letter-${reportMonth}.pdf`))
      ? "application/pdf"
      : "text/html; charset=utf-8"
  );
  pushArtifact(
    "summary-letter-json",
    "Download Final Summary Letter JSON",
    findFirstExistingArtifactFile(runDir, [
      `${filePrefix}_Premier - Letter.json`,
      `final-summary-letter-${reportMonth}.json`,
    ]),
    "application/json; charset=utf-8"
  );
  return artifacts;
}

function normalizeRunForSerialization(run) {
  const storedArtifacts = Array.isArray(run?.artifacts) ? run.artifacts.filter(Boolean) : [];
  const recoveredArtifacts = buildRecoveredArtifacts(run);
  if (!storedArtifacts.length && !recoveredArtifacts.length) {
    return run;
  }

  const shouldMergeRecoveredArtifacts =
    run?.reportType === FINAL_SUMMARY_LETTER_REPORT_TYPE ||
    !storedArtifacts.length;
  if (!shouldMergeRecoveredArtifacts) {
    return run;
  }

  const mergedArtifacts = [];
  const seenArtifactKeys = new Set();
  [...storedArtifacts, ...recoveredArtifacts].forEach((artifact) => {
    const key = `${String(artifact?.kind || "").trim()}::${String(artifact?.fileName || "").trim()}`;
    if (!String(artifact?.fileName || "").trim() || seenArtifactKeys.has(key)) {
      return;
    }
    seenArtifactKeys.add(key);
    mergedArtifacts.push(artifact);
  });

  if (!mergedArtifacts.length) {
    return run;
  }

  return {
    ...run,
    status:
      String(run?.status || "").toLowerCase() === "running"
        ? "complete"
        : run.status,
    statusDetail:
      String(run?.status || "").toLowerCase() === "running"
        ? "Recovered completed artifacts from the saved batch output."
        : run.statusDetail,
    artifacts: mergedArtifacts,
  };
}

function serializeRun(run) {
  const normalizedRun = normalizeRunForSerialization(run);
  const reportName =
    normalizedRun.reportType === FINAL_SUMMARY_LETTER_REPORT_TYPE
      ? FINAL_SUMMARY_LETTER_REPORT_NAME
      : getMonthlyReportType(normalizedRun.reportType || DEFAULT_MONTHLY_REPORT_TYPE)?.name ||
        "Monthly Report";

  return {
    id: normalizedRun.id,
    reportType: normalizedRun.reportType || DEFAULT_MONTHLY_REPORT_TYPE,
    reportName,
    reportMonth: normalizedRun.reportMonth,
    reportMonthLabel: formatReportMonth(normalizedRun.reportMonth),
    status: normalizedRun.status,
    createdAt: normalizedRun.createdAt,
    updatedAt: normalizedRun.updatedAt,
    statusDetail: normalizedRun.statusDetail,
    options: normalizedRun.options || {},
    report: normalizedRun.report || null,
    artifacts: (normalizedRun.artifacts || []).map((artifact) => ({
      kind: artifact.kind,
      label: artifact.label,
      fileName: artifact.fileName,
      url: `/api/monthly-reports/${normalizedRun.id}/artifacts/${artifact.fileName}`,
    })),
  };
}

function resolveMonthlySummaryPremiumTotal(runs, reportMonth, requestedValue) {
  if (requestedValue !== null && requestedValue !== undefined && requestedValue !== "") {
    return Number(requestedValue);
  }

  const matchingRun = runs.find(
    (entry) =>
      entry.reportType === "transaction-summary" &&
      entry.reportMonth === reportMonth &&
      entry.status === "complete" &&
      entry.report?.totals?.grossPremium !== undefined
  );

  return matchingRun ? Number(matchingRun.report.totals.grossPremium) : null;
}

function createRun(
  reportType = DEFAULT_MONTHLY_REPORT_TYPE,
  reportMonth = getPreviousMonthValue(),
  options = {}
) {
  const reportTypeConfig = getMonthlyReportType(reportType);

  if (!reportTypeConfig) {
    throw new Error(`Unknown report type: ${reportType}`);
  }

  const runs = readRuns();
  const newRun = {
    id: createRunId(),
    reportType,
    reportMonth,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusDetail: `Queued ${reportTypeConfig.shortName || reportTypeConfig.name} Salesforce-backed report run.`,
    artifacts: [],
    report: null,
    options: {
      ...options,
      source: options.source || "single",
      batchId: options.batchId || null,
    },
  };

  runs.unshift(newRun);
  writeRuns(runs);

  setTimeout(async () => {
    try {
      let report = null;

      if (newRun.reportType === "amalgamated-premium-remittance") {
        const currentRuns = readRuns();
        report = await buildReportForType(newRun.reportType, newRun.reportMonth, {
          reportMonth: newRun.reportMonth,
          sourceMode: options.sourceMode || "live",
          uploadedFiles: options.uploadedFiles || {},
          monthlySummaryPremiumTotal: resolveMonthlySummaryPremiumTotal(
            currentRuns,
            newRun.reportMonth,
            options.monthlySummaryPremiumTotal
          ),
        });
      } else {
        const sourceData = await fetchMonthlySalesforceReportData(
          newRun.reportType || DEFAULT_MONTHLY_REPORT_TYPE,
          newRun.reportMonth
        );
        report = await buildReportForType(newRun.reportType, newRun.reportMonth, sourceData);
      }
      const artifacts = writeRunArtifacts(newRun.id, newRun.reportType, report);

      updateStoredRun(newRun.id, (run) => {
        run.status = "complete";
        run.updatedAt = new Date().toISOString();
        run.statusDetail = report?.printArtifactWarning
          ? `Salesforce report run completed successfully. ${report.printArtifactWarning}`
          : "Salesforce report run completed successfully.";
        run.report = compactReportPayload(run.reportType, report);
        run.artifacts = artifacts;
      });
    } catch (error) {
      updateStoredRun(newRun.id, (run) => {
        run.status = "failed";
        run.updatedAt = new Date().toISOString();
        run.statusDetail = error.message;
      });
    }
  }, 1200);

  return serializeRun(newRun);
}

function createSyntheticRun(reportType, reportMonth = getPreviousMonthValue(), options = {}) {
  const runs = readRuns();
  const reportTypeName =
    reportType === FINAL_SUMMARY_LETTER_REPORT_TYPE
      ? FINAL_SUMMARY_LETTER_REPORT_NAME
      : getMonthlyReportType(reportType)?.name || "Monthly report";
  const newRun = {
    id: createRunId(),
    reportType,
    reportMonth,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusDetail: `Queued ${reportTypeName}.`,
    artifacts: [],
    report: null,
    options: {
      ...(options || {}),
      source: options.source || "batch",
    },
  };

  runs.unshift(newRun);
  writeRuns(runs);
  return newRun;
}

function copySummaryLetterArtifactsToRun(summaryRunId, targetRunId) {
  const sourceRunDir = path.join(GENERATED_DIR, summaryRunId);
  const targetRunDir = path.join(GENERATED_DIR, targetRunId);
  ensureDir(targetRunDir);

  if (!fs.existsSync(sourceRunDir)) {
    return [];
  }

  const summaryRun = readRuns().find((entry) => entry.id === summaryRunId);
  if (!summaryRun) {
    return [];
  }

  const summaryArtifacts = (summaryRun.artifacts || []).filter(
    (artifact) => String(artifact?.kind || "").trim() === "print"
  );
  const copiedArtifacts = [];

  summaryArtifacts.forEach((artifact) => {
    const sourceFile = path.join(sourceRunDir, artifact.fileName);
    const targetFile = path.join(targetRunDir, artifact.fileName);
    if (!fs.existsSync(sourceFile)) {
      return;
    }

    fs.copyFileSync(sourceFile, targetFile);
    copiedArtifacts.push({ ...artifact });
  });

  return copiedArtifacts;
}

function createFinalSummaryLetterRun(summaryRunId, reportMonth, options = {}) {
  const letterRun = createSyntheticRun(FINAL_SUMMARY_LETTER_REPORT_TYPE, reportMonth, options);
  const monitor = () => {
    try {
      const currentRuns = readRuns();
      const letterRunState = currentRuns.find((entry) => entry.id === letterRun.id);
      const summaryRun = currentRuns.find((entry) => entry.id === summaryRunId);

      if (!letterRunState) {
        return;
      }

      if (!summaryRun) {
        updateStoredRun(letterRun.id, (run) => {
          run.status = "failed";
          run.statusDetail = "Transaction summary run was not found for this batch.";
          run.updatedAt = new Date().toISOString();
        });
        return;
      }

      if (summaryRun.status === "failed") {
        updateStoredRun(letterRun.id, (run) => {
          run.status = "failed";
          run.statusDetail = `Final summary letter requires a complete summary report: ${summaryRun.statusDetail || "summary failed"}.`;
          run.updatedAt = new Date().toISOString();
        });
        return;
      }

      if (summaryRun.status === "complete" && summaryRun.report) {
        try {
          const summaryArtifacts = Array.isArray(summaryRun.artifacts) ? summaryRun.artifacts : [];
          const summaryHasLetterArtifacts = summaryArtifacts.some((artifact) =>
            String(artifact?.kind || "").trim() === "print"
          );

          if (
            !summaryRun.report.finalSummaryLetter ||
            !summaryRun.report.finalSummaryLetter.reportMonth ||
            !summaryHasLetterArtifacts
          ) {
            generateFinalSummaryLetter(summaryRun.id);
          }

          const updatedRuns = readRuns();
          const freshSummaryRun = updatedRuns.find((entry) => entry.id === summaryRun.id);
          if (!updatedRuns.find((entry) => entry.id === letterRun.id)) {
            return;
          }

          const copiedArtifacts = copySummaryLetterArtifactsToRun(summaryRun.id, letterRun.id);
          const letterArtifacts = copiedArtifacts.length
            ? copiedArtifacts
            : (freshSummaryRun?.artifacts || []).filter((artifact) =>
                String(artifact?.kind || "").trim() === "print"
              );
          if (!letterArtifacts.length) {
            throw new Error("Final summary letter finished without any downloadable files.");
          }

          updateStoredRun(letterRun.id, (run) => {
            run.status = "complete";
            run.updatedAt = new Date().toISOString();
            run.statusDetail = `Final summary letter generated for ${formatReportMonth(
              summaryRun.reportMonth || reportMonth
            )}.`;
            run.report = {
              reportMonth: summaryRun.reportMonth || reportMonth,
              finalSummaryLetter: freshSummaryRun?.report?.finalSummaryLetter || null,
            };
            if (letterArtifacts.length) {
              run.artifacts = letterArtifacts;
            }
          });
          return;
        } catch (error) {
          updateStoredRun(letterRun.id, (run) => {
            run.status = "failed";
            run.statusDetail = error.message;
            run.updatedAt = new Date().toISOString();
          });
          return;
        }
      }

      if (summaryRun.status === "complete" && !summaryRun.report) {
        updateStoredRun(letterRun.id, (run) => {
          run.status = "failed";
          run.statusDetail = "Summary report completed without summary data.";
          run.updatedAt = new Date().toISOString();
        });
        return;
      }

      setTimeout(monitor, 1500);
    } catch {
      setTimeout(monitor, 1500);
    }
  };

  setTimeout(monitor, 1500);
  return serializeRun(letterRun);
}

function createMonthEndBatch(
  reportMonth = getPreviousMonthValue(),
  options = {}
) {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const batchOptions = {
    ...options,
    source: "batch",
    batchId,
  };
  const summaryRun = createRun("transaction-summary", reportMonth, batchOptions);
  const detailRun = createRun("transaction-detail", reportMonth, batchOptions);
  const amalgamatedRun = createRun("amalgamated-premium-remittance", reportMonth, batchOptions);
  const finalSummaryLetterRun = createFinalSummaryLetterRun(summaryRun.id, reportMonth, batchOptions);

  return {
    batchId,
    reportMonth,
    reportMonthLabel: formatReportMonth(reportMonth),
    status: "running",
    statusDetail:
      "Queued the full month-end package: summary, detail, Amalgamated remittance, and final summary letter.",
    runs: [summaryRun, detailRun, amalgamatedRun, finalSummaryLetterRun],
  };
}

function listRuns() {
  return readRuns().map(serializeRun);
}

function clearRunsForMonth(reportMonth) {
  const targetMonth = String(reportMonth || "").trim();
  if (!targetMonth) {
    throw new Error("Report month is required.");
  }

  const runs = readRuns();
  const remainingRuns = [];
  let removedCount = 0;

  runs.forEach((run) => {
    if (String(run?.reportMonth || "").trim() !== targetMonth) {
      remainingRuns.push(run);
      return;
    }

    removedCount += 1;
    const runDir = path.join(GENERATED_DIR, String(run?.id || "").trim());
    if (fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  writeRuns(remainingRuns);

  return {
    reportMonth: targetMonth,
    reportMonthLabel: formatReportMonth(targetMonth),
    removedCount,
    runs: remainingRuns.map(serializeRun),
  };
}

function getRun(runId) {
  const run = readRuns().find((entry) => entry.id === runId);
  return run ? serializeRun(run) : null;
}

function getArtifactPath(runId, fileName) {
  const run = readRuns().find((entry) => entry.id === runId);

  if (!run) {
    return null;
  }

  const normalizedRun = normalizeRunForSerialization(run);
  const decodedFileName = decodeURIComponent(String(fileName || ""));
  const artifact = (normalizedRun.artifacts || []).find(
    (entry) => entry.fileName === decodedFileName
  );

  if (!artifact) {
    return null;
  }

  return {
    filePath: path.join(GENERATED_DIR, runId, artifact.fileName),
    contentType: artifact.contentType,
  };
}

function generateFinalSummaryLetter(runId) {
  const runs = readRuns();
  const run = runs.find((entry) => entry.id === runId);

  if (!run) {
    throw new Error("Run not found.");
  }

  if (run.reportType !== "transaction-summary") {
    throw new Error("Final summary letters are only available for the monthly transaction summary report.");
  }

  if (run.status !== "complete" || !run.report) {
    throw new Error("Complete the monthly transaction summary report before generating the final summary letter.");
  }

  const { letterData, artifacts } = createFinalSummaryLetterArtifacts(run.id, run.report);
  const existingArtifacts = (run.artifacts || []).filter(
    (artifact) => String(artifact?.kind || "").trim() !== "print"
  );

  run.artifacts = [...existingArtifacts, ...artifacts];
  run.updatedAt = new Date().toISOString();
  run.statusDetail = `Final summary letter generated for ${letterData.reportMonthLabel}.`;
  run.report.finalSummaryLetter = letterData;
  writeRuns(runs);

  return serializeRun(run);
}

module.exports = {
  buildFinalSummaryLetterData,
  clearRunsForMonth,
  initializeReportRunPersistence,
  createMonthEndBatch,
  formatReportMonth,
  createRun,
  generateFinalSummaryLetter,
  getArtifactPath,
  getPreviousMonthValue,
  getRun,
  listRuns,
  validateFinalSummaryLetterData,
};
