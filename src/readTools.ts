import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  decodeCursor,
  displayPath,
  entityRef,
  formatLocationInventory,
  formatPartInventory,
  formatPartSearch,
  formatQuantity,
  formatRef,
  formatTree,
  normalizePart,
  normalizeStock,
  numberValue,
  optionalString,
  page,
  pageResults,
  record,
  records,
  stringValue,
  type EntityRef,
  type PartSummary,
} from "./inventoryDomain.js";
import type { OAuthService } from "./oauth.js";
import { clientFor, READ_SECURITY, result, safely } from "./mcpSupport.js";

const cursorSchema = z.string().optional().describe("Opaque cursor returned by a previous call");
const limitSchema = z.number().int().min(1).max(100).default(20);

async function stockForPart(client: ReturnType<typeof clientFor>["client"], partId: number, includeDepleted = false) {
  const data = await client.get("/api/stock/", {
    part: partId,
    in_stock: includeDepleted ? undefined : true,
    limit: 100,
    offset: 0,
    part_detail: false,
    location_detail: true,
    path_detail: true,
    ordering: "location",
  });
  return pageResults(data);
}

function resultPage<T>(source: unknown, values: T[], offset: number) {
  return page(source, values, offset);
}

export function registerReadTools(server: McpServer, oauth: OAuthService): void {
  server.registerTool(
    "browse_part_categories",
    {
      title: "Browse the part-category tree",
      description:
        "Browse or search part categories as a compact Markdown hierarchy. Use this to resolve category IDs before creating or moving parts.",
      inputSchema: {
        root_id: z.number().int().positive().optional().describe("Optional category whose descendants should be shown"),
        search: z.string().min(1).optional(),
        max_depth: z.number().int().min(0).max(12).default(6),
        include_counts: z.boolean().default(false),
        include_descriptions: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const path = input.include_counts ? "/api/part/category/" : "/api/part/category/tree/";
        const data = await client.get(path, {
          parent: input.root_id,
          cascade: input.root_id && input.include_counts ? true : undefined,
          search: input.search,
          max_level: input.include_counts ? undefined : input.max_depth,
          limit: 250,
          offset: 0,
          ordering: input.include_counts ? "pathstring" : "name",
        });
        const nodes = pageResults(data);
        const count = numberValue(record(data).count, nodes.length);
        let text = formatTree(nodes, {
          kind: "category",
          search: input.search,
          includeCounts: input.include_counts,
          includeDescriptions: input.include_descriptions,
        });
        if (count > nodes.length) {
          text += `\n\nTree truncated: showing ${nodes.length} of ${count} nodes. Call again with a root_id to expand one branch.`;
        }
        return result(
          {
            count,
            nodes: nodes.map((node) => ({
              id: numberValue(node.pk),
              name: stringValue(node.name),
              path: displayPath(stringValue(node.pathstring)),
              parentId: node.parent ?? null,
              structural: node.structural === true,
              ...(input.include_counts && node.part_count !== undefined ? { partCount: node.part_count } : {}),
            })),
          },
          text,
        );
      }),
  );

  server.registerTool(
    "browse_stock_locations",
    {
      title: "Browse the stock-location tree",
      description:
        "Browse or search physical stock locations as a compact Markdown hierarchy. Use this to resolve location IDs before stock operations.",
      inputSchema: {
        root_id: z.number().int().positive().optional().describe("Optional location whose descendants should be shown"),
        search: z.string().min(1).optional(),
        max_depth: z.number().int().min(0).max(12).default(6),
        include_item_counts: z.boolean().default(false),
        include_descriptions: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const path = input.include_item_counts ? "/api/stock/location/" : "/api/stock/location/tree/";
        const data = await client.get(path, {
          parent: input.root_id,
          cascade: input.root_id && input.include_item_counts ? true : undefined,
          search: input.search,
          max_level: input.include_item_counts ? undefined : input.max_depth,
          limit: 250,
          offset: 0,
          ordering: input.include_item_counts ? "pathstring" : "name",
        });
        const nodes = pageResults(data);
        const count = numberValue(record(data).count, nodes.length);
        let text = formatTree(nodes, {
          kind: "location",
          search: input.search,
          includeCounts: input.include_item_counts,
          includeDescriptions: input.include_descriptions,
        });
        if (count > nodes.length) {
          text += `\n\nTree truncated: showing ${nodes.length} of ${count} nodes. Call again with a root_id to expand one branch.`;
        }
        return result(
          {
            count,
            nodes: nodes.map((node) => ({
              id: numberValue(node.pk),
              name: stringValue(node.name),
              path: displayPath(stringValue(node.pathstring)),
              parentId: node.parent ?? null,
              structural: node.structural === true,
              ...(input.include_item_counts && node.items !== undefined ? { stockItemCount: node.items } : {}),
            })),
          },
          text,
        );
      }),
  );

  server.registerTool(
    "find_parts",
    {
      title: "Find parts and their stock",
      description:
        "Find parts by name, description, IPN, keywords, category, manufacturer, supplier SKU, or tags. Returns compact quantities and physical locations in the same call.",
      inputSchema: {
        query: z.string().min(1),
        category_id: z.number().int().positive().optional(),
        include_subcategories: z.boolean().default(true),
        stock: z.enum(["any", "in_stock", "depleted", "below_minimum"]).default("any"),
        active: z.boolean().default(true),
        limit: z.number().int().min(1).max(20).default(10),
        cursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const offset = decodeCursor(input.cursor);
        const data = await client.get("/api/part/", {
          search: input.query,
          category: input.category_id,
          cascade: input.category_id ? input.include_subcategories : undefined,
          active: input.active,
          has_stock: input.stock === "in_stock" ? true : undefined,
          depleted_stock: input.stock === "depleted" ? true : undefined,
          low_stock: input.stock === "below_minimum" ? true : undefined,
          category_detail: true,
          location_detail: true,
          limit: input.limit,
          offset,
          ordering: "name",
        });
        const parts = pageResults(data);
        const summaries = await Promise.all(
          parts.map(async (part) =>
            normalizePart(part, await stockForPart(client, numberValue(part.pk), input.stock === "depleted")),
          ),
        );
        const output = resultPage(data, summaries, offset);
        return result(output, formatPartSearch(output));
      }),
  );

  server.registerTool(
    "get_part_inventory",
    {
      title: "Get one part and all stock placements",
      description:
        "Get useful home-inventory details for one part, including exact stock-item IDs, quantities, and location paths.",
      inputSchema: {
        part_id: z.number().int().positive(),
        include: z.array(z.enum(["parameters", "notes"])).default([]),
        include_depleted: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const part = record(
          await client.get(`/api/part/${input.part_id}/`, {
            category_detail: true,
            location_detail: true,
            parameters: input.include.includes("parameters"),
          }),
        );
        const stock = await stockForPart(client, input.part_id, input.include_depleted);
        const summary = normalizePart(part, stock);
        return result(
          summary,
          formatPartInventory(
            summary,
            input.include.includes("notes") ? optionalString(part.notes) : undefined,
            input.include.includes("parameters") ? records(part.parameters) : undefined,
          ),
        );
      }),
  );

  server.registerTool(
    "inventory_at_location",
    {
      title: "List inventory at a physical location",
      description:
        "List compact part and stock-item details at one physical location, optionally including all sublocations.",
      inputSchema: {
        location_id: z.number().int().positive(),
        include_sublocations: z.boolean().default(true),
        include_depleted: z.boolean().default(false),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const offset = decodeCursor(input.cursor);
        const [locationData, stockData] = await Promise.all([
          client.get(`/api/stock/location/${input.location_id}/`, { path_detail: true }),
          client.get("/api/stock/", {
            location: input.location_id,
            cascade: input.include_sublocations,
            in_stock: input.include_depleted ? undefined : true,
            part_detail: true,
            location_detail: true,
            path_detail: true,
            limit: input.limit,
            offset,
            ordering: "part__name",
          }),
        ]);
        const location = entityRef(locationData) ?? {
          id: input.location_id,
          name: `Location ${input.location_id}`,
        };
        const rawStock = pageResults(stockData);
        const placements = rawStock.map((stock) => normalizeStock(stock));
        const partByStock = new Map<number, EntityRef>();
        rawStock.forEach((stock) => {
          const part = entityRef(stock.part_detail);
          if (part) partByStock.set(numberValue(stock.pk), part);
        });
        const output = resultPage(stockData, placements, offset);
        return result(
          { location, ...output, parts: Object.fromEntries(partByStock) },
          formatLocationInventory(location, placements, partByStock) +
            (output.nextCursor ? `\nNext cursor: ${output.nextCursor}` : ""),
        );
      }),
  );

  server.registerTool(
    "check_stock_levels",
    {
      title: "Check depleted or low stock",
      description: "Find active household parts that are out of stock or below their configured minimum.",
      inputSchema: {
        category_id: z.number().int().positive().optional(),
        include_subcategories: z.boolean().default(true),
        state: z.enum(["below_minimum", "depleted"]).default("below_minimum"),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const offset = decodeCursor(input.cursor);
        const data = await client.get("/api/part/", {
          active: true,
          category: input.category_id,
          cascade: input.category_id ? input.include_subcategories : undefined,
          low_stock: input.state === "below_minimum" ? true : undefined,
          depleted_stock: input.state === "depleted" ? true : undefined,
          category_detail: true,
          limit: input.limit,
          offset,
          ordering: "name",
        });
        const summaries = pageResults(data).map((part) => normalizePart(part));
        const output = resultPage(data, summaries, offset);
        const lines = summaries.length
          ? summaries.map((part) => {
              const minimum = part.minimumStock ?? 0;
              const shortage = Math.max(0, minimum - part.totalQuantity);
              return `- ${part.name} (#${part.id}): ${formatQuantity(part.totalQuantity, part.units)}; ` +
                `minimum ${formatQuantity(minimum, part.units)}; short by ${formatQuantity(shortage, part.units)}`;
            })
          : [`No ${input.state === "depleted" ? "depleted" : "below-minimum"} parts found.`];
        if (output.nextCursor) lines.push(`Next cursor: ${output.nextCursor}`);
        return result(output, lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_stock_history",
    {
      title: "Get stock-change history",
      description: "Show a compact newest-first timeline of quantity, location, status, and stocktake events.",
      inputSchema: {
        part_id: z.number().int().positive().optional(),
        stock_item_id: z.number().int().positive().optional(),
        since: z.string().date().optional(),
        until: z.string().date().optional(),
        limit: limitSchema,
        cursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        if (!input.part_id && !input.stock_item_id) throw new Error("part_id or stock_item_id is required");
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const offset = decodeCursor(input.cursor);
        const data = await client.get("/api/stock/track/", {
          part: input.part_id,
          item: input.stock_item_id,
          min_date: input.since,
          max_date: input.until,
          limit: input.limit,
          offset,
          ordering: "-date",
        });
        const items = pageResults(data).map((item) => ({
          id: numberValue(item.pk),
          date: stringValue(item.date),
          stockItemId: item.item,
          partId: item.part,
          label: stringValue(item.label),
          deltas: item.deltas,
          notes: optionalString(item.notes),
        }));
        const output = resultPage(data, items, offset);
        const lines = items.length
          ? items.map((item) => {
              const delta = item.deltas === undefined ? "" : ` — ${JSON.stringify(item.deltas)}`;
              return `- ${item.date}: ${item.label || "Stock change"}${delta}${item.notes ? ` — ${item.notes}` : ""} [event #${item.id}]`;
            })
          : ["No matching stock history found."];
        if (output.nextCursor) lines.push(`Next cursor: ${output.nextCursor}`);
        return result(output, lines.join("\n"));
      }),
  );

  server.registerTool(
    "scan_barcode",
    {
      title: "Resolve an inventory barcode",
      description:
        "Resolve a scanned InvenTree or supported third-party barcode. This is read-only despite the upstream validation endpoint using POST.",
      inputSchema: { barcode: z.string().min(1).max(4095) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ barcode }, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const data = record(await client.write("POST", "/api/barcode/", { barcode }));
        const refs = ["part", "stockitem", "stock_item", "stocklocation", "stock_location"]
          .map((key) => ({ kind: key, value: record(data[key]) }))
          .filter(({ value }) => Object.keys(value).length > 0)
          .map(({ kind, value }) => ({
            kind,
            id: numberValue(value.pk),
            name: optionalString(value.name) ?? optionalString(value.full_name),
            path: optionalString(value.pathstring) ? displayPath(stringValue(value.pathstring)) : undefined,
          }));
        const text = refs.length
          ? refs.map((ref) => `- ${ref.kind}: ${ref.path || ref.name || "Item"} (#${ref.id})`).join("\n")
          : `Barcode resolved, but no supported part, stock item, or location reference was returned: ${JSON.stringify(data).slice(0, 1_000)}`;
        return result({ matches: refs }, text);
      }),
  );
}
