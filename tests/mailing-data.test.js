const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  DEFAULT_START_CASE_NUMBER,
  generateMailingDataWorkbook,
  previewMailingData,
} = require("../services/mailingDataService");

function loadUpload(fileName) {
  return {
    fileName,
    base64Content: fs.readFileSync(path.join(__dirname, "..", fileName)).toString("base64"),
  };
}

function runPowerShell(command) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "PowerShell command failed.");
  }
  return result.stdout;
}

function extractWorkbook(workbookPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-mailing-test-"));
  const zipPath = path.join(tempDir, "book.zip");
  const extractDir = path.join(tempDir, "unzipped");
  fs.copyFileSync(workbookPath, zipPath);
  runPowerShell(
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
  );
  return {
    tempDir,
    extractDir,
    sheetXml: fs.readFileSync(path.join(extractDir, "xl", "worksheets", "sheet1.xml"), "utf8"),
  };
}

function getRowXml(sheetXml, rowNumber) {
  const match = sheetXml.match(new RegExp(`<row[^>]*r="${rowNumber}"[^>]*>[\\s\\S]*?<\\/row>`));
  return match ? match[0] : "";
}

test("mailing data preview and workbook generation match the sample mailbag layout", () => {
  const uploads = [
    loadUpload("NHCL_6-4-26_54,312records.zip"),
    loadUpload("RFC_6-4-26_71,855records.zip"),
  ];

  const preview = previewMailingData({
    uploads,
    mailingMonth: "2026-07",
    startingCaseNumber: DEFAULT_START_CASE_NUMBER,
  });

  assert.equal(preview.totalRecords, 126167);
  assert.equal(preview.uploads[0].keyCode, "NHCL");
  assert.equal(preview.uploads[0].recordCount, 54312);
  assert.equal(preview.uploads[0].startingSequence, 1);
  assert.equal(preview.uploads[0].endingSequence, 54312);
  assert.equal(preview.uploads[1].keyCode, "RFC");
  assert.equal(preview.uploads[1].startingSequence, 54313);
  assert.equal(preview.uploads[1].endingSequence, 126167);
  assert.equal(preview.outputFileName, "202607_Mailbag_HPA.AHAv2.xlsx");

  const generated = generateMailingDataWorkbook({
    uploads,
    mailingMonth: "2026-07",
    startingCaseNumber: DEFAULT_START_CASE_NUMBER,
  });

  assert.equal(generated.historyEntry.totalRecords, 126167);
  assert.equal(fs.existsSync(generated.historyEntry.outputFilePath), true);

  const extracted = extractWorkbook(generated.historyEntry.outputFilePath);
  try {
    assert.match(extracted.sheetXml, /<dimension ref="A1:AN126168"/);
    assert.match(getRowXml(extracted.sheetXml, 1), /<c r="A1"[^>]*><v>0<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="Q2"><v>1<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="R2"><v>65782403<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="M2"[^>]*><is><t>NHCL<\/t><\/is><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="W2" s="23"><v>\d+<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="S2"(?: s="\d+")?><f>\(I2\+3\)\*1000<\/f><v>460000<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="T2"(?: s="\d+")?><f>\(I2\*0\.22\)\+19\.95<\/f><v>120\.49000000000001<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 2), /<c r="U2"(?: s="\d+")?><f>\(0\.33\*I2\)\+19\.95<\/f><v>170\.76<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 54313), /<c r="Q54313"><v>54312<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 54313), /<c r="M54313"[^>]*><is><t>NHCL<\/t><\/is><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 54314), /<c r="Q54314"><v>54313<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 54314), /<c r="M54314"[^>]*><is><t>RFC<\/t><\/is><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 126168), /<c r="Q126168"><v>126167<\/v><\/c>/);
    assert.match(getRowXml(extracted.sheetXml, 126168), /<c r="R126168"><v>65908569<\/v><\/c>/);
    assert.equal(/<row[^>]*r="126169"/.test(extracted.sheetXml), false);
  } finally {
    fs.rmSync(extracted.tempDir, { recursive: true, force: true });
  }
});
