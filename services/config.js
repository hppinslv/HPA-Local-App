const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  envLines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  });
}

loadDotEnv();

function getSalesforceConfig() {
  return {
    clientId: process.env.SALESFORCE_CLIENT_ID || "",
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET || "",
    loginUrl: process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com",
    redirectUri:
      process.env.SALESFORCE_REDIRECT_URI ||
      "http://localhost:4173/oauth/salesforce/callback",
  };
}

function getSupabaseConfig() {
  const localModeValue = String(
    process.env.SUPABASE_LOCAL_MODE ||
      process.env.HPA_LOCAL_ONLY ||
      process.env.LOCAL_MODE ||
      ""
  ).trim().toLowerCase();
  const localMode = ["1", "true", "yes", "on"].includes(localModeValue);
  const explicitEnabledValue = String(process.env.SUPABASE_ENABLED || "").trim().toLowerCase();
  const explicitRemoteEnabled = explicitEnabledValue
    ? explicitEnabledValue === "1" || explicitEnabledValue === "true"
    : true;

  return {
    url: process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
    serviceRoleKey:
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "",
    bucket: process.env.SUPABASE_STORAGE_BUCKET || "hpa-state",
    prefix: process.env.SUPABASE_STATE_PREFIX || "analysis",
    enabled: Boolean(
      explicitRemoteEnabled &&
      !localMode &&
      (process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL) &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
    ),
  };
}

module.exports = {
  getSalesforceConfig,
  getSupabaseConfig,
};
