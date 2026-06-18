const fs = require("fs");
const path = require("path");
const { getSupabaseConfig } = require("../services/config");
const {
  buildStatePath,
  hasObject,
  saveStateObject,
} = require("../services/supabasePersistence");

const ROOT_DIR = path.join(__dirname, "..");

const STATE_FILE_MAP = [
  { localPath: path.join(ROOT_DIR, "data", "analysis-runs.json"), remoteName: "analysis-runs.json" },
  { localPath: path.join(ROOT_DIR, "data", "analysis-setups.json"), remoteName: "analysis-setups.json" },
  { localPath: path.join(ROOT_DIR, "data", "analysis-reports.json"), remoteName: "analysis-reports.json" },
  { localPath: path.join(ROOT_DIR, "data", "scf-reference-lists.json"), remoteName: "scf-reference-lists.json" },
  { localPath: path.join(ROOT_DIR, "data", "cc-payment-import-sessions.json"), remoteName: "cc-payment-import-sessions.json" },
  { localPath: path.join(ROOT_DIR, "data", "cc-payment-import-rows.json"), remoteName: "cc-payment-import-rows.json" },
  { localPath: path.join(ROOT_DIR, "data", "cc-payment-policy-lookup-cache.json"), remoteName: "cc-payment-policy-lookup-cache.json" },
  { localPath: path.join(ROOT_DIR, "generated-reports", "report-runs.json"), remoteName: "monthly-report-runs.json" },
];

function normalizeKeyPrefix(prefix = "") {
  return String(prefix || "").trim().replace(/^\/+|\/+$/g, "");
}

function buildRemoteObjectPath(prefix, remoteName) {
  const normalizedPrefix = normalizeKeyPrefix(prefix);
  return normalizedPrefix ? `${normalizedPrefix}/${remoteName}` : remoteName;
}

function jsonHeaders(serviceRoleKey) {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    "Content-Type": "application/json",
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

async function requestText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return text;
}

async function ensureBucket(baseUrl, serviceRoleKey, bucketId) {
  const buckets = await requestJson(`${baseUrl}/storage/v1/bucket`, {
    method: "GET",
    headers: jsonHeaders(serviceRoleKey),
  });

  const existing = Array.isArray(buckets)
    ? buckets.find((entry) => String(entry.id || "").trim() === bucketId)
    : null;

  if (existing) {
    return { created: false, bucket: existing };
  }

  const created = await requestJson(`${baseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: jsonHeaders(serviceRoleKey),
    body: JSON.stringify({
      id: bucketId,
      name: bucketId,
      public: false,
      file_size_limit: null,
      allowed_mime_types: ["application/json"],
    }),
  });

  return { created: true, bucket: created };
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

async function uploadStateObject(remoteName, payload) {
  await saveStateObject(remoteName, payload);
  const exists = await hasObject(buildStatePath(remoteName));
  return { exists };
}

async function main() {
  const config = getSupabaseConfig();
  const baseUrl = String(config.url || "").replace(/\/+$/, "");
  const serviceRoleKey = String(config.serviceRoleKey || "").trim();
  const bucketId = String(config.bucket || "hpa-state").trim() || "hpa-state";
  const prefix = normalizeKeyPrefix(config.prefix || "analysis");

  if (!baseUrl || !serviceRoleKey) {
    throw new Error("Supabase URL and service role key must be configured in .env before syncing state.");
  }

  const missingFiles = STATE_FILE_MAP.filter((entry) => !fs.existsSync(entry.localPath));
  if (missingFiles.length) {
    throw new Error(`Missing local state files: ${missingFiles.map((entry) => entry.localPath).join(", ")}`);
  }

  const bucketResult = await ensureBucket(baseUrl, serviceRoleKey, bucketId);
  const uploads = [];

  for (const entry of STATE_FILE_MAP) {
    const payload = readJsonFile(entry.localPath);
    const remotePath = buildRemoteObjectPath(prefix, entry.remoteName);
    const verification = await uploadStateObject(entry.remoteName, payload);
    uploads.push({
      localPath: path.relative(ROOT_DIR, entry.localPath),
      remotePath,
      sizeBytes: fs.statSync(entry.localPath).size,
      stored: verification.exists === true,
    });
  }

  console.log(JSON.stringify({
    bucket: bucketId,
    prefix,
    bucketCreated: bucketResult.created,
    uploadedCount: uploads.length,
    uploads,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
