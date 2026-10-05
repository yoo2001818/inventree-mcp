import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { catalogPaths, type CatalogEntityType } from "../catalogDomain.js";
import { DomainError, notFound } from "../domainErrors.js";
import { numberValue, pageResults, record, type JsonRecord } from "../inventoryDomain.js";
import { InvenTreeClient, InvenTreeError } from "../inventree.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import { digest, reviewPlan } from "../mutationPlans.js";
import type { OAuthService } from "../oauth.js";
import type { MutationCheck, MutationRequest } from "../store.js";
import {
  entityIdSchema, ensureUnlocked, mutationAnnotations, mutationPath, mutationValue,
  normalizeEntityId, nullableEntityIdSchema, planInputFields, plannedOutput, stageMutation,
  type EntityId, type PlanInput, type MutationPrimitiveRegistry,
} from "./shared.js";

const name = z.string().trim().min(1).max(100);
const description = z.string().max(250);
const link = z.union([z.string().url().max(2000), z.literal("")]);
const companyFields = {
  name, description: z.string().max(500).default(""), is_supplier: z.boolean().default(false),
  is_manufacturer: z.boolean().default(false), active: z.boolean().default(true),
  website: link.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(), phone: z.string().max(50).optional(),
};
const manufacturerFields = {
  part_id: entityIdSchema(), manufacturer_id: entityIdSchema(), MPN: name,
  description: description.optional(), link: link.optional(),
};
const supplierFields = {
  part_id: entityIdSchema(), supplier_id: entityIdSchema(), SKU: name,
  manufacturer_part_id: nullableEntityIdSchema().optional(),
  description: description.optional(), link: link.optional(), packaging: z.string().max(50).optional(),
  pack_quantity: z.string().trim().min(1).max(25).optional().describe("InvenTree pack quantity, e.g. 1, 100, or 30 ml; stock quantities use canonical part units"),
  active: z.boolean().default(true), note: z.string().max(100).optional(),
};
const templateFields = {
  name, units: z.string().max(25).default(""), description: description.default(""),
  choices: z.string().max(5000).optional().describe("Comma-separated allowed values, e.g. X7R,X5R,C0G"),
  checkbox: z.boolean().default(false), enabled: z.boolean().default(true),
};
const fields = { company: companyFields, manufacturer_part: manufacturerFields,
  supplier_part: supplierFields, parameter_template: templateFields };
const foreignKeys: Record<string, [string, CatalogEntityType]> = {
  part_id: ["part", "part"], manufacturer_id: ["manufacturer", "company"],
  supplier_id: ["supplier", "company"], manufacturer_part_id: ["manufacturer_part", "manufacturer_part"],
};
const discovery = { part: "find_parts", company: "list_companies", manufacturer_part: "find_manufacturer_parts",
  supplier_part: "find_supplier_parts", parameter_template: "list_parameter_templates" };

// All reads are also frozen commit preconditions. Earlier staged PATCHes are
// overlaid for validation so role/flag changes work in an ordered plan.
export class CatalogContext {
  readonly checks: MutationCheck[] = [];
  constructor(readonly oauth: OAuthService, readonly auth: AuthInfo,
    readonly client: InvenTreeClient, readonly planId?: string) {}

  get steps() { return this.planId ? reviewPlan(this.oauth, this.auth, this.planId).plan.steps : []; }

  async read(path: string, query?: Record<string, unknown>) {
    const data = await this.client.get(path, query);
    this.checks.push({ path, ...(query ? { query } : {}), digest: digest(data) });
    return data;
  }

  async entity(type: CatalogEntityType, value: EntityId) {
    const id = normalizeEntityId(value);
    const output = plannedOutput(this.oauth, this.auth, this.planId, id, type);
    let data: JsonRecord;
    if (typeof id === "number") {
      try { data = record(await this.read(`${catalogPaths[type]}${id}/`)); }
      catch (error) {
        if (error instanceof InvenTreeError && error.status === 404) {
          throw notFound(type, { supplied_id: id }, discovery[type], `${type} #${id} was not found. Use ${discovery[type]}.`);
        }
        throw error;
      }
    } else data = { ...output!.metadata };
    for (const step of this.steps) {
      for (const request of step.requests) {
        if (request.method === "PATCH" && digest(request.path) === digest(mutationPath(catalogPaths[type], id))) {
          data = { ...data, ...record(request.body) };
        }
      }
    }
    return { id, data, display: output?.display ?? String(data.name ?? data.MPN ?? data.SKU ?? `${type} #${id}`) };
  }
}

export function sameEntity(left: unknown, right: unknown) {
  return digest(left ?? null) === digest(right ?? null);
}

function conflict(message: string, candidates: unknown[] = []) {
  return new DomainError({ status: "conflict", conflict_type: "catalog_duplicate", candidates }, message);
}

async function checkUnique(context: CatalogContext, type: Exclude<CatalogEntityType, "part">,
  body: JsonRecord, excludeId?: number | string) {
  const keys = type === "company" || type === "parameter_template" ? ["name"]
    : type === "manufacturer_part" ? ["part", "manufacturer", "MPN"] : ["part", "supplier", "SKU"];
  const query = Object.fromEntries(keys.map((key) => [key, body[key]]));
  const identityMatches = (candidate: JsonRecord) => keys.every((key) =>
    key === "name" ? String(candidate[key]).toLowerCase() === String(body[key]).toLowerCase()
      : sameEntity(candidate[key], body[key]));
  const concrete = keys.every((key) => typeof body[key] !== "object");
  if (concrete) {
    // Template name collisions are checked across scopes to make discovery unambiguous.
    const lookup = type === "company" || type === "parameter_template" ? { search: body.name } : query;
    const data = await context.read(catalogPaths[type], { ...lookup, limit: 100, offset: 0 });
    const candidates = pageResults(data).filter((item) => numberValue(item.pk) !== excludeId && identityMatches(item));
    if (candidates.length || numberValue(record(data).count) > pageResults(data).length) {
      throw conflict(`A matching ${type} already exists; reuse its ID or update it.`, candidates.map((item) => ({ id: item.pk, name: item.name ?? item.MPN ?? item.SKU })));
    }
  }
  for (const step of context.steps) {
    for (const request of step.requests) {
      const updatedId = request.method === "PATCH" && typeof request.path === "string" && request.path.startsWith(catalogPaths[type])
        ? request.path.slice(catalogPaths[type].length).match(/^([0-9]+)\/$/)?.[1] : undefined;
      if (updatedId && Number(updatedId) !== excludeId) {
        const candidate = (await context.entity(type, Number(updatedId))).data;
        if (identityMatches(candidate)) {
          throw conflict(`A matching ${type} is already staged in this plan; choose a different identity.`);
        }
      }
      if (request.method !== "POST" || request.path !== catalogPaths[type]) continue;
      const output = step.outputs.find((item) => item.entityType === type);
      if (output?.ref === excludeId) continue;
      let candidate = record(request.body);
      if (output) candidate = (await context.entity(type, output.ref)).data;
      if (identityMatches(candidate)) {
        throw conflict(`A matching ${type} is already staged in this plan; reuse its output reference.`);
      }
    }
  }
}

async function validateRelations(context: CatalogContext, type: string, body: JsonRecord) {
  if (type === "company" && body.is_supplier !== true && body.is_manufacturer !== true) {
    throw new Error("A company must be a supplier, a manufacturer, or both");
  }
  if (type !== "manufacturer_part" && type !== "supplier_part") return;
  const partId = typeof body.part === "object" ? String(record(body.part).__planRef) : Number(body.part);
  const part = await context.entity("part", partId);
  ensureUnlocked(part.data);
  const role = type === "manufacturer_part" ? "manufacturer" : "supplier";
  const companyId = typeof body[role] === "object" ? String(record(body[role]).__planRef) : Number(body[role]);
  const company = await context.entity("company", companyId);
  if (company.data[`is_${role}`] !== true) throw new Error(`${company.display} is not marked as a ${role}`);
  if (company.data.active === false) throw new Error(`${company.display} is inactive`);
  if (type === "supplier_part") {
    if (part.data.purchaseable === false) throw new Error(`${part.display} is not purchaseable; update the part first`);
    if (body.manufacturer_part !== undefined && body.manufacturer_part !== null) {
      const manufacturerId = typeof body.manufacturer_part === "object"
        ? String(record(body.manufacturer_part).__planRef) : Number(body.manufacturer_part);
      const manufacturer = await context.entity("manufacturer_part", manufacturerId);
      if (!sameEntity(manufacturer.data.part, body.part)) {
        throw new Error("The supplier part and manufacturer part must refer to the same canonical part");
      }
    }
  }
}

export function registerCatalogPrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService) {
  for (const type of Object.keys(fields) as Array<keyof typeof fields>) {
    const createShape = fields[type];
    const updateShape = Object.fromEntries(Object.entries(createShape)
      .filter(([key]) => key !== "part_id").map(([key, schema]) => [key, schema.optional()]));
    for (const mode of ["create", "update"] as const) {
      primitives.register(`${mode}_${type}`, {
        title: `${mode} ${type.replaceAll("_", " ")}`,
        description: `Stage ${mode === "create" ? "creation of" : "a sparse update to"} an InvenTree ${type}. ${type === "parameter_template" ? "Templates define part attributes; updates affect every use of the template." : "Canonical parts keep readable names; sourcing identifiers live on linked records."}`,
        inputSchema: mode === "create" ? { ...planInputFields, ...createShape }
          : { ...planInputFields, [`${type}_id`]: entityIdSchema(), changes: z.object(updateShape).strict() },
        annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
      }, async (input, extra) => safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const context = new CatalogContext(oauth, auth, client, input.plan_id);
        const rawInput = record(input);
        const existing = mode === "update" ? await context.entity(type, rawInput[`${type}_id`] as EntityId) : undefined;
        const source = mode === "update" ? record(rawInput.changes) : rawInput;
        const body: JsonRecord = {};
        const labels: JsonRecord = {};
        for (const key of Object.keys(mode === "update" ? updateShape : createShape)) {
          if (source[key] === undefined) continue;
          const foreign = foreignKeys[key];
          if (foreign) {
            const value = source[key] === null ? null : await context.entity(foreign[1], source[key] as EntityId);
            body[foreign[0]] = value ? mutationValue(value.id) : null;
            labels[foreign[0]] = value ? `${value.display} (${typeof value.id === "number" ? `#${value.id}` : `ref ${value.id}`})` : null;
          } else { body[key] = source[key]; labels[key] = source[key]; }
        }
        if (!Object.keys(body).length) throw new Error("At least one change is required");
        if (type === "parameter_template" && mode === "create") body.model_type = "part";
        const effective = { ...existing?.data, ...body };
        await validateRelations(context, type, effective);
        await checkUnique(context, type, effective, existing?.id);
        const changed = Object.keys(body).filter((key) => !existing || !sameEntity(existing.data[key], body[key]));
        if (!changed.length) return result({ status: "already_current" }, "The requested values are already current.");
        const display = String(effective.name ?? effective.MPN ?? effective.SKU);
        const summary = [`${mode === "create" ? "Create" : "Update"} ${type}: ${existing?.display ?? display}`,
          ...changed.map((key) => `- ${key}: ${existing ? `${JSON.stringify(existing.data[key] ?? null)} -> ` : ""}${JSON.stringify(labels[key] ?? body[key])}`)].join("\n");
        return stageMutation(oauth, auth, input as PlanInput, summary,
          [{ method: mode === "create" ? "POST" : "PATCH", path: existing ? mutationPath(catalogPaths[type], existing.id) : catalogPaths[type], body }],
          context.checks, mode === "create" ? [{ name: type, entityType: type, requestIndex: 0,
            responsePaths: [["pk"]], display, metadata: body }] : undefined);
      }));
    }
  }

  primitives.register("set_part_parameters", {
    title: "Set canonical part parameters",
    description: "Stage creation or update of part parameter values by template ID. Preserve unspecified values and notes. Resolve templates with list_parameter_templates or create them earlier in the same plan.",
    inputSchema: { ...planInputFields, part_id: entityIdSchema(),
      parameters: z.array(z.object({ template_id: entityIdSchema(), data: z.string().min(1).max(500),
        note: z.string().max(500).optional() }).strict()).min(1).max(30) },
    annotations: mutationAnnotations(), _meta: { securitySchemes: WRITE_SECURITY },
  }, async (input, extra) => safely(oauth, async () => {
    const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
    const context = new CatalogContext(oauth, auth, client, input.plan_id);
    const part = await context.entity("part", input.part_id);
    ensureUnlocked(part.data);
    const requests: MutationRequest[] = [];
    const lines = [`Set parameters for ${part.display}`];
    const seen = new Set<string>();
    for (const parameter of input.parameters) {
      const template = await context.entity("parameter_template", parameter.template_id);
      const key = String(template.id);
      if (seen.has(key)) throw new Error(`Duplicate template ${key} in parameters`);
      seen.add(key);
      if (template.data.enabled === false) throw new Error(`${template.display} is disabled`);
      if (template.data.model_type && !["part", "part.part"].includes(String(template.data.model_type))) throw new Error(`${template.display} does not apply to parts`);
      const choices = String(template.data.choices ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (choices.length && !choices.includes(parameter.data)) throw new Error(`${template.display} requires one of: ${choices.join(", ")}`);
      if (template.data.checkbox === true && !["true", "false"].includes(parameter.data.toLowerCase())) throw new Error(`${template.display} requires true or false`);
      const target = { model_type: "part", model_id: mutationValue(part.id), template: mutationValue(template.id) };
      // A second setter against the same target could otherwise stage two POSTs.
      if (context.steps.some((step) => step.requests.some((request) => request.path === "/api/parameter/" &&
        Object.entries(target).every(([field, value]) => sameEntity(record(request.body)[field], value))))) {
        throw new Error(`${template.display} already has a value staged for this part; include each template once per plan`);
      }
      const source = typeof part.id === "number" && typeof template.id === "number"
        ? await context.read("/api/parameter/", { ...target, limit: 2, offset: 0 }) : { results: [] };
      const matches = pageResults(source);
      if (matches.length > 1 || numberValue(record(source).count) > 1) throw conflict(`Multiple values exist for ${template.display}; resolve them in InvenTree first`);
      const previous = matches[0];
      if (previous && context.steps.some((step) => step.requests.some((request) => request.path === `/api/parameter/${numberValue(previous.pk)}/`))) {
        throw new Error(`${template.display} already has a value staged for this part; include each template once per plan`);
      }
      const body = { data: parameter.data, ...(parameter.note !== undefined ? { note: parameter.note } : {}) };
      if (previous && Object.entries(body).every(([field, value]) => sameEntity(previous[field], value))) continue;
      requests.push(previous ? { method: "PATCH", path: `/api/parameter/${numberValue(previous.pk)}/`, body }
        : { method: "POST", path: "/api/parameter/", body: { ...target, ...body },
          ...(typeof part.id === "string" ? { parameterUpsert: true as const } : {}) });
      lines.push(`- ${template.display} (template ${typeof template.id === "number" ? `#${template.id}` : `ref ${template.id}`}): ${typeof part.id === "string" ? "set after creation, including inherited defaults" : JSON.stringify(previous?.data ?? null)} -> ${JSON.stringify(parameter.data)}${template.data.units ? ` [${template.data.units}]` : ""}${parameter.note !== undefined ? `; note: ${JSON.stringify(previous?.note ?? "")} -> ${JSON.stringify(parameter.note)}` : ""}`);
    }
    if (!requests.length) return result({ status: "already_current" }, "All requested parameter values are already current.");
    return stageMutation(oauth, auth, input, lines.join("\n"), requests, context.checks);
  }));
}
