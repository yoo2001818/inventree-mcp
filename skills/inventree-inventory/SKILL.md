---
name: inventree-inventory
description: >-
  Manage InvenTree inventory through its MCP connector: find parts by specifications, record purchases, migrate MPN-named parts, link manufacturers and supplier SKUs, and edit or reconcile stock.
---

# InvenTree inventory

Use the connected InvenTree MCP tools to organize inventory around readable canonical parts. If the connector is unavailable, explain the missing connection; do not replace it with direct database writes or guessed API calls. Tool names may carry a client-specific MCP prefix.

## Model the inventory correctly

- **Part** is the canonical item, such as `10nF 50V X7R 0603` or `10kΩ ±1% 0603 75V 100mW`. Preserve its existing ID when renaming it. Equivalence and specifications must come from the user or reliable supplied evidence; an MPN alone does not establish interchangeability.
- **ManufacturerPart** links a canonical Part to a manufacturer company and an MPN. **SupplierPart** links it to a supplier company and SKU, optionally referencing a ManufacturerPart. These IDs are distinct from the canonical part ID.
- **Parameters** store structured specifications using discovered template IDs and string values. Template units describe attributes; Part `units` describe stock quantities. A resistor's resistance is a parameter, not its stock unit.
- **StockItem** is a concrete lot with quantity, location, and optional supplier provenance. Set the supplier part only on lots with known provenance. Renaming a Part does not establish where its stock came from.

## Discover, stage, commit, verify

1. Resolve the current Part with `find_parts`. For an MPN or SKU, use `find_manufacturer_parts` or `find_supplier_parts` and follow their canonical `part.id`. Inspect `get_part_inventory`, `get_part_sourcing`, and relevant `get_part_parameters` before changing existing records. Reuse companies and templates found through `list_companies` and `list_parameter_templates`.
2. Resolve category/location IDs only when needed. Follow returned cursors with the same filters when the task concerns every matching record. `get_part_sourcing` has separate manufacturer and supplier cursors. Part inventory shows at most 100 stock lots; use the reference's complete stock read procedure when the task concerns every lot. Ask about an ambiguous identity, missing purchase identifier, or unknown source before constructing dependent changes.
3. Build one `create_inventory_plan` with an operation ID stable for that exact request and at most 30 ordered steps. Mutation actions such as `update_part` and `update_stock` live inside `steps`; they are not separate callable tools. Load [references/workflows.md](references/workflows.md) for action recipes and examples.
4. Use the returned complete review to present the affected names, IDs, quantities, locations, source links, and any unresolved lines. Obtain commit authorization once for that concrete plan unless the user has already explicitly authorized those exact changes; do not ask repeatedly. Staging changes bridge plan state only. Commit with `commit_inventory_plan(plan_id, expected_version=plan_version)`.
5. Verify the requested outcome using the relevant read tools: readable names, sourcing IDs, parameter values, stock IDs, quantities, and locations. Report what changed and any remaining mismatch. A successful commit response alone is not the final reconciliation.

## Choose the right workflow

- **Find by specifications:** use `find_parts` with a category and/or parameter filters. Values can include units; InvenTree performs comparison and conversion. Filters are ANDed.
- **Migrate an existing MPN-named part:** keep the Part ID; `update_part` its name, preserve the original MPN on a ManufacturerPart, add/reuse a SupplierPart, `set_part_parameters`, and `update_stock` each known-source existing lot. Do not receive its quantity again. See the migration example in the reference.
- **Record a new purchase:** reuse the canonical Part or create it, add/reuse its sourcing, set specifications, then `receive_stock`. For new sourced parts, use a part create without initial stock, followed by sourcing and a sourced receipt with `merge: "new_item"`.
- **Edit stock:** use `update_stock` for supplier provenance, batch, packaging, expiry, notes, or link. Use `count_stock` for observed quantities, `move_stock` for physical relocation, and `set_stock_status` for condition. Omitted metadata is preserved.
- **Inspect orders:** purchase/build tools are read-only. A normal receipt does not update purchase-order received quantities. Explain unsupported order lifecycle writes rather than silently substituting another workflow.

## References and failures

References have the exact shape `{"step":"earlier_key","output":"supplier_part"}`. Use an output actually declared by an earlier creation action, never append `_id`, and use an existing numeric ID for records being edited. Updates declare no outputs. Consult the reference's output table instead of guessing.

For `already_current`, verify and report that no commit is needed. For stale inventory, reread affected records and create a fresh reviewed plan; a new operation ID must identify the changed plan. For an uncertain network result, retry the same plan's commit to retrieve its recorded outcome. If a commit failed after some operations, inspect `completed_operations`/`completed_requests`, `failed_step_id`, resolved references, and current inventory; prepare only the missing correction. Do not replay the workflow as a new plan and duplicate receipts or sourcing records. Discard a superseded staged plan when appropriate.

Use `inventree_get` only for a read genuinely missing from the domain tools. Do not use raw writes to bypass the plan review flow.
