const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getSalesforceConfig } = require("./config");
const { getAllConfiguredSalesforceReports } = require("./reportCatalog");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUTH_STATE_PATH = path.join(DATA_DIR, "salesforce-oauth-state.json");
const AUTH_TOKEN_PATH = path.join(DATA_DIR, "salesforce-auth.json");
const SALESFORCE_CALLBACK_PATH = "/oauth/salesforce/callback";

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

function normalizeProto(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "https") return "https";
  return "http";
}

function firstHeaderValue(value) {
  return String(value || "")
    .split(",")[0]
    .trim();
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return (
    normalized === "localhost:4173" ||
    normalized === "127.0.0.1:4173" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1"
  );
}

function resolveBrowserFacingOrigin(headers = {}) {
  const candidates = [
    firstHeaderValue(headers.origin),
    firstHeaderValue(headers.referer),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.host && !isLoopbackHost(parsed.host)) {
        return {
          host: parsed.host,
          proto: normalizeProto(parsed.protocol.replace(":", "")),
        };
      }
    } catch {
      // Ignore malformed browser-facing URLs and continue falling back.
    }
  }

  return null;
}

function resolveRedirectUri(requestContext = null) {
  const config = getSalesforceConfig();
  const configuredRedirect = String(config.redirectUri || "").trim();

  if (!requestContext || !requestContext.headers) {
    return configuredRedirect;
  }

  const headers = requestContext.headers || {};
  const forwardedHost = firstHeaderValue(headers["x-forwarded-host"]);
  const forwardedProto = firstHeaderValue(headers["x-forwarded-proto"]);
  let host = forwardedHost || firstHeaderValue(headers.host);
  let proto = normalizeProto(forwardedProto || requestContext.protocol || "http");
  const browserFacingOrigin = resolveBrowserFacingOrigin(headers);

  if ((!forwardedHost || isLoopbackHost(host)) && browserFacingOrigin) {
    host = browserFacingOrigin.host;
    proto = browserFacingOrigin.proto;
  }

  if (!host) {
    return configuredRedirect;
  }

  if (!configuredRedirect) {
    return `${proto}://${host}${SALESFORCE_CALLBACK_PATH}`;
  }

  try {
    const configuredUrl = new URL(configuredRedirect);
    const configuredHost = String(configuredUrl.host || "").trim().toLowerCase();
    if (!configuredHost || isLoopbackHost(configuredHost)) {
      return `${proto}://${host}${SALESFORCE_CALLBACK_PATH}`;
    }
    return configuredRedirect;
  } catch {
    return `${proto}://${host}${SALESFORCE_CALLBACK_PATH}`;
  }
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

function createAuthorizationUrl(requestContext = null) {
  const config = getSalesforceConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error("Salesforce OAuth is not configured. Add credentials to .env.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = toBase64Url(crypto.randomBytes(32));
  const codeChallenge = toBase64Url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  const redirectUri = resolveRedirectUri(requestContext);
  writeJson(AUTH_STATE_PATH, {
    state,
    codeVerifier,
    redirectUri,
    createdAt: new Date().toISOString(),
  });

  const url = new URL("/services/oauth2/authorize", config.loginUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

async function exchangeCodeForToken({ code, state }, requestContext = null) {
  const config = getSalesforceConfig();
  const savedState = readJson(AUTH_STATE_PATH, null);

  if (!savedState || savedState.state !== state) {
    throw new Error("Salesforce OAuth state mismatch.");
  }

  const redirectUri =
    String(savedState.redirectUri || "").trim() ||
    resolveRedirectUri(requestContext) ||
    config.redirectUri;

  const tokenUrl = new URL("/services/oauth2/token", config.loginUrl);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
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
  resolveRedirectUri,
  storeTokenRecord,
};
