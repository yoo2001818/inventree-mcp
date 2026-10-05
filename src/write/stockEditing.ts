import { z } from "zod";
import { formatQuantity, record, type JsonRecord } from "../inventoryDomain.js";
import { digest } from "../mutationPlans.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import type { OAuthService } from "../oauth.js";
import { CatalogContext, sameEntity } from "./catalogPrimitives.js";
import {
  beforeAfter, ensureUnlocked, entityIdSchema, getStock, mutationAnnotations,
  mutationPath, mutationValue, normalizeEntityId, nullableEntityIdSchema,
  plannedOutput, planInputFields, stageMutation, type MutationPrimitiveRegistry,
} from "./shared.js";

export function registerStockEditing(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  primitives.register("update_stock", {
    title: "Prepare edits to a stock item",
    description: "Stage a sparse edit of existing stock metadata, including attaching, replacing, or clearing its supplier part. Preserve stock identity, quantity, and location. Use count_stock, move_stock, and set_stock_status for those operations.",
    inputSchema: {
      ...planInputFields,
      stock_item_id: entityIdSchema(),
      changes: z.object({
        supplier_part_id: nullableEntityIdSchema().optional().describe("Source supplier part for this stock's canonical part; null clears provenance. May reference a supplier part created earlier in this plan."),
        batch: z.string().max(100).optional(),
        packaging: z.string().max(50).optional(),
        expiry_date: z.string().date().nullable().optional(),
        notes: z.string().max(10000).optional(),
        link: z.union([z.string().url().max(2000), z.literal("")]).optional(),
      }).strict(),
    },
    annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    if (!Object.keys(input.changes).length) throw new Error("At least one stock change is required");
    const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
    const context = new CatalogContext(oauth, auth, client, input.plan_id);
    const stockId = normalizeEntityId(input.stock_item_id);
    const output = plannedOutput(oauth, auth, input.plan_id, stockId, "stock_item");
    const path = mutationPath("/api/stock/", stockId);
    let current: JsonRecord;
    if (typeof stockId === "number") {
      current = await getStock(client, stockId);
      context.checks.push({ path: `/api/stock/${stockId}/`,
        query: { part_detail: true, location_detail: true, path_detail: true }, digest: digest(current) });
    } else {
      current = { ...output!.metadata };
      // Initial stock and its canonical part are outputs of the same create step.
      if (current.part === undefined) {
        const creator = context.steps.find((step) => step.outputs.some((item) => item.ref === stockId));
        const partOutput = creator?.outputs.find((item) => item.entityType === "part");
        if (partOutput) current.part = mutationValue(partOutput.ref);
      }
    }
    for (const step of context.steps) for (const request of step.requests) {
      if (request.method === "PATCH" && sameEntity(request.path, path)) current = { ...current, ...record(request.body) };
    }
    const partId = typeof current.part === "object" ? record(current.part).__planRef : current.part;
    if (typeof partId !== "number" && typeof partId !== "string") throw new Error("Cannot resolve the stock item's canonical part");
    const part = await context.entity("part", partId);
    ensureUnlocked(part.data);
    if (current.locked === true) throw new Error(`Stock #${stockId} is locked`);

    const body: JsonRecord = {};
    const diffs: string[] = [];
    for (const [key, value] of Object.entries(input.changes)) {
      if (value === undefined) continue;
      const field = key === "supplier_part_id" ? "supplier_part" : key;
      let normalized: unknown = value;
      if (key === "supplier_part_id" && value !== null) {
        const supplier = await context.entity("supplier_part", input.changes.supplier_part_id!);
        if (!sameEntity(supplier.data.part, mutationValue(part.id))) throw new Error("The source supplier part must refer to the stock item's canonical part");
        if (supplier.data.active === false) throw new Error("The source supplier part is inactive");
        normalized = mutationValue(supplier.id);
      }
      const previous = field === "supplier_part" ? current[field] || null : current[field];
      const diff = beforeAfter(field, previous, normalized);
      if (diff) { body[field] = normalized; diffs.push(diff); }
    }
    if (!diffs.length) return result({ status: "already_current", stock_item_id: stockId }, "The requested stock metadata is already current; no plan step was created.");
    return stageMutation(oauth, auth, input, [
      `Update ${part.display} [stock ${typeof stockId === "number" ? `#${stockId}` : `ref ${stockId}`}]:`,
      ...diffs,
      `- Retain stock identity, quantity (${formatQuantity(Number(current.quantity), String(part.data.units ?? ""))}), and location.`,
    ].join("\n"), [{ method: "PATCH", path, body }], context.checks);
  }));
}
