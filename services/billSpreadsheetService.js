const { fetchRawSalesforceReportRows, normalizeLabel } = require("./salesforceClient");

const BILLING_REPORTS = Object.freeze({
  bill1: "00O5G000008lBjuUAE",
  bill2: "00O5G000008lBllUAE",
  bill3: "00O5G000008lBlvUAE",
  bill4: "00O5G000008lBm0UAE",
});

const COMMON_HEADERS = Object.freeze([
  "Certificate Number: Certificate Name", "Member 1", "Member 2",
  "Certificate Number: Billing Street", "Certificate Number: Billing City",
  "Certificate Number: Billing State/Province", "Certificate Number: Billing Zip/Postal Code",
  "Bill For", "P1", "P2", "P3", "P6", "P12",
]);

const BILLING_HEADERS = Object.freeze({
  bill1: [...COMMON_HEADERS],
  bill2: [...COMMON_HEADERS, "Bill Due", "Bill 2 Next (+1)"],
  bill3: [...COMMON_HEADERS, "Bill For Long", "Bill Due", "Bill 3 Next (+1)", "Bill 3 Next (+2)", "Lapse"],
  bill4: [...COMMON_HEADERS, "Bill 4 Due", "Bill Due", "Bill For Long", "Coverage Production", "Rate Text"],
});

const FIELD_ALIASES = Object.freeze({
  "Certificate Number: Certificate Name": ["Certificate Number: Certificate Name", "Certificate Name", "Certificate Number", "Policy Name"],
  "Member 1": ["Member 1"], "Member 2": ["Member 2"],
  "Certificate Number: Billing Street": ["Certificate Number: Billing Street", "Billing Street"],
  "Certificate Number: Billing City": ["Certificate Number: Billing City", "Billing City"],
  "Certificate Number: Billing State/Province": ["Certificate Number: Billing State/Province", "Billing State/Province", "Billing State"],
  "Certificate Number: Billing Zip/Postal Code": ["Certificate Number: Billing Zip/Postal Code", "Billing Zip/Postal Code", "Billing Postal Code"],
  "Bill For": ["Bill For"], P1: ["P1"], P2: ["P2"], P3: ["P3"], P6: ["P6"], P12: ["P12"],
  "Bill Due": ["Bill Due"], "Bill 2 Next (+1)": ["Bill 2 Next (+1)", "Bill 2 Next 1"],
  "Bill For Long": ["Bill For Long"], "Bill 3 Next (+1)": ["Bill 3 Next (+1)", "Bill 3 Next 1"],
  "Bill 3 Next (+2)": ["Bill 3 Next (+2)", "Bill 3 Next 2"], Lapse: ["Lapse"],
  "Bill 4 Due": ["Bill 4 Due"], "Coverage Production": ["Coverage Production"], "Rate Text": ["Rate Text"],
});

function firstValue(row, labels) {
  for (const label of labels) {
    const key = normalizeLabel(label);
    const candidate = row?.[key] ?? row?.[`${key} label`];
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") return candidate;
  }
  return "";
}

function parseCertificate(value) {
  const original = String(value ?? "").trim();
  if (!/^\d+$/.test(original)) throw new Error(`Certificate number is missing or nonnumeric: ${original || "blank"}.`);
  return { original, numeric: BigInt(original) };
}

function recordIdFromRow(row) {
  return String(firstValue(row, ["Policy ID", "Record ID", "Id", "Certificate Number ID", "Certificate ID"])).trim();
}

function isNumericAmount(input) {
  if (input === null || input === undefined || String(input).trim() === "") return false;
  const parsed = Number(String(input).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(parsed) && parsed >= 0;
}

function isReadableDate(input) {
  const text = String(input ?? "").trim();
  return Boolean(text) && Number.isFinite(Date.parse(text.replace(/,\s*(\d{4})$/, " $1")));
}

function mapBillingRow(group, row) {
  const headers = BILLING_HEADERS[group];
  if (!headers) throw new Error(`Unknown billing group ${group}.`);
  const values = Object.fromEntries(headers.map((header) => [header, firstValue(row, FIELD_ALIASES[header] || [header])]));
  const certificate = parseCertificate(values["Certificate Number: Certificate Name"]);
  const errors = [];
  if (!recordIdFromRow(row)) errors.push("Salesforce record ID is missing.");
  for (const header of [
    "Member 1", "Certificate Number: Billing Street", "Certificate Number: Billing City",
    "Certificate Number: Billing State/Province", "Certificate Number: Billing Zip/Postal Code", "Bill For",
  ]) if (String(values[header] ?? "").trim() === "") errors.push(`${header} is missing.`);
  for (const header of ["P1", "P2", "P3", "P6", "P12"]) {
    if (!isNumericAmount(values[header])) errors.push(`${header} is missing or nonnumeric.`);
  }
  const requiredByGroup = {
    bill1: [],
    bill2: ["Bill Due", "Bill 2 Next (+1)"],
    bill3: ["Bill For Long", "Bill Due", "Bill 3 Next (+1)", "Bill 3 Next (+2)", "Lapse"],
    bill4: ["Bill 4 Due", "Bill Due", "Bill For Long", "Coverage Production", "Rate Text"],
  };
  for (const header of requiredByGroup[group]) if (String(values[header] ?? "").trim() === "") errors.push(`${header} is missing.`);
  const dateFieldsByGroup = {
    bill1: [], bill2: ["Bill Due", "Bill 2 Next (+1)"],
    bill3: ["Bill Due", "Bill 3 Next (+1)", "Bill 3 Next (+2)", "Lapse"],
    bill4: ["Bill 4 Due", "Bill Due"],
  };
  for (const header of dateFieldsByGroup[group]) if (values[header] !== "" && !isReadableDate(values[header])) errors.push(`${header} is not a readable date.`);
  if (group === "bill4" && !isNumericAmount(values["Coverage Production"])) errors.push("Coverage Production is nonnumeric.");
  return {
    group,
    recordId: recordIdFromRow(row),
    certificateNumber: certificate.original,
    certificateNumeric: certificate.numeric.toString(),
    values,
    errors,
  };
}

function compareBillingRows(a, b) {
  const aNumber = BigInt(a.certificateNumeric);
  const bNumber = BigInt(b.certificateNumeric);
  if (aNumber < bNumber) return -1;
  if (aNumber > bNumber) return 1;
  return String(a.recordId || "").localeCompare(String(b.recordId || ""));
}

function sortAndValidateRows(group, reportRows) {
  const rows = [];
  const errors = [];
  for (const [index, source] of (reportRows || []).entries()) {
    try { rows.push(mapBillingRow(group, source)); }
    catch (error) { errors.push({ group, sourceRow: index + 1, error: error.message || String(error) }); }
  }
  rows.sort(compareBillingRows);
  const certificateCounts = new Map();
  for (const row of rows) certificateCounts.set(row.certificateNumeric, (certificateCounts.get(row.certificateNumeric) || 0) + 1);
  for (const row of rows) {
    if ((certificateCounts.get(row.certificateNumeric) || 0) > 1) errors.push({ group, certificateNumber: row.certificateNumber, recordId: row.recordId, error: "Duplicate certificate number." });
    row.errors.forEach((error) => errors.push({ group, certificateNumber: row.certificateNumber, recordId: row.recordId, error }));
  }
  return { rows, errors, sortingVerified: rows.every((row, index) => index === 0 || compareBillingRows(rows[index - 1], row) <= 0) };
}

async function retrieveBillingReports(dependencies = {}) {
  const fetchReport = dependencies.fetchReport || fetchRawSalesforceReportRows;
  const datasets = {};
  for (const [group, reportId] of Object.entries(BILLING_REPORTS)) {
    const report = await fetchReport(reportId, { failOnTruncatedReport: true });
    const processed = sortAndValidateRows(group, report.rows || []);
    datasets[group] = { reportId, reportName: report.reportName || reportId, retrievedAt: new Date().toISOString(), sourceCount: (report.rows || []).length, ...processed };
  }
  return datasets;
}

function sequenceKeys(rows) { return (rows || []).map((row) => `${row.certificateNumeric}|${row.recordId}`); }

function validateBill4Pairing(invoiceRows, noticeRows) {
  const invoiceKeys = sequenceKeys(invoiceRows);
  const noticeKeys = sequenceKeys(noticeRows);
  const errors = [];
  if (invoiceKeys.length !== noticeKeys.length) errors.push(`Bill 4 invoice count ${invoiceKeys.length} does not match notice count ${noticeKeys.length}.`);
  const length = Math.max(invoiceKeys.length, noticeKeys.length);
  for (let index = 0; index < length; index += 1) {
    if (invoiceKeys[index] !== noticeKeys[index]) errors.push(`Bill 4 sequence mismatch at position ${index + 1}.`);
  }
  return { valid: errors.length === 0, invoiceCount: invoiceKeys.length, noticeCount: noticeKeys.length, invoiceKeys, noticeKeys, errors };
}

module.exports = { BILLING_HEADERS, BILLING_REPORTS, compareBillingRows, isNumericAmount, isReadableDate, mapBillingRow, parseCertificate, retrieveBillingReports, sortAndValidateRows, validateBill4Pairing };
