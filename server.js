const http = require("http");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const {
  clearRunsForMonth,
  createMonthEndBatch,
  createRun,
  generateFinalSummaryLetter,
  getArtifactPath,
  getRun,
  listRuns,
  initializeReportRunPersistence,
} = require("./services/monthlyReportService");
const {
  createAuthorizationUrl,
  exchangeCodeForToken,
  getAuthStatus,
} = require("./services/salesforceAuthService");
const { getAnalysisDebugFilePath } = require("./services/salesforceClient");
const {
  addDnmStateGroup,
  addScfAction,
  addReferenceListItems,
  archiveAnalysisSetup,
  compareAnalysisReports,
  createAnalysisRun,
  deleteAnalysisReport,
  deleteAnalysisReports,
  deleteAnalysisRun,
  deleteAnalysisSetup,
  writeReferenceListExport,
  getAnalysisArtifactPath,
  getAnalysisReport,
  getAnalysisReportRateDebug,
  getAnalysisReportScfMetrics,
  getAnalysisReportExportPath,
  getAnalysisRun,
  getAnalysisSetup,
  getReferenceListByType,
  importReferenceList,
  listAnalysisReports,
  listAnalysisRuns,
  listAnalysisSetups,
  listReferenceLists,
  rebuildAnalysisReport,
  renameAnalysisReport,
  removeDnmStateGroup,
  removeReferenceListItem,
  initializeAnalysisStatePersistence,
  saveAnalysisSetup,
  saveComparison,
} = require("./services/analysisService");
const {
  deleteApplication,
  getApplication,
  initializeApplicationPersistence,
  listApplications,
  saveApplication,
} = require("./services/applicationService");
const {
  createCcPaymentImportSession,
  deleteCcPaymentImportSession,
  exportCcPaymentImportSession,
  confirmCcPaymentImport,
  getCcPaymentImportSession,
  initializeCcPaymentImportPersistence,
  listCcPaymentImportTemplates,
  listCcPaymentImportSessions,
  refreshCcPaymentImportPolicyLookup,
  refreshCcPaymentImportPolicyLookupFromSalesforce,
  revalidateSession,
  updateCcPaymentImportRow,
} = require("./services/ccPaymentImportService");
const {
  createCheckImportSession,
  exportCheckImportErrors,
  confirmCheckImport,
  deleteCheckImportRows,
  deleteCheckImportSession,
  getCheckImportSession,
  initializeCheckImportPersistence,
  listCheckImportSessions,
  listCheckImportTemplates,
  refreshCheckImportPolicyLookupFromSalesforce,
  revalidateSession: revalidateCheckImportSession,
  updateCheckImportRow,
  updateCheckImportRows,
} = require("./services/checkImportService");
const {
  clearCurrentAchReturnSession,
  confirmAchReturnImport,
  confirmCurrentAchReturnImport,
  createAchReturnRow,
  exportAchReturnSession,
  getAchReturnSession,
  getCurrentAchReturnSession,
  initializeAchReturnPersistence,
  listAchReturnSessions,
  previewAchReturn,
  removeAchReturnRow,
} = require("./services/achReturnService");
const {
  deleteMostRecentMailingDataRun,
  generateMailingDataWorkbook,
  getMailingDataArtifact,
  getNextMailingCaseNumber,
  initializeMailingDataPersistence,
  listMailingDataHistory,
  previewMailingData,
} = require("./services/mailingDataService");
const {
  getAllConfiguredSalesforceReports,
  getMonthlyReportTypes,
} = require("./services/reportCatalog");
const {
  initializeCertificateLookupPersistence,
  maybeRunStartupCertificateLookupRefresh,
  scheduleNextCertificateLookupRefresh,
} = require("./services/certificateLookupCacheService");
const {
  buildTrendRows,
  captureScoreDashboardSnapshot,
  debugScoreDashboardSnapshotReports,
  exportScoreDashboardSnapshotsCsv,
  getLatestSuccessfulScoreDashboardSnapshot,
  getScoreDashboardSnapshotConfig,
  isSalesforceAuthFailureMessage,
  initializeScoreDashboardSnapshotPersistence,
  listScoreDashboardSnapshots,
  maybeRunStartupScoreDashboardSnapshot,
  scheduleNextScoreDashboardSnapshot,
} = require("./services/scoreDashboardSnapshotService");

const port = process.env.PORT || 4173;
const rootDir = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, payload, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    ...headers,
  });
  response.end(payload);
}

function decodeRequestBody(request, rawBody) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  const declaredCharset = charsetMatch ? charsetMatch[1].trim() : "";

  if (declaredCharset === "utf-16le") {
    return rawBody.toString("utf16le");
  }

  if (rawBody.length >= 2) {
    const byte0 = rawBody[0];
    const byte1 = rawBody[1];

    if (byte0 === 0xff && byte1 === 0xfe) {
      return rawBody.slice(2).toString("utf16le");
    }

    if (byte0 === 0xfe && byte1 === 0xff) {
      const swapped = Buffer.alloc(rawBody.length - 2);
      for (let index = 2; index < rawBody.length; index += 2) {
        swapped[index - 2] = rawBody[index + 1];
        swapped[index - 1] = rawBody[index];
      }
      return swapped.toString("utf16le");
    }
  }

  let decoded = rawBody.toString("utf8");

  if (decoded.charCodeAt(0) === 0xfeff) {
    decoded = decoded.slice(1);
  }

  return decoded;
}

function parseRequestBody(request, rawBody) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  const decodedBody = decodeRequestBody(request, rawBody).replace(/\u0000/g, "").trim();

  if (!decodedBody) {
    return {};
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return querystring.parse(decodedBody);
  }

  try {
    return JSON.parse(decodedBody);
  } catch (error) {
    if (decodedBody.includes("=") && !decodedBody.startsWith("{") && !decodedBody.startsWith("[")) {
      return querystring.parse(decodedBody);
    }

    throw error;
  }
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(parseRequestBody(request, Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function resolveFilePath(urlPathname) {
  const sanitizedPath = urlPathname === "/" ? "/index.html" : urlPathname;
  const resolvedPath = path.normalize(path.join(rootDir, sanitizedPath));

  if (!resolvedPath.startsWith(rootDir)) {
    return null;
  }

  return resolvedPath;
}

function getRequestProtocol(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https" ? "https" : "http";
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/api/monthly-reports" && request.method === "GET") {
    sendJson(response, 200, { runs: listRuns() });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/runs" && request.method === "GET") {
    sendJson(response, 200, { runs: listAnalysisRuns() });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/reports" && request.method === "GET") {
    sendJson(response, 200, { reports: listAnalysisReports() });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/setups" && request.method === "GET") {
    sendJson(response, 200, { setups: listAnalysisSetups() });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/setups" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const setup = saveAnalysisSetup(body);
        sendJson(response, 200, { setup, setups: listAnalysisSetups() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to save analysis setup." });
      });
    return;
  }

  const analysisSetupArchiveMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/setups\/([^/]+)\/archive$/
  );
  if (analysisSetupArchiveMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const setup = archiveAnalysisSetup(analysisSetupArchiveMatch[1], body.archived);
        sendJson(response, 200, { setup, setups: listAnalysisSetups() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to archive analysis setup." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/reference-lists" && request.method === "GET") {
    sendJson(response, 200, { lists: listReferenceLists() });
    return;
  }

  if (requestUrl.pathname === "/api/cc-payment-imports" && request.method === "GET") {
    sendJson(response, 200, { sessions: listCcPaymentImportSessions() });
    return;
  }

  if (requestUrl.pathname === "/api/cc-payment-import-templates" && request.method === "GET") {
    sendJson(response, 200, { templates: listCcPaymentImportTemplates() });
    return;
  }

  if (requestUrl.pathname === "/api/check-imports" && request.method === "GET") {
    sendJson(response, 200, { sessions: listCheckImportSessions() });
    return;
  }

  if (requestUrl.pathname === "/api/check-import-templates" && request.method === "GET") {
    sendJson(response, 200, { templates: listCheckImportTemplates() });
    return;
  }

  if (requestUrl.pathname === "/api/ach-returns" && request.method === "GET") {
    sendJson(response, 200, {
      sessions: listAchReturnSessions(),
      currentSession: getCurrentAchReturnSession(),
    });
    return;
  }

  if (requestUrl.pathname === "/api/mailing-data" && request.method === "GET") {
    sendJson(response, 200, {
      history: listMailingDataHistory(),
      nextCaseNumber: getNextMailingCaseNumber(),
    });
    return;
  }

  if (requestUrl.pathname === "/api/mailing-data/preview" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const preview = previewMailingData(body || {});
        sendJson(response, 200, {
          preview,
          nextCaseNumber: getNextMailingCaseNumber(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to preview Mailing Data workbook." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/mailing-data/generate" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const result = generateMailingDataWorkbook(body || {});
        sendJson(response, 200, {
          historyEntry: result.historyEntry,
          preview: result.preview,
          history: listMailingDataHistory(),
          nextCaseNumber: getNextMailingCaseNumber(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to generate Mailing Data workbook." });
      });
    return;
  }

  const mailingDataDownloadMatch = requestUrl.pathname.match(/^\/api\/mailing-data\/([^/]+)\/download$/);
  if (mailingDataDownloadMatch && request.method === "GET") {
    try {
      const artifact = getMailingDataArtifact(mailingDataDownloadMatch[1]);
      fs.readFile(artifact.filePath, (error, data) => {
        if (error) {
          sendJson(response, 500, { error: "Unable to read generated Mailing Data workbook." });
          return;
        }
        response.writeHead(200, {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Mailing Data workbook not found." });
    }
    return;
  }

  const mailingDataEntryMatch = requestUrl.pathname.match(/^\/api\/mailing-data\/([^/]+)$/);
  if (mailingDataEntryMatch && request.method === "DELETE") {
    try {
      const result = deleteMostRecentMailingDataRun(mailingDataEntryMatch[1]);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to delete Mailing Data run." });
    }
    return;
  }

  const achReturnsPath = requestUrl.pathname.replace(/\/+$/, "");

  if (achReturnsPath === "/api/ach-returns/parse" && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const preview = await previewAchReturn(body.emailBody || "");
        sendJson(response, 200, { preview });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to parse ACH return email." });
      });
    return;
  }

  if (achReturnsPath === "/api/ach-returns/rows" && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await createAchReturnRow({
          emailBody: body.emailBody || "",
          selectedMatchKey: body.selectedMatchKey || "",
          actor: body.actor || body.user,
        });
        sendJson(response, 200, {
          session,
          sessions: listAchReturnSessions(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to create ACH reversal row." });
      });
    return;
  }

  if (achReturnsPath === "/api/ach-returns/current/clear" && request.method === "POST") {
    try {
      clearCurrentAchReturnSession();
      sendJson(response, 200, {
        sessions: listAchReturnSessions(),
        currentSession: getCurrentAchReturnSession(),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to clear ACH reversal table." });
    }
    return;
  }

  if (achReturnsPath === "/api/ach-returns/current/confirm-import" && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        console.log("[ach-returns] POST /api/ach-returns/current/confirm-import", {
          confirmedBy: body.confirmedBy || body.user || "",
        });
        const session = await confirmCurrentAchReturnImport({
          confirmedBy: body.confirmedBy || body.user,
        });
        sendJson(response, 200, {
          session,
          sessions: listAchReturnSessions(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to import the current ACH return batch." });
      });
    return;
  }

  const achReturnConfirmImportMatch = requestUrl.pathname.match(
    /^\/api\/ach-returns\/([^/]+)\/confirm-import$/
  );
  if (achReturnConfirmImportMatch && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        console.log("[ach-returns] POST /api/ach-returns/:id/confirm-import", {
          sessionId: achReturnConfirmImportMatch[1],
          confirmedBy: body.confirmedBy || body.user || "",
        });
        const session = await confirmAchReturnImport(achReturnConfirmImportMatch[1], {
          confirmedBy: body.confirmedBy || body.user,
        });
        sendJson(response, 200, {
          session,
          sessions: listAchReturnSessions(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to import ACH return credits." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/applications" && request.method === "GET") {
    sendJson(response, 200, { applications: listApplications() });
    return;
  }

  if (requestUrl.pathname === "/api/applications" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const application = saveApplication(body);
        sendJson(response, 200, { application, applications: listApplications() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to save application." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/cc-payment-imports/upload" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const session = createCcPaymentImportSession({
          fileName: body.fileName,
          base64Content: body.base64Content,
          uploadedBy: body.uploadedBy || body.user,
          templateKey: body.templateKey,
        });
        sendJson(response, 200, { session, sessions: listCcPaymentImportSessions() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to upload credit card payments." });
      });
    return;
  }

  const ccPaymentImportSessionMatch = requestUrl.pathname.match(/^\/api\/cc-payment-imports\/([^/]+)$/);
  if (ccPaymentImportSessionMatch && request.method === "DELETE") {
    try {
      const result = deleteCcPaymentImportSession(ccPaymentImportSessionMatch[1]);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to delete credit card payment import session." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/check-imports/upload" && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await createCheckImportSession({
          fileName: body.fileName,
          base64Content: body.base64Content,
          uploadedBy: body.uploadedBy || body.user,
          templateKey: body.templateKey,
        });
        sendJson(response, 200, { session, sessions: listCheckImportSessions() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to upload check import file." });
      });
    return;
  }

  const referenceListExportMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/reference-lists\/([^/]+)\/export$/
  );
  if (referenceListExportMatch && request.method === "GET") {
    try {
      const artifact = writeReferenceListExport(referenceListExportMatch[1], {
        format: requestUrl.searchParams.get("format") || "",
      });
      if (!artifact || !artifact.filePath) {
        sendJson(response, 400, { error: "Unable to create list export." });
        return;
      }
      fs.readFile(artifact.filePath, (error, data) => {
        if (error) {
          sendJson(response, 500, { error: "Unable to generate list export." });
          return;
        }
        response.on("finish", () => {
          try {
            fs.unlinkSync(artifact.filePath);
          } catch (cleanupError) {
            // Ignore cleanup errors for temp artifacts.
          }
        });

        response.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to export reference list." });
    }
    return;
  }

  const referenceListMatch = requestUrl.pathname.match(/^\/api\/analysis\/reference-lists\/([^/]+)$/);
  if (referenceListMatch && request.method === "GET") {
    try {
      const list = getReferenceListByType(referenceListMatch[1]);
      sendJson(response, 200, { list });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to load reference list." });
    }
    return;
  }

  const referenceListItemsMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/reference-lists\/([^/]+)\/items$/
  );
  if (referenceListItemsMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const result = addReferenceListItems({
          listType: referenceListItemsMatch[1],
          scfs: body.scfs,
          actor: body.actor,
          scope: body.scope,
          reason: body.reason,
          sourceName: body.sourceName,
          state: body.state,
          requestPayload: body,
        });
        sendJson(response, 200, { result, list: result.list, lists: listReferenceLists() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to add SCFs to reference list." });
      });
    return;
  }

  const dnmStateMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/reference-lists\/dnm\/states\/([^/]+)$/
  );
  if (dnmStateMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const result = addDnmStateGroup({
          stateKey: decodeURIComponent(dnmStateMatch[1]),
          actor: body.actor,
          reason: body.reason,
          sourceName: body.sourceName,
        });
        sendJson(response, 200, { result, list: result.list, lists: listReferenceLists() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to add DNM state." });
      });
    return;
  }

  if (dnmStateMatch && request.method === "DELETE") {
    try {
      const list = removeDnmStateGroup(decodeURIComponent(dnmStateMatch[1]));
      sendJson(response, 200, { list, lists: listReferenceLists() });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to remove DNM state." });
    }
    return;
  }

  const referenceListItemMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/reference-lists\/([^/]+)\/items\/([^/]+)$/
  );
  if (referenceListItemMatch && request.method === "DELETE") {
    try {
      const list = removeReferenceListItem(referenceListItemMatch[1], referenceListItemMatch[2]);
      sendJson(response, 200, { list, lists: listReferenceLists() });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to remove SCF from reference list." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/salesforce/auth-status" && request.method === "GET") {
    sendJson(response, 200, { auth: getAuthStatus() });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/debug-salesforce-report" && request.method === "GET") {
    try {
      const label = String(requestUrl.searchParams.get("label") || "").trim() || "NHCL";
      const filePath = getAnalysisDebugFilePath(label);
      if (!fs.existsSync(filePath)) {
        sendJson(response, 404, { error: `Debug report for ${label} was not found.`, filePath });
        return;
      }

      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      sendJson(response, 200, {
        label,
        filePath,
        payload,
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to read Salesforce analysis debug report." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/salesforce/report-catalog" && request.method === "GET") {
    sendJson(response, 200, {
      reportTypes: getMonthlyReportTypes(),
      reports: getAllConfiguredSalesforceReports(),
    });
    return;
  }

  if (requestUrl.pathname === "/api/monthly-reports/run" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        try {
          const run = createRun(body.reportType, body.reportMonth, body);
          sendJson(response, 202, { run });
        } catch (error) {
          sendJson(response, 400, { error: error.message || "Unable to start month-end report run." });
        }
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Invalid request body." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/config" && request.method === "GET") {
    sendJson(response, 200, { config: getScoreDashboardSnapshotConfig() });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/capture" && request.method === "POST") {
    captureScoreDashboardSnapshot()
      .then((result) => {
        sendJson(response, 200, result);
      })
      .catch((error) => {
        const message = error.message || "Unable to capture SCORE dashboard snapshot.";
        const statusCode = isSalesforceAuthFailureMessage(message) ? 401 : 400;
        sendJson(response, statusCode, { error: message });
      });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/debug" && request.method === "GET") {
    debugScoreDashboardSnapshotReports()
      .then((result) => {
        sendJson(response, 200, result);
      })
      .catch((error) => {
        const message = error.message || "Unable to inspect SCORE dashboard snapshot reports.";
        const statusCode = isSalesforceAuthFailureMessage(message) ? 401 : 400;
        sendJson(response, statusCode, { error: message });
      });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/latest" && request.method === "GET") {
    sendJson(response, 200, getLatestSuccessfulScoreDashboardSnapshot());
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/trend" && request.method === "GET") {
    sendJson(response, 200, {
      rows: buildTrendRows({
        from: requestUrl.searchParams.get("from") || "",
        to: requestUrl.searchParams.get("to") || "",
        reportKey: requestUrl.searchParams.get("reportKey") || "",
        scorePeriod: requestUrl.searchParams.get("scorePeriod") || "",
        paymentType: requestUrl.searchParams.get("paymentType") || "",
        metricKey: requestUrl.searchParams.get("metricKey") || "",
      }),
    });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots/export" && request.method === "GET") {
    const artifact = exportScoreDashboardSnapshotsCsv({
      from: requestUrl.searchParams.get("from") || "",
      to: requestUrl.searchParams.get("to") || "",
      reportKey: requestUrl.searchParams.get("reportKey") || "",
      scorePeriod: requestUrl.searchParams.get("scorePeriod") || "",
      paymentType: requestUrl.searchParams.get("paymentType") || "",
      metricKey: requestUrl.searchParams.get("metricKey") || "",
    });
    sendText(response, 200, artifact.body, artifact.contentType, {
      "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
    });
    return;
  }

  if (requestUrl.pathname === "/api/score-dashboard-snapshots" && request.method === "GET") {
    sendJson(response, 200, listScoreDashboardSnapshots({
      from: requestUrl.searchParams.get("from") || "",
      to: requestUrl.searchParams.get("to") || "",
      reportKey: requestUrl.searchParams.get("reportKey") || "",
      scorePeriod: requestUrl.searchParams.get("scorePeriod") || "",
      paymentType: requestUrl.searchParams.get("paymentType") || "",
      metricKey: requestUrl.searchParams.get("metricKey") || "",
      captureStatus: requestUrl.searchParams.get("captureStatus") || "",
    }));
    return;
  }

  if (requestUrl.pathname === "/api/monthly-reports/run-all" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        try {
          const batch = createMonthEndBatch(body.reportMonth, body);
          sendJson(response, 202, { batch });
        } catch (error) {
          sendJson(response, 400, { error: error.message || "Unable to start month-end batch." });
        }
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Invalid request body." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/monthly-reports/clear-month" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        try {
          const result = clearRunsForMonth(body.reportMonth);
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, 400, { error: error.message || "Unable to clear monthly report output." });
        }
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Invalid request body." });
      });
    return;
  }

  const finalSummaryLetterMatch = requestUrl.pathname.match(
    /^\/api\/monthly-reports\/([^/]+)\/final-summary-letter$/
  );
  if (finalSummaryLetterMatch && request.method === "POST") {
    try {
      const run = generateFinalSummaryLetter(finalSummaryLetterMatch[1]);
      sendJson(response, 200, { run });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to generate final summary letter." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/analysis/runs" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const run = createAnalysisRun(body);
        sendJson(response, 202, { run });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Invalid JSON body." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/reference-lists/import" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const result = importReferenceList(body);
        sendJson(response, 200, { result, lists: listReferenceLists() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to import reference list." });
      });
    return;
  }

  if (requestUrl.pathname === "/oauth/salesforce/start" && request.method === "GET") {
    try {
      const protocol = getRequestProtocol(request);
      response.writeHead(302, {
        Location: createAuthorizationUrl({
          headers: request.headers,
          protocol,
        }),
      });
      response.end();
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/oauth/salesforce/callback" && request.method === "GET") {
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const oauthError = requestUrl.searchParams.get("error");

    if (oauthError) {
      sendJson(response, 400, {
        error: requestUrl.searchParams.get("error_description") || oauthError,
      });
      return;
    }

    exchangeCodeForToken(
      { code, state },
      {
        headers: request.headers,
        protocol: getRequestProtocol(request),
      }
    )
      .then(() => {
        response.writeHead(302, {
          Location: "/?salesforce=connected",
        });
        response.end();
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return;
  }

  const runMatch = requestUrl.pathname.match(/^\/api\/monthly-reports\/([^/]+)$/);
  if (runMatch && request.method === "GET") {
    const run = getRun(runMatch[1]);

    if (!run) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }

    sendJson(response, 200, { run });
    return;
  }

  const analysisRunMatch = requestUrl.pathname.match(/^\/api\/analysis\/runs\/([^/]+)$/);
  if (analysisRunMatch && request.method === "GET") {
    const run = getAnalysisRun(analysisRunMatch[1]);

    if (!run) {
      sendJson(response, 404, { error: "Analysis run not found." });
      return;
    }

    sendJson(response, 200, { run });
    return;
  }

  const analysisReportScfMetricsMatch = requestUrl.pathname.match(/^\/api\/analysis\/reports\/([^/]+)\/scf-metrics$/);
  if (analysisReportScfMetricsMatch && request.method === "GET") {
    const scf = requestUrl.searchParams.get("scf") || "";
    getAnalysisReportScfMetrics(analysisReportScfMetricsMatch[1], scf)
      .then((metrics) => {
        sendJson(response, 200, { metrics });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to load SCF metrics." });
      });
    return;
  }

  const analysisReportScfDebugMatch = requestUrl.pathname.match(/^\/api\/analysis\/reports\/([^/]+)\/scf\/([^/]+)\/debug-rates$/);
  if (analysisReportScfDebugMatch && request.method === "GET") {
    getAnalysisReportRateDebug(analysisReportScfDebugMatch[1], analysisReportScfDebugMatch[2])
      .then((debug) => {
        sendJson(response, 200, { debug });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to load SCF rate debug." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/reports/bulk-delete" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const deletedIds = deleteAnalysisReports(body.reportIds);
        sendJson(response, 200, { deletedIds, reports: listAnalysisReports() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to delete selected analysis reports." });
      });
    return;
  }

  const analysisReportMatch = requestUrl.pathname.match(/^\/api\/analysis\/reports\/([^/]+)$/);
  if (analysisReportMatch && request.method === "GET") {
    const report = getAnalysisReport(analysisReportMatch[1]);

    if (!report) {
      sendJson(response, 404, { error: "Analysis report not found." });
      return;
    }

    sendJson(response, 200, { report });
    return;
  }

  if (analysisReportMatch && request.method === "DELETE") {
    try {
      deleteAnalysisReport(analysisReportMatch[1]);
      sendJson(response, 200, { reports: listAnalysisReports() });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Analysis report not found." });
    }
    return;
  }

  if (analysisReportMatch && request.method === "PATCH") {
    collectRequestBody(request)
      .then((body) => {
        const shouldRebuild = Boolean(body.rebuild);
        const action = shouldRebuild
          ? rebuildAnalysisReport(analysisReportMatch[1])
          : Promise.resolve(
              renameAnalysisReport(analysisReportMatch[1], body.reportName || body.report_name)
            );
        return action;
      })
      .then((report) => {
        sendJson(response, 200, { report, reports: listAnalysisReports() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to update analysis report." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/analysis/reports/compare" && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const comparison = compareAnalysisReports(body.reportAId, body.reportBId, body);
        sendJson(response, 200, { comparison });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to compare analysis reports." });
      });
    return;
  }

  if (analysisRunMatch && request.method === "DELETE") {
    try {
      deleteAnalysisRun(analysisRunMatch[1]);
      sendJson(response, 200, { runs: listAnalysisRuns() });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Analysis run not found." });
    }
    return;
  }

  const analysisSetupMatch = requestUrl.pathname.match(/^\/api\/analysis\/setups\/([^/]+)$/);
  if (analysisSetupMatch && request.method === "GET") {
    const setup = getAnalysisSetup(analysisSetupMatch[1]);

    if (!setup) {
      sendJson(response, 404, { error: "Analysis setup not found." });
      return;
    }

    sendJson(response, 200, { setup });
    return;
  }

  if (analysisSetupMatch && request.method === "DELETE") {
    try {
      deleteAnalysisSetup(analysisSetupMatch[1]);
      sendJson(response, 200, { setups: listAnalysisSetups() });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to delete analysis setup." });
    }
    return;
  }

  const analysisSetupDeleteMatch = requestUrl.pathname.match(/^\/api\/analysis\/setups\/([^/]+)\/delete$/);
  if (analysisSetupDeleteMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const result = deleteAnalysisSetup(analysisSetupDeleteMatch[1], {
          revertReferenceLists: body.revertReferenceLists === true,
          actor: body.actor,
        });
        sendJson(response, 200, {
          result,
          setups: listAnalysisSetups(),
          reports: listAnalysisReports(),
          runs: listAnalysisRuns(),
          lists: listReferenceLists(),
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to delete analysis setup." });
      });
    return;
  }

  if (ccPaymentImportSessionMatch && request.method === "GET") {
    try {
      const session = getCcPaymentImportSession(ccPaymentImportSessionMatch[1]);
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Credit card payment import session not found." });
    }
    return;
  }

  const applicationMatch = requestUrl.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (applicationMatch && request.method === "GET") {
    const application = getApplication(applicationMatch[1]);
    if (!application) {
      sendJson(response, 404, { error: "Application not found." });
      return;
    }
    sendJson(response, 200, { application });
    return;
  }

  if (applicationMatch && request.method === "DELETE") {
    try {
      const applications = deleteApplication(applicationMatch[1]);
      sendJson(response, 200, { applications });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Unable to delete application." });
    }
    return;
  }

  const ccPaymentImportRefreshMatch = requestUrl.pathname.match(
    /^\/api\/cc-payment-imports\/([^/]+)\/refresh-policy-lookup$/
  );
  if (ccPaymentImportRefreshMatch && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = body.fileName && body.base64Content
          ? refreshCcPaymentImportPolicyLookup(ccPaymentImportRefreshMatch[1], body)
          : await refreshCcPaymentImportPolicyLookupFromSalesforce(ccPaymentImportRefreshMatch[1]);
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to refresh policy lookup." });
      });
    return;
  }

  const checkImportSessionMatch = requestUrl.pathname.match(/^\/api\/check-imports\/([^/]+)$/);
  if (checkImportSessionMatch && request.method === "GET") {
    try {
      const session = getCheckImportSession(checkImportSessionMatch[1]);
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Check import session not found." });
    }
    return;
  }

  const achReturnSessionMatch = requestUrl.pathname.match(/^\/api\/ach-returns\/([^/]+)$/);
  if (achReturnSessionMatch && request.method === "GET") {
    try {
      const session = getAchReturnSession(achReturnSessionMatch[1]);
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 404, { error: error.message || "ACH return session not found." });
    }
    return;
  }

  const achReturnRowMatch = requestUrl.pathname.match(/^\/api\/ach-returns\/([^/]+)\/rows\/([^/]+)$/);
  if (achReturnRowMatch && request.method === "DELETE") {
    try {
      const session = removeAchReturnRow(achReturnRowMatch[1], achReturnRowMatch[2]);
      sendJson(response, 200, {
        session,
        sessions: listAchReturnSessions(),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to remove ACH reversal row." });
    }
    return;
  }

  const achReturnExportMatch = requestUrl.pathname.match(/^\/api\/ach-returns\/([^/]+)\/export$/);
  if (achReturnExportMatch && request.method === "GET") {
    try {
      const artifact = exportAchReturnSession(achReturnExportMatch[1]);
      fs.readFile(artifact.filePath, (error, data) => {
        if (error) {
          sendJson(response, 500, { error: "Unable to generate ACH return export." });
          return;
        }
        response.on("finish", () => {
          try {
            fs.unlinkSync(artifact.filePath);
          } catch {
            // ignore cleanup errors
          }
        });
        response.writeHead(200, {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to export ACH returns CSV." });
    }
    return;
  }

  const checkImportRefreshMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/refresh-policy-lookup$/
  );
  if (checkImportRefreshMatch && request.method === "POST") {
    refreshCheckImportPolicyLookupFromSalesforce(checkImportRefreshMatch[1])
      .then((session) => {
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to refresh check policy lookup." });
      });
    return;
  }

  const checkImportRevalidateMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/revalidate$/
  );
  if (checkImportRevalidateMatch && request.method === "POST") {
    try {
      const session = revalidateCheckImportSession(checkImportRevalidateMatch[1]);
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to revalidate check import session." });
    }
    return;
  }

  const checkImportConfirmMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/confirm-import$/
  );
  if (checkImportConfirmMatch && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await confirmCheckImport(checkImportConfirmMatch[1], {
          confirmedBy: body.confirmedBy || body.user,
        });
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to import checks into Salesforce." });
      });
    return;
  }

  const checkImportBulkDeleteMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/rows\/bulk-delete$/
  );
  if (checkImportBulkDeleteMatch && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await deleteCheckImportRows(
          checkImportBulkDeleteMatch[1],
          Array.isArray(body?.rowIds) ? body.rowIds : []
        );
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to delete check import rows." });
      });
    return;
  }

  const checkImportBulkRowMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/rows\/bulk$/
  );
  if (checkImportBulkRowMatch && request.method === "PATCH") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await updateCheckImportRows(
          checkImportBulkRowMatch[1],
          Array.isArray(body?.rows) ? body.rows : [],
          body?.corrected_by || "Local User"
        );
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to update check import rows." });
      });
    return;
  }

  const deleteCheckImportSessionMatch = requestUrl.pathname.match(/^\/api\/check-imports\/([^/]+)$/);
  if (deleteCheckImportSessionMatch && request.method === "DELETE") {
    try {
      const result = deleteCheckImportSession(deleteCheckImportSessionMatch[1]);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to delete check import session." });
    }
    return;
  }

  const checkImportRowMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/rows\/([^/]+)$/
  );
  if (checkImportRowMatch && request.method === "PATCH") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await updateCheckImportRow(checkImportRowMatch[1], checkImportRowMatch[2], body);
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to update check import row." });
      });
    return;
  }

  const checkImportExportMatch = requestUrl.pathname.match(
    /^\/api\/check-imports\/([^/]+)\/export-errors$/
  );
  if (checkImportExportMatch && request.method === "GET") {
    try {
      const artifact = exportCheckImportErrors(checkImportExportMatch[1]);
      fs.readFile(artifact.filePath, (error, data) => {
        if (error) {
          sendJson(response, 500, { error: "Unable to generate export." });
          return;
        }
        response.on("finish", () => {
          try {
            fs.unlinkSync(artifact.filePath);
          } catch {
            // ignore cleanup errors
          }
        });
        response.writeHead(200, {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to export check import issues." });
    }
    return;
  }

  const ccPaymentImportRevalidateMatch = requestUrl.pathname.match(
    /^\/api\/cc-payment-imports\/([^/]+)\/revalidate$/
  );
  if (ccPaymentImportRevalidateMatch && request.method === "POST") {
    try {
      const session = revalidateSession(ccPaymentImportRevalidateMatch[1]);
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to revalidate credit card payment import." });
    }
    return;
  }

  const ccPaymentImportConfirmMatch = requestUrl.pathname.match(
    /^\/api\/cc-payment-imports\/([^/]+)\/confirm-import$/
  );
  if (ccPaymentImportConfirmMatch && request.method === "POST") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await confirmCcPaymentImport(ccPaymentImportConfirmMatch[1], {
          confirmedBy: body.confirmedBy || body.user,
        });
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to import credit card payments into Salesforce." });
      });
    return;
  }

  const ccPaymentImportRowMatch = requestUrl.pathname.match(
    /^\/api\/cc-payment-imports\/([^/]+)\/rows\/([^/]+)$/
  );
  if (ccPaymentImportRowMatch && request.method === "PATCH") {
    collectRequestBody(request)
      .then(async (body) => {
        const session = await updateCcPaymentImportRow(
          ccPaymentImportRowMatch[1],
          ccPaymentImportRowMatch[2],
          body
        );
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to update credit card payment import row." });
      });
    return;
  }

  const ccPaymentImportExportMatch = requestUrl.pathname.match(
    /^\/api\/cc-payment-imports\/([^/]+)\/export$/
  );
  if (ccPaymentImportExportMatch && request.method === "GET") {
    try {
      const artifact = exportCcPaymentImportSession(ccPaymentImportExportMatch[1]);
      fs.readFile(artifact.filePath, (error, data) => {
        if (error) {
          sendJson(response, 500, { error: "Unable to generate export." });
          return;
        }
        response.on("finish", () => {
          try {
            fs.unlinkSync(artifact.filePath);
          } catch {
            // ignore cleanup errors
          }
        });
        response.writeHead(200, {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to export credit card payment import session." });
    }
    return;
  }

  const analysisRunActionMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/runs\/([^/]+)\/scf-actions$/
  );
  if (analysisRunActionMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const run = addScfAction(analysisRunActionMatch[1], body);
        sendJson(response, 200, { run, lists: listReferenceLists() });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to save SCF action." });
      });
    return;
  }

  const analysisRunComparisonMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/runs\/([^/]+)\/comparisons$/
  );
  if (analysisRunComparisonMatch && request.method === "POST") {
    collectRequestBody(request)
      .then((body) => {
        const run = saveComparison(analysisRunComparisonMatch[1], body);
        sendJson(response, 200, { run });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message || "Unable to save comparison." });
      });
    return;
  }

  const artifactMatch = requestUrl.pathname.match(
    /^\/api\/monthly-reports\/([^/]+)\/artifacts\/([^/]+)$/
  );
  if (artifactMatch && request.method === "GET") {
    const artifact = getArtifactPath(artifactMatch[1], artifactMatch[2]);

    if (!artifact) {
      sendJson(response, 404, { error: "Artifact not found." });
      return;
    }

    fs.readFile(artifact.filePath, (error, data) => {
      if (error) {
        sendJson(response, 500, { error: "Unable to read artifact." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `inline; filename="${path.basename(artifact.filePath)}"`,
      });
      response.end(data);
    });
    return;
  }

  const analysisArtifactMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/runs\/([^/]+)\/artifacts\/([^/]+)$/
  );
  if (analysisArtifactMatch && request.method === "GET") {
    const artifact = getAnalysisArtifactPath(analysisArtifactMatch[1], analysisArtifactMatch[2]);

    if (!artifact) {
      sendJson(response, 404, { error: "Analysis artifact not found." });
      return;
    }

    fs.readFile(artifact.filePath, (error, data) => {
      if (error) {
        sendJson(response, 500, { error: "Unable to read analysis artifact." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `inline; filename="${path.basename(artifact.filePath)}"`,
      });
      response.end(data);
    });
    return;
  }

  const analysisReportExportMatch = requestUrl.pathname.match(
    /^\/api\/analysis\/reports\/([^/]+)\/export$/
  );
  if (analysisReportExportMatch && request.method === "GET") {
    const artifact = getAnalysisReportExportPath(analysisReportExportMatch[1]);

    if (!artifact) {
      sendJson(response, 404, { error: "Analysis report export not found." });
      return;
    }

    fs.readFile(artifact.filePath, (error, data) => {
      if (error) {
        sendJson(response, 500, { error: "Unable to read analysis report export." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.fileName || path.basename(artifact.filePath)}"`,
      });
      response.end(data);
    });
    return;
  }

  const filePath = resolveFilePath(requestUrl.pathname);

  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      contentTypes[extension] || "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  });
});

server.listen(port, () => {
  console.log(`HPA Automations is running at http://localhost:${port}`);
});

initializeCertificateLookupPersistence()
  .then(() => Promise.all([
    initializeApplicationPersistence(),
    initializeAnalysisStatePersistence(),
    initializeReportRunPersistence(),
    initializeScoreDashboardSnapshotPersistence(),
    initializeCcPaymentImportPersistence(),
    initializeCheckImportPersistence(),
    initializeAchReturnPersistence(),
    initializeMailingDataPersistence(),
  ]))
  .then(async () => {
    await maybeRunStartupScoreDashboardSnapshot(console);
    await maybeRunStartupCertificateLookupRefresh(console);
    scheduleNextScoreDashboardSnapshot(console);
    scheduleNextCertificateLookupRefresh(console);
  })
  .catch((error) => {
    console.warn("Could not initialize persistence from Supabase:", error.message);
    scheduleNextScoreDashboardSnapshot(console);
    scheduleNextCertificateLookupRefresh(console);
  });
