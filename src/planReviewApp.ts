import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { reviewPlan } from "./mutationPlans.js";
import type { OAuthService } from "./oauth.js";
import { clientFor, safely, WRITE_SECURITY } from "./mcpSupport.js";

export const PLAN_REVIEW_APP_URI = "ui://inventree/inventory-plan-review.html";
const planReviewHtmlUrl = new URL("../dist-app/plan-review.html", import.meta.url);
let planReviewHtml: Promise<string> | undefined;

function loadPlanReviewHtml(): Promise<string> {
  planReviewHtml ??= readFile(planReviewHtmlUrl, "utf8");
  return planReviewHtml;
}

export function registerPlanReviewApp(server: McpServer, oauth: OAuthService): void {
  registerAppResource(
    server,
    "Inventory plan review",
    PLAN_REVIEW_APP_URI,
    {
      description: "Interactive extended review and confirmation UI for a staged InvenTree inventory plan.",
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{
        uri: PLAN_REVIEW_APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadPlanReviewHtml(),
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );

  registerAppTool(
    server,
    "open_inventory_plan_review",
    {
      title: "Open extended inventory-plan review",
      description: "Open an interactive review only when the user asks for extended or detailed confirmation. The app shows every staged change and lets the user explicitly commit it. Otherwise use review_inventory_plan.",
      inputSchema: { plan_id: z.string().min(16) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        securitySchemes: WRITE_SECURITY,
        ui: { resourceUri: PLAN_REVIEW_APP_URI, visibility: ["model"] },
      },
    },
    async ({ plan_id }, extra) =>
      safely(oauth, async () => {
        const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
        const reviewed = reviewPlan(oauth, auth, plan_id);
        const operationCount = reviewed.plan.steps.reduce((total, step) => total + step.requests.length, 0);
        return {
          structuredContent: {
            data: {
              status: reviewed.plan.state,
              plan_id,
              plan_version: reviewed.plan.version,
              expires_at: new Date(reviewed.plan.expiresAt).toISOString(),
              operation_count: operationCount,
              steps: reviewed.plan.steps.map((step, index) => ({
                position: index + 1,
                step_id: step.id,
                operation_id: step.operationId,
                summary: step.summary,
                operation_count: step.requests.length,
                outputs: step.outputs.map(({ ref, name, entityType, display }) => ({
                  ref,
                  name,
                  entity_type: entityType,
                  display,
                })),
              })),
              commit: {
                tool: "commit_inventory_plan",
                arguments: { plan_id, expected_version: reviewed.plan.version },
              },
            },
          },
          content: [{
            type: "text" as const,
            text: `${reviewed.text}\n\nAn interactive extended-confirmation view is attached. If the host cannot render MCP Apps, present this Markdown review and use the ordinary confirmation flow.`,
          }],
        };
      }),
  );
}
