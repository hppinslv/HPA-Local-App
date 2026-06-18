const {
  AHA_RATE,
  AMAL_RATE,
  FIXED_ORIG_EFFECTIVE_DATE,
  buildFinalColumns,
} = require("./config");
const { roundCurrency } = require("./combineTransactions");

function normalizeInsuranceProduct(product) {
  return String(product || "").trim();
}

function endsWithReduced(product) {
  return normalizeInsuranceProduct(product).toLowerCase().endsWith("reduced");
}

function indicatesAddAndLife(product) {
  const normalized = normalizeInsuranceProduct(product)
    .toLowerCase()
    .replace(/and/g, "&");
  return normalized.includes("life") && (normalized.includes("ad&d") || normalized.includes("ad d") || normalized.includes("add"));
}

function deriveInsurance(product) {
  const fullCoverage = !endsWithReduced(product);
  const secondCoverage = indicatesAddAndLife(product);

  if (fullCoverage) {
    return normalizeInsuranceProduct(product);
  }

  return secondCoverage ? "AD&D & LIFE" : "AD&D";
}

function deriveMemberCount(policyType) {
  const match = String(policyType || "").match(/^(\d)/);
  return match ? Number(match[1]) : null;
}

function maxIsoDate(left, right) {
  if (!left) {
    return right || "";
  }

  if (!right) {
    return left;
  }

  return left >= right ? left : right;
}

function applyAgeReduction(baseAmount, age) {
  if (baseAmount === null || baseAmount === undefined) {
    return null;
  }

  if (age === null || age === undefined) {
    return baseAmount;
  }

  if (age >= 80) {
    return roundCurrency(baseAmount * 0.2);
  }

  if (age >= 70) {
    return roundCurrency(baseAmount * 0.5);
  }

  return roundCurrency(baseAmount);
}

function buildLookup(rows) {
  const byCertificate = new Map();

  (rows || []).forEach((row) => {
    const certificateNumber = String(row.certificateNumber || "").trim();
    if (!certificateNumber) {
      return;
    }

    if (!byCertificate.has(certificateNumber)) {
      byCertificate.set(certificateNumber, []);
    }

    byCertificate.get(certificateNumber).push(row);
  });

  return byCertificate;
}

function buildFinalRows(reportMonth, datasets, summarizedTransactions) {
  const certs = datasets.certs || [];
  const certsByCertificate = buildLookup(certs);
  const contact1ByCertificate = buildLookup(datasets.contact1);
  const contact2ByCertificate = buildLookup(datasets.contact2);
  const finalColumns = buildFinalColumns(reportMonth);
  const rows = (summarizedTransactions || []).map((summary) => {
    const certificateNumber = String(summary?.certificateNumber || "").trim();
    const cert = certsByCertificate.get(certificateNumber)?.[0] || null;
    const member1 = contact1ByCertificate.get(certificateNumber)?.[0] || null;
    const member2 = contact2ByCertificate.get(certificateNumber)?.[0] || null;
    const insuranceImport = cert?.product || "";
    const insurance = deriveInsurance(insuranceImport);
    const memberCount = deriveMemberCount(cert?.policyType);
    const rate1 = cert?.origRate1 ?? null;
    const rate2 = cert?.origRate2 ?? null;
    const rate = memberCount === 2 ? rate2 : rate1;
    const addBenefit = cert?.totalAddCoverage ?? null;
    const lifeBenefit = cert?.freeTermLifeCoverageAmt ?? null;
    const origEffectiveDate = FIXED_ORIG_EFFECTIVE_DATE;
    const policyEffectiveDate = cert?.effectiveDate || "";

    return {
      certificate: certificateNumber,
      state: cert?.state || "",
      insuranceImport,
      isFullCoverage: !endsWithReduced(insuranceImport),
      hasSecondCoverage: indicatesAddAndLife(insuranceImport),
      insurance,
      addPolicyNumber: "26MO06",
      lifePolicyNumber: insurance.toLowerCase().endsWith("life") ? "26MO05" : "",
      memberHide: cert?.policyType || "",
      memberCount,
      origEffectiveDate,
      policyEffectiveDate,
      policyEffectiveFrom: maxIsoDate(policyEffectiveDate, origEffectiveDate),
      policyEffectiveTo: cert?.payToDate || "",
      monthsPaidLabelValue: Number(summary?.monthsPaid || 0),
      rate1,
      rate2,
      rate,
      premiumCollectedLabelValue: roundCurrency(summary?.premium || 0),
      amalPrem: roundCurrency(Number(summary?.premium || 0) * AMAL_RATE),
      ahaPrem: roundCurrency(Number(summary?.premium || 0) * AHA_RATE),
      addBenefit,
      lifeBenefit,
      member1: member1?.fullName || "",
      member1Dob: member1?.dateOfBirth || "",
      member1AgeStart: member1?.startingAge ?? null,
      member1CurrentAge: member1?.currentAge ?? null,
      member1AddBenefit: applyAgeReduction(addBenefit, member1?.startingAge ?? null),
      member1LifeBenefit: applyAgeReduction(lifeBenefit, member1?.startingAge ?? null),
      member2: member2?.fullName || "",
      member2Dob: member2?.dateOfBirth || "",
      member2AgeStart: member2?.startingAge ?? null,
      member2CurrentAge: member2?.currentAge ?? null,
      member2AddBenefit:
        member2 ? applyAgeReduction(addBenefit, member2.startingAge ?? null) : null,
      member2LifeBenefit:
        member2 ? applyAgeReduction(lifeBenefit, member2.startingAge ?? null) : null,
      addCoverage: cert?.totalAddCoverage ?? null,
      addContribCoverage: cert?.origContribAddCoverageAmt ?? null,
      addNonContribCoverage: cert?.origNonContribAddCoverageAmt ?? null,
      _source: {
        cert,
        member1,
        member2,
      },
    };
  });

  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.memberCount += Number(row.memberCount || 0);
      accumulator.monthsPaid += Number(row.monthsPaidLabelValue || 0);
      accumulator.premiumCollected += Number(row.premiumCollectedLabelValue || 0);
      accumulator.amalPrem += Number(row.amalPrem || 0);
      accumulator.ahaPrem += Number(row.ahaPrem || 0);
      return accumulator;
    },
    {
      memberCount: 0,
      monthsPaid: 0,
      premiumCollected: 0,
      amalPrem: 0,
      ahaPrem: 0,
    }
  );

  return {
    finalColumns,
    rows,
    totals: {
      memberCount: totals.memberCount,
      monthsPaid: totals.monthsPaid,
      premiumCollected: roundCurrency(totals.premiumCollected),
      amalPrem: roundCurrency(totals.premiumCollected * AMAL_RATE),
      ahaPrem: roundCurrency(totals.premiumCollected * AHA_RATE),
    },
  };
}

module.exports = {
  applyAgeReduction,
  buildFinalRows,
  deriveInsurance,
  deriveMemberCount,
};
