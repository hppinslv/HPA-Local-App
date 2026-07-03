const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../services/achReturnService");

test("buildAchReturnCommentText uses ISF wording and readable returned check details", () => {
  const text = __test.buildAchReturnCommentText(
    {
      creditAmount: 71.41,
      checkNo: "1234",
      returnCode: "ISF",
      returnReason: "Insufficient Funds",
      creditDate: "2026-07-01",
    },
    "2026-07-03T12:00:00.000Z"
  );

  assert.match(text, /Rcvd notice from the bank of ISF\./);
  assert.match(text, /Processed returned check reversal\/credit of \$71\.41\./);
  assert.match(text, /Check #1234\./);
  assert.match(text, /Return date 07\/01\/2026\./);
  assert.match(text, /Processed on 07\/03\/2026\./);
});

test("buildReturnedCheckTaskPayload maps the Certificate as Related To and sets a Log a Call style payload", () => {
  const payload = __test.buildReturnedCheckTaskPayload(
    {
      certificateRecordId: "001ABC123",
      creditAmount: 80,
      checkNo: "9876",
      returnCode: "NSF",
      returnReason: "Insufficient Funds",
      creditDate: "2026-07-01",
    },
    {
      statusField: { name: "Status", picklistValues: [{ value: "Completed", active: true }] },
      subjectField: { name: "Subject" },
      subtypeField: { name: "TaskSubtype", picklistValues: [{ value: "Call", active: true }] },
      descriptionField: { name: "Description" },
      activityDateField: { name: "ActivityDate", nillable: true },
      commentTypeField: {
        name: "Type",
        picklistValues: [{ value: "Admin", active: true }],
      },
      commentReasonField: {
        name: "Comment_Reason__c",
        picklistValues: [{ value: "Processed refund", active: true }],
      },
    },
    "2026-07-03T12:00:00.000Z"
  );

  assert.equal(payload.payload.WhatId, "001ABC123");
  assert.equal(payload.payload.TaskSubtype, "Call");
  assert.equal(payload.payload.Status, "Completed");
  assert.equal(payload.payload.Type, "Admin");
  assert.equal(payload.payload.Comment_Reason__c, "Processed refund");
  assert.equal(payload.payload.Subject, "Admin - Processed refund");
  assert.match(payload.payload.Description, /Rcvd notice from the bank of NSF\./);
});

test("isEquivalentReturnedCheckTask matches generated returned check activities for duplicate detection", () => {
  const row = {
    certificateNumber: "259616",
    creditAmount: 71.41,
    checkNo: "5551",
    returnCode: "ISF",
    returnReason: "Insufficient Funds",
    creditDate: "2026-07-01",
  };

  const existingTask = {
    Subject: "Admin - Processed refund",
    Description:
      "Rcvd notice from the bank of ISF. Processed returned check reversal/credit of $71.41. Check #5551. Return date 07/01/2026. Processed on 07/03/2026.",
  };

  assert.equal(__test.isEquivalentReturnedCheckTask(existingTask, row), true);
});
