# Sourcing and part specifications

A canonical InvenTree Part describes an interchangeable item. Its name should describe the specifications the owner uses: **10nF 50V X7R 0603**. The name is user-controlled; the connector does not infer equivalence or rename existing inventory automatically. Manufacturer-specific qualifications or specifications can require separate canonical parts.

ManufacturerPart links the canonical part to a manufacturer company and an MPN such as `0603B103K500NT`. SupplierPart links it to a supplier company and SKU such as LCSC's `C57112`, optionally referencing the ManufacturerPart. Multiple MPNs and supplier SKUs can reference one canonical part. Never use a supplier-part ID where a canonical-part ID is required.

These follow InvenTree's [company and sourcing APIs](https://docs.inventree.org/en/stable/api/schema/company/) and [parameter APIs](https://docs.inventree.org/en/stable/api/schema/general/). The implementation uses `/api/parameter/` and `/api/parameter/template/`, as in the repository's API 511 reference schema. Older instances with only legacy `/api/part/parameter/` endpoints require an API adapter and are not supported by these parameter tools. Upstream user permissions still apply; creating or editing parameter templates requires appropriate staff privileges.

## Read contracts

All collections expose `count`, `offset`, `results`, and `nextCursor` when more records exist. Pass the cursor with the same filters. The default page size is 20 and the maximum is 100; `find_parts` retains its maximum of 20.

| Tool | Filters or purpose |
| --- | --- |
| `list_companies` | `query`, `role: any/supplier/manufacturer`, optional `active` |
| `find_manufacturer_parts` | `query`, `part_id`, `manufacturer_id`, exact `MPN` |
| `find_supplier_parts` | `query`, `part_id`, `supplier_id`, `manufacturer_id`, `manufacturer_part_id`, exact `SKU`, optional `active` |
| `get_part_sourcing` | Canonical `part_id`; independent `manufacturer_cursor` and `supplier_cursor` |
| `list_parameter_templates` | `query`, optional `enabled`; includes global and part-scoped templates |
| `get_part_parameters` | Canonical `part_id`, values, units, notes, and template IDs |
| `get_part_inventory` | `include: ["parameters"]` includes normalized specifications and a parameter page cursor |
| `find_parts` | Text search finds names, MPNs, and SKUs; `parameters` adds structured AND filters |

Example specification search, after resolving template IDs:

```json
{
  "parameters": [
    { "template_id": 801, "value": "10nF" },
    { "template_id": 802, "value": "0603" },
    { "template_id": 806, "value": "50V", "operator": "gte" }
  ]
}
```

`query` can be omitted when a category or parameter filter is supplied. Supported operators are `eq` (default), `ne`, `gt`, `gte`, `lt`, `lte`, and `icontains`. InvenTree performs numeric comparisons and unit conversion using the template's units. Two bounds on the same template are allowed; duplicate template/operator pairs are rejected.

## Staged action contracts

These are actions inside `create_inventory_plan`, not separately callable MCP tools. Use at most 30 ordered steps. Staging performs reads and writes only temporary bridge state; review the complete result once before committing.

| Action | Arguments | Output |
| --- | --- | --- |
| `create_company` | `name`, at least one of `is_supplier` / `is_manufacturer`; optional description, website, currency, email, phone, active | `company` |
| `update_company` | `company_id`, sparse `changes` with the same editable fields | None |
| `create_manufacturer_part` | `part_id`, `manufacturer_id`, `MPN`; optional description, link | `manufacturer_part` |
| `update_manufacturer_part` | `manufacturer_part_id`, sparse `changes`; canonical `part_id` is immutable | None |
| `create_supplier_part` | `part_id`, `supplier_id`, `SKU`; optional `manufacturer_part_id`, description, link, packaging, pack_quantity, active, note | `supplier_part` |
| `update_supplier_part` | `supplier_part_id`, sparse `changes`; canonical `part_id` is immutable; `manufacturer_part_id: null` removes that link | None |
| `create_parameter_template` | `name`; optional units, description, choices, checkbox, enabled; creates a part-scoped template | `parameter_template` |
| `update_parameter_template` | `parameter_template_id`, sparse `changes` to those fields; updates affect every use of the template | None |
| `set_part_parameters` | `part_id`, `parameters: [{template_id, data, note?}]` | None |
| `update_part` | `part_id`, sparse `changes`, including name, description, IPN, category, notes, and flags | None |
| `update_stock` | `stock_item_id`, sparse `changes: {supplier_part_id?, batch?, packaging?, expiry_date?, notes?, link?}` | None |

Existing positive IDs, numeric ID strings, and references to earlier steps are accepted for entity selectors. Reference outputs by their exact name, for example `{"step":"maker","output":"company"}`. Create/update part actions also expose `assembly`, `component`, and `purchaseable` flags.

Company roles and activity, unlocked canonical parts, and sourcing relations are validated. A supplier's ManufacturerPart must reference the same canonical Part. Duplicate identities are rejected, including duplicate creates already staged in the same plan. Reuse discovered IDs instead of creating them again. Template-name collisions are checked across scopes. No delete actions are exposed.

`set_part_parameters` creates missing values and patches existing values. Unspecified values and notes remain intact; send `note: ""` to clear a note. A new part can inherit parameter rows from its category: setters resolve those rows after part creation and update them instead of creating duplicates. Values are strings, limited to 500 characters; parameter notes also have a 500-character limit. Disabled or non-part templates, repeated setters for one template/part in a plan, invalid choices, and invalid checkbox inputs are rejected. Upstream unit, currency, selection-list, and plugin validation still runs at commit. As with other inventory plans, upstream failures may leave a partially applied plan; inspect the recorded failure before preparing corrective changes.

`receive_stock` accepts optional `supplier_part_id`. Stock quantities are in canonical part units; `pack_quantity` describes how a supplier sells that part and does not multiply a receipt quantity automatically. Stock from different supplier parts, or stock with unknown provenance, is not merged together. With `merge: "compatible"`, a receipt with a different source creates a new stock item. `merge: "stock_item"` rejects a provenance mismatch. For a newly created canonical part, use `merge: "new_item"`. To create sourced initial stock, create the part without `initial_stock`, link its sourcing records, then use `receive_stock`.

## Example capacitor plan

The category, company, and template IDs below are illustrative. Resolve the actual IDs first with the read tools. This example assumes supplier #501, manufacturer #502, category #15, and templates #801 (capacitance), #802 (package), #803 (dielectric), and #806 (voltage) already exist.

```json
{
  "operation_id": "capacitor-intake-001",
  "steps": [
    {
      "key": "capacitor",
      "action": "create_part_with_stock",
      "arguments": { "part": { "name": "10nF 50V X7R 0603", "category_id": 15 } }
    },
    {
      "key": "mpn",
      "action": "create_manufacturer_part",
      "arguments": {
        "part_id": { "step": "capacitor", "output": "part" },
        "manufacturer_id": 502,
        "MPN": "0603B103K500NT"
      }
    },
    {
      "key": "sku",
      "action": "create_supplier_part",
      "arguments": {
        "part_id": { "step": "capacitor", "output": "part" },
        "supplier_id": 501,
        "manufacturer_part_id": { "step": "mpn", "output": "manufacturer_part" },
        "SKU": "C57112"
      }
    },
    {
      "key": "specs",
      "action": "set_part_parameters",
      "arguments": {
        "part_id": { "step": "capacitor", "output": "part" },
        "parameters": [
          { "template_id": 801, "data": "10nF" },
          { "template_id": 802, "data": "0603" },
          { "template_id": 803, "data": "X7R" },
          { "template_id": 806, "data": "50V" }
        ]
      }
    },
    {
      "key": "receipt",
      "action": "receive_stock",
      "arguments": {
        "part_id": { "step": "capacitor", "output": "part" },
        "supplier_part_id": { "step": "sku", "output": "supplier_part" },
        "location_id": 81,
        "quantity": 100,
        "merge": "new_item"
      }
    }
  ]
}
```

Companies and parameter templates can also be created in earlier steps, then referenced via `company` and `parameter_template` outputs. Existing parts can be renamed through `update_part` and linked to sourcing records without changing stock quantities. This release does not migrate existing identifiers automatically.

## Migrate an existing part and stock

Use one plan to rename the existing canonical Part, preserve its old identifier in a ManufacturerPart, add a SupplierPart, set specifications, and link each selected existing stock lot. The original part ID and stock-item IDs remain stable. Supplier links are per stock item: choose only lots whose provenance is known, and include an `update_stock` step for each selected lot. `get_part_inventory` shows at most 100 stock lots without a stock cursor. For complete discovery beyond that limit, page `/api/stock/` through `inventree_get` with the canonical `part`, `in_stock: true`, `limit: 100`, `offset`, and `ordering: "pk"`, advancing the offset until the returned count is covered.

In this example part #42 is currently named `RC0603FR-0710KL`, stock #91 belongs to that part, manufacturer #502 and supplier #501 already exist, and templates #810–814 represent resistance (`ohm`), tolerance (`%`), package, voltage (`V`), and power (`W`). Replace these illustrative IDs and the supplier SKU with discovered records and the actual purchase identifier. The specifications are supplied by the caller.

```json
{
  "operation_id": "migrate-resistor-42-v1",
  "steps": [
    {
      "key": "rename",
      "action": "update_part",
      "arguments": { "part_id": 42, "changes": { "name": "10kΩ ±1% 0603 75V 100mW" } }
    },
    {
      "key": "mpn",
      "action": "create_manufacturer_part",
      "arguments": { "part_id": 42, "manufacturer_id": 502, "MPN": "RC0603FR-0710KL" }
    },
    {
      "key": "sku",
      "action": "create_supplier_part",
      "arguments": {
        "part_id": 42,
        "supplier_id": 501,
        "SKU": "actual-supplier-SKU",
        "manufacturer_part_id": { "step": "mpn", "output": "manufacturer_part" }
      }
    },
    {
      "key": "specs",
      "action": "set_part_parameters",
      "arguments": {
        "part_id": 42,
        "parameters": [
          { "template_id": 810, "data": "10kohm" },
          { "template_id": 811, "data": "1%" },
          { "template_id": 812, "data": "0603" },
          { "template_id": 813, "data": "75V" },
          { "template_id": 814, "data": "100mW" }
        ]
      }
    },
    {
      "key": "stock",
      "action": "update_stock",
      "arguments": {
        "stock_item_id": 91,
        "changes": { "supplier_part_id": { "step": "sku", "output": "supplier_part" } }
      }
    }
  ]
}
```

Review the complete result, then commit using its `plan_id` and `plan_version`. Discover and reuse sourcing records if they already exist. Companies and templates can be created earlier in the same plan. Keep each plan within the 30-step limit.

`update_stock` patches only changed fields. An omitted field is preserved; `supplier_part_id: null` clears provenance, `expiry_date: null` clears expiry, and empty strings clear batch, packaging, notes, or link. Supplier parts must reference the stock's canonical part and be active. Locked canonical parts, missing stock IDs, and mismatched references are rejected during staging. Existing stock is checked again before commit, so concurrent stock edits invalidate the entire plan before any migration step runs.

Part and stock edits return `already_current` when no fields differ. Earlier edits in the same plan are included when computing later diffs. `update_stock` also accepts an earlier `stock_item` output from initial-stock creation or `receive_stock`. Quantity changes use `count_stock`, movements use `move_stock`, and status changes use `set_stock_status`.

## Purchase and build orders

`list_purchase_orders` accepts query, canonical part, supplier, supplier part, status, and outstanding filters. `get_purchase_order` returns one order plus paginated line items. Each line distinguishes its canonical `part.id` from `supplierPartId`, and reports SKU, MPN, ordered/received/outstanding supplier packs, pack conversion, and price/currency. With `include_received_stock: true`, an independent `receivedStock` page reports stock IDs, quantities in canonical units, source links, locations, and unit prices. Continue lines using `cursor` and stock using `stock_cursor`.

`list_build_orders` accepts query, canonical part, status, and outstanding filters. `get_build_order` returns one build plus paginated component requirements with quantities allocated and consumed. Numeric status codes come from InvenTree, including custom statuses.

Purchase writes are dedicated actions inside `create_inventory_plan`: `create_purchase_order`, `update_purchase_order`, `create_purchase_order_line`, `update_purchase_order_line`, `issue_purchase_order`, `hold_purchase_order`, `cancel_purchase_order`, `complete_purchase_order`, and `receive_purchase_order`. Creates declare `purchase_order` and `purchase_order_line` outputs, usable by later steps. Read [the purchase-order recipe](../skills/inventree-inventory/references/purchase-orders.md), also available through `get_inventory_guide {section:"purchase_orders"}`, before composing the workflow.

Suppliers must be active supplier companies; line SupplierParts must belong to the order's supplier and an active, unlocked, purchaseable canonical Part. Parent order and SupplierPart identities are immutable on line edits; the order supplier is immutable. Metadata edits are sparse and terminal orders cannot be edited. New lines never silently merge. `purchase_price` uses exact decimal strings and represents price per supplier pack. Receiving requires a placed order, validates remaining quantities and destinations, creates purchase-order-linked stock, and can automatically complete the order. It must be the final action for that order in the plan. Excess receipts require explicit `allow_over_receipt:true`; completing with unreceived quantities requires `accept_incomplete:true` and creates no stock.

Unlike ordinary `receive_stock`, purchase-order quantities use supplier packs and **are** converted through `pack_quantity` to canonical stock units. A normal `receive_stock` action does **not** update a purchase order's received quantity. Extra charges, deletion, sales orders, and external-build-linked purchase receipts remain unsupported. Build workflows additionally need BOM handling, allocation of concrete stock, output creation, and completion/consumption validation. The raw write escape hatch remains disabled by default.

Serialized receipts with a non-OK status include a conditional stock-status correction after receiving, compensating for servers that drop the requested status. All lines of the same SupplierPart within that receipt must request the same status. A correction failure leaves the receipt recorded; inspect its stock IDs and correct status without receiving again.
