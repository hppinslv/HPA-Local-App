const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAuthStatus,
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

test("resolveRedirectUri keeps localhost host instead of switching to browser-facing referer", () => {
  const redirectUri = resolveRedirectUri({
    headers: {
      host: "localhost:4173",
      referer: "https://hpa.example.com/",
    },
    protocol: "http",
  });

  assert.equal(redirectUri, "http://localhost:4173/oauth/salesforce/callback");
});

test("getAuthStatus includes the resolved redirect uri for the current host", () => {
  const auth = getAuthStatus({
    headers: {
      host: "192.168.1.8:8000",
    },
    protocol: "http",
  });

  assert.equal(auth.resolvedRedirectUri, "http://192.168.1.8:8000/oauth/salesforce/callback");
});
