function countDuplicates(rows) {
  const counts = new Map();

  (rows || []).forEach((row) => {
    const certificateNumber = String(row.certificateNumber || "").trim();
    if (!certificateNumber) {
      return;
    }

    counts.set(certificateNumber, (counts.get(certificateNumber) || 0) + 1);
  });

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([certificateNumber, count]) => ({ certificateNumber, count }));
}

function buildLookup(rows) {
  const map = new Map();

  (rows || []).forEach((row) => {
    const certificateNumber = String(row.certificateNumber || "").trim();
    if (!certificateNumber) {
      return;
    }

    if (!map.has(certificateNumber)) {
      map.set(certificateNumber, []);
    }

    map.get(certificateNumber).push(row);
  });

  return map;
}

function validateReport({ datasets, combinedTransactions, summarizedTransactions, finalRows, monthlySummaryPremiumTotal }) {
  const issues = [];
  const certLookup = buildLookup(datasets.certs);
  const contact1Lookup = buildLookup(datasets.contact1);
  const contact2Lookup = buildLookup(datasets.contact2);

  combinedTransactions.forEach((entry, index) => {
    const rowNumber = index + 1;
    const certificateNumber = String(entry.certificateNumber || "").trim();

    if (!certificateNumber) {
      issues.push({
        severity: "blocking",
        code: "missing-certificate-number",
        message: "Transaction row is missing a certificate number.",
        certificateNumber: "",
        source: "transactions",
        rowNumber,
      });
    }

    if (entry.premium === null || entry.premium === undefined || String(entry.premium).trim?.() === "") {
      issues.push({
        severity: "blocking",
        code: "missing-premium",
        message: `Transaction ${certificateNumber || "(blank certificate)"} is missing a premium amount.`,
        certificateNumber,
        source: "transactions",
        rowNumber,
      });
    }

    if (entry.monthsPaid === null || entry.monthsPaid === undefined || String(entry.monthsPaid).trim?.() === "") {
      issues.push({
        severity: "warning",
        code: "missing-months-paid",
        message: `Transaction ${certificateNumber || "(blank certificate)"} is missing months paid.`,
        certificateNumber,
        source: "transactions",
        rowNumber,
      });
    }

    if (certificateNumber && !certLookup.has(certificateNumber)) {
      issues.push({
        severity: "warning",
        code: "transaction-cert-not-found",
        message: `Transaction certificate ${certificateNumber} was not found in the cert report.`,
        certificateNumber,
        source: "transactions",
        rowNumber,
      });
    }
  });

  countDuplicates(datasets.contact1).forEach((entry) => {
    issues.push({
      severity: "warning",
      code: "duplicate-contact1",
      message: `Certificate ${entry.certificateNumber} has ${entry.count} Contact 1 rows.`,
      certificateNumber: entry.certificateNumber,
      source: "contact1",
    });
  });

  countDuplicates(datasets.contact2).forEach((entry) => {
    issues.push({
      severity: "warning",
      code: "duplicate-contact2",
      message: `Certificate ${entry.certificateNumber} has ${entry.count} Contact 2 rows.`,
      certificateNumber: entry.certificateNumber,
      source: "contact2",
    });
  });

  finalRows.forEach((row) => {
    if (!contact1Lookup.has(row.certificate)) {
      issues.push({
        severity: "warning",
        code: "missing-contact1",
        message: `Certificate ${row.certificate} is missing Contact 1.`,
        certificateNumber: row.certificate,
        source: "contact1",
      });
    }

    if (Number(row.memberCount || 0) >= 2 && !contact2Lookup.has(row.certificate)) {
      issues.push({
        severity: "warning",
        code: "missing-contact2-two-person",
        message: `Certificate ${row.certificate} is marked as 2 people but is missing Contact 2.`,
        certificateNumber: row.certificate,
        source: "contact2",
      });
    }

    if (Number(row.memberCount || 0) === 1 && !contact2Lookup.has(row.certificate)) {
      issues.push({
        severity: "warning",
        code: "missing-contact2-one-person",
        message: `Certificate ${row.certificate} has no Contact 2, which is expected for a 1 Person policy.`,
        certificateNumber: row.certificate,
        source: "contact2",
      });
    }

    if (row.rate === null || row.rate === undefined) {
      issues.push({
        severity: "warning",
        code: "missing-rate",
        message: `Certificate ${row.certificate} is missing a rate.`,
        certificateNumber: row.certificate,
        source: "certs",
      });
    }

    if (!row.policyEffectiveDate) {
      issues.push({
        severity: "warning",
        code: "missing-effective-date",
        message: `Certificate ${row.certificate} is missing an effective date.`,
        certificateNumber: row.certificate,
        source: "certs",
      });
    }
  });

  const blockingErrors = issues.filter((issue) => issue.severity === "blocking");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const premiumCollectedTotal = finalRows.reduce(
    (sum, row) => sum + Number(row.premiumCollectedLabelValue || 0),
    0
  );
  const hasMonthlySummaryTotal = monthlySummaryPremiumTotal !== null && monthlySummaryPremiumTotal !== undefined;
  const difference = hasMonthlySummaryTotal
    ? Math.round((premiumCollectedTotal - Number(monthlySummaryPremiumTotal || 0) + Number.EPSILON) * 100) / 100
    : null;

  return {
    issues,
    blockingErrors,
    warnings,
    validation: {
      monthlySummaryPremiumTotal: hasMonthlySummaryTotal ? Number(monthlySummaryPremiumTotal) : null,
      premiumCollectedTotal,
      matchesMonthlySummary: hasMonthlySummaryTotal ? difference === 0 : false,
      message: !hasMonthlySummaryTotal
        ? "Monthly summary premium total was not provided, so reconciliation could not be completed."
        : difference === 0
        ? "Premium total matches monthly summary."
        : `Premium total does not match monthly summary. Difference: $${difference.toFixed(2)}`,
      difference,
    },
    summary: {
      paymentRowsImported: datasets.payments.length,
      creditRowsImported: datasets.credits.length,
      summarizedCertificates: summarizedTransactions.length,
      totalMonthsPaid: summarizedTransactions.reduce((sum, row) => sum + Number(row.monthsPaid || 0), 0),
      totalPremiumCollected: premiumCollectedTotal,
      warnings: warnings.length,
      blockingErrors: blockingErrors.length,
    },
  };
}

module.exports = {
  validateReport,
};
