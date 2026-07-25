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

| Tool | Scope | Purpose |
| --- | --- | --- |
| `search_parts` | `inventree.read` | Search parts by free text and category |
| `get_part` | `inventree.read` | Fetch one part by ID |
| `list_stock` | `inventree.read` | Search stock items |
| `list_stock_locations` | `inventree.read` | Resolve physical locations to IDs |
| `get_part_bom` | `inventree.read` | Fetch BOM lines for an assembly |
| `inventree_get` | `inventree.read` | Bounded read-only `/api/` escape hatch |
| `inventree_write` | `inventree.write` | Explicit POST/PATCH/PUT escape hatch; no DELETE |

The write tool is marked destructive and requires an exact confirmation phrase. Use a dedicated InvenTree user with the narrowest roles you can tolerate; the upstream server remains the final authorization boundary.

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
- Access logs include method, pathname, status, response size, and duration. Query parameters, authorization headers, and request bodies are not logged.
- DCR accepts only callback origins listed in `ALLOWED_REDIRECT_ORIGINS`; `https://chatgpt.com` is the default.
- Registrations are rate-limited in memory and capped to prevent unbounded persistent state. For a hardened deployment, also rate-limit at the reverse proxy and optionally restrict the endpoint to OpenAI's published egress ranges.
- InvenTree tokens are encrypted with AES-256-GCM. OAuth bearer and refresh tokens are stored only as SHA-256 hashes.
- Authorization codes are single-use, expire after five minutes, and are bound to client ID, redirect URI, resource, and PKCE challenge.
- MCP access tokens are audience-bound to the configured `/mcp` resource.
- The generic write tool intentionally does not support DELETE. Remove it entirely if read-only access is sufficient.
- Do not expose port 3000 directly without TLS. The application expects a trusted reverse proxy in front of it.

## Reset or revoke everything

Stop the container and remove its state volume. This invalidates OAuth clients, links, access tokens, refresh tokens, and encrypted InvenTree credentials:

```bash
docker compose down
docker volume rm inventree-mcp_inventree-mcp-data
```

The deletion is permanent unless the volume was backed up. You can also invalidate the dedicated token from InvenTree itself.
