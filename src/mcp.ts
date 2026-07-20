import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { InvenTreeClient, InvenTreeError } from "./inventree.js";
import type { OAuthService } from "./oauth.js";

const READ_SECURITY = [{ type: "oauth2", scopes: ["inventree.read"] }];
const WRITE_SECURITY = [{ type: "oauth2", scopes: ["inventree.write"] }];

function requireAuth(authInfo: AuthInfo | undefined, scope: string): AuthInfo {
  if (!authInfo) throw new Error("Authentication required");
  if (!authInfo.scopes.includes(scope)) throw new Error(`OAuth scope ${scope} is required`);
  return authInfo;
}

function clientFor(oauth: OAuthService, authInfo: AuthInfo | undefined, scope: string): InvenTreeClient {
  const auth = requireAuth(authInfo, scope);
  return new InvenTreeClient(oauth.getCredentials(auth));
}

function result(data: unknown, message: string) {
  return {
    structuredContent: { data },
    content: [{ type: "text" as const, text: message }],
  };
}

function errorResult(error: unknown) {
  const details = error instanceof InvenTreeError ? error.details : undefined;
  return {
    isError: true,
    structuredContent: { error: (error as Error).message, details },
    content: [
      {
        type: "text" as const,
        text: details
          ? `${(error as Error).message}: ${JSON.stringify(details).slice(0, 2_000)}`
          : (error as Error).message,
      },
    ],
  };
}

async function safely(callback: () => Promise<unknown>, message: string) {
  try {
    return result(await callback(), message);
  } catch (error) {
    return errorResult(error);
  }
}

export function createMcpServer(oauth: OAuthService): McpServer {
  const server = new McpServer(
    { name: "inventree-mcp", version: "0.1.0" },
    {
      instructions:
        "Use the dedicated InvenTree tools before raw API requests. Read before writing to resolve IDs. Never invent part, stock-item, category, or location IDs. Writes change the user's real inventory; summarize the intended mutation and obtain confirmation before calling a write tool.",
    },
  );

  server.registerTool(
    "search_parts",
    {
      title: "Search InvenTree parts",
      description: "Search parts by name, description, IPN, keywords, revision, or category name.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text part search"),
        category: z.number().int().positive().optional().describe("Optional category ID"),
        active: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ query, category, active, limit, offset }, extra) =>
      safely(
        () =>
          clientFor(oauth, extra.authInfo, "inventree.read").get("/api/part/", {
            search: query,
            category,
            active,
            limit,
            offset,
          }),
        `Searched InvenTree for parts matching “${query}”.`,
      ),
  );

  server.registerTool(
    "get_part",
    {
      title: "Get an InvenTree part",
      description: "Retrieve detailed information for one part by numeric part ID.",
      inputSchema: { part_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ part_id }, extra) =>
      safely(
        () => clientFor(oauth, extra.authInfo, "inventree.read").get(`/api/part/${part_id}/`),
        `Retrieved part ${part_id}.`,
      ),
  );

  server.registerTool(
    "list_stock",
    {
      title: "List InvenTree stock",
      description: "List stock items, optionally filtered by part, location, batch, status, or free text.",
      inputSchema: {
        part: z.number().int().positive().optional(),
        location: z.number().int().positive().optional(),
        search: z.string().optional(),
        batch: z.string().optional(),
        in_stock: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(
        () => clientFor(oauth, extra.authInfo, "inventree.read").get("/api/stock/", input),
        "Retrieved matching stock items.",
      ),
  );

  server.registerTool(
    "list_stock_locations",
    {
      title: "List InvenTree stock locations",
      description: "Search or browse stock locations. Use this to resolve a physical location to its numeric ID.",
      inputSchema: {
        search: z.string().optional(),
        parent: z.number().int().positive().optional(),
        structural: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async (input, extra) =>
      safely(
        () => clientFor(oauth, extra.authInfo, "inventree.read").get("/api/stock/location/", input),
        "Retrieved stock locations.",
      ),
  );

  server.registerTool(
    "get_part_bom",
    {
      title: "Get an InvenTree bill of materials",
      description: "List BOM lines for an assembly part ID.",
      inputSchema: {
        part_id: z.number().int().positive(),
        limit: z.number().int().min(1).max(250).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ part_id, limit, offset }, extra) =>
      safely(
        () =>
          clientFor(oauth, extra.authInfo, "inventree.read").get("/api/bom/", {
            part: part_id,
            limit,
            offset,
          }),
        `Retrieved BOM lines for part ${part_id}.`,
      ),
  );

  server.registerTool(
    "inventree_get",
    {
      title: "Read an InvenTree API endpoint",
      description:
        "Advanced read-only escape hatch for an InvenTree /api/ endpoint not covered by another tool. Query values must be JSON primitives or arrays.",
      inputSchema: {
        path: z.string().startsWith("/api/").describe("Absolute API path, for example /api/company/"),
        query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ path, query }, extra) =>
      safely(
        () => clientFor(oauth, extra.authInfo, "inventree.read").get(path, query),
        `Read ${path}.`,
      ),
  );

  server.registerTool(
    "inventree_write",
    {
      title: "Write to an InvenTree API endpoint",
      description:
        "Advanced InvenTree mutation for POST, PATCH, or PUT requests. Use only after reading the target endpoint, resolving all IDs, and receiving explicit user confirmation. DELETE is intentionally unsupported.",
      inputSchema: {
        method: z.enum(["POST", "PATCH", "PUT"]),
        path: z.string().startsWith("/api/"),
        body: z.record(z.unknown()),
        confirmation: z
          .literal("I confirm this InvenTree mutation")
          .describe("Exact confirmation phrase required after the user has confirmed the mutation"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ method, path, body }, extra) =>
      safely(
        () => clientFor(oauth, extra.authInfo, "inventree.write").write(method, path, body),
        `${method} ${path} completed.`,
      ),
  );

  return server;
}
