import type { Request, Response } from "express";
import morgan from "morgan";

export function createRequestLogger(stream: morgan.StreamOptions = process.stdout) {
  return morgan<Request, Response>(
    (tokens, req, res) => {
      const token = (name: string, argument?: string | number | boolean) =>
        tokens[name]?.(req, res, argument) ?? "-";

      return [
        token("date", "iso"),
        token("method"),
        req.path,
        token("status"),
        `${token("res", "content-length")}b`,
        `${token("response-time", 3)}ms`,
      ].join(" ");
    },
    { stream },
  );
}
