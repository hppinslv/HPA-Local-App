const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveRedirectUri,
} = require("../services/salesforceAuthService");

test("resolveRedirectUri prefers forwarded host/proto when configured redirect is localhost", () => {
  const redirectUri = resolveRedirectUri({
    headers: {
      host: "localhost:4173",
      "x-forwarded-host": "hpa-workstation:4173",
      "x-forwarded-proto": "http",
    },
    protocol: "http",
  });

  assert.equal(redirectUri, "http://hpa-workstation:4173/oauth/salesforce/callback");
});

test("resolveRedirectUri keeps explicit non-localhost redirect uri", () => {
  const original = process.env.SALESFORCE_REDIRECT_URI;
  process.env.SALESFORCE_REDIRECT_URI = "https://hpa.example.com/oauth/salesforce/callback";

  try {
    const redirectUri = resolveRedirectUri({
      headers: {
        host: "hpa-workstation:4173",
      },
      protocol: "http",
    });

    assert.equal(redirectUri, "https://hpa.example.com/oauth/salesforce/callback");
  } finally {
    if (original === undefined) {
      delete process.env.SALESFORCE_REDIRECT_URI;
    } else {
      process.env.SALESFORCE_REDIRECT_URI = original;
    }
  }
});

test("resolveRedirectUri prefers browser-facing referer when host is localhost", () => {
  const redirectUri = resolveRedirectUri({
    headers: {
      host: "localhost:4173",
      referer: "https://hpa.example.com/",
    },
    protocol: "http",
  });

  assert.equal(redirectUri, "https://hpa.example.com/oauth/salesforce/callback");
});
