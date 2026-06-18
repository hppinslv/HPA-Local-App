const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadStateObject, queueStateSync } = require("./supabasePersistence");

const DATA_DIR = path.join(__dirname, "..", "data");
const GENERATED_DIR = path.join(os.tmpdir(), "hpa-mailing-data-artifacts");
const HISTORY_PATH = path.join(DATA_DIR, "mailing-data-history.json");
const HISTORY_SUPABASE_KEY = "mailing-data-history.json";
const TEMPLATE_PATH = path.join(__dirname, "..", "202606_Mailbag_HPA.AHAv2.xlsx");
const DEFAULT_START_CASE_NUMBER = 65782403;
const MAILING_DATA_COLUMNS = [
  "FIRST",
  "LAST",
  "ADDRESS",
  "CSZ",
  "CITY",
  "STATE",
  "ZIP",
  "Z4",
  "MRTG_AMT",
  "MRTG_LEND",
  "XDPBC",
  "REC_TYPE",
  "KEYCODE",
  "SRC",
  "MKEY",
  "CUSTKEY",
  "SEQUENCE",
  "CASENUM",
  "COVERAGE",
  "AMOUNT1",
  "AMOUNT2",
  "DMANID",
  "MAILDATE",
  "PrimaryKey",
  "CreationTimestamp",
  "CreatedBy",
  "ModificationTimestamp",
  "ModifiedBy",
  "Rate_1",
  "Rate_2",
  "Discount",
  "Dues",
  "Original_Lender",
  "Origma",
  "From_Mailing",
  "Mailing_Group",
  "Mail_Type",
  "SCF",
  "SCF_Count",
  "Notes",
];
const REQUIRED_SOURCE_HEADERS = [
  "FIRST_NAME",
  "LAST_NAME",
  "FULLADDRESS",
  "CITY_ST_ZIP_ZIP4",
  "CITY",
  "STATE",
  "ZIP",
  "ZIP4",
  "MRTG_AMT",
  "MRTG_LEND",
  "DPBC",
  "REC_TYPE",
];
const SOURCE_TO_OUTPUT = {
  FIRST_NAME: "FIRST",
  LAST_NAME: "LAST",
  FULLADDRESS: "ADDRESS",
  CITY_ST_ZIP_ZIP4: "CSZ",
  CITY: "CITY",
  STATE: "STATE",
  ZIP: "ZIP",
  ZIP4: "Z4",
  MRTG_AMT: "MRTG_AMT",
  MRTG_LEND: "MRTG_LEND",
  DPBC: "XDPBC",
  REC_TYPE: "REC_TYPE",
};
const COLUMN_LETTERS = MAILING_DATA_COLUMNS.map((_, index) => columnNumberToLetter(index + 1));

let historyCache = null;
let historyDiskWritable = true;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStorage() {
  ensureDir(DATA_DIR);
  ensureDir(GENERATED_DIR);
}

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return clone(fallbackValue);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runPowerShell(command, options = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 1024 * 1024 * 50,
      ...options,
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "PowerShell command failed.").trim());
  }
  return result.stdout;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeHeader(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function padNumber(value, size = 2) {
  return String(value).padStart(size, "0");
}

function formatMonthFilePrefix(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error("Mailing month must be in YYYY-MM format.");
  }
  return `${match[1]}${match[2]}`;
}

function formatMonthLabel(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(monthValue || "");
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

function buildMailDateIso(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error("Select a mailing month.");
  }
  return `${match[1]}-${match[2]}-24`;
}

function toExcelDateNumber(isoDate) {
  const utcMillis = Date.parse(`${isoDate}T00:00:00Z`);
  return Math.floor(utcMillis / 86400000) + 25569;
}

function columnNumberToLetter(value) {
  let number = Number(value || 0);
  let output = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    number = Math.floor((number - 1) / 26);
  }
  return output;
}

function fileNamePrefixKeyCode(fileName) {
  const base = path.basename(String(fileName || ""));
  const prefix = normalizeText(base.split("_")[0] || "").toUpperCase();
  return prefix;
}

function sortUploads(uploads) {
  const orderMap = new Map([
    ["NHCL", 0],
    ["RFC", 1],
  ]);
  return uploads
    .slice()
    .sort((left, right) => {
      const leftOrder = orderMap.has(left.keyCode) ? orderMap.get(left.keyCode) : 100 + left.originalIndex;
      const rightOrder = orderMap.has(right.keyCode) ? orderMap.get(right.keyCode) : 100 + right.originalIndex;
      return leftOrder - rightOrder;
    });
}

function parseWorksheetRows(sheetXml, sharedStrings) {
  const rows = {};
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellPattern = /<c\b[^>]*r="([A-Z]+)\d+"[^>]*(?:>([\s\S]*?)<\/c>|\/>)/g;
  let rowMatch = null;
  let maxRow = 0;

  while ((rowMatch = rowPattern.exec(sheetXml))) {
    const rowXml = rowMatch[1] || "";
    const cellMatches = rowXml.matchAll(cellPattern);
    for (const cellMatch of cellMatches) {
      const cellRef = cellMatch[0].match(/r="([A-Z]+)(\d+)"/);
      if (!cellRef) continue;
      const column = cellRef[1];
      const rowNumber = Number(cellRef[2]);
      const cellType = (cellMatch[0].match(/\bt="([^"]+)"/) || [])[1] || "";
      const cellBody = cellMatch[2] || "";
      const inlineMatch = cellBody.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const valueMatch = cellBody.match(/<v>([\s\S]*?)<\/v>/);
      let value = "";

      if (inlineMatch) {
        value = decodeXmlEntities(inlineMatch[1]);
      } else if (cellType === "s" && valueMatch) {
        value = sharedStrings[Number(valueMatch[1])] || "";
      } else if (valueMatch) {
        value = decodeXmlEntities(valueMatch[1]);
      }

      if (!rows[rowNumber]) {
        rows[rowNumber] = {};
      }
      rows[rowNumber][column] = String(value).trim();
      if (rowNumber > maxRow) {
        maxRow = rowNumber;
      }
    }
  }

  return Array.from({ length: maxRow }, (_, index) => ({
    index: index + 1,
    cells: rows[index + 1] || {},
  }));
}

function parseXlsxWorksheetsFromExtractedDir(extractDir) {
  const sharedStringsPath = path.join(extractDir, "xl", "sharedStrings.xml");
  const workbookPath = path.join(extractDir, "xl", "workbook.xml");
  const relsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
  const sharedStrings = fs.existsSync(sharedStringsPath)
    ? Array.from(
        fs.readFileSync(sharedStringsPath, "utf8").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g),
        (match) => decodeXmlEntities(match[1])
      )
    : [];
  const workbookXml = fs.readFileSync(workbookPath, "utf8");
  const relsXml = fs.readFileSync(relsPath, "utf8");
  const sheets = Array.from(
    workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g),
    (match) => ({ name: match[1], relId: match[2] })
  );

  return sheets
    .map((entry) => {
      const relMatch = relsXml.match(
        new RegExp(`<Relationship[^>]*Id="${escapeRegExp(entry.relId)}"[^>]*Target="([^"]+)"`)
      );
      if (!relMatch) return null;
      const worksheetPath = path.join(extractDir, "xl", relMatch[1].replace(/\//g, path.sep));
      if (!fs.existsSync(worksheetPath)) return null;
      return {
        name: entry.name,
        xml: fs.readFileSync(worksheetPath, "utf8"),
        path: worksheetPath,
        sharedStrings,
      };
    })
    .filter(Boolean);
}

function withExtractedZip(buffer, work) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-mailing-data-"));
  const zipPath = path.join(tempDir, "upload.zip");
  const extractDir = path.join(tempDir, "unzipped");
  fs.writeFileSync(zipPath, buffer);
  runPowerShell(`Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`);
  try {
    return work(extractDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractFirstWorkbookFromZip(buffer, fileName) {
  return withExtractedZip(buffer, (extractDir) => {
    const output = runPowerShell(
      `Get-ChildItem -LiteralPath '${extractDir.replace(/'/g, "''")}' -Recurse -File | Select-Object -ExpandProperty FullName`
    );
    const files = String(output || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry && [".xlsx", ".xlsm"].includes(path.extname(entry).toLowerCase()))
      .sort((left, right) => left.localeCompare(right));

    if (!files.length) {
      throw new Error(`The uploaded ZIP ${fileName} did not contain an .xlsx file.`);
    }

    const workbookPath = files[0];
    return {
      workbookPath,
      workbookFileName: path.basename(workbookPath),
      workbookBuffer: fs.readFileSync(workbookPath),
    };
  });
}

function worksheetRowsToObjects(worksheetRows) {
  const headerRow = worksheetRows.find((row) => Object.keys(row.cells || {}).length > 0);
  if (!headerRow) {
    return [];
  }

  const orderedColumns = Object.keys(headerRow.cells)
    .sort((left, right) => columnLetterToNumber(left) - columnLetterToNumber(right));
  const headers = orderedColumns.map((column) => normalizeHeader(headerRow.cells[column]));

  return worksheetRows
    .filter((row) => row.index > headerRow.index)
    .map((row) => {
      const objectRow = {};
      orderedColumns.forEach((column, index) => {
        objectRow[headers[index]] = normalizeText(row.cells[column] || "");
      });
      return objectRow;
    })
    .filter((row) => Object.values(row).some((value) => normalizeText(value)));
}

function columnLetterToNumber(value) {
  return [...String(value || "").toUpperCase()].reduce(
    (acc, char) => acc * 26 + (char.charCodeAt(0) - 64),
    0
  );
}

function validateSourceHeaders(headers, contextLabel) {
  const missing = REQUIRED_SOURCE_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`${contextLabel} is missing required header(s): ${missing.join(", ")}`);
  }
}

function normalizeUploadRequest(entry, index) {
  const fileName = normalizeText(entry?.fileName);
  const base64Content = normalizeText(entry?.base64Content);
  if (!fileName || !base64Content) {
    throw new Error(`Upload ${index + 1} is missing a file.`);
  }
  if (path.extname(fileName).toLowerCase() !== ".zip") {
    throw new Error(`${fileName} is not a ZIP file.`);
  }
  const keyCode = fileNamePrefixKeyCode(fileName);
  if (!keyCode) {
    throw new Error(`Unable to detect KEYCODE from ${fileName}.`);
  }
  return {
    fileName,
    base64Content,
    keyCode,
    originalIndex: index,
  };
}

function buildOutputFileName(mailingMonth) {
  return `${formatMonthFilePrefix(mailingMonth)}_Mailbag_HPA.AHAv2.xlsx`;
}

function computeNextCaseNumber(historyEntries) {
  const maxFromHistory = historyEntries.reduce((maxValue, entry) => {
    const candidate = integerOrNull(entry?.endingCaseNumber);
    return candidate && candidate > maxValue ? candidate : maxValue;
  }, DEFAULT_START_CASE_NUMBER - 1);
  return Math.max(DEFAULT_START_CASE_NUMBER, maxFromHistory + 1);
}

function readHistory() {
  if (Array.isArray(historyCache)) {
    return clone(historyCache);
  }
  const local = safeParseJson(HISTORY_PATH, []);
  historyCache = Array.isArray(local) ? local : [];
  return clone(historyCache);
}

function writeHistory(entries) {
  const payload = Array.isArray(entries) ? clone(entries) : [];
  historyCache = payload;
  try {
    ensureStorage();
    if (historyDiskWritable) {
      fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
    queueStateSync(HISTORY_SUPABASE_KEY, payload);
  } catch (error) {
    if (historyDiskWritable) {
      console.warn("Unable to persist Mailing Data history to disk, switching to in-memory mode:", error.message);
    }
    historyDiskWritable = false;
  }
}

async function initializeMailingDataPersistence() {
  ensureStorage();
  const localHistory = safeParseJson(HISTORY_PATH, []);
  const remoteHistory = await loadStateObject(HISTORY_SUPABASE_KEY, localHistory);
  historyCache = Array.isArray(remoteHistory) ? remoteHistory : Array.isArray(localHistory) ? localHistory : [];
  writeHistory(historyCache);
}

function listMailingDataHistory() {
  return readHistory()
    .slice()
    .sort((left, right) => (Date.parse(right.generatedAt || 0) || 0) - (Date.parse(left.generatedAt || 0) || 0));
}

function getMailingDataHistoryEntry(entryId) {
  return listMailingDataHistory().find((entry) => entry.id === entryId) || null;
}

function deleteMostRecentMailingDataRun(entryId) {
  const history = listMailingDataHistory();
  if (!history.length) {
    throw new Error("No Mailing Data history exists yet.");
  }

  const mostRecent = history[0];
  if (String(mostRecent.id || "") !== String(entryId || "")) {
    throw new Error("Only the most recent Mailing Data run can be deleted.");
  }

  const remaining = history.filter((entry) => String(entry.id || "") !== String(entryId || ""));
  if (mostRecent.outputFilePath && fs.existsSync(mostRecent.outputFilePath)) {
    try {
      fs.rmSync(mostRecent.outputFilePath, { force: true });
    } catch {
      // Ignore cleanup errors and still remove history.
    }
  }

  writeHistory(remaining);
  return {
    deletedEntry: mostRecent,
    history: listMailingDataHistory(),
    nextCaseNumber: computeNextCaseNumber(remaining),
  };
}

function getNextMailingCaseNumber() {
  return computeNextCaseNumber(readHistory());
}

function parseMailingWorkbook(buffer, fileName, keyCode) {
  const worksheets = withExtractedZip(buffer, (extractDir) => parseXlsxWorksheetsFromExtractedDir(extractDir));
  if (!worksheets.length) {
    throw new Error(`${fileName} did not contain a readable worksheet.`);
  }
  const worksheet = worksheets[0];
  const rows = worksheetRowsToObjects(parseWorksheetRows(worksheet.xml, worksheet.sharedStrings));
  const headers = Object.keys(rows[0] || {});
  validateSourceHeaders(headers, fileName);

  const filteredRows = rows.filter((row) => {
    return Object.values(SOURCE_TO_OUTPUT).some((_, index) => {
      const sourceHeader = Object.keys(SOURCE_TO_OUTPUT)[index];
      return normalizeText(row[sourceHeader]);
    });
  });

  if (!filteredRows.length) {
    throw new Error(`${fileName} did not contain any source rows.`);
  }

  return {
    keyCode,
    sourceWorkbookName: worksheet.name || "",
    recordCount: filteredRows.length,
    headers,
    rows: filteredRows,
  };
}

function parseMailingUpload(entry) {
  const zipBuffer = Buffer.from(entry.base64Content, "base64");
  const extracted = extractFirstWorkbookFromZip(zipBuffer, entry.fileName);
  const workbookData = parseMailingWorkbook(extracted.workbookBuffer, entry.fileName, entry.keyCode);
  return {
    ...entry,
    sourceWorkbookFileName: extracted.workbookFileName,
    ...workbookData,
  };
}

function buildPreviewFromParsedUploads(parsedUploads, options = {}) {
  const mailingMonth = normalizeText(options.mailingMonth);
  const startingCaseNumber = integerOrNull(options.startingCaseNumber);
  if (!mailingMonth) {
    throw new Error("Select a mailing month.");
  }
  if (!startingCaseNumber) {
    throw new Error("Starting case number must be numeric.");
  }

  const sortedUploads = sortUploads(parsedUploads);
  const mailDate = buildMailDateIso(mailingMonth);
  let sequenceCursor = 1;

  const uploads = sortedUploads.map((upload) => {
    const startingSequence = sequenceCursor;
    const endingSequence = sequenceCursor + upload.recordCount - 1;
    const startingCase = startingCaseNumber + startingSequence - 1;
    const endingCase = startingCaseNumber + endingSequence - 1;
    sequenceCursor = endingSequence + 1;
    return {
      fileName: upload.fileName,
      sourceWorkbookFileName: upload.sourceWorkbookFileName,
      keyCode: upload.keyCode,
      recordCount: upload.recordCount,
      startingSequence,
      endingSequence,
      startingCaseNumber: startingCase,
      endingCaseNumber: endingCase,
      mailDate,
    };
  });

  const totalRecords = uploads.reduce((sum, upload) => sum + Number(upload.recordCount || 0), 0);
  if (totalRecords <= 0) {
    throw new Error("Record count must be greater than 0.");
  }

  return {
    outputFileName: buildOutputFileName(mailingMonth),
    mailingMonth,
    mailingMonthLabel: formatMonthLabel(mailingMonth),
    mailDate,
    totalRecords,
    startingSequence: 1,
    endingSequence: totalRecords,
    startingCaseNumber,
    endingCaseNumber: startingCaseNumber + totalRecords - 1,
    uploads,
    progressSteps: [
      "Extracting zip",
      ...uploads.map((upload) => `Reading ${upload.keyCode}`),
      "Building workbook",
      "Saving output",
      "Complete",
    ],
  };
}

function buildMailingRow(row, keyCode, sequence, startingCaseNumber, mailDateIso) {
  const mortgageAmount = normalizeNumber(row.MRTG_AMT) || 0;
  const caseNumber = startingCaseNumber + sequence - 1;
  return {
    FIRST: normalizeText(row.FIRST_NAME),
    LAST: normalizeText(row.LAST_NAME),
    ADDRESS: normalizeText(row.FULLADDRESS),
    CSZ: normalizeText(row.CITY_ST_ZIP_ZIP4),
    CITY: normalizeText(row.CITY),
    STATE: normalizeText(row.STATE),
    ZIP: normalizeText(row.ZIP),
    Z4: normalizeText(row.ZIP4),
    MRTG_AMT: mortgageAmount,
    MRTG_LEND: normalizeText(row.MRTG_LEND),
    XDPBC: normalizeText(row.DPBC),
    REC_TYPE: normalizeText(row.REC_TYPE),
    KEYCODE: keyCode,
    SRC: "",
    MKEY: "",
    CUSTKEY: "",
    SEQUENCE: sequence,
    CASENUM: caseNumber,
    COVERAGE: (mortgageAmount + 3) * 1000,
    AMOUNT1: (mortgageAmount * 0.22) + 19.95,
    AMOUNT2: (mortgageAmount * 0.33) + 19.95,
    DMANID: "",
    MAILDATE: mailDateIso,
    PrimaryKey: "",
    CreationTimestamp: "",
    CreatedBy: "",
    ModificationTimestamp: "",
    ModifiedBy: "",
    Rate_1: 0.22,
    Rate_2: 0.33,
    Discount: 2,
    Dues: 19.95,
    Original_Lender: "",
    Origma: "",
    From_Mailing: "",
    Mailing_Group: "",
    Mail_Type: "",
    SCF: "",
    SCF_Count: "",
    Notes: "",
  };
}

function buildCombinedRows(parsedUploads, preview) {
  let sequence = 1;
  const combined = [];
  sortUploads(parsedUploads).forEach((upload) => {
    upload.rows.forEach((row) => {
      combined.push(buildMailingRow(row, upload.keyCode, sequence, preview.startingCaseNumber, preview.mailDate));
      sequence += 1;
    });
  });
  return combined;
}

function parseTemplateSheetMetadata(sheetXml) {
  const dimensionMatch = sheetXml.match(/<dimension ref="([^"]+)"/);
  const colsMatch = sheetXml.match(/<cols>[\s\S]*?<\/cols>/);
  const headerRowMatch = sheetXml.match(/<row[^>]*r="1"[^>]*>[\s\S]*?<\/row>/);
  const autoFilterMatch = sheetXml.match(/<autoFilter[^>]*ref="([^"]+)"/);
  const sheetViewsMatch = sheetXml.match(/<sheetViews>[\s\S]*?<\/sheetViews>/);
  const pageMarginsMatch = sheetXml.match(/<pageMargins[^>]*\/>/);
  const pageSetupMatch = sheetXml.match(/<pageSetup[^>]*\/>/);
  const headerFooterMatch = sheetXml.match(/<headerFooter[\s\S]*?<\/headerFooter>/);
  const phoneticPrMatch = sheetXml.match(/<phoneticPr[^>]*\/>/);
  const extLstMatch = sheetXml.match(/<extLst>[\s\S]*<\/extLst>/);
  const row2Match = sheetXml.match(/<row[^>]*r="2"[^>]*>[\s\S]*?<\/row>/);

  return {
    dimension: dimensionMatch ? dimensionMatch[1] : "A1:AN1",
    colsXml: colsMatch ? colsMatch[0] : "",
    headerRowXml: headerRowMatch ? headerRowMatch[0] : "",
    autoFilterRef: autoFilterMatch ? autoFilterMatch[1] : "A1:AN1",
    sheetViewsXml: sheetViewsMatch ? sheetViewsMatch[0] : "<sheetViews><sheetView workbookViewId=\"0\"/></sheetViews>",
    pageMarginsXml: pageMarginsMatch ? pageMarginsMatch[0] : "",
    pageSetupXml: pageSetupMatch ? pageSetupMatch[0] : "",
    headerFooterXml: headerFooterMatch ? headerFooterMatch[0] : "",
    phoneticPrXml: phoneticPrMatch ? phoneticPrMatch[0] : "",
    extLstXml: extLstMatch ? extLstMatch[0] : "",
    row2Xml: row2Match ? row2Match[0] : "",
  };
}

function parseRowStyleMap(rowXml) {
  const styles = {};
  const cellPattern = /<c\b[^>]*r="([A-Z]+)\d+"[^>]*(?:>([\s\S]*?)<\/c>|\/>)/g;
  for (const match of rowXml.matchAll(cellPattern)) {
    const styleId = (match[0].match(/\bs="(\d+)"/) || [])[1] || "";
    styles[match[1]] = styleId;
  }
  return styles;
}

function getTemplateCellStyleId(rowXml, reference) {
  const match = String(rowXml || "").match(
    new RegExp(`<c\\b[^>]*r="${escapeRegExp(reference)}"[^>]*\\bs="(\\d+)"`)
  );
  return match ? match[1] : "";
}

function buildCell(reference, value, options = {}) {
  const styleAttr = options.styleId !== undefined && options.styleId !== "" ? ` s="${options.styleId}"` : "";
  if (options.formula) {
    return `<c r="${reference}"${styleAttr}><f>${escapeXml(options.formula)}</f><v>${options.value}</v></c>`;
  }
  if (options.type === "inlineStr") {
    return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }
  if (options.type === "number") {
    return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
  }
  if (options.type === "date") {
    return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
  }
  if (options.blank && styleAttr) {
    return `<c r="${reference}"${styleAttr}/>`;
  }
  if (options.blank) {
    return `<c r="${reference}"/>`;
  }
  return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function buildDataRowXml(rowNumber, row, styleMap, mailDateNumber, overrides = {}) {
  const cells = [];
  const push = (column, value, options = {}) => {
    const reference = `${column}${rowNumber}`;
    const styleId = Object.prototype.hasOwnProperty.call(overrides, column)
      ? overrides[column]
      : styleMap[column];
    cells.push(buildCell(reference, value, { styleId, ...options }));
  };

  push("A", row.FIRST, { type: "inlineStr" });
  push("B", row.LAST, { type: "inlineStr" });
  push("C", row.ADDRESS, { type: "inlineStr" });
  push("D", row.CSZ, { type: "inlineStr" });
  push("E", row.CITY, { type: "inlineStr" });
  push("F", row.STATE, { type: "inlineStr" });
  push("G", row.ZIP === "" ? "" : row.ZIP, { type: "number" });
  push("H", row.Z4 === "" ? "" : row.Z4, { type: "number" });
  push("I", row.MRTG_AMT, { type: "number" });
  push("J", row.MRTG_LEND, { type: "inlineStr" });
  push("K", row.XDPBC === "" ? "" : row.XDPBC, { type: "number" });
  if (row.REC_TYPE) {
    push("L", row.REC_TYPE, { type: "inlineStr" });
  }
  push("M", row.KEYCODE, { type: "inlineStr" });
  push("N", "", { blank: true });
  if (styleMap.O !== undefined) push("O", "", { blank: true });
  push("P", "", { blank: true });
  push("Q", row.SEQUENCE, { type: "number" });
  push("R", row.CASENUM, { type: "number" });
  push("S", row.COVERAGE, { type: "number", formula: `(I${rowNumber}+3)*1000`, value: row.COVERAGE });
  push("T", row.AMOUNT1, { type: "number", formula: `(I${rowNumber}*0.22)+19.95`, value: row.AMOUNT1 });
  push("U", row.AMOUNT2, { type: "number", formula: `(0.33*I${rowNumber})+19.95`, value: row.AMOUNT2 });
  push("V", "", { blank: true });
  push("W", mailDateNumber, { type: "date" });
  push("X", "", { blank: true });
  push("Y", "", { blank: true });
  push("Z", "", { blank: true });
  push("AA", "", { blank: true });
  push("AB", "", { blank: true });
  push("AC", row.Rate_1, { type: "number" });
  push("AD", row.Rate_2, { type: "number" });
  push("AE", row.Discount, { type: "number" });
  push("AF", row.Dues, { type: "number" });
  if (styleMap.AG !== undefined) push("AG", "", { blank: true });
  push("AH", "", { blank: true });
  push("AI", "", { blank: true });
  push("AJ", "", { blank: true });
  push("AK", "", { blank: true });
  push("AL", "", { blank: true });
  if (styleMap.AM !== undefined) push("AM", "", { blank: true });
  if (styleMap.AN !== undefined) push("AN", "", { blank: true });

  return `<row r="${rowNumber}" spans="1:40" x14ac:dyDescent="0.2">${cells.join("")}</row>`;
}

function buildApplicationsSheetXml(templateSheetXml, rows, mailDateIso) {
  const metadata = parseTemplateSheetMetadata(templateSheetXml);
  const styleMap = parseRowStyleMap(metadata.row2Xml);
  const styleOverrides = {
    W: getTemplateCellStyleId(metadata.row2Xml, "W2") || styleMap.W || "",
  };
  const finalRow = Math.max(rows.length + 1, 1);
  const mailDateNumber = toExcelDateNumber(mailDateIso);
  const dataRows = rows
    .map((row, index) => buildDataRowXml(index + 2, row, styleMap, mailDateNumber, styleOverrides))
    .join("");
  const autoFilterEndRow = Math.max(rows.length + 1, 1);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac">\n  <dimension ref="A1:AN${finalRow}"/>\n  ${metadata.sheetViewsXml}\n  ${metadata.colsXml}\n  <sheetData>${metadata.headerRowXml}${dataRows}</sheetData>\n  <autoFilter ref="A1:AN${autoFilterEndRow}"/>\n  ${metadata.phoneticPrXml}\n  ${metadata.pageMarginsXml}\n  ${metadata.pageSetupXml}\n  ${metadata.headerFooterXml}\n  ${metadata.extLstXml}\n</worksheet>\n`;
}

function buildTemplateWorkbook(rows, outputPath, mailDateIso) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Mailing Data template not found: ${TEMPLATE_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-mailbag-build-"));
  const templateZipPath = path.join(tempDir, "template.zip");
  const extractDir = path.join(tempDir, "unzipped");
  const workingZipPath = path.join(tempDir, "output.zip");

  fs.copyFileSync(TEMPLATE_PATH, templateZipPath);
  runPowerShell(`Expand-Archive -LiteralPath '${templateZipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`);

  try {
    const sheetPath = path.join(extractDir, "xl", "worksheets", "sheet1.xml");
    const templateSheetXml = fs.readFileSync(sheetPath, "utf8");
    fs.writeFileSync(sheetPath, buildApplicationsSheetXml(templateSheetXml, rows, mailDateIso), "utf8");
    runPowerShell(`Compress-Archive -Path '${path.join(extractDir, "*").replace(/'/g, "''")}' -DestinationPath '${workingZipPath.replace(/'/g, "''")}' -Force`);
    fs.copyFileSync(workingZipPath, outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createHistoryEntry(preview, uploads, artifactPath) {
  const generatedAt = new Date().toISOString();
  const entryId = `mailing_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: entryId,
    outputFileName: preview.outputFileName,
    generatedAt,
    mailingMonth: preview.mailingMonth,
    mailingMonthLabel: preview.mailingMonthLabel,
    uploadedZipFileNames: uploads.map((upload) => upload.fileName),
    keyCodes: uploads.map((upload) => upload.keyCode),
    recordCountsByKeyCode: Object.fromEntries(uploads.map((upload) => [upload.keyCode, upload.recordCount])),
    totalRecords: preview.totalRecords,
    startingSequence: preview.startingSequence,
    endingSequence: preview.endingSequence,
    startingCaseNumber: preview.startingCaseNumber,
    endingCaseNumber: preview.endingCaseNumber,
    mailDate: preview.mailDate,
    outputFilePath: artifactPath,
    uploads: preview.uploads,
  };
}

function previewMailingData({ uploads = [], mailingMonth = "", startingCaseNumber = "" } = {}) {
  const normalizedUploads = sortUploads(uploads.map(normalizeUploadRequest));
  if (!normalizedUploads.length) {
    throw new Error("Upload at least one ZIP file.");
  }
  const parsedUploads = normalizedUploads.map(parseMailingUpload);
  return buildPreviewFromParsedUploads(parsedUploads, {
    mailingMonth,
    startingCaseNumber,
  });
}

function generateMailingDataWorkbook({ uploads = [], mailingMonth = "", startingCaseNumber = "" } = {}) {
  const normalizedUploads = sortUploads(uploads.map(normalizeUploadRequest));
  if (!normalizedUploads.length) {
    throw new Error("Upload at least one ZIP file.");
  }
  const parsedUploads = normalizedUploads.map(parseMailingUpload);
  const preview = buildPreviewFromParsedUploads(parsedUploads, {
    mailingMonth,
    startingCaseNumber,
  });
  const combinedRows = buildCombinedRows(parsedUploads, preview);
  if (combinedRows.length !== preview.totalRecords) {
    throw new Error(`Final record count mismatch. Expected ${preview.totalRecords}, got ${combinedRows.length}.`);
  }
  ensureStorage();
  const artifactPath = path.join(GENERATED_DIR, preview.outputFileName);
  buildTemplateWorkbook(combinedRows, artifactPath, preview.mailDate);
  const entry = createHistoryEntry(preview, parsedUploads, artifactPath);
  const history = readHistory();
  history.unshift(entry);
  writeHistory(history);
  return {
    historyEntry: entry,
    preview,
  };
}

function getMailingDataArtifact(entryId) {
  const entry = getMailingDataHistoryEntry(entryId);
  if (!entry) {
    throw new Error("Mailing Data history entry not found.");
  }
  if (!entry.outputFilePath || !fs.existsSync(entry.outputFilePath)) {
    throw new Error("Generated workbook file not found.");
  }
  return {
    filePath: entry.outputFilePath,
    fileName: entry.outputFileName || path.basename(entry.outputFilePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

module.exports = {
  REQUIRED_SOURCE_HEADERS,
  MAILING_DATA_COLUMNS,
  DEFAULT_START_CASE_NUMBER,
  initializeMailingDataPersistence,
  listMailingDataHistory,
  getMailingDataHistoryEntry,
  deleteMostRecentMailingDataRun,
  getMailingDataArtifact,
  getNextMailingCaseNumber,
  previewMailingData,
  generateMailingDataWorkbook,
};
