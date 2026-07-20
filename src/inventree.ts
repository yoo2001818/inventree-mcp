export interface InvenTreeCredentials {
  baseUrl: string;
  apiToken: string;
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

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
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
    const token = this.credentials.apiToken.replace(/^Token\s+/i, "").trim();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Token ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > 2_000_000) {
        throw new InvenTreeError("InvenTree response exceeded the 2 MB safety limit", response.status);
      }
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text.slice(0, 2_000);
        }
      }
      if (!response.ok) {
        throw new InvenTreeError(`InvenTree returned HTTP ${response.status}`, response.status, data);
      }
      return data;
    } catch (error) {
      if (error instanceof InvenTreeError) throw error;
      if ((error as Error).name === "AbortError") throw new InvenTreeError("InvenTree request timed out");
      throw new InvenTreeError(`Could not reach InvenTree: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
