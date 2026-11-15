const fs = require("fs");
const path = require("path");
const { fetchSObjectDescribe, getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

async function main() {
  const runs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "bill-runs.json"), "utf8"));
  const list = Array.isArray(runs) ? runs : runs.runs || [];
  const run = list.find((entry) => entry.runCode === "BILL-2026-12") || list[0];
  const ids = (run?.corrections?.bill2 || []).slice(0, 10).map((row) => row.policyId).filter(Boolean);
  if (!ids.length) throw new Error("No Bill 2 correction policy IDs were found.");
  const fields = [
    "Id", "Name", "Pay_Type__c", "Payment_Method__c", "Policy_Type__c", "Total_Monthly_Premium__c", "P1__c",
    "Orig_Monthly_Premium__c", "Add_l_Monthly_Premium__c",
    "Total_Monthly_Premium_1_Person_PL__c", "Total_Monthly_Premium_2_Person__c",
  ];
  const query = `SELECT ${fields.join(",")} FROM Policy__c WHERE Id IN (${ids.map((id) => `'${id}'`).join(",")})`;
  const token = await getConnectedSalesforceToken();
  const describe = await fetchSObjectDescribe(token, "Policy__c");
  const response = await salesforceRequest(token, `/services/data/v61.0/query?q=${encodeURIComponent(query)}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.[0]?.message || payload?.message || "Unable to query Bill 2 premiums.");
  process.stdout.write(`${JSON.stringify({
    payTypePicklistValues: describe.fields.find((field) => field.name === "Pay_Type__c")?.picklistValues?.filter((entry) => entry.active).map(({ label, value, defaultValue }) => ({ label, value, defaultValue })) || [],
    paymentMethodPicklistValues: describe.fields.find((field) => field.name === "Payment_Method__c")?.picklistValues?.filter((entry) => entry.active).map(({ label, value, defaultValue }) => ({ label, value, defaultValue })) || [],
    discountField: (() => { const field = describe.fields.find((entry) => entry.name === "Discount__c"); return field ? { name: field.name, type: field.type, updateable: field.updateable, calculated: field.calculated, calculatedFormula: field.calculatedFormula } : null; })(),
    formulas: describe.fields.filter((field) => ["P1__c", "Orig_Monthly_Premium__c", "Total_Monthly_Premium__c"].includes(field.name)).map((field) => ({ name: field.name, calculated: field.calculated, calculatedFormula: field.calculatedFormula })),
    records: (payload.records || []).map((record) => Object.fromEntries(fields.map((field) => [field, record[field]]))),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
