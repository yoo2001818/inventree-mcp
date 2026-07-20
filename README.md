# InvenTree MCP

An OAuth-protected remote [Model Context Protocol](https://modelcontextprotocol.io/) bridge for [InvenTree](https://inventree.org/). It lets ChatGPT use InvenTree as an inventory clerk without exposing the InvenTree API token to the MCP client.

The service is intentionally self-contained for a single owner:

- Streamable HTTP MCP endpoint at `/mcp`
- OAuth 2.1 authorization-code flow with S256 PKCE
- Dynamic client registration (DCR) for ChatGPT
- OAuth protected-resource and authorization-server discovery
- Authorization page where the owner enters an InvenTree URL and API token
- InvenTree credential validation through `/api/user/me/`
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

Set `PUBLIC_URL` to the external origin only, such as `https://inventree-mcp.example.com`. Do not include `/mcp`. Keep `ENCRYPTION_KEY` stable: changing it makes previously linked InvenTree credentials unreadable.

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
   - An InvenTree URL reachable from the bridge container. It may be private, such as `http://inventree-server:8000`; ChatGPT never connects to it directly.
   - A dedicated InvenTree API token.
   - `OWNER_PASSWORD` from the deployment environment.
6. Start a new Work conversation, enable the app, and try: “Find my 10 kΩ resistors and tell me where they are.”

ChatGPT's current MCP authorization flow expects protected-resource metadata, OAuth discovery, DCR or CIMD, the authorization-code flow, PKCE S256, the RFC 8707 `resource` parameter, and tool security metadata. This server implements the DCR/public-client path. See the [OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth) and [connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

## Local development

```bash
npm install
PUBLIC_URL=http://localhost:3000 \
ENCRYPTION_KEY="$(openssl rand -base64 32)" \
OWNER_PASSWORD="$(openssl rand -base64 32)" \
DATA_FILE=./data/state.json \
npm run dev
```

For local OAuth testing, add the inspector's exact redirect origin to `ALLOWED_REDIRECT_ORIGINS`. The default permits only `https://chatgpt.com`.

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
