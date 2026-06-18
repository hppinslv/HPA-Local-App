const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getSalesforceConfig } = require("./config");
const { getAllConfiguredSalesforceReports } = require("./reportCatalog");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUTH_STATE_PATH = path.join(DATA_DIR, "salesforce-oauth-state.json");
const AUTH_TOKEN_PATH = path.join(DATA_DIR, "salesforce-auth.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  ensureDir(DATA_DIR);

  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function storeTokenRecord(tokenRecord) {
  writeJson(AUTH_TOKEN_PATH, tokenRecord);
}

function toBase64Url(value) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getAuthStatus() {
  const config = getSalesforceConfig();
  const token = readJson(AUTH_TOKEN_PATH, null);

  return {
    isConfigured: Boolean(
      config.clientId && config.clientSecret && config.loginUrl && config.redirectUri
    ),
    isAuthenticated: Boolean(token && token.accessToken),
    configuredReportCount: getAllConfiguredSalesforceReports().length,
    loginUrl: config.loginUrl,
    redirectUri: config.redirectUri,
    instanceUrl: token?.instanceUrl || null,
    issuedAt: token?.issuedAt || null,
  };
}

function createAuthorizationUrl() {
  const config = getSalesforceConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error("Salesforce OAuth is not configured. Add credentials to .env.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = toBase64Url(crypto.randomBytes(32));
  const codeChallenge = toBase64Url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  writeJson(AUTH_STATE_PATH, {
    state,
    codeVerifier,
    createdAt: new Date().toISOString(),
  });

  const url = new URL("/services/oauth2/authorize", config.loginUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

async function exchangeCodeForToken({ code, state }) {
  const config = getSalesforceConfig();
  const savedState = readJson(AUTH_STATE_PATH, null);

  if (!savedState || savedState.state !== state) {
    throw new Error("Salesforce OAuth state mismatch.");
  }

  const tokenUrl = new URL("/services/oauth2/token", config.loginUrl);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: savedState.codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenBody.toString(),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Token exchange failed.");
  }

  const tokenRecord = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    instanceUrl: payload.instance_url,
    issuedAt: payload.issued_at,
    signature: payload.signature,
    tokenType: payload.token_type,
  };

  storeTokenRecord(tokenRecord);
  return tokenRecord;
}

function getStoredToken() {
  return readJson(AUTH_TOKEN_PATH, null);
}

module.exports = {
  createAuthorizationUrl,
  exchangeCodeForToken,
  getAuthStatus,
  getStoredToken,
  storeTokenRecord,
};
