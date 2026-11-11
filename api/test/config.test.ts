import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const prodEnv = {
  NODE_ENV: "production",
  TOKEN_SIGNING_KEY: "real-key",
  ES_URL: "https://es:9200",
  ES_USERNAME: "companion_svc",
  ES_PASSWORD: "pw",
};

describe("loadConfig in production", () => {
  it("refuses to start without TOKEN_SIGNING_KEY", () => {
    const { TOKEN_SIGNING_KEY: _omit, ...env } = prodEnv;
    expect(() => loadConfig(env)).toThrow(/TOKEN_SIGNING_KEY/);
    expect(() => loadConfig({ ...env, TOKEN_SIGNING_KEY: "" })).toThrow(/TOKEN_SIGNING_KEY/);
  });

  it("refuses to start without Elasticsearch credentials", () => {
    expect(() => loadConfig({ ...prodEnv, ES_PASSWORD: "" })).toThrow(/ES_PASSWORD/);
    expect(() => loadConfig({ ...prodEnv, ES_USERNAME: undefined })).toThrow(/ES_USERNAME/);
    expect(() => loadConfig({ ...prodEnv, ES_URL: undefined })).toThrow(/ES_URL/);
  });

  it("starts with everything set", () => {
    expect(loadConfig(prodEnv).tokenSigningKey).toBe("real-key");
  });
});

describe("loadConfig outside production", () => {
  it("keeps the dev signing key fallback", () => {
    expect(loadConfig({}).tokenSigningKey).toBe("dev-only-insecure-key");
    expect(loadConfig({ NODE_ENV: "test" }).tokenSigningKey).toBe("dev-only-insecure-key");
  });

  it("requires an identity HMAC key when a complete OAuth provider is configured", () => {
    const oauth = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_OAUTH_REDIRECT_URI: "https://example.test/callback" };
    expect(() => loadConfig({ ...oauth })).toThrow(/IDENTITY_HASH_KEY \(>=32 chars\)/);
    expect(() => loadConfig({ ...oauth, IDENTITY_HASH_KEY: "short" })).toThrow(/IDENTITY_HASH_KEY \(>=32 chars\)/);
    expect(loadConfig({ ...oauth, IDENTITY_HASH_KEY: "a".repeat(32) }).identityHashKey).toBe("a".repeat(32));
  });
});
