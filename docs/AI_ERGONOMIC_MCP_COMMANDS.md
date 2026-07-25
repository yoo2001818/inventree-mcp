# AI-Ergonomic MCP Commands for Home Parts Inventory

## Purpose

This document defines the MCP tool surface for using InvenTree as a personal parts and stock inventory. It focuses on the things a person is likely to say in conversation:

- "Where are my 10 kOhm resistors?"
- "I bought 200 of these; put them in drawer A3."
- "Move everything from this bin to the blue cabinet."
- "I counted 37, not 42."
- "Create a category for JST connectors."
- "Print labels for the new bins."

Manufacturing, BOM, purchasing, suppliers, sales, customers, and order allocation are deliberately out of scope. InvenTree may still expose those features through its API, but they should not occupy the model's tool-selection context or leak into routine results.

The source material is:

- `docs-dropin/inventree-schema.yml`, the complete InvenTree OpenAPI schema (API version 511)
- `docs-dropin/old-gpt.txt`, the previous GPT instructions and reduced OpenAPI schema (API version 294)
- the current MCP tools in `src/mcp.ts`

## What the old GPT got right

The old GPT description captured a useful end-to-end workflow: normalize a user's informal item description, check for an existing part, choose a category, ask only necessary questions, confirm mutations, create the part and stock, and optionally print a label. It also correctly told the model to omit irrelevant fields.

Those behaviors should become properties of the MCP interface instead of depending on prompt discipline. A model should not need the full `Part` or `StockItem` serializer to learn that most fields are irrelevant. The tool schema should contain only the fields appropriate to its workflow.

## Problems with the current command surface

The current domain tools are a safe start, but they still expose InvenTree more like an API than an inventory clerk:

1. `search_parts`, `get_part`, `list_stock`, and `list_stock_locations` return full upstream JSON. Nested part and location serializers repeat many fields, consuming context and making the important facts harder to identify.
2. There is no category browsing tool, even though choosing a category is central to registering a part.
3. Location browsing returns a paginated flat list instead of a physical hierarchy.
4. Part search and stock lookup are separate calls even for the most frequent question: "Do I have this, how many, and where?"
5. Common mutations require `inventree_write` plus knowledge of endpoint paths and low-level request shapes.
6. The generic write tool allows unrelated InvenTree features and cannot give workflow-specific validation or summaries.
7. `get_part_bom` spends a dedicated tool slot on a workflow that is explicitly low priority here.
8. There is no first-class intake, consumption, movement, stocktake, reorganization, history, or label workflow.

`inventree_get` remains useful as a developer escape hatch. `inventree_write` should eventually be disabled by default once the intended mutations have dedicated tools.

## Design principles

### Expose intentions, not endpoints

Use names such as `receive_stock`, `consume_stock`, and `count_stock`, not `post_stock_add` or `patch_stock_item`. Each tool should own the necessary endpoint selection and validation.

### Keep IDs visible and names readable

Every selectable entity must show both its human-readable name/path and stable InvenTree ID. The model must never infer an ID from position or name alone.

Use:

```text
Electronics > Passive Components > Resistors (#14)
Living room > Blue cabinet > Drawer A3 (#81)
10 kOhm resistor, 1%, 0603 (#203)
Stock item #991
```

### Prefer compact text for orientation

Trees, search results, summaries, and mutation previews are easier for a model to use as concise Markdown than as raw serializers. Do not duplicate a large raw object in `structuredContent`.

Recommended output rule:

- `content`: canonical compact Markdown meant for the model and user.
- `structuredContent`: either omit it or include only the minimal fields needed by a programmatic client. Never include the full upstream response merely because it is available.
- `raw: true`: an optional expert/debug flag on read tools, or use `inventree_get`, when full API JSON is genuinely needed.

### Resolve ambiguity before mutation

Names are not identifiers. A write flow should search and present candidates first. If a phrase resolves to zero or multiple parts, categories, locations, or stock items, the tool returns an ambiguity result and does not mutate anything.

### Make quantities semantically explicit

The following are different operations and should be different commands:

- receive/add 10: increase by 10
- consume/remove 10: decrease by 10
- count 10: set the observed quantity to 10
- move 10: preserve total quantity and change location

A generic `adjust_stock(delta)` makes sign errors too easy.

### Optimize defaults for a home inventory

- Include child categories and child locations in searches by default.
- Prefer active parts and in-stock items by default, but allow depleted parts when checking whether something was previously registered.
- Hide allocation, build, purchasing, sales, pricing, ownership, and supplier fields unless explicitly requested.
- Treat a non-serialized quantity as fungible unless batch, packaging, expiry, status, or notes make stock items meaningfully different.
- Use the part's default location, then the category's default location, as suggestions rather than silently committing to them.
- Keep user-entered notes on all stock transactions.

### Make reads cheap and writes deliberate

Read tools should be easy to compose. Writes first stage non-destructive steps in temporary bridge state. The assistant then shows one consolidated review, asks once for confirmation, and commits the complete plan.

## Core read tools

### `browse_part_categories`

Purpose: orient the model before searching or creating a part and resolve category IDs.

Suggested input:

```json
{
  "root_id": 13,
  "search": "capacitor",
  "max_level": 4,
  "full_tree": false,
  "include_counts": false,
  "include_descriptions": false
}
```

All fields are optional. Without `root_id`, `search`, or `full_tree: true`, return only top-level nodes with child/item counts. A search result should include matched branches with enough ancestors to preserve context. `max_level` deliberately mirrors InvenTree's zero-based level semantics; it is not a relative depth count. Use `/api/part/category/tree/` where possible, with `/api/part/category/` for top-level orientation, counts, or details.

Canonical output:

```markdown
- Electronics (#13) [structural]
  - Passive Components (#21) [structural]
    - Capacitors (#14) — 28 parts
    - Resistors (#15) — 43 parts
```

Only show `[structural]`, counts, descriptions, or defaults when requested or operationally relevant. A structural node cannot directly contain parts, so that marker must not be omitted when the result will be used for part creation.

### `browse_stock_locations`

Purpose: understand the physical storage hierarchy and resolve destination IDs.

Suggested input mirrors `browse_part_categories`:

```json
{
  "root_id": 4,
  "search": "drawer A3",
  "max_level": 5,
  "full_tree": false,
  "include_item_counts": true,
  "include_descriptions": false
}
```

Use `/api/stock/location/tree/` for hierarchy and `/api/stock/location/` for optional counts and details.

Canonical output:

```markdown
- Living room (#4)
  - Blue cabinet (#22) [structural]
    - Drawer A3 (#81) — 12 stock items
```

### `find_parts`

Purpose: answer existence, quantity, and location questions in one call and resolve part IDs.

Suggested input:

```json
{
  "query": "10k 0603 resistor",
  "category_id": 15,
  "include_subcategories": true,
  "stock": "any",
  "limit": 10,
  "cursor": null
}
```

`stock` should be `any`, `in_stock`, `depleted`, or `below_minimum`. Search the part endpoint, then fetch or aggregate stock only for returned part IDs. Do not return the full nested `Part` and `StockItem` serializers.

Canonical output:

```markdown
Results 1-2 of 2 parts:

1. 10 kOhm resistor, 1%, 0603 (#203) — 247 pcs total
   Category: Electronics > Passive Components > Resistors (#15)
   Stock: Drawer A3 (#81): 200 pcs [stock #991]; Workbench bin (#92): 47 pcs [stock #1044]
   IPN: R-10K-0603-1P
2. 10 kOhm resistor, 5%, THT (#77) — out of stock
   Category: Electronics > Passive Components > Resistors (#15)

```

Search output should include the fields used for disambiguation: name, ID, description only if useful, IPN if present, category path, total quantity with units, and stock placements. Batch, serial, packaging, status, or expiry should appear only when present and differentiating.

### `get_part_inventory`

Purpose: retrieve one part's useful metadata and all stock placements after its ID is known.

Suggested input:

```json
{
  "part_id": 203,
  "include": ["parameters", "notes", "history_summary"]
}
```

Canonical output:

```markdown
## 10 kOhm resistor, 1%, 0603 (#203)

- Category: Electronics > Passive Components > Resistors (#15)
- Description: Thick-film resistor, 1%, 0603
- IPN: R-10K-0603-1P
- Stock: 247 pcs across 2 stock items
- Minimum: 50 pcs
- Default location: Living room > Blue cabinet > Drawer A3 (#81)

Stock:
- Drawer A3 (#81): 200 pcs [stock #991]
- Workbench bin (#92): 47 pcs [stock #1044]
```

The default response should omit inactive feature flags such as `assembly`, `salable`, and `purchaseable`. Show a flag only when it changes how the home-inventory workflow behaves, such as `trackable`, `locked`, or `active: false`.

### `inventory_at_location`

Purpose: answer "what is in this drawer/cabinet?", support moves, and prepare stocktakes.

Suggested input:

```json
{
  "location_id": 81,
  "include_sublocations": true,
  "group_by": "location",
  "include_depleted": false,
  "limit": 100,
  "cursor": null
}
```

Canonical output:

```markdown
## Drawer A3 (#81)

- 10 kOhm resistor, 1%, 0603 (#203): 200 pcs [stock #991]
- 100 nF ceramic capacitor, X7R, 0603 (#244): 85 pcs [stock #1102]

Showing stock items 1-2 of 2 (2 parts on this page).
```

When `include_sublocations` is true, preserve location subheadings rather than flattening the physical hierarchy.

### `check_stock_levels`

Purpose: find depleted or low-stock household parts without exposing purchase-order concepts.

Suggested input:

```json
{
  "category_id": 13,
  "include_subcategories": true,
  "state": "below_minimum",
  "limit": 50,
  "cursor": null
}
```

Canonical output:

```markdown
- 100 nF ceramic capacitor (#244): 12 pcs; minimum 50; short by 38
- JST-XH 2-pin housing (#351): 0 pcs; minimum 20; short by 20
```

For `state: "depleted"`, use `out of stock` rather than shortage language. A depleted part whose configured minimum is zero is still out of stock but is not "short by 0".

### `get_stock_history`

Purpose: explain changes and answer "what happened to the quantity?"

Suggested input:

```json
{
  "part_id": 203,
  "stock_item_id": 991,
  "since": "2026-07-01",
  "limit": 20,
  "cursor": null
}
```

At least one of `part_id` or `stock_item_id` is required. Map to `/api/stock/track/` and return a compact newest-first timeline with deltas, resulting quantities when available, notes, and affected locations.

### `scan_barcode`

Purpose: resolve an InvenTree or supported third-party barcode to a part, stock item, or location. This removes several search steps during physical inventory work.

The tool should return the same compact entity notation used elsewhere and must not perform a mutation merely because a barcode endpoint can support actions.

## Core write workflows

Each workflow below should be a dedicated tool or a prepare action accepted by a shared mutation planner. The tool must accept IDs, not unresolved names. The assistant can use the read tools to turn user language into IDs first.

### `create_part_with_stock`

Purpose: register a new household part, optionally with its initial quantity, location, and a stock-item label.

Suggested intent:

```json
{
  "part": {
    "name": "10 kOhm resistor, 1%, 0603",
    "description": "Thick-film resistor",
    "category_id": 15,
    "IPN": "R-10K-0603-1P",
    "keywords": ["10k", "0603", "resistor"],
    "units": "pcs",
    "minimum_stock": 50,
    "default_location_id": 81,
    "trackable": false,
    "notes": null
  },
  "initial_stock": {
    "quantity": 200,
    "location_id": 81,
    "batch": null,
    "packaging": "cut tape",
    "notes": "Initial inventory"
  },
  "label": null
}
```

The public tool schema should not expose assembly, build, purchasing, sales, supplier, pricing, or revision fields. Server-side defaults should set irrelevant feature flags consistently. Before preparing the write, the server should run a duplicate search using name, IPN, and keywords and return candidates if found.

Implementation may use the part endpoint's `initial_stock` support or create the part and stock item as two validated steps. If upstream cannot make that atomic, the preview should disclose the two steps and the server should report partial failure precisely.

### `update_part`

Purpose: rename, recategorize, annotate, deactivate/reactivate, or change home-inventory defaults for an existing part.

Suggested editable fields:

- name, description, category ID, IPN, keywords, units
- minimum and maximum stock
- default location ID and default expiry
- link, notes, tags
- active, trackable, locked

Omitted fields mean "unchanged"; `null` means "clear" where the upstream field allows it. The preview must show a field-level before/after diff.

### `receive_stock`

Purpose: record newly acquired quantity for an existing part without requiring the model to choose between stock creation and `/api/stock/add/`.

Suggested input:

```json
{
  "part_id": 203,
  "quantity": 200,
  "location_id": 81,
  "merge": "compatible",
  "batch": null,
  "packaging": "cut tape",
  "expiry_date": null,
  "notes": "Bought at electronics market"
}
```

`merge` should be:

- `compatible` (default): add to one existing stock item only if part, location, batch, packaging, expiry, and status are compatible; otherwise create a new stock item.
- `new_item`: always create a separate stock item.
- `stock_item`: require an explicit `stock_item_id` and add to it.

The preview must state whether the operation will create stock or add to stock item `#N`.

### `consume_stock`

Purpose: record parts used, discarded, or otherwise removed from available stock.

Suggested input:

```json
{
  "part_id": 203,
  "quantity": 3,
  "location_id": 81,
  "stock_item_id": null,
  "strategy": "fewest_items",
  "reason": "used",
  "notes": "LED controller repair"
}
```

The server should calculate an explicit removal plan from matching stock items. If the location is omitted and the part is stored in multiple places, return the choices unless a strategy was explicitly provided. Never silently consume damaged, lost, quarantined, expired, allocated, or otherwise unavailable stock.

Preview example:

```markdown
Consume 3 pcs of 10 kOhm resistor, 1%, 0603 (#203):
- Stock #991 in Drawer A3 (#81): 200 -> 197 pcs
Note: LED controller repair
```

### `move_stock`

Purpose: move a quantity, selected stock items, or all stock under a location to another location.

Support three explicit selectors:

1. `stock_item_id` plus optional quantity
2. `part_id` plus source location and quantity
3. `source_location_id` plus `all: true`, optionally including sublocations

The destination must be non-structural. Moving part of a fungible stock item may require an upstream split; that detail should remain inside the MCP implementation. The preview must list every affected stock item and preserve the total quantity.

### `count_stock`

Purpose: reconcile the recorded quantity with a physical count. This maps to the stock-count endpoint rather than guessing a positive or negative adjustment.

Suggested input:

```json
{
  "counts": [
    { "stock_item_id": 991, "observed_quantity": 197 },
    { "stock_item_id": 1102, "observed_quantity": 83 }
  ],
  "location_id": 81,
  "notes": "Drawer A3 stocktake"
}
```

Preview output must show recorded value, observed value, and delta for every item.
Unchanged lines are omitted. If every observed quantity is already current, return `already_current` and do not create or modify a plan.

### `set_stock_status`

Purpose: mark items as OK, attention needed, damaged, destroyed, lost, quarantined, or returned using semantic enum names rather than integer status codes.

This is lower priority than receive/consume/move/count, but useful for a home lab. The server maps stable public names to the instance's current status values and includes the numeric code in the preview.

## Structure-management tools

Category and location reorganization is common enough to deserve dedicated tools, but less frequent than inventory operations.

### `create_part_category`

Inputs: name, parent ID, description, structural flag, default location ID, default keywords. Validate that no same-name sibling exists. Return the resulting full path and ID.

### `update_part_category`

Inputs: category ID plus a sparse set of editable fields. Renaming or reparenting must preview the old and new paths and state how many descendant categories and directly assigned parts are affected.

### `create_stock_location`

Inputs: name, parent ID, description, structural flag, tags. Validate same-name siblings and return the resulting full path and ID.

### `update_stock_location`

Inputs: location ID plus a sparse set of editable fields. Renaming or reparenting must preview the old and new paths and state how many descendant locations and stock items are affected. A location may not become structural while it directly contains stock.

Deletion is intentionally omitted from the MCP surface. Empty obsolete nodes can be deleted manually in InvenTree until a clearly recoverable archival workflow exists.

## Label workflow

### `print_labels`

Purpose: print part, stock-item, or stock-location labels without asking the model to remember template IDs or printer plugin strings.

Suggested input:

```json
{
  "operation_id": "print-stock-991",
  "entity_type": "stock_item",
  "entities": [{ "id": 991 }],
  "template": "30x15mm",
  "printer": "zebra",
  "copies": 1
}
```

The tool should discover enabled templates from `/api/label/template/`, filtered by `model_type`, and expose human-readable choices. Do not permanently encode the old GPT's template IDs `17` through `22`; IDs are instance-specific and may drift. A deployment configuration may define aliases such as `30x15mm` after validating their model types.

Printing is a real-world side effect. Always preview the entity names/paths, printer, template dimensions/name, and copy count before commit.

## Mutation safety protocol

Mutation tools stage steps in one shared plan. Staging changes only temporary bridge state, is non-destructive, and must not ask the user for confirmation. If `plan_id` is omitted, the first staging call creates a plan; later calls append to it.

Each staged create operation declares outputs and returns opaque plan-scoped references. Later steps can use those references before InvenTree has assigned numeric IDs. For example, a print step can refer to the stock item that an earlier create step will produce.

Future references are local to the `plan_id` supplied on each staging call, so their public representation does not repeat the plan ID. Each step and declared output receives an immutable opaque ID; human-facing step numbers are presentation only and may change when a step is removed. Models only copy server-issued references; they never construct them.

`review_inventory_plan` returns the complete canonical preview. Only then does the assistant ask the user for confirmation.

After confirmation, `commit_inventory_plan(plan_id, expected_version)` freezes and revalidates the plan, executes steps serially, resolves future references from earlier results, and returns the final ID mapping.

Only the commit tool is destructive. Staging and plan-editing tools use `destructiveHint: false`; the commit tool uses `destructiveHint: true`. Append operations use idempotency keys and plan versions to prevent duplicate or lost updates.

Several InvenTree requests committed from one plan are orchestrated as one reviewed action but are not an upstream database transaction. Partial completion must be reported precisely; automatic rollback must not be assumed.

### Stable plan identity

A plan has three distinct kinds of identity:

- `position` is the current human-facing order. It can change when a step is removed.
- `step_id` is an immutable opaque step identity such as `stp_B7Q2K9`. It is never renumbered or reused.
- `ref` is an immutable opaque identity for one declared output, such as `stock_R4M8XP`. It remains stable for the plan's lifetime.

Never use a display ordinal such as `step-1` as an identity. If the first step is removed, the remaining steps may be displayed as 1 and 2 again without changing either step's `step_id` or outputs.

References are plan-local. Because every consuming call already includes `plan_id`, the reference itself does not repeat that plan ID. The server internally resolves `(plan_id, ref)` and rejects unknown, invalidated, cross-plan, wrong-type, or not-yet-available references. Entity selectors use a structured union:

```ts
type EntitySelector =
  | { id: number }
  | { ref: string };
```

The object form removes the need for a magic `#ref#` string prefix and prevents confusion between a numeric ID and a numeric-looking string. Entity-type prefixes help diagnostics, but refs are server-issued opaque values: clients copy them and never construct them.

### Staging contract

Every staging tool accepts these plan-control fields alongside its workflow fields:

```json
{
  "plan_id": "optional-existing-plan",
  "expected_version": 1,
  "operation_id": "caller-stable-idempotency-key"
}
```

- Omit `plan_id` to create a plan implicitly.
- Supply `plan_id` and the latest `expected_version` to append serially.
- Reusing `operation_id` for the same operation returns its existing step rather than appending a duplicate.
- Reusing an operation ID for different content is an error.
- A successful append increments `plan_version` and refreshes idle expiry.

The response is informational, not a confirmation request:

```json
{
  "status": "staged",
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "plan_version": 2,
  "step_id": "stp_B7Q2K9",
  "position": 2,
  "outputs": [
    {
      "name": "stock_item",
      "entity_type": "stock_item",
      "ref": "stock_R4M8XP",
      "display": "10 kOhm resistor in Drawer A3"
    }
  ]
}
```

Every workflow summary must expose all material non-default fields that will be written, including descriptions, keywords, metadata, packaging, expiry, notes, status, print template, printer, copy count, and the number/order of upstream operations. Long values may be visibly truncated only if the complete value remains bound to the frozen plan.

### Referencing an entity created earlier in the plan

For example, `create_part_with_stock` can return a future stock ref. A later label step uses it without knowing the eventual InvenTree ID:

```json
{
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "expected_version": 1,
  "operation_id": "print-new-stock-label",
  "entity_type": "stock_item",
  "entities": [{ "ref": "stock_R4M8XP" }],
  "template": "30x15mm",
  "printer": "zebra",
  "copies": 1
}
```

Plans execute in their displayed serial order, so a ref may only consume an output from an earlier step. At commit, the connector extracts the real ID from the producer response and substitutes it into later request bodies.

### Review and plan editing

`review_inventory_plan(plan_id)` is the canonical, consolidated preview. It includes current position, immutable step ID, every material field and side effect, declared outputs, and upstream operation order. This is the first point at which the assistant asks the user to confirm.

Plan management is non-destructive:

- `remove_inventory_plan_step(plan_id, step_id, expected_version, cascade=false)` removes an independent step.
- If another step consumes the target's outputs, removal is rejected and lists immutable dependent step IDs.
- `cascade: true` explicitly removes the producer and all transitive dependents.
- `discard_inventory_plan(plan_id)` deletes only temporary connector state.
- Removed step and ref IDs are never reused.

### Commit and retry behavior

`commit_inventory_plan(plan_id, expected_version)` is the only destructive plan tool and the only call that should prompt for confirmation. It freezes the plan before its first await, revalidates all captured existing-entity state, executes requests serially, resolves outputs, and records a bounded result:

```json
{
  "status": "committed",
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "completed_steps": 3,
  "resolved_refs": {
    "part_N2C6VW": 1301,
    "stock_R4M8XP": 944
  }
}
```

Replaying a successfully committed plan returns the recorded result without repeating writes. A partial failure records completed step/request counts, resolved refs, the immutable failed step ID, and the upstream error. It must not claim transactionality or attempt an unsafe automatic rollback.

Plans are scoped to the authenticated credential link, expire after an idle period, and cannot accept steps after commit begins. Committed and failed results remain briefly available for retry and diagnosis.

### Live-output correctness requirements

The following constraints came from exercising the tools against a real home inventory and are part of the permanent command contract:

- Known stock-history deltas are normalized into quantity, location, status, count, add, remove, or transfer text. Nested upstream serializers are never dumped; unknown primitive deltas use a bounded fallback.
- A paged location result says `Showing stock items 11-15 of 15 (5 parts on this page)`. A page's unique-part count is not represented as the whole location total.
- A depleted result says `out of stock`; below-minimum results use current/minimum/shortage wording.
- No-op stock counts return `already_current` without staging a step.
- Existing stock-item label previews resolve both the part and physical location. Planned stock labels show their planned identity and that the ID is assigned at commit.
- A partial move discloses that InvenTree will split the source and assign another stock-item ID. The current transfer response schema does not expose that new ID, so the tool must not issue an unsafe ref for it; a later read resolves the resulting placement.
- Unfiltered category/location browsing starts at top-level nodes. Full trees require `full_tree: true` or branch expansion with `root_id`.
- Paged part search uses an absolute range such as `Results 6-10 of 17`.

## Error and ambiguity contracts

Tools should return actionable domain outcomes rather than raw HTTP errors:

- `not_found`: include the supplied ID or query and a suggested lookup tool.
- `ambiguous`: include compact candidates with IDs and explain which input must be made explicit.
- `invalid_destination`: explain that the category/location is structural and list suitable children.
- `insufficient_stock`: show requested, available, and eligible stock placements.
- `conflict`: show which before-state changed after preview and require a new plan.
- `locked`: name the locked part or stock item.
- `upstream_error`: retain HTTP status and a bounded, sanitized detail payload for debugging.

Expected domain failures should not dump a serializer or stack trace. Authentication and scope failures should continue to use MCP authorization metadata.

## Pagination and output limits

- Prefer opaque cursors at the MCP boundary even if InvenTree uses numeric offsets internally.
- Default search result limits to 10 or 20, not 100.
- Include an absolute range such as `Results 6-10 of 17` and a next cursor when truncated.
- Put a hard node limit on trees. If exceeded, return top levels and tell the model which `root_id` values can be expanded.
- Never embed upstream `next` URLs; they leak deployment details and are not useful to the model.
- Sort trees in stable path/name order and histories newest first.

## Example composed workflows

### "Do I already have this capacitor?"

1. `find_parts(query="100nF X7R 0603")`
2. If there is one strong result, answer with total quantity and locations from that result.
3. If there are plausible variants, present their IDs and differentiating fields. Do not guess.

One MCP call should normally answer this question.

### "Add these 200 capacitors to my inventory"

1. `find_parts` to check for duplicates.
2. If the part exists, use `browse_stock_locations` only if the destination is unresolved, then stage `receive_stock` in a new plan.
3. If it does not exist, use `browse_part_categories` and `browse_stock_locations`, then stage `create_part_with_stock` in a new plan.
4. If a label is wanted, append `print_labels` to the same plan using the server-issued reference to the planned stock item.
5. Call `review_inventory_plan` and show the complete consolidated preview.
6. Ask for confirmation once.
7. Call `commit_inventory_plan` after confirmation.

### "I used five from the workbench"

1. `find_parts` if the part is not already in context.
2. Stage `consume_stock` with the resolved workbench location.
3. If multiple eligible stock items remain, show candidates or the explicit allocation plan.
4. Review the plan, ask once for confirmation, and commit it.

### "What is actually in drawer A3?"

1. Resolve A3 with `browse_stock_locations(search="A3")` if needed.
2. `inventory_at_location(location_id=81)`.
3. If the user is physically counting, prepare one batched `count_stock` from their observations rather than issuing individual adjustments.

### "Reorganize this cabinet"

1. Read the location subtree and its inventory.
2. Stage location creates/renames in one plan.
3. Append stock moves using server-issued references for planned destination locations.
4. Append label printing for the final planned locations.
5. Review the complete serial plan and ask once for confirmation.
6. Commit the plan, while preserving a clear report boundary between structure changes, stock movement, and printing.

## Recommended tool set and priority

### Phase 1: make routine reads excellent

1. `browse_part_categories`
2. Replace `list_stock_locations` with `browse_stock_locations`
3. Upgrade `search_parts` to `find_parts` with compact stock aggregation
4. Upgrade `get_part` to `get_part_inventory`
5. Add `inventory_at_location`
6. Add `check_stock_levels`

This phase is read-only and immediately reduces context use and call count. It should come before expanding writes.

### Phase 2: cover daily stock mutations

1. `create_part_with_stock`
2. `update_part`
3. `receive_stock`
4. `consume_stock`
5. `move_stock`
6. `count_stock`
7. `review_inventory_plan`
8. `remove_inventory_plan_step`
9. `discard_inventory_plan`
10. `commit_inventory_plan`

After these are proven, disable `inventree_write` by default. Keep it behind an explicit deployment flag for development.

### Phase 3: physical organization and maintenance

1. category create/update
2. location create/update
3. `get_stock_history`
4. `set_stock_status`
5. `scan_barcode`
6. `print_labels`

### Remove or demote

- Remove `get_part_bom` from the default home-inventory profile.
- Keep `inventree_get` as an advanced read-only escape hatch with a clearly documented raw result.
- Do not add manufacturing, purchasing, or sales tools to this profile.

## Implementation notes

The MCP layer should have small domain adapters rather than returning `InvenTreeClient.get()` directly:

1. Fetch the minimum upstream fields/detail flags needed.
2. Normalize upstream version differences into internal `PartSummary`, `StockPlacement`, `CategoryNode`, and `LocationNode` types.
3. Format the canonical Markdown from those normalized types.
4. Return only the same minimal types in `structuredContent`, when structured output is useful.
5. Test formatter output with snapshots because formatting is part of the AI-facing API contract.

Useful normalized types are approximately:

```ts
type EntityRef = { id: number; name: string; path?: string };

type StockPlacement = {
  stockItemId: number;
  location: EntityRef | null;
  quantity: number;
  units?: string;
  batch?: string;
  serial?: string;
  packaging?: string;
  status?: string;
  expiryDate?: string;
};

type PartSummary = {
  id: number;
  name: string;
  description?: string;
  ipn?: string;
  category?: EntityRef;
  totalQuantity: number;
  units?: string;
  minimumStock?: number;
  placements?: StockPlacement[];
};
```

Do not treat the OpenAPI schema as the MCP schema. The OpenAPI schema describes everything InvenTree can accept; the MCP schema should describe only what a model should reasonably decide in a named workflow.

## Success criteria

The optimized connector is successful when:

- A typical "do I have it and where is it?" question takes one tool call.
- Category and location browsing is readable without mentally reconstructing parent IDs.
- Routine output contains no unrelated manufacturing, purchasing, sales, or pricing fields.
- Every displayed entity that can be selected has an ID.
- The model never needs to know an InvenTree API path for a normal home-inventory task.
- Add, remove, count, and move cannot be confused by quantity semantics.
- Every mutation preview identifies exact records and before/after quantities or paths.
- User confirmation is requested once and bound to the reviewed version of a short-lived shared plan.
- Full raw API access is exceptional, visibly advanced, and read-only by default.
