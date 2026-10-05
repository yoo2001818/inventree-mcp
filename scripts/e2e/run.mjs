import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { artifacts, testEnvironment } from "./environment.mjs";
import { parse } from "yaml";

const env = testEnvironment();
// All credentials and URLs come from the generated test stack, never .env.
const upstream = `http://127.0.0.1:${env.E2E_INVENTREE_PORT}`;
const bridge = `http://localhost:${env.E2E_MCP_PORT}`;
const prefix = `E2E ${Date.now()} ${randomBytes(3).toString("hex")}`;
const report = { startedAt: new Date().toISOString(), upstream, bridge, image: env.INVENTREE_IMAGE, run: prefix, checks: [], ids: {} };
let apiToken;
let accessToken;
let rpcId = 0;

function saveReport() {
  writeFileSync(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
async function check(name, run) {
  const started = Date.now();
  try {
    const value = await run();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
    saveReport();
    return value;
  } catch (error) {
    report.checks.push({ name, status: "failed", error: error.message, durationMs: Date.now() - started });
    saveReport();
    throw error;
  }
}
async function http(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
}
async function api(path, { method = "GET", body, query } = {}) {
  const url = new URL(path, upstream);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const response = await http(url, { method, headers: { Authorization: `Token ${apiToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}; ${JSON.stringify(data)}`);
  return data;
}
async function rpc(method, params, token = accessToken) {
  const response = await http(`${bridge}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }) });
  assert.equal(response.status, 200, `MCP ${method}: HTTP ${response.status}`);
  const message = await response.json();
  assert.ok(!message.error, `MCP ${method}: ${JSON.stringify(message.error)}`);
  return message.result;
}
async function tool(name, arguments_ = {}, { allowError = false, token } = {}) {
  const outcome = await rpc("tools/call", { name, arguments: arguments_ }, token ?? accessToken);
  if (!allowError) assert.ok(!outcome.isError, `${name}: ${outcome.content?.map((item) => item.text).join("\n")}`);
  return outcome;
}
async function stage(label, steps, options) {
  return tool("create_inventory_plan", { operation_id: `${prefix}:${label}`, steps }, options);
}
async function commit(staged) {
  const data = staged.structuredContent.data;
  assert.equal(data.status, "staged");
  const outcome = await tool("commit_inventory_plan", { plan_id: data.plan_id, expected_version: data.plan_version });
  assert.equal(outcome.structuredContent.data.status, "committed");
  return outcome;
}
async function stageAndCommit(label, steps) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const staged = await stage(`${label}-attempt-${attempt}`, steps);
    const data = staged.structuredContent.data;
    assert.equal(data.status, "staged");
    const done = await tool("commit_inventory_plan", { plan_id: data.plan_id, expected_version: data.plan_version }, { allowError: true });
    if (!done.isError) {
      assert.equal(done.structuredContent.data.status, "committed");
      return [staged, done];
    }
    // Completing a PO schedules background pricing updates. A preflight stale
    // rejection guarantees zero writes; restage only that specific conflict.
    // Never retry a partially applied or otherwise failed mutation as new work.
    const error = done.structuredContent.data;
    if (error.conflict_type !== "stale_inventory") throw new Error(done.content.map((item) => item.text).join("\n"));
    (report.restages ??= []).push({ label, attempt, changedPath: error.changed_path });
    console.log(`RESTAGE ${label}: upstream background change at ${error.changed_path}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}: upstream state continued changing across four reviewed snapshots`);
}
function resolved(staged, committed, step, output) {
  return Number(committed.structuredContent.data.resolved_refs[staged.structuredContent.data.aliases[step][output]]);
}
function ref(step, output) { return { step, output }; }
function results(outcome) { return outcome.structuredContent.data.results; }

async function authorize(scope = "inventree.read inventree.write") {
  const registration = await http(`${bridge}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "InvenTree Docker E2E", redirect_uris: ["http://localhost:18999/callback"] }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("hex");
  const resource = `${bridge}/mcp`;
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:18999/callback", scope, resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state });
  const authorization = await http(`${bridge}/oauth/authorize?${query}`);
  assert.equal(authorization.status, 200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(await authorization.text())?.[1];
  assert.ok(requestId);
  const approval = await http(`${bridge}/oauth/authorize`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, api_token: apiToken, owner_password: env.OWNER_PASSWORD }) });
  assert.equal(approval.status, 303, "Authorization did not validate the real InvenTree token");
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), state);
  const exchange = await http(`${bridge}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code"), client_id,
      redirect_uri: "http://localhost:18999/callback", code_verifier: verifier, resource }) });
  assert.equal(exchange.status, 200);
  return { ...await exchange.json(), client_id, resource };
}

try {
  await check("Real InvenTree credentials and server version", async () => {
    const response = await http(`${upstream}/api/user/me/token/?name=${encodeURIComponent(prefix)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.INVENTREE_ADMIN_USER}:${env.INVENTREE_ADMIN_PASSWORD}`).toString("base64")}` },
    });
    assert.equal(response.status, 200, "Could not authenticate the generated test admin");
    const credentials = await response.json();
    apiToken = credentials.token ?? credentials.key;
    assert.equal(typeof apiToken, "string");
    assert.ok(apiToken);
    const info = await api("/api/");
    report.inventreeVersion = info.version;
    report.apiVersion = info.apiVersion ?? info.api_version;
    console.log(`InvenTree ${info.version}, API ${report.apiVersion}`);
  });
  const oauth = await check("OAuth discovery, DCR, PKCE, and real upstream token validation", async () => {
    const unauthenticated = await http(`${bridge}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthenticated.status, 401);
    const discovery = await http(`${bridge}/.well-known/oauth-authorization-server`);
    assert.equal((await discovery.json()).issuer, bridge);
    const tokens = await authorize();
    accessToken = tokens.access_token;
    return tokens;
  });
  await check("MCP initialization and typed tool discovery", async () => {
    const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "docker-e2e", version: "1.0" } });
    assert.equal(initialized.serverInfo.name, "inventree-mcp");
    assert.deepEqual(initialized.capabilities.extensions["io.modelcontextprotocol/skills"], {});
    const { tools } = await rpc("tools/list");
    for (const name of ["create_inventory_plan", "commit_inventory_plan", "list_companies", "find_manufacturer_parts", "find_supplier_parts",
      "get_part_sourcing", "list_parameter_templates", "get_part_parameters", "list_purchase_orders", "get_purchase_order", "list_build_orders", "get_build_order", "get_inventory_guide"]) {
      assert.ok(tools.some((item) => item.name === name), `Missing ${name}`);
    }
    assert.ok(!tools.some((item) => item.name === "inventree_write"));
    report.toolCount = tools.length;
  });
  await check("Importable MCP skill, exact resource digests, and guide fallback from the Docker image", async () => {
    const readOnly = await authorize("inventree.read");
    const { skills, nextCursor } = await rpc("skills/list", {}, readOnly.access_token);
    assert.equal(skills.length, 1);
    assert.equal(nextCursor, undefined);
    const manifest = skills[0];
    const baseUri = "skill://inventree-mcp/inventree-inventory/";
    assert.equal(manifest.uri, `${baseUri}SKILL.md`);
    assert.deepEqual((await rpc("skills/get", { uri: manifest.uri }, readOnly.access_token)).skill, manifest);
    const textByUri = new Map();
    const { resources } = await rpc("resources/list", {}, readOnly.access_token);
    assert.deepEqual(resources.map((item) => item.uri).sort(), manifest.resources.map((item) => item.uri).sort());
    for (const resource of manifest.resources) {
      const { contents } = await rpc("resources/read", { uri: resource.uri }, readOnly.access_token);
      assert.equal(contents.length, 1);
      assert.equal(contents[0].uri, resource.uri);
      const bytes = contents[0].text !== undefined ? Buffer.from(contents[0].text, "utf8") : Buffer.from(contents[0].blob, "base64");
      assert.equal(resource.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      assert.deepEqual(bytes, readFileSync(new URL(`../../skills/inventree-inventory/${resource.uri.slice(baseUri.length)}`, import.meta.url)));
      textByUri.set(resource.uri, contents[0].text);
    }
    assert.deepEqual(manifest.frontmatter, parse(/^---\n([\s\S]*?)\n---/.exec(textByUri.get(manifest.uri))[1]));
    for (const [section, uri] of [["overview", manifest.uri], ["workflows", `${baseUri}references/workflows.md`], ["purchase_orders", `${baseUri}references/purchase-orders.md`]]) {
      const guide = await tool("get_inventory_guide", { section }, { token: readOnly.access_token });
      assert.equal(guide.structuredContent.data.markdown, textByUri.get(uri));
      assert.equal(guide.structuredContent.data.digest, manifest.resources.find((item) => item.uri === uri).digest);
      assert.equal(guide.content[0].text, textByUri.get(uri));
    }
    report.skillUri = manifest.uri;
    report.skillResourceCount = manifest.resources.length;
  });
  await check("Read-only OAuth token cannot stage mutations", async () => {
    const readOnly = await authorize("inventree.read");
    const refused = await stage("read-only", [{ key: "company", action: "create_company", arguments: { name: `${prefix} Unauthorized`, is_supplier: true } }],
      { token: readOnly.access_token, allowError: true });
    assert.equal(refused.isError, true);
  });
  let setup, setupCommit;
  await check("Create category, location, companies, and parameter templates through MCP", async () => {
    setup = await stage("setup", [
      { key: "category", action: "create_part_category", arguments: { name: `${prefix} Capacitors` } },
      { key: "location", action: "create_stock_location", arguments: { name: `${prefix} Drawer` } },
      { key: "maker", action: "create_company", arguments: { name: `${prefix} Manufacturer`, is_manufacturer: true } },
      { key: "supplier", action: "create_company", arguments: { name: `${prefix} LCSC`, is_supplier: true, currency: "USD" } },
      { key: "capacitance", action: "create_parameter_template", arguments: { name: `${prefix} Capacitance`, units: "F" } },
      { key: "voltage", action: "create_parameter_template", arguments: { name: `${prefix} Voltage`, units: "V" } },
      { key: "dielectric", action: "create_parameter_template", arguments: { name: `${prefix} Dielectric`, choices: "X7R,X5R,C0G" } },
      { key: "package", action: "create_parameter_template", arguments: { name: `${prefix} Package` } },
    ]);
    setupCommit = await commit(setup);
    for (const [key, output] of [["category", "part_category"], ["location", "stock_location"], ["maker", "company"], ["supplier", "company"],
      ["capacitance", "parameter_template"], ["voltage", "parameter_template"], ["dielectric", "parameter_template"], ["package", "parameter_template"]]) {
      report.ids[key] = resolved(setup, setupCommit, key, output);
      assert.ok(report.ids[key] > 0);
    }
    // Realistic inherited parameter fixture, seeded directly because category
    // defaults are not exposed as a connector mutation action yet.
    await api("/api/part/category/parameters/", { method: "POST", body: {
      category: report.ids.category, template: report.ids.capacitance, default_value: "1nF",
    } });
  });
  let capacitor, capacitorCommit;
  await check("Stage complete capacitor workflow without upstream mutations", async () => {
    capacitor = await stage("capacitor", [
      { key: "part", action: "create_part_with_stock", arguments: { part: { name: "10nF 50V X7R 0603", IPN: prefix, category_id: report.ids.category }, allow_possible_duplicates: true } },
      { key: "mpn", action: "create_manufacturer_part", arguments: { part_id: ref("part", "part"), manufacturer_id: report.ids.maker, MPN: "0603B103K500NT" } },
      { key: "sku", action: "create_supplier_part", arguments: { part_id: ref("part", "part"), supplier_id: report.ids.supplier, manufacturer_part_id: ref("mpn", "manufacturer_part"), SKU: "C57112" } },
      { key: "specs", action: "set_part_parameters", arguments: { part_id: ref("part", "part"), parameters: [
        { template_id: report.ids.capacitance, data: "10nF", note: "Measured test capacitor" },
        { template_id: report.ids.voltage, data: "50V" }, { template_id: report.ids.dielectric, data: "X7R" }, { template_id: report.ids.package, data: "0603" },
      ] } },
      { key: "receipt", action: "receive_stock", arguments: { part_id: ref("part", "part"), supplier_part_id: ref("sku", "supplier_part"),
        quantity: 100, location_id: report.ids.location, merge: "new_item" } },
    ]);
    assert.equal((await api("/api/part/", { query: { IPN: prefix, limit: 100 } })).count, 0);
    assert.equal((await api("/api/company/part/", { query: { supplier: report.ids.supplier, limit: 100 } })).count, 0);
  });
  await check("Commit and replay capacitor plan exactly once; verify canonical sourcing and stock", async () => {
    capacitorCommit = await commit(capacitor);
    for (const [key, output] of [["part", "part"], ["mpn", "manufacturer_part"], ["sku", "supplier_part"], ["receipt", "stock_item"]]) {
      report.ids[key] = resolved(capacitor, capacitorCommit, key, output);
    }
    assert.equal((await commit(capacitor)).structuredContent.data.completed_requests, capacitorCommit.structuredContent.data.completed_requests);
    const canonical = await api(`/api/part/${report.ids.part}/`);
    assert.equal(canonical.name, "10nF 50V X7R 0603");
    const supplier = await api(`/api/company/part/${report.ids.sku}/`);
    assert.equal(supplier.part, report.ids.part);
    assert.equal(supplier.manufacturer_part, report.ids.mpn);
    assert.equal(supplier.SKU, "C57112");
    const stock = await api(`/api/stock/${report.ids.receipt}/`);
    assert.equal(Number(stock.quantity), 100);
    assert.equal(stock.supplier_part, report.ids.sku);
    assert.equal((await api("/api/stock/", { query: { part: report.ids.part, limit: 100 } })).count, 1);
  });
  await check("Inherited parameters update without duplicates; units and notes read correctly", async () => {
    const values = await api("/api/parameter/", { query: { model_type: "part", model_id: report.ids.part, limit: 100 } });
    assert.equal(values.count, 4);
    assert.equal(values.results.filter((item) => item.template === report.ids.capacitance).length, 1);
    const params = results(await tool("get_part_parameters", { part_id: report.ids.part }));
    assert.equal(params.find((item) => item.templateId === report.ids.capacitance).value, "10nF");
    assert.equal(params.find((item) => item.templateId === report.ids.capacitance).note, "Measured test capacitor");
    assert.equal(params.find((item) => item.templateId === report.ids.voltage).units, "V");
    const card = await tool("get_part_inventory", { part_id: report.ids.part, include: ["parameters"] });
    assert.equal(card.structuredContent.data.parameters.results.length, 4);
    assert.equal(card.structuredContent.data.placements[0].supplierPartId, report.ids.sku);
  });
  await check("Sourcing discovery by SKU, MPN, and canonical part returns correct IDs", async () => {
    assert.equal(results(await tool("find_supplier_parts", { supplier_id: report.ids.supplier, SKU: "C57112" }))[0].id, report.ids.sku);
    assert.equal(results(await tool("find_manufacturer_parts", { manufacturer_id: report.ids.maker, MPN: "0603B103K500NT" }))[0].id, report.ids.mpn);
    const sourcing = (await tool("get_part_sourcing", { part_id: report.ids.part })).structuredContent.data;
    assert.equal(sourcing.manufacturerParts.results[0].id, report.ids.mpn);
    assert.equal(sourcing.supplierParts.results[0].manufacturerPartId, report.ids.mpn);
    for (const query of ["C57112", "0603B103K500NT"]) {
      let cursor, found = false;
      do {
        const page = (await tool("find_parts", { query, ...(cursor ? { cursor } : {}) })).structuredContent.data;
        found = page.results.some((item) => item.id === report.ids.part);
        cursor = page.nextCursor;
      } while (!found && cursor);
      assert.ok(found, `Current fixture was not discoverable by ${query}`);
    }
    assert.equal(results(await tool("list_companies", { query: prefix, role: "supplier" }))[0].id, report.ids.supplier);
    assert.equal((await tool("list_parameter_templates", { query: prefix })).structuredContent.data.count, 4);
  });
  await check("Specification search uses real unit conversion and ANDed filters", async () => {
    const found = await tool("find_parts", { category_id: report.ids.category, parameters: [
      { template_id: report.ids.capacitance, value: "0.01uF" }, { template_id: report.ids.voltage, value: "25V", operator: "gte" },
      { template_id: report.ids.package, value: "0603" },
    ] });
    assert.ok(results(found).some((item) => item.id === report.ids.part));
    assert.equal(results(await tool("find_parts", { category_id: report.ids.category,
      parameters: [{ template_id: report.ids.package, value: "0805" }] })).length, 0);
  });
  await check("Parameter and company pagination exposes every record", async () => {
    let cursor, ids = [];
    do {
      const page = (await tool("get_part_parameters", { part_id: report.ids.part, limit: 1, ...(cursor ? { cursor } : {}) })).structuredContent.data;
      ids.push(...page.results.map((item) => item.templateId)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(ids).size, 4);
    const first = (await tool("list_companies", { query: prefix, limit: 1 })).structuredContent.data;
    const next = (await tool("list_companies", { query: prefix, limit: 1, cursor: first.nextCursor })).structuredContent.data;
    assert.notEqual(first.results[0].id, next.results[0].id);
  });
  await check("Sparse catalog and parameter updates preserve existing values and notes", async () => {
    const staged = await stage("updates", [
      { key: "company", action: "update_company", arguments: { company_id: report.ids.maker, changes: { is_supplier: true } } },
      { key: "manufacturer", action: "update_manufacturer_part", arguments: { manufacturer_part_id: report.ids.mpn, changes: { description: "Verified test MPN" } } },
      { key: "supplier", action: "update_supplier_part", arguments: { supplier_part_id: report.ids.sku, changes: { packaging: "cut tape" } } },
      { key: "template", action: "update_parameter_template", arguments: { parameter_template_id: report.ids.package, changes: { description: "Package code" } } },
      { key: "specs", action: "set_part_parameters", arguments: { part_id: report.ids.part, parameters: [{ template_id: report.ids.capacitance, data: "22nF" }] } },
    ]);
    await commit(staged);
    const maker = await api(`/api/company/${report.ids.maker}/`);
    assert.equal(maker.is_supplier, true); assert.equal(maker.is_manufacturer, true);
    const param = results(await tool("get_part_parameters", { part_id: report.ids.part })).find((item) => item.templateId === report.ids.capacitance);
    assert.equal(param.value, "22nF"); assert.equal(param.note, "Measured test capacitor");
    const noChange = await stage("no-change", [{ key: "specs", action: "set_part_parameters", arguments: {
      part_id: report.ids.part, parameters: [{ template_id: report.ids.capacitance, data: "22nF" }] } }]);
    assert.equal(noChange.structuredContent.data.status, "already_current");
    // Leave the inspectable capacitor fixture consistent with its canonical name.
    await commit(await stage("restore-capacitance", [{ key: "specs", action: "set_part_parameters", arguments: {
      part_id: report.ids.part, parameters: [{ template_id: report.ids.capacitance, data: "10nF" }] } }]));
  });
  await check("Duplicate, invalid-choice, wrong-role, and missing-ID plans fail before mutation", async () => {
    const bad = [
      { action: "create_supplier_part", arguments: { part_id: report.ids.part, supplier_id: report.ids.supplier, SKU: "C57112" } },
      { action: "set_part_parameters", arguments: { part_id: report.ids.part, parameters: [{ template_id: report.ids.dielectric, data: "Y5V" }] } },
      { action: "create_manufacturer_part", arguments: { part_id: report.ids.part, manufacturer_id: report.ids.supplier, MPN: "Invalid" } },
      { action: "update_company", arguments: { company_id: 99999999, changes: { description: "Missing" } } },
    ];
    for (const [index, step] of bad.entries()) {
      const outcome = await stage(`invalid-${index}`, [{ key: "bad", ...step }], { allowError: true });
      assert.equal(outcome.isError, true); assert.equal(outcome.structuredContent.data.plan_id, undefined);
    }
    assert.equal((await api("/api/company/part/", { query: { supplier: report.ids.supplier, limit: 100 } })).count, 1);
  });
  await check("Stale plans reject commits before any upstream mutation", async () => {
    const stale = await stage("stale", [{ key: "company", action: "update_company", arguments: { company_id: report.ids.supplier, changes: { description: "Staged value" } } }]);
    await api(`/api/company/${report.ids.supplier}/`, { method: "PATCH", body: { description: "Changed externally" } });
    const data = stale.structuredContent.data;
    const outcome = await tool("commit_inventory_plan", { plan_id: data.plan_id, expected_version: data.plan_version }, { allowError: true });
    assert.equal(outcome.isError, true); assert.equal(outcome.structuredContent.data.conflict_type, "stale_inventory");
    assert.equal((await api(`/api/company/${report.ids.supplier}/`)).description, "Changed externally");
  });
  await check("Receipt merges same-source stock and separates unknown provenance", async () => {
    await commit(await stage("receive-more", [{ key: "receipt", action: "receive_stock", arguments: {
      part_id: report.ids.part, supplier_part_id: report.ids.sku, quantity: 5, location_id: report.ids.location,
    } }]));
    assert.equal(Number((await api(`/api/stock/${report.ids.receipt}/`)).quantity), 105);
    const unsourced = await stage("receive-unsourced", [{ key: "receipt", action: "receive_stock", arguments: {
      part_id: report.ids.part, quantity: 3, location_id: report.ids.location,
    } }]);
    await commit(unsourced);
    const stock = await api("/api/stock/", { query: { part: report.ids.part, limit: 100 } });
    assert.equal(stock.count, 2);
    const rejected = await stage("wrong-source-merge", [{ key: "receipt", action: "receive_stock", arguments: {
      part_id: report.ids.part, quantity: 1, location_id: report.ids.location, merge: "stock_item", stock_item_id: report.ids.receipt,
    } }], { allowError: true });
    assert.equal(rejected.isError, true);
  });
  await check("Image upload, staged multipart commit, and authenticated media download", async () => {
    const upload = (await tool("prepare_part_image_upload", { filename: "test-capacitor.png" })).structuredContent.data;
    const uploadUrl = upload.upload_url ?? upload.url;
    assert.equal(typeof uploadUrl, "string");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const uploaded = await http(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png", "X-File-Name": "test-capacitor.png" }, body: image });
    assert.ok(uploaded.ok);
    await commit(await stage("image", [{ key: "image", action: "set_part_image", arguments: { part_id: report.ids.part, upload_ref: upload.upload_ref } }]));
    const preview = await tool("get_part_image", { part_id: report.ids.part, variant: "thumbnail" });
    assert.ok(preview.content.some((item) => item.type === "image"));
  });
  let legacyStocks;
  await check("Migrate an existing MPN-named resistor and both original stock lots", async () => {
    const legacy = await stage("legacy-resistor-fixture", [
      { key: "category", action: "create_part_category", arguments: { name: `${prefix} Resistors` } },
      { key: "resistance", action: "create_parameter_template", arguments: { name: `${prefix} Resistance`, units: "ohm" } },
      { key: "tolerance", action: "create_parameter_template", arguments: { name: `${prefix} Tolerance`, units: "%" } },
      { key: "power", action: "create_parameter_template", arguments: { name: `${prefix} Power`, units: "W" } },
      { key: "part", action: "create_part_with_stock", arguments: { part: {
        name: "RC0603FR-0710KL", IPN: `${prefix}-R`, category_id: ref("category", "part_category"),
        description: "Existing resistor entry", notes: "Original part notes",
      }, initial_stock: { quantity: 300, location_id: report.ids.location, batch: "legacy-lot", packaging: "tape", notes: "Original stock notes" }, allow_possible_duplicates: true } },
      { key: "reserve", action: "receive_stock", arguments: { part_id: ref("part", "part"), location_id: report.ids.location, quantity: 50, batch: "reserve-lot", packaging: "bag", merge: "new_item" } },
    ]);
    const created = await commit(legacy);
    for (const [key, step, output] of [["resistor", "part", "part"], ["resistorStock", "part", "stock_item"], ["resistorReserve", "reserve", "stock_item"],
      ["resistance", "resistance", "parameter_template"], ["tolerance", "tolerance", "parameter_template"], ["power", "power", "parameter_template"]]) {
      report.ids[key] = resolved(legacy, created, step, output);
    }
    legacyStocks = await api("/api/stock/", { query: { part: report.ids.resistor, limit: 100 } });
    assert.equal(legacyStocks.count, 2);
    const migration = await stage("migrate-existing-resistor", [
      { key: "rename", action: "update_part", arguments: { part_id: report.ids.resistor, changes: { name: "10kΩ ±1% 0603 75V 100mW" } } },
      { key: "mpn", action: "create_manufacturer_part", arguments: { part_id: report.ids.resistor, manufacturer_id: report.ids.maker, MPN: "RC0603FR-0710KL" } },
      { key: "sku", action: "create_supplier_part", arguments: { part_id: report.ids.resistor, supplier_id: report.ids.supplier,
        manufacturer_part_id: ref("mpn", "manufacturer_part"), SKU: "TEST-RESISTOR-SKU" } },
      { key: "specs", action: "set_part_parameters", arguments: { part_id: report.ids.resistor, parameters: [
        { template_id: report.ids.resistance, data: "10kohm" }, { template_id: report.ids.tolerance, data: "1%" },
        { template_id: report.ids.package, data: "0603" }, { template_id: report.ids.voltage, data: "75V" }, { template_id: report.ids.power, data: "100mW" },
      ] } },
      { key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: { supplier_part_id: ref("sku", "supplier_part") } } },
      { key: "reserve", action: "update_stock", arguments: { stock_item_id: report.ids.resistorReserve, changes: { supplier_part_id: ref("sku", "supplier_part") } } },
    ]);
    assert.equal((await api(`/api/part/${report.ids.resistor}/`)).name, "RC0603FR-0710KL");
    assert.equal((await api(`/api/stock/${report.ids.resistorStock}/`)).supplier_part, null);
    const done = await commit(migration);
    report.ids.resistorMpn = resolved(migration, done, "mpn", "manufacturer_part");
    report.ids.resistorSku = resolved(migration, done, "sku", "supplier_part");
    await commit(migration);
    const canonical = await api(`/api/part/${report.ids.resistor}/`);
    assert.equal(canonical.name, "10kΩ ±1% 0603 75V 100mW");
    assert.equal(canonical.IPN, `${prefix}-R`); assert.equal(canonical.notes, "Original part notes");
    const sourcing = (await tool("get_part_sourcing", { part_id: report.ids.resistor })).structuredContent.data;
    assert.equal(sourcing.manufacturerParts.count, 1); assert.equal(sourcing.manufacturerParts.results[0].mpn, "RC0603FR-0710KL");
    assert.equal(sourcing.supplierParts.count, 1); assert.equal(sourcing.supplierParts.results[0].manufacturerPartId, report.ids.resistorMpn);
    const stocks = await api("/api/stock/", { query: { part: report.ids.resistor, limit: 100 } });
    assert.equal(stocks.count, 2);
    for (const stock of stocks.results) {
      const original = legacyStocks.results.find((item) => item.pk === stock.pk);
      assert.ok(original, "Migration created or replaced a stock item");
      for (const field of ["part", "quantity", "location", "batch", "packaging", "notes", "expiry_date", "status", "serial", "purchase_order"]) {
        assert.equal(stock[field], original[field], `Migration changed stock ${stock.pk} ${field}`);
      }
      assert.equal(stock.supplier_part, report.ids.resistorSku);
    }
    const parameters = results(await tool("get_part_parameters", { part_id: report.ids.resistor }));
    assert.equal(parameters.length, 5);
    assert.equal(parameters.find((item) => item.templateId === report.ids.resistance).value, "10kohm");
    assert.equal(parameters.find((item) => item.templateId === report.ids.power).value, "100mW");
  });
  await check("Edit stock metadata, clear and restore supplier provenance, and skip identical edits", async () => {
    const changed = { supplier_part_id: null, batch: "verified-lot", packaging: "cut tape", expiry_date: "2099-12-31", notes: "Verified existing lot", link: "https://example.test/stock" };
    await commit(await stage("stock-metadata", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: changed } }]));
    const stock = await api(`/api/stock/${report.ids.resistorStock}/`);
    assert.equal(stock.supplier_part, null); assert.equal(stock.batch, changed.batch);
    assert.equal(stock.expiry_date, changed.expiry_date); assert.equal(stock.notes, changed.notes);
    assert.equal(Number(stock.quantity), 300); assert.equal(stock.location, report.ids.location);
    const same = await stage("stock-already-current", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: changed } }]);
    assert.equal(same.structuredContent.data.status, "already_current");
    const samePart = await stage("part-already-current", [{ key: "part", action: "update_part", arguments: { part_id: report.ids.resistor, changes: { name: "10kΩ ±1% 0603 75V 100mW" } } }]);
    assert.equal(samePart.structuredContent.data.status, "already_current");
    const original = legacyStocks.results.find((item) => item.pk === report.ids.resistorStock);
    await commit(await stage("restore-stock-metadata", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: {
      supplier_part_id: report.ids.resistorSku, batch: original.batch, packaging: original.packaging, expiry_date: original.expiry_date, notes: original.notes, link: original.link,
    } } }]));
  });
  await check("Stock editing rejects cross-part sources and stale migrations without renaming", async () => {
    const invalid = await stage("cross-part-stock", [{ key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: { supplier_part_id: report.ids.sku } } }], { allowError: true });
    assert.equal(invalid.isError, true);
    const stale = await stage("stale-stock-migration", [
      { key: "rename", action: "update_part", arguments: { part_id: report.ids.resistor, changes: { name: "Must never be written" } } },
      { key: "stock", action: "update_stock", arguments: { stock_item_id: report.ids.resistorStock, changes: { notes: "Must never be written" } } },
    ]);
    const original = await api(`/api/stock/${report.ids.resistorStock}/`);
    await api(`/api/stock/${report.ids.resistorStock}/`, { method: "PATCH", body: { notes: "Changed externally" } });
    const data = stale.structuredContent.data;
    const refused = await tool("commit_inventory_plan", { plan_id: data.plan_id, expected_version: data.plan_version }, { allowError: true });
    assert.equal(refused.isError, true); assert.equal(refused.structuredContent.data.conflict_type, "stale_inventory");
    assert.equal((await api(`/api/part/${report.ids.resistor}/`)).name, "10kΩ ±1% 0603 75V 100mW");
    assert.equal((await api(`/api/stock/${report.ids.resistorStock}/`)).notes, "Changed externally");
    await api(`/api/stock/${report.ids.resistorStock}/`, { method: "PATCH", body: { notes: original.notes } });
  });
  await check("Update stock accepts initial-stock and receipt references in the same plan", async () => {
    const staged = await stage("future-stock-edits", [
      { key: "part", action: "create_part_with_stock", arguments: { part: { name: `${prefix} Future stock edit`, category_id: report.ids.category }, initial_stock: { quantity: 2, location_id: report.ids.location } } },
      { key: "sku", action: "create_supplier_part", arguments: { part_id: ref("part", "part"), supplier_id: report.ids.supplier, SKU: "TEST-FUTURE-SKU" } },
      { key: "edit_initial", action: "update_stock", arguments: { stock_item_id: ref("part", "stock_item"), changes: { supplier_part_id: ref("sku", "supplier_part"), notes: "Edited initial stock" } } },
      { key: "receive", action: "receive_stock", arguments: { part_id: ref("part", "part"), quantity: 3, location_id: report.ids.location, merge: "new_item" } },
      { key: "edit_receipt", action: "update_stock", arguments: { stock_item_id: ref("receive", "stock_item"), changes: { supplier_part_id: ref("sku", "supplier_part"), notes: "Edited receipt" } } },
    ]);
    const committed = await commit(staged);
    const sku = resolved(staged, committed, "sku", "supplier_part");
    for (const [step, quantity, notes] of [["part", 2, "Edited initial stock"], ["receive", 3, "Edited receipt"]]) {
      const stock = await api(`/api/stock/${resolved(staged, committed, step, "stock_item")}/`);
      assert.equal(Number(stock.quantity), quantity); assert.equal(stock.notes, notes); assert.equal(stock.supplier_part, sku);
    }
  });
  let purchase, purchaseCommit;
  const poReference = `PO-${Date.now()}`;
  await check("Stage, edit, and commit a draft PO with two separate supplier-pack lines", async () => {
    purchase = await stage("purchase-create", [
      { key: "source", action: "create_supplier_part", arguments: { part_id: report.ids.part, supplier_id: report.ids.supplier,
        manufacturer_part_id: report.ids.mpn, SKU: `${prefix} Pack100`, pack_quantity: "100" } },
      { key: "order", action: "create_purchase_order", arguments: { reference: poReference, supplier_id: report.ids.supplier,
        destination_id: report.ids.location, order_currency: "USD", description: `${prefix} capacitor order`, notes: "keep order notes" } },
      { key: "line", action: "create_purchase_order_line", arguments: { order_id: ref("order", "purchase_order"), supplier_part_id: ref("source", "supplier_part"),
        quantity: 3, purchase_price: "12.500000", purchase_price_currency: "USD", notes: "keep line notes" } },
      { key: "quantity", action: "update_purchase_order_line", arguments: { line_item_id: ref("line", "purchase_order_line"), changes: { quantity: 4 } } },
      { key: "line2", action: "create_purchase_order_line", arguments: { order_id: ref("order", "purchase_order"), supplier_part_id: ref("source", "supplier_part"),
        quantity: 1, purchase_price: "12.500000", purchase_price_currency: "USD", notes: "separate delivery line" } },
      { key: "meta", action: "update_purchase_order", arguments: { order_id: ref("order", "purchase_order"), changes: { supplier_reference: `${prefix} Supplier order` } } },
    ]);
    assert.equal((await api(`/api/order/po/?limit=100&search=${encodeURIComponent(poReference)}`)).count, 0, "Staging created the purchase order");
    purchaseCommit = await commit(purchase);
    report.ids.purchaseOrder = resolved(purchase, purchaseCommit, "order", "purchase_order");
    report.ids.purchaseLine = resolved(purchase, purchaseCommit, "line", "purchase_order_line");
    report.ids.purchaseLine2 = resolved(purchase, purchaseCommit, "line2", "purchase_order_line");
    report.ids.purchaseSku = resolved(purchase, purchaseCommit, "source", "supplier_part");
    assert.notEqual(report.ids.purchaseLine, report.ids.purchaseLine2, "New purchase lines merged silently");
    const found = results(await tool("list_purchase_orders", { supplier_id: report.ids.supplier, part_id: report.ids.part }));
    assert.ok(found.some((item) => item.id === report.ids.purchaseOrder));
    const detail = (await tool("get_purchase_order", { order_id: report.ids.purchaseOrder, include_notes: true })).structuredContent.data;
    assert.equal(detail.order.status, 10); assert.equal(detail.lines.count, 2);
    assert.equal(detail.order.notes, "keep order notes");
    const line = detail.lines.results.find((item) => item.id === report.ids.purchaseLine);
    assert.equal(line.quantity, 4); assert.equal(line.notes, "keep line notes");
    assert.equal(Number(line.purchasePrice), 12.5); assert.equal(line.currency, "USD");
    assert.equal(line.supplierPartId, report.ids.purchaseSku); assert.equal(line.part.id, report.ids.part);
    assert.equal(line.packQuantityNative, 100);
    const unchanged = await stage("po-current-metadata", [{ key: "meta", action: "update_purchase_order", arguments: { order_id: report.ids.purchaseOrder, changes: { notes: "keep order notes" } } }]);
    assert.equal(unchanged.structuredContent.data.status, "already_current");
    const samePrice = await stage("po-current-price", [{ key: "price", action: "update_purchase_order_line", arguments: {
      line_item_id: report.ids.purchaseLine, changes: { purchase_price: "12.500000" },
    } }]);
    assert.equal(samePrice.structuredContent.data.status, "already_current");
  });
  await check("Hold, issue, and partially receive PO lines with pack conversion and idempotent replay", async () => {
    const receipt = await stage("purchase-first-receipt", [
      { key: "hold", action: "hold_purchase_order", arguments: { order_id: report.ids.purchaseOrder } },
      { key: "issue", action: "issue_purchase_order", arguments: { order_id: report.ids.purchaseOrder } },
      { key: "receive", action: "receive_purchase_order", arguments: { order_id: report.ids.purchaseOrder, items: [
        { line_item_id: report.ids.purchaseLine, quantity: 2, batch: `${prefix} Delivery1`, packaging: "reel", notes: "receipt note", expiry_date: "2030-01-01" },
        { line_item_id: report.ids.purchaseLine2, quantity: 1 },
      ] } },
    ]);
    assert.match(receipt.content[0].text, /2 supplier packs.*200/);
    assert.equal((await api(`/api/order/po/${report.ids.purchaseOrder}/`)).status, 10, "Staging issued the order");
    assert.equal((await api(`/api/stock/?limit=100&purchase_order=${report.ids.purchaseOrder}`)).count, 0);
    await commit(receipt); await commit(receipt);
    const detail = (await tool("get_purchase_order", { order_id: report.ids.purchaseOrder, include_received_stock: true, limit: 1 })).structuredContent.data;
    assert.equal(detail.order.status, 20); assert.equal(detail.lines.count, 2); assert.ok(detail.lines.nextCursor);
    assert.equal(detail.lines.results[0].received, 2); assert.equal(detail.lines.results[0].outstanding, 2);
    assert.equal(detail.receivedStock.count, 2); assert.ok(detail.receivedStock.nextCursor);
    assert.ok([100, 200].includes(detail.receivedStock.results[0].quantity)); assert.equal(detail.receivedStock.results[0].supplierPartId, report.ids.purchaseSku);
    assert.equal(detail.receivedStock.results[0].part.id, report.ids.part);
    assert.equal(Number(detail.receivedStock.results[0].purchasePrice), 0.125);
    const next = (await tool("get_purchase_order", { order_id: report.ids.purchaseOrder, include_received_stock: true,
      limit: 1, cursor: detail.lines.nextCursor, stock_cursor: detail.receivedStock.nextCursor })).structuredContent.data;
    assert.equal(next.lines.results[0].received, 1);
    assert.deepEqual([detail.receivedStock.results[0].quantity, next.receivedStock.results[0].quantity].sort((a,b) => a-b), [100,200]);
    const stored = (await api(`/api/stock/?limit=100&purchase_order=${report.ids.purchaseOrder}`)).results.find((item) => Number(item.quantity) === 200);
    assert.equal(stored.notes, "receipt note"); assert.equal(stored.expiry_date, "2030-01-01"); assert.equal(stored.packaging, "reel");
  });
  await check("Final PO delivery reconciles 500 canonical units and automatically completes the order", async () => {
    await stageAndCommit("purchase-final-receipt", [
      { key: "price", action: "update_purchase_order_line", arguments: { line_item_id: report.ids.purchaseLine, changes: { purchase_price: "13.750000" } } },
      { key: "receive", action: "receive_purchase_order", arguments: {
      order_id: report.ids.purchaseOrder, items: [{ line_item_id: report.ids.purchaseLine, quantity: 2 }],
    } }]);
    const detail = (await tool("get_purchase_order", { order_id: report.ids.purchaseOrder, include_received_stock: true })).structuredContent.data;
    assert.equal(detail.order.status, 30);
    assert.equal(detail.receivedStock.count, 3);
    assert.equal(detail.receivedStock.results.reduce((sum, item) => sum + item.quantity, 0), 500);
    assert.deepEqual(detail.receivedStock.results.map((item) => Number(item.purchasePrice)).sort((a,b) => a-b), [0.125,0.125,0.1375]);
    assert.ok(detail.lines.results.every((item) => item.outstanding === 0));
    const current = await stage("purchase-complete-current", [{ key: "complete", action: "complete_purchase_order", arguments: { order_id: report.ids.purchaseOrder } }]);
    assert.equal(current.structuredContent.data.status, "already_current");
  });
  let partialOrder, partialLine;
  await check("PO validation rejects wrong suppliers, invalid transitions, excess receipts, and stale lines", async () => {
    const [setup, done] = await stageAndCommit("purchase-partial-close-setup", [
      { key: "manufacturerOnly", action: "create_company", arguments: { name: `${prefix} Manufacturer only`, is_manufacturer: true } },
      { key: "otherSource", action: "create_supplier_part", arguments: { part_id: report.ids.part, supplier_id: report.ids.maker, SKU: `${prefix} Other supplier` } },
      { key: "order", action: "create_purchase_order", arguments: { reference: `PO-${Date.now()}`, supplier_id: report.ids.supplier, destination_id: report.ids.location } },
      { key: "line", action: "create_purchase_order_line", arguments: { order_id: ref("order", "purchase_order"), supplier_part_id: report.ids.purchaseSku, quantity: 2 } },
      { key: "issue", action: "issue_purchase_order", arguments: { order_id: ref("order", "purchase_order") } },
    ]);
    report.ids.manufacturerOnly = resolved(setup, done, "manufacturerOnly", "company");
    report.ids.otherSku = resolved(setup, done, "otherSource", "supplier_part");
    partialOrder = resolved(setup, done, "order", "purchase_order"); partialLine = resolved(setup, done, "line", "purchase_order_line");
    report.ids.partialPurchaseOrder = partialOrder; report.ids.partialPurchaseLine = partialLine;
    for (const [label, action, arguments_, pattern] of [
      ["wrong-role", "create_purchase_order", { reference: `PO-invalid-${Date.now()}`, supplier_id: report.ids.manufacturerOnly }, /active supplier/],
      ["wrong-supplier", "create_purchase_order_line", { order_id: partialOrder, supplier_part_id: report.ids.otherSku, quantity: 1 }, /order's supplier/],
      ["over-receipt", "receive_purchase_order", { order_id: partialOrder, items: [{ line_item_id: partialLine, quantity: 3 }] }, /remaining/],
      ["wrong-line", "receive_purchase_order", { order_id: partialOrder, items: [{ line_item_id: report.ids.purchaseLine, quantity: 1 }] }, /does not belong/],
      ["incomplete", "complete_purchase_order", { order_id: partialOrder }, /unreceived/],
      ["terminal-edit", "update_purchase_order", { order_id: report.ids.purchaseOrder, changes: { description: "must not apply" } }, /terminal/],
    ]) {
      const rejected = await stage(`purchase-invalid-${label}`, [{ key: "invalid", action, arguments: arguments_ }], { allowError: true });
      assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, pattern);
    }
    const stale = await stage("purchase-stale-line", [
      { key: "edit", action: "update_purchase_order", arguments: { order_id: partialOrder, changes: { supplier_reference: "must not apply" } } },
      { key: "receive", action: "receive_purchase_order", arguments: { order_id: partialOrder, items: [{ line_item_id: partialLine, quantity: 1 }] } },
    ]);
    await api(`/api/order/po-line/${partialLine}/`, { method: "PATCH", body: { quantity: 3, order: partialOrder, part: report.ids.purchaseSku } });
    const failed = await tool("commit_inventory_plan", { plan_id: stale.structuredContent.data.plan_id, expected_version: stale.structuredContent.data.plan_version }, { allowError: true });
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent.data.conflict_type, "stale_inventory");
    assert.equal((await api(`/api/order/po/${partialOrder}/`)).supplier_reference, "");
    assert.equal((await api(`/api/stock/?limit=100&purchase_order=${partialOrder}`)).count, 0);
  });
  await check("Explicit incomplete completion and draft cancellation preserve stock and receipt counts", async () => {
    const closed = await stage("purchase-close-incomplete", [{ key: "complete", action: "complete_purchase_order", arguments: { order_id: partialOrder, accept_incomplete: true } }]);
    await commit(closed);
    assert.equal((await api(`/api/order/po/${partialOrder}/`)).status, 30);
    assert.equal(Number((await api(`/api/order/po-line/${partialLine}/`)).received), 0);
    assert.equal((await api(`/api/stock/?limit=100&purchase_order=${partialOrder}`)).count, 0);
    const cancelled = await stage("purchase-cancel-draft", [
      { key: "order", action: "create_purchase_order", arguments: { reference: `PO-${Date.now()}`, supplier_id: report.ids.supplier } },
      { key: "cancel", action: "cancel_purchase_order", arguments: { order_id: ref("order", "purchase_order") } },
    ]);
    const done = await commit(cancelled);
    const id = resolved(cancelled, done, "order", "purchase_order"); report.ids.cancelledPurchaseOrder = id;
    assert.equal((await api(`/api/order/po/${id}/`)).status, 40);
  });
  await check("Fractional supplier-pack deliveries reconcile without false excess rejection", async () => {
    const [staged, done] = await stageAndCommit("purchase-fractional-first", [
      { key: "order", action: "create_purchase_order", arguments: { reference: `PO-${Date.now()}`, supplier_id: report.ids.supplier, destination_id: report.ids.location } },
      { key: "line", action: "create_purchase_order_line", arguments: { order_id: ref("order", "purchase_order"), supplier_part_id: report.ids.purchaseSku, quantity: 0.3 } },
      { key: "issue", action: "issue_purchase_order", arguments: { order_id: ref("order", "purchase_order") } },
      { key: "receive", action: "receive_purchase_order", arguments: { order_id: ref("order", "purchase_order"), items: [{ line_item_id: ref("line", "purchase_order_line"), quantity: 0.1 }] } },
    ]);
    const orderId = resolved(staged, done, "order", "purchase_order");
    const lineId = resolved(staged, done, "line", "purchase_order_line");
    report.ids.fractionalPurchaseOrder = orderId;
    await stageAndCommit("purchase-fractional-last", [{ key: "receive", action: "receive_purchase_order", arguments: { order_id: orderId, items: [{ line_item_id: lineId, quantity: 0.2 }] } }]);
    const detail = (await tool("get_purchase_order", { order_id: orderId, include_received_stock: true })).structuredContent.data;
    assert.equal(detail.order.status, 30); assert.equal(detail.lines.results[0].received, 0.3);
    assert.equal(detail.receivedStock.results.reduce((sum, item) => sum + item.quantity, 0), 30);
  });
  await check("Serialized PO receipt creates two individual sourced stock items", async () => {
    const staged = await stage("purchase-serialized", [
      { key: "part", action: "create_part_with_stock", arguments: { part: { name: `${prefix} Serialized component`, category_id: report.ids.category, trackable: true } } },
      { key: "source", action: "create_supplier_part", arguments: { part_id: ref("part", "part"), supplier_id: report.ids.supplier, SKU: `${prefix} Serialized SKU` } },
      { key: "order", action: "create_purchase_order", arguments: { reference: `PO-${Date.now()}`, supplier_id: report.ids.supplier, destination_id: report.ids.location } },
      { key: "line", action: "create_purchase_order_line", arguments: { order_id: ref("order", "purchase_order"), supplier_part_id: ref("source", "supplier_part"), quantity: 2 } },
      { key: "issue", action: "issue_purchase_order", arguments: { order_id: ref("order", "purchase_order") } },
      { key: "receive", action: "receive_purchase_order", arguments: { order_id: ref("order", "purchase_order"), items: [
        { line_item_id: ref("line", "purchase_order_line"), quantity: 2, serial_numbers: "70001,70002", status: "quarantined" },
      ] } },
    ]);
    const done = await commit(staged);
    const orderId = resolved(staged, done, "order", "purchase_order");
    report.ids.serializedPurchaseOrder = orderId;
    const detail = (await tool("get_purchase_order", { order_id: orderId, include_received_stock: true })).structuredContent.data;
    assert.equal(detail.order.status, 30); assert.equal(detail.receivedStock.count, 2);
    assert.deepEqual(detail.receivedStock.results.map((item) => item.serial).sort(), ["70001", "70002"]);
    assert.ok(detail.receivedStock.results.every((item) => item.quantity === 1 && item.status === "Quarantined"));
    assert.ok(detail.receivedStock.results.every((item) => item.supplierPartId === resolved(staged, done, "source", "supplier_part")));
  });
  await check("Build order lookup reads real BOM component requirements", async () => {
    const assembly = await stage("assembly", [{ key: "assembly", action: "create_part_with_stock", arguments: {
      part: { name: `${prefix} Assembly`, category_id: report.ids.category, assembly: true, purchaseable: false },
    } }]);
    const done = await commit(assembly);
    const assemblyId = resolved(assembly, done, "assembly", "part"); report.ids.assembly = assemblyId;
    await api("/api/bom/", { method: "POST", body: { part: assemblyId, sub_part: report.ids.part, quantity: 2 } });
    const build = await api("/api/build/", { method: "POST", body: { reference: `BO-${Date.now()}`, part: assemblyId, quantity: 3, title: `${prefix} assembly build` } });
    report.ids.buildOrder = build.pk;
    const found = results(await tool("list_build_orders", { part_id: assemblyId }));
    assert.ok(found.some((item) => item.id === build.pk));
    const detail = (await tool("get_build_order", { order_id: build.pk })).structuredContent.data;
    assert.equal(detail.order.quantity, 3);
    assert.ok(detail.lines.results.some((item) => item.part.id === report.ids.part && item.quantity === 6));
  });
  await check("OAuth refresh rotation retains real upstream access", async () => {
    const refresh = await http(`${bridge}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oauth.refresh_token, client_id: oauth.client_id, resource: oauth.resource }) });
    assert.equal(refresh.status, 200);
    const fresh = await refresh.json();
    accessToken = fresh.access_token;
    assert.equal((await tool("get_part_inventory", { part_id: report.ids.part })).structuredContent.data.id, report.ids.part);
    const replay = await http(`${bridge}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oauth.refresh_token, client_id: oauth.client_id, resource: oauth.resource }) });
    assert.equal(replay.status, 400);
  });
  report.finishedAt = new Date().toISOString(); report.status = "passed";
  saveReport();
  console.log(`${report.checks.length} real-server checks passed. Report: .e2e/report.json`);
} catch (error) {
  report.finishedAt = new Date().toISOString(); report.status = "failed";
  saveReport();
  console.error(error.message);
  process.exitCode = 1;
}
