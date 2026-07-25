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
});
