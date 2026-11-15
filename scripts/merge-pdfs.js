const fs = require("fs");
const { PDFDocument } = require("pdf-lib");

async function main() {
  const [outputPath, ...inputPaths] = process.argv.slice(2);
  if (!outputPath || !inputPaths.length) throw new Error("Usage: node merge-pdfs.js <output.pdf> <input1.pdf> [input2.pdf ...]");
  const merged = await PDFDocument.create();
  for (const inputPath of inputPaths) {
    const source = await PDFDocument.load(fs.readFileSync(inputPath));
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  fs.writeFileSync(outputPath, await merged.save());
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
