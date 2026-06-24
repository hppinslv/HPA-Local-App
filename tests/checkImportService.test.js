const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __setCheckImportStateForTests,
  deleteCheckImportRows,
  deleteCheckImportSession,
  getCheckImportSession,
} = require("../services/checkImportService");

function buildSession(overrides = {}) {
  return {
    id: "check_session_1",
    original_filename: "report.zip",
    import_template_key: "check-payments",
    import_template_name: "Check Import",
    salesforce_object_api_name: "TPA__c",
    operation_type: "insert",
    uploaded_at: "2026-06-24T15:45:00.000Z",
    updated_at: "2026-06-24T15:45:00.000Z",
    uploaded_by: "Local User",
    policy_lookup_refreshed_at: null,
    status: "pending",
    row_count: 2,
    active_row_count: 2,
    ready_count: 0,
    error_count: 0,
    warning_count: 0,
    total_amount: 40,
    missing_certificate_count: 0,
    missing_policy_count: 0,
    discrepancy_count: 0,
    attempted_import_count: 0,
    successful_import_count: 0,
    salesforce_failed_row_count: 0,
    imported_row_count: 0,
    final_status: "pending_review",
    footer_transaction_count: null,
    footer_grand_total_amount: null,
    footer_mismatch: false,
    validation_message: "Upload complete.",
    ...overrides,
  };
}

function buildRow(id, sessionId = "check_session_1", overrides = {}) {
  return {
    id,
    session_id: sessionId,
    row_number: 1,
    transaction_type: "Check",
    deposit_date: "2026-06-24",
    customer_batch_number: "1",
    sequence_number: "1",
    bank_number: "123456789",
    account_number: "1234",
    check_number: `CHK-${id}`,
    check_amount: "20.00",
    remitter_name: "Test Remitter",
    doc_count: "1",
    transaction_id: `TX-${id}`,
    certificate_number: "226514",
    corrected_certificate_number: "",
    matched_policy_id: "",
    matched_certificate_record_id: "",
    member_1_name: "Test One",
    member_2_name: "",
    months: "",
    corrected_months: "",
    status: "pending",
    issue_reason: "",
    issue_details: [],
    expected_amount: null,
    discrepancy_note: "",
    import_result_status: "",
    import_result_message: "",
    imported_salesforce_id: "",
    imported_salesforce_created: false,
    raw_json: {},
    manual_policy_id: "",
    manually_corrected: false,
    corrected_by: "",
    corrected_at: "",
    excluded: false,
    excluded_at: "",
    excluded_by: "",
    footer_transaction_count: null,
    footer_grand_total_count: null,
    footer_grand_total_amount: null,
    premium_comparison_label: "",
    payment_name: "",
    ...overrides,
  };
}

test.after(() => {
  __setCheckImportStateForTests();
});

test("unimported check import sessions can be deleted from history", () => {
  __setCheckImportStateForTests({
    sessions: [
      buildSession({ id: "delete_me" }),
      buildSession({ id: "keep_me", original_filename: "keep.zip" }),
    ],
    rows: [
      buildRow("row_delete_1", "delete_me"),
      buildRow("row_keep_1", "keep_me"),
    ],
  });

  const result = deleteCheckImportSession("delete_me");
  assert.equal(result.deletedSessionId, "delete_me");
  assert.equal(result.sessions.some((entry) => entry.id === "delete_me"), false);
  assert.equal(result.sessions.some((entry) => entry.id === "keep_me"), true);
});

test("imported check import sessions cannot be deleted", () => {
  __setCheckImportStateForTests({
    sessions: [
      buildSession({
        id: "imported_session",
        attempted_import_count: 1,
        successful_import_count: 1,
        imported_row_count: 1,
        final_status: "imported",
      }),
    ],
    rows: [buildRow("row_imported", "imported_session")],
  });

  assert.throws(
    () => deleteCheckImportSession("imported_session"),
    /cannot be deleted/i
  );
});

test("selected unimported check import rows can be deleted in bulk", async () => {
  __setCheckImportStateForTests({
    sessions: [buildSession()],
    rows: [
      buildRow("row_1"),
      buildRow("row_2", "check_session_1", { row_number: 2 }),
    ],
    policyCache: {
      reportId: "00OQm0000016PuPMAU",
      refreshedAt: null,
      source: "test",
      items: [],
    },
  });

  const session = await deleteCheckImportRows("check_session_1", ["row_1"]);
  assert.equal(session.row_count, 1);
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].id, "row_2");
});
