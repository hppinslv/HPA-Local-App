const { getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

async function main() {
  const name = String(process.argv[2] || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error("Provide one Apex class name.");
  const token = await getConnectedSalesforceToken();
  const query = `SELECT Id, Name, Body FROM ApexClass WHERE Name = '${name}' LIMIT 1`;
  const response = await salesforceRequest(token, `/services/data/v61.0/tooling/query?q=${encodeURIComponent(query)}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload[0]?.message || payload.message || "Unable to query Apex class.");
  const apexClass = payload.records?.[0];
  if (!apexClass) throw new Error(`Apex class ${name} was not found.`);
  process.stdout.write(`${apexClass.Body}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
