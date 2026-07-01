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

function resolvePdfBrowserPath() {
  return PDF_BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || "";
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
  generatePdfFromHtml,
  resolvePdfBrowserPath,
};
