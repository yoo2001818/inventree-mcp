import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

export {};
