import { z } from "zod";
import {
  displayPath,
  formatRef,
  numberValue,
  optionalString,
  pageResults,
  record,
  stringValue,
} from "../inventoryDomain.js";
import type { OAuthService } from "../oauth.js";
import { clientFor, safely, WRITE_SECURITY } from "../mcpSupport.js";
import type { MutationRequest } from "../store.js";
import {
  MutationPrimitiveRegistry,
  checksFor,
  entitySelectorSchema,
  mutationAnnotations,
  mutationValue,
  planInputFields,
  plannedOutput,
  selectorId,
  stageMutation,
  stockLocationRef,
  stockPartRef,
} from "./shared.js";

export function registerLabelPrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  primitives.register(
    "print_labels",
    {
      title: "Prepare printing inventory labels",
      description: "Resolve an enabled label template by ID, name, or dimensions and prepare a real printer side effect.",
      inputSchema: {
        ...planInputFields,
        entity_type: z.enum(["part", "stock_item", "stock_location"]),
        entities: z.array(entitySelectorSchema).min(1).max(100),
        template: z.string().min(1).describe("Template ID like #20, exact name, or dimensions like 30x15mm"),
        printer: z.string().min(1).default("zebra").describe("InvenTree label printing plugin slug"),
        copies: z.number().int().min(1).max(99).default(1)
          .describe("Number of copies per entity, passed to the printer as number_of_labels"),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const modelType = input.entity_type.replace("_", "");
        const query = { enabled: true, model_type: modelType, limit: 100, offset: 0 };
        const templateData = await client.get("/api/label/template/", query);
        const normalized = input.template.trim().toLocaleLowerCase();
        const templateId = /^#?(\d+)$/.exec(normalized)?.[1];
        const dimension = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*mm$/.exec(normalized);
        const matches = pageResults(templateData).filter((template) => {
          if (templateId) return numberValue(template.pk) === Number(templateId);
          if (dimension) return numberValue(template.width) === Number(dimension[1]) && numberValue(template.height) === Number(dimension[2]);
          return stringValue(template.name).toLocaleLowerCase() === normalized;
        });
        if (matches.length !== 1) {
          const choices = pageResults(templateData)
            .map((template) => `${stringValue(template.name)} (#${numberValue(template.pk)}, ${template.width}x${template.height}mm)`)
            .join(", ");
          throw new Error(`${matches.length ? "Multiple" : "No"} matching enabled templates. Choices: ${choices || "none"}`);
        }
        const template = matches[0]!;
        const entityPaths = {
          part: (id: number) => `/api/part/${id}/`,
          stock_item: (id: number) => `/api/stock/${id}/`,
          stock_location: (id: number) => `/api/stock/location/${id}/`,
        } as const;
        const expectedType = input.entity_type;
        const resolved = await Promise.all(input.entities.map(async (selector) => {
          const id = selectorId(selector);
          const output = plannedOutput(oauth, auth, input.plan_id, id, expectedType);
          if (output) {
            return { item: mutationValue(id), label: output.display, suffix: `ref ${output.ref}` };
          }
          const query = input.entity_type === "stock_item"
            ? { part_detail: true, location_detail: true, path_detail: true }
            : { path_detail: true };
          const numericId = Number(id);
          const value = record(await client.get(entityPaths[input.entity_type](numericId), query));
          let label = optionalString(value.pathstring)
            ? displayPath(stringValue(value.pathstring))
            : optionalString(value.name) ?? optionalString(value.full_name);
          if (input.entity_type === "stock_item") {
            label = `${formatRef(stockPartRef(value))} in ${formatRef(stockLocationRef(value))}`;
          }
          return {
            item: numericId,
            label: label ?? `${input.entity_type} #${numericId}`,
            suffix: input.entity_type === "stock_item" ? `stock #${numericId}` : `#${numericId}`,
          };
        }));
        const summary = [
          `Print ${input.copies} cop${input.copies === 1 ? "y" : "ies"} of ${resolved.length} ${input.entity_type.replaceAll("_", " ")} label${resolved.length === 1 ? "" : "s"}:`,
          ...resolved.map(({ label, suffix }) => `- ${label} (${suffix})`),
          `- Template: ${stringValue(template.name)} (#${numberValue(template.pk)}, ${template.width}x${template.height}mm)`,
          `- Printer plugin: ${input.printer}`,
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          ["/api/label/template/", query],
          ...input.entities.flatMap((selector) => {
            const id = selectorId(selector);
            return typeof id === "number"
              ? [[entityPaths[input.entity_type](id), input.entity_type === "stock_item" ? { part_detail: true, location_detail: true, path_detail: true } : { path_detail: true }] as [string, Record<string, unknown>]]
              : [];
          }),
        ];
        const requests: MutationRequest[] = [{
          method: "POST" as const,
          path: "/api/label/print/",
          body: {
            template: numberValue(template.pk),
            plugin: input.printer,
            items: resolved.map(({ item }) => item),
            number_of_labels: input.copies,
          },
        }];
        return stageMutation(oauth, auth, input, summary, requests, await checksFor(client, checkPaths));
      }),
  );
}

