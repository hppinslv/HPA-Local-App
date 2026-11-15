# HPA Monthly Billing SOP (Implementation Draft)

Status: implementation draft pending business approval and sandbox/live-connected QA. Do not treat this SOP as finalized until deployment is approved.

## Purpose and safety

The Bill Creator performs two ordered stages: Salesforce bill corrections, followed by document production from newly retrieved Salesforce reports. Test runs must use authorized test data. Live Salesforce writes are disabled unless the deployed environment explicitly sets `HPA_BILLING_SALESFORCE_WRITES_ENABLED=true` after approval. The process does not email customers, submit print jobs, or update billing-status fields.

## Normal monthly run

1. Open **Billing > Run Monthly Billing**.
2. Enter the run operator and optional notes. There is no billing-month selector; the system uses the next calendar month in the HPA business timezone (`America/Los_Angeles` by default).
3. Select **Run Monthly Billing**. Only one active run for the billing month is permitted.
4. Monitor the stages: retrieving correction reports, correcting Bill 2, correcting Bill 4, verifying Salesforce, retrieving billing reports, sorting certificates, generating invoices, generating notices, validating PDFs, and ready to download.
5. If any correction, verification, required report value, duplicate certificate, pairing, or document validation fails, resolve the displayed exception and rerun. The application does not silently continue past a failed correction gate.
6. Download individual artifacts or the complete ZIP. A rerun uses a new run ID/timestamp folder and does not overwrite the prior package.

Use **Run Bill Corrections Only** when corrections must be completed without producing documents.

## Salesforce reports

Correction reports:

- Bill 2: `00O5G000008lD4oUAE`
- Bill 4: `00O5G000008lD4tUAE`

Billing reports:

- Bill 1: `00O5G000008lBjuUAE`
- Bill 2: `00O5G000008lBllUAE`
- Bill 3: `00O5G000008lBlvUAE`
- Bill 4: `00O5G000008lBm0UAE`

Every billing report is freshly executed after corrections verify. The four datasets remain separate and are sorted numerically by certificate number, with Salesforce record ID as the duplicate tie-breaker. Duplicate certificates are exceptions.

## Correction rules

Bill 2: every report record is verified with `Policy__c.Pay_Type__c = Monthly Billing`. Any other value is updated; an already matching record is reread and logged as unchanged. Only the payment-type field is written.

Bill 4: only records with Non-Contrib exactly `$7,000` are changed. For valid nonnegative values:

`Original Total = Original Contrib + Original Non-Contrib`

`New Non-Contrib = 3000`

`New Contrib = MIN(Original Total - 3000, 500000)`

`New Total = New Contrib + 3000`

The monthly premium is read before and after the update and must be identical. Coverage reductions caused by the `$503,000` total cap are recorded. Missing, invalid, negative, rejected, or unverifiable records stop the full billing workflow.

## Documents and mappings

The approved assets in `bills/` are the Bill Spreadsheet workbook and six Word templates. The spreadsheet contains Bill 1 through Bill 4 tabs plus the auxiliary picklist tab. The picklist tab never creates invoices.

- Bill 1: one invoice per report row.
- Bill 2: one overdue invoice per report row, after corrections verify.
- Bill 3: one invoice and one identical general Important Notice page per report row.
- Bill 4: one invoice and one personalized Important Notice per report row. The notice uses report `P1` for monthly premium and `Coverage Production` for coverage.

Amounts and customer-specific dates come from the Salesforce report fields. The generator does not derive P2/P3/P6/P12 from P1. The Bill 4 invoice and notice stacks use the same certificate-plus-record-ID sequence and are validated as separate PDF stacks.

## Outputs and printing

Each unique run folder contains:

- `Bill_Spreadsheet_YYYY-MM.xlsx`
- `Bill1_YYYY-MM.pdf` through `Bill4_YYYY-MM.pdf`
- `Bill3_Important_Notice_YYYY-MM.pdf`
- `Bill4_Important_Notice_YYYY-MM.pdf`
- `Bill_Corrections_YYYY-MM.xlsx`
- `Billing_Reconciliation_YYYY-MM.xlsx`
- `Billing_Run_Summary_YYYY-MM.pdf`
- `Billing_Package_YYYY-MM.zip`

Print invoice and notice PDFs separately. In particular, do not interleave Bill 4 invoices and notices.

## Exceptions and audit

The saved run records operator, timestamps, billing month, stages, counts, correction rows, update/verification status, coverage reductions, validation results, artifacts, and final error. Correction and reconciliation workbooks accompany the package. Historical run artifacts must not be deleted or overwritten through the normal UI.

