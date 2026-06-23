const { getSalesforceConfig } = require("./config");
const {
  getAuthStatus,
  getStoredToken,
  storeTokenRecord,
} = require("./salesforceAuthService");
const {
  DEFAULT_MONTHLY_REPORT_TYPE,
  getMonthlyReportType,
} = require("./reportCatalog");

const SALESFORCE_API_VERSION = "v61.0";

function getMonthDateRange(reportMonth) {
  const [yearString, monthString] = String(reportMonth || "").split("-");
  const year = Number(yearString);
  const month = Number(monthString);

  if (!year || !month) {
    throw new Error(`Invalid report month: ${reportMonth}`);
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function looksLikeDateLabel(label) {
  return (
    label.includes("date received") ||
    label.includes("date refunded") ||
    label.includes("refund date") ||
    label.includes("date returned") ||
    label === "date" ||
    label.startsWith("date ")
  );
}

function looksLikePremiumLabel(label) {
  return label === "premium" || label.includes("gross premium");
}

function looksLikeDuesLabel(label) {
  return label.includes("dues");
}

function looksLikeAmountLabel(label) {
  return (
    label.includes("amount received") ||
    label.includes("settlement amount") ||
    label === "amount" ||
    label.includes("total submitted") ||
    label.includes("submitted")
  );
}

function looksLikeMonthsLabel(label) {
  return (
    label.includes("months paid") ||
    label.includes("rollback months") ||
    label.includes("number of months")
  );
}

function looksLikeCertificateLabel(label) {
  return (
    label.includes("number of certificates") ||
    label.includes("certificate count") ||
    label.includes("total certificates")
  );
}

function parseNumber(value) {
  if (value && typeof value === "object") {
    if (typeof value.amount === "number" && Number.isFinite(value.amount)) {
      return value.amount;
    }

    if (typeof value.value === "number" && Number.isFinite(value.value)) {
      return value.value;
    }
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const stringValue = String(value || "").trim();
  if (!stringValue) {
    return 0;
  }

  const isNegativeByParens =
    stringValue.startsWith("(") && stringValue.endsWith(")");
  const cleaned = stringValue.replace(/[$,%()\s,]/g, "");
  const parsed = Number(cleaned);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return isNegativeByParens ? -parsed : parsed;
}

function parseDateValue(rawValue, fallbackLabel) {
  if (typeof rawValue === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(rawValue)) {
      return rawValue.slice(0, 10);
    }

    const parsed = new Date(rawValue);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const parsedFallback = new Date(fallbackLabel);
  if (!Number.isNaN(parsedFallback.getTime())) {
    return parsedFallback.toISOString().slice(0, 10);
  }

  throw new Error(`Unable to parse Salesforce report date value: ${fallbackLabel}`);
}

async function refreshAccessTokenIfNeeded(tokenRecord) {
  if (tokenRecord?.accessToken) {
    return tokenRecord;
  }

  throw new Error("Salesforce is not connected. Connect Salesforce before running the report.");
}

async function refreshAccessToken(tokenRecord) {
  if (!tokenRecord?.refreshToken) {
    throw new Error(
      "Salesforce access token expired and no refresh token is available. Reconnect Salesforce."
    );
  }

  const config = getSalesforceConfig();
  const tokenUrl = new URL("/services/oauth2/token", config.loginUrl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: tokenRecord.refreshToken,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Salesforce token refresh failed.");
  }

  const updatedToken = {
    ...tokenRecord,
    accessToken: payload.access_token,
    instanceUrl: payload.instance_url || tokenRecord.instanceUrl,
    issuedAt: payload.issued_at || tokenRecord.issuedAt,
    signature: payload.signature || tokenRecord.signature,
    tokenType: payload.token_type || tokenRecord.tokenType,
    refreshToken: payload.refresh_token || tokenRecord.refreshToken,
  };

  storeTokenRecord(updatedToken);
  return updatedToken;
}

async function salesforceRequest(tokenRecord, pathName, options = {}) {
  const requestUrl = new URL(pathName, `${tokenRecord.instanceUrl}/`);
  const headers = {
    Authorization: `Bearer ${tokenRecord.accessToken}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(requestUrl, {
    ...options,
    headers,
  });

  if (response.status !== 401) {
    return response;
  }

  const refreshedToken = await refreshAccessToken(tokenRecord);
  const retryHeaders = {
    ...headers,
    Authorization: `Bearer ${refreshedToken.accessToken}`,
  };

  return fetch(requestUrl, {
    ...options,
    headers: retryHeaders,
  });
}

async function fetchReportDescribe(tokenRecord, reportId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}/describe`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to describe Salesforce report ${reportId}.`
    );
  }

  return payload;
}

function buildReportMetadataAttempts(reportMetadata, dateRange) {
  const baseMetadata = {
    ...reportMetadata,
  };

  if (!baseMetadata.standardDateFilter) {
    return [baseMetadata];
  }

  const baseFilter = {
    ...baseMetadata.standardDateFilter,
  };

  const attemptWithCustomDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      durationValue: "CUSTOM",
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  };

  const attemptWithoutDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  };
  delete attemptWithoutDuration.standardDateFilter.durationValue;

  const attemptWithCurrentDuration = {
    ...baseMetadata,
    standardDateFilter: {
      ...baseFilter,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      durationValue: baseFilter.durationValue || "CURRENT_FISCAL_QUARTER",
    },
  };

  return [
    attemptWithCustomDuration,
    attemptWithoutDuration,
    attemptWithCurrentDuration,
  ];
}

async function executeReport(tokenRecord, reportId, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const reportMetadata = describePayload.reportMetadata || {};
  const dateRange = getMonthDateRange(reportMonth);
  const attempts = buildReportMetadataAttempts(reportMetadata, dateRange);
  const errors = [];

  for (const requestMetadata of attempts) {
    const response = await salesforceRequest(
      tokenRecord,
      `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
      {
        method: "POST",
        body: JSON.stringify({
          reportMetadata: requestMetadata,
        }),
      }
    );

    const payload = await response.json();
    if (response.ok) {
      return payload;
    }

    errors.push(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  throw new Error(errors[errors.length - 1] || `Unable to run Salesforce report ${reportId}.`);
}

async function executeReportForDateRange(tokenRecord, reportId, dateRange) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const reportMetadata = describePayload.reportMetadata || {};
  const attempts = buildReportMetadataAttempts(reportMetadata, dateRange);
  const errors = [];

  for (const requestMetadata of attempts) {
    const response = await salesforceRequest(
      tokenRecord,
      `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
      {
        method: "POST",
        body: JSON.stringify({
          reportMetadata: requestMetadata,
        }),
      }
    );

    const payload = await response.json();
    if (response.ok) {
      return {
        describePayload,
        reportPayload: payload,
      };
    }

    errors.push(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  throw new Error(errors[errors.length - 1] || `Unable to run Salesforce report ${reportId}.`);
}

async function executeReportWithoutDateOverride(tokenRecord, reportId) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  return executeReportWithDescribeMetadata(tokenRecord, reportId, describePayload.reportMetadata || {}, describePayload);
}

async function executeSavedReport(tokenRecord, reportId) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportId);
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  return {
    describePayload,
    reportPayload: payload,
  };
}

async function fetchDashboard(tokenRecord, dashboardId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}`
  );
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to load Salesforce dashboard ${dashboardId}.`
    );
    error.statusCode = response.status;
    error.salesforcePayload = payload;
    error.salesforcePath = `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}`;
    throw error;
  }

  return payload;
}

async function fetchDashboardResults(tokenRecord, dashboardId) {
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}/results`
  );
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to load Salesforce dashboard results ${dashboardId}.`
    );
    error.statusCode = response.status;
    error.salesforcePayload = payload;
    error.salesforcePath = `/services/data/${SALESFORCE_API_VERSION}/analytics/dashboards/${dashboardId}/results`;
    throw error;
  }

  return payload;
}

async function executeReportWithDescribeMetadata(tokenRecord, reportId, reportMetadata, describePayload = null) {
  const resolvedDescribePayload = describePayload || await fetchReportDescribe(tokenRecord, reportId);
  const response = await salesforceRequest(
    tokenRecord,
    `/services/data/${SALESFORCE_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
    {
      method: "POST",
      body: JSON.stringify({
        reportMetadata: reportMetadata || {},
      }),
    }
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload[0]?.message ||
        payload.message ||
        `Unable to run Salesforce report ${reportId}.`
    );
  }

  return {
    describePayload: resolvedDescribePayload,
    reportPayload: payload,
  };
}

function getDetailRows(reportPayload) {
  const factMap = reportPayload.factMap || {};
  const primaryRows = factMap["T!T"]?.rows || factMap["0!T"]?.rows || [];
  if (primaryRows.length) {
    return primaryRows;
  }

  return Object.entries(factMap)
    .filter(([, value]) => Array.isArray(value?.rows) && value.rows.length > 0)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB, undefined, { numeric: true }))
    .flatMap(([, value]) => value.rows);
}

function getNestedValue(source, pathParts) {
  return pathParts.reduce((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    return current[segment];
  }, source);
}

function mapColumnLabels(reportPayload) {
  const detailColumns = reportPayload.reportMetadata?.detailColumns || [];
  const detailInfo = reportPayload.reportExtendedMetadata?.detailColumnInfo || {};

  return detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    return {
      key: columnKey,
      label: info.label || columnKey,
      normalized: normalizeLabel(info.label || columnKey),
      dataType: info.dataType || null,
    };
  });
}

function getRootObjectName(columnName) {
  const value = String(columnName || "").trim();
  if (!value) {
    return "";
  }

  return value.split(".")[0] || "";
}

function normalizeScf(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  return digits.slice(-3).padStart(3, "0");
}

function translateReportFieldToSoql(columnName, rootObject = null) {
  let translated = String(columnName || "").trim();

  if (rootObject && translated.startsWith(`${rootObject}.`)) {
    translated = translated.slice(rootObject.length + 1);
  } else {
    translated = translated.replace(/^[A-Za-z0-9_]+\./, "");
  }

  return translated
    .replace(/^FK_([A-Za-z0-9_]+)__c\./, "$1__r.")
    .replace(/__c\./g, "__r.");
}

function mapDescribeFields(describePayload) {
  const detailColumns = describePayload.reportMetadata?.detailColumns || [];
  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};

  return detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    const fullyQualifiedName = info.fullyQualifiedName || columnKey;
    const rootObject = getRootObjectName(fullyQualifiedName);
    return {
      key: columnKey,
      label: info.label || columnKey,
      normalized: normalizeLabel(info.label || columnKey),
      dataType: info.dataType || null,
      filterValues: Array.isArray(info.filterValues) ? info.filterValues : [],
      fullyQualifiedName,
      rootObject,
      soqlField: translateReportFieldToSoql(fullyQualifiedName, rootObject),
    };
  });
}

function inferSoqlFieldDataType(fieldName) {
  const normalized = String(fieldName || "").trim().toLowerCase();

  if (
    normalized.endsWith("createddate") ||
    normalized.endsWith("lastmodifieddate") ||
    normalized.endsWith("systemmodstamp")
  ) {
    return "datetime";
  }

  return null;
}

function formatSoqlBoundaryValue(dateValue, dataType, boundary) {
  if (String(dataType || "").toLowerCase() === "datetime") {
    return boundary === "end"
      ? `${dateValue}T23:59:59Z`
      : `${dateValue}T00:00:00Z`;
  }

  return dateValue;
}

function buildRowObjectFromSoqlRecord(record, fields) {
  const rowObject = {};

  fields.forEach((field) => {
    const rawValue = getNestedValue(record, String(field.soqlField || "").split("."));
    rowObject[field.label] = rawValue ?? "";
    rowObject[field.normalized] = rawValue ?? "";

    if (
      String(field.dataType || "").toLowerCase() === "picklist" &&
      rawValue !== undefined &&
      rawValue !== null &&
      String(rawValue).trim() !== ""
    ) {
      const match = (field.filterValues || []).find((entry) => {
        return String(entry.apiName || "").trim() === String(rawValue).trim();
      });
      const displayValue = match?.label || match?.name || rawValue;
      rowObject[`${field.label}__label`] = displayValue;
      rowObject[`${field.normalized} label`] = displayValue;
    }
  });

  return rowObject;
}

function isNumericColumn(column) {
  return ["currency", "double", "int", "percent"].includes(column?.dataType);
}

function normalizeDetailRow(row, columnMap) {
  const normalized = {
    date: null,
    grossPremium: 0,
    ahaDues: 0,
    totalSubmitted: 0,
    numberOfMonths: 1,
    numberOfCertificates: 1,
  };
  const matched = {
    date: false,
    grossPremium: false,
    ahaDues: false,
    totalSubmitted: false,
    numberOfMonths: false,
    numberOfCertificates: false,
  };
  const numericCells = [];

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    const label = column.normalized;
    const rawValue = cell.value ?? cell.label;
    const parsedNumeric = parseNumber(rawValue);

    if (isNumericColumn(column)) {
      numericCells.push({
        index,
        label,
        value: parsedNumeric,
      });
    }

    if (!normalized.date && looksLikeDateLabel(label)) {
      normalized.date = parseDateValue(rawValue, cell.label);
      matched.date = true;
      return;
    }

    if (looksLikePremiumLabel(label)) {
      normalized.grossPremium = parsedNumeric;
      matched.grossPremium = true;
      return;
    }

    if (looksLikeDuesLabel(label)) {
      normalized.ahaDues = parsedNumeric;
      matched.ahaDues = true;
      return;
    }

    if (looksLikeAmountLabel(label)) {
      normalized.totalSubmitted = parsedNumeric;
      matched.totalSubmitted = true;
      return;
    }

    if (looksLikeMonthsLabel(label)) {
      normalized.numberOfMonths = parsedNumeric;
      matched.numberOfMonths = true;
      return;
    }

    if (looksLikeCertificateLabel(label)) {
      normalized.numberOfCertificates = parsedNumeric;
      matched.numberOfCertificates = true;
    }
  });

  if (!normalized.date) {
    throw new Error("Salesforce report row is missing a recognizable date column.");
  }

  if (!matched.grossPremium && numericCells[0]) {
    normalized.grossPremium = numericCells[0].value;
  }

  if (!matched.ahaDues && numericCells[1]) {
    normalized.ahaDues = numericCells[1].value;
  }

  if (!matched.totalSubmitted && numericCells[2]) {
    normalized.totalSubmitted = numericCells[2].value;
  }

  if (!matched.numberOfMonths && numericCells[3]) {
    normalized.numberOfMonths = numericCells[3].value || normalized.numberOfMonths;
  }

  if (!matched.numberOfCertificates && numericCells[4]) {
    normalized.numberOfCertificates =
      numericCells[4].value || normalized.numberOfCertificates;
  }

  if (
    !matched.totalSubmitted &&
    normalized.totalSubmitted === 0 &&
    (normalized.grossPremium !== 0 || normalized.ahaDues !== 0)
  ) {
    normalized.totalSubmitted = normalized.grossPremium + normalized.ahaDues;
  }

  return normalized;
}

function normalizeSummaryReportPayload(tabConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) =>
    normalizeDetailRow(row, columnMap)
  );

  return {
    key: tabConfig.key,
    tabName: tabConfig.tabName,
    transactionType: tabConfig.transactionType,
    rows,
  };
}

function escapeSoqlLiteral(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function findReportColumnInfo(describePayload, columnName) {
  const target = String(columnName || "").trim();
  if (!target) {
    return null;
  }

  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};
  if (detailInfo[target]) {
    return detailInfo[target];
  }

  const categories = describePayload.reportTypeMetadata?.categories || [];
  for (const category of categories) {
    for (const [key, column] of Object.entries(category.columns || {})) {
      if (
        key === target ||
        column?.fullyQualifiedName === target ||
        column?.entityColumnName === target
      ) {
        return column;
      }
    }
  }

  return null;
}

function normalizeFilterValues(filter, describePayload) {
  const rawValues = String(filter?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawValues.length === 0) {
    return rawValues;
  }

  const columnInfo = findReportColumnInfo(describePayload, filter?.column);
  const filterValues = Array.isArray(columnInfo?.filterValues) ? columnInfo.filterValues : [];

  if (
    String(columnInfo?.dataType || "").toLowerCase() !== "picklist" ||
    filterValues.length === 0
  ) {
    return rawValues;
  }

  return rawValues.map((value) => {
    const match = filterValues.find((entry) => {
      return (
        String(entry.apiName || "").trim().toLowerCase() === value.toLowerCase() ||
        String(entry.label || "").trim().toLowerCase() === value.toLowerCase() ||
        String(entry.name || "").trim().toLowerCase() === value.toLowerCase()
      );
    });

    return match?.apiName || value;
  });
}

function buildAggregateQueryPlan(describePayload) {
  const reportMetadata = describePayload.reportMetadata || {};
  const detailColumns = reportMetadata.detailColumns || [];
  const detailInfo = describePayload.reportExtendedMetadata?.detailColumnInfo || {};

  if (detailColumns.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName = String(detailColumns[0]).split(".")[0];
  const fields = detailColumns.map((columnKey) => {
    const info = detailInfo[columnKey] || {};
    const label = info.label || columnKey;
    return {
      key: columnKey,
      label,
      normalized: normalizeLabel(label),
      soqlField: translateReportFieldToSoql(columnKey),
    };
  });

  const dateField = fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const premiumField = fields.find((field) => looksLikePremiumLabel(field.normalized))?.soqlField;
  const duesField = fields.find((field) => looksLikeDuesLabel(field.normalized))?.soqlField;
  const amountField = fields.find((field) => looksLikeAmountLabel(field.normalized))?.soqlField;
  const monthsField = fields.find((field) => looksLikeMonthsLabel(field.normalized))?.soqlField;

  if (!dateField || !premiumField || !duesField || !monthsField) {
    throw new Error(
      `Unable to map required Salesforce fields for report ${reportMetadata.name || reportMetadata.id}.`
    );
  }

  return {
    objectName,
    dateField,
    premiumField,
    duesField,
    amountField,
    monthsField,
    reportMetadata,
  };
}

function buildFilterClause(filter, describePayload, rootObject = null) {
  const operator = String(filter?.operator || "").trim();
  if (!operator) {
    return null;
  }

  const translatedField = translateReportFieldToSoql(filter.column, rootObject);
  const values = normalizeFilterValues(filter, describePayload);

  if (operator === "equals") {
    if (values.length > 1) {
      return `${translatedField} IN (${values
        .map((value) => `'${escapeSoqlLiteral(value)}'`)
        .join(", ")})`;
    }

    if (values.length === 1) {
      return `${translatedField} = '${escapeSoqlLiteral(values[0])}'`;
    }
  }

  if (operator === "notContain" && values.length > 0) {
    return null;
  }

  return null;
}

function findFieldByLikelyLabels(fields, labels = []) {
  const targets = labels.map((label) => normalizeLabel(label)).filter(Boolean);
  if (!targets.length) {
    return null;
  }

  return (
    fields.find((field) => targets.includes(normalizeLabel(field.label))) ||
    fields.find((field) =>
      targets.some((target) => normalizeLabel(field.label).includes(target))
    ) ||
    null
  );
}

function buildAnalysisDetailSoqlPlan(describePayload, filters = {}) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getGroupingColumns({ reportExtendedMetadata: describePayload.reportExtendedMetadata }).map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType || "string",
      fullyQualifiedName: column.key,
      rootObject: getRootObjectName(column.key),
      soqlField: translateReportFieldToSoql(column.key, getRootObjectName(column.key)),
    })),
  ];

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);

  const dateRange = resolveAnalysisDateRange(filters);
  const fallbackDateField = fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    fallbackDateField;
  const dateFieldInfo =
    fields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  const whereClauses = [];
  if (dateRange?.startDate && dateField) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(dateRange.startDate, dateFieldInfo.dataType, "start")}`
    );
  }
  if (dateRange?.endDate && dateField) {
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(dateRange.endDate, dateFieldInfo.dataType, "end")}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  const keyField = findFieldByLikelyLabels(fields, ["Key", "Key Code", "Report Key"]);
  const scfField = findFieldByLikelyLabels(fields, ["SCF Grouping", "SCF"]);
  const keyFilters = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (keyField?.soqlField && keyFilters.length > 0) {
    if (keyFilters.length === 1) {
      whereClauses.push(`${keyField.soqlField} = '${escapeSoqlLiteral(keyFilters[0])}'`);
    } else {
      whereClauses.push(
        `${keyField.soqlField} IN (${keyFilters
          .map((value) => `'${escapeSoqlLiteral(value)}'`)
          .join(", ")})`
      );
    }
  }

  const normalizedScf = String(filters.scf || "").trim();
  if (scfField?.soqlField && normalizedScf) {
    whereClauses.push(`${scfField.soqlField} = '${escapeSoqlLiteral(normalizedScf)}'`);
  }

  return {
    objectName,
    dateField,
    whereClauses,
    fields,
  };
}

function buildRawDetailSoqlPlan(describePayload) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = mapDescribeFields(describePayload);

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);

  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField ||
    "";
  const dateFieldInfo =
    fields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  const whereClauses = [];
  const startDate = String(reportMetadata.standardDateFilter?.startDate || "").trim();
  const endDate = String(reportMetadata.standardDateFilter?.endDate || "").trim();

  if (dateField && startDate) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(startDate, dateFieldInfo.dataType, "start")}`
    );
  }
  if (dateField && endDate) {
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(endDate, dateFieldInfo.dataType, "end")}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  return {
    objectName,
    dateField,
    whereClauses,
    fields,
  };
}

function buildAggregateSoql(describePayload, reportMonth) {
  const dateRange = getMonthDateRange(reportMonth);
  const plan = buildAggregateQueryPlan(describePayload);
  const standardDateField =
    translateReportFieldToSoql(plan.reportMetadata.standardDateFilter?.column) || plan.dateField;
  const whereClauses = [
    `${standardDateField} >= ${dateRange.startDate}`,
    `${standardDateField} <= ${dateRange.endDate}`,
  ];

  (plan.reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  const selectedAmountField = plan.amountField || plan.premiumField;
  const soql = `
SELECT ${plan.dateField}, SUM(${plan.premiumField}), SUM(${plan.duesField}), SUM(${selectedAmountField}), SUM(${plan.monthsField}), COUNT(Id)
FROM ${plan.objectName}
WHERE ${whereClauses.join("\nAND ")}
GROUP BY ${plan.dateField}
ORDER BY ${plan.dateField}
`.trim();

  return {
    soql,
    plan,
  };
}

async function runSoqlQuery(tokenRecord, soql) {
  let nextPath = `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const records = [];

  while (nextPath) {
    const response = await salesforceRequest(tokenRecord, nextPath, { method: "GET" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload[0]?.message || payload.message || "Salesforce SOQL query failed."
      );
    }

    records.push(...(payload.records || []));
    nextPath = payload.nextRecordsUrl || null;
  }

  return records;
}

async function fetchAggregateReportRows(tokenRecord, reportConfig, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const { soql, plan } = buildAggregateSoql(describePayload, reportMonth);
  const records = await runSoqlQuery(tokenRecord, soql);

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows: records.map((record) => ({
      date: record[plan.dateField],
      grossPremium: parseNumber(record.expr0),
      ahaDues: parseNumber(record.expr1),
      totalSubmitted: parseNumber(record.expr2),
      numberOfMonths: parseNumber(record.expr3),
      numberOfCertificates: parseNumber(record.expr4),
    })),
  };
}

function getCellValue(cell) {
  return cell?.value ?? cell?.label ?? "";
}

function buildRowObject(row, columnMap) {
  const result = {};

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    result[column.label] = getCellValue(cell);
    result[column.normalized] = getCellValue(cell);

    if (cell?.label !== undefined && cell?.label !== null && String(cell.label).trim() !== "") {
      result[`${column.label}__label`] = cell.label;
      result[`${column.normalized} label`] = cell.label;
    }
  });

  return result;
}

function buildDisplayRowObject(row, columnMap) {
  const result = {};

  (row.dataCells || []).forEach((cell, index) => {
    const column = columnMap[index];
    if (!column) {
      return;
    }

    const displayValue =
      cell?.label !== undefined && cell?.label !== null ? cell.label : getCellValue(cell);
    result[column.label] = displayValue ?? "";
    result[column.normalized] = displayValue ?? "";
  });

  return result;
}

function getGroupingColumns(reportPayload) {
  const groupingInfo = reportPayload.reportExtendedMetadata?.groupingColumnInfo || {};
  return Object.values(groupingInfo)
    .filter((entry) => Number.isInteger(entry.groupingLevel))
    .sort((a, b) => a.groupingLevel - b.groupingLevel)
    .map((entry) => ({
      key: entry.fullyQualifiedName || entry.entityColumnName || entry.label,
      label: entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping",
      normalized: normalizeLabel(entry.label || entry.fullyQualifiedName || entry.entityColumnName || "Grouping"),
      groupingLevel: entry.groupingLevel,
      dataType: entry.dataType || "string",
    }));
}

function getAggregateColumns(reportPayload) {
  const aggregateIds = reportPayload.reportMetadata?.aggregates || [];
  const aggregateInfo = reportPayload.reportExtendedMetadata?.aggregateColumnInfo || {};
  return aggregateIds.map((aggregateId) => {
    const info = aggregateInfo[aggregateId] || {};
    return {
      key: aggregateId,
      label: info.label || aggregateId,
      normalized: normalizeLabel(info.label || aggregateId),
      dataType: info.dataType || null,
    };
  });
}

function buildSummaryAggregateValues(reportPayload, aggregateColumns) {
  const totalEntry = reportPayload.factMap?.["T!T"] || reportPayload.factMap?.["0!T"] || null;
  const aggregates = Array.isArray(totalEntry?.aggregates) ? totalEntry.aggregates : [];
  if (!aggregates.length) {
    return [];
  }

  return aggregateColumns.map((column, index) => ({
    key: column.key,
    label: column.label,
    value: aggregates[index]?.label ?? "",
  }));
}

function buildAnalysisSummaryValuesFromRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const totals = safeRows.reduce((acc, row) => {
    acc.mailed += parseNumber(row["Sum of Mailed"] ?? row["sum of mailed"] ?? 0);
    acc.oppCount += parseNumber(row["Sum of Opp Count"] ?? row["sum of opp count"] ?? 0);
    acc.inForce += parseNumber(row["Sum of In Force"] ?? row["sum of in force"] ?? 0);
    acc.sold += parseNumber(row["Sum of Sold"] ?? row["sum of sold"] ?? 0);
    acc.totalMonthlyPremium += parseNumber(
      row["Sum of Total Monthly Premium"] ??
      row["sum of total monthly premium"] ??
      0
    );
    acc.inForceMonthlyPremium += parseNumber(
      row["Sum of In Force Monthly Premium"] ??
      row["sum of in force monthly premium"] ??
      0
    );
    acc.totalConvertedMonthlyPremiums += parseNumber(
      row["Sum of Total Converted Monthly Premiums"] ??
      row["sum of total converted monthly premiums"] ??
      0
    );
    return acc;
  }, {
    mailed: 0,
    oppCount: 0,
    inForce: 0,
    sold: 0,
    totalMonthlyPremium: 0,
    inForceMonthlyPremium: 0,
    totalConvertedMonthlyPremiums: 0,
  });

  const averageMonthlyPremium = totals.oppCount > 0
    ? totals.totalMonthlyPremium / totals.oppCount
    : 0;

  return [
    { key: "Sum of Mailed", label: "Sum of Mailed", value: Math.round(totals.mailed).toLocaleString("en-US") },
    { key: "Sum of Opp Count", label: "Sum of Opp Count", value: Math.round(totals.oppCount).toLocaleString("en-US") },
    { key: "Sum of In Force", label: "Sum of In Force", value: Math.round(totals.inForce).toLocaleString("en-US") },
    { key: "Sum of Sold", label: "Sum of Sold", value: Math.round(totals.sold).toLocaleString("en-US") },
    { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", value: totals.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", value: totals.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", value: totals.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }) },
  ];
}

function fillAnalysisRateFallbacks(row = {}) {
  const mailed = parseNumber(row["Sum of Mailed"] ?? row["sum of mailed"] ?? row["Mailed"] ?? row["mailed"] ?? 0);
  if (!(mailed > 0)) {
    return row;
  }

  const inForce = parseNumber(row["Sum of In Force"] ?? row["sum of in force"] ?? row["In Force"] ?? row["in force"] ?? 0);
  const oppCount = parseNumber(row["Sum of Opp Count"] ?? row["sum of opp count"] ?? row["Opp Count"] ?? row["opp count"] ?? 0);
  const totalMonthlyPremium = parseNumber(
    row["Sum of Total Monthly Premium"] ??
    row["sum of total monthly premium"] ??
    row["Total Monthly Premium"] ??
    row["total monthly premium"] ??
    0
  );
  const inForceMonthlyPremium = parseNumber(
    row["Sum of In Force Monthly Premium"] ??
    row["sum of in force monthly premium"] ??
    row["In Force Monthly Premium"] ??
    row["in force monthly premium"] ??
    0
  );
  const totalConvertedMonthlyPremiums = parseNumber(
    row["Sum of Total Converted Monthly Premiums"] ??
    row["sum of total converted monthly premiums"] ??
    row["Total Converted Monthly Premiums"] ??
    row["total converted monthly premiums"] ??
    0
  );
  const sold = resolveAnalysisSoldValue(row, totalConvertedMonthlyPremiums);
  row["Sum of Sold"] = Math.round(sold).toLocaleString("en-US");
  row["sum of sold"] = Math.round(sold).toLocaleString("en-US");
  row.Sold = Math.round(sold).toLocaleString("en-US");
  row.sold = Math.round(sold).toLocaleString("en-US");
  const nextSoldRate = oppCount > 0
    ? (oppCount / mailed) * 100
    : 0;
  const nextInForceRate = inForce > 0
    ? (inForce / mailed) * 100
    : 0;
  const nextConvertedRate = sold > 0
    ? (sold / mailed) * 100
    : 0;

  row["Sold Rate"] = nextSoldRate.toFixed(10);
  row["sold rate"] = nextSoldRate.toFixed(10);
  row["In Force Rate"] = nextInForceRate.toFixed(10);
  row["in force rate"] = nextInForceRate.toFixed(10);
  row["Converted Rate"] = nextConvertedRate.toFixed(10);
  row["converted rate"] = nextConvertedRate.toFixed(10);
  const averageMonthlyPremium = oppCount > 0 ? totalMonthlyPremium / oppCount : 0;
  row.averageMonthlyPremium = averageMonthlyPremium;
  return row;
}

function resolveAnalysisSoldValue(row = {}, precomputedConvertedPremium = null) {
  const baseSold = parseNumber(row["Sum of Sold"] ?? row["sum of sold"] ?? row["Sold"] ?? row["sold"] ?? 0);
  const convertedPremium = precomputedConvertedPremium === null
    ? parseNumber(
      row["Sum of Total Converted Monthly Premiums"] ??
      row["sum of total converted monthly premiums"] ??
      row["Total Converted Monthly Premiums"] ??
      row["total converted monthly premiums"] ??
      0
    )
    : precomputedConvertedPremium;

  if (convertedPremium > 0) {
    return Math.max(baseSold, 1);
  }

  return baseSold;
}

function resolveAnalysisSoldCountFromDetailRow(row = {}, precomputedConvertedPremium = null) {
  const convertedPremium = precomputedConvertedPremium === null
    ? parseNumber(
      row["Sum of Total Converted Monthly Premiums"] ??
      row["sum of total converted monthly premiums"] ??
      row["Total Converted Monthly Premiums"] ??
      row["total converted monthly premiums"] ??
      0
    )
    : precomputedConvertedPremium;

  return convertedPremium > 0 ? 1 : 0;
}

function buildGroupedReportRows(reportPayload) {
  const groupingColumns = getGroupingColumns(reportPayload);
  const aggregateColumns = getAggregateColumns(reportPayload);
  const downGroups = reportPayload.groupingsDown?.groupings || [];
  const factMap = reportPayload.factMap || {};

  if (!groupingColumns.length || !aggregateColumns.length || !downGroups.length) {
    return null;
  }

  const rows = [];
  const visitGrouping = (group, path = []) => {
    const nextPath = [...path, group];
    const children = Array.isArray(group.groupings) ? group.groupings : [];
    if (children.length > 0) {
      children.forEach((child) => visitGrouping(child, nextPath));
      return;
    }

    const factKey = `${group.key}!T`;
    const factEntry = factMap[factKey];
    const factAggregates = Array.isArray(factEntry?.aggregates) ? factEntry.aggregates : [];
    if (!factAggregates.length) {
      return;
    }

    const row = {};
    groupingColumns.forEach((column, index) => {
      const grouping = nextPath[index];
      const value = grouping?.label ?? "";
      row[column.label] = value;
      row[column.normalized] = value;
    });

    aggregateColumns.forEach((column, index) => {
      const value = factAggregates[index]?.label ?? "";
      row[column.label] = value;
      row[column.normalized] = value;
    });

    fillAnalysisRateFallbacks(row);
    rows.push(row);
  };

  downGroups.forEach((group) => visitGrouping(group, []));

  rows.sort((rowA, rowB) => {
    const soldRateA = parseNumber(rowA["Sold Rate"] ?? rowA["sold rate"]);
    const soldRateB = parseNumber(rowB["Sold Rate"] ?? rowB["sold rate"]);
    if (soldRateB !== soldRateA) {
      return soldRateB - soldRateA;
    }

    const scfA = String(rowA["SCF Grouping"] ?? rowA["scf grouping"] ?? "");
    const scfB = String(rowB["SCF Grouping"] ?? rowB["scf grouping"] ?? "");
    return scfA.localeCompare(scfB, undefined, { numeric: true });
  });

  return {
    columns: [
      ...groupingColumns.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
      ...aggregateColumns,
    ],
    rows,
    summaryValues: buildAnalysisSummaryValuesFromRows(rows),
  };
}

function buildGroupingPathLookup(groups = [], path = [], lookup = new Map()) {
  groups.forEach((group) => {
    const nextPath = [...path, group];
    const children = Array.isArray(group.groupings) ? group.groupings : [];
    if (children.length > 0) {
      buildGroupingPathLookup(children, nextPath, lookup);
      return;
    }
    lookup.set(String(group.key || ""), nextPath);
  });
  return lookup;
}

function buildDetailExportRows(reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const groupingColumns = getGroupingColumns(reportPayload);
  const groupingLookup = buildGroupingPathLookup(reportPayload.groupingsDown?.groupings || []);
  const factMap = reportPayload.factMap || {};
  const rows = [];

  Object.entries(factMap)
    .filter(([, value]) => Array.isArray(value?.rows) && value.rows.length > 0)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB, undefined, { numeric: true }))
    .forEach(([factKey, value]) => {
      const groupingKey = String(factKey).replace(/!T$/, "");
      const groupingPath = groupingLookup.get(groupingKey) || [];
      value.rows.forEach((row) => {
        const output = buildDisplayRowObject(row, columnMap);
        groupingColumns.forEach((column, index) => {
          const grouping = groupingPath[index];
          const label = grouping?.label || "";
          output[column.label] = label;
          output[column.normalized] = label;
        });
        rows.push(output);
      });
    });

  return {
    columns: [
      ...columnMap.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
      ...groupingColumns.map((column) => ({
        key: column.key,
        label: column.label,
        normalized: column.normalized,
        dataType: column.dataType,
      })),
    ],
    rows,
  };
}

async function buildFullDetailExportRows(tokenRecord, describePayload, filters = {}) {
  const plan = buildAnalysisDetailSoqlPlan(describePayload, filters);
  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  const rows = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

  return {
    columns: fields.map((field) => ({
      key: field.key || field.soqlField,
      label: field.label || field.soqlField,
      normalized: field.normalized || normalizeLabel(field.label || field.soqlField),
      dataType: field.dataType || null,
    })),
    rows,
  };
}

function countRowsWithScfValue(rows = []) {
  return rows.filter((row) =>
    Object.entries(row || {}).some(([key, rawValue]) => {
      if (String(key).endsWith("__label")) {
        return false;
      }
      if (!normalizeLabel(key).includes("scf")) {
        return false;
      }
      return String(rawValue || "").trim() !== "";
    })
  ).length;
}

function choosePreferredAnalysisExportRows(primaryExport, fallbackExport) {
  const primaryRows = Array.isArray(primaryExport?.rows) ? primaryExport.rows : [];
  const fallbackRows = Array.isArray(fallbackExport?.rows) ? fallbackExport.rows : [];

  if (!fallbackRows.length) {
    return primaryExport;
  }

  if (!primaryRows.length) {
    return fallbackExport;
  }

  const primaryScfRowCount = countRowsWithScfValue(primaryRows);
  const fallbackScfRowCount = countRowsWithScfValue(fallbackRows);

  if (fallbackScfRowCount > primaryScfRowCount) {
    return fallbackExport;
  }

  if (fallbackScfRowCount === primaryScfRowCount && fallbackRows.length > primaryRows.length) {
    return fallbackExport;
  }

  return primaryExport;
}

function normalizeAnalysisDateValue(value) {
  const normalized = String(value || "").trim().replace(/\//g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function buildFlatReportRows(reportPayload) {
  const grouped = buildGroupedReportRows(reportPayload);
  if (grouped) {
    return grouped;
  }

  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap));

  return {
    columns: columnMap.map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType,
    })),
    rows,
    summaryValues: [],
  };
}

function buildFlatRowsFromDetailExport(exportRows = []) {
  const aggregateMap = new Map();
  const hasPremiumFieldValues = exportRows.some((row) => {
    const premiumValue =
      row["Total Monthly Premium"] ??
      row["total monthly premium"] ??
      row["Sum of Total Monthly Premium"] ??
      row["sum of total monthly premium"] ??
      row["In Force Monthly Premium"] ??
      row["in force monthly premium"] ??
      row["Sum of In Force Monthly Premium"] ??
      row["sum of in force monthly premium"] ??
      row["Total Converted Monthly Premiums"] ??
      row["total converted monthly premiums"] ??
      row["Sum of Total Converted Monthly Premiums"] ??
      row["sum of total converted monthly premiums"] ??
      "";
    return parseNumber(premiumValue) !== 0;
  });
  exportRows.forEach((row) => {
    const scf = normalizeScf(
      row["SCF Grouping"] ??
      row["scf grouping"] ??
      row["SCF"] ??
      row.scf ??
      ""
    );
    if (!scf) {
      return;
    }

    const keyCode = String(
      row["Key"] ??
      row.key ??
      row["Report Key"] ??
      row["report key"] ??
      ""
    ).trim();
    const aggregateKey = `${scf}::${keyCode}`;
    const rowTotalMonthlyPremium = parseNumber(
      getLikelyColumnValue(row, [
        "Total Monthly Premium",
        "Sum of Total Monthly Premium",
        "Monthly Premium",
        "Sold Premium",
      ]) ?? 0
    );
    const rowInForceMonthlyPremium = parseNumber(
      getLikelyColumnValue(row, [
        "In Force Monthly Premium",
        "Sum of In Force Monthly Premium",
      ]) ?? 0
    );
    const rowConvertedPremium = parseNumber(
      getLikelyColumnValue(row, [
        "Total Converted Monthly Premiums",
        "Sum of Total Converted Monthly Premiums",
        "Converted Monthly Premium",
      ]) ?? 0
    );
    const rowOppCount = parseNumber(
      getLikelyColumnValue(row, [
        "Opp Count",
        "Sum of Opp Count",
        "Applications Received",
        "Application Count",
      ]) ?? 0
    );
    const rowApplicationPremium = rowTotalMonthlyPremium > 0
      ? rowTotalMonthlyPremium
      : rowConvertedPremium > 0
        ? rowConvertedPremium
        : rowInForceMonthlyPremium > 0
          ? rowInForceMonthlyPremium
          : 0;
    const current = aggregateMap.get(aggregateKey) || {
      scf,
      keyCode,
      mailed: 0,
      oppCount: 0,
      inForce: 0,
      sold: 0,
      totalMonthlyPremium: 0,
      inForceMonthlyPremium: 0,
      totalConvertedMonthlyPremiums: 0,
      applicationPremiumTotal: 0,
      soldRateWeightedTotal: 0,
      soldRateWeight: 0,
      inForceRateWeightedTotal: 0,
      inForceRateWeight: 0,
      convertedRateWeightedTotal: 0,
      convertedRateWeight: 0,
      highPremium: null,
      lowPremium: null,
    };

    current.mailed += parseNumber(
      getLikelyColumnValue(row, [
        "Mailed",
        "Sum of Mailed",
      ]) ?? 0
    );
    current.oppCount += rowOppCount;
    current.inForce += parseNumber(
      getLikelyColumnValue(row, [
        "In Force",
        "Sum of In Force",
      ]) ?? 0
    );
    current.totalMonthlyPremium += rowTotalMonthlyPremium;
    current.inForceMonthlyPremium += rowInForceMonthlyPremium;
    current.totalConvertedMonthlyPremiums += rowConvertedPremium;
    current.sold += resolveAnalysisSoldValue(row, rowConvertedPremium);
    if (rowOppCount > 0 && rowApplicationPremium > 0) {
      current.applicationPremiumTotal += rowApplicationPremium;
      current.highPremium = current.highPremium === null
        ? rowApplicationPremium
        : Math.max(current.highPremium, rowApplicationPremium);
      current.lowPremium = current.lowPremium === null
        ? rowApplicationPremium
        : Math.min(current.lowPremium, rowApplicationPremium);
    }
    const rowMailed = parseNumber(
      getLikelyColumnValue(row, [
        "Mailed",
        "Sum of Mailed",
      ]) ?? 0
    );
    const rowSold = resolveAnalysisSoldValue(row, rowConvertedPremium);
    const sourceSoldRate = parseNumber(row["Sold Rate"] ?? row["sold rate"]);
    const sourceInForceRate = parseNumber(row["In Force Rate"] ?? row["in force rate"]);
    const sourceConvertedRate = rowMailed > 0 ? (rowSold / rowMailed) * 100 : 0;
    if (rowMailed > 0 && Number.isFinite(sourceSoldRate) && Math.abs(sourceSoldRate) > 0.000001) {
      current.soldRateWeightedTotal += sourceSoldRate * rowMailed;
      current.soldRateWeight += rowMailed;
    }
    if (rowMailed > 0 && Number.isFinite(sourceInForceRate) && Math.abs(sourceInForceRate) > 0.000001) {
      current.inForceRateWeightedTotal += sourceInForceRate * rowMailed;
      current.inForceRateWeight += rowMailed;
    }
    if (rowMailed > 0 && Number.isFinite(sourceConvertedRate) && Math.abs(sourceConvertedRate) > 0.000001) {
      current.convertedRateWeightedTotal += sourceConvertedRate * rowMailed;
      current.convertedRateWeight += rowMailed;
    }
    aggregateMap.set(aggregateKey, current);
  });

  const rows = Array.from(aggregateMap.values())
    .sort((entryA, entryB) => {
      const soldRateA = entryA.mailed > 0 ? (entryA.oppCount / entryA.mailed) * 100 : 0;
      const soldRateB = entryB.mailed > 0 ? (entryB.oppCount / entryB.mailed) * 100 : 0;
      if (soldRateB !== soldRateA) {
        return soldRateB - soldRateA;
      }
      if (entryA.scf !== entryB.scf) {
        return entryA.scf.localeCompare(entryB.scf, undefined, { numeric: true });
      }
      return entryA.keyCode.localeCompare(entryB.keyCode, undefined, { numeric: true });
    })
    .map((entry) => {
      const soldRate = entry.mailed > 0 ? (entry.oppCount / entry.mailed) * 100 : 0;
      const inForceRate = entry.mailed > 0 ? (entry.inForce / entry.mailed) * 100 : 0;
      const convertedRate = entry.mailed > 0 ? (entry.sold / entry.mailed) * 100 : 0;
      const averageSoldPremium = entry.oppCount > 0 ? entry.applicationPremiumTotal / entry.oppCount : 0;

      return {
        "SCF Grouping": entry.scf,
        "scf grouping": entry.scf,
        "Key": entry.keyCode,
        "key": entry.keyCode,
        "Sum of Mailed": Math.round(entry.mailed).toLocaleString("en-US"),
        "sum of mailed": Math.round(entry.mailed).toLocaleString("en-US"),
        "Sum of Opp Count": Math.round(entry.oppCount).toLocaleString("en-US"),
        "sum of opp count": Math.round(entry.oppCount).toLocaleString("en-US"),
        "Sum of In Force": Math.round(entry.inForce).toLocaleString("en-US"),
        "sum of in force": Math.round(entry.inForce).toLocaleString("en-US"),
        "Sum of Sold": Math.round(entry.sold).toLocaleString("en-US"),
        "sum of sold": Math.round(entry.sold).toLocaleString("en-US"),
        "Sum of Total Monthly Premium": entry.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of total monthly premium": entry.totalMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "Sum of In Force Monthly Premium": entry.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of in force monthly premium": entry.inForceMonthlyPremium.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "Sum of Total Converted Monthly Premiums": entry.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        "sum of total converted monthly premiums": entry.totalConvertedMonthlyPremiums.toLocaleString("en-US", { style: "currency", currency: "USD" }),
        averageMonthlyPremium: averageSoldPremium,
        highPremium: entry.highPremium,
        lowPremium: entry.lowPremium,
        "Sold Rate": soldRate.toFixed(10),
        "sold rate": soldRate.toFixed(10),
        "In Force Rate": inForceRate.toFixed(10),
        "in force rate": inForceRate.toFixed(10),
        "Converted Rate": convertedRate.toFixed(10),
        "converted rate": convertedRate.toFixed(10),
      };
    });

  return {
    columns: [
      { key: "SCF Grouping", label: "SCF Grouping", normalized: "scf grouping", dataType: "string" },
      { key: "Key", label: "Key", normalized: "key", dataType: "string" },
      { key: "Sum of Mailed", label: "Sum of Mailed", normalized: "sum of mailed", dataType: "double" },
      { key: "Sum of Opp Count", label: "Sum of Opp Count", normalized: "sum of opp count", dataType: "double" },
      { key: "Sum of In Force", label: "Sum of In Force", normalized: "sum of in force", dataType: "double" },
      { key: "Sum of Sold", label: "Sum of Sold", normalized: "sum of sold", dataType: "double" },
      { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", normalized: "sum of total monthly premium", dataType: "currency" },
      { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", normalized: "sum of in force monthly premium", dataType: "currency" },
      { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", normalized: "sum of total converted monthly premiums", dataType: "currency" },
      { key: "Sold Rate", label: "Sold Rate", normalized: "sold rate", dataType: "double" },
      { key: "In Force Rate", label: "In Force Rate", normalized: "in force rate", dataType: "double" },
      { key: "Converted Rate", label: "Converted Rate", normalized: "converted rate", dataType: "double" },
    ],
    rows,
    summaryValues: [
      { key: "Sum of Mailed", label: "Sum of Mailed", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.mailed, 0)).toLocaleString("en-US") },
      { key: "Sum of Opp Count", label: "Sum of Opp Count", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.oppCount, 0)).toLocaleString("en-US") },
      { key: "Sum of In Force", label: "Sum of In Force", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.inForce, 0)).toLocaleString("en-US") },
      { key: "Sum of Sold", label: "Sum of Sold", value: Math.round(Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.sold, 0)).toLocaleString("en-US") },
      { key: "Sum of Total Monthly Premium", label: "Sum of Total Monthly Premium", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.totalMonthlyPremium, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
      { key: "Sum of In Force Monthly Premium", label: "Sum of In Force Monthly Premium", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.inForceMonthlyPremium, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
      { key: "Sum of Total Converted Monthly Premiums", label: "Sum of Total Converted Monthly Premiums", value: Array.from(aggregateMap.values()).reduce((sum, entry) => sum + entry.totalConvertedMonthlyPremiums, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }) },
    ],
  };
}

function normalizeAnalysisKeyCodeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "nhcl" || normalized === "n") {
    return "N";
  }
  if (normalized === "rfc") {
    return "RFC";
  }
  return String(value || "").trim();
}

function buildAnalysisMetricReportMetadata(describePayload, filters = {}) {
  const reportMetadata = describePayload.reportMetadata || {};
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getGroupingColumns({ reportExtendedMetadata: describePayload.reportExtendedMetadata }).map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType || "string",
      fullyQualifiedName: column.key,
      rootObject: getRootObjectName(column.key),
      soqlField: translateReportFieldToSoql(column.key, getRootObjectName(column.key)),
    })),
  ];
  const scfField = findFieldByLikelyLabels(fields, ["SCF Grouping", "SCF"]);
  const keyField = findFieldByLikelyLabels(fields, ["Key", "Key Code", "Report Key"]);
  const nextReportFilters = Array.isArray(reportMetadata.reportFilters)
    ? [...reportMetadata.reportFilters]
    : [];
  const startDate = normalizeAnalysisDateValue(filters.dateRange?.startDate || "");
  const endDate = normalizeAnalysisDateValue(filters.dateRange?.endDate || "");
  const normalizedScf = normalizeScf(filters.scf);
  if (scfField?.key && normalizedScf) {
    nextReportFilters.push({
      column: scfField.key,
      operator: "equals",
      value: normalizedScf,
    });
  }
  const keyCodes = Array.isArray(filters.keyCodes)
    ? filters.keyCodes
        .map((value) => normalizeAnalysisKeyCodeValue(value))
        .filter(Boolean)
    : [];
  if (keyField?.key && keyCodes.length > 0) {
    nextReportFilters.push({
      column: keyField.key,
      operator: "equals",
      value: keyCodes.join(","),
    });
  }

  const nextMetadata = {
    ...reportMetadata,
    reportFilters: nextReportFilters,
  };
  if (startDate && endDate && reportMetadata.standardDateFilter?.column) {
    nextMetadata.standardDateFilter = {
      ...(reportMetadata.standardDateFilter || {}),
      durationValue: "CUSTOM",
      startDate,
      endDate,
    };
  }

  return nextMetadata;
}

async function fetchAnalysisReportScfMetrics(reportId, filters = {}) {
  const normalizedReportId = String(reportId || "").trim();
  if (!normalizedReportId) {
    throw new Error("Report ID is required.");
  }

  const normalizedScf = normalizeScf(filters.scf);
  if (!normalizedScf) {
    throw new Error("SCF is required.");
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const describePayload = await fetchReportDescribe(tokenRecord, normalizedReportId);
  const reportMetadata = buildAnalysisMetricReportMetadata(describePayload, {
    scf: normalizedScf,
    keyCodes: filters.keyCodes,
    dateRange: filters.dateRange,
  });
  const executed = await executeReportWithDescribeMetadata(
    tokenRecord,
    normalizedReportId,
    reportMetadata,
    describePayload
  );
  const grouped = buildGroupedReportRows(executed.reportPayload);
  const rows = Array.isArray(grouped?.rows) ? grouped.rows : [];
  const fullDetailExport = await buildFullDetailExportRows(tokenRecord, describePayload, {
    scf: normalizedScf,
    keyCodes: filters.keyCodes,
    dateRange: filters.dateRange,
  });
  const detailSummary = Array.isArray(fullDetailExport?.rows) && fullDetailExport.rows.length
    ? buildFlatRowsFromDetailExport(fullDetailExport.rows)
    : { rows: [] };
  const detailRows = Array.isArray(detailSummary?.rows) ? detailSummary.rows : [];
  const normalizedKeys = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => normalizeAnalysisKeyCodeValue(value).toUpperCase()).filter(Boolean)
    : [];
  const matchingRows = rows.filter((row) => {
    const rowScf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row["scf"] ?? "");
    if (rowScf !== normalizedScf) {
      return false;
    }
    if (!normalizedKeys.length) {
      return true;
    }
    const rowKey = String(row["Key"] ?? row.key ?? "").trim().toUpperCase();
    return normalizedKeys.includes(rowKey);
  });
  const matchingDetailRows = detailRows.filter((row) => {
    const rowScf = normalizeScf(row["SCF Grouping"] ?? row["scf grouping"] ?? row["SCF"] ?? row["scf"] ?? "");
    if (rowScf !== normalizedScf) {
      return false;
    }
    if (!normalizedKeys.length) {
      return true;
    }
    const rowKey = String(row["Key"] ?? row.key ?? "").trim().toUpperCase();
    return normalizedKeys.includes(rowKey);
  });
  const mergeMetricRows = (groupedRow, detailRow) => {
    if (!groupedRow && !detailRow) {
      return null;
    }
    return {
      ...(detailRow || {}),
      ...(groupedRow || {}),
      averageMonthlyPremium: Number.isFinite(detailRow?.averageMonthlyPremium)
        ? detailRow.averageMonthlyPremium
        : Number.isFinite(groupedRow?.averageMonthlyPremium)
          ? groupedRow.averageMonthlyPremium
          : null,
      highPremium: Number.isFinite(detailRow?.highPremium)
        ? detailRow.highPremium
        : Number.isFinite(groupedRow?.highPremium)
          ? groupedRow.highPremium
          : null,
      lowPremium: Number.isFinite(detailRow?.lowPremium)
        ? detailRow.lowPremium
        : Number.isFinite(groupedRow?.lowPremium)
          ? groupedRow.lowPremium
          : null,
    };
  };
  const mergedRows = matchingRows.length || matchingDetailRows.length
    ? Array.from({ length: Math.max(matchingRows.length, matchingDetailRows.length) }, (_, index) =>
        mergeMetricRows(matchingRows[index] || null, matchingDetailRows[index] || null)
      ).filter(Boolean)
    : [];

  return {
    reportId: normalizedReportId,
    scf: normalizedScf,
    row: mergedRows[0] || mergeMetricRows(matchingRows[0] || null, matchingDetailRows[0] || null),
    rows: mergedRows,
  };
}

function resolveAnalysisDateRange(filters = {}) {
  const dateRange = filters.dateRange || {};
  const startDate = normalizeAnalysisDateValue(dateRange.startDate);
  const endDate = normalizeAnalysisDateValue(dateRange.endDate);

  if (startDate && endDate) {
    return {
      startDate,
      endDate,
    };
  }

  const years = Array.isArray(filters.years)
    ? filters.years
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value))
    : [];

  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    return {
      startDate: `${minYear}-01-01`,
      endDate: `${maxYear}-12-31`,
    };
  }

  return null;
}

function getLikelyColumnValue(row, candidates) {
  const candidateList = Array.isArray(candidates)
    ? candidates
        .map((entry) => normalizeLabel(String(entry || "").trim()))
        .filter(Boolean)
    : [];

  const entries = Object.entries(row).filter(
    ([key]) => !key.endsWith("__label") && !key.endsWith(" label")
  );

  for (const candidate of candidateList) {
    const exactMatch = entries.find(([key, value]) => {
      const normalizedKey = normalizeLabel(key);
      if (!normalizedKey || normalizedKey === "") {
        return false;
      }

      if (normalizedKey === candidate) {
        return value !== undefined && value !== null && String(value).trim() !== "";
      }

      return false;
    });

    if (exactMatch) {
      return exactMatch[1];
    }
  }

  for (const candidate of candidateList) {
    const fuzzyMatch = entries.find(([key, value]) => {
      const normalizedKey = normalizeLabel(key);
      if (!normalizedKey || normalizedKey === "") {
        return false;
      }

      if (
        normalizedKey.includes(candidate) &&
        normalizedKey !== "code" &&
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
      ) {
        return true;
      }

      return false;
    });

    if (fuzzyMatch) {
      return fuzzyMatch[1];
    }
  }

  return null;
}

function matchesAnyToken(value, tokens) {
  const haystack = normalizeLabel(value);
  return tokens.some((token) => haystack === normalizeLabel(token) || haystack.includes(normalizeLabel(token)));
}

function filterAnalysisRows(rows, filters = {}) {
  const keyCodes = Array.isArray(filters.keyCodes)
    ? filters.keyCodes.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const keyFilters = Array.isArray(filters.keyFilters)
    ? filters.keyFilters.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const scfFilter = String(filters.scf || "").trim();
  const clientType = String(filters.clientType || "").trim();
  const years = Array.isArray(filters.years)
    ? filters.years.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value))
    : [];
  const dateRange = filters.dateRange || {};

  const keyMatchTokens = keyCodes.length > 0 ? keyCodes : [];
  const explicitKeyTokens = keyFilters.length > 0 ? keyFilters : [];
  const combinedKeyFilters = Array.from(new Set([...keyMatchTokens, ...explicitKeyTokens]));

  return rows.filter((row) => {
    if (combinedKeyFilters.length > 0) {
      const keyValue = getLikelyColumnValue(row, [
        "key",
        "key field",
        "key code",
        "keycode",
        "authorization code",
        "auth code",
      ]);

      if (keyValue !== null && !matchesAnyToken(String(keyValue), combinedKeyFilters)) {
        return false;
      }
    }

    if (scfFilter) {
      const scfValue = getLikelyColumnValue(row, ["scf", "sectional center facility"]);
      if (scfValue !== null) {
        const normalizedScfValue = normalizeScf(scfValue);
        if (normalizedScfValue !== normalizeScf(scfFilter)) {
          return false;
        }
      }
    }

    if (clientType) {
      const clientValue = getLikelyColumnValue(row, ["client", "list type", "mailing list"]);
      if (clientValue !== null && !matchesAnyToken(String(clientValue), [clientType])) {
        return false;
      }
    }

    if (years.length > 0 || (dateRange.startDate && dateRange.endDate)) {
      const dateValue = getLikelyColumnValue(row, ["date", "created date", "close date"]);
      if (dateValue === null) {
        return true;
      }

      let parsedDate = null;
      try {
        parsedDate = parseDateValue(dateValue, String(dateValue));
      } catch (error) {
        return false;
      }

      const rowYear = Number(parsedDate.slice(0, 4));
      if (years.length > 0 && !years.includes(rowYear)) {
        return false;
      }

      if (dateRange.startDate && parsedDate < dateRange.startDate) {
        return false;
      }

      if (dateRange.endDate && parsedDate > dateRange.endDate) {
        return false;
      }
    }

    return true;
  });
}

async function getConnectedSalesforceToken() {
  const authStatus = getAuthStatus();

  if (!authStatus.isConfigured) {
    throw new Error("Salesforce OAuth is not configured. Add the Connected App values to .env.");
  }

  let tokenRecord = getStoredToken();
  tokenRecord = await refreshAccessTokenIfNeeded(tokenRecord);
  return tokenRecord;
}

async function fetchFlexibleSalesforceReportData(reportId, filters = {}) {
  const tokenRecord = await getConnectedSalesforceToken();
  const effectiveDateRange = resolveAnalysisDateRange(filters);

  let describePayload = null;
  let reportPayload = null;
  let groupedReportUnavailableReason = "";

  try {
    describePayload = await fetchReportDescribe(tokenRecord, reportId);
    const reportMetadata = buildAnalysisMetricReportMetadata(describePayload, {
      scf: filters.scf,
      keyCodes: filters.keyCodes,
      dateRange: effectiveDateRange,
    });
    const executed = await executeReportWithDescribeMetadata(
      tokenRecord,
      reportId,
      reportMetadata,
      describePayload
    );
    describePayload = executed.describePayload || describePayload;
    reportPayload = executed.reportPayload;
  } catch (error) {
    groupedReportUnavailableReason = error instanceof Error ? error.message : String(error || "");
    if (!effectiveDateRange) {
      throw error;
    }
    describePayload = await fetchReportDescribe(tokenRecord, reportId);
  }

  const flattened = reportPayload
    ? buildFlatReportRows(reportPayload)
    : { columns: [], rows: [], summaryValues: [] };
  const fullDetailExport = await buildFullDetailExportRows(tokenRecord, describePayload, filters);
  const reportPayloadDetailExport = reportPayload
    ? buildDetailExportRows(reportPayload)
    : { columns: [], rows: [] };
  const normalizedDetailSummary = fullDetailExport.rows.length
    ? buildFlatRowsFromDetailExport(fullDetailExport.rows)
    : { columns: [], rows: [], summaryValues: [] };
  const preferredExport = choosePreferredAnalysisExportRows(
    fullDetailExport,
    reportPayloadDetailExport
  );
  const preferredExportSummary = preferredExport.rows.length
    ? buildFlatRowsFromDetailExport(preferredExport.rows)
    : { columns: [], rows: [], summaryValues: [] };
  const shouldPreferDetailSummary =
    normalizedDetailSummary.rows.length > flattened.rows.length
    || countRowsWithScfValue(normalizedDetailSummary.rows) > countRowsWithScfValue(flattened.rows);
  const shouldPreferPreferredExportSummary =
    preferredExportSummary.rows.length > flattened.rows.length
    || countRowsWithScfValue(preferredExportSummary.rows) > countRowsWithScfValue(flattened.rows);
  const effectiveFlattened =
    shouldPreferDetailSummary && (normalizedDetailSummary.rows.length || normalizedDetailSummary.columns.length)
      ? normalizedDetailSummary
      : shouldPreferPreferredExportSummary && (preferredExportSummary.rows.length || preferredExportSummary.columns.length)
        ? preferredExportSummary
      : flattened.rows.length || flattened.columns.length
        ? flattened
        : normalizedDetailSummary.rows.length || normalizedDetailSummary.columns.length
          ? normalizedDetailSummary
          : preferredExportSummary.rows.length || preferredExportSummary.columns.length
            ? preferredExportSummary
            : buildFlatRowsFromDetailExport(preferredExport.rows);
  const availableKeyValues = Array.from(
    new Set(
      effectiveFlattened.rows
        .map((row) => String(row["Key"] || row.key || "").trim())
        .filter(Boolean)
    )
  ).sort();
  return {
    reportId,
    filters: {
      ...filters,
      dateRange: effectiveDateRange || filters.dateRange || null,
    },
    describePayload,
    rawReportPayload: reportPayload,
    groupedReportUnavailableReason,
    columns: effectiveFlattened.columns,
    summaryValues: effectiveFlattened.summaryValues || [],
    rows: filterAnalysisRows(effectiveFlattened.rows, filters),
    exportColumns: effectiveFlattened.columns,
    exportRows: filterAnalysisRows(effectiveFlattened.rows, filters),
    unfilteredRowCount: effectiveFlattened.rows.length,
    exportRowCount: filterAnalysisRows(effectiveFlattened.rows, filters).length,
    availableKeyValues,
  };
}

async function fetchRawSalesforceReportRows(reportId) {
  const normalizedReportId = String(reportId || "").trim();
  if (!normalizedReportId) {
    throw new Error("Report ID is required.");
  }

  const tokenRecord = await getConnectedSalesforceToken();
  const { describePayload, reportPayload } = await executeReportWithoutDateOverride(
    tokenRecord,
    normalizedReportId
  );
  const reportName = describePayload?.reportMetadata?.name || normalizedReportId;
  const shouldFallbackToSoql =
    reportPayload?.allData === false &&
    reportPayload?.hasExceededTabularRowLimit === true;

  if (shouldFallbackToSoql) {
    const plan = buildRawDetailSoqlPlan(describePayload);
    const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
    const rows = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

    return {
      reportId: normalizedReportId,
      reportName,
      columns: fields.map((field) => ({
        key: field.key,
        label: field.label,
        normalized: field.normalized,
        dataType: field.dataType,
      })),
      rows,
    };
  }

  const columnMap = mapColumnLabels(reportPayload);
  const rows = getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap));

  return {
    reportId: normalizedReportId,
    reportName,
    columns: columnMap.map((column) => ({
      key: column.key,
      label: column.label,
      normalized: column.normalized,
      dataType: column.dataType,
    })),
    rows,
  };
}

function firstValue(rowObject, labels) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    const value = rowObject[normalized];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function firstDisplayValue(rowObject, labels) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    const displayValue =
      rowObject[`${normalized} label`] ?? rowObject[`${label}__label`];

    if (
      displayValue !== undefined &&
      displayValue !== null &&
      String(displayValue).trim() !== ""
    ) {
      return displayValue;
    }
  }

  return firstValue(rowObject, labels);
}

function derivePayTypeFromReceived(value) {
  const stringValue = String(value ?? "").trim().toUpperCase();

  if (stringValue === "2" || stringValue === "CC" || stringValue.includes("CREDIT CARD")) {
    return "CC";
  }

  if (
    stringValue === "3" ||
    stringValue === "BILL" ||
    stringValue.includes("BILL") ||
    stringValue.includes("CHECK")
  ) {
    return "BILL";
  }

  return "ACH";
}

function derivePayTypeFromCreditType(value) {
  const stringValue = normalizeLabel(value);

  if (stringValue.includes("credit card")) {
    return "CC";
  }

  if (stringValue.includes("check")) {
    return "BILL";
  }

  return "ACH";
}

function normalizePaymentSummaryPayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizePaymentSummaryRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizeCreditsSummaryPayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizeCreditsSummaryRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizePolicyTypePayload(reportConfig, reportPayload) {
  const columnMap = mapColumnLabels(reportPayload);
  const rows = normalizePolicyTypeRowObjects(
    getDetailRows(reportPayload).map((row) => buildRowObject(row, columnMap))
  );

  return {
    key: reportConfig.key,
    tabName: reportConfig.tabName,
    transactionType: reportConfig.transactionType,
    rows,
  };
}

function normalizeDetailPayload(reportConfig, reportPayload) {
  if (reportConfig.key === "paymentSummary") {
    return normalizePaymentSummaryPayload(reportConfig, reportPayload);
  }

  if (reportConfig.key === "creditsSummary") {
    return normalizeCreditsSummaryPayload(reportConfig, reportPayload);
  }

  if (reportConfig.key === "policyType") {
    return normalizePolicyTypePayload(reportConfig, reportPayload);
  }

  throw new Error(`Unsupported detail report mapping: ${reportConfig.key}`);
}

function normalizePaymentSummaryRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const typeReceived = firstValue(rowObject, ["Type Received"]);
    const gatewayResponseMessage =
      firstValue(rowObject, ["Gateway Response Message"]) ||
      firstValue(rowObject, ["Gateway Response Message2"]);
    const gatewayResponseMessage2 = String(
      firstDisplayValue(rowObject, ["Gateway Response Message2"]) ||
        firstValue(rowObject, ["Gateway Response Message2"])
    ).trim();

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, [
          "Policy: Certificate",
          "Policy: Certificate ID",
          "Policy: Certificate External ID",
          "Certificate",
        ])
      ).trim(),
      transactionDate: parseDateValue(
        firstValue(rowObject, ["Date Received"]),
        String(firstValue(rowObject, ["Date Received"]))
      ),
      typeReceived,
      payType: derivePayTypeFromReceived(typeReceived),
      amount: parseNumber(firstValue(rowObject, ["Amount Received"])),
      checkNumber: String(firstDisplayValue(rowObject, ["Check #"])).trim(),
      authCode: String(firstDisplayValue(rowObject, ["Auth Code"])).trim(),
      approval: String(firstDisplayValue(rowObject, ["Issuer Response Text"])).trim(),
      gatewayTxnId: String(firstDisplayValue(rowObject, ["Gateway Txn ID"])).trim(),
      gatewayResponseMessage: String(
        firstDisplayValue(rowObject, [
          "Gateway Response Message",
          "Gateway Response Message2",
        ]) || gatewayResponseMessage
      ).trim(),
      gatewayResponseMessage2,
      reasonForCredit: gatewayResponseMessage2,
      raw: rowObject,
    };
  });
}

function normalizeCreditsSummaryRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const type = firstValue(rowObject, ["Type"]);
    const amount = Math.abs(parseNumber(firstValue(rowObject, ["Amount"]))) * -1;

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, ["Certificate: Certificate Name", "Certificate"])
      ).trim(),
      transactionDate: parseDateValue(
        firstValue(rowObject, ["Date Refunded"]),
        String(firstValue(rowObject, ["Date Refunded"]))
      ),
      type: String(firstDisplayValue(rowObject, ["Type"]) || type).trim(),
      payType: derivePayTypeFromCreditType(type),
      amount,
      checkNumber: String(firstDisplayValue(rowObject, ["Check No", "Check #"])).trim(),
      approval: String(firstDisplayValue(rowObject, ["Credit Batch ID (Approval)"])).trim(),
      reasonForCredit: String(firstDisplayValue(rowObject, ["Credit Reason Code"])).trim(),
      raw: rowObject,
    };
  });
}

function normalizePolicyTypeRowObjects(rowObjects) {
  return rowObjects.map((rowObject) => {
    const policyType = String(
      firstDisplayValue(rowObject, ["Policy Type"]) || firstValue(rowObject, ["Policy Type"])
    ).trim();

    return {
      certificateNumber: String(
        firstDisplayValue(rowObject, ["Certificate: Certificate Name", "Certificate"])
      ).trim(),
      policyType,
      members: policyType ? policyType.slice(0, 1) : "",
      raw: rowObject,
    };
  });
}

function getDetailSupplementalFields(reportConfig) {
  if (reportConfig.key === "certs") {
    return [
      {
        label: "Product",
        normalized: normalizeLabel("Product"),
        dataType: "picklist",
        soqlField: "Policy_Record_for_TPA__r.Product__c",
      },
      {
        label: "Policy Type",
        normalized: normalizeLabel("Policy Type"),
        dataType: "picklist",
        soqlField: "Policy_Record_for_TPA__r.Policy_Type__c",
      },
      {
        label: "Effective Date",
        normalized: normalizeLabel("Effective Date"),
        dataType: "date",
        soqlField: "Policy_Record_for_TPA__r.Effective_Date__c",
      },
      {
        label: "Pay To Date",
        normalized: normalizeLabel("Pay To Date"),
        dataType: "date",
        soqlField: "Policy_Record_for_TPA__r.Pay_To_Date__c",
      },
      {
        label: "Orig Rate (1 Person)",
        normalized: normalizeLabel("Orig Rate (1 Person)"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Rate_1__c",
      },
      {
        label: "Orig Rate (2 Person)",
        normalized: normalizeLabel("Orig Rate (2 Person)"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Rate_2__c",
      },
      {
        label: "Total AD&D Coverage",
        normalized: normalizeLabel("Total AD&D Coverage"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Total_AD_D_Coverage__c",
      },
      {
        label: "Free Term Life Coverage Amt",
        normalized: normalizeLabel("Free Term Life Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Free_Coverage__c",
      },
      {
        label: "Orig Contrib AD&D Coverage Amt",
        normalized: normalizeLabel("Orig Contrib AD&D Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Orig_Contrib_AD_D_Coverage_Amt__c",
      },
      {
        label: "Orig Non-Contrib AD&D Coverage Amt",
        normalized: normalizeLabel("Orig Non-Contrib AD&D Coverage Amt"),
        dataType: "currency",
        soqlField: "Policy_Record_for_TPA__r.Orig_Non_Contrib_AD_D_Coverage_Amt__c",
      },
    ];
  }

  if (reportConfig.key === "payments") {
    return [
      {
        label: "Certificate",
        normalized: normalizeLabel("Certificate"),
        dataType: "string",
        soqlField: "Certificate__r.Name",
      },
    ];
  }

  if (reportConfig.key !== "paymentSummary") {
    return [];
  }

  return [
    {
      label: "Check #",
      normalized: normalizeLabel("Check #"),
      dataType: "string",
      soqlField: "Check__c",
    },
    {
      label: "Auth Code",
      normalized: normalizeLabel("Auth Code"),
      dataType: "string",
      soqlField: "Auth_Code__c",
    },
    {
      label: "Issuer Response Text",
      normalized: normalizeLabel("Issuer Response Text"),
      dataType: "string",
      soqlField: "Issuer_Response_Text__c",
    },
    {
      label: "Gateway Txn ID",
      normalized: normalizeLabel("Gateway Txn ID"),
      dataType: "string",
      soqlField: "Gateway_Txn_ID__c",
    },
    {
      label: "Gateway Response Message",
      normalized: normalizeLabel("Gateway Response Message"),
      dataType: "string",
      soqlField: "Gateway_Response_Message__c",
    },
    {
      label: "Policy: Certificate ID",
      normalized: normalizeLabel("Policy: Certificate ID"),
      dataType: "string",
      soqlField: "Policy__r.Certificate_ID__c",
    },
    {
      label: "Policy: Certificate External ID",
      normalized: normalizeLabel("Policy: Certificate External ID"),
      dataType: "string",
      soqlField: "Policy__r.Certificate_External_ID__c",
    },
    {
      label: "Policy: Certificate",
      normalized: normalizeLabel("Policy: Certificate"),
      dataType: "string",
      soqlField: "Policy__r.Account__r.Name",
    },
  ];
}

function buildDetailSoql(describePayload, reportConfig, reportMonth) {
  const dateRange = getMonthDateRange(reportMonth);
  const fields = [
    ...mapDescribeFields(describePayload),
    ...getDetailSupplementalFields(reportConfig),
  ];
  const reportMetadata = describePayload.reportMetadata || {};

  if (fields.length === 0) {
    throw new Error("Salesforce report is missing detail columns.");
  }

  const hasExplicitStandardRange =
    reportMetadata.standardDateFilter?.startDate || reportMetadata.standardDateFilter?.endDate;
  const fallbackDateField = fields.find((field) => looksLikeDateLabel(field.normalized))?.soqlField;
  const objectName =
    fields.find((field) => String(field.rootObject || "").trim())?.rootObject ||
    getRootObjectName(fields[0].fullyQualifiedName || fields[0].key);
  const dateField =
    translateReportFieldToSoql(reportMetadata.standardDateFilter?.column, objectName) ||
    fallbackDateField;
  const dateFieldInfo =
    fields.find((field) => field.soqlField === dateField) || {
      dataType: inferSoqlFieldDataType(dateField),
    };

  if (!dateField && hasExplicitStandardRange) {
    throw new Error("Salesforce report is missing a standard date field.");
  }

  const selectFields = [...new Set(fields.map((field) => field.soqlField).filter(Boolean))];
  const whereClauses = [];

  if (dateField && (hasExplicitStandardRange || fallbackDateField)) {
    whereClauses.push(
      `${dateField} >= ${formatSoqlBoundaryValue(
        dateRange.startDate,
        dateFieldInfo.dataType,
        "start"
      )}`
    );
    whereClauses.push(
      `${dateField} <= ${formatSoqlBoundaryValue(
        dateRange.endDate,
        dateFieldInfo.dataType,
        "end"
      )}`
    );
  }

  (reportMetadata.reportFilters || []).forEach((filter) => {
    const clause = buildFilterClause(filter, describePayload, objectName);
    if (clause) {
      whereClauses.push(clause);
    }
  });

  return {
    objectName,
    dateField,
    whereClauses,
    fields,
  };
}

function composeDetailSoql(plan, selectedFields) {
  const whereSection = plan.whereClauses.length
    ? `\nWHERE ${plan.whereClauses.join("\nAND ")}`
    : "";
  const orderBySection = plan.dateField ? `\nORDER BY ${plan.dateField}` : "";

  return `
SELECT ${selectedFields.join(", ")}
FROM ${plan.objectName}
${whereSection}
${orderBySection}
`.trim();
}

function extractInvalidSoqlField(error) {
  const message = String(error?.message || "");
  const columnMatch = message.match(/No such column '([^']+)'/);
  if (columnMatch) {
    return columnMatch[1];
  }

  const relationshipMatch = message.match(/Didn't understand relationship '([^']+)'/);
  if (relationshipMatch) {
    return relationshipMatch[1];
  }

  return null;
}

async function runDetailSoqlWithFallback(tokenRecord, plan) {
  let selectedFields = [...new Set(plan.fields.map((field) => field.soqlField).filter(Boolean))];
  let whereClauses = [...(plan.whereClauses || [])];
  let lastError = null;

  while (selectedFields.length > 0) {
    try {
      const records = await runSoqlQuery(
        tokenRecord,
        composeDetailSoql({ ...plan, whereClauses }, selectedFields)
      );
      const allowed = new Set(selectedFields);
      return {
        records,
        fields: plan.fields.filter((field) => allowed.has(field.soqlField)),
      };
      } catch (error) {
        lastError = error;
        const invalidField = extractInvalidSoqlField(error);
        if (!invalidField) {
          throw error;
        }

        const nextFields = selectedFields.filter(
          (fieldName) =>
            fieldName !== invalidField &&
            !String(fieldName).startsWith(`${invalidField}.`)
        );

        if (nextFields.length !== selectedFields.length) {
          selectedFields = nextFields;
          continue;
        }

        const nextWhereClauses = whereClauses.filter(
          (clause) =>
            !String(clause).includes(`${invalidField} `) &&
            !String(clause).includes(`${invalidField}.`) &&
            !String(clause).includes(`${invalidField}=`)
        );
        if (nextWhereClauses.length !== whereClauses.length) {
          whereClauses = nextWhereClauses;
          continue;
        }

        throw error;
      }
    }

  throw lastError || new Error("No queryable detail fields were available for the Salesforce report.");
}

async function fetchFullDetailRows(tokenRecord, reportConfig, reportMonth) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const plan = buildDetailSoql(describePayload, reportConfig, reportMonth);
  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  const rowObjects = records.map((record) => buildRowObjectFromSoqlRecord(record, fields));

  if (reportConfig.key === "paymentSummary") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizePaymentSummaryRowObjects(rowObjects),
    };
  }

  if (reportConfig.key === "creditsSummary") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizeCreditsSummaryRowObjects(rowObjects),
    };
  }

  if (reportConfig.key === "policyType") {
    return {
      key: reportConfig.key,
      tabName: reportConfig.tabName,
      transactionType: reportConfig.transactionType,
      rows: normalizePolicyTypeRowObjects(rowObjects),
    };
  }

  throw new Error(`Unsupported detail report mapping: ${reportConfig.key}`);
}

async function fetchFullFlatReportRows(tokenRecord, reportConfig, reportMonth, options = {}) {
  const describePayload = await fetchReportDescribe(tokenRecord, reportConfig.reportId);
  const plan = buildDetailSoql(describePayload, reportConfig, reportMonth);

  if (options.applyDateFilter === false) {
    plan.whereClauses = (plan.whereClauses || []).filter(
      (clause) => !plan.dateField || !String(clause).includes(plan.dateField)
    );
    plan.dateField = null;
  }

  const { records, fields } = await runDetailSoqlWithFallback(tokenRecord, plan);
  return records.map((record) => buildRowObjectFromSoqlRecord(record, fields));
}

async function fetchReportTypeData(tokenRecord, reportType, reportMonth) {
  const results = [];

  for (const reportConfig of reportType.salesforceReports) {
    try {
      if (reportType.id === "transaction-detail") {
        results.push(await fetchFullDetailRows(tokenRecord, reportConfig, reportMonth));
        continue;
      }

      if (reportType.id === "transaction-summary" && reportConfig.useAggregateQuery) {
        try {
          results.push(
            await fetchAggregateReportRows(tokenRecord, reportConfig, reportMonth)
          );
          continue;
        } catch (error) {
          // Fall through to the regular report API.
        }
      }

      const reportPayload = await executeReport(tokenRecord, reportConfig.reportId, reportMonth);

      if (reportType.id === "transaction-detail") {
        results.push(normalizeDetailPayload(reportConfig, reportPayload));
      } else {
        results.push(normalizeSummaryReportPayload(reportConfig, reportPayload));
      }
    } catch (error) {
      throw new Error(
        `Failed to pull ${reportConfig.transactionType} (${reportConfig.reportId}): ${error.message}`
      );
    }
  }

  return results;
}

async function fetchMonthlySalesforceReportData(
  reportTypeId = DEFAULT_MONTHLY_REPORT_TYPE,
  reportMonth
) {
  const authStatus = getAuthStatus();
  const reportType = getMonthlyReportType(reportTypeId);

  if (!reportType) {
    throw new Error(`Unknown monthly report type: ${reportTypeId}`);
  }

  if (!authStatus.isConfigured) {
    throw new Error("Salesforce OAuth is not configured. Add the Connected App values to .env.");
  }

  let tokenRecord = getStoredToken();
  tokenRecord = await refreshAccessTokenIfNeeded(tokenRecord);

  const rawTabs = await fetchReportTypeData(tokenRecord, reportType, reportMonth);

  return {
    reportType: reportType.id,
    reportName: reportType.name,
    source: "salesforce-live-reports",
    reportMonth,
    configuredReports: reportType.salesforceReports,
    rawTabs,
  };
}

module.exports = {
  buildFlatReportRows,
  buildDetailSoql,
  executeReport,
  executeReportForDateRange,
  executeReportWithDescribeMetadata,
  executeSavedReport,
  executeReportWithoutDateOverride,
  fetchDashboard,
  fetchDashboardResults,
  fetchAnalysisReportScfMetrics,
  fetchFlexibleSalesforceReportData,
  fetchFullFlatReportRows,
  fetchMonthlySalesforceReportData,
  fetchRawSalesforceReportRows,
  fetchReportDescribe,
  getConnectedSalesforceToken,
  getMonthDateRange,
  mapColumnLabels,
  normalizeLabel,
  parseDateValue,
  parseNumber,
  resolveAnalysisDateRange,
  runSoqlQuery,
  salesforceRequest,
};
