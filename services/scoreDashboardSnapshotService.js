const fs = require("fs");
const path = require("path");
const {
  getConnectedSalesforceToken,
  executeSavedReport,
  fetchDashboard,
  fetchDashboardResults,
} = require("./salesforceClient");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOTS_PATH = path.join(DATA_DIR, "salesforce-score-snapshots.json");
const SNAPSHOTS_SUPABASE_KEY = "salesforce-score-snapshots.json";
const SCORE_PERIOD_ORDER = ["Current Month", "Last Month", "Last Year"];
const PAYMENT_TYPE_ORDER = ["ACH", "Credit Card", "Check", "Not Provided"];
const FAILURE_METRIC_KEY = "__report_capture__";
const DEFAULT_SCHEDULE_HOUR = 6;
const DEFAULT_SCHEDULE_MINUTE = 0;

const scoreDashboardSnapshotConfig = Object.freeze({
  dashboardKey: "scoreReport",
  dashboardName: "SCORE Report",
  salesforceDashboardId: normalizeText(process.env.SALESFORCE_SCORE_DASHBOARD_ID || ""),
  reports: [
    {
      reportKey: "score",
      reportLabel: "SCORE",
      salesforceReportId: "00OQm000001y7MDMAY",
      dashboardComponentLabels: ["Score", "SCORE"],
      expectedGroupings: ["Score Period"],
      expectedMetrics: [
        {
          key: "active_clients",
          label: "Active Clients",
          aliases: ["sum of active_clients", "active clients", "sum of active clients"],
          format: "whole",
        },
        {
          key: "total_premium_with_dues",
          label: "Total Premium With Dues",
          aliases: [
            "sum of total_premium_with_dues",
            "total premium with dues",
            "sum of total premium with dues",
          ],
          format: "currency",
        },
      ],
    },
    {
      reportKey: "moneyReceived",
      reportLabel: "Money Received",
      salesforceReportId: "00OQm000001xzA9MAI",
      dashboardComponentLabels: ["Money Received"],
      expectedGroupings: ["Score Period"],
      expectedMetrics: [
        {
          key: "amount",
          label: "Amount",
          aliases: ["sum of amount", "amount"],
          format: "currency",
        },
      ],
    },
    {
      reportKey: "moneyReceivedByPayType",
      reportLabel: "Money Received by Payment Type",
      salesforceReportId: "00OQm000001xzDNMAY",
      dashboardComponentLabels: ["Money Received with PayType", "Money Received by Payment Type"],
      expectedGroupings: ["Payment Type", "Score Period"],
      expectedMetrics: [
        {
          key: "amount",
          label: "Amount",
          aliases: ["sum of amount", "amount"],
          format: "currency",
        },
      ],
    },
    {
      reportKey: "applicationsReceived",
      reportLabel: "Applications Received",
      salesforceReportId: "00OQm000001y6efMAA",
      dashboardComponentLabels: ["Applications Received"],
      expectedGroupings: ["Score Period"],
      expectedMetrics: [
        {
          key: "record_count",
          label: "Record Count",
          aliases: ["record count", "row count"],
          format: "whole",
        },
      ],
    },
  ],
});

let snapshotsCache = null;
let snapshotsDiskWritable = true;
let scoreSnapshotScheduleTimeout = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Unable to parse ${filePath}:`, error.message);
    return clone(fallbackValue);
  }
}

function writeJsonSafe(filePath, payload) {
  ensureStorage();
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    fs.writeFileSync(filePath, serialized, "utf8");
    snapshotsDiskWritable = true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      snapshotsDiskWritable = false;
      console.warn(`Unable to write ${filePath}; continuing with in-memory SCORE snapshot state.`);
      return;
    }
    throw error;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeMetricAlias(value) {
  return normalizeKey(value).replace(/[^a-z0-9 ]+/g, "");
}

function parseMetricValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const isNegativeByParens = text.startsWith("(") && text.endsWith(")");
  const cleaned = text.replace(/[$,%(),\s]/g, "");
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return isNegativeByParens ? -parsed : parsed;
}

function normalizeScorePeriodLabel(value) {
  const text = normalizeText(value).replace(/^\d+\.\s*/, "");
  if (!text) {
    return "";
  }
  return text;
}

function normalizePaymentTypeLabel(value) {
  return normalizeText(value);
}

function getScorePeriodSortValue(value) {
  const normalized = normalizeScorePeriodLabel(value);
  const index = SCORE_PERIOD_ORDER.indexOf(normalized);
  if (index !== -1) {
    return index;
  }
  return SCORE_PERIOD_ORDER.length + 10;
}

function getPaymentTypeSortValue(value) {
  const normalized = normalizePaymentTypeLabel(value);
  const index = PAYMENT_TYPE_ORDER.indexOf(normalized);
  if (index !== -1) {
    return index;
  }
  return PAYMENT_TYPE_ORDER.length + 10;
}

function getSnapshotDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function getLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return getLocalDateKey(new Date());
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseScheduleNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

function getScoreSnapshotScheduleConfig() {
  const enabledValue = String(process.env.SCORE_HISTORY_SCHEDULE_ENABLED || "true").trim().toLowerCase();
  const enabled = !["0", "false", "no", "off"].includes(enabledValue);
  const hour = parseScheduleNumber(process.env.SCORE_HISTORY_SCHEDULE_HOUR, DEFAULT_SCHEDULE_HOUR);
  const minute = parseScheduleNumber(process.env.SCORE_HISTORY_SCHEDULE_MINUTE, DEFAULT_SCHEDULE_MINUTE);

  return {
    enabled,
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
  };
}

function getNextScheduledCaptureTime(now = new Date(), config = getScoreSnapshotScheduleConfig()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(config.hour, config.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function getReportConfig(reportKey) {
  return scoreDashboardSnapshotConfig.reports.find((entry) => entry.reportKey === reportKey) || null;
}

function getConfigPayload() {
  return {
    dashboardKey: scoreDashboardSnapshotConfig.dashboardKey,
    dashboardName: scoreDashboardSnapshotConfig.dashboardName,
    salesforceDashboardId: scoreDashboardSnapshotConfig.salesforceDashboardId,
    scorePeriodOrder: [...SCORE_PERIOD_ORDER],
    paymentTypeOrder: [...PAYMENT_TYPE_ORDER],
    reports: scoreDashboardSnapshotConfig.reports.map((report) => ({
      reportKey: report.reportKey,
      reportLabel: report.reportLabel,
      salesforceReportId: report.salesforceReportId,
      expectedGroupings: clone(report.expectedGroupings),
      expectedMetrics: report.expectedMetrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        format: metric.format || "number",
      })),
    })),
  };
}

function normalizeDashboardLabel(value) {
  return normalizeKey(value).replace(/[^a-z0-9 ]+/g, "");
}

function extractDashboardReportPayload(source, depth = 0, visited = new Set()) {
  if (!source || typeof source !== "object" || depth > 6 || visited.has(source)) {
    return null;
  }
  if (source.factMap && source.reportMetadata) {
    return source;
  }

  visited.add(source);
  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const candidate = extractDashboardReportPayload(value, depth + 1, visited);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function buildDashboardComponentCandidates(dashboardMetadata, dashboardResults) {
  const metadataComponents = [
    ...ensureArray(dashboardMetadata?.dashboardMetadata?.components),
    ...ensureArray(dashboardMetadata?.components),
    ...ensureArray(dashboardResults?.dashboardMetadata?.components),
    ...ensureArray(dashboardResults?.components),
  ];
  const metadataById = new Map(
    metadataComponents
      .filter((component) => component && typeof component === "object")
      .map((component) => [String(component.id || component.name || component.label || ""), component])
      .filter(([key]) => key)
  );

  const componentEntries = Object.entries(dashboardResults?.componentData || {});
  return componentEntries
    .map(([componentId, componentData]) => {
      const metadata = metadataById.get(String(componentId)) || {};
      const reportPayload = extractDashboardReportPayload(componentData);
      const reportId = normalizeText(
        componentData?.reportMetadata?.id ||
        componentData?.reportId ||
        metadata?.reportId ||
        metadata?.reportMetadata?.id ||
        reportPayload?.id
      );
      const label = normalizeText(
        metadata?.title ||
        metadata?.name ||
        metadata?.label ||
        componentData?.name ||
        componentData?.label ||
        componentId
      );

      return {
        componentId: String(componentId),
        label,
        reportId,
        metadata,
        componentData,
        reportPayload,
      };
    })
    .filter((entry) => entry.reportPayload);
}

function findDashboardComponentForReport(dashboardComponents, reportConfig) {
  const reportId = normalizeText(reportConfig.salesforceReportId);
  const labelAliases = new Set(
    [reportConfig.reportLabel, reportConfig.reportKey, ...(reportConfig.dashboardComponentLabels || [])]
      .map((value) => normalizeDashboardLabel(value))
      .filter(Boolean)
  );

  const byReportId = dashboardComponents.find((entry) => normalizeText(entry.reportId) === reportId);
  if (byReportId) {
    return byReportId;
  }

  const byLabel = dashboardComponents.find((entry) => labelAliases.has(normalizeDashboardLabel(entry.label)));
  if (byLabel) {
    return byLabel;
  }

  const candidates = dashboardComponents.filter((entry) => {
    const groupingColumns = getGroupingColumns(entry.reportPayload || {}).map((column) => normalizeKey(column.label));
    const aggregateColumns = getAggregateColumns(entry.reportPayload || {}).map((column) => normalizeMetricAlias(column.label));

    const expectedGroupings = reportConfig.expectedGroupings.map((value) => normalizeKey(value));
    const groupingMatches =
      groupingColumns.length === expectedGroupings.length
      && groupingColumns.every((value, index) => value === expectedGroupings[index]);
    if (!groupingMatches) {
      return false;
    }

    const expectedMetricAliases = reportConfig.expectedMetrics
      .flatMap((metric) => [metric.label, metric.key, ...(metric.aliases || [])])
      .map((value) => normalizeMetricAlias(value));

    return expectedMetricAliases.some((alias) => aggregateColumns.includes(alias));
  });

  if (!candidates.length) {
    return null;
  }

  if (reportConfig.reportKey === "moneyReceivedByPayType") {
    return candidates.find((entry) => Object.keys(entry.reportPayload?.factMap || {}).length > 6) || candidates[0];
  }

  if (reportConfig.reportKey === "score") {
    return candidates.find((entry) => {
      const aggregateColumns = getAggregateColumns(entry.reportPayload || {}).map((column) => normalizeMetricAlias(column.label));
      return aggregateColumns.includes("sum of active clients") || aggregateColumns.includes("sum of active_clients");
    }) || candidates[0];
  }

  if (reportConfig.reportKey === "applicationsReceived") {
    return candidates.find((entry) => {
      const aggregateColumns = getAggregateColumns(entry.reportPayload || {}).map((column) => normalizeMetricAlias(column.label));
      return aggregateColumns.includes("record count");
    }) || candidates[0];
  }

  if (reportConfig.reportKey === "moneyReceived") {
    return candidates.find((entry) => {
      const aggregateColumns = getAggregateColumns(entry.reportPayload || {}).map((column) => normalizeMetricAlias(column.label));
      return aggregateColumns.includes("sum of amount") && !aggregateColumns.includes("sum of active clients");
    }) || candidates[0];
  }

  return candidates[0];
}

async function loadScoreDashboardSourceContext(tokenRecord) {
  const dashboardId = normalizeText(scoreDashboardSnapshotConfig.salesforceDashboardId);
  if (!dashboardId) {
    return null;
  }
  try {
    const dashboardMetadata = await fetchDashboard(tokenRecord, dashboardId);
    let dashboardResults = dashboardMetadata;
    let error = "";
    let errorStatusCode = 0;
    let errorPath = "";
    let errorPayload = null;

    try {
      dashboardResults = await fetchDashboardResults(tokenRecord, dashboardId);
    } catch (resultsError) {
      error = resultsError instanceof Error ? resultsError.message : String(resultsError || "");
      errorStatusCode = resultsError?.statusCode || 0;
      errorPath = resultsError?.salesforcePath || "";
      errorPayload = resultsError?.salesforcePayload || null;
    }

    return {
      dashboardId,
      dashboardMetadata,
      dashboardResults,
      dashboardComponents: buildDashboardComponentCandidates(dashboardMetadata, dashboardResults),
      error,
      errorStatusCode,
      errorPath,
      errorPayload,
    };
  } catch (error) {
    return {
      dashboardId,
      dashboardMetadata: null,
      dashboardResults: null,
      dashboardComponents: [],
      error: error instanceof Error ? error.message : String(error || ""),
      errorStatusCode: error?.statusCode || 0,
      errorPath: error?.salesforcePath || "",
      errorPayload: error?.salesforcePayload || null,
    };
  }
}

async function resolveScoreSnapshotReportExecution(tokenRecord, reportConfig, dashboardContext) {
  const dashboardComponent = findDashboardComponentForReport(
    ensureArray(dashboardContext?.dashboardComponents),
    reportConfig
  );

  if (dashboardComponent?.reportPayload) {
    return {
      describePayload: dashboardComponent.reportPayload,
      reportPayload: dashboardComponent.reportPayload,
      source: "dashboard",
      dashboardComponentId: dashboardComponent.componentId,
      dashboardComponentLabel: dashboardComponent.label,
      dashboardReportId: dashboardComponent.reportId,
    };
  }

  const executed = await executeSavedReport(tokenRecord, reportConfig.salesforceReportId);
  return {
    ...executed,
    source: "report",
    dashboardComponentId: "",
    dashboardComponentLabel: "",
    dashboardReportId: "",
  };
}

function buildRowId(row) {
  return [
    row.snapshot_date,
    row.dashboard_key,
    row.report_key,
    row.score_period || "",
    row.payment_type || "",
    row.metric_key || "",
  ].join("::");
}

function sortSnapshotRows(rows) {
  rows.sort((left, right) => {
    if (left.snapshot_date !== right.snapshot_date) {
      return String(right.snapshot_date).localeCompare(String(left.snapshot_date));
    }

    const reportCompare = String(left.report_label || "").localeCompare(String(right.report_label || ""));
    if (reportCompare !== 0) {
      return reportCompare;
    }

    const paymentSort = getPaymentTypeSortValue(left.payment_type) - getPaymentTypeSortValue(right.payment_type);
    if (paymentSort !== 0) {
      return paymentSort;
    }

    const paymentCompare = String(left.payment_type || "").localeCompare(String(right.payment_type || ""));
    if (paymentCompare !== 0) {
      return paymentCompare;
    }

    const periodSort = getScorePeriodSortValue(left.score_period) - getScorePeriodSortValue(right.score_period);
    if (periodSort !== 0) {
      return periodSort;
    }

    const periodCompare = String(left.score_period || "").localeCompare(String(right.score_period || ""));
    if (periodCompare !== 0) {
      return periodCompare;
    }

    const metricCompare = String(left.metric_label || "").localeCompare(String(right.metric_label || ""));
    if (metricCompare !== 0) {
      return metricCompare;
    }

    return String(right.captured_at || "").localeCompare(String(left.captured_at || ""));
  });

  return rows;
}

function normalizeStoredRows(rows) {
  const normalizedRows = Array.isArray(rows)
    ? rows
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          id: entry.id || buildRowId(entry),
          snapshot_date: normalizeText(entry.snapshot_date),
          captured_at: normalizeText(entry.captured_at),
          salesforce_as_of_text: normalizeText(entry.salesforce_as_of_text),
          dashboard_key: normalizeText(entry.dashboard_key) || scoreDashboardSnapshotConfig.dashboardKey,
          dashboard_name: normalizeText(entry.dashboard_name) || scoreDashboardSnapshotConfig.dashboardName,
          report_key: normalizeText(entry.report_key),
          report_label: normalizeText(entry.report_label),
          score_period: normalizeScorePeriodLabel(entry.score_period),
          payment_type: normalizePaymentTypeLabel(entry.payment_type),
          metric_key: normalizeText(entry.metric_key),
          metric_label: normalizeText(entry.metric_label),
          metric_value: entry.metric_value === null || entry.metric_value === undefined
            ? null
            : Number(entry.metric_value),
          raw_value: entry.raw_value === null || entry.raw_value === undefined ? null : entry.raw_value,
          raw_json: entry.raw_json || null,
          capture_status: normalizeText(entry.capture_status) || "success",
          error_message: normalizeText(entry.error_message),
          created_at: normalizeText(entry.created_at || entry.captured_at),
          updated_at: normalizeText(entry.updated_at || entry.captured_at),
        }))
    : [];

  return sortSnapshotRows(normalizedRows);
}

function readSnapshotRows() {
  if (snapshotsCache) {
    return snapshotsCache;
  }

  ensureStorage();
  snapshotsCache = normalizeStoredRows(safeParseJson(SNAPSHOTS_PATH, []));
  return snapshotsCache;
}

function hasSuccessfulSnapshotForDate(snapshotDate) {
  const dateKey = normalizeText(snapshotDate);
  if (!dateKey) {
    return false;
  }

  return readSnapshotRows().some(
    (row) =>
      row.snapshot_date === dateKey
      && row.capture_status === "success"
      && row.metric_key !== FAILURE_METRIC_KEY
  );
}

function persistSnapshotRows(rows) {
  const normalized = normalizeStoredRows(rows);
  snapshotsCache = normalized;
  if (snapshotsDiskWritable) {
    writeJsonSafe(SNAPSHOTS_PATH, normalized);
  }
  queueStateSync(SNAPSHOTS_SUPABASE_KEY, normalized);
  return normalized;
}

function upsertSnapshotRows(nextRows) {
  const existingRows = readSnapshotRows();
  const rowMap = new Map(existingRows.map((entry) => [buildRowId(entry), entry]));

  nextRows.forEach((row) => {
    const key = buildRowId(row);
    const previous = rowMap.get(key);
    rowMap.set(key, {
      ...previous,
      ...row,
      id: key,
      created_at: previous?.created_at || row.created_at || row.captured_at,
      updated_at: row.updated_at || row.captured_at || new Date().toISOString(),
    });
  });

  return persistSnapshotRows(Array.from(rowMap.values()));
}

function extractAsOfCandidate(value) {
  const text = normalizeText(value);
  return /^as of\s+/i.test(text) ? text : "";
}

function findSalesforceAsOfText(source, depth = 0, visited = new Set()) {
  if (!source || depth > 6 || visited.has(source)) {
    return "";
  }

  if (typeof source === "string") {
    return extractAsOfCandidate(source);
  }

  if (typeof source !== "object") {
    return "";
  }

  visited.add(source);

  for (const value of Object.values(source)) {
    if (typeof value === "string") {
      const candidate = extractAsOfCandidate(value);
      if (candidate) {
        return candidate;
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = findSalesforceAsOfText(entry, depth + 1, visited);
        if (nested) {
          return nested;
        }
      }
      continue;
    }

    if (value && typeof value === "object") {
      const nested = findSalesforceAsOfText(value, depth + 1, visited);
      if (nested) {
        return nested;
      }
    }
  }

  return "";
}

function extractSalesforceAsOfText(describePayload, reportPayload) {
  return (
    findSalesforceAsOfText(reportPayload) ||
    findSalesforceAsOfText(describePayload) ||
    ""
  );
}

function getGroupingColumns(reportPayload) {
  const groupingInfo = reportPayload.reportExtendedMetadata?.groupingColumnInfo || {};
  return Object.values(groupingInfo)
    .filter((entry) => Number.isInteger(entry?.groupingLevel))
    .sort((left, right) => left.groupingLevel - right.groupingLevel)
    .map((entry) => ({
      key: entry.fullyQualifiedName || entry.entityColumnName || entry.label || "Grouping",
      label: normalizeText(entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping"),
      normalized: normalizeKey(entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping"),
      groupingLevel: entry.groupingLevel,
    }));
}

function getAggregateColumns(reportPayload) {
  const aggregateIds = reportPayload.reportMetadata?.aggregates || [];
  const aggregateInfo = reportPayload.reportExtendedMetadata?.aggregateColumnInfo || {};
  return aggregateIds.map((aggregateId) => {
    const info = aggregateInfo[aggregateId] || {};
    return {
      key: aggregateId,
      label: normalizeText(info.label || aggregateId),
      normalized: normalizeMetricAlias(info.label || aggregateId),
    };
  });
}

function buildGroupingLabelLookup(groups = [], path = [], lookup = new Map()) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) {
    lookup.set("T", []);
    return lookup;
  }

  list.forEach((group) => {
    const nextPath = [...path, group];
    lookup.set(
      String(group?.key || "T"),
      nextPath.map((entry) => normalizeText(entry?.label))
    );
    const children = Array.isArray(group.groupings) ? group.groupings : [];
    if (children.length) {
      buildGroupingLabelLookup(children, nextPath, lookup);
    }
  });

  return lookup;
}

function collectLeafGroupedRows(reportPayload, minimumPathLength = 0) {
  const rows = [];
  const factMap = reportPayload.factMap || {};
  const downLookup = buildGroupingLabelLookup(reportPayload.groupingsDown?.groupings || []);
  const acrossLookup = buildGroupingLabelLookup(reportPayload.groupingsAcross?.groupings || []);

  Object.entries(factMap).forEach(([factKey, factEntry]) => {
    const aggregates = Array.isArray(factEntry?.aggregates) ? factEntry.aggregates : [];
    if (!aggregates.length) {
      return;
    }

    const [downKeyRaw = "T", acrossKeyRaw = "T"] = String(factKey).split("!");
    const downKey = String(downKeyRaw || "T");
    const acrossKey = String(acrossKeyRaw || "T");
    const downPath = downLookup.get(downKey) || (downKey === "T" ? [] : null);
    const acrossPath = acrossLookup.get(acrossKey) || (acrossKey === "T" ? [] : null);

    if (downPath === null || acrossPath === null) {
      return;
    }

    const pathLabels = [...downPath, ...acrossPath];
    if (pathLabels.length < minimumPathLength) {
      return;
    }

    rows.push({
      factKey,
      pathLabels,
      rawAggregates: aggregates.map((entry) => entry?.label ?? ""),
    });
  });

  return rows;
}

function listGroupingPaths(groups = [], path = [], results = []) {
  const list = Array.isArray(groups) ? groups : [];
  list.forEach((group) => {
    const nextPath = [...path, normalizeText(group?.label)];
    results.push({
      key: String(group?.key || ""),
      path: nextPath,
    });
    const children = Array.isArray(group?.groupings) ? group.groupings : [];
    if (children.length) {
      listGroupingPaths(children, nextPath, results);
    }
  });
  return results;
}

function buildMetricLookup(reportConfig, aggregateColumns) {
  return reportConfig.expectedMetrics.map((metric) => {
    const aliases = new Set([metric.label, metric.key, ...(metric.aliases || [])].map((entry) => normalizeMetricAlias(entry)));
    const column = aggregateColumns.find((aggregate) => aliases.has(normalizeMetricAlias(aggregate.label)));
    if (!column) {
      throw new Error(
        `${reportConfig.reportLabel} parser could not find expected metric "${metric.label}".`
      );
    }
    return {
      metric,
      columnIndex: aggregateColumns.findIndex((aggregate) => aggregate.key === column.key),
      aggregateLabel: column.label,
    };
  });
}

function validateGroupingColumns(reportConfig, groupingColumns) {
  const expected = reportConfig.expectedGroupings.map((entry) => normalizeKey(entry));
  const actual = groupingColumns.map((entry) => normalizeKey(entry.label));

  if (expected.length !== actual.length) {
    throw new Error(
      `${reportConfig.reportLabel} parser expected ${expected.length} grouping level(s) but found ${actual.length}.`
    );
  }

  expected.forEach((entry, index) => {
    if (actual[index] !== entry) {
      throw new Error(
        `${reportConfig.reportLabel} parser expected grouping "${reportConfig.expectedGroupings[index]}" but found "${groupingColumns[index]?.label || "Unknown"}".`
      );
    }
  });
}

function parseReportMetricRows(reportConfig, describePayload, reportPayload, snapshotDate, capturedAt) {
  const groupingColumns = getGroupingColumns(reportPayload);
  validateGroupingColumns(reportConfig, groupingColumns);

  const aggregateColumns = getAggregateColumns(reportPayload);
  const metricLookup = buildMetricLookup(reportConfig, aggregateColumns);
  const groupedRows = collectLeafGroupedRows(reportPayload, groupingColumns.length);
  if (!groupedRows.length) {
    throw new Error(`${reportConfig.reportLabel} did not return any grouped rows to capture.`);
  }

  const salesforceAsOfText = extractSalesforceAsOfText(describePayload, reportPayload);
  const rows = [];

  groupedRows.forEach((groupedRow) => {
    const pathLabels = groupedRow.pathLabels;
    const paymentType = groupingColumns.length > 1 ? normalizePaymentTypeLabel(pathLabels[0]) : null;
    const scorePeriodSource = groupingColumns.length > 1 ? pathLabels[1] : pathLabels[0];
    const scorePeriod = normalizeScorePeriodLabel(scorePeriodSource);

    metricLookup.forEach(({ metric, columnIndex, aggregateLabel }) => {
      const rawValue = groupedRow.rawAggregates[columnIndex] ?? "";
      rows.push({
        id: buildRowId({
          snapshot_date: snapshotDate,
          dashboard_key: scoreDashboardSnapshotConfig.dashboardKey,
          report_key: reportConfig.reportKey,
          score_period: scorePeriod,
          payment_type: paymentType,
          metric_key: metric.key,
        }),
        snapshot_date: snapshotDate,
        captured_at: capturedAt,
        salesforce_as_of_text: salesforceAsOfText,
        dashboard_key: scoreDashboardSnapshotConfig.dashboardKey,
        dashboard_name: scoreDashboardSnapshotConfig.dashboardName,
        report_key: reportConfig.reportKey,
        report_label: reportConfig.reportLabel,
        score_period: scorePeriod,
        payment_type: paymentType,
        metric_key: metric.key,
        metric_label: metric.label,
        metric_value: parseMetricValue(rawValue),
        raw_value: rawValue === "" ? null : rawValue,
        raw_json: {
          reportId: reportConfig.salesforceReportId,
          groupingColumns: groupingColumns.map((entry) => entry.label),
          groupPath: clone(pathLabels),
          aggregateLabel,
          rawAggregates: clone(groupedRow.rawAggregates),
        },
        capture_status: "success",
        error_message: "",
        created_at: capturedAt,
        updated_at: capturedAt,
      });
    });
  });

  return {
    rows,
    salesforceAsOfText,
    groupedRows: groupedRows.length,
  };
}

function createFailureRow(reportConfig, snapshotDate, capturedAt, errorMessage, rawJson = null) {
  return {
    id: buildRowId({
      snapshot_date: snapshotDate,
      dashboard_key: scoreDashboardSnapshotConfig.dashboardKey,
      report_key: reportConfig.reportKey,
      score_period: "",
      payment_type: "",
      metric_key: FAILURE_METRIC_KEY,
    }),
    snapshot_date: snapshotDate,
    captured_at: capturedAt,
    salesforce_as_of_text: "",
    dashboard_key: scoreDashboardSnapshotConfig.dashboardKey,
    dashboard_name: scoreDashboardSnapshotConfig.dashboardName,
    report_key: reportConfig.reportKey,
    report_label: reportConfig.reportLabel,
    score_period: "",
    payment_type: "",
    metric_key: FAILURE_METRIC_KEY,
    metric_label: "Capture Error",
    metric_value: null,
    raw_value: null,
    raw_json: rawJson,
    capture_status: "failed",
    error_message: normalizeText(errorMessage),
    created_at: capturedAt,
    updated_at: capturedAt,
  };
}

async function captureScoreDashboardSnapshot(options = {}) {
  const snapshotDate = getSnapshotDateKey(options.snapshotDate);
  const capturedAt = new Date().toISOString();
  const tokenRecord = await getConnectedSalesforceToken();
  const dashboardContext = await loadScoreDashboardSourceContext(tokenRecord);
  const captureRows = [];
  const results = [];

  for (const reportConfig of scoreDashboardSnapshotConfig.reports) {
    if (!normalizeText(reportConfig.salesforceReportId)) {
      const errorMessage = `Report ID missing for ${reportConfig.reportLabel}. Add the Salesforce report ID in the SCORE dashboard config.`;
      captureRows.push(createFailureRow(reportConfig, snapshotDate, capturedAt, errorMessage));
      results.push({
        reportKey: reportConfig.reportKey,
        reportLabel: reportConfig.reportLabel,
        status: "failed",
        metricsSaved: 0,
        error: errorMessage,
      });
      continue;
    }

    try {
      const executed = await resolveScoreSnapshotReportExecution(tokenRecord, reportConfig, dashboardContext);
      const parsed = parseReportMetricRows(
        reportConfig,
        executed.describePayload,
        executed.reportPayload,
        snapshotDate,
        capturedAt
      );
      captureRows.push(...parsed.rows);
      results.push({
        reportKey: reportConfig.reportKey,
        reportLabel: reportConfig.reportLabel,
        status: "success",
        metricsSaved: parsed.rows.length,
        groupedRows: parsed.groupedRows,
        salesforceAsOfText: parsed.salesforceAsOfText,
        source: executed.source,
        dashboardComponentId: executed.dashboardComponentId,
        dashboardComponentLabel: executed.dashboardComponentLabel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      captureRows.push(
        createFailureRow(reportConfig, snapshotDate, capturedAt, message, {
          reportId: reportConfig.salesforceReportId,
          expectedGroupings: clone(reportConfig.expectedGroupings),
          expectedMetrics: reportConfig.expectedMetrics.map((entry) => entry.label),
        })
      );
      results.push({
        reportKey: reportConfig.reportKey,
        reportLabel: reportConfig.reportLabel,
        status: "failed",
        metricsSaved: 0,
        error: message,
      });
    }
  }

  upsertSnapshotRows(captureRows);

  const successfulReports = results.filter((entry) => entry.status === "success").length;
  const failedReports = results.length - successfulReports;
  const totalMetricsSaved = captureRows.filter(
    (entry) => entry.capture_status === "success" && entry.metric_key !== FAILURE_METRIC_KEY
  ).length;

  return {
    snapshotDate,
    capturedAt,
    totalReports: results.length,
    successfulReports,
    failedReports,
    totalMetricsSaved,
    results,
    errors: results
      .filter((entry) => entry.status !== "success")
      .map((entry) => ({
        reportKey: entry.reportKey,
        reportLabel: entry.reportLabel,
        error: entry.error,
      })),
  };
}

async function debugScoreDashboardSnapshotReports() {
  const tokenRecord = await getConnectedSalesforceToken();
  const dashboardContext = await loadScoreDashboardSourceContext(tokenRecord);
  const reports = [];

  for (const reportConfig of scoreDashboardSnapshotConfig.reports) {
    try {
      const executed = await resolveScoreSnapshotReportExecution(tokenRecord, reportConfig, dashboardContext);
      const groupingColumns = getGroupingColumns(executed.reportPayload);
      const aggregateColumns = getAggregateColumns(executed.reportPayload);
      const groupedRows = collectLeafGroupedRows(executed.reportPayload, 0);
      const parsedRows = parseReportMetricRows(
        reportConfig,
        executed.describePayload,
        executed.reportPayload,
        "debug",
        new Date().toISOString()
      ).rows;

      reports.push({
        reportKey: reportConfig.reportKey,
        reportLabel: reportConfig.reportLabel,
        salesforceReportId: reportConfig.salesforceReportId,
        source: executed.source,
        dashboardComponentId: executed.dashboardComponentId,
        dashboardComponentLabel: executed.dashboardComponentLabel,
        groupingColumns: groupingColumns.map((entry) => entry.label),
        aggregateColumns: aggregateColumns.map((entry) => entry.label),
        downGroupingPaths: listGroupingPaths(executed.reportPayload.groupingsDown?.groupings || []),
        acrossGroupingPaths: listGroupingPaths(executed.reportPayload.groupingsAcross?.groupings || []),
        factMapKeys: Object.keys(executed.reportPayload.factMap || {}),
        groupedRowPreview: groupedRows.slice(0, 20),
        parsedRowCount: parsedRows.length,
        parsedRowPreview: parsedRows.slice(0, 20).map((row) => ({
          score_period: row.score_period,
          payment_type: row.payment_type,
          metric_key: row.metric_key,
          metric_value: row.metric_value,
          raw_json: row.raw_json,
        })),
      });
    } catch (error) {
      reports.push({
        reportKey: reportConfig.reportKey,
        reportLabel: reportConfig.reportLabel,
        salesforceReportId: reportConfig.salesforceReportId,
        error: error instanceof Error ? error.message : String(error || ""),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dashboardId: dashboardContext?.dashboardId || "",
    dashboardError: dashboardContext?.error || "",
    dashboardErrorStatusCode: dashboardContext?.errorStatusCode || 0,
    dashboardErrorPath: dashboardContext?.errorPath || "",
    dashboardErrorPayload: dashboardContext?.errorPayload || null,
    dashboardComponentCount: ensureArray(dashboardContext?.dashboardComponents).length,
    dashboardComponents: ensureArray(dashboardContext?.dashboardComponents).map((entry) => ({
      componentId: entry.componentId,
      label: entry.label,
      reportId: entry.reportId,
      metadataTitle: normalizeText(entry.metadata?.title),
      metadataName: normalizeText(entry.metadata?.name),
      metadataLabel: normalizeText(entry.metadata?.label),
      reportFactMapKeys: Object.keys(entry.reportPayload?.factMap || {}),
      reportGroupingColumns: getGroupingColumns(entry.reportPayload || {}).map((column) => column.label),
    })),
    reports,
  };
}

function isSalesforceAuthFailureMessage(message) {
  const normalized = normalizeText(message).toLowerCase();
  return (
    normalized.includes("expired access/refresh token")
    || normalized.includes("reconnect salesforce")
    || normalized.includes("salesforce token refresh failed")
    || normalized.includes("salesforce oauth")
    || normalized.includes("authentication failed")
  );
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function rowMatchesFilters(row, filters = {}) {
  const snapshotDate = normalizeText(row.snapshot_date);
  const from = normalizeText(filters.from);
  const to = normalizeText(filters.to);
  if (from && snapshotDate < from) {
    return false;
  }
  if (to && snapshotDate > to) {
    return false;
  }

  const matchFields = [
    ["reportKey", "report_key"],
    ["scorePeriod", "score_period"],
    ["paymentType", "payment_type"],
    ["metricKey", "metric_key"],
    ["captureStatus", "capture_status"],
  ];

  for (const [filterKey, rowKey] of matchFields) {
    const filterValue = normalizeText(filters[filterKey]);
    if (filterValue && normalizeText(row[rowKey]) !== filterValue) {
      return false;
    }
  }

  return true;
}

function buildFilterOptions(rows) {
  const scorePeriods = new Set();
  const paymentTypes = new Set();
  const metricOptions = new Map();

  rows.forEach((row) => {
    if (row.capture_status !== "success" || row.metric_key === FAILURE_METRIC_KEY) {
      return;
    }
    if (row.score_period) {
      scorePeriods.add(row.score_period);
    }
    if (row.payment_type) {
      paymentTypes.add(row.payment_type);
    }
    if (row.metric_key) {
      metricOptions.set(row.metric_key, row.metric_label || row.metric_key);
    }
  });

  return {
    reports: scoreDashboardSnapshotConfig.reports.map((report) => ({
      key: report.reportKey,
      label: report.reportLabel,
    })),
    scorePeriods: Array.from(scorePeriods).sort((left, right) => {
      const diff = getScorePeriodSortValue(left) - getScorePeriodSortValue(right);
      return diff !== 0 ? diff : String(left).localeCompare(String(right));
    }),
    paymentTypes: Array.from(paymentTypes).sort((left, right) => {
      const diff = getPaymentTypeSortValue(left) - getPaymentTypeSortValue(right);
      return diff !== 0 ? diff : String(left).localeCompare(String(right));
    }),
    metrics: Array.from(metricOptions.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

function listScoreDashboardSnapshots(filters = {}) {
  const range = {
    ...defaultDateRange(),
    ...filters,
  };
  const rows = readSnapshotRows().filter((row) => rowMatchesFilters(row, range));
  return {
    rows,
    filters: {
      from: range.from,
      to: range.to,
      reportKey: normalizeText(range.reportKey),
      scorePeriod: normalizeText(range.scorePeriod),
      paymentType: normalizeText(range.paymentType),
      metricKey: normalizeText(range.metricKey),
      captureStatus: normalizeText(range.captureStatus),
    },
    config: getConfigPayload(),
    options: buildFilterOptions(readSnapshotRows()),
  };
}

function buildLatestReportMatrix(rows) {
  const reportMap = new Map(scoreDashboardSnapshotConfig.reports.map((report) => [report.reportKey, report]));
  const grouped = {};

  rows.forEach((row) => {
    if (row.capture_status !== "success" || row.metric_key === FAILURE_METRIC_KEY) {
      return;
    }
    const reportKey = row.report_key;
    if (!grouped[reportKey]) {
      grouped[reportKey] = {
        reportKey,
        reportLabel: reportMap.get(reportKey)?.reportLabel || row.report_label,
        rows: [],
      };
    }
    grouped[reportKey].rows.push(row);
  });

  Object.values(grouped).forEach((reportEntry) => {
    reportEntry.rows.sort((left, right) => {
      const paymentSort = getPaymentTypeSortValue(left.payment_type) - getPaymentTypeSortValue(right.payment_type);
      if (paymentSort !== 0) {
        return paymentSort;
      }
      const paymentCompare = String(left.payment_type || "").localeCompare(String(right.payment_type || ""));
      if (paymentCompare !== 0) {
        return paymentCompare;
      }
      const periodSort = getScorePeriodSortValue(left.score_period) - getScorePeriodSortValue(right.score_period);
      if (periodSort !== 0) {
        return periodSort;
      }
      const periodCompare = String(left.score_period || "").localeCompare(String(right.score_period || ""));
      if (periodCompare !== 0) {
        return periodCompare;
      }
      return String(left.metric_label || "").localeCompare(String(right.metric_label || ""));
    });
  });

  return grouped;
}

function getLatestSuccessfulScoreDashboardSnapshot() {
  const successfulRows = readSnapshotRows().filter(
    (row) => row.capture_status === "success" && row.metric_key !== FAILURE_METRIC_KEY
  );
  if (!successfulRows.length) {
    return {
      snapshotDate: "",
      capturedAt: "",
      salesforceAsOfText: "",
      reports: {},
      config: getConfigPayload(),
    };
  }

  const latestSnapshotDate = successfulRows
    .map((row) => row.snapshot_date)
    .sort((left, right) => String(right).localeCompare(String(left)))[0];
  const latestRows = successfulRows.filter((row) => row.snapshot_date === latestSnapshotDate);
  const capturedAt = latestRows
    .map((row) => row.captured_at || "")
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || "";
  const salesforceAsOfText = latestRows.find((row) => normalizeText(row.salesforce_as_of_text))?.salesforce_as_of_text || "";

  return {
    snapshotDate: latestSnapshotDate,
    capturedAt,
    salesforceAsOfText,
    reports: buildLatestReportMatrix(latestRows),
    config: getConfigPayload(),
  };
}

function buildTrendRows(filters = {}) {
  const reportConfig = getReportConfig(filters.reportKey);
  const baseRows = readSnapshotRows().filter((row) => {
    if (row.capture_status !== "success" || row.metric_key === FAILURE_METRIC_KEY) {
      return false;
    }
    if (!rowMatchesFilters(row, filters)) {
      return false;
    }
    return true;
  });

  const rows = baseRows
    .map((row) => ({
      snapshotDate: row.snapshot_date,
      reportKey: row.report_key,
      reportLabel: row.report_label,
      paymentType: row.payment_type || "",
      scorePeriod: row.score_period || "",
      metricKey: row.metric_key,
      metricLabel: row.metric_label,
      metricValue: row.metric_value,
      metricFormat:
        reportConfig?.expectedMetrics.find((metric) => metric.key === row.metric_key)?.format || "number",
      salesforceAsOfText: row.salesforce_as_of_text || "",
      capturedAt: row.captured_at || "",
    }))
    .sort((left, right) => String(left.snapshotDate).localeCompare(String(right.snapshotDate)));

  return rows;
}

function toCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportScoreDashboardSnapshotsCsv(filters = {}) {
  const rows = listScoreDashboardSnapshots(filters).rows.filter(
    (row) => row.metric_key !== FAILURE_METRIC_KEY
  );
  const headers = [
    "snapshot_date",
    "dashboard_name",
    "report_label",
    "payment_type",
    "score_period",
    "metric_label",
    "metric_value",
    "salesforce_as_of_text",
    "captured_at",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.snapshot_date,
        row.dashboard_name,
        row.report_label,
        row.payment_type || "",
        row.score_period || "",
        row.metric_label,
        row.metric_value === null || row.metric_value === undefined ? "" : row.metric_value,
        row.salesforce_as_of_text || "",
        row.captured_at || "",
      ].map(toCsvCell).join(",")
    ),
  ];

  return {
    fileName: `score-dashboard-history-${getSnapshotDateKey()}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\n"),
  };
}

async function initializeScoreDashboardSnapshotPersistence() {
  ensureStorage();
  const localRows = normalizeStoredRows(safeParseJson(SNAPSHOTS_PATH, []));
  const remoteRows = await loadStateObject(SNAPSHOTS_SUPABASE_KEY, localRows);
  snapshotsCache = normalizeStoredRows(Array.isArray(remoteRows) ? remoteRows : localRows);
  if (snapshotsDiskWritable) {
    writeJsonSafe(SNAPSHOTS_PATH, snapshotsCache);
  }
}

function scheduleNextScoreDashboardSnapshot(logger = console) {
  if (scoreSnapshotScheduleTimeout) {
    clearTimeout(scoreSnapshotScheduleTimeout);
    scoreSnapshotScheduleTimeout = null;
  }

  const config = getScoreSnapshotScheduleConfig();
  if (!config.enabled) {
    logger.log("SCORE snapshot scheduler disabled.");
    return;
  }

  const now = new Date();
  const nextRun = getNextScheduledCaptureTime(now, config);
  const delayMs = Math.max(1000, nextRun.getTime() - now.getTime());
  logger.log(
    `SCORE snapshot scheduler armed for ${nextRun.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })}.`
  );

  scoreSnapshotScheduleTimeout = setTimeout(async () => {
    scoreSnapshotScheduleTimeout = null;
    try {
      const result = await captureScoreDashboardSnapshot({
        snapshotDate: getLocalDateKey(new Date()),
      });
      logger.log(
        `Scheduled SCORE snapshot complete: ${result.totalMetricsSaved} metric(s), ${result.failedReports} failed report(s).`
      );
      if (result.failedReports) {
        result.errors.forEach((entry) => {
          logger.warn(`Scheduled SCORE snapshot report failure [${entry.reportLabel}]: ${entry.error}`);
        });
      }
    } catch (error) {
      logger.warn(`Scheduled SCORE snapshot failed: ${error.message}`);
    } finally {
      scheduleNextScoreDashboardSnapshot(logger);
    }
  }, delayMs);
}

async function maybeRunStartupScoreDashboardSnapshot(logger = console) {
  const config = getScoreSnapshotScheduleConfig();
  if (!config.enabled) {
    return;
  }

  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const scheduledTime = new Date(now);
  scheduledTime.setHours(config.hour, config.minute, 0, 0);

  if (now.getTime() < scheduledTime.getTime()) {
    return;
  }

  if (hasSuccessfulSnapshotForDate(todayKey)) {
    return;
  }

  logger.log("No successful SCORE snapshot found for today after the scheduled time. Running startup catch-up capture.");
  try {
    const result = await captureScoreDashboardSnapshot({
      snapshotDate: todayKey,
    });
    logger.log(
      `Startup SCORE snapshot catch-up complete: ${result.totalMetricsSaved} metric(s), ${result.failedReports} failed report(s).`
    );
    if (result.failedReports) {
      result.errors.forEach((entry) => {
        logger.warn(`Startup SCORE snapshot report failure [${entry.reportLabel}]: ${entry.error}`);
      });
    }
  } catch (error) {
    logger.warn(`Startup SCORE snapshot catch-up failed: ${error.message}`);
  }
}

module.exports = {
  SCORE_PERIOD_ORDER,
  PAYMENT_TYPE_ORDER,
  captureScoreDashboardSnapshot,
  exportScoreDashboardSnapshotsCsv,
  getScoreSnapshotScheduleConfig,
  getLatestSuccessfulScoreDashboardSnapshot,
  getLocalDateKey,
  getNextScheduledCaptureTime,
  getScoreDashboardSnapshotConfig: getConfigPayload,
  hasSuccessfulSnapshotForDate,
  initializeScoreDashboardSnapshotPersistence,
  isSalesforceAuthFailureMessage,
  listScoreDashboardSnapshots,
  maybeRunStartupScoreDashboardSnapshot,
  debugScoreDashboardSnapshotReports,
  buildTrendRows,
  normalizeScorePeriodLabel,
  normalizePaymentTypeLabel,
  parseReportMetricRows,
  parseMetricValue,
  scoreDashboardSnapshotConfig,
  scheduleNextScoreDashboardSnapshot,
};
