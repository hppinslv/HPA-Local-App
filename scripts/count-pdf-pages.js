const fs = require("fs");
const { PDFDocument } = require("pdf-lib");

async function main() {
  const [filePath] = process.argv.slice(2);
  if (!filePath) throw new Error("Usage: node count-pdf-pages.js <file.pdf>");
  const document = await PDFDocument.load(fs.readFileSync(filePath));
  process.stdout.write(String(document.getPageCount()));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
