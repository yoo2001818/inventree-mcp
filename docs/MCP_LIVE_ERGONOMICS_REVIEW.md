# MCP Live Ergonomics Review and Mutation-Plan Revision

## Context

This review records a live exercise of the home-inventory MCP tools against the real InvenTree instance on 2026-07-25. The inventory was only read, and mutation tools were used only to create previews. No plan was committed. Follow-up reads confirmed that the preview-only part and location did not exist and that the tested part, stock item, category, and location were unchanged.

The read surface is already a substantial improvement over raw InvenTree JSON. In particular, `find_parts`, category/location search, ambiguity handling, duplicate detection, and semantic mutation previews make sense to an AI client. The remaining issues are concentrated in output accuracy and the mutation-plan lifecycle.

## Product decisions from the review

1. Staging a mutation must not bother the user for confirmation. It changes only temporary MCP plan state, not InvenTree.
2. Only the final commit is a destructive action and requires user confirmation.
3. Multiple workflow calls must be appendable to one plan.
4. A staged operation may refer to an entity that an earlier staged operation will create.
5. Future-entity references must identify a particular output within a plan. A plan ID by itself is insufficient.
6. The final review must expose every material field and side effect across the entire plan.

## Live issues

### P0: previews omit material mutation fields

The `create_part_with_stock` preview showed the category, default location, initial quantity, and operation count, but omitted fields including description, keywords, part notes, stock packaging, and stock notes. `receive_stock` similarly omitted its transaction note and optional stock metadata.

This undermines confirmation: a user cannot meaningfully approve an immutable plan if the preview hides part of that plan.

Expected behavior:

- The final plan review shows every non-default field that will be written.
- Part, stock, category, location, status, and label-print steps have workflow-specific summaries.
- Long notes may be bounded, but the preview must clearly indicate truncation and preserve a digest of the complete value.
- The preview includes the number and order of upstream operations.

### P0: one workflow call creates one isolated plan

The current implementation returns a new plan ID from every mutation tool. This prevents a natural workflow such as:

1. create a part;
2. create its initial stock item;
3. print that new stock item's label;
4. confirm everything once;
5. commit everything together.

The third step cannot name the future stock-item ID, and each call currently asks the client to treat its isolated preview as confirmation-ready.

Expected behavior: mutation tools append steps to a shared plan and return plan-scoped references for future outputs. The assistant reviews and confirms only the complete plan.

### P1: staging tools look destructive to the client

Plan-building tools are currently annotated like destructive writes and return `confirmation_required`. This can cause the host to interrupt the user for every staged step, even though no inventory mutation occurs.

Expected behavior:

- Staging calls use `destructiveHint: false`.
- Staging responses say `staged`, not `confirmation_required`.
- Only `commit_inventory_plan` uses `destructiveHint: true`.
- The assistant asks the user for confirmation once, after showing the final consolidated review.

Staging does write temporary bridge state, so `readOnlyHint: false` remains accurate. It is non-destructive, not read-only.

### P1: stock history leaks nested upstream JSON

A location-change event printed a large `location_detail` serializer inside the `deltas` JSON.

Expected output:

```text
- 2026-01-11 17:38: moved to 작업실 > 부품서랍장 > OC02 (#105) [event #978]
```

History normalization should recognize quantity, location, status, count, add, remove, and transfer events. Unknown deltas may fall back to bounded JSON, but known fields must never dump nested serializers.

### P1: paged location totals are misleading

The first page of a 15-item location said `10 stock items, 10 parts`; the second page said `5 stock items, 5 parts`. Those are page sizes, not location totals.

Expected behavior:

```text
Showing stock items 11-15 of 15 (5 parts on this page).
```

If a total unique-part count is not available without another query, do not imply that the page's unique count is the location total.

### P1: depleted output uses shortage language

`check_stock_levels(state="depleted")` produced results such as `0; minimum 0; short by 0`.

Expected behavior:

- `depleted`: say `out of stock`, optionally including category and last/default location.
- `below_minimum`: show current, minimum, and shortage.
- A depleted part with minimum zero is still depleted, but it is not below minimum.

### P1: no-op stock counts create commit-ready plans

`count_stock` accepted `20 -> 20 (+0)` and created a plan. This is inconsistent with `update_part`, which correctly rejects an already-current update.

Expected behavior: omit unchanged count lines; if every line is unchanged, return `already_current` without creating or modifying a plan.

### P1: label previews do not resolve stock-item identity

The label preview rendered `stock_item #674 (#674)` instead of the part and physical location.

Expected output:

```text
- Stock #674: 1/4W 1% Axial Resistor 103F (10kOhm) (#1048)
  Location: 작업실 > 부품서랍장 > OC02 (#105)
```

For planned stock items, render the planned part and location plus `ID assigned at commit`.

### P2: unfiltered trees are long by default

The unfiltered calls returned all 115 categories and 127 locations. They were readable but unnecessarily large for initial orientation.

Expected behavior: without `search` or `root_id`, return top-level nodes and child counts. The model can then expand one branch with `root_id`. An explicit `full_tree: true` may retain the current behavior.

### P2: `max_depth` is ambiguous

`max_depth: 2` returned levels 0, 1, and 2. This matches a zero-based upstream level but is surprising for a parameter named depth.

Expected behavior: define depth as the number of levels returned relative to the selected root. For example, `depth: 2` means the root's children and grandchildren, or rename the passthrough parameter to `max_level` and document that roots are level zero.

### P2: pagination copy could orient the model better

The second part-search page still began with `Found 17 parts` and ended with `Showing 5 of 17`.

Expected behavior: show `Results 6-10 of 17` and the next cursor.

### P2: partial moves should disclose splitting

A one-unit move from a 20-unit stock item showed the source and destination but did not state that InvenTree may split the stock item and create another stock-item ID.

Expected behavior: explain whether the existing item moves intact or a new stock item will be created for the partial quantity, and expose a planned reference to that future item.

## Revised mutation-plan model

### Reference identity within a plan

Every staging call already supplies `plan_id`, and a plan is executed serially. Repeating the plan ID inside every entity reference is unnecessary. References should be local to the selected plan.

A reference must also not use a display ordinal such as `step-1`. Ordinals describe current presentation order, not stable identity. Removing the first step would otherwise make `step-1` mean either the deleted step or the step that moved into first place.

Use three separate concepts:

- `position`: current human-facing order (`1.`, `2.`, `3.`); it may change after editing.
- `step_id`: immutable opaque identity for a staged step, such as `stp_B7Q2K9`; it is never reused or renumbered.
- `ref`: immutable opaque identity for one declared output, such as `stock_R4M8XP`; it remains stable for the lifetime of the plan.

The public reference does not need to expose its producing step or output index. Internally, the plan stores:

```ts
type PlannedOutput = {
  refId: string;
  entityType: "part" | "stock_item" | "part_category" | "stock_location";
  producerStepId: string;
  responseSelector: string; // internal extraction rule, e.g. result[0].pk
};
```

The entity-type prefix in `stock_R4M8XP` is useful for debugging and early schema validation, but the token remains server-issued and opaque. Models copy it; they never construct or edit it.

The plan ID and reference token form the actual lookup key internally: `(plan_id, ref)`. The same reference is invalid in any other plan even though the plan ID is not embedded in its public representation.

### Entity selector contract

Tools that select entities should accept existing IDs or planned references:

```ts
type PlannedEntityRef = string; // server-issued plan-local token

type EntitySelector =
  | { id: number }
  | { ref: PlannedEntityRef };
```

For a compact public schema, a scalar union is also acceptable:

```ts
type EntityIdOrRef = number | PlannedEntityRef;
```

The object form is preferable because it makes accidental numeric-string confusion less likely. It also makes a literal `#ref#` marker unnecessary:

```json
{ "ref": "stock_R4M8XP" }
```

If a compact scalar union is chosen instead, a rendering such as `#ref#stock_R4M8XP` may be useful to distinguish references from other strings. That marker is syntax, not identity, and should not contain plan or step ordinals. Either form is better than overloading the field name `entity_ids` with unexplained magic strings.

References cannot cross plans. A staging tool resolves each reference only within the plan named by the call and rejects an unknown or invalidated reference.

### Plan lifecycle

#### 1. Start implicitly or explicitly

Every staging tool accepts:

```json
{
  "plan_id": null,
  "expected_version": null,
  "operation_id": "client-generated-idempotency-key"
}
```

- Omitting `plan_id` creates a new plan.
- Providing `plan_id` appends to that plan.
- `expected_version` prevents lost updates if multiple calls edit the same plan.
- Reusing `operation_id` returns the already-staged step instead of duplicating it.

An optional `begin_inventory_plan` tool can create a named empty plan, but it should not be required for the common case.

#### 2. Stage workflow steps

Existing workflow names can remain, but their behavior changes from "create an immutable plan" to "append a step":

- `create_part_with_stock`
- `update_part`
- `receive_stock`
- `consume_stock`
- `move_stock`
- `count_stock`
- `set_stock_status`
- category/location create and update
- `print_labels`

Each response includes:

```json
{
  "status": "staged",
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "plan_version": 2,
  "step_id": "stp_B7Q2K9",
  "outputs": {
    "part": { "ref": "part_N2C6VW" },
    "stock_items": [
      { "ref": "stock_R4M8XP" }
    ]
  },
  "summary": "Staged part and initial stock creation. Plan now has 1 step."
}
```

This response is informational. It must not ask the user to confirm.

#### 3. Reference future entities

The next staged call can print the future stock item's label:

```json
{
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "expected_version": 1,
  "operation_id": "print-new-stock-label",
  "entity_type": "stock_item",
  "entities": [
    { "ref": "stock_R4M8XP" }
  ],
  "template": "30x15mm",
  "printer": "zebra",
  "copies": 1
}
```

The print step depends on the create step. The plan stores that dependency explicitly.

The same mechanism supports:

- moving stock into a location created earlier in the plan;
- updating a part created earlier in the plan;
- printing labels for a new location;
- receiving more stock into a newly created stock item;
- referring to an item created by a partial stock split.

#### 4. Review the complete plan

`review_inventory_plan(plan_id)` returns a canonical consolidated preview:

```markdown
## Inventory plan Xkkp... (version 2)

1. Create part "10 kOhm resistor, 1%, 0603"
   - Category: Electronics > Resistors (#15)
   - Description: Thick-film resistor
   - Keywords: 10k, 0603, resistor
2. Create initial stock
   - Planned stock item: stock_R4M8XP
   - Quantity: 200 pcs
   - Location: Drawer A3 (#81)
   - Packaging: cut tape
3. Print the planned stock-item label
   - Entity: new stock item from step 2 (ID assigned at commit)
   - Template: Stock Item 30x15 ZPL (#20)
   - Printer: zebra

Upstream operations: 3
```

This is the first point at which the assistant asks the user to confirm.

#### 5. Commit once

After confirmation:

```json
{
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "expected_version": 2
}
```

`commit_inventory_plan`:

1. atomically claims and freezes the plan;
2. revalidates all existing-entity snapshots and duplicate checks;
3. orders steps by declared dependencies;
4. executes upstream operations sequentially;
5. captures each declared output from the upstream response;
6. resolves later planned references to the captured numeric IDs;
7. returns a mapping from planned references to final IDs;
8. records a bounded commit result so safe retries return the same result instead of repeating writes.

Example result:

```json
{
  "status": "committed",
  "plan_id": "XkkpE8NFka1sL7ey9PWbaBvO",
  "resolved_refs": {
    "part_N2C6VW": 1301,
    "stock_R4M8XP": 944
  },
  "completed_steps": 3
}
```

### Plan editing

The following non-destructive helpers make a shared plan manageable:

- `review_inventory_plan(plan_id)` — show the full plan and validation state.
- `remove_inventory_plan_step(plan_id, step_id, expected_version)` — remove a step if no remaining step depends on its outputs.
- `discard_inventory_plan(plan_id)` — discard temporary bridge state without touching InvenTree.

Appending or removing a step increments `plan_version` and extends the plan expiry. Human-facing positions are recalculated after removal, but immutable `step_id` and `ref` values are never renumbered or reused.

Removing a step follows these rules:

1. If no remaining step consumes its outputs, remove it and invalidate its output references.
2. If remaining steps consume its outputs, reject with `dependent_steps` and list their immutable step IDs.
3. An optional explicit cascade operation may remove the producer and all transitive dependents together, after previewing that set.

Leaving a visible numbering gap such as steps 1, 3, and 4 is unnecessary because numbers are only presentation. The review can renumber them 1, 2, and 3 without changing identity.

### Tool annotations and confirmation UX

Staging and plan-editing tools:

```json
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

`idempotentHint: true` assumes `operation_id` deduplication. Without that field, append operations are not idempotent and the hint must be false.

The commit tool:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Commit is idempotent only if committed-plan results are retained and replaying the same plan ID returns the recorded result without performing upstream writes again.

### Execution is not an upstream database transaction

A single plan and a single confirmation do not make several InvenTree HTTP requests atomic. If operation three fails after operations one and two succeed, the connector must report precise partial completion:

- completed steps and resolved IDs;
- the failed step and upstream error;
- unexecuted steps;
- safe recovery suggestions.

Automatic rollback is unsafe unless InvenTree provides a real transaction endpoint. The UI and documentation should say "committed as one reviewed plan," not "atomically committed."

### Persistence and expiry

- Plans are scoped to the authenticated credential link.
- References are unforgeable opaque tokens stored within one plan; their public form does not need to contain the plan ID.
- Plans expire after a configurable idle period; appending a step refreshes the expiry.
- Committing freezes the plan before the first upstream request.
- Committed and partially failed results are retained briefly for idempotent retry and diagnosis.
- Expired, discarded, committed, and failed plans cannot accept new steps.

## Recommended implementation order

1. Fix the six concrete read/preview correctness issues: complete previews, history normalization, page totals, depleted wording, no-op counts, and label identity.
2. Change staging annotations and response status so staging never requests confirmation.
3. Add mutable plan state with versioning and idempotent step append.
4. Add declared step outputs and server-issued future-entity references.
5. Make label printing and location/stock selection accept `EntitySelector` values.
6. Add consolidated review, step removal, and discard tools.
7. Replace `commit_inventory_change` with dependency-aware `commit_inventory_plan` and retained results.
8. Add integration tests for create-part -> create-stock -> print-future-stock-label, stale snapshots, duplicate append, concurrent commit, partial failure, and retry after commit.
