import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "../domainErrors.js";
import {
  commitPlan,
  digest,
  discardPlan,
  reviewPlan,
} from "../mutationPlans.js";
import type { OAuthService } from "../oauth.js";
import type { PartImageUploads } from "../partImages.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import {
  MutationPrimitiveRegistry,
  authenticatedCredentialsId,
  commitAnnotations,
  mutationAnnotations,
  type PrimitiveDefinition,
} from "./shared.js";

const PLAN_ACTION_GUIDE = [
  "Step shape: {key, action, arguments}. Action argument guide:",
  "create_part_with_stock {part:{name,category_id,...}, initial_stock?}; update_part {part_id,changes};",
  "update_stock {stock_item_id,changes:{supplier_part_id?,batch?,packaging?,expiry_date?,notes?,link?}}; supplier_part_id:null clears stock provenance; preserve stock IDs and quantity when migrating existing parts.",
  "set_part_image {part_id,upload_ref}; receive_stock {part_id,quantity,location_id,...};",
  "consume_stock {part_id,quantity,location_id?,stock_item_id?,strategy?,reason?,notes?};",
  "move_stock {destination_location_id plus stock_item_id, part_id/source_location_id, or source_location_id/all};",
  "count_stock {counts:[{stock_item_id,observed_quantity}],location_id?,notes?};",
  "set_stock_status {stock_item_ids,status,notes?}; create_part_category {name,parent_id?,...};",
  "update_part_category {category_id,changes}; create_stock_location {name,parent_id?,...};",
  "update_stock_location {location_id,changes}; print_labels {entity_type,entities,template,printer?,copies?}.",
  "create_company {name,is_supplier?,is_manufacturer?,...}; update_company {company_id,changes};",
  "create_manufacturer_part {part_id,manufacturer_id,MPN,...}; update_manufacturer_part {manufacturer_part_id,changes};",
  "create_supplier_part {part_id,supplier_id,SKU,manufacturer_part_id?,...}; update_supplier_part {supplier_part_id,changes};",
  "create_parameter_template {name,units?,choices?,...}; update_parameter_template {parameter_template_id,changes};",
  "set_part_parameters {part_id,parameters:[{template_id,data,note?}]}; receive_stock optionally accepts supplier_part_id.",
  "create_purchase_order {supplier_id,reference,...}; update_purchase_order {order_id,changes};",
  "create_purchase_order_line {order_id,supplier_part_id,quantity,...}; update_purchase_order_line {line_item_id,changes};",
  "issue_purchase_order/hold_purchase_order/cancel_purchase_order {order_id}; complete_purchase_order {order_id,accept_incomplete?};",
  "receive_purchase_order {order_id,items:[{line_item_id,quantity,location_id?,...}],location_id?,allow_over_receipt?}; order quantities are supplier-pack quantities, not canonical stock units; receiving must be the final action for that order in the plan.",
  "Exact outputs (never append _id): create_part_with_stock -> part, plus stock_item only with initial_stock;",
  "receive_stock -> stock_item only when it creates a new item (use merge:new_item when a later step requires it);",
  "create_part_category -> part_category; create_stock_location -> stock_location; create_company -> company;",
  "create_manufacturer_part -> manufacturer_part; create_supplier_part -> supplier_part; create_parameter_template -> parameter_template;",
  "create_purchase_order -> purchase_order; create_purchase_order_line -> purchase_order_line; all other actions -> no outputs.",
  "Reference example: {step:\"part\",output:\"stock_item\"}, where step is the exact earlier step key.",
].join(" ");

function primitiveArgumentsShape(definition: PrimitiveDefinition): z.ZodRawShape {
  const { plan_id: _planId, expected_version: _expectedVersion, operation_id: _operationId, ...shape } = definition.config.inputSchema;
  return shape;
}

function resolveLocalPlanRefs(
  value: unknown,
  aliases: Map<string, Map<string, string>>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveLocalPlanRefs(item, aliases));
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 2 && keys.includes("step") && keys.includes("output")) {
    const step = String(object.step);
    const output = String(object.output);
    const available = aliases.get(step);
    if (!available) {
      throw new DomainError(
        {
          status: "invalid_plan_reference",
          reference_error: "unknown_or_forward_step",
          step,
          supplied_output: output,
          available_outputs: [],
        },
        `Step "${step}" is unknown, skipped, or not earlier in the plan; step must be the exact key of an earlier step`,
      );
    }
    const ref = available.get(output);
    if (!ref) {
      const availableOutputs = [...available.keys()];
      const choices = availableOutputs.length
        ? `declares outputs ${JSON.stringify(availableOutputs)}`
        : "declares no outputs";
      throw new DomainError(
        {
          status: "invalid_plan_reference",
          reference_error: "unknown_output",
          step,
          supplied_output: output,
          available_outputs: availableOutputs,
        },
        `Step "${step}" ${choices}; output "${output}" is not valid. Use an exact declared output name and never append _id.`,
      );
    }
    return ref;
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolveLocalPlanRefs(child, aliases)]));
}

function canonicalPlanData(reviewed: ReturnType<typeof reviewPlan>) {
  return {
    status: reviewed.plan.state === "staging" ? "staged" : reviewed.plan.state,
    plan_id: reviewed.plan.id,
    plan_version: reviewed.plan.version,
    expires_at: new Date(reviewed.plan.expiresAt).toISOString(),
    operation_count: reviewed.plan.steps.reduce((total, step) => total + step.requests.length, 0),
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
  };
}

function registerCreateInventoryPlan(
  server: McpServer,
  oauth: OAuthService,
  primitives: MutationPrimitiveRegistry,
): void {
  const variants = primitives.definitions.map((definition) => z.object({
    key: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
      .describe("Request-local step key used by later {step, output} references"),
    action: z.literal(definition.name),
    arguments: z.object(primitiveArgumentsShape(definition)).strict(),
  }).strict().describe(definition.config.description));
  if (variants.length < 2) throw new Error("create_inventory_plan requires at least two mutation primitives");
  const stepSchema = z.union(variants as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  const stepsSchema = z.array(stepSchema).min(1).max(30)
    .superRefine((steps, context) => {
      const seen = new Set<string>();
      for (const [index, step] of steps.entries()) {
        const key = String((step as { key: string }).key);
        if (seen.has(key)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step key: ${key}`, path: [index, "key"] });
        }
        seen.add(key);
      }
    })
    .describe(PLAN_ACTION_GUIDE);

  server.registerTool(
    "create_inventory_plan",
    {
      title: "Create a complete inventory mutation plan",
      description:
        "Validate and stage an entire ordered inventory workflow in one call. The steps parameter documents every action shape for clients that render its strict union opaquely. The response is the complete canonical review; ask once for confirmation, then call commit_inventory_plan.",
      inputSchema: {
        operation_id: z.string().min(1).max(100).describe("Caller-stable idempotency key for the complete plan"),
        steps: stepsSchema,
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) => safely(oauth, async () => {
      const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
      oauth.store.cleanup();
      const owner = authenticatedCredentialsId(auth);
      const creationDigest = digest(input.steps);
      const existing = Object.values(oauth.store.snapshot.mutationPlans).find(
        (plan) => plan.credentialsId === owner && plan.creationOperationId === input.operation_id,
      );
      if (existing) {
        if (existing.creationDigest !== creationDigest) {
          throw new DomainError(
            { status: "conflict", conflict_type: "operation_id", operation_id: input.operation_id },
            `operation_id ${input.operation_id} was already used for a different inventory plan`,
          );
        }
        const reviewed = reviewPlan(oauth, auth, existing.id);
        return result(
          {
            ...canonicalPlanData(reviewed),
            operation_id: input.operation_id,
            duplicate_operation: true,
            aliases: existing.creationAliases ?? {},
            ...(existing.creationSkippedSteps?.length ? { skipped_steps: existing.creationSkippedSteps } : {}),
          },
          `${reviewed.text}\n\nThis complete plan was already created for the same operation_id.`,
        );
      }
      const aliases = new Map<string, Map<string, string>>();
      const publicAliases: Record<string, Record<string, string>> = {};
      const skipped: Array<{ key: string; action: string; status: string }> = [];
      let planId: string | undefined;
      let planVersion: number | undefined;
      try {
        for (const rawStep of input.steps as Array<{ key: string; action: string; arguments: Record<string, unknown> }>) {
          const definition = primitives.definitions.find((candidate) => candidate.name === rawStep.action)!;
          const resolvedArguments = resolveLocalPlanRefs(rawStep.arguments, aliases) as Record<string, unknown>;
          const outcome = await definition.handler({
            ...resolvedArguments,
            operation_id: `${input.operation_id}:${rawStep.key}`,
            ...(planId ? { plan_id: planId, expected_version: planVersion } : {}),
          }, extra);
          if (outcome?.isError) {
            if (planId) discardPlan(oauth, auth, planId);
            return outcome;
          }
          const data = outcome?.structuredContent?.data as Record<string, unknown> | undefined;
          if (data?.status !== "staged") {
            skipped.push({ key: rawStep.key, action: rawStep.action, status: String(data?.status ?? "no_change") });
            continue;
          }
          planId = String(data.plan_id);
          planVersion = Number(data.plan_version);
          const outputs = Array.isArray(data.outputs) ? data.outputs as Array<Record<string, unknown>> : [];
          const stepAliases = new Map<string, string>();
          publicAliases[rawStep.key] = {};
          for (const output of outputs) {
            const name = String(output.name);
            const ref = String(output.ref);
            stepAliases.set(name, ref);
            publicAliases[rawStep.key]![name] = ref;
          }
          aliases.set(rawStep.key, stepAliases);
        }
      } catch (error) {
        if (planId) discardPlan(oauth, auth, planId);
        throw error;
      }
      if (!planId) {
        return result(
          { status: "already_current", operation_id: input.operation_id, skipped_steps: skipped },
          "No inventory changes are required; no plan was created.",
        );
      }
      oauth.store.mutate((data) => {
        Object.assign(data.mutationPlans[planId]!, {
          creationOperationId: input.operation_id,
          creationDigest,
          creationAliases: publicAliases,
          creationSkippedSteps: skipped,
        });
      });
      const reviewed = reviewPlan(oauth, auth, planId);
      return result(
        {
          ...canonicalPlanData(reviewed),
          operation_id: input.operation_id,
          aliases: publicAliases,
          ...(skipped.length ? { skipped_steps: skipped } : {}),
        },
        `${reviewed.text}\n\nThis is the complete canonical review. Ask the user for one final confirmation before commit_inventory_plan.`,
      );
    }),
  );
}


export function registerInventoryPlanTools(
  server: McpServer,
  oauth: OAuthService,
  imageUploads: PartImageUploads,
  primitives: MutationPrimitiveRegistry,
): void {
  registerCreateInventoryPlan(server, oauth, primitives);
  server.registerTool(
    "review_inventory_plan",
    {
      title: "Review an inventory plan",
      description: "Show every staged step, immutable step ID, and future entity reference in one shared inventory plan.",
      inputSchema: { plan_id: z.string().min(16) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id }, extra) =>
      safely(oauth, async () => {
        const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
        const reviewed = reviewPlan(oauth, auth, plan_id);
        return result(
          {
            status: reviewed.plan.state === "staging" ? "staged" : reviewed.plan.state,
            plan_id,
            plan_version: reviewed.plan.version,
            ...(reviewed.plan.commitResult ? { commit_result: {
              completed_steps: reviewed.plan.commitResult.completedSteps,
              completed_requests: reviewed.plan.commitResult.completedRequests,
              resolved_refs: reviewed.plan.commitResult.resolvedRefs,
              result_ids: reviewed.plan.commitResult.resultIds,
              failed_step_id: reviewed.plan.commitResult.failedStepId,
              error: reviewed.plan.commitResult.error,
            } } : {}),
            steps: reviewed.plan.steps.map((step, index) => ({
              position: index + 1,
              step_id: step.id,
              operation_id: step.operationId,
              summary: step.summary,
              operation_count: step.requests.length,
              outputs: step.outputs.map(({ ref, name, entityType, display }) => ({ ref, name, entity_type: entityType, display })),
            })),
          },
          reviewed.text,
        );
      }),
  );

  server.registerTool(
    "discard_inventory_plan",
    {
      title: "Discard an inventory plan",
      description: "Discard a staged plan without changing InvenTree.",
      inputSchema: { plan_id: z.string().min(16) },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id }, extra) => safely(oauth, async () => {
      const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
      discardPlan(oauth, auth, plan_id);
      return result({ status: "discarded", plan_id }, `Discarded inventory plan ${plan_id}. No InvenTree changes were made.`);
    }),
  );

  server.registerTool(
    "commit_inventory_plan",
    {
      title: "Commit a reviewed inventory plan",
      description: "After the user's single final confirmation, revalidate and execute all staged steps serially. Safe retries return the recorded result.",
      inputSchema: { plan_id: z.string().min(16), expected_version: z.number().int().positive() },
      annotations: commitAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id, expected_version }, extra) => safely(oauth, async () => {
      const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
      const committed = await commitPlan(oauth, auth, client, plan_id, expected_version, imageUploads);
      const resolved = Object.entries(committed.result.resolvedRefs).map(([ref, id]) => `${ref}=#${id}`);
      return result(
        {
          status: committed.result.status,
          plan_id,
          plan_version: committed.plan.version,
          completed_steps: committed.result.completedSteps,
          completed_requests: committed.result.completedRequests,
          resolved_refs: committed.result.resolvedRefs,
          result_ids: committed.result.resultIds,
          ...(committed.result.failedStepId ? { failed_step_id: committed.result.failedStepId } : {}),
          ...(committed.result.error ? { error: committed.result.error } : {}),
        },
        `Committed ${committed.result.completedSteps} steps (${committed.result.completedRequests} upstream operations) successfully.${resolved.length ? ` Resolved references: ${resolved.join(", ")}.` : ""}`,
      );
    }),
  );

}
