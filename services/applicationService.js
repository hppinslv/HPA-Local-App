const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const APPLICATIONS_PATH = path.join(DATA_DIR, "customer-applications.json");

const APPLICATION_DEFAULTS = {
  dues: 19.95,
  freeCoverageAmount: 3000,
  onePersonPer1000: 0.22,
  twoPersonPer1000: 0.33,
};

let applicationsCache = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeParseJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return clone(fallbackValue);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return clone(fallbackValue);
  }
}

function writeJson(filePath, payload) {
  ensureStorage();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCurrencyNumber(value, fallbackValue = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = normalizeText(value);
  if (!text) {
    return fallbackValue;
  }

  const negativeByParens = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }

  return negativeByParens ? -parsed : parsed;
}

function createApplicationId() {
  return `application_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readApplications() {
  if (!Array.isArray(applicationsCache)) {
    applicationsCache = safeParseJson(APPLICATIONS_PATH, []);
  }
  return applicationsCache;
}

function persistApplications(nextApplications) {
  applicationsCache = clone(nextApplications);
  writeJson(APPLICATIONS_PATH, applicationsCache);
}

function calculateApplicationFinancials(source = {}) {
  const coverageAmount = normalizeCurrencyNumber(
    source.coverageAmount ?? source.coverage_amount,
    null
  );
  const dues = APPLICATION_DEFAULTS.dues;
  const freeCoverageAmount = APPLICATION_DEFAULTS.freeCoverageAmount;
  const onePersonPer1000 = APPLICATION_DEFAULTS.onePersonPer1000;
  const twoPersonPer1000 = APPLICATION_DEFAULTS.twoPersonPer1000;
  const coverageDividedBy1000 = Number.isFinite(coverageAmount)
    ? coverageAmount / 1000
    : null;
  const coverageOverFreeBase = Number.isFinite(coverageDividedBy1000)
    ? coverageDividedBy1000 - 3
    : null;
  const onePersonPremium = Number.isFinite(coverageOverFreeBase)
    ? Number((coverageOverFreeBase * onePersonPer1000 + dues).toFixed(2))
    : null;
  const twoPersonPremium = Number.isFinite(coverageOverFreeBase)
    ? Number((coverageOverFreeBase * twoPersonPer1000 + dues).toFixed(2))
    : null;

  return {
    coverageAmount,
    dues,
    freeCoverageAmount,
    onePersonPer1000,
    twoPersonPer1000,
    coverageDividedBy1000,
    coverageOverFreeBase,
    onePersonPremium,
    twoPersonPremium,
  };
}

function validateApplicationPayload(source = {}) {
  const errors = [];
  const customerMailingInformation = normalizeText(
    source.customerMailingInformation ?? source.customer_mailing_information
  );
  const coverageAmount = normalizeCurrencyNumber(
    source.coverageAmount ?? source.coverage_amount,
    null
  );

  if (!customerMailingInformation) {
    errors.push("Customer Mailing Information is required.");
  }

  if (!Number.isFinite(coverageAmount)) {
    errors.push("Coverage Amount is required.");
  } else if (coverageAmount <= 0) {
    errors.push("Coverage Amount must be greater than 0.");
  }

  const financials = calculateApplicationFinancials(source);
  if (!Number.isFinite(financials.onePersonPremium) || !Number.isFinite(financials.twoPersonPremium)) {
    errors.push("Premiums must calculate before printing.");
  }

  return {
    errors,
    financials,
  };
}

function serializeApplication(entry = {}) {
  return {
    id: entry.id,
    customer_mailing_information: entry.customer_mailing_information || "",
    lender: entry.lender || "",
    coverage_amount: entry.coverage_amount,
    one_person_premium: entry.one_person_premium,
    two_person_premium: entry.two_person_premium,
    case_number: entry.case_number || "",
    created_at: entry.created_at || "",
    updated_at: entry.updated_at || "",
  };
}

function normalizeApplicationPayload(source = {}, existingEntry = null) {
  const { errors, financials } = validateApplicationPayload(source);
  if (errors.length) {
    throw new Error(errors.join(" "));
  }

  const now = new Date().toISOString();
  return {
    id: normalizeText(source.id || existingEntry?.id) || createApplicationId(),
    customer_mailing_information: normalizeText(
      source.customerMailingInformation ?? source.customer_mailing_information
    ),
    lender: normalizeText(source.lender),
    coverage_amount: financials.coverageAmount,
    one_person_premium: financials.onePersonPremium,
    two_person_premium: financials.twoPersonPremium,
    case_number: normalizeText(source.caseNumber ?? source.case_number),
    created_at: existingEntry?.created_at || now,
    updated_at: now,
  };
}

function listApplications() {
  return readApplications()
    .slice()
    .sort((left, right) => new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime())
    .map((entry) => serializeApplication(entry));
}

function getApplication(applicationId) {
  const normalizedId = normalizeText(applicationId);
  if (!normalizedId) {
    return null;
  }

  const entry = readApplications().find((item) => item.id === normalizedId);
  return entry ? serializeApplication(entry) : null;
}

function saveApplication(source = {}) {
  const applications = readApplications().slice();
  const normalizedId = normalizeText(source.id);
  const index = normalizedId
    ? applications.findIndex((entry) => entry.id === normalizedId)
    : -1;
  const existingEntry = index >= 0 ? applications[index] : null;
  const normalizedEntry = normalizeApplicationPayload(source, existingEntry);

  if (index >= 0) {
    applications[index] = normalizedEntry;
  } else {
    applications.unshift(normalizedEntry);
  }

  persistApplications(applications);
  return serializeApplication(normalizedEntry);
}

function deleteApplication(applicationId) {
  const normalizedId = normalizeText(applicationId);
  if (!normalizedId) {
    throw new Error("Application not found.");
  }

  const applications = readApplications();
  const remaining = applications.filter((entry) => entry.id !== normalizedId);
  if (remaining.length === applications.length) {
    throw new Error("Application not found.");
  }

  persistApplications(remaining);
  return listApplications();
}

async function initializeApplicationPersistence() {
  ensureStorage();
  applicationsCache = safeParseJson(APPLICATIONS_PATH, []);
  if (!fs.existsSync(APPLICATIONS_PATH)) {
    writeJson(APPLICATIONS_PATH, applicationsCache);
  }
}

module.exports = {
  APPLICATION_DEFAULTS,
  calculateApplicationFinancials,
  deleteApplication,
  getApplication,
  initializeApplicationPersistence,
  listApplications,
  saveApplication,
  validateApplicationPayload,
};
