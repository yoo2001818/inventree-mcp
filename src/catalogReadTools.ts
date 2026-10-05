import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { catalogPaths, normalizeCompany, normalizeManufacturerPart, normalizeParameter,
  normalizeParameterTemplate, normalizeSupplierPart } from "./catalogDomain.js";
import { notFound } from "./domainErrors.js";
import { decodeCursor, formatRef, numberValue, page, pageResults, record, type JsonRecord, type Page } from "./inventoryDomain.js";
import { InvenTreeClient, InvenTreeError } from "./inventree.js";
import { clientFor, READ_SECURITY, result, safely } from "./mcpSupport.js";
import type { OAuthService } from "./oauth.js";

const id = () => z.number().int().positive();
const paging = { limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional().describe("Opaque cursor returned by this tool") };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export async function requiredCatalogRecord(client: InvenTreeClient, path: string, kind: string, id: number, tool: string,
  query?: Record<string, unknown>) {
  try { return record(await client.get(`${path}${id}/`, query)); }
  catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound(kind, { supplied_id: id }, tool, `${kind} #${id} was not found. Use ${tool}.`);
    }
    throw error;
  }
}

function formatPage<T>(title: string, data: Page<T>, line: (value: T) => string) {
  return [`${title}: ${data.results.length ? `${data.offset + 1}-${data.offset + data.results.length} of ${data.count}` : "no results"}`,
    ...data.results.map((value) => `- ${line(value)}`),
    ...(data.nextCursor ? [`Next cursor: ${data.nextCursor}`] : [])].join("\n");
}
const manufacturerLine = (item: ReturnType<typeof normalizeManufacturerPart>) =>
  `${item.mpn} [manufacturer part #${item.id}] — ${formatRef(item.manufacturer)}; canonical part: ${formatRef(item.part)}${item.link ? `; ${item.link}` : ""}`;
const supplierLine = (item: ReturnType<typeof normalizeSupplierPart>) =>
  `${item.sku} [supplier part #${item.id}] — ${formatRef(item.supplier)}; canonical part: ${formatRef(item.part)}${item.mpn ? `; MPN ${item.mpn}${item.manufacturerPartId ? ` [manufacturer part #${item.manufacturerPartId}]` : ""}` : ""}${item.packaging ? `; ${item.packaging}` : ""}${item.packQuantity ? `; pack ${item.packQuantity}` : ""}${item.active === false ? "; inactive" : ""}${item.link ? `; ${item.link}` : ""}`;

export async function partParameters(client: InvenTreeClient, partId: number, limit: number, offset = 0) {
  const source = await client.get("/api/parameter/", { model_type: "part", model_id: partId,
    template_detail: true, limit, offset, ordering: "template" });
  return page(source, pageResults(source).map(normalizeParameter), offset);
}

export function registerCatalogReadTools(server: McpServer, oauth: OAuthService) {
  server.registerTool("list_companies", {
    title: "Find suppliers and manufacturers", description: "Find InvenTree companies by name and role. A company may be both supplier and manufacturer; IDs are shared by both roles.",
    inputSchema: { query: z.string().optional(), role: z.enum(["any", "supplier", "manufacturer"]).default("any"),
      active: z.boolean().optional(), ...paging }, annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    const offset = decodeCursor(input.cursor);
    const source = await client.get(catalogPaths.company, { search: input.query, active: input.active,
      is_supplier: input.role === "supplier" ? true : undefined,
      is_manufacturer: input.role === "manufacturer" ? true : undefined, limit: input.limit, offset, ordering: "name" });
    const data = page(source, pageResults(source).map(normalizeCompany), offset);
    return result(data, formatPage("Companies", data, (item) => `${item.name} (#${item.id}) [${[item.isSupplier ? "supplier" : "", item.isManufacturer ? "manufacturer" : "", item.active === false ? "inactive" : ""].filter(Boolean).join(", ")}]${item.website ? ` — ${item.website}` : ""}`));
  }));

  server.registerTool("find_manufacturer_parts", {
    title: "Find manufacturer part numbers", description: "Find MPNs and their canonical parts. Use these IDs for manufacturer_part_id; they are distinct from canonical part IDs.",
    inputSchema: { query: z.string().optional(), part_id: id().optional(), manufacturer_id: id().optional(),
      MPN: z.string().optional().describe("Exact manufacturer part number"), ...paging }, annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    const offset = decodeCursor(input.cursor);
    const source = await client.get(catalogPaths.manufacturer_part, { search: input.query, part: input.part_id,
      manufacturer: input.manufacturer_id, MPN: input.MPN, part_detail: true, manufacturer_detail: true,
      limit: input.limit, offset, ordering: "MPN" });
    const data = page(source, pageResults(source).map(normalizeManufacturerPart), offset);
    return result(data, formatPage("Manufacturer parts", data, manufacturerLine));
  }));

  server.registerTool("find_supplier_parts", {
    title: "Find supplier SKUs", description: "Find supplier SKUs and their canonical parts and MPNs. Supplier-part IDs are distinct from canonical part and manufacturer-part IDs.",
    inputSchema: { query: z.string().optional(), part_id: id().optional(), supplier_id: id().optional(),
      manufacturer_part_id: id().optional(), manufacturer_id: id().optional(), SKU: z.string().optional().describe("Exact supplier SKU"), active: z.boolean().optional(), ...paging },
    annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    const offset = decodeCursor(input.cursor);
    const source = await client.get(catalogPaths.supplier_part, { search: input.query, part: input.part_id,
      supplier: input.supplier_id, manufacturer_part: input.manufacturer_part_id, manufacturer: input.manufacturer_id, SKU: input.SKU, active: input.active,
      part_detail: true, supplier_detail: true, manufacturer_detail: true, manufacturer_part_detail: true,
      limit: input.limit, offset, ordering: "SKU" });
    const data = page(source, pageResults(source).map(normalizeSupplierPart), offset);
    return result(data, formatPage("Supplier parts", data, supplierLine));
  }));

  server.registerTool("get_part_sourcing", {
    title: "Get a canonical part's sourcing", description: "Show manufacturer MPNs and supplier SKUs for one canonical part. Each collection has its own cursor so neither is silently truncated.",
    inputSchema: { part_id: id(), limit: paging.limit, manufacturer_cursor: paging.cursor, supplier_cursor: paging.cursor },
    annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    const part = await requiredCatalogRecord(client, catalogPaths.part, "part", input.part_id, "find_parts");
    const manufacturerOffset = decodeCursor(input.manufacturer_cursor), supplierOffset = decodeCursor(input.supplier_cursor);
    const [manufacturers, suppliers] = await Promise.all([
      client.get(catalogPaths.manufacturer_part, { part: input.part_id, part_detail: true, manufacturer_detail: true,
        limit: input.limit, offset: manufacturerOffset, ordering: "MPN" }),
      client.get(catalogPaths.supplier_part, { part: input.part_id, part_detail: true, supplier_detail: true,
        manufacturer_detail: true, manufacturer_part_detail: true, limit: input.limit, offset: supplierOffset, ordering: "SKU" }),
    ]);
    const data = { part: { id: input.part_id, name: String(part.name) },
      manufacturerParts: page(manufacturers, pageResults(manufacturers).map(normalizeManufacturerPart), manufacturerOffset),
      supplierParts: page(suppliers, pageResults(suppliers).map(normalizeSupplierPart), supplierOffset) };
    return result(data, [`${formatRef(data.part)}`, formatPage("Manufacturer parts", data.manufacturerParts, manufacturerLine),
      formatPage("Supplier parts", data.supplierParts, supplierLine)].join("\n\n"));
  }));

  server.registerTool("list_parameter_templates", {
    title: "Find part parameter templates", description: "Resolve templates for part specifications such as capacitance, voltage, dielectric, and package. Includes global templates and templates scoped to parts.",
    inputSchema: { query: z.string().optional(), enabled: z.boolean().optional(), ...paging },
    annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    const offset = decodeCursor(input.cursor);
    const source = await client.get(catalogPaths.parameter_template, { search: input.query, for_model: "part",
      enabled: input.enabled, limit: input.limit, offset, ordering: "name" });
    const data = page(source, pageResults(source).map(normalizeParameterTemplate), offset);
    return result(data, formatPage("Parameter templates", data, (item) => `${item.name} (#${item.id})${item.units ? ` [${item.units}]` : ""}${item.choices ? `; choices: ${item.choices}` : ""}${item.enabled === false ? "; disabled" : ""}`));
  }));

  server.registerTool("get_part_parameters", {
    title: "Get part specifications", description: "Read structured canonical part parameters with template IDs, values, units, and notes.",
    inputSchema: { part_id: id(), ...paging }, annotations, _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
    await requiredCatalogRecord(client, catalogPaths.part, "part", input.part_id, "find_parts");
    const data = await partParameters(client, input.part_id, input.limit, decodeCursor(input.cursor));
    return result(data, formatPage(`Parameters for part #${input.part_id}`, data,
      (item) => `${item.name} (template #${item.templateId}): ${item.value || "—"}${item.units ? ` [${item.units}]` : ""}${item.note ? `; ${item.note}` : ""}`));
  }));
}
