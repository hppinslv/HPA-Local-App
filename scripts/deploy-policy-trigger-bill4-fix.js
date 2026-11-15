const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  getConnectedSalesforceToken,
  salesforceRequest,
} = require("../services/salesforceClient");

const API_VERSION = "61.0";
const TRIGGER_NAME = "PolicyTrigger";
const TEST_CLASSES = ["PolicyTriggerTest", "PolicyTriggerBill4Test"];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tagValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function allTagValues(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "gi"))]
    .map((match) => decodeXml(match[1]));
}

async function toolingQuery(token, query) {
  const response = await salesforceRequest(
    token,
    `/services/data/v${API_VERSION}/tooling/query?q=${encodeURIComponent(query)}`,
    { method: "GET" },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.[0]?.message || payload?.message || "Salesforce Tooling API query failed.");
  }
  return payload.records || [];
}

function addBill4PremiumGuard(triggerBody) {
  const bill2Guard = `Boolean preserveBill2Premium = oldPolicy != null
                && String.valueOf(policy.Pay_Type__c) == '3'
                && policy.Pay_Type__c != oldPolicy.Pay_Type__c
                && policy.Orig_Contrib_AD_D_Coverage_Amt__c == oldPolicy.Orig_Contrib_AD_D_Coverage_Amt__c
                && policy.Orig_Non_Contrib_AD_D_Coverage_Amt__c == oldPolicy.Orig_Non_Contrib_AD_D_Coverage_Amt__c
                && policy.Add_l_AD_D_Coverage_Amt_NoReduction__c == oldPolicy.Add_l_AD_D_Coverage_Amt_NoReduction__c;`;
  if (triggerBody.includes("preserveBill4Premium") && triggerBody.includes("preserveBill2Premium")) return triggerBody;
  if (triggerBody.includes("preserveBill4Premium")) {
    const bill4Marker = "Boolean preserveBill4Premium = oldPolicy != null";
    const bill4Index = triggerBody.indexOf(bill4Marker);
    if (bill4Index < 0 || !triggerBody.includes("if(preserveBill4Premium){")) {
      throw new Error("The installed Bill 4 premium guard has an unexpected shape; no deployment was attempted.");
    }
    return `${triggerBody.slice(0, bill4Index)}${bill2Guard}\n            ${triggerBody.slice(bill4Index)}`
      .replace("if(preserveBill4Premium){", "if(preserveBill4Premium || preserveBill2Premium){");
  }
  const markerPattern = /if\s*\(\s*policy\.Add_l_Monthly_Premium__c\s*!=\s*null\s*&&\s*policy\.Orig_Monthly_Premium__c\s*!=\s*null\s*\)\s*\{/gi;
  const markers = [...triggerBody.matchAll(markerPattern)];
  if (markers.length !== 2) {
    throw new Error(`Expected exactly two premium recalculation blocks but found ${markers.length}; no deployment was attempted.`);
  }
  const marker = markers[1];
  const markerIndex = marker.index;

  const replacement = `Policy__c oldPolicy = Trigger.oldMap.get(policy.Id);
            Decimal expectedBill4Contrib = null;
            if(oldPolicy != null && oldPolicy.Orig_Contrib_AD_D_Coverage_Amt__c != null && oldPolicy.Orig_Non_Contrib_AD_D_Coverage_Amt__c != null){
                expectedBill4Contrib = oldPolicy.Orig_Contrib_AD_D_Coverage_Amt__c + oldPolicy.Orig_Non_Contrib_AD_D_Coverage_Amt__c - 3000;
                if(expectedBill4Contrib > 500000){
                    expectedBill4Contrib = 500000;
                }
            }
            Boolean preserveBill4Premium = oldPolicy != null
                && oldPolicy.Orig_Non_Contrib_AD_D_Coverage_Amt__c == 7000
                && policy.Orig_Non_Contrib_AD_D_Coverage_Amt__c == 3000
                && policy.Orig_Contrib_AD_D_Coverage_Amt__c == expectedBill4Contrib;
            ${bill2Guard}
            if(preserveBill4Premium || preserveBill2Premium){
                policy.Total_Monthly_Premium__c = oldPolicy.Total_Monthly_Premium__c;
            } else if(policy.Add_l_Monthly_Premium__c!=null && policy.Orig_Monthly_Premium__c!=null){`;

  return `${triggerBody.slice(0, markerIndex)}${replacement}${triggerBody.slice(markerIndex + marker[0].length)}`;
}

function bill4TestClass() {
  return `@isTest
public class PolicyTriggerBill4Test {
    @isTest
    static void preservesStoredPremiumForExactBill4Correction() {
        Account account = new Account(Name = 'Bill 4 Trigger Test');
        insert account;

        Policy__c policy = new Policy__c(
            Name = 'Bill4PremiumPreservation',
            Account__c = account.Id,
            Months__c = '1',
            Policy_Type__c = '1',
            Pay_Type__c = '3',
            Total_Monthly_Premium__c = 54.82,
            Rate_1__c = 0.22,
            Orig_Contrib_AD_D_Coverage_Amt__c = 154000,
            Orig_Non_Contrib_AD_D_Coverage_Amt__c = 7000,
            Add_l_AD_D_Coverage_Amt_NoReduction__c = 0,
            Add_l_Coverage_Rate_1_Person__c = 0
        );
        insert policy;

        policy = [
            SELECT Total_Monthly_Premium__c, Orig_Monthly_Premium__c,
                Add_l_Monthly_Premium__c, Total_Monthly_Premium_1_Person_PL__c,
                Orig_Contrib_AD_D_Coverage_Amt__c,
                Orig_Non_Contrib_AD_D_Coverage_Amt__c
            FROM Policy__c
            WHERE Id = :policy.Id
        ];
        System.assertNotEquals(null, policy.Orig_Monthly_Premium__c,
            'The test must exercise the premium recalculation path.');
        System.assertNotEquals(null, policy.Add_l_Monthly_Premium__c,
            'The test must exercise the premium recalculation path.');
        Decimal storedPremiumBefore = policy.Total_Monthly_Premium__c;

        policy.Orig_Contrib_AD_D_Coverage_Amt__c = 158000;
        policy.Orig_Non_Contrib_AD_D_Coverage_Amt__c = 3000;
        update policy;

        Policy__c corrected = [
            SELECT Total_Monthly_Premium__c, Total_Monthly_Premium_1_Person_PL__c,
                Orig_Contrib_AD_D_Coverage_Amt__c,
                Orig_Non_Contrib_AD_D_Coverage_Amt__c
            FROM Policy__c
            WHERE Id = :policy.Id
        ];
        System.assertNotEquals(storedPremiumBefore, corrected.Total_Monthly_Premium_1_Person_PL__c,
            'Changing coverage must change the calculated premium used by the ordinary trigger path.');
        System.assertEquals(storedPremiumBefore, corrected.Total_Monthly_Premium__c,
            'The exact Bill 4 correction must preserve the stored premium.');
        System.assertEquals(158000, corrected.Orig_Contrib_AD_D_Coverage_Amt__c);
        System.assertEquals(3000, corrected.Orig_Non_Contrib_AD_D_Coverage_Amt__c);
    }

    @isTest
    static void preservesStoredPremiumForBill2MonthlyBillCorrection() {
        Account account = new Account(Name = 'Bill 2 Trigger Test');
        insert account;
        Policy__c policy = new Policy__c(
            Name = 'Bill2PremiumPreservation',
            Account__c = account.Id,
            Months__c = '1',
            Policy_Type__c = '1',
            Pay_Type__c = 'Monthly Billing',
            Total_Monthly_Premium__c = 50,
            Rate_1__c = 0.22,
            Orig_Contrib_AD_D_Coverage_Amt__c = 250000,
            Orig_Non_Contrib_AD_D_Coverage_Amt__c = 3000,
            Add_l_AD_D_Coverage_Amt_NoReduction__c = 0,
            Add_l_Coverage_Rate_1_Person__c = 0
        );
        insert policy;
        policy.Total_Monthly_Premium__c = 81.42;
        update policy;
        policy = [SELECT Pay_Type__c, Total_Monthly_Premium__c FROM Policy__c WHERE Id = :policy.Id];
        Decimal storedPremiumBefore = policy.Total_Monthly_Premium__c;
        policy.Pay_Type__c = '3';

        Test.startTest();
        update policy;
        Test.stopTest();

        Policy__c corrected = [
            SELECT Pay_Type__c, Total_Monthly_Premium__c, Total_Monthly_Premium_1_Person_PL__c
            FROM Policy__c WHERE Id = :policy.Id
        ];
        System.assertEquals('3', corrected.Pay_Type__c);
        System.assertNotEquals(storedPremiumBefore, corrected.Total_Monthly_Premium_1_Person_PL__c,
            'The test must prove the ordinary recalculation would change the stored premium.');
        System.assertEquals(storedPremiumBefore, corrected.Total_Monthly_Premium__c,
            'The Bill 2 payment-type-only correction must preserve the stored premium.');
    }

    private static Policy__c refundPolicy(Account account, String name, String policyType, String status) {
        return new Policy__c(
            Name = name,
            Account__c = account.Id,
            Months__c = '1',
            Policy_Type__c = policyType,
            Policy_Status__c = status,
            Pay_Type__c = '3',
            Total_Monthly_Premium__c = 25,
            Pay_To_Date__c = Date.today().addMonths(3),
            Pay_Date__c = Date.today(),
            Rate_1__c = 0.22,
            Rate_2__c = 0.35,
            Orig_Contrib_AD_D_Coverage_Amt__c = 100000,
            Orig_Non_Contrib_AD_D_Coverage_Amt__c = 3000,
            Add_l_AD_D_Coverage_Amt_NoReduction__c = 0,
            Add_l_Coverage_Rate_1_Person__c = 0,
            Add_l_Coverage_Rate_2_Person__c = 0,
            Products__c = '26MO05-2000: Amalgamated Life;AD-20: Fidelity ADD'
        );
    }

    @isTest
    static void coversCancellationRefundOnInsertForBothPolicyTypes() {
        Account account = new Account(Name = 'Bill 4 Insert Refund Test');
        insert account;
        List<Policy__c> policies = new List<Policy__c>{
            refundPolicy(account, 'Bill4InsertType1', '1', '4'),
            refundPolicy(account, 'Bill4InsertType2', '2', '4')
        };

        Test.startTest();
        insert policies;
        Test.stopTest();

        System.assertEquals(2, [SELECT count() FROM Refund__c WHERE Policy__c IN :policies]);
    }

    @isTest
    static void coversCancellationRefundOnUpdateForBothPolicyTypes() {
        Account account = new Account(Name = 'Bill 4 Update Refund Test');
        insert account;
        List<Policy__c> policies = new List<Policy__c>{
            refundPolicy(account, 'Bill4UpdateType1', '1', '1'),
            refundPolicy(account, 'Bill4UpdateType2', '2', '1')
        };
        insert policies;
        insert new List<Payments__c>{
            new Payments__c(
                Name = 'Bill4Payment1', Certificate__c = account.Id, Policy__c = policies[0].Id,
                Amount_Received__c = 25, Amount_1_Person__c = 25, Date_Received__c = Date.today(),
                Months_Pay__c = 1, Type_Received__c = '3', Pay_Type__c = '3'
            ),
            new Payments__c(
                Name = 'Bill4Payment2', Certificate__c = account.Id, Policy__c = policies[1].Id,
                Amount_Received__c = 25, Amount_1_Person__c = 25, Date_Received__c = Date.today(),
                Months_Pay__c = 1, Type_Received__c = '3', Pay_Type__c = '3'
            )
        };
        for (Policy__c policy : policies) policy.Policy_Status__c = '4';

        Test.startTest();
        update policies;
        Test.stopTest();

        System.assertEquals(2, [SELECT count() FROM Refund__c WHERE Policy__c IN :policies]);
    }
}
`;
}

function writePackage(root, triggerBody) {
  const packageDir = path.join(root, "package");
  fs.mkdirSync(path.join(packageDir, "triggers"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "classes"), { recursive: true });

  fs.writeFileSync(path.join(packageDir, "package.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${TRIGGER_NAME}</members><name>ApexTrigger</name></types>
    <types><members>PolicyTriggerBill4Test</members><name>ApexClass</name></types>
    <version>${API_VERSION}</version>
</Package>
`);
  fs.writeFileSync(path.join(packageDir, "triggers", `${TRIGGER_NAME}.trigger`), triggerBody);
  fs.writeFileSync(path.join(packageDir, "triggers", `${TRIGGER_NAME}.trigger-meta.xml`), `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${API_VERSION}</apiVersion><status>Active</status></ApexTrigger>
`);
  fs.writeFileSync(path.join(packageDir, "classes", "PolicyTriggerBill4Test.cls"), bill4TestClass());
  fs.writeFileSync(path.join(packageDir, "classes", "PolicyTriggerBill4Test.cls-meta.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${API_VERSION}</apiVersion><status>Active</status></ApexClass>
`);

  const zipPath = path.join(root, "policy-trigger-bill4.zip");
  const zipped = spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, "package.xml", "classes", "triggers"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  if (zipped.status !== 0) {
    throw new Error(`Unable to build Metadata API package: ${zipped.stderr || zipped.stdout}`);
  }
  return zipPath;
}

async function metadataSoap(token, body, action) {
  const endpoint = `${token.instanceUrl}/services/Soap/m/${API_VERSION}`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <env:Header><met:SessionHeader><met:sessionId>${escapeXml(token.accessToken)}</met:sessionId></met:SessionHeader></env:Header>
  <env:Body>${body}</env:Body>
</env:Envelope>`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: action },
    body: envelope,
  });
  const xml = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault>/i.test(xml)) {
    throw new Error(`Metadata API ${action} failed: ${tagValue(xml, "faultstring") || tagValue(xml, "message") || response.status}`);
  }
  return xml;
}

async function deployPackage(token, zipPath, checkOnly) {
  const zipBase64 = fs.readFileSync(zipPath).toString("base64");
  const tests = TEST_CLASSES.map((name) => `<met:runTests>${name}</met:runTests>`).join("");
  const xml = await metadataSoap(token, `<met:deploy>
    <met:ZipFile>${zipBase64}</met:ZipFile>
    <met:DeployOptions>
      <met:allowMissingFiles>false</met:allowMissingFiles>
      <met:autoUpdatePackage>false</met:autoUpdatePackage>
      <met:checkOnly>${checkOnly}</met:checkOnly>
      <met:ignoreWarnings>false</met:ignoreWarnings>
      <met:performRetrieve>false</met:performRetrieve>
      <met:purgeOnDelete>false</met:purgeOnDelete>
      <met:rollbackOnError>true</met:rollbackOnError>
      <met:runAllTests>false</met:runAllTests>
      ${tests}
      <met:singlePackage>true</met:singlePackage>
      <met:testLevel>RunSpecifiedTests</met:testLevel>
    </met:DeployOptions>
  </met:deploy>`, "deploy");
  const deploymentId = tagValue(xml, "id");
  if (!deploymentId) throw new Error("Salesforce did not return a deployment ID.");
  process.stdout.write(`${checkOnly ? "Validation" : "Deployment"} submitted: ${deploymentId}\n`);
  return deploymentId;
}

async function waitForDeployment(token, deploymentId) {
  for (;;) {
    const xml = await metadataSoap(token, `<met:checkDeployStatus><met:asyncProcessId>${escapeXml(deploymentId)}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`, "checkDeployStatus");
    const done = tagValue(xml, "done").toLowerCase() === "true";
    const status = tagValue(xml, "status") || "Unknown";
    const testsCompleted = tagValue(xml, "numTestsCompleted") || "0";
    const testsTotal = tagValue(xml, "numTestsRun") || "0";
    process.stdout.write(`Status: ${status}; tests ${testsCompleted}/${testsTotal}\n`);
    if (done) {
      const success = status.toLowerCase() === "succeeded";
      if (!success) {
        const problems = [...new Set([
          ...allTagValues(xml, "problem"),
          ...allTagValues(xml, "message"),
          ...allTagValues(xml, "stackTrace"),
        ].filter(Boolean))];
        throw new Error(`Salesforce deployment failed.${problems.length ? ` ${problems.join(" | ")}` : ""}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main() {
  const performDeployment = process.argv.includes("--deploy");
  const token = await getConnectedSalesforceToken();
  const records = await toolingQuery(token, `SELECT Id, Name, Status, Body FROM ApexTrigger WHERE Name = '${TRIGGER_NAME}' LIMIT 1`);
  const trigger = records[0];
  if (!trigger || trigger.Status !== "Active") {
    throw new Error(`Active ${TRIGGER_NAME} was not found; no deployment was attempted.`);
  }

  const updatedBody = addBill4PremiumGuard(String(trigger.Body || ""));
  const alreadyInstalled = updatedBody === trigger.Body;
  if (alreadyInstalled && !performDeployment) {
    process.stdout.write("The Bill 4 premium guard is already present.\n");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hpa-bill4-trigger-"));
  try {
    const backupPath = path.join(tempRoot, `${TRIGGER_NAME}.original.trigger`);
    fs.writeFileSync(backupPath, trigger.Body);
    const zipPath = writePackage(tempRoot, updatedBody);
    process.stdout.write(`Prepared ${alreadyInstalled ? "current" : "updated"} trigger and focused regression test.\n`);
    const deploymentId = await deployPackage(token, zipPath, !performDeployment);
    await waitForDeployment(token, deploymentId);
    process.stdout.write(`${performDeployment ? "Deployment" : "Validation"} succeeded.\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
