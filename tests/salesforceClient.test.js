const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldFallbackToSoqlForReportPayload,
} = require("../services/salesforceClient");

test("shouldFallbackToSoqlForReportPayload detects truncated Salesforce tabular payloads", () => {
  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: false,
      hasExceededTabularRowLimit: true,
    }),
    true
  );
});

test("shouldFallbackToSoqlForReportPayload ignores complete Salesforce payloads", () => {
  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: true,
      hasExceededTabularRowLimit: false,
    }),
    false
  );

  assert.equal(
    shouldFallbackToSoqlForReportPayload({
      allData: false,
      hasExceededTabularRowLimit: false,
    }),
    false
  );
});
