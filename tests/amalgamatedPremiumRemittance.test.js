const test = require("node:test");
const assert = require("node:assert/strict");

const { combineTransactions, summarizeTransactions } = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/combineTransactions");
const { buildFinalRows, applyAgeReduction } = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/buildFinalRows");
const { normalizeDatasets } = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/normalize");
const { getDynamicColumnLabels } = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/config");
const { validateReport } = require("../src/reports/monthEnd/amalgamatedPremiumRemittance/validate");
const {
  buildFinalSummaryLetterData,
  validateFinalSummaryLetterData,
} = require("../services/monthlyReportService");

function buildBaseDatasets() {
  return normalizeDatasets({
    certs: [
      {
        "Certificate Name": "CERT-1",
        "Billing State/Province": "NV",
        Product: "AD&D & LIFE",
        "Policy Type": "2 People",
        "Effective Date": "2024-01-01",
        "Pay To Date": "2024-12-31",
        "Orig Rate (1 Person)": "0.18",
        "Orig Rate (2 Person)": "0.27",
        "Total AD&D Coverage": "100000",
        "Free Term Life Coverage Amt": "2000",
        "Orig Contrib AD&D Coverage Amt": "90000",
        "Orig Non-Contrib AD&D Coverage Amt": "10000",
      },
      {
        "Certificate Name": "CERT-2",
        "Billing State/Province": "CA",
        Product: "AD&D reduced",
        "Policy Type": "1 Person",
        "Effective Date": "2024-02-01",
        "Pay To Date": "2024-12-31",
        "Orig Rate (1 Person)": "0.12",
        "Orig Rate (2 Person)": "0.22",
        "Total AD&D Coverage": "80000",
        "Free Term Life Coverage Amt": "0",
        "Orig Contrib AD&D Coverage Amt": "70000",
        "Orig Non-Contrib AD&D Coverage Amt": "10000",
      },
    ],
    payments: [
      { Certificate: "CERT-1", "Months Paid": "2", Premium: "30.00" },
      { Certificate: "CERT-1", "Months Paid": "1", Premium: "15.00" },
      { Certificate: "CERT-2", "Months Paid": "1", Premium: "12.00" },
    ],
    credits: [
      { "Certificate / Certificate Name": "CERT-1", "Rollback Months": "1", Premium: "10.00" },
    ],
    contact1: [
      {
        "Certificate Name": "CERT-1",
        "First Name": "Jane",
        "Middle Name": "",
        "Last Name": "Smith",
        "Date of Birth": "1958-01-01",
        "Starting Age Calc": "70",
        "Current Age": "76",
      },
      {
        "Certificate Name": "CERT-2",
        "First Name": "Bob",
        "Middle Name": "A",
        "Last Name": "Jones",
        "Date of Birth": "1940-01-01",
        "Starting Age Calc": "80",
        "Current Age": "86",
      },
    ],
    contact2: [
      {
        "Certificate Name": "CERT-1",
        "First Name": "John",
        "Middle Name": "",
        "Last Name": "Smith",
        "Date of Birth": "1960-01-01",
        "Starting Age Calc": "69",
        "Current Age": "74",
      },
    ],
  });
}

test("payment and credit merge keeps payments positive and converts credits negative", () => {
  const datasets = buildBaseDatasets();
  const combined = combineTransactions(datasets.payments, datasets.credits);

  assert.equal(combined.length, 4);
  assert.equal(combined[0].premium, 30);
  assert.equal(combined[3].monthsPaid, -1);
  assert.equal(combined[3].premium, -10);
});

test("duplicate certificates are combined correctly", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const cert1 = summarized.find((row) => row.certificateNumber === "CERT-1");

  assert.equal(cert1.monthsPaid, 2);
  assert.equal(cert1.premium, 35);
});

test("member 1 name formatting trims middle-name gaps", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const report = buildFinalRows("2026-06", datasets, summarized);
  const cert1 = report.rows.find((row) => row.certificate === "CERT-1");

  assert.equal(cert1.member1, "Jane Smith");
});

test("member 2 missing behavior leaves values blank", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const report = buildFinalRows("2026-06", datasets, summarized);
  const cert2 = report.rows.find((row) => row.certificate === "CERT-2");

  assert.equal(cert2.member2, "");
  assert.equal(cert2.member2Dob, "");
  assert.equal(cert2.member2AddBenefit, null);
});

test("one-person vs two-person policy member count and rate selection work", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const report = buildFinalRows("2026-06", datasets, summarized);
  const cert1 = report.rows.find((row) => row.certificate === "CERT-1");
  const cert2 = report.rows.find((row) => row.certificate === "CERT-2");

  assert.equal(cert1.memberCount, 2);
  assert.equal(cert1.rate, 0.27);
  assert.equal(cert2.memberCount, 1);
  assert.equal(cert2.rate, 0.12);
});

test("premium split uses 41 percent Amal and 59 percent AHA", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const report = buildFinalRows("2026-06", datasets, summarized);
  const cert1 = report.rows.find((row) => row.certificate === "CERT-1");

  assert.equal(cert1.premiumCollectedLabelValue, 35);
  assert.equal(cert1.amalPrem, 14.35);
  assert.equal(cert1.ahaPrem, 20.65);
});

test("age reduction at 70 and 80 works", () => {
  assert.equal(applyAgeReduction(100, 70), 50);
  assert.equal(applyAgeReduction(100, 80), 20);
});

test("premium total validation against monthly summary flags mismatches", () => {
  const datasets = buildBaseDatasets();
  const summarized = summarizeTransactions(combineTransactions(datasets.payments, datasets.credits));
  const report = buildFinalRows("2026-06", datasets, summarized);
  const validation = validateReport({
    datasets,
    combinedTransactions: combineTransactions(datasets.payments, datasets.credits),
    summarizedTransactions: summarized,
    finalRows: report.rows,
    monthlySummaryPremiumTotal: 999,
  });

  assert.equal(validation.validation.matchesMonthlySummary, false);
  assert.match(validation.validation.message, /does not match/i);
});

test("missing transaction certificate in cert report is warning-only", () => {
  const datasets = normalizeDatasets({
    certs: [],
    payments: [{ Certificate: "MISSING", "Months Paid": "1", Premium: "12" }],
    credits: [],
    contact1: [],
    contact2: [],
  });
  const combined = combineTransactions(datasets.payments, datasets.credits);
  const summarized = summarizeTransactions(combined);
  const report = buildFinalRows("2026-06", datasets, summarized);
  const validation = validateReport({
    datasets,
    combinedTransactions: combined,
    summarizedTransactions: summarized,
    finalRows: report.rows,
    monthlySummaryPremiumTotal: 12,
  });

  assert.ok(validation.warnings.some((issue) => issue.code === "transaction-cert-not-found"));
  assert.equal(validation.blockingErrors.some((issue) => issue.code === "transaction-cert-not-found"), false);
});

test("salesforce label values are preferred over record ids for certificate matching", () => {
  const datasets = normalizeDatasets({
    certs: [
      {
        "Certificate Name": "0015G00002LhWcFQAV",
        "Certificate Name__label": "257795",
        "Billing State/Province": "OH",
        Product: "AD&D",
        "Policy Type": "2 People",
        "Effective Date": "2024-01-01",
        "Pay To Date": "2024-12-31",
        "Orig Rate (1 Person)": "0.22",
        "Orig Rate (2 Person)": "0.33",
      },
    ],
    payments: [
      {
        Certificate: "0015G00002LhWcFQAV",
        "Certificate__label": "257795",
        "Months Paid": "1",
        Premium: "12.00",
      },
    ],
    credits: [],
    contact1: [
      {
        "Certificate Name": "0015G00002LhWcFQAV",
        "Certificate Name__label": "257795",
        "First Name": "Jane",
        "Last Name": "Smith",
      },
    ],
    contact2: [],
  });

  const combined = combineTransactions(datasets.payments, datasets.credits);
  const summarized = summarizeTransactions(combined);
  const report = buildFinalRows("2026-06", datasets, summarized);
  const validation = validateReport({
    datasets,
    combinedTransactions: combined,
    summarizedTransactions: summarized,
    finalRows: report.rows,
    monthlySummaryPremiumTotal: 12,
  });

  assert.equal(datasets.certs[0].certificateNumber, "257795");
  assert.equal(datasets.payments[0].certificateNumber, "257795");
  assert.equal(report.rows[0].certificate, "257795");
  assert.equal(
    validation.blockingErrors.some((issue) => issue.code === "transaction-cert-not-found"),
    false
  );
});

test("dynamic report month labels update with the selected month", () => {
  const labels = getDynamicColumnLabels("2026-06");

  assert.equal(labels.monthsPaidLabel, "Months Paid for in Jun 2026");
  assert.equal(labels.premiumCollectedLabel, "Premium Collected in Jun 2026");
});

test("final summary letter data is derived from summary totals", () => {
  const letterData = buildFinalSummaryLetterData({
    reportMonth: "2026-05",
    totals: {
      totalSubmitted: 314278.36,
      amalgamatedPremium: 126547.29,
      hpaCommission: 182231.07,
      ahaDues: 5500,
      ftjFee: 5200,
      estimatedBankFee: 0,
    },
  });

  assert.equal(letterData.reportMonthLabel, "May-2026");
  assert.equal(letterData.fundsReceived, 314278.36);
  assert.equal(letterData.amalgamatedPremium, 126547.29);
  assert.equal(letterData.hpaCommission, 182231.07);
  assert.equal(letterData.ahaDues, 5500);
  assert.equal(letterData.ftjFee, 5200);
  assert.equal(letterData.bankFee, 0);
});

test("final summary letter validation rejects non-reconciling totals", () => {
  assert.throws(
    () =>
      validateFinalSummaryLetterData({
        letterDate: "June 15, 2026",
        reportMonthLabel: "May-2026",
        fundsReceived: 100,
        amalgamatedPremium: 41,
        hpaCommission: 59,
        ahaDues: 10,
        ftjFee: 5.5,
        bankFee: 3.5,
      }),
    /do not reconcile/i
  );
});
