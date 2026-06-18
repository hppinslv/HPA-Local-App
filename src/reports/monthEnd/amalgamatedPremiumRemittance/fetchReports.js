const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  fetchFullFlatReportRows,
  getConnectedSalesforceToken,
  normalizeLabel,
} = require("../../../../services/salesforceClient");
const { SALESFORCE_REPORTS, SOURCE_FILE_FIELDS, SOURCE_KEYS } = require("./config");
const { resolveCertificateNumber } = require("./normalize");

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

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readXlsxRows(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-amalgamated-upload-"));
  const zipPath = path.join(tempDir, "upload.zip");
  const extractDir = path.join(tempDir, "unzipped");

  fs.writeFileSync(zipPath, buffer);
  runPowerShell(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`);

  try {
    const workbookXml = fs.readFileSync(path.join(extractDir, "xl", "workbook.xml"), "utf8");
    const relsXml = fs.readFileSync(path.join(extractDir, "xl", "_rels", "workbook.xml.rels"), "utf8");
    const sharedStringsPath = path.join(extractDir, "xl", "sharedStrings.xml");
    const sharedStrings = fs.existsSync(sharedStringsPath)
      ? Array.from(
          fs.readFileSync(sharedStringsPath, "utf8").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g),
          (match) => decodeXmlEntities(match[1])
        )
      : [];
    const firstSheetId = workbookXml.match(/<sheet[^>]*r:id="([^"]+)"/)?.[1];

    if (!firstSheetId) {
      return [];
    }

    const target = relsXml.match(new RegExp(`<Relationship[^>]*Id="${firstSheetId}"[^>]*Target="([^"]+)"`))?.[1];
    if (!target) {
      return [];
    }

    const worksheetXml = fs.readFileSync(
      path.join(extractDir, "xl", target.replace(/\//g, path.sep)),
      "utf8"
    );
    return worksheetXmlToRows(worksheetXml, sharedStrings);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function columnToNumber(reference) {
  return reference.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function worksheetXmlToRows(sheetXml, sharedStrings) {
  const rowMatches = Array.from(sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g));
  const grid = rowMatches.map((rowMatch) => {
    const rowCells = [];

    Array.from(rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)).forEach((cellMatch) => {
      const attributes = cellMatch[1] || cellMatch[3] || "";
      const body = cellMatch[2] || "";
      const reference = attributes.match(/r="([A-Z]+)\d+"/)?.[1];
      const type = attributes.match(/t="([^"]+)"/)?.[1] || "";
      const colIndex = reference ? columnToNumber(reference) - 1 : rowCells.length;
      let value = "";

      const inlineMatch = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);

      if (inlineMatch) {
        value = decodeXmlEntities(inlineMatch[1]);
      } else if (type === "s" && valueMatch) {
        value = sharedStrings[Number(valueMatch[1])] || "";
      } else if (valueMatch) {
        value = decodeXmlEntities(valueMatch[1]);
      }

      rowCells[colIndex] = value;
    });

    return rowCells;
  });

  return tabularRowsToObjects(grid);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function tabularRowsToObjects(rows) {
  const firstDataRowIndex = rows.findIndex((row) => row.some((cell) => String(cell || "").trim() !== ""));
  if (firstDataRowIndex === -1) {
    return [];
  }

  const headers = rows[firstDataRowIndex].map((cell, index) => {
    const label = String(cell || "").trim();
    return label || `Column ${index + 1}`;
  });

  return rows
    .slice(firstDataRowIndex + 1)
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
    .map((row) => {
      const entry = {};
      headers.forEach((header, index) => {
        entry[header] = row[index] ?? "";
        entry[normalizeLabel(header)] = row[index] ?? "";
      });
      return entry;
    });
}

function readCsvRows(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return tabularRowsToObjects(lines.map(parseCsvLine));
}

function parseUploadedRows(fileName, base64Content) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const buffer = Buffer.from(String(base64Content || ""), "base64");

  if (extension === ".csv" || extension === ".txt") {
    return readCsvRows(buffer);
  }

  if (extension === ".xlsx" || extension === ".xlsm") {
    return readXlsxRows(buffer);
  }

  throw new Error(`Unsupported upload type for ${fileName || "file"}. Use CSV, XLSX, or XLSM.`);
}

function getRowTypeValue(row) {
  return String(
    row?.Type__label ??
      row?.["Type label"] ??
      row?.Type ??
      row?.type ??
      ""
  ).trim();
}

function filterSourceRows(reportKey, rows) {
  if (reportKey === SOURCE_KEYS.contact1) {
    return rows.filter((row) => getRowTypeValue(row).toLowerCase() === "member 1");
  }

  if (reportKey === SOURCE_KEYS.contact2) {
    return rows.filter((row) => getRowTypeValue(row).toLowerCase() === "member 2");
  }

  return rows;
}

function getCertificateLabels(reportKey) {
  if (reportKey === SOURCE_KEYS.credits) {
    return [
      "Certificate / Certificate Name",
      "Certificate: Certificate Name",
      "Certificate Name",
      "Certificate",
      "Certificate Number",
    ];
  }

  return ["Certificate Name", "Certificate", "Certificate Number"];
}

function getCertificateValue(reportKey, row) {
  return resolveCertificateNumber(row, getCertificateLabels(reportKey));
}

function filterRowsByCertificate(reportKey, rows, certificateSet) {
  if (!(certificateSet instanceof Set) || certificateSet.size === 0) {
    return rows;
  }

  return (rows || []).filter((row) => certificateSet.has(getCertificateValue(reportKey, row)));
}

async function fetchLiveSourceReports(reportMonth) {
  const tokenRecord = await getConnectedSalesforceToken();
  const rawDatasets = {};
  const monthScopedSources = new Set([SOURCE_KEYS.payments, SOURCE_KEYS.credits]);

  for (const reportConfig of SALESFORCE_REPORTS) {
    const rows = await fetchFullFlatReportRows(
      tokenRecord,
      reportConfig,
      reportMonth,
      {
        applyDateFilter: monthScopedSources.has(reportConfig.key),
      }
    );
    rawDatasets[reportConfig.key] = filterSourceRows(reportConfig.key, rows);
  }

  const relevantCertificates = new Set(
    [SOURCE_KEYS.payments, SOURCE_KEYS.credits]
      .flatMap((sourceKey) =>
        (rawDatasets[sourceKey] || []).map((row) => getCertificateValue(sourceKey, row))
      )
      .filter(Boolean)
  );

  [SOURCE_KEYS.certs, SOURCE_KEYS.contact1, SOURCE_KEYS.contact2].forEach((key) => {
    rawDatasets[key] = filterRowsByCertificate(key, rawDatasets[key] || [], relevantCertificates);
  });

  return {
    source: "salesforce-live-reports",
    rawDatasets,
    sourceSheets: SALESFORCE_REPORTS.map((entry) => ({
      key: entry.key,
      tabName: entry.tabName,
      rows: rawDatasets[entry.key] || [],
    })),
  };
}

function fetchUploadedSourceReports(uploadedFiles) {
  const rawDatasets = {};

  SOURCE_FILE_FIELDS.forEach((field) => {
    const upload = uploadedFiles?.[field.key];
    if (!upload?.fileName || !upload?.base64Content) {
      throw new Error(`${field.label} is required for uploaded-source mode.`);
    }

    rawDatasets[field.key] = parseUploadedRows(upload.fileName, upload.base64Content);
  });

  return {
    source: "uploaded-source-files",
    rawDatasets,
    sourceSheets: SALESFORCE_REPORTS.map((entry) => ({
      key: entry.key,
      tabName: entry.tabName,
      rows: rawDatasets[entry.key] || [],
    })),
  };
}

async function fetchReports({ reportMonth, sourceMode, uploadedFiles }) {
  if (sourceMode === "upload") {
    return fetchUploadedSourceReports(uploadedFiles);
  }

  return fetchLiveSourceReports(reportMonth);
}

module.exports = {
  fetchReports,
};
