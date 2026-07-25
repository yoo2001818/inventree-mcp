# `inventree-local` MCP Connector Feedback

Date: 2026-07-25

## Summary

The connector was exercised against the live inventory after reviewing
`docs/AI_ERGONOMIC_MCP_COMMANDS.md`. Routine inventory workflows are genuinely
agent-friendly, especially the staged mutation protocol. The main opportunities
are more consistent domain error handling, more precise public input schemas,
and tighter bounds on large tree responses.

No inventory plan was committed, no label was printed, and no repository commit
was created.

## Coverage

The evaluation covered these read workflows:

- top-level and branch category browsing;
- top-level, branch, and searched location browsing;
- first and subsequent part-search pages;
- depleted and below-minimum stock checks;
- part inventory and location inventory;
- stock history;
- an unknown barcode;
- missing part and location IDs.

It also covered these non-destructive mutation-planning workflows:

- create a part with initial stock;
- prevent a possible duplicate part;
- receive and consume stock;
- no-op stock counting;
- partial stock movement;
- stock status and part metadata updates;
- create a location and use its future reference as a move destination;
- create a part and use its future stock-item reference for a label;
- consolidated plan review;
- idempotent operation replay;
- stale plan-version rejection;
- plan discard.

`commit_inventory_plan`, a successful physical barcode scan, and actual label
printing were intentionally not tested because they would create external side
effects. The advanced raw `inventree_get` escape hatch was also outside the
routine-flow evaluation.

## What Worked Well

### Compact routine reads

- `find_parts` answered existence, total quantity, and physical placement in one
  call while retaining part, location, and stock-item IDs.
- Subsequent pages used absolute ranges such as `Results 6-10 of 15`.
- Category and location searches preserved readable paths.
- Location inventory distinguished the total number of stock items from the
  number of unique parts on the current page.
- Depleted results used `out of stock`, including when minimum stock was zero.
- Stock history normalized a location change into semantic text without dumping
  an upstream serializer.

### Clear mutation semantics

- Receive, consume, count, move, and status operations produced distinct and
  explicit previews.
- Receive and consume previews showed exact before-and-after quantities.
- Partial moves disclosed that InvenTree would split the source stock item and
  assign a new ID at commit.
- An unchanged physical count returned `already_current` without creating a
  plan.
- Possible duplicate creation was blocked and identified the existing part by
  name and ID.

### Strong plan safety

- A planned stock-item reference from `create_part_with_stock` was accepted by a
  later `print_labels` step.
- A planned location reference from `create_stock_location` was accepted as a
  later move destination.
- Replaying identical content with the same `operation_id` returned the existing
  step without incrementing the plan version.
- A unique append with a stale `expected_version` was rejected with the expected
  and current versions.
- Removing a producer with a dependent label step was rejected and identified
  the immutable dependent step ID.
- Consolidated review showed material fields, immutable step IDs, future refs,
  and total upstream-operation count.
- Label staging resolved `30x15mm` to the enabled stock-item template and showed
  the selected printer before any side effect.

## Recommended Improvements

### 1. Normalize missing-resource errors

Missing parts and locations currently return upstream-oriented messages such as:

```text
InvenTree returned HTTP 404: {"detail":"No Part matches the given query."}
```

An unknown barcode similarly returns the raw HTTP 400 detail payload, including
an internal barcode hash.

These should use the documented domain outcome, for example:

```json
{
  "data": {
    "status": "not_found",
    "entity_type": "part",
    "supplied_id": 99999999,
    "suggested_tool": "find_parts"
  }
}
```

The canonical text should explain the next useful action, and upstream-only
details such as the barcode hash should be omitted.

### 2. Make expected errors programmatically structured

Success responses consistently place fields under `structuredContent.data`, but
stale versions, dependency conflicts, duplicate candidates, and missing entities
place a message under `structuredContent.error`.

Prefer typed domain data instead of requiring clients to parse an error string:

```json
{
  "data": {
    "status": "conflict",
    "expected_version": 1,
    "current_version": 2
  }
}
```

Dependent step IDs and duplicate candidates should likewise be structured
arrays. If errors are intentionally exempt from the uniform `{ data: ... }`
envelope, the connector contract should state that explicitly.

### 3. Replace `unknown` in published input schemas

Several entity-ID fields are published as `unknown`, including some location and
stock-item IDs. `create_part_with_stock.initial_stock.notes` is also published as
`unknown`.

Entity fields should expose the documented scalar union:

```ts
type EntityId = number | string;
```

More precise schemas improve model tool selection, client-side validation, and
generated documentation while retaining support for numeric IDs and typed plan
references.

### 4. Bound large tree responses

Expanding stock location `#1` through level 2 returned 66 nodes in one response.
The depth bound worked, but the response was already large and the tool exposes
no result limit or expansion cursor.

Enforce the documented hard node limit. When a result exceeds it, return a
compact top-level orientation and identify the `root_id` values that can be
expanded next.

### 5. Keep a selected tree root visible

When `root_id` is provided, category and location output begins with the root's
children. Including the selected root as a heading or top node would keep the
text self-contained and preserve the user's physical or categorical point of
reference.

### 6. Trim non-differentiating structured fields

The text output is compact, but structured search results repeatedly include
default values such as:

- `active: true`;
- `locked: false`;
- `trackable: false`;
- `allocated: 0`;
- `expired: false`.

Omitting default fields unless they change inventory behavior would better match
the document's context-efficiency goal.

### 7. Shorten repeated staging guidance

Every staged response repeats the same instruction to append more steps or
review the plan. This is useful on the first step, but it could be shortened on
subsequent steps because plan ID, version, and status already make the next
actions clear.

### 8. Add first-class part image upload and download

The live `볼펜` part (`#124`) demonstrates that image data exists upstream but is
not available through the domain tools. Its raw part response includes relative
`image` and `thumbnail` paths under `/media/part_images/`, while `find_parts` and
`get_part_inventory` omit image information.

MCP supports returning resource links, and InvenTree supports programmatic part-image upload using
`multipart/form-data`. The current connector cannot bridge the two because its
InvenTree client:

- permits only `/api/` paths, excluding returned `/media/` paths;
- sends write bodies as JSON;
- advertises `Accept: application/json`;
- parses every response as text or JSON;
- has no multipart upload or binary download method.

The MCP HTTP endpoint also currently has a 1 MB JSON request limit, so embedding
ordinary photographs as base64 tool arguments would be restrictive and would
inflate persisted mutation plans.

Recommended read tool:

```text
get_part_image(part_id, variant="thumbnail" | "preview" | "original")
```

It should default to `thumbnail`, select only a media path returned by the trusted
InvenTree instance, and return:

- a compact text identity for the part;
- an MCP image block and compact validated metadata for `thumbnail` and
  `preview`, completing those requests in one MCP response;
- an MCP resource link and short-lived direct-download URL for `original`.

The capability URL should proxy the trusted upstream path, require no MCP OAuth
header, and validate the response signature, MIME type, and size when fetched.

Recommended write flow:

1. `prepare_part_image_upload` returns an opaque, expiring `upload_ref` and a
   capability URL scoped to the credential link. The URL provides a browser
   file picker and also accepts raw bytes through `PUT`, without exposing the
   MCP bearer token to either client.
2. `set_part_image(part_id, upload_ref, ...plan fields)` validates the part and
   stages image replacement in the normal inventory plan.
3. `review_inventory_plan` identifies the part, existing-image state, filename,
   MIME type, dimensions, byte size, and replacement side effect.
4. After confirmation, `commit_inventory_plan` sends a multipart update to
   InvenTree and verifies the resulting image and thumbnail paths.

Temporary image bytes should not be serialized into the JSON plan store. The
bridge should validate actual file signatures rather than trusting extensions,
enforce configurable byte and dimension limits, allow only supported image MIME
types, and never fetch an arbitrary caller-supplied URL. Media downloads should
be constrained to the configured InvenTree origin and to paths obtained from an
authenticated InvenTree response.

For clients that can reliably place an attached image into a tool argument, a
small base64 input could be supported as a convenience path. It should not be
the primary upload design because MCP tool inputs are JSON, host handling of user
attachments varies, and base64 adds substantial request overhead.

Relevant protocol and upstream documentation:

- [MCP tool image content and resource links](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [InvenTree part images](https://docs.inventree.org/en/stable/part/)
- [InvenTree part API schema](https://docs.inventree.org/en/stable/api/schema/part/)

## Cleanup Verification

Seven temporary plans were discarded through `discard_inventory_plan`. Final
read checks confirmed:

- the probe part did not exist;
- the probe location did not exist;
- sampled part `#1048` still had 20 units in stock item `#674` at location
  `#105`;
- stock item `#674` remained in status `OK`;
- the Git worktree was clean before this feedback document was added.

## Implementation Response

All eight recommendations were implemented in the following pass:

- missing parts, locations, categories, stock items, part images, and unknown barcodes now return sanitized `not_found` domain data;
- expected conflicts use `structuredContent.data`, including plan versions, dependent step IDs, and duplicate candidates;
- reusable Zod definitions were converted to factories so every published entity ID and notes field retains its precise JSON schema instead of degrading to `{}`;
- category and location expansions are hard-limited to 40 orientation nodes and expose focused `expandableRootIds`;
- selected category and location roots appear in both text and structured output;
- non-differentiating part and stock defaults are omitted from structured summaries;
- only the first staged step repeats append/review guidance;
- `get_part_image`, expiring upload/download capability URLs, browser and native `PUT` uploads, upload-status checks, `set_part_image`, trusted media downloads, signature and size validation, and multipart commit execution were added without persisting image bytes in plans or capability tokens in access logs.
- Only relative `/media/` paths are accepted as part images. Static placeholders, absolute URLs, and other namespaces are normalized as no image across part summaries, image retrieval, and replacement previews.
- Generic `/mcp` HTTP access lines are suppressed in favor of semantic `tools/call` console entries containing the tool name and arguments, with secrets and capability tokens redacted.

## Unified Plan Creation Update

The incremental mutation surface was subsequently replaced by one `create_inventory_plan` tool. The former mutation tool names remain as typed action discriminators inside its ordered `steps` array, but are no longer published as separately callable MCP tools. `prepare_part_image_upload`, upload status, plan review, discard, and commit remain standalone because they operate outside initial plan construction.

One request can now express dependent workflows such as category creation, part plus initial stock, and label printing. Each step has an agent-chosen request-local `key`; later entity fields refer to earlier outputs with a structured `{ "step": "part", "output": "stock_item" }` value. The server rejects duplicate keys and unknown or forward references, translates accepted symbols to opaque canonical refs, and returns the whole reviewed plan plus an informational alias mapping.

The redesign also changes safety and latency behavior:

- action arguments do not expose `plan_id`, `expected_version`, or per-step operation IDs;
- the top-level `operation_id` idempotently identifies the complete plan;
- any validation failure discards temporary partially staged plan state;
- the successful creation response is already the canonical review, so normal workflows require only plan creation followed by one confirmed commit;
- immutable server-issued step IDs and refs remain authoritative for review, removal, dependency protection, and commit;
- formal part units are normally omitted and are checked against `/api/units/all/` before plan creation when explicitly supplied;
- upstream commit errors retain sanitized field-level validation details, HTTP status, failed step ID, and completed-operation counts.
