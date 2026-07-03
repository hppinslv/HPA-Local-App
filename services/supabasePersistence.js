const http = require("http");
const https = require("https");
const { URL } = require("url");
const { getSupabaseConfig } = require("./config");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKeyPrefix(prefix = "") {
  return String(prefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function normalizePath(path = "") {
  return String(path || "").trim().replace(/^\/+|\/+$/g, "");
}

const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 3500;
const DEFAULT_SUPABASE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const persistenceRuntime = {
  lastLoads: {},
  lastSaves: {},
};

function sanitizeError(error) {
  return {
    message: String(error?.message || error || "Unknown error"),
    name: String(error?.name || "Error"),
  };
}

function parseTimeoutMs(candidate) {
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS;
  }
  return Math.max(250, Math.floor(parsed));
}

function getRuntimeConfig() {
  const config = getSupabaseConfig() || {};
  const baseUrl = String(config.url || "").replace(/\/+$/, "");
  const key = String(config.serviceRoleKey || "").trim();
  const bucket = String(config.bucket || "hpa-state").trim() || "hpa-state";
  const prefix = normalizeKeyPrefix(config.prefix || "analysis");
  const enabled = Boolean(config.enabled);

  return {
    enabled,
    baseUrl,
    key,
    bucket,
    prefix,
  };
}

function recordPersistenceRuntime(kind, stateKey, details = {}) {
  persistenceRuntime[kind] = persistenceRuntime[kind] || {};
  persistenceRuntime[kind][stateKey] = {
    at: new Date().toISOString(),
    ...details,
  };
}

function jsonHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: token,
    "Content-Type": "application/json",
  };
}

function textHeaders(token, contentType = "text/plain; charset=utf-8") {
  return {
    Authorization: `Bearer ${token}`,
    apikey: token,
    "Content-Type": contentType,
  };
}

async function requestWithFetch(url, options = {}) {
  if (typeof fetch === "function") {
    const timeoutMs = parseTimeoutMs(process.env.SUPABASE_REQUEST_TIMEOUT_MS);
    let timeoutId = null;
    let timeoutController = null;
    let response;

    try {
      if (typeof AbortController !== "undefined") {
        timeoutController = new AbortController();
        timeoutId = setTimeout(() => {
          timeoutController.abort();
        }, timeoutMs);
        response = await fetch(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
          },
          signal: timeoutController.signal,
        });
      } else {
        response = await fetch(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
          },
        });
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
    const text = await response.text();
    if (!response.ok) {
      const message =
        text || `Supabase request failed (${response.status} ${response.statusText}).`;
      const error = new Error(message);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { status: response.status, text };
  }

  return requestWithHttps(url, options);
}

function requestWithHttps(url, options = {}) {
  const timeoutMs = parseTimeoutMs(process.env.SUPABASE_REQUEST_TIMEOUT_MS);
  const target = new URL(url);
  const headers = options.headers || {};
  const payload = options.body;

  return new Promise((resolve, reject) => {
    const requestModule = target.protocol === "http:" ? http : https;
    const req = requestModule.request(
      {
        method: options.method || "GET",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(
              body || `Supabase request failed (${res.statusCode} ${res.statusMessage})`
            );
            error.status = res.statusCode;
            error.body = body;
            reject(error);
            return;
          }

          resolve({ status: res.statusCode, text: body });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      const timeoutError = new Error("Supabase request timed out");
      timeoutError.code = "ETIMEDOUT";
      req.destroy(timeoutError);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function loadObject(pathname) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return null;
  }

  const normalizedPath = normalizePath(pathname);
  const url = `${config.baseUrl}/storage/v1/object/${encodeURIComponent(
    config.bucket
  )}/${normalizedPath}`;
  const encoded = await requestWithFetch(url, {
    method: "GET",
    headers: jsonHeaders(config.key),
  });

  if (!encoded.text) {
    return null;
  }

  try {
    return JSON.parse(encoded.text);
  } catch {
    return null;
  }
}

async function loadTextObject(pathname) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return null;
  }

  const normalizedPath = normalizePath(pathname);
  const url = `${config.baseUrl}/storage/v1/object/${encodeURIComponent(
    config.bucket
  )}/${normalizedPath}`;
  const encoded = await requestWithFetch(url, {
    method: "GET",
    headers: textHeaders(config.key),
  });

  return encoded.text || "";
}

async function saveObject(pathname, payload) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return false;
  }

  const normalizedPath = normalizePath(pathname);
  const url = `${config.baseUrl}/storage/v1/object/${encodeURIComponent(
    config.bucket
  )}/${normalizedPath}?upsert=true`;
  await requestWithFetch(url, {
    method: "POST",
    headers: {
      ...jsonHeaders(config.key),
      "x-upsert": "true",
    },
    body: JSON.stringify(payload),
  });

  return true;
}

async function saveTextObject(pathname, payload, contentType = "text/plain; charset=utf-8") {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return false;
  }

  const normalizedPath = normalizePath(pathname);
  const url = `${config.baseUrl}/storage/v1/object/${encodeURIComponent(
    config.bucket
  )}/${normalizedPath}?upsert=true`;
  await requestWithFetch(url, {
    method: "POST",
    headers: {
      ...textHeaders(config.key, contentType),
      "x-upsert": "true",
    },
    body: payload,
  });

  return true;
}

async function hasObject(pathname) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return false;
  }

  const normalizedPath = normalizePath(pathname);
  const url = `${config.baseUrl}/storage/v1/object/${encodeURIComponent(
    config.bucket
  )}/${normalizedPath}`;
  try {
    await requestWithFetch(url, {
      method: "HEAD",
      headers: jsonHeaders(config.key),
    });
    return true;
  } catch {
    return false;
  }
}

function buildStatePath(filename) {
  const config = getRuntimeConfig();
  const prefix = normalizeKeyPrefix(config.prefix);
  const path = normalizePath(filename);
  return prefix ? `${prefix}/${path}` : path;
}

function fallbackSafeClone(value, fallbackValue = null) {
  if (value === null || value === undefined) {
    return clone(fallbackValue);
  }
  return clone(value);
}

function isChunkManifest(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.__supabaseChunkedState === true &&
    Number.isInteger(value.chunkCount) &&
    value.chunkCount > 0
  );
}

function getChunkSizeBytes() {
  const parsed = Number(process.env.SUPABASE_CHUNK_SIZE_BYTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUPABASE_CHUNK_SIZE_BYTES;
  }

  return Math.max(256 * 1024, Math.floor(parsed));
}

function chunkStateString(serialized) {
  const chunkSize = getChunkSizeBytes();
  const chunks = [];

  for (let offset = 0; offset < serialized.length; offset += chunkSize) {
    chunks.push(serialized.slice(offset, offset + chunkSize));
  }

  return chunks;
}

function buildChunkPath(basePath, index) {
  return `${normalizePath(basePath)}.__chunks__/${index}.part`;
}

async function loadChunkedState(pathname, manifest) {
  const chunkCount = Number(manifest.chunkCount || 0);
  const chunks = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const chunkText = await loadTextObject(buildChunkPath(pathname, index));
    chunks.push(chunkText || "");
  }

  const serialized = chunks.join("");
  if (!serialized) {
    return null;
  }

  return JSON.parse(serialized);
}

async function saveChunkedState(pathname, payload) {
  const serialized = JSON.stringify(payload);
  const chunks = chunkStateString(serialized);

  for (let index = 0; index < chunks.length; index += 1) {
    await saveTextObject(buildChunkPath(pathname, index), chunks[index], "application/json");
  }

  await saveObject(pathname, {
    __supabaseChunkedState: true,
    version: 1,
    chunkCount: chunks.length,
    chunkByteSize: getChunkSizeBytes(),
    savedAt: new Date().toISOString(),
  });

  return true;
}

function logPersistenceWarning(action, stateKey, details) {
  if (process.env.NODE_ENV !== "test") {
    console.warn(`Supabase ${action} failed for ${stateKey}: ${details}`);
  }
}

async function loadStateObject(stateKey, fallbackValue = null) {
  const result = await loadStateObjectDetailed(stateKey, fallbackValue);
  return result.value;
}

async function loadStateObjectDetailed(stateKey, fallbackValue = null, options = {}) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    recordPersistenceRuntime("lastLoads", stateKey, {
      ok: true,
      source: "local-fallback",
      remoteEnabled: false,
    });
    return {
      value: fallbackSafeClone(fallbackValue),
      source: "local-fallback",
      remoteEnabled: false,
      error: null,
    };
  }

  try {
    const loaded = await loadObject(buildStatePath(stateKey));
    const resolved = isChunkManifest(loaded)
      ? await loadChunkedState(buildStatePath(stateKey), loaded)
      : loaded;
    let value;
    if (Array.isArray(fallbackValue) || fallbackValue === null) {
      value = resolved !== null && Array.isArray(resolved) ? resolved : fallbackSafeClone(fallbackValue);
    } else {
      value = resolved && typeof resolved === "object" ? resolved : fallbackSafeClone(fallbackValue);
    }
    recordPersistenceRuntime("lastLoads", stateKey, {
      ok: true,
      source: "database",
      remoteEnabled: true,
    });
    return {
      value,
      source: "database",
      remoteEnabled: true,
      error: null,
    };
  } catch (error) {
    logPersistenceWarning("load", stateKey, error.message);
    recordPersistenceRuntime("lastLoads", stateKey, {
      ok: false,
      source: "local-fallback",
      remoteEnabled: true,
      error: sanitizeError(error),
    });
    if (options.throwOnError === true) {
      throw error;
    }
    return {
      value: fallbackSafeClone(fallbackValue),
      source: "local-fallback",
      remoteEnabled: true,
      error: sanitizeError(error),
    };
  }
}

function queueStateSync(stateKey, payload) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return;
  }

  const snapshot = clone(payload);
  Promise.resolve()
    .then(() => saveStateObject(stateKey, snapshot))
    .catch((error) => {
      recordPersistenceRuntime("lastSaves", stateKey, {
        ok: false,
        error: sanitizeError(error),
      });
      logPersistenceWarning("save", stateKey, error.message);
    });
}

async function saveStateObject(stateKey, payload) {
  const config = getRuntimeConfig();
  if (!config.enabled) {
    return false;
  }

  const pathname = buildStatePath(stateKey);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > getChunkSizeBytes()) {
    await saveChunkedState(pathname, payload);
    recordPersistenceRuntime("lastSaves", stateKey, {
      ok: true,
      source: "database",
      chunked: true,
    });
    return true;
  }

  await saveObject(pathname, payload);
  recordPersistenceRuntime("lastSaves", stateKey, {
    ok: true,
    source: "database",
    chunked: false,
  });
  return true;
}

async function flushStateObject(stateKey, payload) {
  try {
    return await saveStateObject(stateKey, payload);
  } catch (error) {
    recordPersistenceRuntime("lastSaves", stateKey, {
      ok: false,
      error: sanitizeError(error),
    });
    logPersistenceWarning("save", stateKey, error.message);
    return false;
  }
}

function getPersistenceRuntimeSnapshot() {
  const config = getRuntimeConfig();
  let host = "";
  try {
    host = config.baseUrl ? new URL(config.baseUrl).host : "";
  } catch {
    host = "";
  }

  return {
    enabled: Boolean(config.enabled),
    bucket: config.bucket,
    prefix: config.prefix,
    host,
    lastLoads: clone(persistenceRuntime.lastLoads),
    lastSaves: clone(persistenceRuntime.lastSaves),
  };
}

module.exports = {
  hasObject,
  buildStatePath,
  loadStateObject,
  loadStateObjectDetailed,
  queueStateSync,
  flushStateObject,
  saveStateObject,
  getPersistenceRuntimeSnapshot,
};
