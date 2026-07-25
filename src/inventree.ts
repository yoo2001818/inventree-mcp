export interface InvenTreeCredentials {
  baseUrl: string;
  apiToken: string;
}

export interface BinaryResponse {
  bytes: Buffer;
  contentType: string;
}

export class InvenTreeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function normalizeInvenTreeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("InvenTree URL must use http:// or https://");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export class InvenTreeClient {
  constructor(private readonly credentials: InvenTreeCredentials) {}

  async testConnection(): Promise<{ username: string; user: unknown }> {
    const user = (await this.request("GET", "/api/user/me/")) as Record<string, unknown>;
    const username = String(user.username ?? user.name ?? user.pk ?? "authenticated user");
    return { username, user };
  }

  async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", path, undefined, query);
  }

  async write(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body);
  }

  async writeMultipart(
    method: "POST" | "PATCH" | "PUT",
    path: string,
    file: { field: string; bytes: Buffer; filename: string; mimeType: string },
  ): Promise<unknown> {
    const url = this.apiUrl(path);
    const form = new FormData();
    form.append(file.field, new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType }), file.filename);
    return this.fetchJson(url, method, form);
  }

  async downloadMedia(path: string, maxBytes: number): Promise<BinaryResponse> {
    if (!path.startsWith("/media/") || path.includes("..") || path.includes("?") || path.includes("#")) {
      throw new InvenTreeError("InvenTree returned an invalid media path");
    }
    const baseUrl = new URL(`${this.credentials.baseUrl}/`);
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/media/")) {
      throw new InvenTreeError("Media path escaped the configured InvenTree media namespace");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "image/*", Authorization: `Token ${this.token()}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new InvenTreeError(`InvenTree returned HTTP ${response.status}`, response.status);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > maxBytes) throw new InvenTreeError(`InvenTree image exceeded the ${maxBytes}-byte safety limit`);
      if (!response.body) throw new InvenTreeError("InvenTree returned an empty media response", response.status);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let received = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new InvenTreeError(`InvenTree image exceeded the ${maxBytes}-byte safety limit`);
        }
        chunks.push(Buffer.from(chunk.value));
      }
      const bytes = Buffer.concat(chunks, received);
      return { bytes, contentType: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
    } catch (error) {
      if (error instanceof InvenTreeError) throw error;
      if ((error as Error).name === "AbortError") throw new InvenTreeError("InvenTree media request timed out");
      throw new InvenTreeError(`Could not download InvenTree media: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private token(): string {
    return this.credentials.apiToken.replace(/^Token\s+/i, "").trim();
  }

  private apiUrl(path: string): URL {
    if (!path.startsWith("/api/") || path.includes("..")) {
      throw new InvenTreeError("Only absolute /api/ paths are allowed");
    }
    if (path.includes("?") || path.includes("#")) {
      throw new InvenTreeError("Put query parameters in the query object, not the API path");
    }
    const baseUrl = new URL(`${this.credentials.baseUrl}/`);
    const apiPrefix = `${baseUrl.pathname.replace(/\/$/, "")}/api/`.replace(/\/{2,}/g, "/");
    const url = new URL(path.slice(1), baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(apiPrefix)) {
      throw new InvenTreeError("API path escaped the configured InvenTree /api/ namespace");
    }
    return url;
  }

  private async fetchJson(url: URL, method: string, body: BodyInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method,
        headers: { Accept: "application/json", Authorization: `Token ${this.token()}` },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      return await this.parseJsonResponse(response);
    } catch (error) {
      if (error instanceof InvenTreeError) throw error;
      if ((error as Error).name === "AbortError") throw new InvenTreeError("InvenTree request timed out");
      throw new InvenTreeError(`Could not reach InvenTree: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > 2_000_000) throw new InvenTreeError("InvenTree response exceeded the 2 MB safety limit", response.status);
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text.slice(0, 2_000);
      }
    }
    if (!response.ok) throw new InvenTreeError(`InvenTree returned HTTP ${response.status}`, response.status, data);
    return data;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.apiUrl(path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Token ${this.token()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
      return await this.parseJsonResponse(response);
    } catch (error) {
      if (error instanceof InvenTreeError) throw error;
      if ((error as Error).name === "AbortError") throw new InvenTreeError("InvenTree request timed out");
      throw new InvenTreeError(`Could not reach InvenTree: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
