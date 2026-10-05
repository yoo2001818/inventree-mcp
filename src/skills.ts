import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "yaml";
import { z } from "zod";
import { READ_SECURITY, requireAuth, result, safely } from "./mcpSupport.js";
import type { OAuthService } from "./oauth.js";

const name = "inventree-inventory";
const root = new URL(`../skills/${name}/`, import.meta.url);
const baseUri = `skill://inventree-mcp/${name}/`;
export const inventorySkillUri = `${baseUri}SKILL.md`;

type SkillResource = {
  uri: string;
  digest: string;
  path: string;
  mimeType: string;
  text?: string;
  blob?: string;
};

// Cache the package bytes and their digests together. No request can select a
// filesystem path, and a deployment serves one consistent import snapshot.
function loadSkill() {
  const resources: SkillResource[] = [];
  let totalBytes = 0;
  function walk(directory: URL, prefix = "") {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${item.name}`;
      const file = new URL(encodeURIComponent(item.name), directory);
      if (item.isDirectory()) { walk(new URL(`${file.href}/`), `${path}/`); continue; }
      if (!item.isFile()) throw new Error(`Skill package contains a non-regular file: ${path}`);
      const bytes = readFileSync(file);
      totalBytes += bytes.length;
      if (bytes.length > (path === "SKILL.md" ? 256 * 1024 : 1024 * 1024)) throw new Error(`Skill resource exceeds import limits: ${path}`);
      const extension = extname(path);
      const mimeType = extension === ".md" ? "text/markdown" : [".yaml", ".yml"].includes(extension)
        ? "application/yaml" : extension === ".json" ? "application/json" : extension === ".txt" ? "text/plain" : "application/octet-stream";
      resources.push({ path, uri: `${baseUri}${path.split("/").map(encodeURIComponent).join("/")}`, mimeType,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        ...(mimeType === "application/octet-stream" ? { blob: bytes.toString("base64") } : { text: bytes.toString("utf8") }) });
    }
  }
  walk(root);
  if (resources.length > 100 || totalBytes > 5 * 1024 * 1024) throw new Error("Skill package exceeds import limits");
  const entry = resources.find((item) => item.uri === inventorySkillUri);
  const frontmatterText = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entry?.text ?? "")?.[1];
  if (!frontmatterText) throw new Error("Inventory SKILL.md requires YAML frontmatter");
  const frontmatter = z.object({ name: z.literal(name), description: z.string().min(1) }).passthrough().parse(parse(frontmatterText));
  return { entry: entry!, resources,
    manifest: { uri: inventorySkillUri, frontmatter, resources: resources.map(({ uri, digest }) => ({ uri, digest })) } };
}

const skill = loadSkill();
const listRequest = z.object({ method: z.literal("skills/list"), params: z.object({ cursor: z.string().optional() }).optional() });
const getRequest = z.object({ method: z.literal("skills/get"), params: z.object({ uri: z.string() }) });

export function registerSkills(server: McpServer, oauth: OAuthService): void {
  server.server.registerCapabilities({ extensions: { "io.modelcontextprotocol/skills": {} } });
  server.server.setRequestHandler(listRequest, async (request, extra) => {
    requireAuth(extra.authInfo, "inventree.read");
    // There is one static skill and therefore one page, with no next cursor.
    if (request.params?.cursor) throw new McpError(ErrorCode.InvalidParams, "Invalid skills cursor; this catalog has one page");
    return { skills: [skill.manifest] };
  });
  server.server.setRequestHandler(getRequest, async (request, extra) => {
    requireAuth(extra.authInfo, "inventree.read");
    if (request.params.uri !== inventorySkillUri) throw new McpError(ErrorCode.InvalidParams, "Unknown skill URI");
    return { skill: skill.manifest };
  });
  for (const resource of skill.resources) {
    server.registerResource(resource.path, resource.uri, {
      title: resource.path === "SKILL.md" ? "InvenTree inventory skill" : resource.path,
      description: "Packaged instructions for the InvenTree inventory skill", mimeType: resource.mimeType,
    }, async (_uri, extra) => {
      requireAuth(extra.authInfo, "inventree.read");
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType,
        ...(resource.text !== undefined ? { text: resource.text } : { blob: resource.blob! }) }] };
    });
  }
  server.registerTool("get_inventory_guide", {
    title: "Read the inventory workflow guide",
    description: "Load the InvenTree skill before a complex sourcing, parameter, migration, stock, or purchase-order plan. Provides the same packaged skill and recipes for clients without MCP skill/resource support. This reads instructions only and never changes inventory.",
    inputSchema: { section: z.enum(["overview", "workflows", "purchase_orders"]).default("overview") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: READ_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    requireAuth(extra.authInfo, "inventree.read");
    const resource = input.section === "overview" ? skill.entry : skill.resources.find((item) => item.path === `references/${input.section === "purchase_orders" ? "purchase-orders" : "workflows"}.md`)!;
    return result({ name, uri: resource.uri, digest: resource.digest, markdown: resource.text }, resource.text!);
  }));
}
