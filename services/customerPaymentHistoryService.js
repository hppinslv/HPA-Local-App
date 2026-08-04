const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getConnectedSalesforceToken, fetchReportDescribe, salesforceRequest } = require("./salesforceClient");

const PAYMENT_REPORT_ID = "00Of40000083rUIEAY";
const CREDIT_REPORT_ID = "00Of4000008Ds2PEAS";
const TEMPLATE_PATH = process.env.CUSTOMER_PAYMENT_HISTORY_TEMPLATE_PATH ||
  "C:\\Users\\MelindaH\\OneDrive - Home Protection Plan\\Desktop\\Customer Payment History In with Check Numbers.xlsx";

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function runPowerShell(command) {
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Workbook packaging failed.");
}
function textCell(ref, style, value) { return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`; }
function numCell(ref, style, value) { return `<c r="${ref}" s="${style}"><v>${Number(value || 0)}</v></c>`; }
function dateSerial(value) { return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000) + 25569; }
function amount(cell) { return Number(cell?.value?.amount ?? cell?.value ?? 0) || 0; }

async function salesforceJson(token, requestPath, options = {}) {
  const response = await salesforceRequest(token, requestPath, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.[0]?.message || payload?.message || "Salesforce request failed.");
  return payload;
}
async function findCertificate(token, certificateNumber) {
  const safe = String(certificateNumber).trim().replaceAll("'", "\\'");
  const soql = `SELECT Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode FROM Account WHERE Name = '${safe}' LIMIT 2`;
  const data = await salesforceJson(token, `/services/data/v61.0/query?q=${encodeURIComponent(soql)}`);
  if (data.totalSize !== 1) throw new Error(data.totalSize ? `More than one certificate matched ${certificateNumber}.` : `Certificate ${certificateNumber} was not found.`);
  return data.records[0];
}
async function runReport(token, reportId, accountId) {
  const describe = await fetchReportDescribe(token, reportId);
  const metadata = JSON.parse(JSON.stringify(describe.reportMetadata));
  metadata.reportFilters = (metadata.reportFilters || []).map((filter) => ({ ...filter, value: accountId }));
  const payload = await salesforceJson(token, `/services/data/v61.0/analytics/reports/${reportId}?includeDetails=true`, {
    method: "POST", body: JSON.stringify({ reportMetadata: metadata }),
  });
  return payload.factMap?.["T!T"]?.rows || [];
}
function buildSheetData(certificate, payments, credits) {
  const transactions = [
    ...payments.map((row) => ({ date: row.dataCells[1]?.value, amount: amount(row.dataCells[2]), check: row.dataCells[5]?.label || "" })),
    ...credits.map((row) => ({ date: row.dataCells[1]?.value, amount: -amount(row.dataCells[2]), check: "" })),
  ].filter((row) => row.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const paymentTotal = payments.reduce((sum, row) => sum + amount(row.dataCells[2]), 0);
  const creditTotal = credits.reduce((sum, row) => sum + amount(row.dataCells[2]), 0);
  const address = [certificate.BillingStreet, [certificate.BillingCity, certificate.BillingState].filter(Boolean).join(", "), certificate.BillingPostalCode].filter(Boolean).join(", ").replace(", ", ", ");
  const rows = [
    `<row r="9">${textCell("B9",24,"Customer Payment History")}${textCell("C9",25,"")}</row>`,
    `<row r="11">${textCell("B11",14,"Certificate Number:   ")}${textCell("C11",29,certificate.Name)}</row>`,
    `<row r="13">${textCell("B13",23,"")}</row>`,
    `<row r="14">${textCell("B14",25,address)}${textCell("C14",25,"")}</row>`,
    `<row r="16">${textCell("B16",20,"Total Payments")}${numCell("C16",17,paymentTotal)}</row>`,
    `<row r="17">${textCell("B17",21,"Total Credits")}${numCell("C17",18,-creditTotal)}</row>`,
    `<row r="18">${textCell("B18",22,"Total Payments Less Credits")}${numCell("C18",19,paymentTotal-creditTotal)}</row>`,
    `<row r="20">${textCell("B20",15,"Date Received or Credited")}${textCell("C20",16,"Amount Received or Credited")}${textCell("D20",28,"Check Number")}</row>`,
  ];
  transactions.forEach((row, index) => {
    const r = index + 21;
    rows.push(`<row r="${r}">${numCell(`B${r}`,6,dateSerial(row.date))}${numCell(`C${r}`,7,row.amount)}${textCell(`D${r}`,0,row.check)}</row>`);
  });
  return rows.join("");
}
async function buildCustomerPaymentHistory(certificateNumber) {
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error(`Payment history template was not found: ${TEMPLATE_PATH}`);
  const token = await getConnectedSalesforceToken();
  const certificate = await findCertificate(token, certificateNumber);
  const [payments, credits] = await Promise.all([runReport(token, PAYMENT_REPORT_ID, certificate.Id), runReport(token, CREDIT_REPORT_ID, certificate.Id)]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-payment-history-"));
  try {
    const templateZip = path.join(tempDir, "template.zip"), extracted = path.join(tempDir, "xlsx"), outputZip = path.join(tempDir, "output.zip");
    fs.copyFileSync(TEMPLATE_PATH, templateZip);
    runPowerShell(`Expand-Archive -LiteralPath '${templateZip}' -DestinationPath '${extracted}' -Force`);
    const sheetPath = path.join(extracted, "xl", "worksheets", "sheet4.xml");
    const workbookRelsPath = path.join(extracted, "xl", "_rels", "workbook.xml.rels");
    const contentTypesPath = path.join(extracted, "[Content_Types].xml");
    const calcChainPath = path.join(extracted, "xl", "calcChain.xml");
    const existing = fs.readFileSync(sheetPath, "utf8");
    const xml = existing.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${buildSheetData(certificate, payments, credits)}</sheetData>`)
      .replace(/ref="B1:D3506"/, `ref="B9:D${Math.max(21, payments.length + credits.length + 20)}"`);
    fs.writeFileSync(sheetPath, xml, "utf8");
    // The template's calculation chain references formulas that are replaced by values.
    // Leaving it behind makes Excel offer a repair dialog when opening the new workbook.
    if (fs.existsSync(workbookRelsPath)) {
      fs.writeFileSync(workbookRelsPath, fs.readFileSync(workbookRelsPath, "utf8")
        .replace(/<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/calcChain"[^>]*\/>/g, ""), "utf8");
    }
    if (fs.existsSync(contentTypesPath)) {
      fs.writeFileSync(contentTypesPath, fs.readFileSync(contentTypesPath, "utf8")
        .replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ""), "utf8");
    }
    if (fs.existsSync(calcChainPath)) fs.rmSync(calcChainPath, { force: true });
    runPowerShell(`Compress-Archive -Path '${path.join(extracted, "*")}' -DestinationPath '${outputZip}' -Force`);
    const dateStamp = new Date().toISOString().slice(0, 10);
    return { fileName: `${certificate.Name} - Customer Payment History - ${dateStamp}.xlsx`, buffer: fs.readFileSync(outputZip) };
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
module.exports = { buildCustomerPaymentHistory };
