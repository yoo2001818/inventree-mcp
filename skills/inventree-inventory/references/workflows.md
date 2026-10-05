# InvenTree MCP workflow recipes

## Read contracts

| Goal | Tool and key arguments |
| --- | --- |
| Find canonical parts | `find_parts {query?, category_id?, parameters?:[{template_id,value,operator?}], cursor?}` |
| Inspect stock lots | `get_part_inventory {part_id, include?:["parameters","notes"], include_depleted?}` |
| Inspect sourcing | `get_part_sourcing {part_id, manufacturer_cursor?, supplier_cursor?}` |
| Resolve companies | `list_companies {query?, role:"supplier"|"manufacturer"|"any", active?, cursor?}` |
| Resolve MPN or SKU | `find_manufacturer_parts {part_id?,manufacturer_id?,MPN?,query?,cursor?}` / `find_supplier_parts {part_id?,supplier_id?,SKU?,query?,cursor?}` |
| Resolve specification templates | `list_parameter_templates {query?,enabled?,cursor?}` |
| Read specifications | `get_part_parameters {part_id,cursor?}` |
| Resolve storage/category | `browse_stock_locations {search?,root_id?}` / `browse_part_categories {search?,root_id?}` |
| Verify a location | `inventory_at_location {location_id,cursor?}` |
| Inspect purchase/build orders | `list_purchase_orders`, `get_purchase_order`, `list_build_orders`, `get_build_order` |

Paged collections expose `results`, `count`, and `nextCursor`. Cursors are opaque: do not construct them or change filters between pages. `get_part_inventory` returns a `placements` array capped at 100 stock lots, without a stock cursor. Its optional `parameters` page has a `nextCursor`; continue that page through `get_part_parameters`. Trust the actual published schemas if a connector version differs from this guide.

For complete stock discovery beyond that cap, use the missing-read fallback: `inventree_get {path:"/api/stock/",query:{part:42,in_stock:true,limit:100,offset:0,ordering:"pk",location_detail:true,path_detail:true}}`. Read its raw `results` and `count`, advance `offset` by the number of returned rows, and repeat until the count is covered; replace 42 with the discovered canonical Part ID. Omit `in_stock` when explicitly including depleted lots. A placement summary alone must not be treated as a complete list when there could be more than 100 lots. Reread if inventory changes during paging.

Parameter operators are `eq` (default), `ne`, `gt`, `gte`, `lt`, `lte`, and `icontains`. Supply at least a query, category, or parameter filter. Two bounds on the same template are allowed; repeating the same template/operator pair is rejected. Example after resolving the real template IDs:

```json
{"category_id":15,"parameters":[{"template_id":810,"value":"10kohm"},{"template_id":813,"value":"50V","operator":"gte"},{"template_id":812,"value":"0603"}]}
```

## Plan actions and outputs

Call `create_inventory_plan {operation_id,steps:[{key,action,arguments}]}`. Each key is unique, starts with a letter, and uses letters, digits, underscores, or hyphens. Keep plans to 30 steps and finish verification before proceeding to another batch. Companies, templates, and sourcing can use existing IDs or creation outputs.

| Action | Essential arguments | Declared outputs |
| --- | --- | --- |
| `create_part_with_stock` | `part:{name,category_id,...}`, optional `initial_stock:{quantity,location_id,...}` | `part`; `stock_item` only with initial stock |
| `update_part` | `part_id`, `changes:{name?,description?,IPN?,category_id?,notes?,...}` | None |
| `create_company` | `name`, `is_supplier:true` and/or `is_manufacturer:true` | `company` |
| `update_company` | `company_id`, sparse `changes` | None |
| `create_manufacturer_part` | `part_id`, `manufacturer_id`, `MPN` | `manufacturer_part` |
| `update_manufacturer_part` | `manufacturer_part_id`, sparse `changes` | None |
| `create_supplier_part` | `part_id`, `supplier_id`, `SKU`, optional `manufacturer_part_id` | `supplier_part` |
| `update_supplier_part` | `supplier_part_id`, sparse `changes` | None |
| `create_parameter_template` | `name`, optional `units`, `choices`, `checkbox`, `enabled` | `parameter_template` |
| `update_parameter_template` | `parameter_template_id`, sparse `changes` | None |
| `set_part_parameters` | `part_id`, `parameters:[{template_id,data,note?}]` | None |
| `create_purchase_order` | `supplier_id`, `reference`, optional destination, dates, currency, notes | `purchase_order` |
| `update_purchase_order` | `order_id`, sparse `changes` | None |
| `create_purchase_order_line` | `order_id`, `supplier_part_id`, `quantity`, optional price, currency, destination | `purchase_order_line` |
| `update_purchase_order_line` | `line_item_id`, sparse `changes` | None |
| `issue_purchase_order` / `hold_purchase_order` / `cancel_purchase_order` | `order_id` | None |
| `complete_purchase_order` | `order_id`, optional `accept_incomplete` | None |
| `receive_purchase_order` | `order_id`, `items:[{line_item_id,quantity,...}]`, optional `location_id`, `allow_over_receipt` | None |
| `update_stock` | `stock_item_id`, `changes:{supplier_part_id?,batch?,packaging?,expiry_date?,notes?,link?}` | None |
| `receive_stock` | `part_id`, `quantity`, `location_id`, optional `supplier_part_id`, `merge` | `stock_item` only when a new lot is created |
| `count_stock` | `counts:[{stock_item_id,observed_quantity}]`, optional `location_id`, `notes` | None |
| `consume_stock` | `part_id`, `quantity`, optional `stock_item_id`, `location_id`, `strategy`, `reason`, `notes` | None |
| `move_stock` | `destination_location_id` and a stock selector; optional `quantity` | None |
| `set_stock_status` | `stock_item_ids`, semantic `status`, optional `notes` | None |
| `create_part_category` | `name`, optional `parent_id` | `part_category` |
| `create_stock_location` | `name`, optional `parent_id` | `stock_location` |
| `update_part_category` / `update_stock_location` | `category_id` / `location_id`, sparse `changes` | None |
| `set_part_image` | `part_id`, `upload_ref` from `prepare_part_image_upload` | None |
| `print_labels` | `entity_type`, `entities`, `template`, optional `printer`, `copies` | None |

`create_part_with_stock` checks possible duplicates. Resolve and reuse them where appropriate; set `allow_possible_duplicates:true` only when intentionally creating a reviewed distinct Part. Source updates cannot reassign their canonical Part. A supplier's linked ManufacturerPart and every sourced stock item must belong to that same Part. Company roles, source activity, and locked Parts are validated.

`set_part_parameters` upserts values, including defaults inherited when a new Part is created. Omitted values and notes are preserved; an empty note clears it. Each template can be set only once for a Part within one plan. Values are strings (maximum 500 characters); choices and checkbox values must match the template. Template changes affect every use, so prefer existing templates unless their meaning really differs.

`update_stock` preserves omitted metadata and retains identity, quantity, and location. `supplier_part_id:null` clears provenance; `expiry_date:null` clears expiry; empty strings clear other editable text fields. Do not use this action to change which canonical Part owns a stock item. Select stock lots explicitly rather than assigning a supplier to every lot merely because their canonical Part matches.

## Existing-part migration example

Illustrative resolved identities: canonical Part #42 currently has name `RC0603FR-0710KL`, stock #91 belongs to it, manufacturer company #502, supplier company #501. Templates #810–814 represent resistance (`ohm`), tolerance (`%`), package, voltage (`V`), and power (`W`). Replace these IDs and `actual-supplier-SKU` with verified records. Reuse an existing MPN/SKU record when discovery finds one.

```json
{
  "operation_id": "migrate-resistor-42-v1",
  "steps": [
    {"key":"rename","action":"update_part","arguments":{"part_id":42,"changes":{"name":"10kΩ ±1% 0603 75V 100mW"}}},
    {"key":"mpn","action":"create_manufacturer_part","arguments":{"part_id":42,"manufacturer_id":502,"MPN":"RC0603FR-0710KL"}},
    {"key":"sku","action":"create_supplier_part","arguments":{"part_id":42,"supplier_id":501,"SKU":"actual-supplier-SKU","manufacturer_part_id":{"step":"mpn","output":"manufacturer_part"}}},
    {"key":"specs","action":"set_part_parameters","arguments":{"part_id":42,"parameters":[{"template_id":810,"data":"10kohm"},{"template_id":811,"data":"1%"},{"template_id":812,"data":"0603"},{"template_id":813,"data":"75V"},{"template_id":814,"data":"100mW"}]}},
    {"key":"stock","action":"update_stock","arguments":{"stock_item_id":91,"changes":{"supplier_part_id":{"step":"sku","output":"supplier_part"}}}}
  ]
}
```

Add an `update_stock` step for each selected known-source lot. Leave unknown-source lots alone. If the source SKU or manufacturer is missing, continue independent discovery but ask for that fact before staging those dependent steps; do not invent a supplier identifier from the MPN. Renaming can proceed separately if that is the user's authorized intent.

The response contains `plan_id`, `plan_version`, and a complete review. Commit the authorized plan with `commit_inventory_plan {plan_id,expected_version:plan_version}`. Updates declare no output, so later steps continue using Part #42 and stock #91. Verify `get_part_inventory`, `get_part_sourcing`, and `get_part_parameters` afterward. The total and every original stock ID should remain intact.

## Purchases and stock operations

For a new sourced capacitor: create the Part without initial stock, create/reuse its ManufacturerPart and SupplierPart, set parameters, then receive stock with the canonical `part_id`, matching `supplier_part_id`, location, and quantity. Future Part/location refs require `merge:"new_item"`; compatible lookup cannot find entities that do not exist yet.

For an existing Part, `merge:"compatible"` adds to a single matching lot or creates a new lot. Matching includes source provenance, batch, packaging, expiry, and eligible status. Multiple candidates require selecting a stock item or choosing `new_item`. `merge:"stock_item"` requires `stock_item_id` and rejects a different source. Unknown provenance and different supplier parts remain separate. Ordinary `receive_stock` uses canonical Part units and never multiplies by supplier `pack_quantity`; dedicated purchase-order receipts use supplier-pack quantities and perform that conversion.

For consumption, specify a stock item/location or a deliberate `fewest_items` or `oldest_first` strategy when multiple locations exist. Only available eligible quantities can be consumed. For a partial move, InvenTree can split the lot and assign another stock ID; discover the resulting placements afterward instead of assuming the source ID describes the moved quantity.

For a physical count, use the observed absolute quantity, not a calculated receipt. Verify totals at the intended location. For images, call `prepare_part_image_upload`, upload the bytes to its capability URL, then stage `set_part_image` with the opaque `upload_ref`. Keep the capability URL private. Print labels only when requested; labels for new entities can use their creation outputs.

## Orders and incomplete commits

Purchase order reads distinguish canonical `line.part.id` from `line.supplierPartId`; quantities include ordered and received supplier packs. Purchase order creation, edits, transitions, and receipts use dedicated staged actions. Load [purchase-orders.md](purchase-orders.md), or `get_inventory_guide {section:"purchase_orders"}`, before constructing a plan. Build reads show BOM-derived requirements, allocation, and consumption; build allocation/completion remain unsupported. Ordinary `receive_stock` does not advance an order.

On an upstream failure, examine the failed step and the completed operation count, then read the affected records. Preserve created entities by reusing their resolved IDs. A corrected plan uses a new operation ID and only the remaining changes. On a transport failure with an uncertain outcome, retry the same plan commit; never create a fresh receipt just because its response was lost. On stale inventory, the previous preconditions no longer apply: reread, restage, and review the new result before executing it.
