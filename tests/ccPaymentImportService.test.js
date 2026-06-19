const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const sessionsPath = path.join(dataDir, "cc-payment-import-sessions.json");
const rowsPath = path.join(dataDir, "cc-payment-import-rows.json");
const policyCachePath = path.join(dataDir, "cc-payment-policy-lookup-cache.json");

const originalSessions = fs.readFileSync(sessionsPath, "utf8");
const originalRows = fs.readFileSync(rowsPath, "utf8");
const originalPolicyCache = fs.readFileSync(policyCachePath, "utf8");

const {
  __setCcPaymentImportStateForTests,
  deleteCcPaymentImportSession,
  getCcPaymentImportSession,
  revalidateSession,
} = require("../services/ccPaymentImportService");

test.after(() => {
  __setCcPaymentImportStateForTests({
    sessions: JSON.parse(originalSessions),
    rows: JSON.parse(originalRows),
    policyCache: JSON.parse(originalPolicyCache),
  });
});

test("deleting a duplicate-only cc payment session revalidates the remaining session", () => {
  __setCcPaymentImportStateForTests({
    sessions: [
    {
      id: "session_keep",
      original_filename: "keep.csv",
      import_template_key: "credit-card-payments",
      import_template_name: "Credit Card Payment Import",
      salesforce_object_api_name: "Payments__c",
      operation_type: "insert",
      uploaded_at: "2026-06-19T06:00:00.000Z",
      updated_at: "2026-06-19T06:00:00.000Z",
      uploaded_by: "Local User",
      policy_lookup_refreshed_at: null,
      status: "pending",
      row_count: 1,
      ready_count: 0,
      error_count: 0,
      warning_count: 0,
      missing_policy_count: 0,
      attempted_import_count: 0,
      successful_import_count: 0,
      salesforce_failed_row_count: 0,
      imported_row_count: 0,
      failed_validation_row_count: 0,
      final_status: "pending_review",
      destination_object: "Payments__c",
      exported_at: null,
      export_filename: "",
    },
    {
      id: "session_delete",
      original_filename: "delete.csv",
      import_template_key: "credit-card-payments",
      import_template_name: "Credit Card Payment Import",
      salesforce_object_api_name: "Payments__c",
      operation_type: "insert",
      uploaded_at: "2026-06-19T06:01:00.000Z",
      updated_at: "2026-06-19T06:01:00.000Z",
      uploaded_by: "Local User",
      policy_lookup_refreshed_at: null,
      status: "pending",
      row_count: 1,
      ready_count: 0,
      error_count: 0,
      warning_count: 0,
      missing_policy_count: 0,
      attempted_import_count: 0,
      successful_import_count: 0,
      salesforce_failed_row_count: 0,
      imported_row_count: 0,
      failed_validation_row_count: 0,
      final_status: "pending_review",
      destination_object: "Payments__c",
      exported_at: null,
      export_filename: "",
    },
    ],
    rows: [
    {
      id: "row_keep",
      session_id: "session_keep",
      row_number: 1,
      transaction_id: "txn-123",
      certificate_number: "226560",
      matched_policy_id: "a00f400000QB7x2AAD",
      matched_certificate_record_id: "cert-1",
      manual_policy_id: "a00f400000QB7x2AAD",
      amount: "75.62",
      transaction_date: "2026-06-18",
      payment_account: "5475",
      months: 1,
      status: "pending",
      issue_reason: "",
      issue_details: [],
      payment_name: "",
      name_amount_match_note: "",
      raw_json: {
        TransactionDate: "2026-06-18",
      },
      date_received: "",
      type: "2",
      pay_type: "3",
      manual_payment: "Yes",
    },
    {
      id: "row_delete",
      session_id: "session_delete",
      row_number: 1,
      transaction_id: "txn-123",
      certificate_number: "226560",
      matched_policy_id: "a00f400000QB7x2AAD",
      matched_certificate_record_id: "cert-1",
      manual_policy_id: "a00f400000QB7x2AAD",
      amount: "75.62",
      transaction_date: "2026-06-18",
      payment_account: "5475",
      months: 1,
      status: "pending",
      issue_reason: "",
      issue_details: [],
      payment_name: "",
      name_amount_match_note: "",
      raw_json: {
        TransactionDate: "2026-06-18",
      },
      date_received: "",
      type: "2",
      pay_type: "3",
      manual_payment: "Yes",
    },
    ],
    policyCache: {
      reportId: "00OQm0000016PuPMAU",
      refreshedAt: null,
      source: "test",
      items: [
      {
        certificate_number: "226560",
        policy_id: "a00f400000QB7x2AAD",
        certificate_record_id: "cert-1",
        p1: 75.62,
      },
      ],
    },
  });

  const beforeDelete = revalidateSession("session_keep");
  assert.equal(beforeDelete.error_count, 1);
  assert.match(beforeDelete.rows[0].issue_reason, /already exists in import history/i);

  const result = deleteCcPaymentImportSession("session_delete");
  assert.equal(result.deletedSessionId, "session_delete");
  assert.equal(result.sessions.some((entry) => entry.id === "session_delete"), false);

  const afterDelete = getCcPaymentImportSession("session_keep");
  assert.equal(afterDelete.error_count, 0);
  assert.equal(afterDelete.ready_count, 1);
  assert.equal(afterDelete.rows[0].status, "ready");
  assert.equal(afterDelete.rows[0].issue_reason, "");
});

test("imported cc payment sessions cannot be deleted", () => {
  __setCcPaymentImportStateForTests({
    sessions: [
    {
      id: "session_imported",
      original_filename: "imported.csv",
      import_template_key: "credit-card-payments",
      import_template_name: "Credit Card Payment Import",
      salesforce_object_api_name: "Payments__c",
      operation_type: "insert",
      uploaded_at: "2026-06-19T06:00:00.000Z",
      updated_at: "2026-06-19T06:00:00.000Z",
      uploaded_by: "Local User",
      policy_lookup_refreshed_at: null,
      status: "pending",
      row_count: 1,
      ready_count: 0,
      error_count: 0,
      warning_count: 0,
      missing_policy_count: 0,
      attempted_import_count: 1,
      successful_import_count: 1,
      salesforce_failed_row_count: 0,
      imported_row_count: 1,
      failed_validation_row_count: 0,
      final_status: "imported",
      destination_object: "Payments__c",
      exported_at: null,
      export_filename: "",
    },
    ],
    rows: [],
  });

  assert.throws(
    () => deleteCcPaymentImportSession("session_imported"),
    /cannot be deleted/i
  );
});
