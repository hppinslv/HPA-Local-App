function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function combineTransactions(payments, credits) {
  return [...(payments || []), ...(credits || [])].map((entry) => ({
    certificateNumber: entry.certificateNumber,
    monthsPaid: entry.monthsPaid,
    premium: entry.premium,
    raw: entry.raw,
  }));
}

function summarizeTransactions(transactions) {
  const byCertificate = new Map();

  for (const entry of transactions || []) {
    const certificateNumber = String(entry.certificateNumber || "").trim();
    const current =
      byCertificate.get(certificateNumber) || {
        certificateNumber,
        monthsPaid: 0,
        premium: 0,
        transactionCount: 0,
      };

    current.monthsPaid += Number(entry.monthsPaid || 0);
    current.premium += Number(entry.premium || 0);
    current.transactionCount += 1;
    byCertificate.set(certificateNumber, current);
  }

  return Array.from(byCertificate.values()).map((entry) => ({
    ...entry,
    monthsPaid: entry.monthsPaid,
    premium: roundCurrency(entry.premium),
  }));
}

module.exports = {
  combineTransactions,
  roundCurrency,
  summarizeTransactions,
};
