const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PDFParse } = require("pdf-parse");
const {
  applyBill2Corrections,
  applyBill4Corrections,
  pullBill2Corrections,
  pullBill4Corrections,
  summarizeCorrectionResults,
} = require("./billCorrectionServiceV2");
const { retrieveBillingReports, validateBill4Pairing } = require("./billSpreadsheetService");

const BILL_OUTPUT_ROOT = process.env.HPA_BILL_OUTPUT_DIR
  ? path.resolve(process.env.HPA_BILL_OUTPUT_DIR)
  : path.join(__dirname, "..", "generated-reports", "bills");

function writesEnabled() {
  return String(process.env.HPA_BILLING_SALESFORCE_WRITES_ENABLED || "").trim().toLowerCase() === "true";
}

const BILL_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function reportDateParts(input) {
  const normalized = String(input ?? "").trim().replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const day = date.getDate();
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  return {
    iso: `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    display: `${BILL_MONTH_NAMES[monthIndex]} ${day}, ${year}`,
    ordinalDisplay: `${BILL_MONTH_NAMES[monthIndex]} ${day}${suffix}, ${year}`,
  };
}

function resolveAuthoritativeBill3Lapse(rows = []) {
  const resolved = rows.map((row) => reportDateParts(row.values?.Lapse)).filter(Boolean);
  const unique = new Map(resolved.map((entry) => [entry.iso, entry]));
  if (unique.size > 1) {
    return { value: null, error: `Bill 3 report contains ${unique.size} different Lapse dates; one authoritative general-notice date is required.` };
  }
  return { value: unique.values().next().value || null, error: "" };
}

function requireWritesEnabled() {
  if (!writesEnabled()) throw new Error("Salesforce billing writes are disabled for this deployment. Set HPA_BILLING_SALESFORCE_WRITES_ENABLED=true only after approved testing.");
}

async function runCorrections(options = {}) {
  requireWritesEnabled();
  const progress = options.progress || (async () => {});
  await progress("Retrieving correction reports");
  const [bill2Pull, bill4Pull] = await Promise.all([
    pullBill2Corrections(options.billMonth, options.dependencies),
    pullBill4Corrections(options.billMonth, options.dependencies),
  ]);
  await progress("Correcting Bill 2");
  const bill2 = await applyBill2Corrections(bill2Pull.rows, options.dependencies);
  await progress("Correcting Bill 4");
  const bill4 = await applyBill4Corrections(bill4Pull.rows, options.dependencies);
  await progress("Verifying Salesforce");
  const summary = summarizeCorrectionResults(bill2, bill4);
  return { bill2Pull, bill4Pull, bill2, bill4, summary };
}

function safeRunFolderName(run) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${String(run.runCode || run.id || "billing-run").replace(/[^A-Za-z0-9_-]/g, "_")}-${stamp}-${String(run.id || "").slice(-8)}`;
}

function runOfficeGenerator(payload) {
  fs.mkdirSync(BILL_OUTPUT_ROOT, { recursive: true });
  const outputDir = path.join(BILL_OUTPUT_ROOT, safeRunFolderName(payload.run));
  fs.mkdirSync(outputDir, { recursive: false });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-billing-payload-"));
  const payloadPath = path.join(tempDir, "payload.json");
  fs.writeFileSync(payloadPath, JSON.stringify({ ...payload, outputDir }, null, 2), "utf8");
  try {
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "..", "scripts", "generate-billing-package.ps1"), "-PayloadPath", payloadPath],
      { encoding: "utf8", windowsHide: true, timeout: 45 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Billing document generation failed.");
    const resultPath = path.join(outputDir, "generation-result.json");
    if (!fs.existsSync(resultPath)) throw new Error("Billing document generation did not return a result manifest.");
    return JSON.parse(fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function readPdf(filePath) {
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try { return await parser.getText(); }
  finally { await parser.destroy(); }
}

async function validateGeneratedBillingPdfs(generated, datasets) {
  const errors = [];
  const details = {};
  const specs = [
    ["_Bill1.pdf", "bill1", datasets.bill1.rows], ["_Bill2.pdf", "bill2", datasets.bill2.rows],
    ["_Bill3.pdf", "bill3", datasets.bill3.rows], ["_Bill4.pdf", "bill4", datasets.bill4.rows],
    ["_Bill3_Letter.pdf", "bill3Notices", datasets.bill3.rows],
    ["_Bill4_Letter.pdf", "bill4Notices", datasets.bill4.rows],
  ];
  const commonFields = ["Member 1", "Member 2", "Certificate Number: Billing Street", "Certificate Number: Billing City", "Certificate Number: Billing State/Province", "Certificate Number: Billing Zip/Postal Code"];
  function valueVariants(value) {
    const raw = String(value ?? "").trim();
    const variants = new Set([raw, raw.replace(/,/g, "")]);
    const numeric = Number(raw.replace(/[$,\s]/g, ""));
    if (raw && Number.isFinite(numeric)) {
      variants.add(numeric.toFixed(2));
      variants.add(numeric.toLocaleString("en-US"));
      variants.add(numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
    const timestamp = Date.parse(raw);
    if (raw && Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      variants.add(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(date));
      variants.add(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "numeric", day: "numeric", year: "numeric" }).format(date));
    }
    return [...variants].filter(Boolean).map((item) => item.replace(/\s+/g, " ").toLowerCase());
  }
  function pageHasValue(pageText, value) {
    const normalized = String(pageText || "").replace(/[$,]/g, "").replace(/\s+/g, " ").toLowerCase();
    return valueVariants(value).some((variant) => normalized.includes(variant.replace(/[$,]/g, "")));
  }
  for (const [suffix, key, rows] of specs) {
    const artifact = (generated.artifacts || []).find((item) => item.kind !== "summary" && String(item.fileName || "").endsWith(suffix));
    if (!artifact) { errors.push(`${key} PDF is missing.`); continue; }
    const parsed = await readPdf(path.join(generated.outputDirectory, artifact.fileName));
    const text = parsed.text || "";
    const pages = Number(parsed.total || parsed.pages?.length || 0);
    const expectedPages = rows.length || 1;
    if (pages !== expectedPages) errors.push(`${artifact.fileName} has ${pages} page(s); expected exactly ${expectedPages}.`);
    if (key !== "bill3Notices") {
      let priorPosition = -1;
      for (const [rowIndex, row] of rows.entries()) {
        const certificate = String(row.certificateNumber || "");
        const position = text.indexOf(certificate, priorPosition + 1);
        if (position < 0) errors.push(`${artifact.fileName} is missing certificate ${certificate}.`);
        else if (position < priorPosition) errors.push(`${artifact.fileName} certificate order is invalid at ${certificate}.`);
        priorPosition = Math.max(priorPosition, position);
        const member = String(row.values?.["Member 1"] || "").trim();
        if (member && !text.includes(member)) errors.push(`${artifact.fileName} is missing member ${member} for certificate ${certificate}.`);
        const pageText = parsed.pages?.[rowIndex]?.text || text;
        const group = key.replace("Notices", "");
        const expectedFields = key === "bill4Notices"
          ? [...commonFields, "P1", "Coverage Production", "Rate Text", "Bill For Long"]
          : [...commonFields, ...(group === "bill4" ? [] : ["Bill For"]), "P1", "P2", "P3", "P6", "P12", ...({
            bill1: [], bill2: ["Bill Due", "Bill 2 Next (+1)"],
            bill3: ["Bill For Long", "Bill Due", "Bill 3 Next (+1)", "Bill 3 Next (+2)", "Lapse"],
            bill4: ["Bill 4 Due", "Bill Due", "Bill For Long", "Coverage Production", "Rate Text"],
          }[group] || [])];
        for (const field of expectedFields) {
          const expected = row.values?.[field];
          if (expected !== "" && expected !== null && expected !== undefined && !pageHasValue(pageText, expected)) errors.push(`${artifact.fileName} page ${rowIndex + 1} is missing ${field} for certificate ${certificate}.`);
        }
      }
    } else if (Array.isArray(parsed.pages) && parsed.pages.length > 1) {
      const normalizedPages = parsed.pages.map((page) => String(page.text || "").replace(/\s+/g, " ").trim());
      if (normalizedPages.some((page) => page !== normalizedPages[0])) errors.push(`${artifact.fileName} notice pages are not identical.`);
    }
    details[key] = { fileName: artifact.fileName, pages, expectedPages };
  }
  return { valid: errors.length === 0, errors, details };
}

async function runMonthlyBilling(run, options = {}) {
  const progress = options.progress || (async () => {});
  const corrections = await runCorrections({ ...options, billMonth: run.billMonth, progress });
  if (!corrections.summary.complete) {
    const error = new Error(`${corrections.summary.failed} correction record(s) failed verification. Billing reports were not generated.`);
    error.code = "correction_verification_failed";
    error.corrections = corrections;
    throw error;
  }
  await progress("Retrieving billing reports");
  const datasets = await retrieveBillingReports(options.dependencies);
  await progress("Sorting certificates");
  const dataErrors = Object.values(datasets).flatMap((dataset) => dataset.errors || []);
  const authoritativeBill3Lapse = resolveAuthoritativeBill3Lapse(datasets.bill3.rows);
  if (authoritativeBill3Lapse.error) dataErrors.push({ group: "bill3", error: authoritativeBill3Lapse.error });
  if (dataErrors.length) {
    const error = new Error(`${dataErrors.length} billing data exception(s) must be corrected before document generation.`);
    error.code = "billing_data_validation_failed";
    error.dataErrors = dataErrors;
    error.corrections = corrections;
    error.datasets = datasets;
    throw error;
  }
  const bill4Pairing = validateBill4Pairing(datasets.bill4.rows, datasets.bill4.rows);
  if (!bill4Pairing.valid) throw new Error(bill4Pairing.errors.join(" "));
  const effectiveDates = authoritativeBill3Lapse.value
    ? {
        ...(run.dates || {}),
        bill3LapseDeadline: authoritativeBill3Lapse.value.iso,
        bill3LapseDeadlineDisplay: authoritativeBill3Lapse.value.display,
        bill3LapseDeadlineOrdinalDisplay: authoritativeBill3Lapse.value.ordinalDisplay,
      }
    : { ...(run.dates || {}) };
  const effectiveRun = { ...run, dates: effectiveDates };
  await progress("Generating invoices");
  const generator = options.generatePackage || runOfficeGenerator;
  const generated = generator({ run: effectiveRun, corrections, datasets, bill4Pairing });
  await progress("Generating notices");
  await progress("Validating PDFs");
  const pdfValidation = options.validatePdfs === false
    ? { valid: true, errors: [], details: {} }
    : await validateGeneratedBillingPdfs(generated, datasets);
  generated.pdfValidation = pdfValidation;
  if (!generated.valid || !pdfValidation.valid) {
    const error = new Error([...(generated.errors || []), ...pdfValidation.errors].join(" ") || "Generated billing package validation failed.");
    error.code = "pdf_validation_failed";
    error.generated = generated;
    error.datasets = datasets;
    error.pdfValidation = pdfValidation;
    throw error;
  }
  await progress("Ready to Download");
  return { corrections, datasets, bill4Pairing, generated, effectiveDates };
}

function getBillingArtifactPath(run, fileName) {
  const outputDir = path.resolve(String(run.outputDirectory || ""));
  const root = path.resolve(BILL_OUTPUT_ROOT);
  const candidate = path.resolve(outputDir, path.basename(String(fileName || "")));
  if (!outputDir.startsWith(`${root}${path.sep}`) || !candidate.startsWith(`${outputDir}${path.sep}`) || !fs.existsSync(candidate)) throw new Error("Billing artifact not found.");
  return candidate;
}

function writeBillingExceptionReport(run, error) {
  fs.mkdirSync(BILL_OUTPUT_ROOT, { recursive: true });
  const failedOutputDirectory = error.generated?.outputDirectory;
  const outputDirectory = failedOutputDirectory && fs.existsSync(failedOutputDirectory)
    ? failedOutputDirectory
    : run.outputDirectory && fs.existsSync(run.outputDirectory)
      ? run.outputDirectory
    : path.join(BILL_OUTPUT_ROOT, safeRunFolderName(run));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const fileName = `Billing_Exceptions_${run.billMonth}.json`;
  const payload = {
    runId: run.id, runCode: run.runCode, billingMonth: run.billMonth,
    recordedAt: new Date().toISOString(), code: error.code || "workflow_error",
    error: error.message || String(error),
    correctionSummary: error.corrections?.summary || null,
    bill2Corrections: error.corrections?.bill2 || [],
    bill4Corrections: error.corrections?.bill4 || [],
    dataErrors: error.dataErrors || [],
    pdfValidation: error.pdfValidation || null,
    generatedArtifacts: error.generated?.artifacts || [],
  };
  fs.writeFileSync(path.join(outputDirectory, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outputDirectory, artifact: { fileName, kind: "exception", contentType: "application/json" } };
}

module.exports = { BILL_OUTPUT_ROOT, getBillingArtifactPath, requireWritesEnabled, runCorrections, runMonthlyBilling, runOfficeGenerator, validateGeneratedBillingPdfs, writeBillingExceptionReport, writesEnabled };
