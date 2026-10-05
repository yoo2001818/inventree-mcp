import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { parse } from "yaml";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { pkceS256 } from "../src/crypto.js";
import { catalogPaths } from "../src/catalogDomain.js";

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
  const partSearchQueries: string[] = [];
  const partParameterQueries: Record<string, unknown>[] = [];
  const createdParts = new Map<number, Record<string, unknown>>();
  const createdStockBodies: Record<string, unknown>[] = [];
  const catalogWrites: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const stockMetadataPatches: Record<string, unknown>[] = [];
  const catalog = new Map<string, Map<number, Record<string, unknown>>>([
    [catalogPaths.company, new Map([
      [501, { pk: 501, name: "LCSC", is_supplier: true, is_manufacturer: false, active: true }],
      [502, { pk: 502, name: "Example Manufacturer", is_supplier: false, is_manufacturer: true, active: true }],
      [503, { pk: 503, name: "Inactive", is_supplier: true, is_manufacturer: false, active: false }],
    ])],
    [catalogPaths.manufacturer_part, new Map([
      [601, { pk: 601, part: 42, manufacturer: 502, MPN: "0603B103K500NT" }],
      [602, { pk: 602, part: 43, manufacturer: 502, MPN: "Other MPN" }],
    ])],
    [catalogPaths.supplier_part, new Map([
      [701, { pk: 701, part: 42, supplier: 501, SKU: "C57112", manufacturer_part: 601, active: true, pack_quantity: "1" }],
    ])],
    [catalogPaths.parameter_template, new Map([
      [801, { pk: 801, name: "Capacitance", units: "F", enabled: true, model_type: "part.part" }],
      [802, { pk: 802, name: "Package", units: "", enabled: true, model_type: null }],
      [803, { pk: 803, name: "Dielectric", choices: "X7R,C0G", enabled: true, model_type: "part" }],
      [804, { pk: 804, name: "Build parameter", enabled: true, model_type: "build" }],
      [805, { pk: 805, name: "Disabled", enabled: false, model_type: "part" }],
    ])],
    ["/api/parameter/", new Map([
      [901, { pk: 901, model_type: "part", model_id: 42, template: 801, data: "10nF", note: "keep this note" }],
    ])],
  ]);
  let catalogPk = 3000;
  const partDetail = (value: unknown) => createdParts.get(Number(value)) ?? (Number(value) === 43 ? { ...part, pk: 43 } : part);
  function enrichedCatalog(path: string, item: Record<string, unknown>) {
    const data = { ...item };
    if (item.part) data.part_detail = partDetail(item.part);
    for (const key of ["supplier", "manufacturer"]) if (item[key]) data[`${key}_detail`] = catalog.get(catalogPaths.company)?.get(Number(item[key]));
    if (item.manufacturer_part) {
      data.manufacturer_part_detail = catalog.get(catalogPaths.manufacturer_part)?.get(Number(item.manufacturer_part));
      const manufacturerPart = data.manufacturer_part_detail as Record<string, unknown>;
      data.MPN = manufacturerPart.MPN;
      data.manufacturer_detail = catalog.get(catalogPaths.company)?.get(Number(manufacturerPart.manufacturer));
    }
    if (path === "/api/parameter/") data.template_detail = catalog.get(catalogPaths.parameter_template)?.get(Number(item.template));
    return data;
  }
  fakeInvenTree.use((req, res, next) => {
    if (req.header("authorization") !== "Token correct-inventree-token") {
      res.status(401).json({ detail: "Invalid token" });
      return;
    }
    next();
  });
  fakeInvenTree.get("/api/user/me/", (_req, res) => res.json({ pk: 1, username: "workbench" }));
  fakeInvenTree.get("/api/units/all/", (_req, res) => res.json({
    default_system: "mks",
    available_units: Object.fromEntries(
      ["pcs", "piece", "each", "dozen", "hundred", "thousand", "m", "kg", "L"].map((name) => [name, { name }]),
    ),
  }));
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
    if (createdParts.has(Number(req.params.id))) return res.json(createdParts.get(Number(req.params.id)));
    if (req.params.id === "99999999") return res.status(404).json({ detail: "No Part matches", barcode_hash: "must-not-leak" });
    if (req.params.id === "43") {
      return res.json({ ...part, pk: 43, name: "Part without image", image: null, thumbnail: "/static/img/blank_image.thumbnail.png" });
    }
    return res.json(part);
  });
  fakeInvenTree.get("/api/part/", (req, res) => {
    partSearchQueries.push(String(req.query.search ?? ""));
    partParameterQueries.push(req.query);
    const results = ["New capacitor", "10nF 50V X7R 0603"].includes(String(req.query.search)) ? [] : [{ ...part, query: req.query.search }];
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
  fakeInvenTree.get("/api/stock/:id/", (req, res) => req.params.id === "99999999"
    ? res.status(404).json({ detail: "No stock matches" }) : res.json(stockItem));
  fakeInvenTree.patch("/api/stock/:id/", (req, res) => {
    stockMetadataPatches.push(req.body);
    Object.assign(stockItem, req.body);
    res.json(stockItem);
  });
  fakeInvenTree.get("/api/stock/", (_req, res) =>
    res.json({ count: 1, next: null, previous: null, results: [stockItem] }),
  );
  fakeInvenTree.post("/api/stock/add/", (req, res) => {
    const adjustment = req.body.items?.[0];
    stockItem.quantity += Number(adjustment?.quantity ?? 0);
    part.total_in_stock = stockItem.quantity;
    res.status(201).json(req.body);
  });
  fakeInvenTree.post("/api/part/", (req, res) => {
    if (req.body.name === "Rejected part") {
      return res.status(400).json({ units: ["Select a valid choice."], secret_token: "must-not-leak" });
    }
    createdParts.set(1001, { ...req.body, pk: 1001 });
    if (req.body.name === "10nF 50V X7R 0603") {
      const inheritedPk = ++catalogPk;
      catalog.get("/api/parameter/")!.set(inheritedPk, { pk: inheritedPk, model_type: "part", model_id: 1001,
        template: 801, data: "1nF", note: "inherited category note" });
    }
    return res.status(201).json({ ...req.body, pk: 1001 });
  });
  fakeInvenTree.post("/api/stock/", (req, res) => {
    createdStockBodies.push(req.body);
    res.status(201).json([{ ...req.body, pk: 1002 }]);
  });
  fakeInvenTree.patch("/api/part/:id/", express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      Object.assign(createdParts.get(Number(req.params.id)) ?? part, req.body);
      return res.json({ ...req.body, pk: Number(req.params.id) });
    }
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
  for (const [path, items] of catalog) {
    fakeInvenTree.get(path, (req, res) => {
      let values = [...items.values()].filter((item) => Object.entries(req.query).every(([key, value]) => {
        if (["limit", "offset", "ordering", "template_detail", "part_detail", "supplier_detail", "manufacturer_detail", "manufacturer_part_detail"].includes(key)) return true;
        if (key === "search") return Object.values(item).some((field) => String(field).toLowerCase().includes(String(value).toLowerCase()));
        if (key === "for_model") return !item.model_type || item.model_type === value || item.model_type === `${value}.${value}`;
        return String(item[key]) === String(value);
      }));
      const count = values.length;
      values = values.slice(Number(req.query.offset ?? 0), Number(req.query.offset ?? 0) + Number(req.query.limit ?? 100));
      res.json({ count, results: values.map((item) => enrichedCatalog(path, item)) });
    });
    fakeInvenTree.get(new RegExp(`^${path}([0-9]+)/$`), (req, res) => {
      const item = items.get(Number(req.params[0]));
      return item ? res.json(enrichedCatalog(path, item)) : res.status(404).json({ detail: "Missing catalog record" });
    });
    fakeInvenTree.post(path, (req, res) => {
      catalogWrites.push({ method: "POST", path, body: req.body });
      const item = { ...req.body, pk: ++catalogPk };
      items.set(item.pk, item);
      res.status(201).json(item);
    });
    fakeInvenTree.patch(new RegExp(`^${path}([0-9]+)/$`), (req, res) => {
      catalogWrites.push({ method: "PATCH", path: req.path, body: req.body });
      const item = items.get(Number(req.params[0]));
      if (!item) return res.status(404).json({ detail: "Missing catalog record" });
      Object.assign(item, req.body);
      return res.json(item);
    });
  }
  fakeInvenTree.get("/api/order/po/", (req, res) => {
    assert.equal(req.query.supplier, "501");
    res.json({ count: 1, results: [{ pk: 1101, reference: "PO-001", status: 10, status_text: "Pending", supplier: 501, supplier_detail: { pk: 501, name: "LCSC" } }] });
  });
  fakeInvenTree.get("/api/order/po/:id/", (_req, res) => res.json({ pk: 1101, reference: "PO-001", status: 10, supplier: 501 }));
  fakeInvenTree.get("/api/order/po-line/", (req, res) => {
    assert.equal(req.query.order, "1101");
    res.json({ count: 1, results: [{ pk: 1201, part: 701, internal_part: 42, part_detail: part,
      sku: "C57112", mpn: "0603B103K500NT", quantity: "100", received: "40" }] });
  });
  fakeInvenTree.get("/api/build/", (req, res) => {
    assert.equal(req.query.part, "42");
    res.json({ count: 1, results: [{ pk: 1301, reference: "BO-001", status: 10, status_text: "Pending", part: 42, part_detail: part, quantity: "2", completed: 0 }] });
  });
  fakeInvenTree.get(/^\/api\/build\/([0-9]+)\/$/, (_req, res) => res.json({ pk: 1301, reference: "BO-001", part: 42, part_detail: part, quantity: 2, completed: 0, status: 10 }));
  fakeInvenTree.get("/api/build/line/", (req, res) => {
    assert.equal(req.query.build, "1301");
    res.json({ count: 1, results: [{ pk: 1401, part: 42, part_detail: part, quantity: "4", allocated: "2", consumed: "1" }] });
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
      "create_inventory_plan",
      "prepare_part_image_upload",
      "get_part_image_upload_status",
      "review_inventory_plan",
      "discard_inventory_plan",
      "commit_inventory_plan",
      "get_inventory_guide", "inventree_get", "list_companies", "find_manufacturer_parts", "find_supplier_parts",
      "get_part_sourcing", "list_parameter_templates", "get_part_parameters",
      "list_purchase_orders", "get_purchase_order", "list_build_orders", "get_build_order",
    ]) {
      assert.ok(toolNames.includes(expected), `missing tool ${expected}`);
    }
    assert.ok(!toolNames.includes("inventree_write"));
    assert.ok(!toolNames.includes("get_part_bom"));
    for (const removed of [
      "create_part_with_stock", "update_part", "set_part_image", "receive_stock", "consume_stock",
      "move_stock", "count_stock", "update_stock", "set_stock_status", "create_part_category", "update_part_category",
      "create_stock_location", "update_stock_location", "print_labels", "remove_inventory_plan_step",
      "open_inventory_plan_review",
    ]) {
      assert.ok(!toolNames.includes(removed), `removed tool still published: ${removed}`);
    }
    const searchTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "find_parts");
    assert.ok(searchTool);
    assert.deepEqual(searchTool._meta.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);
    assert.deepEqual(searchTool.securitySchemes, [
      { type: "oauth2", scopes: ["inventree.read"] },
    ]);
    const stageTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "create_inventory_plan");
    const commitTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "commit_inventory_plan");
    assert.equal(stageTool.annotations.destructiveHint, false);
    assert.equal(commitTool.annotations.destructiveHint, true);
    const stepsDescription = stageTool.inputSchema.properties.steps.description as string;
    assert.match(stepsDescription, /Step shape: \{key, action, arguments\}/);
    assert.match(stepsDescription, /receive_stock \{part_id,quantity,location_id/);
    assert.match(stepsDescription, /print_labels \{entity_type,entities,template/);
    const planSchema = JSON.stringify(stageTool.inputSchema);
    for (const action of [
      "create_part_with_stock", "update_part", "set_part_image", "receive_stock", "consume_stock",
      "move_stock", "count_stock", "update_stock", "set_stock_status", "create_part_category", "update_part_category",
      "create_stock_location", "update_stock_location", "print_labels", "create_company", "update_company",
      "create_manufacturer_part", "update_manufacturer_part", "create_supplier_part", "update_supplier_part",
      "create_parameter_template", "update_parameter_template", "set_part_parameters",
    ]) {
      assert.match(planSchema, new RegExp(action), `missing create_inventory_plan action: ${action}`);
    }
    assert.match(planSchema, /"step"/);
    assert.match(planSchema, /"output"/);
    const outputEnums: unknown[][] = [];
    const collectOutputEnums = (schema: unknown) => {
      if (!schema || typeof schema !== "object") return;
      for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (key === "output" && value && typeof value === "object") {
          const values = (value as Record<string, unknown>).enum;
          if (Array.isArray(values)) outputEnums.push(values);
        }
        if (Array.isArray(value)) value.forEach(collectOutputEnums);
        else collectOutputEnums(value);
      }
    };
    collectOutputEnums(stageTool.inputSchema);
    assert.ok(outputEnums.length > 0, "create_inventory_plan did not publish output-name enums");
    for (const values of outputEnums) {
      assert.deepEqual(values, ["part", "stock_item", "part_category", "stock_location", "company", "manufacturer_part", "supplier_part", "parameter_template"]);
    }
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
    const normalizedSearch = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "find_parts", arguments: { query: "10 kOhm resistor" } },
    });
    assert.equal(normalizedSearch.body.result.structuredContent.data.results[0].id, 42);
    assert.equal(partSearchQueries.at(-1), "10kΩ resistor");
    const toolLog = requestLogs.find((message) => message.includes("MCP tools/call") && message.includes('"name":"find_parts"'));
    assert.ok(toolLog);
    assert.match(toolLog, /"arguments":\{"query":"10k"/);
    assert.equal(requestLogs.some((message) => message.includes("POST /mcp")), false);

    const refusedWrite = await mcpRequest(token.body.access_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "refused-write",
          steps: [{
            key: "receive",
            action: "receive_stock",
            arguments: { part_id: 42, quantity: 1, location_id: 81 },
          }],
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

  it("serves an importable skill package with matching resource bytes and a read-only tool fallback", async () => {
    const token = await authorizeToken("inventree.read");
    const invoke = async (method: string, params: object = {}) =>
      (await mcpRequest(token, { jsonrpc: "2.0", id: 201, method, params })).body;
    const before = { catalog: catalogWrites.length, stock: stockMetadataPatches.length, receipts: createdStockBodies.length };
    const initialized = await invoke("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "skill-import-test", version: "1" },
    });
    assert.deepEqual(initialized.result.capabilities.extensions["io.modelcontextprotocol/skills"], {});
    assert.ok(initialized.result.capabilities.resources);
    assert.match(initialized.result.instructions, /get_inventory_guide/);
    const catalog = await invoke("skills/list");
    assert.equal(catalog.result.skills.length, 1);
    assert.equal(catalog.result.nextCursor, undefined);
    const manifest = catalog.result.skills[0];
    const baseUri = "skill://inventree-mcp/inventree-inventory/";
    assert.equal(manifest.uri, `${baseUri}SKILL.md`);
    assert.deepEqual((await invoke("skills/get", { uri: manifest.uri })).result.skill, manifest);
    const resources = (await invoke("resources/list")).result.resources;
    const textByUri = new Map<string, string>();
    assert.deepEqual(manifest.resources.map((item: { uri: string }) => item.uri).sort(),
      resources.map((item: { uri: string }) => item.uri).sort());
    for (const item of manifest.resources) {
      const read = await invoke("resources/read", { uri: item.uri });
      assert.equal(read.result.contents.length, 1);
      const content = read.result.contents[0];
      assert.equal(content.uri, item.uri);
      const bytes = content.text !== undefined ? Buffer.from(content.text, "utf8") : Buffer.from(content.blob, "base64");
      assert.equal(item.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      assert.deepEqual(bytes, readFileSync(new URL(`../skills/inventree-inventory/${item.uri.slice(baseUri.length)}`, import.meta.url)));
      textByUri.set(item.uri, content.text);
    }
    for (const path of ["SKILL.md", "agents/openai.yaml", "references/workflows.md"]) assert.ok(textByUri.has(`${baseUri}${path}`));
    const main = textByUri.get(manifest.uri)!;
    assert.deepEqual(manifest.frontmatter, parse(/^---\n([\s\S]*?)\n---/.exec(main)![1]!));
    for (const [arguments_, uri] of [[{}, manifest.uri], [{ section: "workflows" }, `${baseUri}references/workflows.md`]] as const) {
      const guide = await callTool(token, "get_inventory_guide", arguments_);
      assert.ok(!guide.isError);
      assert.equal(guide.structuredContent.data.uri, uri);
      assert.equal(guide.structuredContent.data.markdown, textByUri.get(uri));
      assert.equal(guide.content[0].text, textByUri.get(uri));
      assert.equal(guide.structuredContent.data.digest, manifest.resources.find((item: { uri: string }) => item.uri === uri).digest);
    }
    assert.equal((await invoke("skills/get", { uri: `${baseUri}missing/SKILL.md` })).error.code, -32602);
    assert.equal((await invoke("skills/list", { cursor: "unknown-page" })).error.code, -32602);
    assert.ok((await invoke("resources/read", { uri: `${baseUri}../../.env` })).error);
    const writeOnly = await authorizeToken("inventree.write");
    const denied = await callTool(writeOnly, "get_inventory_guide", {});
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /inventree.read/);
    for (const [method, params] of [["skills/list", {}], ["skills/get", { uri: manifest.uri }], ["resources/read", { uri: manifest.uri }]] as const) {
      const deniedRequest = await mcpRequest(writeOnly, { jsonrpc: "2.0", id: 202, method, params });
      assert.match(deniedRequest.body.error.message, /inventree.read/);
    }
    assert.deepEqual({ catalog: catalogWrites.length, stock: stockMetadataPatches.length, receipts: createdStockBodies.length }, before);
  });

  it("creates, revalidates, and commits a complete stock plan idempotently", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const preview = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "receive-five",
          steps: [{
            key: "receive",
            action: "receive_stock",
            arguments: {
              part_id: 42,
              quantity: 5,
              location_id: 81,
              merge: "compatible",
              notes: "Integration test",
            },
          }],
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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "receive-five",
          steps: [{
            key: "receive",
            action: "receive_stock",
            arguments: {
              part_id: 42,
              quantity: 5,
              location_id: 81,
              merge: "compatible",
              notes: "Integration test",
            },
          }],
        },
      },
    });
    assert.equal(duplicate.body.result.structuredContent.data.duplicate_operation, true);
    assert.equal(duplicate.body.result.structuredContent.data.plan_id, planId);
    assert.equal(duplicate.body.result.structuredContent.data.plan_version, planVersion);

    const conflictingReplay = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "receive-five",
          steps: [{
            key: "receive",
            action: "receive_stock",
            arguments: { part_id: 42, quantity: 6, location_id: 81, merge: "compatible" },
          }],
        },
      },
    });
    assert.equal(conflictingReplay.body.result.structuredContent.data.status, "conflict");
    assert.equal(conflictingReplay.body.result.structuredContent.data.conflict_type, "operation_id");

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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "stale-receive",
          steps: [{
            key: "receive",
            action: "receive_stock",
            arguments: { part_id: 42, quantity: 1, location_id: 81, merge: "compatible" },
          }],
        },
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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "create-new-capacitor",
          steps: [
            {
              key: "part",
              action: "create_part_with_stock",
              arguments: {
                part: { name: "New capacitor", category_id: 15, units: "pcs" },
                initial_stock: { quantity: 10, location_id: 81, packaging: "cut tape" },
              },
            },
            {
              key: "label",
              action: "print_labels",
              arguments: {
                entity_type: "stock_item",
                entities: [{ step: "part", output: "stock_item" }],
                template: "30x15mm",
                copies: 3,
              },
            },
          ],
        },
      },
    });
    assert.equal(create.body.result.structuredContent.data.status, "staged");
    const planId = create.body.result.structuredContent.data.plan_id as string;
    const stockRef = create.body.result.structuredContent.data.aliases.part.stock_item as string;
    assert.equal(create.body.result.structuredContent.data.plan_version, 2);
    assert.match(create.body.result.content[0].text, /New capacitor.*Drawer A3/);
    assert.match(create.body.result.content[0].text, /Print 3 copies/);
    assert.match(create.body.result.content[0].text, /complete canonical review/i);

    const review = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "review_inventory_plan", arguments: { plan_id: planId } },
    });
    assert.equal(review.body.result.structuredContent.data.status, "staged");
    assert.equal(review.body.result.structuredContent.data.steps.length, 2);

    const printRequestCountBeforeCommit = printedLabelBodies.length;
    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "commit_inventory_plan", arguments: { plan_id: planId, expected_version: 2 } },
    });
    assert.equal(commit.body.result.structuredContent.data.resolved_refs[stockRef], 1002);
    assert.equal(printedLabelBodies.length, printRequestCountBeforeCommit + 1);
    assert.deepEqual(printedLabelBodies.at(-1), {
      template: 20,
      plugin: "zebra",
      items: [1002],
      number_of_labels: 3,
    });
  });

  it("rejects invalid future references without retaining a partial plan", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");
    const invalidReference = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "atomic-invalid-reference",
          steps: [
            {
              key: "part",
              action: "create_part_with_stock",
              arguments: { part: { name: "New capacitor", category_id: 15 } },
            },
            {
              key: "label",
              action: "print_labels",
              arguments: {
                entity_type: "stock_item",
                entities: [{ step: "part", output: "stock_location" }],
                template: "30x15mm",
              },
            },
          ],
        },
      },
    });
    assert.equal(invalidReference.body.result.structuredContent.data.status, "invalid_plan_reference");
    assert.equal(invalidReference.body.result.structuredContent.data.reference_error, "unknown_output");
    assert.equal(invalidReference.body.result.structuredContent.data.supplied_output, "stock_location");
    assert.deepEqual(invalidReference.body.result.structuredContent.data.available_outputs, ["part"]);
    assert.match(invalidReference.body.result.content[0].text, /declares outputs \["part"\]/);
    assert.doesNotMatch(readFileSync(config.dataFile, "utf8"), /atomic-invalid-reference/);

    const invalidOutputName = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "atomic-invalid-output-name",
          steps: [
            {
              key: "part",
              action: "create_part_with_stock",
              arguments: {
                part: { name: "New capacitor", category_id: 15 },
                initial_stock: { quantity: 10, location_id: 81 },
              },
            },
            {
              key: "label",
              action: "print_labels",
              arguments: {
                entity_type: "stock_item",
                entities: [{ step: "part", output: "stock_item_id" }],
                template: "30x15mm",
              },
            },
          ],
        },
      },
    });
    assert.equal(invalidOutputName.body.result.isError, true);
    assert.match(invalidOutputName.body.result.content[0].text, /stock_item_id/);
    assert.match(invalidOutputName.body.result.content[0].text, /part_category/);
    assert.doesNotMatch(readFileSync(config.dataFile, "utf8"), /atomic-invalid-output-name/);
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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "create-planned-bin",
          steps: [
            {
              key: "location",
              action: "create_stock_location",
              arguments: { name: "Planned bin", parent_id: "81" },
            },
            {
              key: "describe",
              action: "update_stock_location",
              arguments: {
                location_id: { step: "location", output: "stock_location" },
                changes: { description: "Created and updated in one plan" },
              },
            },
            {
              key: "move",
              action: "move_stock",
              arguments: {
                destination_location_id: { step: "location", output: "stock_location" },
                stock_item_id: "91",
              },
            },
          ],
        },
      },
    });
    assert.equal(create.body.result.structuredContent.data.status, "staged");
    const planId = create.body.result.structuredContent.data.plan_id as string;
    const locationRef = create.body.result.structuredContent.data.aliases.location.stock_location as string;
    assert.equal(create.body.result.structuredContent.data.plan_version, 3);

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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "duplicate-part-probe",
          steps: [{
            key: "part",
            action: "create_part_with_stock",
            arguments: { part: { name: "10k resistor", category_id: 15 } },
          }],
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

  it("validates formal part units before staging and preserves upstream commit details", async () => {
    const accessToken = await authorizeToken("inventree.read inventree.write");

    const invalidUnit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 65,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "invalid-localized-unit",
          steps: [{
            key: "part",
            action: "create_part_with_stock",
            arguments: { part: { name: "Household item", category_id: 15, units: "개" } },
          }],
        },
      },
    });
    assert.equal(invalidUnit.body.result.isError, true);
    assert.equal(invalidUnit.body.result.structuredContent.data.status, "invalid_unit");
    assert.equal(invalidUnit.body.result.structuredContent.data.supplied_unit, "개");
    assert.equal(invalidUnit.body.result.structuredContent.data.plan_id, undefined);
    assert.match(invalidUnit.body.result.content[0].text, /Omit units unless/);

    const staged = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 66,
      method: "tools/call",
      params: {
        name: "create_inventory_plan",
        arguments: {
          operation_id: "upstream-validation-detail",
          steps: [{
            key: "part",
            action: "create_part_with_stock",
            arguments: {
              allow_possible_duplicates: true,
              part: { name: "Rejected part", category_id: 15 },
            },
          }],
        },
      },
    });
    assert.equal(staged.body.result.structuredContent.data.status, "staged");

    const commit = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 67,
      method: "tools/call",
      params: {
        name: "commit_inventory_plan",
        arguments: {
          plan_id: staged.body.result.structuredContent.data.plan_id,
          expected_version: 1,
        },
      },
    });
    assert.equal(commit.body.result.isError, true);
    assert.equal(commit.body.result.structuredContent.data.status, "upstream_error");
    assert.equal(commit.body.result.structuredContent.data.http_status, 400);
    assert.match(commit.body.result.structuredContent.data.failed_step_id, /^stp_/);
    assert.equal(commit.body.result.structuredContent.data.completed_steps, 0);
    assert.equal(commit.body.result.structuredContent.data.completed_operations, 0);
    assert.deepEqual(commit.body.result.structuredContent.data.details, {
      units: ["Select a valid choice."],
    });
    assert.doesNotMatch(JSON.stringify(commit.body.result), /must-not-leak|secret_token/);
    assert.match(commit.body.result.content[0].text, /failed at stp_.*HTTP 400/);
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
      suggested_tool: "prepare_part_image_upload",
    });
    assert.match(noImage.body.result.content[0].text, /prepare_part_image_upload/);

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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "replace-part-image",
          steps: [{
            key: "image",
            action: "set_part_image",
            arguments: { part_id: "42", upload_ref: uploadRef },
          }],
        },
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
        name: "create_inventory_plan",
        arguments: {
          operation_id: "no-op-count",
          steps: [{
            key: "count",
            action: "count_stock",
            arguments: { counts: [{ stock_item_id: 91, observed_quantity: stockItem.quantity }] },
          }],
        },
      },
    });
    assert.equal(counted.body.result.structuredContent.data.status, "already_current");
    assert.equal(counted.body.result.structuredContent.data.plan_id, undefined);
  });

  async function callTool(token: string, name: string, arguments_: object) {
    return (await mcpRequest(token, { jsonrpc: "2.0", id: 200, method: "tools/call", params: { name, arguments: arguments_ } })).body.result;
  }
  async function stageCatalog(token: string, operation_id: string, steps: object[]) {
    return callTool(token, "create_inventory_plan", { operation_id, steps });
  }
  async function commitCatalog(token: string, staged: any) {
    assert.equal(staged.structuredContent.data.status, "staged", staged.content[0].text);
    return callTool(token, "commit_inventory_plan", { plan_id: staged.structuredContent.data.plan_id,
      expected_version: staged.structuredContent.data.plan_version });
  }

  it("reads sourcing and specifications with distinct IDs and explicit pagination", async () => {
    const token = await authorizeToken("inventree.read");
    const companies = await callTool(token, "list_companies", { role: "supplier", limit: 1 });
    assert.equal(companies.structuredContent.data.results[0].id, 501);
    assert.ok(companies.structuredContent.data.nextCursor);
    const next = await callTool(token, "list_companies", { role: "supplier", limit: 1, cursor: companies.structuredContent.data.nextCursor });
    assert.equal(next.structuredContent.data.results[0].id, 503);
    const source = await callTool(token, "get_part_sourcing", { part_id: 42 });
    const data = source.structuredContent.data;
    assert.equal(data.part.id, 42);
    assert.equal(data.manufacturerParts.results[0].id, 601);
    assert.equal(data.supplierParts.results[0].id, 701);
    assert.equal(data.supplierParts.results[0].manufacturerPartId, 601);
    assert.equal(data.supplierParts.results[0].mpn, "0603B103K500NT");
    assert.match(source.content[0].text, /C57112.*supplier part #701/);
    const supplier = await callTool(token, "find_supplier_parts", { SKU: "C57112", supplier_id: 501 });
    assert.equal(supplier.structuredContent.data.count, 1);
    const manufacturer = await callTool(token, "find_manufacturer_parts", { MPN: "0603B103K500NT", manufacturer_id: 502 });
    assert.equal(manufacturer.structuredContent.data.results[0].part.id, 42);
    const parameters = await callTool(token, "get_part_parameters", { part_id: 42 });
    assert.equal(parameters.structuredContent.data.results[0].templateId, 801);
    assert.equal(parameters.structuredContent.data.results[0].value, "10nF");
    assert.equal(parameters.structuredContent.data.results[0].units, "F");
    const card = await callTool(token, "get_part_inventory", { part_id: 42, include: ["parameters"] });
    assert.equal(card.structuredContent.data.parameters.results[0].value, "10nF");
    assert.match(card.content[0].text, /Capacitance: 10nF/);
    const templates = await callTool(token, "list_parameter_templates", { enabled: true });
    assert.ok(templates.structuredContent.data.results.some((item: any) => item.id === 802));
    assert.ok(!templates.structuredContent.data.results.some((item: any) => item.id === 804 || item.id === 805));
    const missing = await callTool(token, "get_part_sourcing", { part_id: 99999999 });
    assert.equal(missing.structuredContent.data.status, "not_found");
  });

  it("searches canonical parts with structured specification filters", async () => {
    const token = await authorizeToken("inventree.read");
    const response = await callTool(token, "find_parts", { parameters: [
      { template_id: 801, value: "10nF" }, { template_id: 802, value: "0603" },
      { template_id: 801, value: "50nF", operator: "lte" },
    ] });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.data.results[0].id, 42);
    const query = partParameterQueries.at(-1)!;
    assert.equal(query.parameter_801, "10nF");
    assert.equal(query.parameter_802, "0603");
    assert.equal(query.parameter_801_lte, "50nF");
    const duplicate = await callTool(token, "find_parts", { parameters: [
      { template_id: 801, value: "10nF" }, { template_id: 801, value: "20nF" },
    ] });
    assert.match(duplicate.content[0].text, /Duplicate parameter filter/);
  });

  it("keeps purchase supplier IDs distinct and reads build component progress", async () => {
    const token = await authorizeToken("inventree.read");
    const purchases = await callTool(token, "list_purchase_orders", { supplier_id: 501 });
    assert.equal(purchases.structuredContent.data.results[0].reference, "PO-001");
    const purchase = await callTool(token, "get_purchase_order", { order_id: 1101 });
    const line = purchase.structuredContent.data.lines.results[0];
    assert.equal(line.supplierPartId, 701);
    assert.equal(line.part.id, 42);
    assert.equal(line.quantity, 100);
    assert.equal(line.received, 40);
    const builds = await callTool(token, "list_build_orders", { part_id: 42 });
    assert.equal(builds.structuredContent.data.results[0].quantity, 2);
    const build = await callTool(token, "get_build_order", { order_id: 1301 });
    assert.equal(build.structuredContent.data.lines.results[0].allocated, 2);
    assert.equal(build.structuredContent.data.lines.results[0].consumed, 1);
  });

  it("commits a complete canonical capacitor, sourcing, specifications and sourced receipt once", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const before = catalogWrites.length;
    const stockBefore = createdStockBodies.length;
    const staged = await stageCatalog(token, "capacitor-catalog", [
      { key: "maker", action: "create_company", arguments: { name: "Capacitor Maker", is_manufacturer: true } },
      { key: "shop", action: "create_company", arguments: { name: "Capacitor Shop", is_supplier: true } },
      { key: "part", action: "create_part_with_stock", arguments: { part: { name: "10nF 50V X7R 0603", category_id: 15 } } },
      { key: "mpn", action: "create_manufacturer_part", arguments: { part_id: { step: "part", output: "part" }, manufacturer_id: { step: "maker", output: "company" }, MPN: "0603B103K500NT" } },
      { key: "sku", action: "create_supplier_part", arguments: { part_id: { step: "part", output: "part" }, supplier_id: { step: "shop", output: "company" }, manufacturer_part_id: { step: "mpn", output: "manufacturer_part" }, SKU: "C57112" } },
      { key: "voltage", action: "create_parameter_template", arguments: { name: "Voltage", units: "V" } },
      { key: "specs", action: "set_part_parameters", arguments: { part_id: { step: "part", output: "part" }, parameters: [
        { template_id: 801, data: "10nF" }, { template_id: 802, data: "0603" }, { template_id: 803, data: "X7R" },
        { template_id: { step: "voltage", output: "parameter_template" }, data: "50V" },
      ] } },
      { key: "receive", action: "receive_stock", arguments: { part_id: { step: "part", output: "part" }, supplier_part_id: { step: "sku", output: "supplier_part" }, location_id: 81, quantity: 100, merge: "new_item" } },
    ]);
    assert.equal(catalogWrites.length, before, "staging wrote catalog records");
    assert.equal(createdStockBodies.length, stockBefore, "staging received stock");
    assert.match(staged.content[0].text, /10nF 50V X7R 0603/);
    assert.match(staged.content[0].text, /0603B103K500NT/);
    assert.match(staged.content[0].text, /C57112/);
    const committed = await commitCatalog(token, staged);
    assert.equal(committed.structuredContent.data.status, "committed", committed.content[0].text);
    const writes = catalogWrites.slice(before);
    const maker = writes.find((item) => item.body.name === "Capacitor Maker")!;
    assert.equal(maker.body.is_manufacturer, true);
    const mpn = writes.find((item) => item.body.MPN)!;
    const supplier = writes.find((item) => item.body.SKU)!;
    assert.equal(mpn.body.part, 1001);
    assert.equal(supplier.body.part, 1001);
    assert.equal(typeof supplier.body.manufacturer_part, "number");
    assert.equal(writes.filter((item) => item.path.startsWith("/api/parameter/") && !item.path.startsWith("/api/parameter/template/")).length, 4);
    const inherited = [...catalog.get("/api/parameter/")!.values()].filter((item) => item.model_id === 1001 && item.template === 801);
    assert.equal(inherited.length, 1, "setter duplicated an inherited category parameter");
    assert.equal(inherited[0]!.data, "10nF");
    assert.equal(inherited[0]!.note, "inherited category note");
    assert.ok(writes.filter((item) => item.path === "/api/parameter/").every((item) => item.body.model_id === 1001));
    const receipt = createdStockBodies.at(-1)!;
    assert.equal(receipt.part, 1001);
    assert.equal(receipt.quantity, 100);
    assert.equal(typeof receipt.supplier_part, "number");
    const count = catalogWrites.length;
    await commitCatalog(token, staged);
    assert.equal(catalogWrites.length, count, "commit replay wrote catalog records twice");
    assert.equal(createdStockBodies.length, stockBefore + 1);
  });

  it("upserts existing parameters sparsely, preserves notes, and rejects stale commits", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const staged = await stageCatalog(token, "update-capacitance", [{ key: "specs", action: "set_part_parameters",
      arguments: { part_id: 42, parameters: [{ template_id: 801, data: "22nF" }, { template_id: 802, data: "0603" }] } }]);
    const committed = await commitCatalog(token, staged);
    assert.equal(committed.structuredContent.data.status, "committed");
    assert.equal(catalog.get("/api/parameter/")!.get(901)!.data, "22nF");
    assert.equal(catalog.get("/api/parameter/")!.get(901)!.note, "keep this note");
    const noChange = await stageCatalog(token, "same-capacitance", [{ key: "specs", action: "set_part_parameters",
      arguments: { part_id: 42, parameters: [{ template_id: 801, data: "22nF" }] } }]);
    assert.equal(noChange.structuredContent.data.status, "already_current");
    const stale = await stageCatalog(token, "stale-capacitance", [{ key: "specs", action: "set_part_parameters",
      arguments: { part_id: 42, parameters: [{ template_id: 801, data: "33nF" }] } }]);
    catalog.get("/api/parameter/")!.get(901)!.data = "47nF";
    const count = catalogWrites.length;
    const failed = await commitCatalog(token, stale);
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.data.conflict_type, "stale_inventory");
    assert.equal(catalogWrites.length, count);
  });

  it("supports sparse updates and role changes earlier in the same catalog plan", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const staged = await stageCatalog(token, "maker-becomes-supplier", [
      { key: "role", action: "update_company", arguments: { company_id: 502, changes: { is_supplier: true } } },
      { key: "supplier", action: "create_supplier_part", arguments: { part_id: 42, supplier_id: 502, SKU: "MAKER-DIRECT", manufacturer_part_id: 601 } },
      { key: "mpn", action: "update_manufacturer_part", arguments: { manufacturer_part_id: 601, changes: { description: "Verified MPN" } } },
      { key: "sku", action: "update_supplier_part", arguments: { supplier_part_id: { step: "supplier", output: "supplier_part" }, changes: { packaging: "reel" } } },
      { key: "template", action: "update_parameter_template", arguments: { parameter_template_id: 802, changes: { description: "Package code" } } },
    ]);
    const before = catalogWrites.length;
    assert.equal((await commitCatalog(token, staged)).structuredContent.data.status, "committed");
    assert.deepEqual(catalogWrites[before]!.body, { is_supplier: true });
    assert.equal(catalog.get(catalogPaths.company)!.get(502)!.is_manufacturer, true);
    assert.deepEqual(catalogWrites.at(-1)!.body, { description: "Package code" });
  });

  it("rejects invalid sourcing and parameter inputs without upstream writes or retained plans", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const cases = [
      ["company-roles", "create_company", { name: "Neither role" }, /must be a supplier/],
      ["company-case", "create_company", { name: "lcsc", is_supplier: true }, /already exists/],
      ["template-case", "create_parameter_template", { name: "capacitance" }, /already exists/],
      ["empty-update", "update_supplier_part", { supplier_part_id: 701, changes: {} }, /At least one change/],
      ["wrong-receipt", "receive_stock", { part_id: 43, supplier_part_id: 701, quantity: 2, location_id: 81, merge: "new_item" }, /received canonical part/],
      ["wrong-role", "create_manufacturer_part", { part_id: 42, manufacturer_id: 501, MPN: "Wrong role" }, /not marked as a manufacturer/],
      ["wrong-part", "create_supplier_part", { part_id: 42, supplier_id: 501, SKU: "Wrong part", manufacturer_part_id: 602 }, /same canonical part/],
      ["inactive", "create_supplier_part", { part_id: 42, supplier_id: 503, SKU: "Inactive" }, /inactive/],
      ["duplicate", "create_supplier_part", { part_id: 42, supplier_id: 501, SKU: "C57112" }, /already exists/],
      ["missing", "update_company", { company_id: 99999999, changes: { description: "missing" } }, /not found/],
      ["disabled", "set_part_parameters", { part_id: 42, parameters: [{ template_id: 805, data: "x" }] }, /disabled/],
      ["scope", "set_part_parameters", { part_id: 42, parameters: [{ template_id: 804, data: "x" }] }, /does not apply/],
      ["choices", "set_part_parameters", { part_id: 42, parameters: [{ template_id: 803, data: "Y5V" }] }, /requires one of/],
      ["repeat", "set_part_parameters", { part_id: 42, parameters: [{ template_id: 802, data: "0603" }, { template_id: 802, data: "0805" }] }, /Duplicate template/],
    ] as const;
    const count = catalogWrites.length;
    for (const [key, action, arguments_, message] of cases) {
      const rejected = await stageCatalog(token, key, [{ key: "bad", action, arguments: arguments_ }]);
      assert.equal(rejected.isError, true, key);
      assert.match(rejected.content[0].text, message, key);
      assert.equal(rejected.structuredContent.data.plan_id, undefined, key);
    }
    const duplicate = await stageCatalog(token, "staged-company-duplicate", [
      { key: "one", action: "create_company", arguments: { name: "Same company", is_supplier: true } },
      { key: "two", action: "create_company", arguments: { name: "same COMPANY", is_manufacturer: true } },
    ]);
    assert.equal(duplicate.structuredContent.data.conflict_type, "catalog_duplicate");
    assert.equal(catalogWrites.length, count);
    const badType = await stageCatalog(token, "wrong-output-type", [
      { key: "shop", action: "create_company", arguments: { name: "Bad type test", is_supplier: true } },
      { key: "sku", action: "create_supplier_part", arguments: { part_id: { step: "shop", output: "company" }, supplier_id: 501, SKU: "BAD-TYPE" } },
    ]);
    assert.match(badType.content[0].text, /company, not part/);
    assert.ok(!Object.values(JSON.parse(readFileSync(config.dataFile, "utf8")).mutationPlans).some((plan: any) =>
      plan.steps.some((step: any) => step.operationId.startsWith("staged-company-duplicate:") || step.operationId.startsWith("wrong-output-type:"))));
  });

  it("preserves source provenance and refuses stock merges from a different supplier", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const rejected = await stageCatalog(token, "bad-source-merge", [{ key: "receive", action: "receive_stock",
      arguments: { part_id: 42, supplier_part_id: 701, quantity: 2, location_id: 81, merge: "stock_item", stock_item_id: 91 } }]);
    assert.match(rejected.content[0].text, /different supplier provenance/);
    const beforeQuantity = stockItem.quantity;
    const staged = await stageCatalog(token, "sourced-compatible", [{ key: "receive", action: "receive_stock",
      arguments: { part_id: 42, supplier_part_id: 701, quantity: 2, location_id: 81, merge: "compatible" } }]);
    assert.match(staged.content[0].text, /Create a new stock item/);
    assert.equal((await commitCatalog(token, staged)).structuredContent.data.status, "committed");
    assert.equal(createdStockBodies.at(-1)!.supplier_part, 701);
    assert.equal(stockItem.quantity, beforeQuantity);
  });

  it("migrates an existing MPN-named part and links its existing stock without receiving anything", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const originalPart = { ...part };
    const originalStock = { ...stockItem };
    const stockKeys = new Set(Object.keys(stockItem));
    const stocksBefore = createdStockBodies.length;
    const patchesBefore = stockMetadataPatches.length;
    try {
      part.name = "RC0603FR-0710KL";
      const staged = await stageCatalog(token, "migrate-existing-resistor", [
        { key: "rename", action: "update_part", arguments: { part_id: 42, changes: { name: "10kΩ ±1% 0603 75V 100mW" } } },
        { key: "mpn", action: "create_manufacturer_part", arguments: { part_id: 42, manufacturer_id: 502, MPN: "RC0603FR-0710KL" } },
        { key: "sku", action: "create_supplier_part", arguments: { part_id: 42, supplier_id: 501, SKU: "TEST-RESISTOR", manufacturer_part_id: { step: "mpn", output: "manufacturer_part" } } },
        { key: "specs", action: "set_part_parameters", arguments: { part_id: 42, parameters: [{ template_id: 802, data: "0603" }] } },
        { key: "stock", action: "update_stock", arguments: { stock_item_id: "91", changes: { supplier_part_id: { step: "sku", output: "supplier_part" } } } },
      ]);
      assert.equal(staged.isError, undefined, staged.content[0].text);
      assert.match(staged.content[0].text, /RC0603FR-0710KL.*10kΩ/s);
      assert.equal(part.name, "RC0603FR-0710KL");
      assert.equal(stockMetadataPatches.length, patchesBefore);
      const committed = await commitCatalog(token, staged);
      assert.equal(committed.isError, undefined, committed.content[0].text);
      const supplierId = committed.structuredContent.data.resolved_refs[staged.structuredContent.data.aliases.sku.supplier_part];
      assert.equal(part.pk, 42); assert.equal(stockItem.pk, 91);
      assert.equal(part.name, "10kΩ ±1% 0603 75V 100mW");
      assert.deepEqual(stockMetadataPatches.at(-1), { supplier_part: supplierId });
      for (const key of ["quantity", "location", "batch", "packaging", "expiry_date", "status"] as const) assert.equal(stockItem[key], originalStock[key]);
      assert.equal(createdStockBodies.length, stocksBefore);
      await commitCatalog(token, staged);
      assert.equal(stockMetadataPatches.length, patchesBefore + 1);
    } finally {
      Object.assign(part, originalPart);
      for (const key of Object.keys(stockItem)) if (!stockKeys.has(key)) delete (stockItem as Record<string, unknown>)[key];
      Object.assign(stockItem, originalStock);
    }
  });

  it("edits stock sparsely, clears provenance, skips no-ops, and respects ordered edits", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const original = { ...stockItem };
    const keys = new Set(Object.keys(stockItem));
    try {
      await commitCatalog(token, await stageCatalog(token, "stock-attach", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: 91, changes: { supplier_part_id: 701 } } }]));
      const noChange = await stageCatalog(token, "stock-no-change", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: 91, changes: { supplier_part_id: 701 } } }]);
      assert.equal(noChange.structuredContent.data.status, "already_current");
      const before = stockMetadataPatches.length;
      const ordered = await stageCatalog(token, "stock-ordered", [
        { key: "first", action: "update_stock", arguments: { stock_item_id: 91, changes: { batch: "Changed" } } },
        { key: "restore", action: "update_stock", arguments: { stock_item_id: 91, changes: { batch: original.batch, supplier_part_id: null, notes: "Confirmed source cleared" } } },
        { key: "rename", action: "update_part", arguments: { part_id: 42, changes: { name: "Temporary name" } } },
        { key: "restore_name", action: "update_part", arguments: { part_id: 42, changes: { name: part.name } } },
      ]);
      await commitCatalog(token, ordered);
      assert.equal(stockMetadataPatches.length, before + 2);
      assert.deepEqual(stockMetadataPatches.at(-1), { batch: original.batch, supplier_part: null, notes: "Confirmed source cleared" });
      assert.equal(stockItem.quantity, original.quantity); assert.equal(stockItem.location, original.location);
    } finally {
      for (const key of Object.keys(stockItem)) if (!keys.has(key)) delete (stockItem as Record<string, unknown>)[key];
      Object.assign(stockItem, original);
    }
  });

  it("rejects invalid stock edits and stale migration commits before changing part or stock", async () => {
    const token = await authorizeToken("inventree.read inventree.write");
    const before = stockMetadataPatches.length;
    const suppliers = catalog.get(catalogPaths.supplier_part)!;
    suppliers.set(702, { pk: 702, part: 43, supplier: 501, SKU: "WRONG-PART", active: true });
    suppliers.set(703, { pk: 703, part: 42, supplier: 501, SKU: "INACTIVE", active: false });
    try {
      for (const [key, arguments_, message] of [
        ["stock-wrong-part", { stock_item_id: 91, changes: { supplier_part_id: 702 } }, /canonical part/],
        ["stock-inactive", { stock_item_id: 91, changes: { supplier_part_id: 703 } }, /inactive/],
        ["stock-empty", { stock_item_id: 91, changes: {} }, /At least one stock change/],
        ["stock-missing", { stock_item_id: 99999999, changes: { batch: "A" } }, /not found/],
        ["stock-quantity", { stock_item_id: 91, changes: { quantity: 100 } }, /quantity/],
      ] as const) {
        const invalid = await stageCatalog(token, key, [{ key: "bad", action: "update_stock", arguments: arguments_ }]);
        assert.equal(invalid.isError, true, key); assert.match(invalid.content[0].text, message);
      }
      part.locked = true;
      const locked = await stageCatalog(token, "stock-locked", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: 91, changes: { batch: "A" } } }]);
      assert.equal(locked.isError, true); assert.match(locked.content[0].text, /locked/);
      part.locked = false;
      const originalName = part.name;
      const stale = await stageCatalog(token, "stock-stale-migration", [
        { key: "rename", action: "update_part", arguments: { part_id: 42, changes: { name: "Must not commit" } } },
        { key: "stock", action: "update_stock", arguments: { stock_item_id: 91, changes: { supplier_part_id: 701 } } },
      ]);
      stockItem.quantity += 1;
      try {
        const failed = await commitCatalog(token, stale);
        assert.equal(failed.isError, true); assert.equal(failed.structuredContent.data.conflict_type, "stale_inventory");
        assert.equal(part.name, originalName); assert.equal(stockMetadataPatches.length, before);
      } finally { stockItem.quantity -= 1; }
    } finally { part.locked = false; suppliers.delete(702); suppliers.delete(703); }
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
