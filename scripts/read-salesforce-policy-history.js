const { getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

async function main() {
  const ids = process.argv.slice(2).map((value) => String(value || "").trim()).filter(Boolean);
  if (!ids.length || ids.some((id) => !/^[a-zA-Z0-9]{15,18}$/.test(id))) throw new Error("Provide one or more Salesforce record IDs.");
  const quotedIds = ids.map((id) => `'${id}'`).join(",");
  const query = `SELECT ParentId, Field, OldValue, NewValue, CreatedDate FROM Policy__History WHERE ParentId IN (${quotedIds}) AND CreatedDate = TODAY ORDER BY CreatedDate DESC`;
  const token = await getConnectedSalesforceToken();
  const response = await salesforceRequest(token, `/services/data/v61.0/query?q=${encodeURIComponent(query)}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload[0]?.message || payload.message || "Unable to query policy history.");
  process.stdout.write(`${JSON.stringify({ totalSize: payload.totalSize, records: (payload.records || []).map(({ ParentId, Field, OldValue, NewValue, CreatedDate }) => ({ ParentId, Field, OldValue, NewValue, CreatedDate })) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
