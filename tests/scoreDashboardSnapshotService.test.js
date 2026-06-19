const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNextScheduledCaptureTime,
  normalizeScorePeriodLabel,
  parseMetricValue,
  parseReportMetricRows,
  scoreDashboardSnapshotConfig,
} = require("../services/scoreDashboardSnapshotService");

function buildSingleGroupingPayload() {
  return {
    reportMetadata: {
      aggregates: ["s!ACTIVE", "s!PREMIUM"],
    },
    reportExtendedMetadata: {
      groupingColumnInfo: {
        SCORE_PERIOD: {
          label: "Score Period",
          groupingLevel: 0,
        },
      },
      aggregateColumnInfo: {
        "s!ACTIVE": {
          label: "Sum of Active_Clients",
        },
        "s!PREMIUM": {
          label: "Sum of Total_Premium_With_Dues",
        },
      },
    },
    groupingsDown: {
      groupings: [
        {
          key: "0",
          label: "1. Current Month",
          groupings: [],
        },
        {
          key: "1",
          label: "2. Last Month",
          groupings: [],
        },
      ],
    },
    factMap: {
      "0!T": {
        aggregates: [{ label: "5,109" }, { label: "$301,053.54" }],
      },
      "1!T": {
        aggregates: [{ label: "4,800" }, { label: "$280,000.00" }],
      },
    },
  };
}

function buildDoubleGroupingPayload() {
  return {
    reportMetadata: {
      aggregates: ["s!AMOUNT"],
    },
    reportExtendedMetadata: {
      groupingColumnInfo: {
        PAYMENT_TYPE: {
          label: "Payment Type",
          groupingLevel: 0,
        },
        SCORE_PERIOD: {
          label: "Score Period",
          groupingLevel: 1,
        },
      },
      aggregateColumnInfo: {
        "s!AMOUNT": {
          label: "Sum of Amount",
        },
      },
    },
    groupingsDown: {
      groupings: [
        {
          key: "0",
          label: "ACH",
          groupings: [
            {
              key: "0_0",
              label: "1. Current Month",
              groupings: [],
            },
            {
              key: "0_1",
              label: "2. Last Month",
              groupings: [],
            },
          ],
        },
        {
          key: "1",
          label: "Check",
          groupings: [
            {
              key: "1_0",
              label: "1. Current Month",
              groupings: [],
            },
          ],
        },
      ],
    },
    factMap: {
      "0_0!T": {
        aggregates: [{ label: "$108,521.74" }],
      },
      "0_1!T": {
        aggregates: [{ label: "$108,739.42" }],
      },
      "1_0!T": {
        aggregates: [{ label: "$36,689.60" }],
      },
    },
  };
}

function buildAcrossOnlyPayload() {
  return {
    reportMetadata: {
      aggregates: ["s!AMOUNT"],
    },
    reportExtendedMetadata: {
      groupingColumnInfo: {
        SCORE_PERIOD: {
          label: "Score Period",
          groupingLevel: 0,
        },
      },
      aggregateColumnInfo: {
        "s!AMOUNT": {
          label: "Sum of Amount",
        },
      },
    },
    groupingsAcross: {
      groupings: [
        {
          key: "0",
          label: "1. Current Month",
          groupings: [],
        },
        {
          key: "1",
          label: "2. Last Month",
          groupings: [],
        },
        {
          key: "2",
          label: "3. Last Year",
          groupings: [],
        },
      ],
    },
    factMap: {
      "T!0": {
        aggregates: [{ label: "$200,709.55" }],
      },
      "T!1": {
        aggregates: [{ label: "$203,284.80" }],
      },
      "T!2": {
        aggregates: [{ label: "$215,228.65" }],
      },
    },
  };
}

function buildMatrixPayload() {
  return {
    reportMetadata: {
      aggregates: ["s!AMOUNT"],
    },
    reportExtendedMetadata: {
      groupingColumnInfo: {
        PAYMENT_TYPE: {
          label: "Payment Type",
          groupingLevel: 0,
        },
        SCORE_PERIOD: {
          label: "Score Period",
          groupingLevel: 1,
        },
      },
      aggregateColumnInfo: {
        "s!AMOUNT": {
          label: "Sum of Amount",
        },
      },
    },
    groupingsDown: {
      groupings: [
        {
          key: "0",
          label: "ACH",
          groupings: [],
        },
        {
          key: "1",
          label: "Credit Card",
          groupings: [],
        },
        {
          key: "2",
          label: "Check",
          groupings: [],
        },
      ],
    },
    groupingsAcross: {
      groupings: [
        {
          key: "0_0",
          label: "1. Current Month",
          groupings: [],
        },
        {
          key: "0_1",
          label: "2. Last Month",
          groupings: [],
        },
        {
          key: "0_2",
          label: "3. Last Year",
          groupings: [],
        },
      ],
    },
    factMap: {
      "0!0_0": { aggregates: [{ label: "$108,452.36" }] },
      "0!0_1": { aggregates: [{ label: "$108,729.51" }] },
      "0!0_2": { aggregates: [{ label: "$110,175.03" }] },
      "1!0_0": { aggregates: [{ label: "$54,357.48" }] },
      "1!0_1": { aggregates: [{ label: "$59,925.77" }] },
      "1!0_2": { aggregates: [{ label: "$55,805.90" }] },
      "2!0_0": { aggregates: [{ label: "$36,792.81" }] },
      "2!0_1": { aggregates: [{ label: "$34,629.52" }] },
      "2!0_2": { aggregates: [{ label: "$49,247.72" }] },
    },
  };
}

test("normalizeScorePeriodLabel strips Salesforce numeric prefixes", () => {
  assert.equal(normalizeScorePeriodLabel("1. Current Month"), "Current Month");
  assert.equal(normalizeScorePeriodLabel("4. 2 Years Ago"), "2 Years Ago");
});

test("parseMetricValue keeps blanks as null and parses currency", () => {
  assert.equal(parseMetricValue(""), null);
  assert.equal(parseMetricValue("$301,053.54"), 301053.54);
  assert.equal(parseMetricValue("5,109"), 5109);
});

test("parseReportMetricRows parses score-period grouped SCORE rows", () => {
  const reportConfig = scoreDashboardSnapshotConfig.reports.find((entry) => entry.reportKey === "score");
  const parsed = parseReportMetricRows(
    reportConfig,
    {},
    buildSingleGroupingPayload(),
    "2026-06-19",
    "2026-06-19T10:00:00.000Z"
  );

  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(
    parsed.rows.map((row) => ({
      scorePeriod: row.score_period,
      metricKey: row.metric_key,
      metricValue: row.metric_value,
    })),
    [
      { scorePeriod: "Current Month", metricKey: "active_clients", metricValue: 5109 },
      { scorePeriod: "Current Month", metricKey: "total_premium_with_dues", metricValue: 301053.54 },
      { scorePeriod: "Last Month", metricKey: "active_clients", metricValue: 4800 },
      { scorePeriod: "Last Month", metricKey: "total_premium_with_dues", metricValue: 280000 },
    ]
  );
});

test("parseReportMetricRows parses payment-type then score-period rows", () => {
  const reportConfig = scoreDashboardSnapshotConfig.reports.find(
    (entry) => entry.reportKey === "moneyReceivedByPayType"
  );
  const parsed = parseReportMetricRows(
    reportConfig,
    {},
    buildDoubleGroupingPayload(),
    "2026-06-19",
    "2026-06-19T10:00:00.000Z"
  );

  assert.deepEqual(
    parsed.rows.map((row) => ({
      paymentType: row.payment_type,
      scorePeriod: row.score_period,
      metricValue: row.metric_value,
    })),
    [
      { paymentType: "ACH", scorePeriod: "Current Month", metricValue: 108521.74 },
      { paymentType: "ACH", scorePeriod: "Last Month", metricValue: 108739.42 },
      { paymentType: "Check", scorePeriod: "Current Month", metricValue: 36689.6 },
    ]
  );
});

test("parseReportMetricRows parses score-period rows from groupingsAcross", () => {
  const reportConfig = scoreDashboardSnapshotConfig.reports.find(
    (entry) => entry.reportKey === "moneyReceived"
  );
  const parsed = parseReportMetricRows(
    reportConfig,
    {},
    buildAcrossOnlyPayload(),
    "2026-06-19",
    "2026-06-19T10:00:00.000Z"
  );

  assert.deepEqual(
    parsed.rows.map((row) => ({
      scorePeriod: row.score_period,
      metricValue: row.metric_value,
    })),
    [
      { scorePeriod: "Current Month", metricValue: 200709.55 },
      { scorePeriod: "Last Month", metricValue: 203284.8 },
      { scorePeriod: "Last Year", metricValue: 215228.65 },
    ]
  );
});

test("parseReportMetricRows parses matrix payment-type rows from down and across groupings", () => {
  const reportConfig = scoreDashboardSnapshotConfig.reports.find(
    (entry) => entry.reportKey === "moneyReceivedByPayType"
  );
  const parsed = parseReportMetricRows(
    reportConfig,
    {},
    buildMatrixPayload(),
    "2026-06-19",
    "2026-06-19T10:00:00.000Z"
  );

  assert.equal(parsed.rows.length, 9);
  assert.deepEqual(
    parsed.rows.slice(0, 3).map((row) => ({
      paymentType: row.payment_type,
      scorePeriod: row.score_period,
      metricValue: row.metric_value,
    })),
    [
      { paymentType: "ACH", scorePeriod: "Current Month", metricValue: 108452.36 },
      { paymentType: "ACH", scorePeriod: "Last Month", metricValue: 108729.51 },
      { paymentType: "ACH", scorePeriod: "Last Year", metricValue: 110175.03 },
    ]
  );
});

test("getNextScheduledCaptureTime stays on the same day before 6am and moves to next day after", () => {
  const beforeRun = new Date("2026-06-19T05:15:00");
  const sameDay = getNextScheduledCaptureTime(beforeRun, { hour: 6, minute: 0 });
  assert.equal(sameDay.getFullYear(), 2026);
  assert.equal(sameDay.getMonth(), 5);
  assert.equal(sameDay.getDate(), 19);
  assert.equal(sameDay.getHours(), 6);
  assert.equal(sameDay.getMinutes(), 0);

  const afterRun = new Date("2026-06-19T06:15:00");
  const nextDay = getNextScheduledCaptureTime(afterRun, { hour: 6, minute: 0 });
  assert.equal(nextDay.getDate(), 20);
  assert.equal(nextDay.getHours(), 6);
  assert.equal(nextDay.getMinutes(), 0);
});
