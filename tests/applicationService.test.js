const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateApplicationFinancials,
  validateApplicationPayload,
} = require("../services/applicationService");

test("application financials calculate 1 person and 2 person premiums for 3000 coverage", () => {
  const result = calculateApplicationFinancials({
    coverageAmount: 3000,
  });

  assert.equal(result.onePersonPremium, 19.95);
  assert.equal(result.twoPersonPremium, 19.95);
});

test("application financials calculate 1 person and 2 person premiums for 27000 coverage", () => {
  const result = calculateApplicationFinancials({
    coverageAmount: 27000,
  });

  assert.equal(result.onePersonPremium, 25.23);
  assert.equal(result.twoPersonPremium, 27.87);
});

test("application validation enforces required mailing information and valid coverage amount", () => {
  const result = validateApplicationPayload({
    customerMailingInformation: "",
    coverageAmount: 0,
  });

  assert.equal(result.errors.includes("Customer Mailing Information is required."), true);
  assert.equal(result.errors.includes("Coverage Amount must be greater than 0."), true);
});
