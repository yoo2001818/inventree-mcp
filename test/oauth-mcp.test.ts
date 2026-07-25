import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { pkceS256 } from "../src/crypto.js";

describe("OAuth-protected InvenTree MCP", () => {
  const directory = mkdtempSync(join(tmpdir(), "inventree-mcp-test-"));
  const fakeInvenTree = express();
  fakeInvenTree.use((req, res, next) => {
    if (req.header("authorization") !== "Token correct-inventree-token") {
      res.status(401).json({ detail: "Invalid token" });
      return;
    }
    next();
  });
  fakeInvenTree.get("/api/user/me/", (_req, res) => res.json({ pk: 1, username: "workbench" }));
  fakeInvenTree.get("/api/part/", (req, res) =>
    res.json({
      count: 1,
      next: null,
      previous: null,
      results: [{ pk: 42, name: "10k resistor", IPN: "R-10K", query: req.query.search }],
    }),
  );
  const upstreamServer = createServer(fakeInvenTree);
  let upstreamUrl = "";
  let app: ReturnType<typeof createApp>["app"];

  const config: Config = {
    publicUrl: new URL("https://mcp.example.test"),
    resourceUrl: "https://mcp.example.test/mcp",
    inventreeUrl: "http://127.0.0.1",
    port: 3000,
    ownerPassword: "owner-secret-long-enough",
    encryptionKey: Buffer.alloc(32, 7),
    dataFile: join(directory, "state.json"),
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86_400,
    allowedRedirectOrigins: ["https://chatgpt.com"],
  };

  before(async () => {
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${address.port}`;
    config.inventreeUrl = upstreamUrl;
    app = createApp(config).app;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      upstreamServer.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes OAuth discovery and challenges unauthenticated MCP requests", async () => {
    const metadata = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    assert.equal(metadata.body.authorization_endpoint, "https://mcp.example.test/oauth/authorize");
    assert.deepEqual(metadata.body.code_challenge_methods_supported, ["S256"]);

    const response = await request(app).post("/mcp").send({}).expect(401);
    const challenge = response.header["www-authenticate"];
    assert.ok(challenge);
    assert.match(challenge, /oauth-protected-resource/);
  });

  it("completes DCR, authorization-code PKCE, token exchange, and an MCP tool call", async () => {
    const redirectUri = "https://chatgpt.com/connector/oauth/test-callback";
    const registration = await request(app)
      .post("/oauth/register")
      .send({ client_name: "ChatGPT test", redirect_uris: [redirectUri] })
      .expect(201);
    const clientId = registration.body.client_id as string;

    const verifier = "test-verifier-with-enough-entropy-012345678901234567890";
    const authorization = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state: "expected-state",
        scope: "inventree.read",
        resource: config.resourceUrl,
        code_challenge: pkceS256(verifier),
        code_challenge_method: "S256",
      })
      .expect(200);
    assert.doesNotMatch(authorization.text, /name="inventree_url"/);
    const requestId = /name="request_id" value="([^"]+)"/.exec(authorization.text)?.[1];
    assert.ok(requestId);

    const approval = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        request_id: requestId,
        inventree_url: "http://127.0.0.1:1",
        api_token: "correct-inventree-token",
        owner_password: config.ownerPassword,
      })
      .expect(303);
    const callbackLocation = approval.header.location;
    assert.ok(callbackLocation);
    const callback = new URL(callbackLocation);
    assert.equal(callback.searchParams.get("state"), "expected-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const token = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: config.resourceUrl,
      })
      .expect(200);
    assert.equal(token.body.token_type, "Bearer");
    assert.ok(token.body.access_token);
    assert.ok(token.body.refresh_token);

    const initialize = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(initialize.body.result.serverInfo.name, "inventree-mcp");

    const tools = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const searchTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "search_parts");
    assert.ok(searchTool);
    assert.deepEqual(searchTool._meta.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);
    assert.deepEqual(searchTool.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);

    const search = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_parts", arguments: { query: "10k" } },
    });
    assert.equal(search.body.result.structuredContent.data.results[0].pk, 42);
    assert.equal(search.body.result.structuredContent.data.results[0].query, "10k");

    const refusedWrite = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "inventree_write",
        arguments: {
          method: "PATCH",
          path: "/api/part/42/",
          body: { description: "changed" },
          confirmation: "I confirm this InvenTree mutation",
        },
      },
    });
    assert.equal(refusedWrite.body.result.isError, true);
    assert.match(
      refusedWrite.body.result._meta["mcp/www_authenticate"][0],
      /insufficient_scope/,
    );

    const refresh = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "refresh_token",
        refresh_token: token.body.refresh_token,
        client_id: clientId,
        resource: config.resourceUrl,
      })
      .expect(200);
    assert.notEqual(refresh.body.refresh_token, token.body.refresh_token);
  });

  async function mcpRequest(accessToken: string, body: object) {
    return request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", "application/json, text/event-stream")
      .send(body)
      .expect(200);
  }
});
