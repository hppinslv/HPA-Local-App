const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildFinalColumns } = require("./config");
const { generatePdfFromHtml } = require("../../../../services/pdfPrintService");
const { formatCompletionMonthFilePrefix } = require("../../../../services/monthlyReportServiceHelpers");

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "..", "..", "Amalgamated_Premium_Remittance.xlsx");

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

function escapeXml(value) {
  return Array.from(String(value ?? ""))
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      );
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toColumnName(index) {
  let value = index + 1;
  let result = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }

  return result;
}

function toExcelDateNumber(isoDate) {
  if (!isoDate) {
    return null;
  }

  const utcMillis = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(utcMillis)) {
    return null;
  }

  return Math.floor(utcMillis / 86400000) + 25569;
}

function buildInlineStringCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(
    value
  )}</t></is></c>`;
}

function buildNumberCell(reference, styleId, value) {
  const numericValue = coerceFiniteNumber(value);
  if (numericValue === null) {
    return buildBlankCell(reference, styleId);
  }

  return `<c r="${reference}" s="${styleId}"><v>${numericValue}</v></c>`;
}

function buildBooleanCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}" t="b"><v>${value ? 1 : 0}</v></c>`;
}

function buildBlankCell(reference, styleId) {
  return `<c r="${reference}" s="${styleId}"/>`;
}

function coerceFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  let normalized = String(value).trim();
  if (!normalized || normalized === "-" || normalized === "--") {
    return null;
  }

  let isNegative = false;
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    isNegative = true;
    normalized = normalized.slice(1, -1).trim();
  }

  normalized = normalized
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");

  if (!normalized) {
    return null;
  }

  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return isNegative ? numericValue * -1 : numericValue;
}

function readTemplateCellStyles(templateXml, rowNumber) {
  const rowMatch = templateXml.match(new RegExp(`<row r="${rowNumber}"[^>]*>([\\s\\S]*?)<\\/row>`));
  if (!rowMatch) {
    return [];
  }

  return Array.from(rowMatch[1].matchAll(/<c r="([A-Z]+)\d+"(?: s="(\d+)")?/g)).map((match) => ({
    column: match[1],
    styleId: Number(match[2] || 0),
  }));
}

function getStyleId(styleRows, index, fallback = 0) {
  return styleRows[index]?.styleId ?? fallback;
}

function replaceDimensionRef(xml, ref) {
  return xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`);
}

function replaceAutoFilterRef(xml, ref) {
  return xml.replace(/<autoFilter ref="[^"]*"[^>]*\/>/, (match) =>
    match.replace(/ref="[^"]*"/, `ref="${ref}"`)
  );
}

function replaceSheetData(xml, sheetDataXml) {
  return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetDataXml}</sheetData>`);
}

function removeNode(xml, pattern) {
  return xml.replace(pattern, "");
}

function sanitizeWorksheetXml(worksheetXml) {
  return worksheetXml
    .replace(/<pageSetup\b[\s\S]*?\/>/g, "")
    .replace(/<customProperties\b[\s\S]*?<\/customProperties>/g, "")
    .replace(/<tableParts\b[\s\S]*?<\/tableParts>/g, "")
    .replace(/<extLst\b[\s\S]*?<\/extLst>/g, "");
}

function sanitizeWorksheetRelationships(relationshipsXml) {
  return relationshipsXml
    .replace(
      /<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/printerSettings"[^>]*\/>/g,
      ""
    )
    .replace(
      /<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/customProperty"[^>]*\/>/g,
      ""
    )
    .replace(
      /<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/table"[^>]*\/>/g,
      ""
    );
}

function sanitizeWorksheetArtifacts(extractDir, sheetFileName) {
  const worksheetPath = path.join(extractDir, "xl", "worksheets", sheetFileName);
  const relsPath = path.join(extractDir, "xl", "worksheets", "_rels", `${sheetFileName}.rels`);

  if (fs.existsSync(worksheetPath)) {
    fs.writeFileSync(
      worksheetPath,
      sanitizeWorksheetXml(fs.readFileSync(worksheetPath, "utf8")),
      "utf8"
    );
  }

  if (fs.existsSync(relsPath)) {
    fs.writeFileSync(
      relsPath,
      sanitizeWorksheetRelationships(fs.readFileSync(relsPath, "utf8")),
      "utf8"
    );
  }
}

function sanitizeWorkbookXml(workbookXml) {
  return workbookXml
    .replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, "")
    .replace(/<xr:revisionPtr\b[\s\S]*?\/>/g, "")
    .replace(/<extLst\b[\s\S]*?<\/extLst>/g, "");
}

function sanitizeContentTypesXml(contentTypesXml) {
  return contentTypesXml
    .replace(
      /<Override PartName="\/xl\/customProperty\d+\.bin" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.customProperty"\/>/g,
      ""
    )
    .replace(
      /<Override PartName="\/xl\/tables\/table\d+\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.table\+xml"\/>/g,
      ""
    )
    .replace(
      /<Default Extension="bin" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.printerSettings"\/>/g,
      ""
    );
}

function sanitizePackageArtifacts(extractDir) {
  const workbookPath = path.join(extractDir, "xl", "workbook.xml");
  const contentTypesPath = path.join(extractDir, "[Content_Types].xml");
  const customPropertyFiles = fs.readdirSync(path.join(extractDir, "xl"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^customProperty\d+\.bin$/i.test(entry.name))
    .map((entry) => path.join(extractDir, "xl", entry.name));
  const printerSettingsDir = path.join(extractDir, "xl", "printerSettings");
  const tablesDir = path.join(extractDir, "xl", "tables");

  if (fs.existsSync(workbookPath)) {
    fs.writeFileSync(workbookPath, sanitizeWorkbookXml(fs.readFileSync(workbookPath, "utf8")), "utf8");
  }

  if (fs.existsSync(contentTypesPath)) {
    fs.writeFileSync(
      contentTypesPath,
      sanitizeContentTypesXml(fs.readFileSync(contentTypesPath, "utf8")),
      "utf8"
    );
  }

  customPropertyFiles.forEach((filePath) => {
    fs.rmSync(filePath, { force: true });
  });

  if (fs.existsSync(printerSettingsDir)) {
    fs.rmSync(printerSettingsDir, { recursive: true, force: true });
  }

  if (fs.existsSync(tablesDir)) {
    fs.rmSync(tablesDir, { recursive: true, force: true });
  }
}

function buildCertSheetXml(templateXml, rows) {
  const headerStyles = readTemplateCellStyles(templateXml, 1);
  const dataStyles = readTemplateCellStyles(templateXml, 2);
  const headers = [
    "Certificate Name",
    "Billing State/Province",
    "Product",
    "Policy Type",
    "Effective Date",
    "Pay To Date",
    "Orig Rate (1 Person)",
    "Orig Rate (2 Person)",
    "Total AD&D Coverage",
    "Free Term Life Coverage Amt",
    "Orig Contrib AD&D Coverage Amt",
    "Orig Non-Contrib AD&D Coverage Amt",
    "Add'l AD&D Coverage Amt (NoReduction)",
  ];
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:13" x14ac:dyDescent="0.25">${headers
      .map((header, index) =>
        buildInlineStringCell(`${toColumnName(index)}1`, getStyleId(headerStyles, index, 1), header)
      )
      .join("")}</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const values = [
      row["Certificate Name"] ?? row["certificate name"] ?? "",
      row["Billing State/Province"] ?? row["billing state province"] ?? "",
      row.Product ?? row.product ?? "",
      row["Policy Type"] ?? row["policy type"] ?? "",
      row["Effective Date"] ?? row["effective date"] ?? "",
      row["Pay To Date"] ?? row["pay to date"] ?? "",
      row["Orig Rate (1 Person)"] ?? row["orig rate 1 person"] ?? "",
      row["Orig Rate (2 Person)"] ?? row["orig rate 2 person"] ?? "",
      row["Total AD&D Coverage"] ?? row["total ad d coverage"] ?? "",
      row["Free Term Life Coverage Amt"] ?? row["free term life coverage amt"] ?? "",
      row["Orig Contrib AD&D Coverage Amt"] ?? row["orig contrib ad d coverage amt"] ?? "",
      row["Orig Non-Contrib AD&D Coverage Amt"] ??
        row["orig non contrib ad d coverage amt"] ??
        "",
      row["Add'l AD&D Coverage Amt (NoReduction)"] ??
        row["add l ad d coverage amt noreduction"] ??
        "",
    ];

    const cellXml = values
      .map((value, columnIndex) => {
        const reference = `${toColumnName(columnIndex)}${rowNumber}`;
        const styleId = getStyleId(dataStyles, columnIndex, 0);

        if (columnIndex === 4 || columnIndex === 5) {
          const excelDate = toExcelDateNumber(value);
          return excelDate === null
            ? buildBlankCell(reference, styleId)
            : buildNumberCell(reference, styleId, excelDate);
        }

        if (columnIndex >= 6) {
          return value === "" ? buildBlankCell(reference, styleId) : buildNumberCell(reference, styleId, Number(value));
        }

        return value === "" ? buildBlankCell(reference, styleId) : buildInlineStringCell(reference, styleId, value);
      })
      .join("");

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:13" x14ac:dyDescent="0.25">${cellXml}</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);
  return replaceAutoFilterRef(
    replaceDimensionRef(
      replaceSheetData(templateXml, sheetRows.join("")),
      `A1:M${lastRow}`
    ),
    `A1:M${lastRow}`
  );
}

function buildPaymentsSheetXml(templateXml, rows) {
  const headerStyles = readTemplateCellStyles(templateXml, 1);
  const dataStyles = readTemplateCellStyles(templateXml, 2);
  const headers = ["Certificate", "Months Paid", "Premium"];
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:3" x14ac:dyDescent="0.25">${headers
      .map((header, index) =>
        buildInlineStringCell(`${toColumnName(index)}1`, getStyleId(headerStyles, index, 1), header)
      )
      .join("")}</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const values = [
      row.Certificate ?? row["Certificate Name"] ?? row.certificate ?? "",
      row["Months Paid"] ?? row["months paid"] ?? "",
      row.Premium ?? row.premium ?? "",
    ];

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:3" x14ac:dyDescent="0.25">` +
        buildNumberCell(`A${rowNumber}`, getStyleId(dataStyles, 0, 0), Number(values[0])) +
        buildNumberCell(`B${rowNumber}`, getStyleId(dataStyles, 1, 0), Number(values[1] || 0)) +
        buildNumberCell(`C${rowNumber}`, getStyleId(dataStyles, 2, 0), Number(values[2] || 0)) +
      `</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);
  return replaceAutoFilterRef(
    replaceDimensionRef(
      replaceSheetData(templateXml, sheetRows.join("")),
      `A1:C${lastRow}`
    ),
    `A1:C${lastRow}`
  );
}

function buildCreditsSheetXml(templateXml, rows) {
  const headerStyles = readTemplateCellStyles(templateXml, 1);
  const dataStyles = readTemplateCellStyles(templateXml, 2);
  const headers = [
    "Certificate: Certificate Name",
    "Rollback Months",
    "Premium",
    "Rollback Months2",
    "Premium2",
  ];
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:5" x14ac:dyDescent="0.25">${headers
      .map((header, index) =>
        buildInlineStringCell(`${toColumnName(index)}1`, getStyleId(headerStyles, index, 1), header)
      )
      .join("")}</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const certificateNumber =
      row["Certificate / Certificate Name"] ??
      row["Certificate Name"] ??
      row.Certificate ??
      row.certificate ??
      "";
    const rollbackMonths = Number(row["Rollback Months"] ?? row["rollback months"] ?? 0);
    const premium = Number(row.Premium ?? row.premium ?? 0);

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:5" x14ac:dyDescent="0.25">` +
        buildNumberCell(`A${rowNumber}`, getStyleId(dataStyles, 0, 0), Number(certificateNumber)) +
        buildNumberCell(`B${rowNumber}`, getStyleId(dataStyles, 1, 0), rollbackMonths) +
        buildNumberCell(`C${rowNumber}`, getStyleId(dataStyles, 2, 0), premium) +
        buildNumberCell(`D${rowNumber}`, getStyleId(dataStyles, 3, 0), rollbackMonths * -1) +
        buildNumberCell(`E${rowNumber}`, getStyleId(dataStyles, 4, 0), premium * -1) +
      `</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);
  return replaceDimensionRef(replaceSheetData(templateXml, sheetRows.join("")), `A1:E${lastRow}`);
}

function buildContactSheetXml(templateXml, rows) {
  const headerStyles = readTemplateCellStyles(templateXml, 1);
  const dataStyles = readTemplateCellStyles(templateXml, 2);
  const headers = [
    "Certificate Name",
    "First Name",
    "Middle Name",
    "Last Name",
    "Date of Birth",
    "Starting Age Calc",
    "Current Age",
    "Type",
    "Column1",
  ];
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:9" x14ac:dyDescent="0.25">${headers
      .map((header, index) =>
        buildInlineStringCell(`${toColumnName(index)}1`, getStyleId(headerStyles, index, 1), header)
      )
      .join("")}</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const firstName = row["First Name"] ?? row["first name"] ?? "";
    const middleName = row["Middle Name"] ?? row["middle name"] ?? "";
    const lastName = row["Last Name"] ?? row["last name"] ?? "";
    const fullName = [firstName, middleName, lastName].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
    const values = [
      row["Certificate Name"] ?? row.Certificate ?? row.certificate ?? "",
      firstName,
      middleName,
      lastName,
      row["Date of Birth"] ?? row["date of birth"] ?? "",
      row["Starting Age Calc"] ?? row["starting age calc"] ?? "",
      row["Current Age"] ?? row["current age"] ?? "",
      fullName,
      fullName,
    ];

    const cellXml = values
      .map((value, columnIndex) => {
        const reference = `${toColumnName(columnIndex)}${rowNumber}`;
        const styleId = getStyleId(dataStyles, columnIndex, 0);

        if (columnIndex === 0) {
          return buildNumberCell(reference, styleId, Number(value));
        }

        if (columnIndex === 4) {
          const excelDate = toExcelDateNumber(value);
          return excelDate === null
            ? buildBlankCell(reference, styleId)
            : buildNumberCell(reference, styleId, excelDate);
        }

        if (columnIndex === 5 || columnIndex === 6) {
          return value === "" ? buildBlankCell(reference, styleId) : buildNumberCell(reference, styleId, Number(value));
        }

        return value === "" ? buildBlankCell(reference, styleId) : buildInlineStringCell(reference, styleId, value);
      })
      .join("");

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:9" x14ac:dyDescent="0.25">${cellXml}</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);
  return replaceDimensionRef(replaceSheetData(templateXml, sheetRows.join("")), `A1:I${lastRow}`);
}

function buildFinalSheetXml(templateXml, report) {
  const finalColumns = buildFinalColumns(report.reportMonth);
  const headerStyles = readTemplateCellStyles(templateXml, 1);
  const totalStyles = readTemplateCellStyles(templateXml, 2);
  const oddStyles = readTemplateCellStyles(templateXml, 3);
  const evenStyles = readTemplateCellStyles(templateXml, 4);
  const rows = [];

  rows.push(
    `<row r="1" spans="1:38" x14ac:dyDescent="0.25">${finalColumns
      .map((column, index) =>
        buildInlineStringCell(`${toColumnName(index)}1`, getStyleId(headerStyles, index, 1), column.label)
      )
      .join("")}</row>`
  );

  const totalsByKey = {
    certificate: "Totals",
    memberCount: report.totals.memberCount,
    monthsPaidLabelValue: report.totals.monthsPaid,
    premiumCollectedLabelValue: report.totals.premiumCollected,
    amalPrem: report.totals.amalPrem,
    ahaPrem: report.totals.ahaPrem,
  };

  rows.push(
    `<row r="2" spans="1:38" x14ac:dyDescent="0.25">${finalColumns
      .map((column, index) => {
        const reference = `${toColumnName(index)}2`;
        const styleId = getStyleId(totalStyles, index, 0);
        const value = totalsByKey[column.key];

        if (value === undefined || value === null || value === "") {
          return buildBlankCell(reference, styleId);
        }

        if (typeof value === "number") {
          return buildNumberCell(reference, styleId, value);
        }

        return buildInlineStringCell(reference, styleId, value);
      })
      .join("")}</row>`
  );

  report.rows.forEach((row, index) => {
    const rowNumber = index + 3;
    const styleRow = index % 2 === 0 ? oddStyles : evenStyles;
    const cellXml = finalColumns
      .map((column, columnIndex) => {
        const reference = `${toColumnName(columnIndex)}${rowNumber}`;
        const styleId = getStyleId(styleRow, columnIndex, 0);
        const value = row[column.key];

        if (value === undefined || value === null || value === "") {
          return buildBlankCell(reference, styleId);
        }

        if (typeof value === "boolean") {
          return buildBooleanCell(reference, styleId, value);
        }

        if (column.key === "origEffectiveDate" || column.key === "policyEffectiveDate" || column.key === "policyEffectiveFrom" || column.key === "policyEffectiveTo" || column.key === "member1Dob" || column.key === "member2Dob") {
          const excelDate = toExcelDateNumber(value);
          return excelDate === null
            ? buildBlankCell(reference, styleId)
            : buildNumberCell(reference, styleId, excelDate);
        }

        if (typeof value === "number") {
          return buildNumberCell(reference, styleId, value);
        }

        return buildInlineStringCell(reference, styleId, value);
      })
      .join("");

    rows.push(
      `<row r="${rowNumber}" spans="1:38" x14ac:dyDescent="0.25">${cellXml}</row>`
    );
  });

  const lastDataRow = Math.max(report.rows.length + 2, 2);
  return replaceAutoFilterRef(
    replaceDimensionRef(
      replaceSheetData(templateXml, rows.join("")),
      `A1:AL${lastDataRow}`
    ),
    `A1:AL${lastDataRow}`
  );
}

function updateWorkbookXml(workbookXml, report) {
  const lastDataRow = Math.max(report.rows.length + 2, 2);
  const paymentsLastRow = Math.max((report.sourceSheets.find((sheet) => sheet.key === "payments")?.rows.length || 0) + 1, 1);

  return workbookXml
    .replace(
      /<definedName name="_xlnm\._FilterDatabase" localSheetId="2" hidden="1">[^<]+<\/definedName>/,
      `<definedName name="_xlnm._FilterDatabase" localSheetId="2" hidden="1">'Premium Remittance Payments'!$A$1:$C$${paymentsLastRow}</definedName>`
    )
    .replace(
      /<definedName name="_xlnm\._FilterDatabase" localSheetId="6" hidden="1">[^<]+<\/definedName>/,
      `<definedName name="_xlnm._FilterDatabase" localSheetId="6" hidden="1">Sheet1!$A$1:$AL$${lastDataRow}</definedName>`
    );
}

function stripCalcChain(extractDir) {
  const workbookRelsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
  const contentTypesPath = path.join(extractDir, "[Content_Types].xml");
  const calcChainPath = path.join(extractDir, "xl", "calcChain.xml");

  if (fs.existsSync(workbookRelsPath)) {
    fs.writeFileSync(
      workbookRelsPath,
      removeNode(
        fs.readFileSync(workbookRelsPath, "utf8"),
        /<Relationship[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/calcChain"[^>]*\/>/
      ),
      "utf8"
    );
  }

  if (fs.existsSync(contentTypesPath)) {
    fs.writeFileSync(
      contentTypesPath,
      removeNode(
        fs.readFileSync(contentTypesPath, "utf8"),
        /<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/
      ),
      "utf8"
    );
  }

  if (fs.existsSync(calcChainPath)) {
    fs.rmSync(calcChainPath, { force: true });
  }
}

function writeWorkbook(report, destinationPath) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Workbook template not found: ${TEMPLATE_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-amalgamated-workbook-"));
  const templateZipPath = path.join(tempDir, "template.zip");
  const extractDir = path.join(tempDir, "unzipped");
  const outputZipPath = path.join(tempDir, "output.zip");

  fs.copyFileSync(TEMPLATE_PATH, templateZipPath);
  runPowerShell(
    `Expand-Archive -LiteralPath '${templateZipPath}' -DestinationPath '${extractDir}' -Force`
  );

  const sourceSheetMap = new Map((report.sourceSheets || []).map((sheet) => [sheet.key, sheet]));
  const certSheetPath = path.join(extractDir, "xl", "worksheets", "sheet2.xml");
  const paymentsSheetPath = path.join(extractDir, "xl", "worksheets", "sheet3.xml");
  const creditsSheetPath = path.join(extractDir, "xl", "worksheets", "sheet4.xml");
  const contact1SheetPath = path.join(extractDir, "xl", "worksheets", "sheet5.xml");
  const contact2SheetPath = path.join(extractDir, "xl", "worksheets", "sheet6.xml");
  const finalSheetPath = path.join(extractDir, "xl", "worksheets", "sheet7.xml");
  const workbookPath = path.join(extractDir, "xl", "workbook.xml");

  fs.writeFileSync(
    certSheetPath,
    buildCertSheetXml(fs.readFileSync(certSheetPath, "utf8"), sourceSheetMap.get("certs")?.rows || []),
    "utf8"
  );
  fs.writeFileSync(
    paymentsSheetPath,
    buildPaymentsSheetXml(
      fs.readFileSync(paymentsSheetPath, "utf8"),
      sourceSheetMap.get("payments")?.rows || []
    ),
    "utf8"
  );
  fs.writeFileSync(
    creditsSheetPath,
    buildCreditsSheetXml(
      fs.readFileSync(creditsSheetPath, "utf8"),
      sourceSheetMap.get("credits")?.rows || []
    ),
    "utf8"
  );
  fs.writeFileSync(
    contact1SheetPath,
    buildContactSheetXml(
      fs.readFileSync(contact1SheetPath, "utf8"),
      sourceSheetMap.get("contact1")?.rows || []
    ),
    "utf8"
  );
  fs.writeFileSync(
    contact2SheetPath,
    buildContactSheetXml(
      fs.readFileSync(contact2SheetPath, "utf8"),
      sourceSheetMap.get("contact2")?.rows || []
    ),
    "utf8"
  );
  fs.writeFileSync(
    finalSheetPath,
    buildFinalSheetXml(fs.readFileSync(finalSheetPath, "utf8"), report),
    "utf8"
  );

  fs.writeFileSync(
    workbookPath,
    updateWorkbookXml(fs.readFileSync(workbookPath, "utf8"), report),
    "utf8"
  );

  ["sheet2.xml", "sheet3.xml", "sheet4.xml", "sheet5.xml", "sheet6.xml", "sheet7.xml"].forEach((sheetFileName) => {
    sanitizeWorksheetArtifacts(extractDir, sheetFileName);
  });
  sanitizePackageArtifacts(extractDir);

  stripCalcChain(extractDir);

  runPowerShell(
    `Compress-Archive -Path '${path.join(extractDir, "*")}' -DestinationPath '${outputZipPath}' -Force`
  );

  fs.copyFileSync(outputZipPath, destinationPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function buildPrintableHtml(report) {
  const finalColumns = buildFinalColumns(report.reportMonth);
  const dateKeys = new Set([
    "origEffectiveDate",
    "policyEffectiveDate",
    "policyEffectiveFrom",
    "policyEffectiveTo",
    "member1Dob",
    "member2Dob",
  ]);
  const currencyKeys = new Set([
    "rate1",
    "rate2",
    "rate",
    "premiumCollectedLabelValue",
    "amalPrem",
    "ahaPrem",
    "addBenefit",
    "lifeBenefit",
    "member1AddBenefit",
    "member1LifeBenefit",
    "member2AddBenefit",
    "member2LifeBenefit",
    "addCoverage",
    "addContribCoverage",
    "addNonContribCoverage",
  ]);
  const integerKeys = new Set([
    "certificate",
    "memberCount",
    "monthsPaidLabelValue",
    "member1AgeStart",
    "member1CurrentAge",
    "member2AgeStart",
    "member2CurrentAge",
  ]);

  function formatDate(value) {
    if (!value) {
      return "";
    }

    const [year, month, day] = String(value).split("-");
    if (!year || !month || !day) {
      return String(value);
    }

    return `${month}/${day}/${year}`;
  }

  function formatNumber(value, fractionDigits = 2) {
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }

  function formatCellValue(column, value) {
    if (value === undefined || value === null || value === "") {
      return "";
    }

    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }

    if (dateKeys.has(column.key)) {
      return formatDate(value);
    }

    if (currencyKeys.has(column.key) && Number.isFinite(Number(value))) {
      return formatNumber(value);
    }

    if (integerKeys.has(column.key) && Number.isFinite(Number(value))) {
      const numericValue = Number(value);
      return Number.isInteger(numericValue) ? String(numericValue) : formatNumber(numericValue);
    }

    return String(value);
  }

  const totalValues = {
    certificate: "Totals",
    memberCount: report.totals.memberCount,
    monthsPaidLabelValue: report.totals.monthsPaid,
    premiumCollectedLabelValue: report.totals.premiumCollected,
    amalPrem: report.totals.amalPrem,
    ahaPrem: report.totals.ahaPrem,
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Amalgamated Premium Remittance - ${escapeXml(report.reportMonthLabel)}</title>
    <style>
      :root {
        --grid: #d4d4d4;
        --header: #d9ead3;
        --total: #fff2cc;
        --sheet: #ffffff;
        --text: #1f1f1f;
        --muted: #6f6f6f;
      }
      body {
        margin: 0;
        background: #f3f3f3;
        font-family: Calibri, Arial, sans-serif;
        color: var(--text);
      }
      .sheet-shell {
        padding: 18px;
      }
      .sheet-print-area {
        width: fit-content;
      }
      .sheet-meta {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 12px;
      }
      .sheet-wrap {
        overflow: auto;
        background: var(--sheet);
        border: 1px solid var(--grid);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      }
      table {
        border-collapse: collapse;
        min-width: 2400px;
        background: var(--sheet);
      }
      th, td {
        border: 1px solid var(--grid);
        padding: 6px 8px;
        font-size: 12px;
        line-height: 1.2;
        white-space: nowrap;
        text-align: left;
      }
      th {
        position: sticky;
        top: 0;
        background: var(--header);
        z-index: 1;
        font-weight: 700;
      }
      tr.total-row td {
        background: var(--total);
        font-weight: 700;
      }
      tr:nth-child(even) td {
        background: #fbfbfb;
      }
      td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .is-hidden {
        display: none;
      }
      @media print {
        @page {
          size: 14in 11in;
          margin: 0.2in;
        }
        body {
          background: #fff;
        }
        .sheet-shell {
          padding: 0;
        }
        .sheet-wrap {
          overflow: visible;
          border: none;
          box-shadow: none;
        }
        .sheet-print-area {
          zoom: 0.5;
          width: calc(100% / 0.5);
          transform-origin: top left;
        }
      }
    </style>
  </head>
  <body>
    <div class="sheet-shell">
      <p class="sheet-meta">Sheet1 | ${escapeXml(report.reportMonthLabel)} | ${escapeXml(report.source)}</p>
      <div class="sheet-print-area">
        <div class="sheet-wrap">
          <table>
            <thead>
              <tr>
                ${finalColumns
                  .map(
                    (column) =>
                      `<th class="${column.hidden ? "is-hidden" : ""}">${escapeXml(column.label)}</th>`
                  )
                  .join("")}
              </tr>
            </thead>
            <tbody>
              <tr class="total-row">
                ${finalColumns
                  .map((column) => {
                    const value = totalValues[column.key];
                    const isNumeric =
                      value !== undefined &&
                      value !== null &&
                      value !== "" &&
                      (currencyKeys.has(column.key) || integerKeys.has(column.key));
                    return `<td class="${column.hidden ? "is-hidden " : ""}${isNumeric ? "num" : ""}">${escapeXml(
                      formatCellValue(column, value)
                    )}</td>`;
                  })
                  .join("")}
              </tr>
              ${report.rows
                .map(
                  (row) => `
              <tr>
                ${finalColumns
                  .map((column) => {
                    const value = row[column.key];
                    const isNumeric =
                      value !== undefined &&
                      value !== null &&
                      value !== "" &&
                      (currencyKeys.has(column.key) || integerKeys.has(column.key));
                    return `<td class="${column.hidden ? "is-hidden " : ""}${isNumeric ? "num" : ""}">${escapeXml(
                      formatCellValue(column, value)
                    )}</td>`;
                  })
                  .join("")}
              </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function writeArtifacts(runDir, report) {
  const filePrefix = formatCompletionMonthFilePrefix(report.generatedAt);
  const workbookFileName = `${filePrefix}_Amalgamated_Premium_Remittance.xlsx`;
  const pdfFileName = `${filePrefix}_Amalgamated_Premium_Remittance.pdf`;
  const jsonFileName = `${filePrefix}_Amalgamated_Premium_Remittance.json`;
  const printableHtml = buildPrintableHtml(report);
  const artifacts = [];
  fs.writeFileSync(path.join(runDir, jsonFileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!report.blockingErrors.length) {
    writeWorkbook(report, path.join(runDir, workbookFileName));
    artifacts.push({
      kind: "spreadsheet",
      label: "Download Workbook",
      fileName: workbookFileName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  try {
    generatePdfFromHtml(printableHtml, path.join(runDir, pdfFileName));
    artifacts.push({
      kind: "print",
      label: "Download PDF",
      fileName: pdfFileName,
      contentType: "application/pdf",
    });
    report.printArtifactWarning = "";
  } catch (error) {
    report.printArtifactWarning = `PDF output was unavailable: ${error.message}`;
  }

  artifacts.push(
    {
      kind: "json",
      label: "Download JSON",
      fileName: jsonFileName,
      contentType: "application/json; charset=utf-8",
    }
  );

  return artifacts;
}

module.exports = {
  __test: {
    coerceFiniteNumber,
  },
  writeArtifacts,
};
