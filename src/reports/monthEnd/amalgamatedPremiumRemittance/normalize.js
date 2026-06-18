const { normalizeLabel, parseDateValue, parseNumber } = require("../../../../services/salesforceClient");

function buildLookup(row) {
  const lookup = new Map();

  Object.entries(row || {}).forEach(([key, value]) => {
    lookup.set(normalizeLabel(key), value);
  });

  return lookup;
}

function firstValue(row, labels, options = {}) {
  const lookup = buildLookup(row);

  for (const label of labels) {
    const value = lookup.get(normalizeLabel(label));
    if (value === undefined || value === null) {
      continue;
    }

    if (!options.allowBlank && String(value).trim() === "") {
      continue;
    }

    return value;
  }

  return options.fallback;
}

function normalizeCertificateNumber(value) {
  return String(value ?? "").trim();
}

function resolveCertificateNumber(row, labels) {
  const expandedLabels = labels.flatMap((label) => [
    `${label}__label`,
    `${label} label`,
    label,
  ]);

  return normalizeCertificateNumber(
    firstValue(row, expandedLabels, {
      fallback: "",
    })
  );
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }

  try {
    return parseDateValue(value, String(value));
  } catch (error) {
    return "";
  }
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  return parseNumber(value);
}

function joinNameParts(...parts) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function normalizeCertRows(rows) {
  return rows.map((row) => ({
    certificateNumber: resolveCertificateNumber(row, [
      "Certificate Name",
      "Certificate",
      "Certificate Number",
    ]),
    state: String(
      firstValue(row, ["Billing State/Province", "State", "Billing State"], {
        fallback: "",
      })
    ).trim(),
    product: String(firstValue(row, ["Product"], { fallback: "" })).trim(),
    policyType: String(firstValue(row, ["Policy Type"], { fallback: "" })).trim(),
    effectiveDate: parseOptionalDate(firstValue(row, ["Effective Date"], { fallback: "" })),
    payToDate: parseOptionalDate(firstValue(row, ["Pay To Date"], { fallback: "" })),
    origRate1: parseOptionalNumber(firstValue(row, ["Orig Rate (1 Person)", "Rate 1"], { fallback: "" })),
    origRate2: parseOptionalNumber(firstValue(row, ["Orig Rate (2 Person)", "Rate 2"], { fallback: "" })),
    totalAddCoverage: parseOptionalNumber(
      firstValue(row, ["Total AD&D Coverage", "Total ADD Coverage"], { fallback: "" })
    ),
    freeTermLifeCoverageAmt: parseOptionalNumber(
      firstValue(row, ["Free Term Life Coverage Amt", "Life Coverage"], { fallback: "" })
    ),
    origContribAddCoverageAmt: parseOptionalNumber(
      firstValue(row, ["Orig Contrib AD&D Coverage Amt", "Orig Contrib ADD Coverage Amt"], {
        fallback: "",
      })
    ),
    origNonContribAddCoverageAmt: parseOptionalNumber(
      firstValue(
        row,
        ["Orig Non-Contrib AD&D Coverage Amt", "Orig Non Contrib AD&D Coverage Amt"],
        {
          fallback: "",
        }
      )
    ),
    raw: row,
  }));
}

function normalizePaymentRows(rows) {
  return rows.map((row) => ({
    certificateNumber: resolveCertificateNumber(row, [
      "Certificate",
      "Certificate Name",
      "Certificate Number",
    ]),
    monthsPaid: parseOptionalNumber(firstValue(row, ["Months Paid"], { fallback: "" })),
    premium: parseOptionalNumber(firstValue(row, ["Premium"], { fallback: "" })),
    raw: row,
  }));
}

function normalizeCreditRows(rows) {
  return rows.map((row) => {
    const rollbackMonths = parseOptionalNumber(
      firstValue(row, ["Rollback Months", "Months Paid"], { fallback: "" })
    );
    const premium = parseOptionalNumber(firstValue(row, ["Premium"], { fallback: "" }));

    return {
      certificateNumber: resolveCertificateNumber(row, [
        "Certificate / Certificate Name",
        "Certificate Name",
        "Certificate",
        "Certificate Number",
      ]),
      monthsPaid: rollbackMonths === null ? null : rollbackMonths * -1,
      premium: premium === null ? null : premium * -1,
      raw: row,
    };
  });
}

function normalizeContactRows(rows) {
  return rows.map((row) => ({
    certificateNumber: resolveCertificateNumber(row, [
      "Certificate Name",
      "Certificate",
      "Certificate Number",
    ]),
    firstName: String(
      firstValue(row, ["First Name__label", "First Name label", "First Name"], {
        fallback: "",
      })
    ).trim(),
    middleName: String(
      firstValue(row, ["Middle Name__label", "Middle Name label", "Middle Name"], {
        fallback: "",
      })
    ).trim(),
    lastName: String(
      firstValue(row, ["Last Name__label", "Last Name label", "Last Name"], {
        fallback: "",
      })
    ).trim(),
    fullName: joinNameParts(
      firstValue(row, ["First Name__label", "First Name label", "First Name"], { fallback: "" }),
      firstValue(row, ["Middle Name__label", "Middle Name label", "Middle Name"], { fallback: "" }),
      firstValue(row, ["Last Name__label", "Last Name label", "Last Name"], { fallback: "" })
    ),
    dateOfBirth: parseOptionalDate(firstValue(row, ["Date of Birth"], { fallback: "" })),
    startingAge: parseOptionalNumber(firstValue(row, ["Starting Age Calc"], { fallback: "" })),
    currentAge: parseOptionalNumber(firstValue(row, ["Current Age"], { fallback: "" })),
    type: String(firstValue(row, ["Type"], { fallback: "" })).trim(),
    raw: row,
  }));
}

function normalizeDatasets(rawDatasets) {
  return {
    certs: normalizeCertRows(rawDatasets.certs || []),
    payments: normalizePaymentRows(rawDatasets.payments || []),
    credits: normalizeCreditRows(rawDatasets.credits || []),
    contact1: normalizeContactRows(rawDatasets.contact1 || []),
    contact2: normalizeContactRows(rawDatasets.contact2 || []),
  };
}

module.exports = {
  firstValue,
  joinNameParts,
  normalizeCertificateNumber,
  resolveCertificateNumber,
  normalizeDatasets,
};
