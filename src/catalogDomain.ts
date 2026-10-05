import { entityRef, numberValue, optionalString, record, type JsonRecord } from "./inventoryDomain.js";

export const catalogPaths = {
  part: "/api/part/",
  company: "/api/company/",
  manufacturer_part: "/api/company/part/manufacturer/",
  supplier_part: "/api/company/part/",
  parameter_template: "/api/parameter/template/",
} as const;
export type CatalogEntityType = keyof typeof catalogPaths;

function linked(item: JsonRecord, field: string, kind: string) {
  return entityRef(item[`${field}_detail`]) ?? (numberValue(item[field])
    ? { id: numberValue(item[field]), name: `${kind} ${numberValue(item[field])}` } : null);
}

export function normalizeCompany(item: JsonRecord) {
  return { id: numberValue(item.pk), name: String(item.name ?? ""),
    description: optionalString(item.description), website: optionalString(item.website),
    active: item.active, isSupplier: item.is_supplier, isManufacturer: item.is_manufacturer,
    currency: optionalString(item.currency) };
}

export function normalizeManufacturerPart(item: JsonRecord) {
  return { id: numberValue(item.pk), part: linked(item, "part", "Part"),
    manufacturer: linked(item, "manufacturer", "Company"), mpn: String(item.MPN ?? ""),
    description: optionalString(item.description), link: optionalString(item.link) };
}

export function normalizeSupplierPart(item: JsonRecord) {
  const manufacturerPart = record(item.manufacturer_part_detail);
  return { id: numberValue(item.pk), part: linked(item, "part", "Part"),
    supplier: linked(item, "supplier", "Company"), sku: String(item.SKU ?? ""),
    manufacturerPartId: numberValue(item.manufacturer_part) || null,
    manufacturer: linked(item, "manufacturer", "Company") ?? linked(manufacturerPart, "manufacturer", "Company"),
    mpn: optionalString(item.MPN) ?? optionalString(manufacturerPart.MPN),
    description: optionalString(item.description), link: optionalString(item.link),
    packaging: optionalString(item.packaging), packQuantity: optionalString(item.pack_quantity) ?? item.pack_quantity,
    packQuantityNative: item.pack_quantity_native,
    active: item.active };
}

export function normalizeParameterTemplate(item: JsonRecord) {
  return { id: numberValue(item.pk), name: String(item.name ?? ""), units: optionalString(item.units),
    description: optionalString(item.description), modelType: item.model_type ?? null,
    choices: optionalString(item.choices), checkbox: item.checkbox, enabled: item.enabled };
}

export function normalizeParameter(item: JsonRecord) {
  const template = record(item.template_detail);
  return { id: numberValue(item.pk), templateId: numberValue(item.template),
    name: optionalString(template.name) ?? `Parameter ${numberValue(item.template)}`,
    units: optionalString(template.units), value: String(item.data ?? ""), note: optionalString(item.note) };
}
