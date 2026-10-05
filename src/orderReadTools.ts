import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requiredCatalogRecord } from "./catalogReadTools.js";
import { decodeCursor, entityRef, formatRef, numberValue, optionalString, page, pageResults, record, type JsonRecord } from "./inventoryDomain.js";
import { clientFor, READ_SECURITY, result, safely } from "./mcpSupport.js";
import type { OAuthService } from "./oauth.js";

const paging = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().optional() };
const id = () => z.number().int().positive();
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function normalizeOrder(item: JsonRecord, kind: "purchase" | "build") {
  return { id: numberValue(item.pk), reference: String(item.reference ?? ""),
    description: optionalString(item.description ?? item.title), status: item.status, statusText: optionalString(item.status_text),
    supplier: kind === "purchase" ? entityRef(item.supplier_detail) ?? { id: numberValue(item.supplier), name: String(item.supplier_name ?? `Company ${item.supplier}`) } : undefined,
    part: kind === "build" ? entityRef(item.part_detail) ?? { id: numberValue(item.part), name: String(item.part_name ?? `Part ${item.part}`) } : undefined,
    quantity: kind === "build" ? numberValue(item.quantity) : undefined,
    completed: kind === "build" ? numberValue(item.completed) : undefined,
    targetDate: optionalString(item.target_date), supplierReference: optionalString(item.supplier_reference) };
}

export function registerOrderReadTools(server: McpServer, oauth: OAuthService) {
  for (const kind of ["purchase", "build"] as const) {
    const path = kind === "purchase" ? "/api/order/po/" : "/api/build/";
    server.registerTool(`list_${kind}_orders`, {
      title: `Find ${kind} orders`, description: `Read-only ${kind} order lookup with status and canonical part context. Order lifecycle mutations are not supported yet.`,
      inputSchema: { query: z.string().optional(), part_id: id().optional(),
        ...(kind === "purchase" ? { supplier_id: id().optional(), supplier_part_id: id().optional() } : {}),
        status: z.number().int().nonnegative().optional(), outstanding: z.boolean().optional(), ...paging },
      annotations, _meta: { securitySchemes: READ_SECURITY },
    }, async (input, extra) => safely(oauth, async () => {
      const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
      const offset = decodeCursor(input.cursor);
      const source = await client.get(path, { search: input.query, part: input.part_id,
        supplier: input.supplier_id, supplier_part: input.supplier_part_id, status: input.status,
        outstanding: input.outstanding, part_detail: true, supplier_detail: true, ordering: "reference", limit: input.limit, offset });
      const data = page(source, pageResults(source).map((item) => normalizeOrder(item, kind)), offset);
      return result(data, [`${kind === "purchase" ? "Purchase" : "Build"} orders: ${data.results.length} shown of ${data.count}`,
        ...data.results.map((item) => `- ${item.reference} (#${item.id}) — ${item.statusText ?? item.status}; ${formatRef(item.supplier ?? item.part)}${item.quantity !== undefined ? `; completed ${item.completed}/${item.quantity}` : ""}`),
        ...(data.nextCursor ? [`Next cursor: ${data.nextCursor}`] : [])].join("\n"));
    }));

    server.registerTool(`get_${kind}_order`, {
      title: `Inspect a ${kind} order`,
      description: `Read one ${kind} order and a page of ${kind === "purchase" ? "supplier-part line items with canonical part IDs" : "required component lines with allocated and consumed quantities"}. This tool does not receive stock, allocate components, or change order state.`,
      inputSchema: { order_id: id(), ...paging }, annotations, _meta: { securitySchemes: READ_SECURITY },
    }, async (input, extra) => safely(oauth, async () => {
      const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
      const order = normalizeOrder(await requiredCatalogRecord(client, path, `${kind}_order`, input.order_id,
        `list_${kind}_orders`, { supplier_detail: true, part_detail: true }), kind);
      const offset = decodeCursor(input.cursor);
      const source = await client.get(kind === "purchase" ? "/api/order/po-line/" : "/api/build/line/", {
        ...(kind === "purchase" ? { order: input.order_id } : { build: input.order_id }),
        part_detail: true, limit: input.limit, offset, ordering: "pk" });
      const lines = page(source, pageResults(source).map((item) => {
        const supplier = record(item.supplier_part_detail);
        return { id: numberValue(item.pk),
          part: entityRef(item.part_detail) ?? { id: numberValue(kind === "purchase" ? item.internal_part ?? supplier.part : item.part),
            name: String(item.internal_part_name ?? `Part ${kind === "purchase" ? item.internal_part ?? supplier.part : item.part}`) },
          supplierPartId: kind === "purchase" ? numberValue(item.part) : undefined,
          sku: kind === "purchase" ? optionalString(item.sku ?? supplier.SKU) : undefined,
          mpn: kind === "purchase" ? optionalString(item.mpn ?? supplier.MPN) : undefined,
          quantity: numberValue(item.quantity), received: kind === "purchase" ? numberValue(item.received) : undefined,
          allocated: kind === "build" ? numberValue(item.allocated) : undefined,
          consumed: kind === "build" ? numberValue(item.consumed) : undefined };
      }), offset);
      return result({ order, lines }, [`${order.reference} (#${order.id}) — ${order.statusText ?? order.status}`,
        `Lines: ${lines.results.length} shown of ${lines.count}`,
        ...lines.results.map((item) => `- ${formatRef(item.part)} [line #${item.id}${item.supplierPartId ? `; supplier part #${item.supplierPartId}` : ""}] — quantity ${item.quantity}${kind === "purchase" ? `; received ${item.received}${item.sku ? `; SKU ${item.sku}` : ""}${item.mpn ? `; MPN ${item.mpn}` : ""}` : `; allocated ${item.allocated}; consumed ${item.consumed}`}`),
        ...(lines.nextCursor ? [`Next cursor: ${lines.nextCursor}`] : [])].join("\n"));
    }));
  }
}
