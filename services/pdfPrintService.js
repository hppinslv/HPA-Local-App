const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const PDF_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const WORD_CANDIDATES = [
  "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  "C:\\Program Files\\Microsoft Office\\Office16\\WINWORD.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\Office16\\WINWORD.EXE",
];

function quotePowerShellLiteral(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function resolvePdfBrowserPath() {
  return PDF_BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolveWordPath() {
  return WORD_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || "";
}

function generatePdfFromHtml(html, pdfPath) {
  const browserPath = resolvePdfBrowserPath();
  if (!browserPath) {
    throw new Error("A PDF browser engine was not found. Install Microsoft Edge or Google Chrome to generate PDF output.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-print-pdf-"));
  const htmlPath = path.join(tempDir, "print.html");

  try {
    fs.writeFileSync(htmlPath, html, "utf8");
    const fileUrl = pathToFileURL(htmlPath).toString();
    const result = spawnSync(
      browserPath,
      [
        "--headless",
        "--disable-gpu",
        "--allow-file-access-from-files",
        "--print-to-pdf-no-header",
        `--print-to-pdf=${pdfPath}`,
        fileUrl,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
      }
    );

    if (result.status !== 0 || !fs.existsSync(pdfPath)) {
      throw new Error(
        result.stderr?.trim() || result.stdout?.trim() || "Unable to generate PDF output."
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function generatePdfFromDocx(docxPath, pdfPath) {
  const wordPath = resolveWordPath();
  if (!wordPath) {
    throw new Error("Microsoft Word was not found. Install Word to generate the final summary letter PDF.");
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$word = $null",
    "$document = $null",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $word.Visible = $false",
    `  $document = $word.Documents.Open('${quotePowerShellLiteral(docxPath)}', $false, $true)`,
    `  $document.SaveAs([ref] '${quotePowerShellLiteral(pdfPath)}', [ref] 17)`,
    "} finally {",
    "  if ($document -ne $null) { $document.Close([ref] 0) }",
    "  if ($word -ne $null) { $word.Quit() }",
    "  [System.GC]::Collect()",
    "  [System.GC]::WaitForPendingFinalizers()",
    "}",
  ].join("; ");

  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    }
  );

  if (result.status !== 0 || !fs.existsSync(pdfPath)) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || "Unable to generate PDF output from Word."
    );
  }
}

function createPrintableArtifactFromHtml({
  html,
  outputDir,
  pdfFileName,
  htmlFileName,
}) {
  const pdfPath = path.join(outputDir, pdfFileName);

  try {
    generatePdfFromHtml(html, pdfPath);
    return {
      artifact: {
        kind: "print",
        label: "Download PDF",
        fileName: pdfFileName,
        contentType: "application/pdf",
      },
      warning: "",
    };
  } catch (error) {
    const fallbackFileName = htmlFileName || pdfFileName.replace(/\.pdf$/i, ".html");
    fs.writeFileSync(path.join(outputDir, fallbackFileName), html, "utf8");
    return {
      artifact: {
        kind: "print",
        label: "Download Printable HTML",
        fileName: fallbackFileName,
        contentType: "text/html; charset=utf-8",
      },
      warning: `PDF output was unavailable, so a printable HTML file was generated instead: ${error.message}`,
    };
  }
}

module.exports = {
  createPrintableArtifactFromHtml,
  generatePdfFromDocx,
  generatePdfFromHtml,
  resolvePdfBrowserPath,
  resolveWordPath,
};
