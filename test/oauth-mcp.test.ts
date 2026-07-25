import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  fakeInvenTree.use(express.json());
  const category = {
    pk: 15,
    name: "Resistors",
    pathstring: "Electronics/Resistors",
    parent: 13,
    level: 1,
    structural: false,
    subcategories: 0,
    part_count: 1,
  };
  const location = {
    pk: 81,
    name: "Drawer A3",
    pathstring: "Living room/Blue cabinet/Drawer A3",
    parent: 22,
    level: 2,
    structural: false,
    sublocations: 0,
    items: 1,
  };
  const part = {
    pk: 42,
    name: "10k resistor",
    description: "1%, 0603",
    IPN: "R-10K",
    category: 15,
    category_name: "Resistors",
    category_detail: category,
    default_location: 81,
    default_location_detail: location,
    active: true,
    locked: false,
    trackable: false,
    units: "pcs",
    minimum_stock: 50,
    total_in_stock: 200,
    image: "/media/part_images/test.png",
    thumbnail: "/media/part_images/test-thumb.png",
  };
  const pngImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const stockItem = {
    pk: 91,
    part: 42,
    part_detail: part,
    quantity: 200,
    allocated: 0,
    location: 81,
    location_detail: location,
    status: 10,
    status_text: "OK",
    expired: false,
    batch: "",
    packaging: "",
    expiry_date: null,
    updated: "2026-01-01 00:00",
    in_stock: true,
  };
  const printedLabelBodies: unknown[] = [];
  const patchedLocationIds: string[] = [];
  const transferredStockBodies: unknown[] = [];
  const partImagePatches: Array<{ contentType: string; body: Buffer }> = [];
  fakeInvenTree.use((req, res, next) => {
    if (req.header("authorization") !== "Token correct-inventree-token") {
      res.status(401).json({ detail: "Invalid token" });
      return;
    }
    next();
  });
  fakeInvenTree.get("/api/user/me/", (_req, res) => res.json({ pk: 1, username: "workbench" }));
  fakeInvenTree.get("/api/part/category/tree/", (_req, res) =>
    res.json({ count: 1, next: null, previous: null, results: [category] }),
  );
  fakeInvenTree.get("/api/part/category/", (req, res) => {
    const results = req.query.cascade === "true"
      ? [category, { ...category, pk: 16, name: "SMD", pathstring: "Electronics/Resistors/SMD", parent: 15, level: 2 }]
      : [];
    res.json({ count: results.length, next: null, previous: null, results });
  });
  fakeInvenTree.get("/api/part/category/:id/", (req, res) => {
    if (req.params.id === "99999999") return res.status(404).json({ detail: "No category matches" });
    return res.json(req.params.id === "13" ? { ...category, pk: 13, name: "Electronics", pathstring: "Electronics", parent: null, level: 0, structural: true } : category);
  });
  fakeInvenTree.get("/api/stock/location/tree/", (_req, res) =>
    res.json({ count: 1, next: null, previous: null, results: [location] }),
  );
  fakeInvenTree.get("/api/stock/location/", (req, res) => {
    const results = req.query.parent === "1" && req.query.cascade === "true"
      ? Array.from({ length: 66 }, (_, index) => ({
          ...location,
          pk: 3000 + index,
          name: `Branch ${index + 1}`,
          pathstring: index < 6 ? `Root/Branch ${index + 1}` : `Root/Branch ${(index % 6) + 1}/Bin ${index + 1}`,
          parent: index < 6 ? 1 : 3000 + (index % 6),
          level: index < 6 ? 1 : 2,
        }))
      : req.query.cascade === "true"
      ? [
          { ...location, pk: 80, name: "Blue cabinet", pathstring: "Living room/Blue cabinet", parent: 22, level: 1 },
          location,
        ]
      : [];
    res.json({ count: results.length, next: null, previous: null, results });
  });
  fakeInvenTree.get("/api/stock/location/:id/", (req, res) => {
    if (req.params.id === "99999999") return res.status(404).json({ detail: "No StockLocation matches" });
    return res.json(req.params.id === "1" ? { ...location, pk: 1, name: "Root", pathstring: "Root", parent: null, level: 0, structural: true } : location);
  });
  fakeInvenTree.get("/api/part/:id/", (req, res) => {
    if (req.params.id === "99999999") return res.status(404).json({ detail: "No Part matches", barcode_hash: "must-not-leak" });
    if (req.params.id === "43") {
      return res.json({ ...part, pk: 43, name: "Part without image", image: null, thumbnail: "/static/img/blank_image.thumbnail.png" });
    }
    return res.json(part);
  });
  fakeInvenTree.get("/api/part/", (req, res) => {
    const results = req.query.search === "New capacitor" ? [] : [{ ...part, query: req.query.search }];
    res.json({ count: results.length, next: null, previous: null, results });
  });
  fakeInvenTree.get("/api/stock/track/", (_req, res) => res.json({
    count: 1,
    next: null,
    previous: null,
    results: [{
      pk: 301,
      date: "2026-01-02 12:00",
      item: 91,
      part: 42,
      label: "Location changed",
      deltas: {
        location: 81,
        location_detail: { ...location, location_type: { pk: 7, name: "Drawer" } },
      },
      notes: "Moved during cleanup",
    }],
  }));
  fakeInvenTree.get("/api/stock/:id/", (_req, res) => res.json(stockItem));
  fakeInvenTree.get("/api/stock/", (_req, res) =>
    res.json({ count: 1, next: null, previous: null, results: [stockItem] }),
  );
  fakeInvenTree.post("/api/stock/add/", (req, res) => {
    const adjustment = req.body.items?.[0];
    stockItem.quantity += Number(adjustment?.quantity ?? 0);
    part.total_in_stock = stockItem.quantity;
    res.status(201).json(req.body);
  });
  fakeInvenTree.post("/api/part/", (req, res) => res.status(201).json({ ...req.body, pk: 1001 }));
  fakeInvenTree.post("/api/stock/", (req, res) => res.status(201).json([{ ...req.body, pk: 1002 }]));
  fakeInvenTree.patch("/api/part/:id/", express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
    partImagePatches.push({ contentType: req.header("content-type") ?? "", body: Buffer.from(req.body) });
    res.json({ ...part, pk: Number(req.params.id) });
  });
  fakeInvenTree.post("/api/stock/location/", (req, res) => res.status(201).json({ ...req.body, pk: 2001 }));
  fakeInvenTree.patch("/api/stock/location/:id/", (req, res) => {
    patchedLocationIds.push(req.params.id);
    res.json({ ...req.body, pk: Number(req.params.id) });
  });
  fakeInvenTree.post("/api/stock/transfer/", (req, res) => {
    transferredStockBodies.push(req.body);
    res.status(201).json(req.body);
  });
  fakeInvenTree.get("/api/label/template/", (_req, res) => res.json({
    count: 1,
    next: null,
    previous: null,
    results: [{ pk: 20, name: "Stock 30x15", width: 30, height: 15, enabled: true }],
  }));
  fakeInvenTree.post("/api/label/print/", (req, res) => {
    printedLabelBodies.push(req.body);
    res.status(201).json(req.body);
  });
  fakeInvenTree.get(["/media/part_images/test.png", "/media/part_images/test-thumb.png"], (_req, res) => {
    res.type("image/png").send(pngImage);
  });
  const upstreamServer = createServer(fakeInvenTree);
  let upstreamUrl = "";
  let app: ReturnType<typeof createApp>["app"];
  const requestLogs: string[] = [];

  const config: Config = {
    publicUrl: new URL("https://mcp.example.test"),
    resourceUrl: "https://mcp.example.test/mcp",
    inventreeUrl: "http://127.0.0.1",
    bindHost: "127.0.0.1",
    port: 3000,
    ownerPassword: "owner-secret-long-enough",
    encryptionKey: Buffer.alloc(32, 7),
    dataFile: join(directory, "state.json"),
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86_400,
    allowedRedirectOrigins: [
      "https://chatgpt.com",
      "http://localhost:*",
      "http://127.0.0.1:*",
    ],
    allowedMcpOrigins: ["https://chatgpt.com"],
    enableRawWrite: false,
    imageUploadMaxBytes: 8 * 1024 * 1024,
    imageMaxPixels: 40_000_000,
  };

  before(async () => {
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${address.port}`;
    config.inventreeUrl = upstreamUrl;
    app = createApp(config, undefined, {
      requestLogStream: { write: (message) => requestLogs.push(message) },
    }).app;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      upstreamServer.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes OAuth discovery and challenges unauthenticated MCP requests", async () => {
    const metadata = await request(app)
      .get("/.well-known/oauth-authorization-server")
      .set("Origin", "https://chatgpt.com")
      .expect(200);
    assert.equal(metadata.body.authorization_endpoint, "https://mcp.example.test/oauth/authorize");
    assert.deepEqual(metadata.body.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.header["access-control-allow-origin"], "https://chatgpt.com");

    const response = await request(app)
      .post("/mcp")
      .set("Origin", "https://chatgpt.com")
      .send({})
      .expect(401);
    const challenge = response.header["www-authenticate"];
    assert.ok(challenge);
    assert.match(challenge, /oauth-protected-resource/);
    assert.equal(response.header["access-control-allow-origin"], "https://chatgpt.com");
    const exposedHeaders = response.header["access-control-expose-headers"];
    assert.ok(exposedHeaders);
    assert.match(exposedHeaders, /WWW-Authenticate/i);

    const invalidOrigin = await request(app)
      .get("/mcp")
      .set("Origin", "https://attacker.example")
      .set("Accept", "text/event-stream")
      .expect(403);
    assert.equal(invalidOrigin.body.error.message, "Invalid Origin header: https://attacker.example");
    assert.equal(invalidOrigin.header["access-control-allow-origin"], undefined);
  });

  it("supports Inspector CORS preflights for MCP and OAuth endpoints", async () => {
    const cases = [
      ["/.well-known/oauth-protected-resource", "GET", ""],
      ["/.well-known/oauth-authorization-server", "GET", ""],
      ["/.well-known/openid-configuration", "GET", ""],
      ["/oauth/register", "POST", "content-type"],
      ["/oauth/token", "POST", "content-type"],
      ["/oauth/revoke", "POST", "content-type"],
      ["/part-images/upload", "PUT", "content-type,x-file-name"],
      ["/mcp", "POST", "authorization,content-type,mcp-protocol-version"],
    ] as const;

    for (const [path, method, headers] of cases) {
      const preflight = request(app)
        .options(path)
        .set("Origin", "https://chatgpt.com")
        .set("Access-Control-Request-Method", method);
      if (headers) preflight.set("Access-Control-Request-Headers", headers);

      const response = await preflight.expect(204);
      assert.equal(response.header["access-control-allow-origin"], "https://chatgpt.com");
      const allowedMethods = response.header["access-control-allow-methods"];
      assert.ok(allowedMethods);
      assert.match(allowedMethods, new RegExp(method));
      assert.match(response.header.vary ?? "", /Origin/);
    }
  });

  it("allows dynamic loopback callback ports but rejects other HTTP hosts", async () => {
    for (const redirectUri of [
      "http://localhost:49152/oauth/callback",
      "http://127.0.0.1:54321/oauth/callback",
    ]) {
      const registration = await request(app)
        .post("/oauth/register")
        .send({ client_name: "Local Codex", redirect_uris: [redirectUri] })
        .expect(201);
      assert.deepEqual(registration.body.redirect_uris, [redirectUri]);
    }

    const rejected = await request(app)
      .post("/oauth/register")
      .send({
        client_name: "Non-loopback client",
        redirect_uris: ["http://192.168.1.10:49152/oauth/callback"],
      })
      .expect(400);
    assert.equal(rejected.body.error, "invalid_redirect_uri");
  });

  it("logs request metadata without query parameters", async () => {
    await request(app).get("/healthz?api_token=must-not-be-logged").expect(200);

    const log = requestLogs.find((message) => message.includes("GET /healthz 200"));
    assert.ok(log);
    assert.match(log, /^\d{4}-\d{2}-\d{2}T.* GET \/healthz 200 \d+b \d+\.\d{3}ms\n$/);
    assert.doesNotMatch(log, /api_token|must-not-be-logged/);
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
      .set("Origin", "https://chatgpt.com")
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
    assert.equal(token.header["access-control-allow-origin"], "https://chatgpt.com");

    const getResponse = await request(app)
      .get("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Origin", "https://chatgpt.com")
      .set("Accept", "text/event-stream")
      .expect(405);
    assert.equal(getResponse.header.allow, "POST");
    assert.equal(getResponse.body.error.message, "Method not allowed.");

    const initialize = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
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
    const toolNames = tools.body.result.tools.map((tool: { name: string }) => tool.name);
    for (const expected of [
      "browse_part_categories",
      "browse_stock_locations",
      "find_parts",
      "get_part_inventory",
      "get_part_image",
      "inventory_at_location",
      "check_stock_levels",
      "get_stock_history",
      "scan_barcode",
      "create_part_with_stock",
      "update_part",
      "prepare_part_image_upload",
      "get_part_image_upload_status",
      "set_part_image",
      "receive_stock",
      "consume_stock",
      "move_stock",
      "count_stock",
      "set_stock_status",
      "create_part_category",
      "update_part_category",
      "create_stock_location",
      "update_stock_location",
      "print_labels",
      "review_inventory_plan",
      "open_inventory_plan_review",
      "remove_inventory_plan_step",
      "discard_inventory_plan",
      "commit_inventory_plan",
      "inventree_get",
    ]) {
      assert.ok(toolNames.includes(expected), `missing tool ${expected}`);
    }
    assert.ok(!toolNames.includes("inventree_write"));
    assert.ok(!toolNames.includes("get_part_bom"));
    const searchTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "find_parts");
    assert.ok(searchTool);
    assert.deepEqual(searchTool._meta.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);
    assert.deepEqual(searchTool.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);
    const stageTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "receive_stock");
    const commitTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "commit_inventory_plan");
    const extendedReviewTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "open_inventory_plan_review");
    assert.equal(stageTool.annotations.destructiveHint, false);
    assert.equal(commitTool.annotations.destructiveHint, true);
    assert.equal(extendedReviewTool.annotations.destructiveHint, false);
    assert.equal(extendedReviewTool._meta.ui.resourceUri, "ui://inventree/inventory-plan-review.html");
    assert.equal(extendedReviewTool._meta["ui/resourceUri"], "ui://inventree/inventory-plan-review.html");

    const resources = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
      params: {},
    });
    const reviewResource = resources.body.result.resources.find(
      (resource: { uri: string }) => resource.uri === "ui://inventree/inventory-plan-review.html",
    );
    assert.ok(reviewResource);
    assert.equal(reviewResource.mimeType, "text/html;profile=mcp-app");

    const appResource = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "ui://inventree/inventory-plan-review.html" },
    });
    assert.equal(appResource.body.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(appResource.body.result.contents[0].text, /Inventory plan review/);
    assert.match(appResource.body.result.contents[0].text, /Commit inventory plan/);
    const createTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "create_part_with_stock");
    const categoryIdSchema = createTool.inputSchema.properties.part.properties.category_id;
    assert.deepEqual(categoryIdSchema.anyOf.map((entry: { type: string }) => entry.type), ["integer", "string"]);
    const initialNotesSchema = createTool.inputSchema.properties.initial_stock.anyOf
      .find((entry: { type?: string }) => entry.type === "object").properties.notes;
    const initialNoteTypes = initialNotesSchema.anyOf?.map((entry: { type: string }) => entry.type) ?? initialNotesSchema.type;
    assert.deepEqual(initialNoteTypes, ["string", "null"]);
    const assertPreciseFields = (schema: unknown, path = "inputSchema") => {
      if (!schema || typeof schema !== "object") return;
      const object = schema as Record<string, unknown>;
      const properties = object.properties as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(properties ?? {})) {
        if (/(_id|_ids|notes)$/.test(name)) {
          assert.ok(value && typeof value === "object" && Object.keys(value as object).length > 0, `${path}.${name} was published as unknown`);
        }
        assertPreciseFields(value, `${path}.${name}`);
      }
      if (Array.isArray(object.anyOf)) object.anyOf.forEach((value, index) => assertPreciseFields(value, `${path}.anyOf[${index}]`));
      if (object.items) assertPreciseFields(object.items, `${path}.items`);
    };
    tools.body.result.tools.forEach((tool: { name: string; inputSchema: unknown }) => assertPreciseFields(tool.inputSchema, tool.name));

    const search = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "find_parts", arguments: { query: "10k" } },
    });
    assert.equal(search.body.result.structuredContent.data.results[0].id, 42);
    assert.equal(search.body.result.structuredContent.data.results[0].placements[0].stockItemId, 91);
    assert.equal(search.body.result.structuredContent.data.results[0].active, undefined);
    assert.equal(search.body.result.structuredContent.data.results[0].locked, undefined);
    assert.equal(search.body.result.structuredContent.data.results[0].trackable, undefined);
    assert.equal(search.body.result.structuredContent.data.results[0].placements[0].allocated, undefined);
    assert.equal(search.body.result.structuredContent.data.results[0].placements[0].expired, undefined);
    assert.equal(search.body.result.structuredContent.data.results[0].placements[0].status, undefined);
    assert.match(search.body.result.content[0].text, /Drawer A3 \(#81\)/);
    const toolLog = requestLogs.find((message) => message.includes("MCP tools/call") && message.includes('"name":"find_parts"'));
    assert.ok(toolLog);
    assert.match(toolLog, /"arguments":\{"query":"10k"/);
    assert.equal(requestLogs.some((message) => message.includes("POST /mcp")), false);

    const refusedWrite = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "receive_stock",
        arguments: {
          part_id: 42,
          quantity: 1,
          location_id: 81,
          operation_id: "refused-write",
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

  it("stages, revalidates, and commits a shared stock plan idempotently", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const preview = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "receive_stock",
        arguments: {
          part_id: 42,
          quantity: 5,
          location_id: 81,
          merge: "compatible",
          notes: "Integration test",
          operation_id: "receive-five",
        },
      },
    });
    assert.equal(preview.body.result.structuredContent.data.status, "staged");
    assert.match(preview.body.result.content[0].text, /200 pcs -> 205 pcs/);
    const planId = preview.body.result.structuredContent.data.plan_id as string;
    const planVersion = preview.body.result.structuredContent.data.plan_version as number;

    const duplicate = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "receive_stock",
        arguments: {
          plan_id: planId,
          expected_version: 999,
          operation_id: "receive-five",
          part_id: 42,
          quantity: 5,
          location_id: 81,
          merge: "compatible",
          notes: "Integration test",
        },
      },
    });
    assert.equal(duplicate.body.result.structuredContent.data.duplicate_operation, true);
    assert.equal(duplicate.body.result.structuredContent.data.plan_version, planVersion);

    const staleAppend = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "receive_stock",
        arguments: {
          plan_id: planId,
          expected_version: 999,
          operation_id: "different-stale-operation",
          part_id: 42,
          quantity: 1,
          location_id: 81,
          merge: "compatible",
        },
      },
    });
    assert.deepEqual(staleAppend.body.result.structuredContent.data, {
      status: "conflict",
      conflict_type: "plan_version",
      expected_version: 999,
      current_version: planVersion,
    });

    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "commit_inventory_plan", arguments: { plan_id: planId, expected_version: planVersion } },
    });
    assert.equal(commit.body.result.structuredContent.data.status, "committed");
    assert.equal(stockItem.quantity, 205);

    const replay = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "commit_inventory_plan", arguments: { plan_id: planId, expected_version: planVersion } },
    });
    assert.equal(replay.body.result.structuredContent.data.status, "committed");
    assert.equal(stockItem.quantity, 205);

    const stalePreview = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "receive_stock",
        arguments: { part_id: 42, quantity: 1, location_id: 81, merge: "compatible", operation_id: "stale-receive" },
      },
    });
    const stalePlanId = stalePreview.body.result.structuredContent.data.plan_id as string;
    const stalePlanVersion = stalePreview.body.result.structuredContent.data.plan_version as number;
    stockItem.quantity = 206;
    part.total_in_stock = 206;
    const staleCommit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "commit_inventory_plan", arguments: { plan_id: stalePlanId, expected_version: stalePlanVersion } },
    });
    assert.equal(staleCommit.body.result.isError, true);
    assert.equal(staleCommit.body.result.structuredContent.data.status, "conflict");
    assert.match(staleCommit.body.result.content[0].text, /plan is stale/i);
    assert.equal(stockItem.quantity, 206);
  });

  it("resolves a future stock reference when a later plan step prints its label", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");
    const create = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "create_part_with_stock",
        arguments: {
          operation_id: "create-new-capacitor",
          part: { name: "New capacitor", category_id: 15, units: "pcs" },
          initial_stock: { quantity: 10, location_id: 81, packaging: "cut tape" },
        },
      },
    });
    assert.equal(create.body.result.structuredContent.data.status, "staged");
    const planId = create.body.result.structuredContent.data.plan_id as string;
    const stockRef = create.body.result.structuredContent.data.outputs.find(
      (output: { name: string }) => output.name === "stock_item",
    ).ref as string;

    const print = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "print_labels",
        arguments: {
          plan_id: planId,
          expected_version: 1,
          operation_id: "print-new-capacitor-stock",
          entity_type: "stock_item",
          entities: [{ ref: stockRef }],
          template: "30x15mm",
        },
      },
    });
    assert.equal(print.body.result.structuredContent.data.plan_version, 2);
    assert.match(print.body.result.content[0].text, /New capacitor.*Drawer A3/);
    assert.doesNotMatch(print.body.result.content[0].text, /Append related steps/);

    const review = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "review_inventory_plan", arguments: { plan_id: planId } },
    });
    assert.equal(review.body.result.structuredContent.data.steps.length, 2);

    const extendedReview = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 221,
      method: "tools/call",
      params: { name: "open_inventory_plan_review", arguments: { plan_id: planId } },
    });
    assert.equal(extendedReview.body.result.structuredContent.data.plan_version, 2);
    assert.equal(extendedReview.body.result.structuredContent.data.operation_count, 3);
    assert.deepEqual(extendedReview.body.result.structuredContent.data.commit, {
      tool: "commit_inventory_plan",
      arguments: { plan_id: planId, expected_version: 2 },
    });
    assert.match(extendedReview.body.result.content[0].text, /interactive extended-confirmation view/i);

    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "commit_inventory_plan", arguments: { plan_id: planId, expected_version: 2 } },
    });
    assert.equal(commit.body.result.structuredContent.data.resolved_refs[stockRef], 1002);
    assert.deepEqual(printedLabelBodies.at(-1), { template: 20, plugin: "zebra", items: [1002] });
  });

  it("uses immutable step IDs and protects dependent future references during plan edits", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");
    const create = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "create_part_with_stock",
        arguments: {
          operation_id: "create-removal-test",
          part: { name: "New capacitor", category_id: 15 },
          initial_stock: { quantity: 1, location_id: 81 },
        },
      },
    });
    const planId = create.body.result.structuredContent.data.plan_id as string;
    const producerId = create.body.result.structuredContent.data.step_id as string;
    const stockRef = create.body.result.structuredContent.data.outputs.find(
      (output: { name: string }) => output.name === "stock_item",
    ).ref as string;
    const print = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "print_labels",
        arguments: {
          plan_id: planId,
          expected_version: 1,
          operation_id: "print-removal-test",
          entity_type: "stock_item",
          entities: [{ ref: stockRef }],
          template: "30x15mm",
        },
      },
    });
    const dependentId = print.body.result.structuredContent.data.step_id as string;

    const refused = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "remove_inventory_plan_step",
        arguments: { plan_id: planId, expected_version: 2, step_id: producerId },
      },
    });
    assert.equal(refused.body.result.isError, true);
    assert.equal(refused.body.result.structuredContent.data.status, "conflict");
    assert.deepEqual(refused.body.result.structuredContent.data.dependent_step_ids, [dependentId]);
    assert.match(refused.body.result.content[0].text, new RegExp(dependentId));

    const cascaded = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "remove_inventory_plan_step",
        arguments: { plan_id: planId, expected_version: 2, step_id: producerId, cascade: true },
      },
    });
    assert.deepEqual(cascaded.body.result.structuredContent.data.remaining_step_ids, []);
    assert.equal(cascaded.body.result.structuredContent.data.plan_version, 3);
  });

  it("accepts numeric ID strings, resolves refs in request paths, and enforces counted tree depth", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const categories = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "browse_part_categories",
        arguments: { root_id: 13, include_counts: true, max_level: 1 },
      },
    });
    assert.deepEqual(categories.body.result.structuredContent.data.nodes.map((node: { id: number }) => node.id), [15]);
    assert.match(categories.body.result.content[0].text, /Depth limited/);

    const locations = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "browse_stock_locations",
        arguments: { root_id: 22, include_item_counts: true, max_level: 1 },
      },
    });
    assert.deepEqual(locations.body.result.structuredContent.data.nodes.map((node: { id: number }) => node.id), [80]);
    assert.match(locations.body.result.content[0].text, /Depth limited/);

    const history = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 46,
      method: "tools/call",
      params: { name: "get_stock_history", arguments: { stock_item_id: 91 } },
    });
    const historyItem = history.body.result.structuredContent.data.results[0];
    assert.equal(historyItem.deltas, undefined);
    assert.deepEqual(historyItem.delta, {
      kind: "location",
      text: "moved to Living room > Blue cabinet > Drawer A3 (#81)",
      location: { id: 81, name: "Drawer A3", path: "Living room > Blue cabinet > Drawer A3" },
    });

    const create = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "create_stock_location",
        arguments: {
          operation_id: "create-planned-bin",
          name: "Planned bin",
          parent_id: "81",
        },
      },
    });
    assert.equal(create.body.result.structuredContent.data.status, "staged");
    const planId = create.body.result.structuredContent.data.plan_id as string;
    const locationRef = create.body.result.structuredContent.data.outputs[0].ref as string;

    const update = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: {
        name: "update_stock_location",
        arguments: {
          plan_id: planId,
          expected_version: 1,
          operation_id: "describe-planned-bin",
          location_id: locationRef,
          changes: { description: "Created and updated in one plan" },
        },
      },
    });
    assert.equal(update.body.result.structuredContent.data.plan_version, 2);

    const move = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: {
        name: "move_stock",
        arguments: {
          plan_id: planId,
          expected_version: 2,
          operation_id: "move-to-planned-bin",
          destination_location_id: locationRef,
          stock_item_id: "91",
        },
      },
    });
    assert.equal(move.body.result.structuredContent.data.plan_version, 3);

    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 45,
      method: "tools/call",
      params: {
        name: "commit_inventory_plan",
        arguments: { plan_id: planId, expected_version: 3 },
      },
    });
    assert.equal(commit.body.result.structuredContent.data.resolved_refs[locationRef], 2001);
    assert.equal(patchedLocationIds.at(-1), "2001");
    assert.deepEqual(transferredStockBodies.at(-1), {
      items: [{ pk: 91, quantity: String(stockItem.quantity) }],
      location: 2001,
    });
  });

  it("returns structured domain errors and bounds rooted tree expansions", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const missingPart = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: { name: "get_part_inventory", arguments: { part_id: 99999999 } },
    });
    assert.deepEqual(missingPart.body.result.structuredContent.data, {
      status: "not_found",
      entity_type: "part",
      supplied_id: 99999999,
      suggested_tool: "find_parts",
    });
    assert.doesNotMatch(JSON.stringify(missingPart.body.result), /barcode_hash|No Part matches/);

    const missingLocation = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: { name: "inventory_at_location", arguments: { location_id: 99999999 } },
    });
    assert.equal(missingLocation.body.result.structuredContent.data.status, "not_found");
    assert.equal(missingLocation.body.result.structuredContent.data.suggested_tool, "browse_stock_locations");

    const barcode = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: { name: "scan_barcode", arguments: { barcode: "unknown-private-barcode" } },
    });
    assert.equal(barcode.body.result.structuredContent.data.status, "not_found");
    assert.doesNotMatch(JSON.stringify(barcode.body.result), /unknown-private-barcode|barcode_hash/);

    const duplicate = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: {
        name: "create_part_with_stock",
        arguments: {
          operation_id: "duplicate-part-probe",
          part: { name: "10k resistor", category_id: 15 },
        },
      },
    });
    assert.equal(duplicate.body.result.structuredContent.data.conflict_type, "possible_duplicates");
    assert.deepEqual(duplicate.body.result.structuredContent.data.candidates, [{ id: 42, name: "10k resistor" }]);

    const tree = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 64,
      method: "tools/call",
      params: {
        name: "browse_stock_locations",
        arguments: { root_id: 1, include_item_counts: true, max_level: 2 },
      },
    });
    assert.equal(tree.body.result.structuredContent.data.truncated, true);
    assert.equal(tree.body.result.structuredContent.data.nodes.length, 6);
    assert.deepEqual(tree.body.result.structuredContent.data.expandableRootIds, [3000, 3001, 3002, 3003, 3004, 3005]);
    assert.deepEqual(tree.body.result.structuredContent.data.root, { id: 1, name: "Root", path: "Root" });
    assert.match(tree.body.result.content[0].text, /^## Selected location: Root \(#1\)/);
  });

  it("downloads part images and commits temporary uploads as multipart data", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const noImage = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 69,
      method: "tools/call",
      params: { name: "get_part_image", arguments: { part_id: 43 } },
    });
    assert.equal(noImage.body.result.isError, true);
    assert.deepEqual(noImage.body.result.structuredContent.data, {
      status: "not_found",
      entity_type: "part_image",
      supplied_id: 43,
      suggested_tool: "set_part_image",
    });

    const image = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 70,
      method: "tools/call",
      params: { name: "get_part_image", arguments: { part_id: 42 } },
    });
    assert.equal(image.body.result.structuredContent.data.status, "ready");
    assert.equal(image.body.result.structuredContent.data.delivery, "inline");
    assert.equal(image.body.result.structuredContent.data.download_url, undefined);
    assert.equal(image.body.result.structuredContent.data.mime_type, "image/png");
    assert.equal(image.body.result.structuredContent.data.width, 1);
    assert.equal(image.body.result.content[1].type, "image");
    assert.equal(image.body.result.content[1].data, pngImage.toString("base64"));

    const previewImage = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: { name: "get_part_image", arguments: { part_id: 42, variant: "preview" } },
    });
    assert.equal(previewImage.body.result.structuredContent.data.delivery, "inline");
    assert.equal(previewImage.body.result.content[1].type, "image");

    const original = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 72,
      method: "tools/call",
      params: { name: "get_part_image", arguments: { part_id: 42, variant: "original" } },
    });
    assert.equal(original.body.result.structuredContent.data.delivery, "download_url");
    assert.equal(original.body.result.content[1].type, "resource_link");
    const downloadUrl = new URL(original.body.result.structuredContent.data.download_url);
    assert.equal(downloadUrl.origin, config.publicUrl.origin);
    const download = await request(app)
      .get(`${downloadUrl.pathname}${downloadUrl.search}`)
      .expect("Content-Type", /image\/png/)
      .expect(200);
    assert.deepEqual(download.body, pngImage);
    const contentDisposition = download.header["content-disposition"];
    assert.ok(contentDisposition);
    assert.match(contentDisposition, /^inline; filename=/);

    const prepared = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 73,
      method: "tools/call",
      params: { name: "prepare_part_image_upload", arguments: { filename: "replacement.png" } },
    });
    assert.equal(prepared.body.result.structuredContent.data.status, "awaiting_upload");
    assert.equal(prepared.body.result.structuredContent.data.method, "PUT");
    const uploadRef = prepared.body.result.structuredContent.data.upload_ref as string;
    const uploadUrl = new URL(prepared.body.result.structuredContent.data.upload_url);
    assert.equal(uploadUrl.origin, config.publicUrl.origin);
    const uploadPath = `${uploadUrl.pathname}${uploadUrl.search}`;

    const page = await request(app).get(uploadPath).expect(200);
    assert.match(page.text, /Upload a part image/);
    const contentSecurityPolicy = page.header["content-security-policy"];
    assert.ok(contentSecurityPolicy);
    assert.match(contentSecurityPolicy, /connect-src 'self'/);

    const invalidUpload = await request(app)
      .put(uploadPath)
      .set("Content-Type", "image/png")
      .send(Buffer.from("not-an-image"))
      .expect(400);
    assert.equal(invalidUpload.body.data.status, "invalid_image");

    const upload = await request(app)
      .put(uploadPath)
      .set("Content-Type", "image/png")
      .set("X-File-Name", "replacement.png")
      .send(pngImage)
      .expect(201);
    assert.equal(upload.body.data.status, "ready");
    assert.equal(upload.body.data.width, 1);
    assert.equal(upload.body.data.upload_ref, uploadRef);

    const status = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 74,
      method: "tools/call",
      params: { name: "get_part_image_upload_status", arguments: { upload_ref: uploadRef } },
    });
    assert.equal(status.body.result.structuredContent.data.status, "ready");
    assert.equal(status.body.result.structuredContent.data.filename, "replacement.png");
    assert.doesNotMatch(requestLogs.join(""), new RegExp(uploadUrl.searchParams.get("token")!));
    assert.doesNotMatch(requestLogs.join(""), new RegExp(downloadUrl.searchParams.get("token")!));

    const staged = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 75,
      method: "tools/call",
      params: {
        name: "set_part_image",
        arguments: { operation_id: "replace-part-image", part_id: "42", upload_ref: uploadRef },
      },
    });
    assert.equal(staged.body.result.structuredContent.data.status, "staged");
    assert.match(staged.body.result.content[0].text, /replacement\.png/);
    assert.doesNotMatch(readFileSync(config.dataFile, "utf8"), new RegExp(pngImage.toString("base64").slice(0, 24)));

    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 76,
      method: "tools/call",
      params: {
        name: "commit_inventory_plan",
        arguments: {
          plan_id: staged.body.result.structuredContent.data.plan_id,
          expected_version: 1,
        },
      },
    });
    assert.equal(commit.body.result.structuredContent.data.status, "committed");
    const multipart = partImagePatches.at(-1)!;
    assert.match(multipart.contentType, /^multipart\/form-data; boundary=/);
    assert.match(multipart.body.toString("latin1"), /name="image"; filename="replacement\.png"/);
    assert.notEqual(multipart.body.indexOf(pngImage), -1);
  });

  it("does not create a plan for an already-current stock count", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");
    const counted = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "count_stock",
        arguments: {
          operation_id: "no-op-count",
          counts: [{ stock_item_id: 91, observed_quantity: stockItem.quantity }],
        },
      },
    });
    assert.equal(counted.body.result.structuredContent.data.status, "already_current");
    assert.equal(counted.body.result.structuredContent.data.plan_id, undefined);
  });

  async function authorizeToken(scope: string): Promise<string> {
    const redirectUri = "https://chatgpt.com/connector/oauth/workflow-test";
    const registration = await request(app)
      .post("/oauth/register")
      .send({ client_name: "Workflow test", redirect_uris: [redirectUri] })
      .expect(201);
    const clientId = registration.body.client_id as string;
    const verifier = "workflow-test-verifier-with-enough-entropy-01234567890";
    const authorization = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        resource: config.resourceUrl,
        code_challenge: pkceS256(verifier),
        code_challenge_method: "S256",
      })
      .expect(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(authorization.text)?.[1];
    assert.ok(requestId);
    const approval = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        request_id: requestId,
        api_token: "correct-inventree-token",
        owner_password: config.ownerPassword,
      })
      .expect(303);
    const callbackLocation = approval.header.location;
    assert.ok(callbackLocation);
    const code = new URL(callbackLocation).searchParams.get("code");
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
    return token.body.access_token as string;
  }

  async function mcpRequest(accessToken: string, body: object) {
    return request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-11-25")
      .send(body)
      .expect(200);
  }
});
