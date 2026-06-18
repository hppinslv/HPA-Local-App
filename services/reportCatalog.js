const MONTHLY_REPORT_TYPES = [
  {
    id: "transaction-summary",
    name: "AHA HPA Transaction Summary Report",
    shortName: "Transaction Summary",
    description:
      "Builds the month-end summary workbook and print view from eight Salesforce reports.",
    templateFileName: "AHA HPA Transaction Summary.test.xlsm",
    artifactBaseName: "aha-hpa-transaction-summary",
    salesforceReports: [
      {
        key: "billingCredits",
        reportId: "00Of4000008DsaQEAS",
        tabName: "Billing Credits",
        transactionType: "Billing Credit",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "billingAndDirectDebitRefunds",
        reportId: "00Of4000008Dsc2EAC",
        tabName: "B & DD Refund",
        transactionType: "Refund",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "billingBouncedChecks",
        reportId: "00Of4000008DsbYEAS",
        tabName: "B BC",
        transactionType: "Bounced Check",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "directDebitCredits",
        reportId: "00Of4000008Dsc7EAC",
        tabName: "DD C",
        transactionType: "Direct Debit Credit",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: true,
      },
      {
        key: "directDebitReturnedItems",
        reportId: "00Of4000008DsakEAC",
        tabName: "DD Returned Items",
        transactionType: "Returned Item",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "creditCardCredits",
        reportId: "00Of4000008DsaWEAS",
        tabName: "CC C",
        transactionType: "Credit Card Credit",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "creditCardRefunds",
        reportId: "00Of4000008Dsb4EAC",
        tabName: "CC R",
        transactionType: "Credit Card Refund",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
      {
        key: "directDebitReturnedRefunds",
        reportId: "00Of4000008DsbnEAC",
        tabName: "DD RR",
        transactionType: "M&T Return / Refund",
        notes: "Assumed from the workbook/source order provided by the user.",
        useAggregateQuery: false,
      },
    ],
  },
  {
    id: "transaction-detail",
    name: "AHA HPA Transaction Detail Report",
    shortName: "Transaction Detail",
    description:
      "Combines payment, credit, and policy type Salesforce reports into the monthly detail workbook.",
    templateFileName: "AHA HPA Transaction Detail.xlsx",
    artifactBaseName: "aha-hpa-transaction-detail",
    salesforceReports: [
      {
        key: "paymentSummary",
        reportId: "00Of4000008DtM5EAK",
        tabName: "Month End Transaction Summ(2)",
        transactionType: "Payment Summary",
      },
      {
        key: "creditsSummary",
        reportId: "00O5G000008KqHSUA0",
        tabName: "Month End Transaction Summ(1)",
        transactionType: "Credits Summary",
      },
      {
        key: "policyType",
        reportId: "00O5G000008KqHXUA0",
        tabName: "Month End Transaction Summa...",
        transactionType: "Policy Type",
      },
    ],
  },
  {
    id: "amalgamated-premium-remittance",
    name: "Amalgamated Premium Remittance",
    shortName: "Amalgamated Premium Remittance",
    description:
      "Builds the month-end Amalgamated Premium Remittance workbook from certificate, payment, credit, and contact source reports.",
    templateFileName: "Amalgamated_Premium_Remittance.xlsx",
    salesforceReports: [
      {
        key: "certs",
        reportId: "00O5G000008KqGZUA0",
        tabName: "Premium Remittance Certs an...",
        transactionType: "Certificate / Policy Detail",
      },
      {
        key: "payments",
        reportId: "00O5G000008KqGeUAK",
        tabName: "Premium Remittance Payments",
        transactionType: "Payments",
      },
      {
        key: "credits",
        reportId: "00O5G000008KuTNUA0",
        tabName: "Premium Remittance Credits",
        transactionType: "Credits",
      },
      {
        key: "contact1",
        reportId: "00O5G000008KqGjUAK",
        tabName: "Premium Remittance Contact(1)",
        transactionType: "Contact 1",
      },
      {
        key: "contact2",
        reportId: "00O5G000008KqH3UAK",
        tabName: "Premium Remittance Contacts...",
        transactionType: "Contact 2",
      },
    ],
  },
];

const DEFAULT_MONTHLY_REPORT_TYPE = MONTHLY_REPORT_TYPES[0].id;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getMonthlyReportTypes() {
  return MONTHLY_REPORT_TYPES.map((entry) => clone(entry));
}

function getMonthlyReportType(reportTypeId = DEFAULT_MONTHLY_REPORT_TYPE) {
  const reportType = MONTHLY_REPORT_TYPES.find((entry) => entry.id === reportTypeId);
  return reportType ? clone(reportType) : null;
}

function getAllConfiguredSalesforceReports() {
  return MONTHLY_REPORT_TYPES.flatMap((reportType) =>
    reportType.salesforceReports.map((report) => ({
      reportType: reportType.id,
      reportName: reportType.name,
      ...clone(report),
    }))
  );
}

function getMonthEndReportCatalog() {
  return getMonthlyReportType("transaction-summary")?.salesforceReports || [];
}

module.exports = {
  DEFAULT_MONTHLY_REPORT_TYPE,
  getAllConfiguredSalesforceReports,
  getMonthEndReportCatalog,
  getMonthlyReportType,
  getMonthlyReportTypes,
};
