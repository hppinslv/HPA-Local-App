const {
  applyBill2Corrections,
  pullBill2Corrections,
} = require("../services/billCorrectionServiceV2");

async function main() {
  const idArgument = process.argv.find((argument) => argument.startsWith("--id="));
  const requestedId = idArgument ? idArgument.slice(5).trim() : "";
  if (requestedId && !/^[A-Za-z0-9]{15,18}$/.test(requestedId)) throw new Error("Invalid --id Salesforce record ID.");
  const report = await pullBill2Corrections("2026-12");
  const rows = requestedId ? report.rows.filter((row) => row.policyId === requestedId) : report.rows;
  if (requestedId && rows.length !== 1) throw new Error(`Expected one correction row for ${requestedId}, found ${rows.length}.`);
  const results = await applyBill2Corrections(rows);
  const failures = results.filter((row) => row.status === "Failed" || row.status === "Data Error");
  const premiumChanges = results.filter((row) => row.premiumBefore !== row.premiumAfter);
  const summary = {
    reportRows: report.rows.length,
    processed: results.length,
    updatedAndVerified: results.filter((row) => row.status === "Updated and Verified").length,
    unchangedAndVerified: results.filter((row) => row.status === "Unchanged and Verified").length,
    failures: failures.length,
    premiumChanges: premiumChanges.length,
    failureSamples: failures.slice(0, 10).map(({ policyId, error }) => ({ policyId, error })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures.length || premiumChanges.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
