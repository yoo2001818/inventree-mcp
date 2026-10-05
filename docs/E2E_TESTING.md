# Real InvenTree end-to-end tests

The Docker test stack uses the fixed Compose project `inventree-mcp-e2e`, dedicated volumes, random test credentials, and loopback-only host ports. It does not read the connector's production `.env` or use its Compose stack. The runner requires Node 22 or newer, Docker, Docker Compose, and access to download container images.

```bash
npm run test:e2e       # initialize InvenTree, build MCP, start services, run checks
npm run test:e2e:run   # rerun checks against the existing running services
npm run test:e2e:down  # stop this project; retain test data and credentials
```

The full command can be repeated with the existing test database. Each run creates fixtures with a unique `E2E` prefix and keeps them available for inspection. A failed check exits nonzero; rerun after fixing it. After changing connector source, use the full command to rebuild its container.

| Service / artifact | Location |
| --- | --- |
| InvenTree UI and API | `http://localhost:18000` |
| MCP endpoint | `http://localhost:18300/mcp` |
| Generated credentials | `.e2e/stack.env` (mode 0600) |
| Test report, check durations, and fixture IDs | `.e2e/report.json` |
| Image download, database initialization, and build logs | `.e2e/pull.log`, `.e2e/initialization.log`, `.e2e/build.log` |

Sign into InvenTree using `INVENTREE_ADMIN_USER` and `INVENTREE_ADMIN_PASSWORD` from the generated test file. For an interactive OAuth client, use the test instance's API token and `OWNER_PASSWORD` from that same file. OAuth clients must use an allowed loopback callback. Browser clients need their exact origin added to the test file's `ALLOWED_MCP_ORIGINS` before recreating MCP.

On first setup, `E2E_INVENTREE_PORT` and `E2E_MCP_PORT` can override the host ports. `E2E_INVENTREE_IMAGE` can override the pinned InvenTree image. Once generated, `.e2e/stack.env` remains authoritative for subsequent runs. Reusing data with another image requires normal InvenTree upgrade compatibility.

## Checks

The test client sends HTTP JSON-RPC directly to the built MCP container, authenticating through discovery, dynamic client registration, authorization-code PKCE, and the real upstream API token. The core fixture is canonical part `10nF 50V X7R 0603`, linked to manufacturer part `0603B103K500NT`, supplier SKU `C57112`, four parameter values, and supplier-linked stock.

The 24 checks cover:

- Real server version and token authentication; OAuth discovery, PKCE, read-only scope enforcement, initialization, tool discovery, and refresh rotation.
- Skill discovery/import manifests, every packaged resource's exact bytes and SHA-256 digest, and read-only guide fallback through the built Docker image.
- Staged category, location, supplier/manufacturer companies, and parameter-template creation.
- The complete capacitor plan, no upstream mutations while staging, and idempotent commit replay.
- Updating a parameter inherited from a category without creating duplicate rows; preserving units and notes.
- SKU/MPN sourcing lookup, canonical part discovery, parameter and company pagination, and specification filters with unit conversion and AND semantics.
- Sparse company, manufacturer-part, supplier-part, template, and parameter updates; already-current values; duplicate identifiers, invalid choices, wrong roles, and missing IDs.
- Rejecting stale commits before mutation; merging stock from the same supplier while keeping unknown provenance separate.
- Image upload through a capability URL, staged multipart commit, and authenticated thumbnail retrieval through the media proxy.
- Migrating existing part `RC0603FR-0710KL` to `10kΩ ±1% 0603 75V 100mW`, adding linked sourcing and five parameters, and attaching the supplier part to two original stock lots while verifying all their other fields and IDs remain intact.
- Sparse stock edits, clearing/restoring provenance, already-current part/stock edits, cross-part source rejection, stale migration rejection before renaming, and editing initial-stock/receipt outputs within the same plan.
- Purchase-order lines with distinct supplier-part and canonical-part IDs, and build-order requirements generated from a real BOM.

Category defaults, purchase orders, purchase lines, and the BOM/build fixtures are seeded directly through the test InvenTree API. Order tools are tested as reads; order lifecycle writes remain unsupported. All connector mutations otherwise go through MCP plans and commits, with direct API reads checking the stored results.

## Verified version and compatibility fix

Verified on 2026-10-05 against InvenTree **1.5.6**, API **530**, using:

```text
inventree/inventree@sha256:b61e6a7534bf82e70b72d8de53d0983ecda1343554e090baf70246944da65588
```

Real-server testing found that scoped parameter templates serialize their model type as `part.part`. The connector now accepts that form as well as `part`, while continuing to reject templates scoped to other models. The fast regression fixture also uses the real serialized form.

The stack intentionally remains running after checks. `test:e2e:down` preserves volumes so it can be restarted and inspected; deleting volumes is a separate explicit action.
