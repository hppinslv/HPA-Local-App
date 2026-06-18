const REPORT_ID = "amalgamated-premium-remittance";

const SOURCE_KEYS = {
  certs: "certs",
  payments: "payments",
  credits: "credits",
  contact1: "contact1",
  contact2: "contact2",
};

const SOURCE_FILE_FIELDS = [
  {
    key: SOURCE_KEYS.certs,
    label: "Certificate / Policy Detail Report",
    required: true,
  },
  {
    key: SOURCE_KEYS.payments,
    label: "Payments Report",
    required: true,
  },
  {
    key: SOURCE_KEYS.credits,
    label: "Credits Report",
    required: true,
  },
  {
    key: SOURCE_KEYS.contact1,
    label: "Contact 1 Report",
    required: true,
  },
  {
    key: SOURCE_KEYS.contact2,
    label: "Contact 2 Report",
    required: true,
  },
];

const SALESFORCE_REPORTS = [
  {
    key: SOURCE_KEYS.certs,
    reportId: "00O5G000008KqGZUA0",
    tabName: "Premium Remittance Certs an...",
    transactionType: "Certificate / Policy Detail",
  },
  {
    key: SOURCE_KEYS.payments,
    reportId: "00O5G000008KqGeUAK",
    tabName: "Premium Remittance Payments",
    transactionType: "Payments",
  },
  {
    key: SOURCE_KEYS.credits,
    reportId: "00O5G000008KuTNUA0",
    tabName: "Premium Remittance Credits",
    transactionType: "Credits",
  },
  {
    key: SOURCE_KEYS.contact1,
    reportId: "00O5G000008KqGjUAK",
    tabName: "Premium Remittance Contact(1)",
    transactionType: "Contact 1",
  },
  {
    key: SOURCE_KEYS.contact2,
    reportId: "00O5G000008KqH3UAK",
    tabName: "Premium Remittance Contacts...",
    transactionType: "Contact 2",
  },
];

const SHEET_NAMES = {
  picklist: "Enabler4Excel_Picklist_Values",
  certs: "Premium Remittance Certs an...",
  payments: "Premium Remittance Payments",
  credits: "Premium Remittance Credits",
  contact1: "Premium Remittance Contact(1)",
  contact2: "Premium Remittance Contacts...",
  final: "Sheet1",
};

const FIXED_ORIG_EFFECTIVE_DATE = "2018-06-01";
const AMAL_RATE = 0.41;
const AHA_RATE = 0.59;

const FINAL_COLUMN_DEFS = [
  { key: "certificate", label: "Certificate" },
  { key: "state", label: "State" },
  { key: "insuranceImport", label: "Insurance Import (hide)", hidden: true },
  { key: "isFullCoverage", label: "True/False(Hide)", hidden: true },
  { key: "hasSecondCoverage", label: "2nd (Hide)", hidden: true },
  { key: "insurance", label: "Insurance" },
  { key: "addPolicyNumber", label: "ADD Policy Number" },
  { key: "lifePolicyNumber", label: "Life Policy Number" },
  { key: "memberHide", label: "Member(Hide)", hidden: true },
  { key: "memberCount", label: "Member" },
  { key: "origEffectiveDate", label: "Orig effective date" },
  { key: "policyEffectiveDate", label: "Policy Effective Date(hide)", hidden: true },
  { key: "policyEffectiveFrom", label: "Policy Effective From" },
  { key: "policyEffectiveTo", label: "Policy Effective To" },
  { key: "monthsPaidLabelValue", label: "__MONTHS_PAID_LABEL__" },
  { key: "rate1", label: "rate 1 (hide)", hidden: true },
  { key: "rate2", label: "rate 2 hide", hidden: true },
  { key: "rate", label: "Rate" },
  { key: "premiumCollectedLabelValue", label: "__PREMIUM_COLLECTED_LABEL__" },
  { key: "amalPrem", label: "Amal Prem" },
  { key: "ahaPrem", label: "AHA Prem" },
  { key: "addBenefit", label: "ADD Benefit" },
  { key: "lifeBenefit", label: "Life Benefit" },
  { key: "member1", label: "Member 1" },
  { key: "member1Dob", label: "Member1 DOB" },
  { key: "member1AgeStart", label: "Member1 Age of 05/31/2018" },
  { key: "member1CurrentAge", label: "Member1 Current Age" },
  { key: "member1AddBenefit", label: "Member1 ADD Benefit" },
  { key: "member1LifeBenefit", label: "Member 1 Life Benefit" },
  { key: "member2", label: "Member 2" },
  { key: "member2Dob", label: "Member2 DOB" },
  { key: "member2AgeStart", label: "Member2 Age as of 05/31/2018" },
  { key: "member2CurrentAge", label: "Member2 Current Age" },
  { key: "member2AddBenefit", label: "Member2 ADD Benefit" },
  { key: "member2LifeBenefit", label: "Member2 Life Benefit" },
  { key: "addCoverage", label: "ADD Coverage" },
  { key: "addContribCoverage", label: "ADD Contrib Coverage" },
  { key: "addNonContribCoverage", label: "ADD Non Contrib Coverage" },
];

module.exports = {
  AHA_RATE,
  AMAL_RATE,
  FINAL_COLUMN_DEFS,
  FIXED_ORIG_EFFECTIVE_DATE,
  REPORT_ID,
  SALESFORCE_REPORTS,
  SHEET_NAMES,
  SOURCE_FILE_FIELDS,
  SOURCE_KEYS,
};
