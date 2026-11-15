const { getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

const PREMIUM_FIELD = "Total_Monthly_Premium__c";

async function readPremium(token, id) {
  const response = await salesforceRequest(token, `/services/data/v61.0/sobjects/Policy__c/${encodeURIComponent(id)}?fields=${PREMIUM_FIELD}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload[0]?.message || payload.message || `Unable to read ${id}.`);
  return Number(payload[PREMIUM_FIELD]);
}

async function main() {
  const changes = process.argv.slice(2).map((argument) => {
    const match = String(argument).match(/^([A-Za-z0-9]{15,18})=(\d+(?:\.\d{1,2})?)$/);
    if (!match) throw new Error("Use SalesforceId=amount for each premium restoration.");
    return { id: match[1], expected: Number(match[2]) };
  });
  if (!changes.length) throw new Error("At least one premium restoration is required.");
  const token = await getConnectedSalesforceToken();
  const results = [];
  for (const change of changes) {
    const before = await readPremium(token, change.id);
    const response = await salesforceRequest(token, `/services/data/v61.0/sobjects/Policy__c/${encodeURIComponent(change.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ [PREMIUM_FIELD]: change.expected }),
    });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* use fallback */ }
      throw new Error(payload?.[0]?.message || payload?.message || `Unable to restore ${change.id}.`);
    }
    const after = await readPremium(token, change.id);
    if (after !== change.expected) throw new Error(`Premium verification failed for ${change.id}.`);
    results.push({ id: change.id, before, restored: after, verified: true });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
