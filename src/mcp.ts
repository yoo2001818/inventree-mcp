import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OAuthService } from "./oauth.js";
import type { PartImageUploads } from "./partImages.js";
import { clientFor, READ_SECURITY, result, safely, WRITE_SECURITY } from "./mcpSupport.js";
import { registerReadTools } from "./readTools.js";
import { registerWriteTools } from "./writeTools.js";

export function createMcpServer(oauth: OAuthService, imageUploads: PartImageUploads): McpServer {
  const server = new McpServer(
    { name: "inventree-mcp", version: "0.3.0" },
    {
      instructions: "Home parts and physical stock only.",
    },
  );

  registerReadTools(server, oauth, imageUploads);
  registerWriteTools(server, oauth, imageUploads);

  server.registerTool(
    "inventree_get",
    {
      title: "Read a raw InvenTree API endpoint",
      description:
        "Advanced read-only escape hatch for an InvenTree /api/ endpoint not covered by a compact domain tool. Returns raw upstream JSON and should not be used for routine inventory workflows.",
      inputSchema: {
        path: z.string().startsWith("/api/").describe("Absolute API path, for example /api/company/"),
        query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: READ_SECURITY },
    },
    async ({ path, query }, extra) =>
      safely(oauth, async () => {
        const { client } = clientFor(oauth, extra.authInfo, "inventree.read");
        return result(await client.get(path, query), `Raw response from ${path}.`);
      }),
  );

  if (oauth.config.enableRawWrite) {
    server.registerTool(
      "inventree_write",
      {
        title: "Write to a raw InvenTree API endpoint",
        description:
          "Development-only advanced mutation escape hatch. Prefer typed create_inventory_plan actions and their preview/commit flow. DELETE is intentionally unsupported.",
        inputSchema: {
          method: z.enum(["POST", "PATCH", "PUT"]),
          path: z.string().startsWith("/api/"),
          body: z.record(z.unknown()),
          confirmation: z
            .literal("I confirm this InvenTree mutation")
            .describe("Exact confirmation phrase required after the user has confirmed the raw mutation"),
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
        safely(oauth, async () => {
          const { client } = clientFor(oauth, extra.authInfo, "inventree.write");
          return result(await client.write(method, path, body), `${method} ${path} completed through the raw escape hatch.`);
        }),
    );
  }

  return server;
}
