export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function authorizationPage(input: {
  requestId: string;
  clientName: string;
  scopes: string[];
  error?: string;
}): string {
  const scopeItems = input.scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  const error = input.error ? `<div class="error">${escapeHtml(input.error)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize InvenTree MCP</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 2rem 1rem; background: #111827; color: #f9fafb; }
    main { max-width: 34rem; margin: auto; background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 1.5rem; }
    h1 { margin-top: 0; font-size: 1.45rem; }
    p, li { color: #d1d5db; line-height: 1.5; }
    label { display: block; margin: 1rem 0 .35rem; font-weight: 650; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #4b5563; border-radius: 8px; padding: .75rem; background: #111827; color: #fff; }
    button { width: 100%; margin-top: 1.25rem; border: 0; border-radius: 8px; padding: .8rem; background: #22c55e; color: #052e16; font-weight: 750; cursor: pointer; }
    .error { background: #7f1d1d; border: 1px solid #ef4444; border-radius: 8px; padding: .75rem; }
    .warning { font-size: .9rem; color: #fbbf24; }
    code { font-size: .85em; }
  </style>
</head>
<body><main>
  <h1>Connect ${escapeHtml(input.clientName)} to InvenTree</h1>
  <p>This bridge will store your InvenTree API token encrypted and issue a separate OAuth token to the MCP client.</p>
  ${error}
  <p>Requested permissions:</p><ul>${scopeItems}</ul>
  <form method="post" action="/oauth/authorize" autocomplete="off">
    <input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
    <label for="api_token">InvenTree API token</label>
    <input id="api_token" name="api_token" type="password" required spellcheck="false">
    <label for="owner_password">Bridge owner password</label>
    <input id="owner_password" name="owner_password" type="password" required>
    <p class="warning">Use a dedicated, least-privilege InvenTree account. The token is tested before authorization completes.</p>
    <button type="submit">Authorize</button>
  </form>
</main></body></html>`;
}

export function successPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title></head><body><main><h1>Connected</h1><p>${escapeHtml(message)}</p><p>You can close this window.</p></main></body></html>`;
}

export function partImageUploadPage(input: {
  status: "pending" | "ready" | "invalid";
  expiresAt?: number;
  message?: string;
}): string {
  const ready = input.status === "ready";
  const invalid = input.status === "invalid";
  const expires = input.expiresAt
    ? `<p class="muted">This link expires at ${escapeHtml(new Date(input.expiresAt).toISOString())}.</p>`
    : "";
  const body = invalid
    ? `<h1>Upload link unavailable</h1><p>${escapeHtml(input.message ?? "This upload link is invalid or expired.")}</p>`
    : ready
      ? "<h1>Image uploaded</h1><p>The image is ready. Return to your MCP client to stage it on the part.</p>"
      : `<h1>Upload a part image</h1>
  <p>Select a PNG, JPEG, GIF, or extended WebP image. The file is held temporarily until the mutation plan is committed.</p>
  <input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
  <button id="upload" type="button">Upload image</button>
  <p id="status" role="status" aria-live="polite"></p>
  <script>
    const file = document.getElementById("file");
    const button = document.getElementById("upload");
    const status = document.getElementById("status");
    button.addEventListener("click", async () => {
      if (!file.files.length) { status.textContent = "Choose an image first."; return; }
      button.disabled = true;
      status.textContent = "Uploading…";
      try {
        const selected = file.files[0];
        const response = await fetch(window.location.href, {
          method: "PUT",
          headers: {
            "Content-Type": selected.type || "application/octet-stream",
            "X-File-Name": selected.name,
          },
          body: selected,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "Upload failed");
        status.textContent = "Image uploaded. Return to your MCP client to continue.";
        file.disabled = true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Upload failed";
        button.disabled = false;
      }
    });
  </script>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Part image upload</title><style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 2rem 1rem; background: #111827; color: #f9fafb; }
  main { max-width: 36rem; margin: auto; background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 1.5rem; }
  h1 { margin-top: 0; font-size: 1.45rem; }
  p { color: #d1d5db; line-height: 1.5; }
  input { display: block; width: 100%; box-sizing: border-box; margin: 1rem 0; }
  button { border: 0; border-radius: 8px; padding: .8rem 1rem; background: #22c55e; color: #052e16; font-weight: 750; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  .muted { font-size: .85rem; color: #9ca3af; }
</style></head><body><main>${body}${expires}</main></body></html>`;
}
