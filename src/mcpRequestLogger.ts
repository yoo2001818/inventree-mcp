interface LogStream {
  write(message: string): void;
}

const SECRET_KEY = /(authorization|password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)/i;
const MAX_LOG_CHARS = 100_000;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : sanitize(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]");
  }
  return value;
}

function requests(body: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(body) ? body : [body];
  return values.filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

export function logMcpToolCalls(
  body: unknown,
  stream: LogStream = process.stdout,
  now = new Date(),
): void {
  for (const request of requests(body)) {
    if (request.method !== "tools/call") continue;
    const params = request.params !== null && typeof request.params === "object"
      ? request.params as Record<string, unknown>
      : {};
    const entry = sanitize({
      id: request.id,
      name: params.name,
      arguments: params.arguments ?? {},
    });
    const serialized = JSON.stringify(entry);
    const bounded = serialized.length > MAX_LOG_CHARS
      ? `${serialized.slice(0, MAX_LOG_CHARS)}…[truncated]`
      : serialized;
    stream.write(`${now.toISOString()} MCP tools/call ${bounded}\n`);
  }
}
