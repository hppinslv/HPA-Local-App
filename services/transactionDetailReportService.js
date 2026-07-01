const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createPrintableArtifactFromHtml } = require("./pdfPrintService");
const { formatReportMonthFilePrefix } = require("./monthlyReportServiceHelpers");

const TEMPLATE_PATH = path.join(__dirname, "..", "AHA HPA Transaction Detail.xlsx");

const DETAIL_COLUMNS = [
  "Certificate Number",
  "Transaction Type",
  "Transaction Date",
  "Certificate Number",
  "Pay Type",
  "Amount",
  "Members",
  "Check #",
  "Auth Code",
  "APPROVAL",
  "Gateway Txn ID",
  "Gateway Response Message",
  "Reason_for_Credit__c",
];

function formatReportMonth(monthValue) {
  const [year, month] = String(monthValue).split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toExcelDateNumber(isoDate) {
  const utcMillis = Date.parse(`${isoDate}T00:00:00Z`);
  return Math.floor(utcMillis / 86400000) + 25569;
}

function buildInlineStringCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(
    value
  )}</t></is></c>`;
}

function buildNumberCell(reference, styleId, value) {
  return `<c r="${reference}" s="${styleId}"><v>${value}</v></c>`;
}

function buildBlankCell(reference, styleId) {
  return `<c r="${reference}" s="${styleId}"/>`;
}

function normalizeCertificate(value) {
  return String(value ?? "").trim();
}

function deriveTransactionType(payType, amount) {
  if (payType === "BILL") {
    return amount < 0
      ? "Billing & Direct Debit - Refunds"
      : "Billing - Credits (from TPA)";
  }

  if (payType === "CC") {
    return amount < 0
      ? "Credit Cards (UMB) - Refunds"
      : "Credit Cards (UMB) - Credits";
  }

  return amount < 0
    ? "Direct Debit (UMB Bank) - Returned Items"
    : "Direct Debit (UMB Bank) - Credits";
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function buildTransactionFingerprint(entry) {
  return [
    entry.transactionDate,
    normalizeCertificate(entry.certificateNumber),
    entry.payType,
    roundCurrency(entry.amount),
    String(entry.checkNumber || "").trim(),
    String(entry.authCode || "").trim(),
    String(entry.approval || "").trim(),
    String(entry.gatewayTxnId || "").trim(),
    String(entry.reasonForCredit || "").trim(),
  ].join("|");
}

function buildDifferenceMap(entries) {
  const counts = new Map();

  entries.forEach((entry) => {
    const fingerprint = buildTransactionFingerprint(entry);
    counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
  });

  return counts;
}

function expandDifferences(leftCounts, rightCounts, sourceEntries, label) {
  const remaining = new Map(leftCounts);
  const results = [];

  for (const [fingerprint, count] of rightCounts.entries()) {
    if (!remaining.has(fingerprint)) {
      continue;
    }

    const nextCount = remaining.get(fingerprint) - count;
    if (nextCount > 0) {
      remaining.set(fingerprint, nextCount);
    } else {
      remaining.delete(fingerprint);
    }
  }

  for (const entry of sourceEntries) {
    const fingerprint = buildTransactionFingerprint(entry);
    const remainingCount = remaining.get(fingerprint);
    if (!remainingCount) {
      continue;
    }

    results.push({
      kind: label,
      transactionDate: entry.transactionDate,
      certificateNumber: entry.certificateNumber,
      payType: entry.payType,
      amount: roundCurrency(entry.amount),
      checkNumber: entry.checkNumber,
      approval: entry.approval,
      reasonForCredit: entry.reasonForCredit || "",
    });

    if (remainingCount === 1) {
      remaining.delete(fingerprint);
    } else {
      remaining.set(fingerprint, remainingCount - 1);
    }
  }

  return results;
}

function buildSystemChecks(sourceEntries, combinedEntries, sheetTotalAmount) {
  const sourceTotal = roundCurrency(
    sourceEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  );
  const sheetTotal = roundCurrency(sheetTotalAmount);
  const sourceCounts = buildDifferenceMap(sourceEntries);
  const combinedCounts = buildDifferenceMap(combinedEntries);

  const missingFromOutput = expandDifferences(
    sourceCounts,
    combinedCounts,
    sourceEntries,
    "missing-from-output"
  );
  const extraInOutput = expandDifferences(
    combinedCounts,
    sourceCounts,
    combinedEntries,
    "extra-in-output"
  );
  const matches = sourceTotal === sheetTotal;

  return [
    {
      key: "sheet1-f2-vs-source-total",
      label: "Sheet1 F2 matches payment plus credit source total",
      status: matches ? "passed" : "failed",
      sourceTotal,
      sheetTotal,
      note: matches
        ? "Sheet1 F2 matches the normalized amount from the two source transaction reports."
        : "Sheet1 F2 does not match the normalized amount from the payment and credit reports.",
      differingTransactions: matches ? [] : [...missingFromOutput, ...extraInOutput],
    },
  ];
}

function buildPolicyLookup(policyRows) {
  const lookup = new Map();

  for (const row of policyRows) {
    const certificateNumber = normalizeCertificate(row.certificateNumber);
    if (!certificateNumber) {
      continue;
    }

    const policyType = String(row.policyType ?? "").trim();
    lookup.set(certificateNumber, {
      policyType,
      members: row.members || (policyType ? policyType.slice(0, 1) : ""),
    });
  }

  return lookup;
}

function deriveMembersFromPolicyType(policyType) {
  const match = String(policyType || "").match(/^(\d+)/);
  return match ? match[1] : "";
}

function resolvePolicyDetails(certificateNumber, row, policyLookup) {
  const lookupPolicy = policyLookup.get(certificateNumber);
  if (lookupPolicy) {
    return lookupPolicy;
  }

  const rawPolicyType =
    row?.raw?.["Policy: Policy Type__label"] ||
    row?.raw?.["policy policy type label"] ||
    row?.raw?.["Policy Type__label"] ||
    row?.raw?.["policy type label"] ||
    row?.raw?.["Policy: Policy Type"] ||
    row?.raw?.["policy policy type"] ||
    row?.raw?.["Policy Type"] ||
    row?.raw?.["policy type"] ||
    "";

  const policyType = String(rawPolicyType).trim();

  return {
    policyType,
    members: deriveMembersFromPolicyType(policyType),
  };
}

function buildTransactionDetailReport(reportMonth, sourceData) {
  const paymentSource = sourceData.rawTabs.find((entry) => entry.key === "paymentSummary");
  const creditSource = sourceData.rawTabs.find((entry) => entry.key === "creditsSummary");
  const policySource = sourceData.rawTabs.find((entry) => entry.key === "policyType");

  if (!paymentSource) {
    throw new Error("Payment Summary report data was not returned.");
  }

  if (!creditSource) {
    throw new Error("Credits Summary report data was not returned.");
  }

  if (!policySource) {
    throw new Error("Policy Type report data was not returned.");
  }

  const policyLookup = buildPolicyLookup(policySource.rows);

  const paymentRows = paymentSource.rows.map((row) => {
    const certificateNumber = normalizeCertificate(row.certificateNumber);
    const policy = resolvePolicyDetails(certificateNumber, row, policyLookup);

    return {
      sourceKey: "paymentSummary",
      transactionType: deriveTransactionType(row.payType, row.amount),
      transactionDate: row.transactionDate,
      certificateNumber,
      payType: row.payType,
      amount: row.amount,
      members: policy.members,
      checkNumber: String(row.checkNumber ?? "").trim(),
      authCode: String(row.authCode ?? "").trim(),
      approval: String(row.approval ?? "").trim(),
      gatewayTxnId: String(row.gatewayTxnId ?? "").trim(),
      gatewayResponseMessage: String(row.gatewayResponseMessage ?? "").trim(),
      reasonForCredit: String(
        row.reasonForCredit ?? row.gatewayResponseMessage2 ?? ""
      ).trim(),
      policyType: policy.policyType,
      sourceRow: row,
    };
  });

  const creditRows = creditSource.rows.map((row) => {
    const certificateNumber = normalizeCertificate(row.certificateNumber);
    const policy = resolvePolicyDetails(certificateNumber, row, policyLookup);

    return {
      sourceKey: "creditsSummary",
      transactionType: deriveTransactionType(row.payType, row.amount),
      transactionDate: row.transactionDate,
      certificateNumber,
      payType: row.payType,
      amount: row.amount,
      members: policy.members,
      checkNumber: String(row.checkNumber ?? "").trim(),
      authCode: "",
      approval: String(row.approval ?? "").trim(),
      gatewayTxnId: "",
      gatewayResponseMessage: "",
      reasonForCredit: String(row.reasonForCredit ?? "").trim(),
      policyType: policy.policyType,
      sourceRow: row,
    };
  });

  const combinedRows = [...paymentRows, ...creditRows];
  const normalizedSourceRows = [
    ...paymentRows.map((row) => ({
      transactionDate: row.transactionDate,
      certificateNumber: row.certificateNumber,
      payType: row.payType,
      amount: row.amount,
      checkNumber: row.checkNumber,
      authCode: row.authCode,
      approval: row.approval,
      gatewayTxnId: row.gatewayTxnId,
      reasonForCredit: row.reasonForCredit,
    })),
    ...creditRows.map((row) => ({
      transactionDate: row.transactionDate,
      certificateNumber: row.certificateNumber,
      payType: row.payType,
      amount: row.amount,
      checkNumber: row.checkNumber,
      authCode: row.authCode,
      approval: row.approval,
      gatewayTxnId: row.gatewayTxnId,
      reasonForCredit: row.reasonForCredit,
    })),
  ];
  const totalAmount = roundCurrency(
    combinedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );
  const systemChecks = buildSystemChecks(normalizedSourceRows, combinedRows, totalAmount);

  return {
    reportType: "transaction-detail",
    reportName: "AHA HPA Transaction Detail Report",
    reportMonth,
    reportMonthLabel: formatReportMonth(reportMonth),
    generatedAt: new Date().toISOString(),
    source: sourceData.source,
    configuredReports: sourceData.configuredReports || [],
    columns: DETAIL_COLUMNS,
    totals: {
      rowCount: combinedRows.length,
      amount: totalAmount,
    },
    systemChecks,
    sourceSheets: {
      paymentSummary: paymentSource.rows,
      creditsSummary: creditSource.rows,
      policyType: policySource.rows,
    },
    rows: combinedRows,
  };
}

function buildPaymentSheetXml(templateXml, rows) {
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:11" x14ac:dyDescent="0.25">` +
      buildInlineStringCell("A1", 1, "Certificate") +
      buildInlineStringCell("B1", 1, "Date Received") +
      buildInlineStringCell("C1", 1, "Type Received") +
      buildInlineStringCell("D1", 1, "Amount Received") +
      buildInlineStringCell("E1", 1, "Check #") +
      buildInlineStringCell("F1", 1, "Auth Code") +
      buildInlineStringCell("G1", 1, "Issuer Response Text") +
      buildInlineStringCell("H1", 1, "Gateway Txn ID") +
      buildInlineStringCell("I1", 1, "Gateway Response Message") +
      buildInlineStringCell("J1", 1, "Gateway Response Message2") +
      buildInlineStringCell("K1", 1, "Column1") +
    `</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:11" x14ac:dyDescent="0.25">` +
        buildInlineStringCell(`A${rowNumber}`, 0, row.certificateNumber) +
        buildNumberCell(`B${rowNumber}`, 3, toExcelDateNumber(row.transactionDate)) +
        buildInlineStringCell(`C${rowNumber}`, 0, String(row.typeReceived ?? "")) +
        buildNumberCell(`D${rowNumber}`, 0, row.amount) +
        buildInlineStringCell(`E${rowNumber}`, 0, row.checkNumber) +
        buildInlineStringCell(`F${rowNumber}`, 0, row.authCode) +
        buildInlineStringCell(`G${rowNumber}`, 0, row.approval) +
        buildInlineStringCell(`H${rowNumber}`, 0, row.gatewayTxnId) +
        buildInlineStringCell(`I${rowNumber}`, 0, row.gatewayResponseMessage) +
        buildInlineStringCell(
          `J${rowNumber}`,
          0,
          String(row.gatewayResponseMessage2 ?? row.reasonForCredit ?? "")
        ) +
        buildInlineStringCell(`K${rowNumber}`, 0, row.payType) +
      `</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);

  return templateXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:K${lastRow}"/>`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetRows.join("")}</sheetData>`);
}

function buildCreditsSheetXml(templateXml, rows) {
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:9" x14ac:dyDescent="0.25">` +
      buildInlineStringCell("A1", 1, "Certificate: Certificate Name") +
      buildInlineStringCell("B1", 1, "Date Refunded") +
      buildInlineStringCell("C1", 1, "Amount") +
      buildInlineStringCell("D1", 1, "Check No") +
      buildInlineStringCell("E1", 1, "Credit Batch ID (Approval)") +
      buildInlineStringCell("F1", 1, "Credit Reason Code") +
      buildInlineStringCell("G1", 1, "Type") +
      buildInlineStringCell("H1", 1, "Column1") +
      buildInlineStringCell("I1", 1, "Column2") +
    `</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:9" x14ac:dyDescent="0.25">` +
        buildInlineStringCell(`A${rowNumber}`, 0, row.certificateNumber) +
        buildNumberCell(`B${rowNumber}`, 3, toExcelDateNumber(row.transactionDate)) +
        buildNumberCell(`C${rowNumber}`, 0, Math.abs(row.amount)) +
        buildInlineStringCell(`D${rowNumber}`, 0, row.checkNumber) +
        buildInlineStringCell(`E${rowNumber}`, 0, row.approval) +
        buildInlineStringCell(`F${rowNumber}`, 0, row.reasonForCredit) +
        buildInlineStringCell(`G${rowNumber}`, 0, row.type) +
        buildNumberCell(`H${rowNumber}`, 29, row.amount) +
        buildInlineStringCell(`I${rowNumber}`, 29, row.payType) +
      `</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);

  return templateXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:I${lastRow}"/>`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetRows.join("")}</sheetData>`)
    .replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>/, "");
}

function buildPolicySheetXml(templateXml, rows) {
  const sheetRows = [];

  sheetRows.push(
    `<row r="1" spans="1:3" x14ac:dyDescent="0.25">` +
      buildInlineStringCell("A1", 1, "Certificate: Certificate Name") +
      buildInlineStringCell("B1", 1, "Policy Type") +
      buildInlineStringCell("C1", 1, "Column1") +
    `</row>`
  );

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    sheetRows.push(
      `<row r="${rowNumber}" spans="1:3" x14ac:dyDescent="0.25">` +
        buildInlineStringCell(`A${rowNumber}`, 0, row.certificateNumber) +
        buildInlineStringCell(`B${rowNumber}`, 0, row.policyType) +
        buildInlineStringCell(`C${rowNumber}`, 0, row.members) +
      `</row>`
    );
  });

  const lastRow = Math.max(rows.length + 1, 1);

  return templateXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:C${lastRow}"/>`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetRows.join("")}</sheetData>`);
}

function buildFinalSheetXml(templateXml, report) {
  const rows = [];
  const lastDataRow = Math.max(report.rows.length + 2, 3);

  rows.push(
    `<row r="1" spans="1:13" s="21" customFormat="1" x14ac:dyDescent="0.25">` +
      buildInlineStringCell("A1", 11, "Certificate Number") +
      buildInlineStringCell("B1", 11, "Transaction Type") +
      buildInlineStringCell("C1", 12, "Transaction Date") +
      buildInlineStringCell("D1", 11, "Certificate Number") +
      buildInlineStringCell("E1", 11, "Pay Type") +
      buildInlineStringCell("F1", 7, "Amount") +
      buildInlineStringCell("G1", 11, "Members") +
      buildInlineStringCell("H1", 11, "Check #") +
      buildInlineStringCell("I1", 13, "Auth Code") +
      buildInlineStringCell("J1", 11, "APPROVAL") +
      buildInlineStringCell("K1", 11, "Gateway Txn ID") +
      buildInlineStringCell("L1", 11, "Gateway Response Message") +
      buildInlineStringCell("M1", 11, "Reason_for_Credit__c") +
    `</row>`
  );

  rows.push(
    `<row r="2" spans="1:13" s="21" customFormat="1" x14ac:dyDescent="0.25">` +
      buildBlankCell("A2", 11) +
      buildBlankCell("B2", 11) +
      buildBlankCell("C2", 12) +
      buildBlankCell("D2", 11) +
      buildBlankCell("E2", 11) +
      `<c r="F2" s="8"><f>SUM(F3:F${lastDataRow})</f><v>${report.totals.amount}</v></c>` +
      buildBlankCell("G2", 11) +
      buildBlankCell("H2", 11) +
      buildBlankCell("I2", 11) +
      buildBlankCell("J2", 13) +
      buildBlankCell("K2", 11) +
      buildBlankCell("L2", 11) +
      buildBlankCell("M2", 11) +
    `</row>`
  );

  report.rows.forEach((entry, index) => {
    const rowNumber = index + 3;
    const striped = index % 2 === 0;
    const helperStyle = striped ? 14 : 23;
    const dateStyle = striped ? 37 : 38;
    const certStyle = striped ? 31 : 34;
    const payTypeStyle = striped ? 33 : 36;
    const amountStyle = striped ? 32 : 35;

    rows.push(
      `<row r="${rowNumber}" spans="1:13" x14ac:dyDescent="0.25">` +
        buildInlineStringCell(`A${rowNumber}`, helperStyle, entry.certificateNumber) +
        buildInlineStringCell(`B${rowNumber}`, 14, entry.transactionType) +
        buildNumberCell(`C${rowNumber}`, dateStyle, toExcelDateNumber(entry.transactionDate)) +
        buildInlineStringCell(`D${rowNumber}`, certStyle, entry.certificateNumber) +
        buildInlineStringCell(`E${rowNumber}`, payTypeStyle, entry.payType) +
        buildNumberCell(`F${rowNumber}`, amountStyle, entry.amount) +
        buildInlineStringCell(`G${rowNumber}`, 14, entry.members) +
        buildInlineStringCell(`H${rowNumber}`, 15, entry.checkNumber) +
        buildInlineStringCell(`I${rowNumber}`, 15, entry.authCode) +
        buildInlineStringCell(`J${rowNumber}`, 15, entry.approval) +
        buildInlineStringCell(`K${rowNumber}`, 15, entry.gatewayTxnId) +
        buildInlineStringCell(`L${rowNumber}`, 15, entry.gatewayResponseMessage) +
        buildInlineStringCell(`M${rowNumber}`, 15, entry.reasonForCredit) +
      `</row>`
    );
  });

  const lastRow = Math.max(report.rows.length + 2, 2);

  return templateXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:M${lastRow}"/>`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${rows.join("")}</sheetData>`);
}

function buildTableXml(tableXml, ref) {
  return tableXml
    .replace(/ref="[^"]*"/, `ref="${ref}"`)
    .replace(/<autoFilter ref="[^"]*"/, `<autoFilter ref="${ref}"`);
}

function buildWorkbookXml(workbookXml, finalRowCount) {
  return workbookXml.replace(
    /<definedName name="_xlnm\._FilterDatabase"[\s\S]*?<\/definedName>/,
    `<definedName name="_xlnm._FilterDatabase" localSheetId="4" hidden="1">Sheet1!$A$1:$M$${finalRowCount}</definedName>`
  );
}

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

function buildDetailWorkbook(report, destinationPath) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Workbook template not found: ${TEMPLATE_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-detail-workbook-"));
  const templateZipPath = path.join(tempDir, "template.zip");
  const extractDir = path.join(tempDir, "unzipped");
  const workingZipPath = path.join(tempDir, "output.zip");

  fs.copyFileSync(TEMPLATE_PATH, templateZipPath);

  runPowerShell(
    `Expand-Archive -LiteralPath '${templateZipPath}' -DestinationPath '${extractDir}' -Force`
  );

  const paymentSheetPath = path.join(extractDir, "xl", "worksheets", "sheet2.xml");
  const creditsSheetPath = path.join(extractDir, "xl", "worksheets", "sheet3.xml");
  const policySheetPath = path.join(extractDir, "xl", "worksheets", "sheet4.xml");
  const finalSheetPath = path.join(extractDir, "xl", "worksheets", "sheet5.xml");
  const table1Path = path.join(extractDir, "xl", "tables", "table1.xml");
  const table2Path = path.join(extractDir, "xl", "tables", "table2.xml");
  const table3Path = path.join(extractDir, "xl", "tables", "table3.xml");
  const workbookPath = path.join(extractDir, "xl", "workbook.xml");
  const workbookRelsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
  const contentTypesPath = path.join(extractDir, "[Content_Types].xml");
  const calcChainPath = path.join(extractDir, "xl", "calcChain.xml");

  fs.writeFileSync(
    paymentSheetPath,
    buildPaymentSheetXml(fs.readFileSync(paymentSheetPath, "utf8"), report.sourceSheets.paymentSummary),
    "utf8"
  );
  fs.writeFileSync(
    creditsSheetPath,
    buildCreditsSheetXml(fs.readFileSync(creditsSheetPath, "utf8"), report.sourceSheets.creditsSummary),
    "utf8"
  );
  fs.writeFileSync(
    policySheetPath,
    buildPolicySheetXml(fs.readFileSync(policySheetPath, "utf8"), report.sourceSheets.policyType),
    "utf8"
  );
  fs.writeFileSync(
    finalSheetPath,
    buildFinalSheetXml(fs.readFileSync(finalSheetPath, "utf8"), report),
    "utf8"
  );

  fs.writeFileSync(
    table1Path,
    buildTableXml(
      fs.readFileSync(table1Path, "utf8"),
      `A1:K${Math.max(report.sourceSheets.paymentSummary.length + 1, 1)}`
    ),
    "utf8"
  );
  fs.writeFileSync(
    table2Path,
    buildTableXml(
      fs.readFileSync(table2Path, "utf8"),
      `A1:I${Math.max(report.sourceSheets.creditsSummary.length + 1, 1)}`
    ),
    "utf8"
  );
  fs.writeFileSync(
    table3Path,
    buildTableXml(
      fs.readFileSync(table3Path, "utf8"),
      `A1:C${Math.max(report.sourceSheets.policyType.length + 1, 1)}`
    ),
    "utf8"
  );

  fs.writeFileSync(
    workbookPath,
    buildWorkbookXml(fs.readFileSync(workbookPath, "utf8"), Math.max(report.rows.length + 2, 2)),
    "utf8"
  );

  if (fs.existsSync(workbookRelsPath)) {
    fs.writeFileSync(
      workbookRelsPath,
      fs
        .readFileSync(workbookRelsPath, "utf8")
        .replace(
          /<Relationship Id="rId9" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/calcChain" Target="calcChain\.xml"\/>/,
          ""
        ),
      "utf8"
    );
  }

  if (fs.existsSync(contentTypesPath)) {
    fs.writeFileSync(
      contentTypesPath,
      fs
        .readFileSync(contentTypesPath, "utf8")
        .replace(
          /<Override PartName="\/xl\/calcChain\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.calcChain\+xml"\/>/,
          ""
        ),
      "utf8"
    );
  }

  if (fs.existsSync(calcChainPath)) {
    fs.rmSync(calcChainPath, { force: true });
  }

  runPowerShell(
    `Compress-Archive -Path '${path.join(extractDir, "*")}' -DestinationPath '${workingZipPath}' -Force`
  );

  fs.copyFileSync(workingZipPath, destinationPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function buildPrintableHtml(report) {
  const failedChecks = (report.systemChecks || []).filter((check) => check.status === "failed");
  const differingTransactions = failedChecks.flatMap(
    (check) => check.differingTransactions || []
  );
  const summaryRow = `
        <tr class="summary-row">
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td class="amount">${Number(report.totals.amount).toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })}</td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
        </tr>`;
  const rows = report.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeXml(row.transactionType)}</td>
          <td>${escapeXml(row.transactionDate)}</td>
          <td>${escapeXml(row.certificateNumber)}</td>
          <td>${escapeXml(row.payType)}</td>
          <td class="amount">${Number(row.amount).toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })}</td>
          <td>${escapeXml(row.members)}</td>
          <td>${escapeXml(row.checkNumber)}</td>
          <td>${escapeXml(row.authCode)}</td>
          <td>${escapeXml(row.approval)}</td>
          <td>${escapeXml(row.gatewayTxnId)}</td>
          <td>${escapeXml(row.gatewayResponseMessage)}</td>
          <td>${escapeXml(row.reasonForCredit)}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AHA HPA Transaction Detail - ${escapeXml(report.reportMonthLabel)}</title>
    <style>
      @page { size: landscape; margin: 0.25in; }
      body { font-family: Georgia, "Times New Roman", serif; margin: 24px; color: #2c1a08; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 10px; }
      .detail-print-area { width: 100%; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: fixed; }
      th, td { border-bottom: 1px solid #d9c7ad; padding: 5px 6px; text-align: left; font-size: 10px; line-height: 1.15; vertical-align: top; word-break: break-word; overflow-wrap: anywhere; }
      th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
      .amount { text-align: right; }
      .summary-row td { border-top: 1px solid #d9c7ad; font-weight: 700; }
      @media print {
        body { margin: 0; }
      }
    </style>
  </head>
  <body>
    <div class="detail-print-area">
      <h1>AHA HPA Transaction Detail Report</h1>
      <p><strong>Report Month:</strong> ${escapeXml(report.reportMonthLabel)}</p>
      <p><strong>Generated:</strong> ${escapeXml(new Date(report.generatedAt).toLocaleString("en-US"))}</p>
      <p><strong>Source:</strong> ${escapeXml(report.source)}</p>
      ${
        failedChecks.length > 0
          ? `<div style="margin-top:16px;padding:12px 14px;border:1px solid #d4a373;background:#fff4e6;">
            <strong>System Check Note</strong>
            <p style="margin-top:8px;">${escapeXml(failedChecks[0].note)}</p>
            <p style="margin-top:8px;">Expected source total: ${escapeXml(
              failedChecks[0].sourceTotal.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })
            )}. Sheet1 F2: ${escapeXml(
              failedChecks[0].sheetTotal.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })
            )}.</p>
          </div>
          ${
            differingTransactions.length > 0
              ? `<table style="margin-top:16px;">
                  <thead>
                    <tr>
                      <th>Difference</th>
                      <th>Transaction Date</th>
                      <th>Certificate Number</th>
                      <th>Pay Type</th>
                      <th>Amount</th>
                      <th>Check #</th>
                      <th>APPROVAL</th>
                      <th>Reason_for_Credit__c</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${differingTransactions
                      .map(
                        (entry) => `
                          <tr>
                            <td>${escapeXml(entry.kind)}</td>
                            <td>${escapeXml(entry.transactionDate)}</td>
                            <td>${escapeXml(entry.certificateNumber)}</td>
                            <td>${escapeXml(entry.payType)}</td>
                            <td class="amount">${Number(entry.amount).toLocaleString("en-US", {
                              style: "currency",
                              currency: "USD",
                            })}</td>
                            <td>${escapeXml(entry.checkNumber)}</td>
                            <td>${escapeXml(entry.approval)}</td>
                            <td>${escapeXml(entry.reasonForCredit)}</td>
                          </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>`
              : ""
          }`
          : ""
      }
      <table>
        <thead>
          <tr>
            <th>Transaction Type</th>
            <th>Transaction Date</th>
            <th>Certificate Number</th>
            <th>Pay Type</th>
            <th>Amount</th>
            <th>Members</th>
            <th>Check #</th>
            <th>Auth Code</th>
            <th>APPROVAL</th>
            <th>Gateway Txn ID</th>
            <th>Gateway Response Message</th>
            <th>Reason_for_Credit__c</th>
          </tr>
        </thead>
        <tbody>${summaryRow}${rows}</tbody>
      </table>
    </div>
  </body>
</html>`;
}

function writeDetailArtifacts(runDir, report) {
  const filePrefix = formatReportMonthFilePrefix(report.reportMonth);
  const workbookFileName = `${filePrefix}_AHA HPA Transaction Detail.xlsx`;
  const pdfFileName = `${filePrefix}_AHA HPA Transaction Detail.pdf`;
  const htmlFileName = `${filePrefix}_AHA HPA Transaction Detail.html`;
  const jsonFileName = `${filePrefix}_AHA HPA Transaction Detail.json`;
  const printableHtml = buildPrintableHtml(report);

  buildDetailWorkbook(report, path.join(runDir, workbookFileName));
  const printableArtifact = createPrintableArtifactFromHtml({
    html: printableHtml,
    outputDir: runDir,
    pdfFileName,
    htmlFileName,
  });
  if (printableArtifact.warning) {
    report.printArtifactWarning = printableArtifact.warning;
  }
  fs.writeFileSync(path.join(runDir, jsonFileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return [
    {
      kind: "spreadsheet",
      label: "Download Workbook",
      fileName: workbookFileName,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    printableArtifact.artifact,
    {
      kind: "json",
      label: "Download JSON",
      fileName: jsonFileName,
      contentType: "application/json; charset=utf-8",
    },
  ];
}

module.exports = {
  DETAIL_COLUMNS,
  buildDetailWorkbook,
  buildTransactionDetailReport,
  writeDetailArtifacts,
};
