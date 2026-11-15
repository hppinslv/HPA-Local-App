const { getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

const FIELDS = {
  contrib: "Orig_Contrib_AD_D_Coverage_Amt__c",
  nonContrib: "Orig_Non_Contrib_AD_D_Coverage_Amt__c",
  premium: "Total_Monthly_Premium__c",
};

async function readPolicy(token, id) {
  const names = Object.values(FIELDS);
  const response = await salesforceRequest(token, `/services/data/v61.0/sobjects/Policy__c/${encodeURIComponent(id)}?fields=${encodeURIComponent(names.join(","))}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload[0]?.message || payload.message || `Unable to read ${id}.`);
  return payload;
}

async function main() {
  const rollbacks = process.argv.slice(2).map((argument) => {
    const match = String(argument).match(/^([A-Za-z0-9]{15,18})=(\d+(?:\.\d{1,2})?),(\d+(?:\.\d{1,2})?),(\d+(?:\.\d{1,2})?)$/);
    if (!match) throw new Error("Use SalesforceId=contrib,nonContrib,premium for each rollback.");
    return { id: match[1], contrib: Number(match[2]), nonContrib: Number(match[3]), premium: Number(match[4]) };
  });
  if (!rollbacks.length) throw new Error("At least one rollback is required.");
  const token = await getConnectedSalesforceToken();
  const results = [];
  for (const rollback of rollbacks) {
    const before = await readPolicy(token, rollback.id);
    const response = await salesforceRequest(token, `/services/data/v61.0/sobjects/Policy__c/${encodeURIComponent(rollback.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ [FIELDS.contrib]: rollback.contrib, [FIELDS.nonContrib]: rollback.nonContrib }),
    });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* use fallback */ }
      throw new Error(payload?.[0]?.message || payload?.message || `Unable to roll back ${rollback.id}.`);
    }
    const after = await readPolicy(token, rollback.id);
    const verified = Number(after[FIELDS.contrib]) === rollback.contrib && Number(after[FIELDS.nonContrib]) === rollback.nonContrib && Number(after[FIELDS.premium]) === rollback.premium;
    if (!verified) throw new Error(`Rollback verification failed for ${rollback.id}: ${JSON.stringify(after)}`);
    results.push({ id: rollback.id, before: { contrib: before[FIELDS.contrib], nonContrib: before[FIELDS.nonContrib], premium: before[FIELDS.premium] }, restored: { contrib: after[FIELDS.contrib], nonContrib: after[FIELDS.nonContrib], premium: after[FIELDS.premium] }, verified });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
