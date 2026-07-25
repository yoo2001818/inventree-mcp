import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  PUBLIC_URL: "https://mcp.example.test",
  INVENTREE_URL: "https://inventree.example.test/instance/",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OWNER_PASSWORD: "owner-secret-long-enough",
};

describe("configuration", () => {
  it("loads and normalizes the fixed InvenTree URL", () => {
    const config = loadConfig(validEnvironment);

    assert.equal(config.inventreeUrl, "https://inventree.example.test/instance");
    assert.equal(config.bindHost, "127.0.0.1");
    assert.deepEqual(config.allowedRedirectOrigins, [
      "https://chatgpt.com",
      "http://localhost:*",
      "http://127.0.0.1:*",
    ]);
    assert.deepEqual(config.allowedMcpOrigins, ["https://chatgpt.com"]);
    assert.equal(config.enableRawWrite, false);
  });

  it("loads explicit bind and MCP Origin settings", () => {
    const config = loadConfig({
      ...validEnvironment,
      BIND_HOST: "0.0.0.0",
      ALLOWED_MCP_ORIGINS: "https://chatgpt.com,http://localhost:6274",
    });

    assert.equal(config.bindHost, "0.0.0.0");
    assert.deepEqual(config.allowedMcpOrigins, ["https://chatgpt.com", "http://localhost:6274"]);
  });

  it("only enables the raw write escape hatch explicitly", () => {
    assert.equal(loadConfig({ ...validEnvironment, ENABLE_RAW_WRITE: "true" }).enableRawWrite, true);
    assert.equal(loadConfig({ ...validEnvironment, ENABLE_RAW_WRITE: "false" }).enableRawWrite, false);
  });

  it("requires the fixed InvenTree URL", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, INVENTREE_URL: undefined }),
      /INVENTREE_URL is required/,
    );
  });

  it("rejects unsupported InvenTree URL protocols", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, INVENTREE_URL: "ftp://inventree.example.test" }),
      /InvenTree URL must use http:\/\/ or https:\/\//,
    );
  });

  it("rejects MCP Origin entries containing paths", () => {
    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          ALLOWED_MCP_ORIGINS: "https://chatgpt.com/connector",
        }),
      /ALLOWED_MCP_ORIGINS entries must be exact HTTP\(S\) origins without paths/,
    );
  });

  it("rejects redirect wildcard patterns outside the supported loopback hosts", () => {
    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          ALLOWED_REDIRECT_ORIGINS: "https://example.com:*",
        }),
      /ALLOWED_REDIRECT_ORIGINS entries must be exact HTTP\(S\) origins without paths/,
    );
  });
});
