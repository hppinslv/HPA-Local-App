# Bill Creator Implementation Kanban

## Done in code / automated QA

- Inspect legacy Bill Creator and supplied assets.
- Replace Bill 2 report, target value, filtering, and HTTP-only success handling.
- Implement Bill 4 calculation, premium preservation, update, and reread verification.
- Add deployment-level Salesforce write safety switch.
- Retrieve four authoritative billing reports separately and freshly.
- Add numeric certificate sorting, duplicate detection, and Bill 4 identity-sequence validation.
- Derive the next calendar billing month with no UI override.
- Generate the required workbook, six PDFs, audit/reconciliation workbooks, summary PDF, and ZIP in unique folders.
- Replace stepwise confirmations with primary monthly-run and corrections-only actions.
- Sync the newer supplied OneDrive workbooks and templates into `bills/`.
- Add unit, integration, and isolated Office rendering tests.
- Draft the monthly billing SOP.

## QA / approval required

- Reconnect Salesforce and validate the runtime-resolved Bill 4 field metadata in an authorized sandbox/test org.
- Run a sanitized multi-record document set and visually inspect every template type, including remittance boundaries and page breaks.
- Reconcile report row totals with expected Salesforce report totals in the connected org.
- Obtain business approval of sample PDFs and the SOP.

## Blocked from production

- Production Salesforce writes remain disabled until approved deployment configuration sets `HPA_BILLING_SALESFORCE_WRITES_ENABLED=true`.
- Production deployment and customer printing remain out of scope until business approval.
