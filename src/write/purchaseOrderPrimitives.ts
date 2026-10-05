import { z } from "zod";
import { DomainError, notFound } from "../domainErrors.js";
import { numberValue, pageResults, record, type JsonRecord } from "../inventoryDomain.js";
import { InvenTreeError } from "../inventree.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import type { OAuthService } from "../oauth.js";
import type { MutationRequest } from "../store.js";
import { CatalogContext, sameEntity } from "./catalogPrimitives.js";
import {
  entityIdSchema, ensureStockDestination, ensureUnlocked, mutationAnnotations, mutationPath, mutationValue,
  normalizeEntityId, nullableEntityIdSchema, plannedOutput, planInputFields, positiveQuantity,
  stageMutation, STATUS_CODES, type EntityId, type MutationPrimitiveRegistry,
} from "./shared.js";

const paths = { purchase_order: "/api/order/po/", purchase_order_line: "/api/order/po-line/", stock_location: "/api/stock/location/" };
const states = { issue: 20, hold: 25, complete: 30, cancel: 40 } as const;
const open = [10, 20, 25];
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().date().nullable().optional();
const link = z.union([z.string().url().max(2000), z.literal("")]).optional();
const price = z.string().regex(/^\d{1,13}(?:\.\d{1,6})?$/).nullable().optional()
  .describe("Exact nonnegative decimal price per supplier pack, e.g. 0.125000; null clears price");
const orderFields = {
  reference: z.string().trim().min(1).max(100).describe("Unique order reference matching the instance's reference pattern"),
  description: z.string().max(250).optional(), supplier_reference: z.string().max(64).optional(),
  destination_id: nullableEntityIdSchema().optional(), target_date: date, start_date: date,
  order_currency: currency.nullable().optional(), notes: z.string().max(50000).nullable().optional(), link,
  responsible_id: z.number().int().positive().nullable().optional().describe("Existing InvenTree owner (user/group) ID, if required by the instance"),
};
const lineFields = {
  quantity: positiveQuantity.describe("Quantity of supplier packs, matching the purchase-order line's units"),
  purchase_price: price, purchase_price_currency: currency.optional(), discount: z.number().min(0).max(100).optional(),
  destination_id: nullableEntityIdSchema().optional(), target_date: date,
  line: z.string().max(20).optional(), reference: z.string().max(100).optional(),
  notes: z.string().max(500).optional(), link,
};
const sparseOrder = z.object(Object.fromEntries(Object.entries(orderFields).map(([key, schema]) => [key, schema.optional()]))).strict();
const sparseLine = z.object(Object.fromEntries(Object.entries(lineFields).map(([key, schema]) => [key, schema.optional()]))).strict();

function entityValue(value: unknown): number | string {
  const id = typeof value === "object" && value ? record(value).__planRef : value;
  if (typeof id !== "number" && typeof id !== "string") throw new Error("Missing linked inventory ID");
  return id;
}

function sumExceeds(addends: number[], total: number): boolean {
  // Compare decimal quantities exactly: 0.3 - 0.1 must allow a receipt of 0.2.
  const decimals = [...addends, total].map((value) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
    if (!match) throw new Error("Invalid purchase-order quantity");
    return { coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`), scale: (match[3]?.length ?? 0) - Number(match[4] ?? 0) };
  });
  const scale = Math.max(...decimals.map((value) => value.scale));
  const integers = decimals.map((value) => value.coefficient * 10n ** BigInt(scale - value.scale));
  return integers.slice(0, -1).reduce((sum, value) => sum + value, 0n) > integers.at(-1)!;
}

class OrderContext extends CatalogContext {
  async item(type: keyof typeof paths, value: EntityId) {
    const id = normalizeEntityId(value);
    const output = plannedOutput(this.oauth, this.auth, this.planId, id, type);
    let data: JsonRecord;
    if (typeof id === "number") {
      try { data = record(await this.read(`${paths[type]}${id}/`)); }
      catch (error) {
        if (error instanceof InvenTreeError && error.status === 404) throw notFound(type, { supplied_id: id },
          type === "stock_location" ? "browse_stock_locations" : "get_purchase_order", `${type} #${id} was not found`);
        throw error;
      }
    } else data = { ...output!.metadata };
    for (const step of this.steps) for (const request of step.requests) {
      if (request.method === "PATCH" && sameEntity(request.path, mutationPath(paths[type], id))) data = { ...data, ...record(request.body) };
      if (type !== "purchase_order" || request.method !== "POST") continue;
      if (sameEntity(request.path, mutationPath(paths[type], id, "/receive/"))) {
        throw new Error("A receipt must be the final action for that purchase order in the plan; verify its state before preparing further changes");
      }
      for (const [action, state] of Object.entries(states)) {
        if (sameEntity(request.path, mutationPath(paths[type], id, `/${action}/`))) data.status = state;
      }
    }
    return { id, data, display: output?.display ?? String(data.reference ?? data.name ?? `${type} #${id}`) };
  }

  async location(value: EntityId) {
    const location = await this.item("stock_location", value);
    ensureStockDestination(location.data);
    return location;
  }

  async lines(orderId: number | string) {
    const ids: Array<number | string> = [];
    if (typeof orderId === "number") {
      let offset = 0;
      while (true) {
        const source = await this.read(paths.purchase_order_line, { order: orderId, limit: 100, offset, ordering: "pk" });
        const rows = pageResults(source);
        ids.push(...rows.map((item) => numberValue(item.pk)));
        offset += rows.length;
        if (offset >= numberValue(record(source).count, rows.length)) break;
        if (!rows.length || offset >= 10000) throw new Error("Could not inspect all purchase-order lines; narrow the order before staging changes");
      }
    }
    for (const step of this.steps) for (const output of step.outputs) {
      if (output.entityType === "purchase_order_line" && sameEntity(output.metadata?.order, mutationValue(orderId))) ids.push(output.ref);
    }
    return Promise.all(ids.map((id) => this.item("purchase_order_line", id)));
  }

  async supplier(value: EntityId) {
    const supplier = await this.entity("company", value);
    if (supplier.data.is_supplier !== true || supplier.data.active === false) throw new Error("Purchase-order supplier must be an active supplier company");
    return supplier;
  }

  async source(order: JsonRecord, value: EntityId) {
    const source = await this.entity("supplier_part", value);
    if (!sameEntity(source.data.supplier, order.supplier)) throw new Error("Supplier part must belong to the purchase order's supplier");
    if (source.data.active === false) throw new Error("Supplier part is inactive");
    const part = await this.entity("part", entityValue(source.data.part));
    ensureUnlocked(part.data);
    if (part.data.purchaseable === false || part.data.active === false) throw new Error("Canonical part must be active and purchaseable");
    return { ...source, part };
  }

  async fields(source: JsonRecord) {
    const body: JsonRecord = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (key === "destination_id") body.destination = value === null ? null : mutationValue((await this.location(value as EntityId)).id);
      else body[key === "responsible_id" ? "responsible" : key] = value;
    }
    return body;
  }

  async uniqueReference(reference: string, exclude?: number | string) {
    const data = await this.read(paths.purchase_order, { search: reference, limit: 100, offset: 0 });
    if (pageResults(data).some((item) => item.reference === reference && item.pk !== exclude) || numberValue(record(data).count) > pageResults(data).length) {
      throw new DomainError({ status: "conflict", conflict_type: "purchase_order_duplicate" }, "Purchase-order reference already exists or the lookup is incomplete; discover and reuse the existing order");
    }
    for (const step of this.steps) {
      for (const output of step.outputs) if (output.entityType === "purchase_order" && output.ref !== exclude) {
        if ((await this.item("purchase_order", output.ref)).data.reference === reference) throw new Error("Purchase-order reference is already staged");
      }
      for (const request of step.requests) if (request.method === "PATCH" && record(request.body).reference === reference
        && !sameEntity(request.path, exclude === undefined ? null : mutationPath(paths.purchase_order, exclude))) {
        if (typeof request.path === "string" && request.path.startsWith(paths.purchase_order)) throw new Error("Purchase-order reference is already staged");
      }
    }
  }
}

function ensureOpen(order: JsonRecord) {
  if (!open.includes(numberValue(order.status))) throw new Error("Purchase order must be pending, placed, or on hold; terminal orders cannot be edited");
}

function diffs(current: JsonRecord | undefined, body: JsonRecord) {
  const decimal = (value: unknown) => {
    const text = String(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
    const [whole, fraction = ""] = text.split(".");
    const trimmed = fraction.replace(/0+$/, "");
    return `${whole!.replace(/^0+(?=\d)/, "")}${trimmed ? `.${trimmed}` : ""}`;
  };
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => {
    if (!current) return true;
    // InvenTree may serialize monetary amounts as numbers or normalized strings.
    if (key === "purchase_price" && value != null && current[key] != null && decimal(value) !== undefined
      && decimal(value) === decimal(current[key])) return false;
    return !sameEntity(current[key], value);
  }));
}
function summary(title: string, body: JsonRecord, current?: JsonRecord) {
  return [title, ...Object.entries(body).map(([key, value]) => `- ${key}: ${current ? `${JSON.stringify(current[key] ?? null)} -> ` : ""}${JSON.stringify(value)}`)].join("\n");
}

export function registerPurchaseOrderPrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  for (const mode of ["create", "update"] as const) {
    primitives.register(`${mode}_purchase_order`, {
      title: `${mode} a purchase order`, description: "Stage a pending purchase order or sparse metadata edits to an open order. Supplier identity is immutable. Lifecycle transitions use dedicated actions.",
      inputSchema: mode === "create" ? { ...planInputFields, supplier_id: entityIdSchema(), ...orderFields }
        : { ...planInputFields, order_id: entityIdSchema(), changes: sparseOrder },
      annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
    }, async (input, extra) => safely(oauth, async () => {
      const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
      const context = new OrderContext(oauth, auth, client, input.plan_id);
      const raw = record(input);
      const current = mode === "update" ? await context.item("purchase_order", raw.order_id as EntityId) : undefined;
      if (current) ensureOpen(current.data);
      const source = mode === "create" ? Object.fromEntries(Object.keys(orderFields).map((key) => [key, raw[key]])) : record(raw.changes);
      if (!Object.keys(source).length) throw new Error("At least one order change is required");
      const body = await context.fields(source);
      if (mode === "create") body.supplier = mutationValue((await context.supplier(raw.supplier_id as EntityId)).id);
      else await context.supplier(entityValue(current!.data.supplier));
      if (body.reference !== undefined) await context.uniqueReference(String(body.reference), current?.id);
      const changed = diffs(current?.data, body);
      if (!Object.keys(changed).length) return result({ status: "already_current" }, "Purchase-order metadata is already current");
      const display = String(body.reference ?? current!.display);
      return stageMutation(oauth, auth, input, summary(`${mode} purchase order ${display}`, changed, current?.data),
        [{ method: current ? "PATCH" : "POST", path: current ? mutationPath(paths.purchase_order, current.id) : paths.purchase_order, body: changed }],
        context.checks, current ? undefined : [{ name: "purchase_order", entityType: "purchase_order", requestIndex: 0,
          responsePaths: [["pk"]], display, metadata: { ...body, status: 10 } }]);
    }));

    primitives.register(`${mode}_purchase_order_line`, {
      title: `${mode} a purchase-order line`, description: "Stage a supplier-part line or sparse edits to its quantity, price, and delivery metadata. Order and supplier-part identity are immutable on updates. Creates never silently merge lines. Quantities and prices use supplier packs.",
      inputSchema: mode === "create" ? { ...planInputFields, order_id: entityIdSchema(), supplier_part_id: entityIdSchema(), ...lineFields }
        : { ...planInputFields, line_item_id: entityIdSchema(), changes: sparseLine },
      annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
    }, async (input, extra) => safely(oauth, async () => {
      const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
      const context = new OrderContext(oauth, auth, client, input.plan_id);
      const raw = record(input);
      const current = mode === "update" ? await context.item("purchase_order_line", raw.line_item_id as EntityId) : undefined;
      const order = await context.item("purchase_order", current ? entityValue(current.data.order) : raw.order_id as EntityId);
      ensureOpen(order.data);
      await context.supplier(entityValue(order.data.supplier));
      const source = await context.source(order.data, current ? entityValue(current.data.part) : raw.supplier_part_id as EntityId);
      const values = mode === "create" ? Object.fromEntries(Object.keys(lineFields).map((key) => [key, raw[key]])) : record(raw.changes);
      if (!Object.keys(values).length) throw new Error("At least one line change is required");
      const body = await context.fields(values);
      if (body.quantity !== undefined && sumExceeds([numberValue(current?.data.received)], Number(body.quantity))) throw new Error("Ordered quantity cannot be less than the quantity already received");
      if (!current) Object.assign(body, { order: mutationValue(order.id), part: mutationValue(source.id), merge_items: false });
      const changed = diffs(current?.data, body);
      if (!Object.keys(changed).length) return result({ status: "already_current" }, "Purchase-order line is already current");
      const display = `${order.display}: ${source.part.display}, SKU ${source.display}`;
      // InvenTree's line serializer requires both parent identities even for a
      // partial update. Supply the frozen, validated IDs without exposing moves.
      const requestBody = current ? { ...changed, order: mutationValue(order.id), part: mutationValue(source.id) } : changed;
      return stageMutation(oauth, auth, input, summary(`${mode} purchase-order line ${display} (supplier-pack units)`, changed, current?.data),
        [{ method: current ? "PATCH" : "POST", path: current ? mutationPath(paths.purchase_order_line, current.id) : paths.purchase_order_line, body: requestBody }],
        context.checks, current ? undefined : [{ name: "purchase_order_line", entityType: "purchase_order_line", requestIndex: 0,
          responsePaths: [["pk"]], display, metadata: { ...body, received: 0 } }]);
    }));
  }

  for (const action of ["issue", "hold", "cancel", "complete"] as const) {
    primitives.register(`${action}_purchase_order`, {
      title: `${action} a purchase order`, description: `Stage the dedicated ${action} transition. Issuing records placement with the supplier in InvenTree; it does not transmit a supplier order. Completing can explicitly accept unreceived quantities without creating stock.`,
      inputSchema: { ...planInputFields, order_id: entityIdSchema(), ...(action === "complete" ? { accept_incomplete: z.boolean().default(false) } : {}) },
      annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
    }, async (input, extra) => safely(oauth, async () => {
      const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
      const context = new OrderContext(oauth, auth, client, input.plan_id);
      const order = await context.item("purchase_order", input.order_id);
      const status = numberValue(order.data.status);
      if (status === states[action]) return result({ status: "already_current" }, `Purchase order is already ${action === "issue" ? "placed" : action === "hold" ? "on hold" : action === "complete" ? "complete" : "cancelled"}`);
      const eligible = action === "issue" ? [10, 25] : action === "hold" ? [10, 20] : action === "complete" ? [20] : open;
      if (!eligible.includes(status)) throw new Error(`Cannot ${action} purchase order in status ${status}`);
      const lines = await context.lines(order.id);
      if (action === "issue") {
        if (!lines.length) throw new Error("Cannot issue a purchase order with no lines");
        await context.supplier(entityValue(order.data.supplier));
        for (const line of lines) await context.source(order.data, entityValue(line.data.part));
      }
      const incomplete = lines.filter((line) => numberValue(line.data.received) < numberValue(line.data.quantity));
      const accept = record(input).accept_incomplete === true;
      if (action === "complete" && incomplete.length && !accept) throw new Error("Purchase order has unreceived quantities; receive them or explicitly set accept_incomplete:true");
      return stageMutation(oauth, auth, input, [
        `${action} purchase order ${order.display}: status ${status} -> ${states[action]}`,
        ...lines.map((line) => `- Line ${line.id}: ordered ${line.data.quantity}, received ${line.data.received ?? 0} supplier packs`),
        ...(action === "complete" && accept ? ["- Close with unreceived quantities accepted; this does not create stock."] : []),
      ].join("\n"), [{ method: "POST", path: mutationPath(paths.purchase_order, order.id, `/${action}/`),
        body: action === "complete" ? { accept_incomplete: accept } : {} }], context.checks);
    }));
  }

  primitives.register("receive_purchase_order", {
    title: "Receive stock against purchase-order lines",
    description: "Stage partial or full receipts against a placed order. Updates order-line received quantities and creates sourced stock linked to the order. Quantities are supplier packs; InvenTree converts to canonical stock units. May automatically complete the order; make this the final action for that order and verify afterward. Declares no stock outputs.",
    inputSchema: { ...planInputFields, order_id: entityIdSchema(), location_id: entityIdSchema().optional(), allow_over_receipt: z.boolean().default(false),
      items: z.array(z.object({ line_item_id: entityIdSchema(),
        quantity: positiveQuantity.refine((value) => /^\d{1,10}(?:\.\d{1,5})?$/.test(String(value)), "Receipt quantity supports at most 10 integer digits and 5 decimal places"),
        location_id: entityIdSchema().optional(), batch: z.string().max(100).optional(), expiry_date: date,
        packaging: z.string().max(50).optional(), notes: z.string().max(10000).optional(),
        status: z.enum(["ok", "attention_needed", "damaged", "destroyed", "rejected", "lost", "quarantined", "returned"]).default("ok"),
        serial_numbers: z.string().max(10000).optional().describe("InvenTree serial expression; the server validates quantity, uniqueness, and serialization rules at commit"),
      }).strict()).min(1).max(30) }, annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
    const context = new OrderContext(oauth, auth, client, input.plan_id);
    const order = await context.item("purchase_order", input.order_id);
    if (numberValue(order.data.status) !== 20) throw new Error("Purchase order must be placed before receiving; stage issue_purchase_order first");
    await context.supplier(entityValue(order.data.supplier));
    const globalLocation = input.location_id === undefined ? undefined : await context.location(input.location_id);
    const items: JsonRecord[] = [];
    const review = [`Receive against purchase order ${order.display}`];
    const seen = new Set<string>();
    const sourceStatuses = new Map<number | string, Set<number>>();
    const serializedStatuses = new Map<number | string, number>();
    for (const item of input.items) {
      const line = await context.item("purchase_order_line", item.line_item_id);
      if (seen.has(String(line.id))) throw new Error("Each purchase-order line can appear only once in a receipt");
      seen.add(String(line.id));
      if (!sameEntity(line.data.order, mutationValue(order.id))) throw new Error("Line item does not belong to this purchase order");
      if (line.data.build_order) throw new Error("External-build purchase receipts need a dedicated build workflow and are not supported");
      const source = await context.source(order.data, entityValue(line.data.part));
      const status = STATUS_CODES[item.status];
      const statuses = sourceStatuses.get(source.id) ?? new Set<number>();
      statuses.add(status);
      sourceStatuses.set(source.id, statuses);
      if (item.serial_numbers && status !== STATUS_CODES.ok && !source.part.data.virtual) serializedStatuses.set(source.id, status);
      const remaining = Number((numberValue(line.data.quantity) - numberValue(line.data.received)).toPrecision(15));
      if (sumExceeds([numberValue(line.data.received), item.quantity], numberValue(line.data.quantity)) && !input.allow_over_receipt) throw new Error(`Receipt exceeds remaining ${remaining} supplier packs; use allow_over_receipt:true only for an explicitly reviewed excess delivery`);
      const destination = item.location_id ?? globalLocation?.id ?? (line.data.destination ? entityValue(line.data.destination) : undefined)
        ?? (order.data.destination ? entityValue(order.data.destination) : undefined);
      if (destination === undefined) throw new Error("A receipt destination is required; specify location_id or an order/line destination");
      const location = await context.location(destination);
      // Native conversion comes from the current server state. Earlier edits to
      // the pack or canonical units can invalidate it before this receipt runs.
      const conversionChanged = context.steps.some((step) => step.requests.some((request) => request.method === "PATCH" && (
        (sameEntity(request.path, mutationPath("/api/company/part/", source.id)) && record(request.body).pack_quantity !== undefined) ||
        (sameEntity(request.path, mutationPath("/api/part/", source.part.id)) && record(request.body).units !== undefined)
      )));
      const factor = !conversionChanged && source.data.pack_quantity_native !== undefined ? Number(source.data.pack_quantity_native)
        : source.data.pack_quantity ? Number(source.data.pack_quantity) : 1;
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("Cannot determine supplier pack conversion; commit sourcing first and discover its native pack quantity before receiving");
      const stockQuantity = Number((item.quantity * factor).toPrecision(15));
      if (!Number.isFinite(stockQuantity)) throw new Error("Converted stock quantity is not finite");
      items.push({ line_item: mutationValue(line.id), quantity: String(item.quantity), location: mutationValue(location.id),
        status: STATUS_CODES[item.status], ...(item.batch === undefined ? {} : { batch_code: item.batch }),
        ...(item.expiry_date === undefined ? {} : { expiry_date: item.expiry_date }),
        ...(item.packaging === undefined ? {} : { packaging: item.packaging }),
        ...(item.notes === undefined ? {} : { note: item.notes }),
        ...(item.serial_numbers === undefined ? {} : { serial_numbers: item.serial_numbers }) });
      review.push(`- Line ${line.id}: ${source.part.display}; SKU ${source.display}; receive ${item.quantity} supplier packs (${source.data.pack_quantity || "1"} per pack) -> ${source.part.data.virtual ? "no physical stock (virtual part)" : `${stockQuantity} ${source.part.data.units || "canonical units"}`}; ${location.display}; received ${line.data.received ?? 0} -> ${Number((numberValue(line.data.received) + item.quantity).toPrecision(15))}`,
        ...Object.entries(item).filter(([key]) => !["line_item_id", "quantity", "location_id"].includes(key)).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
    }
    if (input.allow_over_receipt) review.push("- Excess receipts explicitly allowed.");
    review.push("- Create purchase-order-linked stock; the server may automatically complete a fully received order.");
    const requests: MutationRequest[] = [{ method: "POST", path: mutationPath(paths.purchase_order, order.id, "/receive/"), body: { items }, purchaseReceipt: true }];
    const corrections = new Map<number, Array<number | string>>();
    for (const [source, status] of serializedStatuses) {
      if (sourceStatuses.get(source)!.size > 1) throw new Error("Serialized receipts with a non-OK status require the same status for every line of that supplier part; use separate receipt plans for different statuses");
      const sources = corrections.get(status) ?? [];
      sources.push(source);
      corrections.set(status, sources);
    }
    for (const [status, sources] of corrections) {
      requests.push({ method: "POST", path: "/api/stock/change_status/", body: { supplier_parts: sources.map(mutationValue), status }, stockStatusFromReceipt: { requestIndex: 0 } });
    }
    if (corrections.size) review.push("- Verify serialized stock status after receipt and correct it if needed. If correction fails, the receipt is already recorded; inspect the created stock before preparing a recovery plan.");
    return stageMutation(oauth, auth, input, review.join("\n"),
      requests, context.checks);
  }));
}
