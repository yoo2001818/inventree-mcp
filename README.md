# InvenTree MCP

An OAuth-protected remote [Model Context Protocol](https://modelcontextprotocol.io/) bridge for [InvenTree](https://inventree.org/). It lets ChatGPT use InvenTree as an inventory clerk without exposing the InvenTree API token to the MCP client.

The service is intentionally self-contained for a single owner:

- Streamable HTTP MCP endpoint at `/mcp`
- OAuth 2.1 authorization-code flow with S256 PKCE
- Dynamic client registration (DCR) for ChatGPT
- OAuth protected-resource and authorization-server discovery
- Exact-origin CORS support for browser-based MCP and OAuth clients
- A single server-configured InvenTree URL, with API tokens entered during authorization
- InvenTree credential validation through `/api/user/me/`
- HTTP access logs with query strings, headers, and bodies excluded
- AES-256-GCM encryption at rest for the InvenTree token
- Hashed, short-lived OAuth access tokens and rotating refresh tokens
- Persistent JSON state designed for one container instance

## MCP tools

The default workflow profile is intentionally limited to household parts and physical stock. It does not expose manufacturing, purchasing, sales, or BOM workflows.

Read tools return compact Markdown plus minimal normalized structured data. Category and location results preserve their hierarchy, and part search includes quantities, physical paths, and exact stock-item IDs in one call.

| Read tool | Purpose |
| --- | --- |
| `browse_part_categories` | Browse or search the category hierarchy |
| `browse_stock_locations` | Browse or search the physical-location hierarchy |
| `find_parts` | Find parts with aggregate quantities and stock placements |
| `get_part_inventory` | Fetch one useful part card and every stock placement |
| `get_part_image` | Return thumbnails/previews inline or an expiring URL for the original image |
| `inventory_at_location` | List what is physically stored at a location or subtree |
| `check_stock_levels` | Find depleted or below-minimum parts |
| `get_stock_history` | Explain stock changes with a compact timeline |
| `scan_barcode` | Resolve a barcode without changing inventory |
| `inventree_get` | Advanced raw read-only `/api/` escape hatch |

Dedicated write tools append stable steps to a short-lived shared plan. Staging and plan editing do not mutate InvenTree and do not require user confirmation. Review the complete plan once, obtain confirmation, then call `commit_inventory_plan(plan_id, expected_version)`. Commit re-reads relevant upstream state, executes the frozen plan serially, and retains its result for safe retries.

| Write tool | Purpose |
| --- | --- |
| `create_part_with_stock` | Create a part and optional initial stock after duplicate checks |
| `update_part` | Change useful home-inventory part metadata |
| `prepare_part_image_upload` | Create an expiring browser/PUT upload URL and `upload_ref` |
| `get_part_image_upload_status` | Check whether a temporary upload is ready to stage |
| `set_part_image` | Stage a multipart part-image replacement from a temporary upload |
| `receive_stock` | Add newly acquired quantity or create a stock item |
| `consume_stock` | Remove used/discarded quantity with an explicit allocation |
| `move_stock` | Move stock while preserving total quantity |
| `count_stock` | Reconcile recorded quantities with a physical count |
| `set_stock_status` | Mark stock OK, damaged, lost, quarantined, and so on |
| `create_part_category` / `update_part_category` | Organize the part hierarchy |
| `create_stock_location` / `update_stock_location` | Organize the physical hierarchy |
| `print_labels` | Resolve a template and prepare a printer side effect |
| `review_inventory_plan` | Show the consolidated plan with immutable step IDs and output refs |
| `open_inventory_plan_review` | Open an optional interactive extended-confirmation app |
| `remove_inventory_plan_step` | Remove a step, rejecting dependents unless cascade is explicit |
| `discard_inventory_plan` | Discard temporary plan state without changing InvenTree |
| `commit_inventory_plan` | Revalidate and commit the once-confirmed plan |
| `inventree_write` | Optional advanced raw POST/PATCH/PUT escape hatch; no DELETE |

The raw write escape hatch is disabled by default. Set `ENABLE_RAW_WRITE=true` only for development or unusual upstream features; routine clients should use dedicated workflow tools. Use a dedicated InvenTree user with the narrowest roles you can tolerate; the upstream server remains the final authorization boundary.

Part-image bytes never enter MCP JSON arguments or the persisted plan store. Call `prepare_part_image_upload` to receive an expiring, credential-scoped `upload_ref` and capability URL. A person can open that URL and choose a file, while a native client can `PUT` raw PNG, JPEG, GIF, or extended WebP bytes to the same URL without an OAuth header. The capability token is unguessable, short-lived, and omitted from HTTP access logs. After upload, pass the already-known reference to `set_part_image`, review the shared plan normally, and commit once. For reads, `get_part_image` returns thumbnails and previews immediately as base64 MCP image content; only `variant: "original"` returns a short-lived direct-download URL and MCP resource link. `IMAGE_UPLOAD_MAX_BYTES` and `IMAGE_MAX_PIXELS` configure the in-memory bounds.

When the user explicitly asks for extended or detailed confirmation, call `open_inventory_plan_review(plan_id)` instead of relying only on the Markdown review. MCP Apps-capable hosts render an inline plan UI with every change, outputs, operation counts, a partial-failure warning, an acknowledgement checkbox, and a commit button. The button calls the existing version-checked `commit_inventory_plan`; the app never receives OAuth credentials. Hosts without MCP Apps support still receive the complete Markdown fallback and can use the ordinary confirmation flow.

The full command rationale, output contracts, and workflow examples are in [`docs/AI_ERGONOMIC_MCP_COMMANDS.md`](docs/AI_ERGONOMIC_MCP_COMMANDS.md).

## Deploy with Docker Compose

Requirements:

- A hostname reachable by ChatGPT over public HTTPS
- A reverse proxy or tunnel terminating TLS
- Network reachability from this container to InvenTree

Create the environment file:

```bash
cp .env.example .env
openssl rand -base64 32  # use as ENCRYPTION_KEY
openssl rand -base64 32  # use as OWNER_PASSWORD
```

Set `PUBLIC_URL` to the external origin only, such as `https://inventree-mcp.example.com`. Do not include `/mcp`. Set `INVENTREE_URL` to the one InvenTree instance reachable from the bridge container, such as `http://inventree-server:8000`. End users cannot override this URL; changing it and restarting the service moves all existing credential links to the new instance. `ALLOWED_MCP_ORIGINS` is a comma-separated allowlist used for MCP Origin validation and browser CORS across the MCP, OAuth, and discovery endpoints. Keep `ENCRYPTION_KEY` stable: changing it makes previously linked InvenTree credentials unreadable.

Start the service:

```bash
docker compose up -d --build
docker compose logs -f inventree-mcp
```

The compose file binds port 3000 to loopback. Put Caddy, nginx, Traefik, or a secure tunnel in front of it. A minimal Caddy route is:

```caddyfile
inventree-mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Back up the `inventree-mcp-data` volume together with the encryption key. Run only one replica: the JSON state store is atomic on one filesystem but is not a distributed database.

## Connect ChatGPT

1. Deploy the service and verify `https://inventree-mcp.example.com/healthz`.
2. In ChatGPT, enable developer mode under **Settings → Security and login**.
3. Open **Settings → Plugins**, add a developer-mode app, and enter `https://inventree-mcp.example.com/mcp`.
4. Choose dynamic client registration when ChatGPT asks how to register the OAuth client.
5. On the authorization page, enter:
   - A dedicated InvenTree API token.
   - `OWNER_PASSWORD` from the deployment environment.
6. Start a new Work conversation, enable the app, and try: “Find my 10 kΩ resistors and tell me where they are.”

ChatGPT's current MCP authorization flow expects protected-resource metadata, OAuth discovery, DCR or CIMD, the authorization-code flow, PKCE S256, the RFC 8707 `resource` parameter, and tool security metadata. This server implements the DCR/public-client path. See the [OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth) and [connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

## Local development

```bash
npm install
npm run dev
```

`npm run dev` loads the Git-ignored `.env` file. Copy `.env.example` to `.env` and set its values if the file does not exist yet.
It exits immediately when the configured address cannot be bound, including when the port is already occupied. Use `npm run dev:watch` when automatic restarts after file changes are preferred.

For local OAuth testing, `ALLOWED_REDIRECT_ORIGINS` supports the two special loopback patterns `http://localhost:*` and `http://127.0.0.1:*`, allowing Inspector, Codex, and other native clients to choose ephemeral callback ports. No other wildcard forms are accepted. Browser clients still need their exact origin in `ALLOWED_MCP_ORIGINS` for CORS. Local development binds to `127.0.0.1` by default; Docker Compose overrides `BIND_HOST` to `0.0.0.0` inside the container while publishing the port only on host loopback.

Run the checks:

```bash
npm run typecheck
npm test
npm run build
```

The end-to-end test starts a fake InvenTree server and exercises DCR, authorization, upstream token validation, PKCE exchange, MCP initialization, tool discovery, a real proxied part search, insufficient-scope reauthorization, and refresh-token rotation.

## Security notes

- This is a compact single-user authorization server, not a general identity platform.
- `OWNER_PASSWORD` gates authorization and is rate-limited in memory after failed attempts.
- `INVENTREE_URL` fixes the upstream instance for every linked credential; authorization requests cannot select another host.
- MCP requests with an `Origin` header are rejected with HTTP 403 unless the exact origin appears in `ALLOWED_MCP_ORIGINS`.
- CORS preflights allow the browser headers required by MCP Inspector, including authorization, content type, protocol version, session ID, and event resumption headers.
- Part images are signature-checked, byte- and pixel-limited, held only in memory for 30 minutes, and uploaded to InvenTree as multipart data only during a confirmed plan commit. Media reads accept only same-origin `/media/` paths returned by the authenticated part API.
- Access logs include method, pathname, status, response size, and duration. Query parameters, authorization headers, and request bodies are not logged.
- DCR accepts only callback origins listed in `ALLOWED_REDIRECT_ORIGINS`; `https://chatgpt.com` is the default.
- Registrations are rate-limited in memory and capped to prevent unbounded persistent state. For a hardened deployment, also rate-limit at the reverse proxy and optionally restrict the endpoint to OpenAI's published egress ranges.
- InvenTree tokens are encrypted with AES-256-GCM. OAuth bearer and refresh tokens are stored only as SHA-256 hashes.
- Authorization codes are single-use, expire after five minutes, and are bound to client ID, redirect URI, resource, and PKCE challenge.
- MCP access tokens are audience-bound to the configured `/mcp` resource.
- The optional raw write tool intentionally does not support DELETE and is disabled unless `ENABLE_RAW_WRITE=true`.
- Do not expose port 3000 directly without TLS. The application expects a trusted reverse proxy in front of it.

## Reset or revoke everything

Stop the container and remove its state volume. This invalidates OAuth clients, links, access tokens, refresh tokens, and encrypted InvenTree credentials:

```bash
docker compose down
docker volume rm inventree-mcp_inventree-mcp-data
```

The deletion is permanent unless the volume was backed up. You can also invalidate the dedicated token from InvenTree itself.
