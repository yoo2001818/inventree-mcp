import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { notFound } from "./domainErrors.js";
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
  normalizePartSearchQuery,
  normalizeStock,
  numberValue,
  optionalString,
  partImagePath,
  page,
  pageResults,
  record,
  records,
  stringValue,
  type EntityRef,
  type JsonRecord,
  type PartSummary,
} from "./inventoryDomain.js";
import type { OAuthService } from "./oauth.js";
import { InvenTreeError } from "./inventree.js";
import { inspectImage, type PartImageUploads } from "./partImages.js";
import { clientFor, READ_SECURITY, result, safely } from "./mcpSupport.js";
import { partParameters, requiredCatalogRecord } from "./catalogReadTools.js";

const cursorSchema = z.string().optional().describe("Opaque cursor returned by a previous call");
const limitSchema = z.number().int().min(1).max(100).default(20);
const TREE_NODE_LIMIT = 40;

function boundTreeNodes(nodes: JsonRecord[], search?: string) {
  if (nodes.length <= TREE_NODE_LIMIT) {
    return { nodes, truncated: false, expandableRootIds: [] as number[] };
  }
  const minimumLevel = Math.min(...nodes.map((node) => numberValue(node.level)));
  const orientation = search
    ? nodes.slice(0, TREE_NODE_LIMIT)
    : nodes.filter((node) => numberValue(node.level) === minimumLevel).slice(0, TREE_NODE_LIMIT);
  return {
    nodes: orientation,
    truncated: true,
    expandableRootIds: orientation.map((node) => numberValue(node.pk)).filter(Boolean),
  };
}

function treeRootHeading(root: JsonRecord | undefined, kind: "category" | "location"): string | undefined {
  if (!root) return undefined;
  const ref = entityRef(root);
  if (!ref) return undefined;
  const structural = root.structural === true ? " [structural]" : "";
  return `## Selected ${kind}: ${formatRef(ref)}${structural}`;
}

async function requiredPart(client: ReturnType<typeof clientFor>["client"], partId: number, parameters = false) {
  try {
    return await client.get(`/api/part/${partId}/`, { category_detail: true, location_detail: true, parameters });
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part", { supplied_id: partId }, "find_parts", `Part #${partId} was not found. Use find_parts to resolve the current ID.`);
    }
    throw error;
  }
}

async function requiredLocation(client: ReturnType<typeof clientFor>["client"], locationId: number) {
  try {
    return await client.get(`/api/stock/location/${locationId}/`, { path_detail: true });
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("stock_location", { supplied_id: locationId }, "browse_stock_locations", `Stock location #${locationId} was not found. Use browse_stock_locations to resolve the current ID.`);
    }
    throw error;
  }
}

async function requiredCategory(client: ReturnType<typeof clientFor>["client"], categoryId: number) {
  try {
    return await client.get(`/api/part/category/${categoryId}/`, { path_detail: true });
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part_category", { supplied_id: categoryId }, "browse_part_categories", `Part category #${categoryId} was not found. Use browse_part_categories to resolve the current ID.`);
    }
    throw error;
  }
}

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

function normalizeHistoryDelta(value: unknown) {
  const deltas = record(value);
  const location = entityRef(deltas.location_detail);
  if (location) return { kind: "location", text: `moved to ${formatRef(location)}`, location };
  const primitive = (key: string): string | undefined => {
    const candidate = deltas[key];
    return typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean"
      ? String(candidate)
      : undefined;
  };
  const changes = [
    primitive("quantity") ? `quantity ${primitive("quantity")}` : "",
    primitive("location") ? `location #${primitive("location")}` : "",
    primitive("status") ? `status ${primitive("status")}` : "",
    primitive("count") ? `count ${primitive("count")}` : "",
    primitive("added") ? `added ${primitive("added")}` : "",
    primitive("removed") ? `removed ${primitive("removed")}` : "",
  ].filter(Boolean);
  if (changes.length) return { kind: "fields", text: changes.join(", "), fields: boundedPrimitiveDeltas(deltas) };
  const bounded = boundedPrimitiveDeltas(deltas);
  const fallback = JSON.stringify(bounded);
  return { kind: "unknown", text: fallback === "{}" ? "" : fallback.slice(0, 300), fields: bounded };
}

function boundedPrimitiveDeltas(deltas: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(deltas)
      .filter((entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]))
      .slice(0, 8),
  );
}

export function registerReadTools(server: McpServer, oauth: OAuthService, imageUploads: PartImageUploads): void {
  server.registerTool(
    "browse_part_categories",
    {
      title: "Browse the part-category tree",
      description:
        "Browse or search part categories as a compact Markdown hierarchy. Use this to resolve category IDs before creating or moving parts.",
      inputSchema: {
        root_id: z.number().int().positive().optional().describe("Optional category whose descendants should be shown"),
        search: z.string().min(1).optional(),
        max_level: z.number().int().min(0).max(12).default(6).describe("Upstream zero-based maximum tree level"),
        full_tree: z.boolean().default(false),
        include_counts: z.boolean().default(false),
        include_descriptions: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const topLevelOnly = !input.root_id && !input.search && !input.full_tree;
        const path = input.include_counts || topLevelOnly ? "/api/part/category/" : "/api/part/category/tree/";
        const [data, rootData] = await Promise.all([
          client.get(path, {
            parent: input.root_id,
            top_level: topLevelOnly ? true : undefined,
            cascade: input.root_id && input.include_counts ? true : undefined,
            search: input.search,
            max_level: input.include_counts || topLevelOnly ? undefined : input.max_level,
            limit: 250,
            offset: 0,
            ordering: input.include_counts || topLevelOnly ? "pathstring" : "name",
          }),
          input.root_id ? requiredCategory(client, input.root_id) : undefined,
        ]);
        const rawNodes = pageResults(data);
        const depthNodes = !topLevelOnly
          ? rawNodes.filter((node) => numberValue(node.level) <= input.max_level)
          : rawNodes;
        const bounded = boundTreeNodes(depthNodes, input.search);
        const nodes = bounded.nodes;
        const availableCount = numberValue(record(data).count, rawNodes.length);
        const count = nodes.length;
        let text = formatTree(nodes, {
          kind: "category",
          search: input.search,
          includeCounts: input.include_counts || topLevelOnly,
          includeDescriptions: input.include_descriptions,
        });
        const heading = treeRootHeading(rootData ? record(rootData) : undefined, "category");
        if (heading) text = `${heading}\n\n${text}`;
        if (bounded.truncated) {
          text += `\n\nTree limited to ${nodes.length} orientation nodes from ${depthNodes.length} depth-matched nodes. Expand one of these root_id values next: ${bounded.expandableRootIds.join(", ")}.`;
        } else if (availableCount > depthNodes.length) {
          text += `\n\nDepth limited: showing ${depthNodes.length} of ${availableCount} matching nodes through max_level ${input.max_level}.`;
        }
        return result(
          {
            count,
            availableCount,
            ...(rootData ? { root: entityRef(rootData) } : {}),
            ...(bounded.truncated ? { truncated: true, expandableRootIds: bounded.expandableRootIds } : {}),
            nodes: nodes.map((node) => ({
              id: numberValue(node.pk),
              name: stringValue(node.name),
              path: displayPath(stringValue(node.pathstring)),
              parentId: node.parent ?? null,
              structural: node.structural === true,
              ...((input.include_counts || topLevelOnly) && node.part_count !== undefined ? { partCount: node.part_count } : {}),
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
        max_level: z.number().int().min(0).max(12).default(6).describe("Upstream zero-based maximum tree level"),
        full_tree: z.boolean().default(false),
        include_item_counts: z.boolean().default(false),
        include_descriptions: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const topLevelOnly = !input.root_id && !input.search && !input.full_tree;
        const path = input.include_item_counts || topLevelOnly ? "/api/stock/location/" : "/api/stock/location/tree/";
        const [data, rootData] = await Promise.all([
          client.get(path, {
            parent: input.root_id,
            top_level: topLevelOnly ? true : undefined,
            cascade: input.root_id && input.include_item_counts ? true : undefined,
            search: input.search,
            max_level: input.include_item_counts || topLevelOnly ? undefined : input.max_level,
            limit: 250,
            offset: 0,
            ordering: input.include_item_counts || topLevelOnly ? "pathstring" : "name",
          }),
          input.root_id ? requiredLocation(client, input.root_id) : undefined,
        ]);
        const rawNodes = pageResults(data);
        const depthNodes = !topLevelOnly
          ? rawNodes.filter((node) => numberValue(node.level) <= input.max_level)
          : rawNodes;
        const bounded = boundTreeNodes(depthNodes, input.search);
        const nodes = bounded.nodes;
        const availableCount = numberValue(record(data).count, rawNodes.length);
        const count = nodes.length;
        let text = formatTree(nodes, {
          kind: "location",
          search: input.search,
          includeCounts: input.include_item_counts || topLevelOnly,
          includeDescriptions: input.include_descriptions,
        });
        const heading = treeRootHeading(rootData ? record(rootData) : undefined, "location");
        if (heading) text = `${heading}\n\n${text}`;
        if (bounded.truncated) {
          text += `\n\nTree limited to ${nodes.length} orientation nodes from ${depthNodes.length} depth-matched nodes. Expand one of these root_id values next: ${bounded.expandableRootIds.join(", ")}.`;
        } else if (availableCount > depthNodes.length) {
          text += `\n\nDepth limited: showing ${depthNodes.length} of ${availableCount} matching nodes through max_level ${input.max_level}.`;
        }
        return result(
          {
            count,
            availableCount,
            ...(rootData ? { root: entityRef(rootData) } : {}),
            ...(bounded.truncated ? { truncated: true, expandableRootIds: bounded.expandableRootIds } : {}),
            nodes: nodes.map((node) => ({
              id: numberValue(node.pk),
              name: stringValue(node.name),
              path: displayPath(stringValue(node.pathstring)),
              parentId: node.parent ?? null,
              structural: node.structural === true,
              ...((input.include_item_counts || topLevelOnly) && node.items !== undefined ? { stockItemCount: node.items } : {}),
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
        "Find canonical parts by name, description, IPN, keywords, category, MPN, supplier SKU, tags, or structured parameter filters. Returns compact quantities and physical locations in the same call.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Name, description, IPN, MPN, or supplier SKU; omit when searching by category or parameters"),
        parameters: z.array(z.object({ template_id: z.number().int().positive(),
          value: z.string().min(1).max(500), operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "icontains"]).default("eq") }).strict())
          .max(30).default([]).describe("ANDed specification filters. Resolve template IDs with list_parameter_templates. Values can include units, e.g. 10nF or 50V."),
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
        if (!input.query && !input.category_id && !input.parameters.length) throw new Error("Provide a query, category_id, or parameter filters");
        const normalizedQuery = input.query ? normalizePartSearchQuery(input.query) : undefined;
        const parameterFilters: Record<string, unknown> = {};
        for (const filter of input.parameters) {
          const key = `parameter_${filter.template_id}${filter.operator === "eq" ? "" : `_${filter.operator}`}`;
          if (Object.hasOwn(parameterFilters, key)) throw new Error(`Duplicate parameter filter: ${key}`);
          await requiredCatalogRecord(client, "/api/parameter/template/", "parameter_template", filter.template_id, "list_parameter_templates");
          parameterFilters[key] = filter.value;
        }
        const data = await client.get("/api/part/", {
          search: normalizedQuery,
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
          ...parameterFilters,
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
        const part = record(await requiredPart(client, input.part_id));
        const stock = await stockForPart(client, input.part_id, input.include_depleted);
        const summary = normalizePart(part, stock);
        const parameters = input.include.includes("parameters") ? await partParameters(client, input.part_id, 100) : undefined;
        return result(
          { ...summary, ...(parameters ? { parameters } : {}) },
          formatPartInventory(
            summary,
            input.include.includes("notes") ? optionalString(part.notes) : undefined,
            parameters?.results.map((parameter) => ({ template: parameter.templateId,
              template_detail: { name: parameter.name }, data: parameter.value + (parameter.units ? ` [${parameter.units}]` : "") })),
          ) + (parameters?.nextCursor ? `\nMore parameters: use get_part_parameters with cursor ${parameters.nextCursor}.` : ""),
        );
      }),
  );

  server.registerTool(
    "get_part_image",
    {
      title: "Get a part image",
      description: "Return thumbnail and preview images directly as MCP image content. Original images use an expiring direct-download URL.",
      inputSchema: {
        part_id: z.number().int().positive(),
        variant: z.enum(["thumbnail", "preview", "original"]).default("thumbnail"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.read");
        const part = record(await requiredPart(client, input.part_id));
        const selectedPath = input.variant === "thumbnail"
          ? partImagePath(part.thumbnail) ?? partImagePath(part.image)
          : partImagePath(part.image) ?? partImagePath(part.thumbnail);
        if (!selectedPath) {
          throw notFound(
            "part_image",
            { supplied_id: input.part_id },
            "prepare_part_image_upload",
            `Part #${input.part_id} does not have an image. Call prepare_part_image_upload, upload the image, then create a plan containing a set_part_image action.`,
          );
        }
        const name = optionalString(part.name) ?? `Part ${input.part_id}`;
        if (input.variant !== "original") {
          const downloaded = await client.downloadMedia(selectedPath, imageUploads.maxBytes);
          const metadata = inspectImage(downloaded.bytes);
          if (downloaded.contentType && downloaded.contentType !== metadata.mimeType) {
            throw new Error(`InvenTree returned ${downloaded.contentType}, but the downloaded file is ${metadata.mimeType}`);
          }
          return {
            structuredContent: {
              data: {
                status: "ready",
                part: { id: input.part_id, name },
                variant: input.variant,
                delivery: "inline",
                mime_type: metadata.mimeType,
                byte_size: metadata.byteSize,
                width: metadata.width,
                height: metadata.height,
              },
            },
            content: [
              { type: "text" as const, text: `${name} (#${input.part_id}) — ${input.variant} image, ${metadata.width}x${metadata.height}, ${metadata.byteSize} bytes.` },
              { type: "image" as const, data: downloaded.bytes.toString("base64"), mimeType: metadata.mimeType },
            ],
          };
        }
        const credentialsId = String(auth.extra?.credentialsId ?? "");
        if (!credentialsId) throw new Error("Authenticated InvenTree credentials are missing");
        const sourceExtension = /\.(png|jpe?g|gif|webp)$/i.exec(selectedPath)?.[1]?.toLowerCase();
        const filename = `${name}-${input.variant}${sourceExtension ? `.${sourceExtension}` : ""}`;
        const signed = imageUploads.prepareDownload(credentialsId, selectedPath, filename);
        const downloadUrl = new URL("/part-images/download", oauth.config.publicUrl);
        downloadUrl.searchParams.set("token", signed.token);
        return {
          structuredContent: {
            data: {
              status: "ready",
              part: { id: input.part_id, name },
              variant: input.variant,
              delivery: "download_url",
              download_url: downloadUrl.toString(),
              expires_at: new Date(signed.expiresAt).toISOString(),
            },
          },
          content: [
            { type: "text" as const, text: `[Open or download the ${input.variant} image for ${name} (#${input.part_id})](${downloadUrl.toString()})\n\nThis capability URL expires at ${new Date(signed.expiresAt).toISOString()}.` },
            {
              type: "resource_link" as const,
              uri: downloadUrl.toString(),
              name: `${name} ${input.variant} image`,
              description: `Expiring direct-download URL for part #${input.part_id}`,
            },
          ],
        };
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
          requiredLocation(client, input.location_id),
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
        const enrichedPlacements = placements.map((placement) => ({
          ...placement,
          ...(partByStock.get(placement.stockItemId) ? { part: partByStock.get(placement.stockItemId) } : {}),
        }));
        const output = resultPage(stockData, enrichedPlacements, offset);
        return result(
          { location, ...output },
          formatLocationInventory(location, placements, partByStock, output) +
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
              if (input.state === "depleted") return `- ${part.name} (#${part.id}): out of stock`;
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
          delta: normalizeHistoryDelta(item.deltas),
          notes: optionalString(item.notes),
        }));
        const output = resultPage(data, items, offset);
        const lines = items.length
          ? items.map((item) => {
              const delta = item.delta.text ? ` — ${item.delta.text}` : "";
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
        let data: JsonRecord;
        try {
          data = record(await client.write("POST", "/api/barcode/", { barcode }));
        } catch (error) {
          if (error instanceof InvenTreeError && (error.status === 400 || error.status === 404)) {
            throw notFound(
              "barcode",
              {},
              "find_parts",
              "No supported inventory entity matched that barcode. Try find_parts if you know the item name.",
            );
          }
          throw error;
        }
        const refs = ["part", "stockitem", "stock_item", "stocklocation", "stock_location"]
          .map((key) => ({ kind: key, value: record(data[key]) }))
          .filter(({ value }) => Object.keys(value).length > 0)
          .map(({ kind, value }) => ({
            kind,
            id: numberValue(value.pk),
            name: optionalString(value.name) ?? optionalString(value.full_name),
            path: optionalString(value.pathstring) ? displayPath(stringValue(value.pathstring)) : undefined,
          }));
        if (!refs.length) {
          throw notFound(
            "barcode",
            {},
            "find_parts",
            "No supported part, stock item, or location matched that barcode. Try find_parts if you know the item name.",
          );
        }
        const text = refs.map((ref) => `- ${ref.kind}: ${ref.path || ref.name || "Item"} (#${ref.id})`).join("\n");
        return result({ matches: refs }, text);
      }),
  );
}
