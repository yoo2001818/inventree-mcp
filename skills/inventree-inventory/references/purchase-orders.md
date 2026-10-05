# Purchase orders

Use the standard discover, stage, review, authorize, commit, and verify flow. Resolve actual IDs before building a plan, keep it to 30 steps, and reuse existing orders for the same purchase. Issuing an order records its placement in InvenTree; the connector does not submit it to a supplier.

## Identities and quantities

An order belongs to a supplier company. A purchase line's `supplier_part_id` is a SupplierPart ID, not a canonical Part ID. All lines must belong to that order's supplier. `get_purchase_order` returns both identities, ordered/received/outstanding quantities, pack conversion, and price/currency.

Order quantities and receipt quantities are **supplier packs**. Prices are per supplier pack, supplied as exact decimal strings with up to six decimal places. A SupplierPart with `pack_quantity:"100"` turns a receipt of 2 into 200 canonical stock units. A unit-bearing pack quantity uses the server's `pack_quantity_native` conversion. If that conversion cannot be resolved for a newly staged SupplierPart, commit sourcing first, then discover it before preparing the receipt. Ordinary `receive_stock` instead takes canonical stock units.

Do not infer pack sizes, prices, currencies, or delivery quantities from an MPN. Reconcile supplied purchase evidence before staging receipts. Order receipt stock retains the supplier part, purchase order, and per-canonical-unit price; the instance may convert its currency according to its settings.

## Supported actions

All actions are inside `create_inventory_plan`, not standalone tools.

| Action | Arguments / behavior |
| --- | --- |
| `create_purchase_order` | `supplier_id`, unique `reference`; optional `description`, `supplier_reference`, `destination_id`, `target_date`, `start_date`, `order_currency`, `notes`, `link`, existing `responsible_id` |
| `update_purchase_order` | `order_id`, sparse `changes` with the same metadata fields; supplier is immutable |
| `create_purchase_order_line` | `order_id`, `supplier_part_id`, positive `quantity`; optional `purchase_price`, `purchase_price_currency`, `discount`, `destination_id`, `target_date`, `line`, `reference`, `notes`, `link` |
| `update_purchase_order_line` | `line_item_id`, sparse `changes` with the same quantity/price/delivery fields; order and SupplierPart are immutable; quantity cannot drop below received quantity |
| `issue_purchase_order` | `order_id`; pending or on-hold order with lines becomes placed |
| `hold_purchase_order` | `order_id`; pending or placed order becomes on hold |
| `cancel_purchase_order` | `order_id`; cancel an open order without deleting stock or undoing receipts |
| `complete_purchase_order` | `order_id`, `accept_incomplete:false` by default; explicit `true` permits closing with unreceived quantities and creates no stock |
| `receive_purchase_order` | `order_id`, `items:[{line_item_id,quantity,location_id?,batch?,expiry_date?,packaging?,notes?,status?,serial_numbers?}]`; optional global `location_id`, `allow_over_receipt:false` by default |

Creates declare `purchase_order` and `purchase_order_line` outputs respectively. References use exactly `{"step":"po","output":"purchase_order"}` and `{"step":"line","output":"purchase_order_line"}`. All other order actions, including receipts, declare no outputs. Discover receipt stock afterward instead of guessing IDs or referencing a nonexistent `stock_item` output.

Order/line edits are supported while pending, placed, or on hold; terminal orders cannot be edited. Omitted metadata is preserved. Null destination/date/notes/price fields clear those nullable values. Creates always disable line merging, so separately reviewed lines retain separate identities. Discover and update an existing line when that is the intended change.

Receipts require a placed order and a destination. Destination precedence is per-item location, global receipt location, line destination, then order destination. Locations must accept stock. A line can appear only once in one receipt; aggregate its delivery quantity. Excess over the remaining quantity is rejected unless explicitly reviewed with `allow_over_receipt:true`. Do not routinely enable that option.

Receipt `status` uses semantic stock names: `ok`, `attention_needed`, `damaged`, `destroyed`, `rejected`, `lost`, `quarantined`, or `returned`. InvenTree validates serial expressions and uniqueness at commit. External-build-linked receipts are unsupported because they can also mutate build progress. Virtual-part receipts update order progress but create no physical stock.

For serialized stock with a non-OK status, the plan includes a conditional status correction because some server versions drop that status during receipt. Every line of the same SupplierPart in that receipt must request the same status; use separate receipt plans for different statuses. If correction fails, the receipt has already created stock and updated order progress. Inspect the recorded stock IDs and apply only the missing status change; do not receive again.

## Example: prepare and place an order

Illustrative existing supplier #501, SupplierPart #701 with 100 pieces per pack, and destination #81. Replace IDs, reference, quantity, and price with verified values. The order reference must match the instance's configured pattern.

```json
{
  "operation_id": "purchase-resistors-001",
  "steps": [
    {"key":"po","action":"create_purchase_order","arguments":{"supplier_id":501,"reference":"PO-0042","destination_id":81,"order_currency":"USD"}},
    {"key":"line","action":"create_purchase_order_line","arguments":{"order_id":{"step":"po","output":"purchase_order"},"supplier_part_id":701,"quantity":3,"purchase_price":"12.500000","purchase_price_currency":"USD"}},
    {"key":"issue","action":"issue_purchase_order","arguments":{"order_id":{"step":"po","output":"purchase_order"}}}
  ]
}
```

Commit the authorized plan and read its resolved IDs. Do not receive stock merely because the order was placed: receipt represents a real delivery. For an already-delivered historical purchase explicitly authorized by the user, issue and receipt may be staged in one plan using earlier order/line references.

If a historical delivery is already counted in existing stock, do not receive it again. Discover and reconcile that stock first.

For a delivery of two packs against verified order #1101 and line #1201, stage:

```json
{
  "operation_id": "purchase-resistors-delivery-001",
  "steps": [
    {"key":"delivery","action":"receive_purchase_order","arguments":{"order_id":1101,"items":[{"line_item_id":1201,"quantity":2,"batch":"delivery-001"}]}}
  ]
}
```

The review should show 2 supplier packs becoming 200 canonical pieces at the resolved destination, and received quantity increasing from 0 to 2. Do not also call `receive_stock` for this delivery.

## Verify and recover

Receiving must be the **final action for that order within a plan**. The instance may automatically complete a fully received order, so read the resulting state before preparing any later order action. Other unrelated inventory steps may follow. A receipt may contain up to 30 distinct lines.

Call `get_purchase_order {order_id,include_received_stock:true,include_notes:true}`. Follow its `lines.nextCursor` via `cursor` and its independent `receivedStock.nextCursor` via `stock_cursor`, keeping filters and page size consistent. Verify ordered/received/outstanding pack quantities, state, SKU/canonical identities, stock quantity in canonical units, supplier provenance, purchase price/currency, and locations. Receipt stock reflects current quantities, which can differ from original receipt totals after later consumption or movement.

Preconditions freeze order, line, source, Part, and destination reads; concurrent changes reject commit before it starts. The upstream API still validates configured reference patterns, owner requirements, currencies, serialization rules, permissions, and plugins. Multi-step plans can partially succeed. Inspect recorded progress and read affected orders/stock before preparing only the missing corrections. Retry the same committed plan for a lost response; never create a second receipt operation merely because a response was lost.

Extra charges, line deletion, sales orders, build lifecycle changes, and supplier-system submission are outside this connector's current purchase-order actions. Use the supplied order metadata for records; do not imply those operations happened.
