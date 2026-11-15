const { fetchSObjectDescribe, getConnectedSalesforceToken, salesforceRequest } = require("../services/salesforceClient");

async function toolingQuery(token, query) {
  const response = await salesforceRequest(token, `/services/data/v61.0/tooling/query?q=${encodeURIComponent(query)}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload[0]?.message || payload.message || "Tooling API query failed.");
  return payload.records || [];
}

async function main() {
  const token = await getConnectedSalesforceToken();
  const describe = await fetchSObjectDescribe(token, "Policy__c");
  const bypassFields = describe.fields
    .filter((field) => /bypass|skip|disable|automation|recalc|recalcul|override/i.test(`${field.name} ${field.label}`))
    .map(({ name, label, type, updateable, calculated }) => ({ name, label, type, updateable, calculated }));
  const triggers = await toolingQuery(token, "SELECT Id, Name, Status, TableEnumOrId, Body FROM ApexTrigger WHERE TableEnumOrId = 'Policy__c'");
  const flows = await toolingQuery(token, "SELECT Id, Definition.DeveloperName, Status, ProcessType FROM Flow WHERE Status = 'Active'");
  process.stdout.write(`${JSON.stringify({
    bypassFields,
    triggers: triggers.map(({ Id, Name, Status, Body }) => ({
      Id, Name, Status,
      mentionsPremium: /Total_Monthly_Premium__c|P1__c/.test(Body || ""),
      relevantLines: String(Body || "").split(/\r?\n/).flatMap((line, index, lines) => /Total_Monthly_Premium__c\s*=\s*0|when 1\{policy\.Total_Monthly_Premium__c/i.test(line)
        ? lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 12)).map((contextLine, contextIndex) => `${Math.max(0, index - 8) + contextIndex + 1}: ${contextLine}`)
        : []).filter((line, index, lines) => index === 0 || line !== lines[index - 1]),
    })),
    activeFlows: flows.map((flow) => ({ Id: flow.Id, DeveloperName: flow.Definition?.DeveloperName, Status: flow.Status, ProcessType: flow.ProcessType })),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
