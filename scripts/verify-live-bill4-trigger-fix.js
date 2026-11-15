const {
  applyBill4Corrections,
  pullBill4Corrections,
} = require("../services/billCorrectionServiceV2");

const EXPECTED = new Map([
  ["a00f400000QB0YFAA1", { contrib: 158000, nonContrib: 3000, premium: 54.82 }],
  ["a00f400000QB50VAAT", { contrib: 123000, nonContrib: 3000, premium: 36.13 }],
]);

async function main() {
  const report = await pullBill4Corrections("2026-12");
  const rows = report.rows.filter((row) => EXPECTED.has(row.policyId));
  if (rows.length !== EXPECTED.size) {
    throw new Error(`Expected ${EXPECTED.size} controlled Bill 4 rows but found ${rows.length}.`);
  }
  const results = await applyBill4Corrections(rows);
  for (const result of results) {
    const expected = EXPECTED.get(result.policyId);
    const verified = result.status === "Updated and Verified"
      && result.verifiedContrib === expected.contrib
      && result.verifiedNonContrib === expected.nonContrib
      && result.premiumBefore === expected.premium
      && result.premiumAfter === expected.premium
      && result.premiumRestored === false;
    if (!verified) {
      throw new Error(`Live Bill 4 verification failed for ${result.policyId}: ${JSON.stringify(result)}`);
    }
  }
  process.stdout.write(`${JSON.stringify(results.map((result) => ({
    policyId: result.policyId,
    status: result.status,
    verifiedContrib: result.verifiedContrib,
    verifiedNonContrib: result.verifiedNonContrib,
    premiumBefore: result.premiumBefore,
    premiumAfter: result.premiumAfter,
    premiumRestored: result.premiumRestored,
  })), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
