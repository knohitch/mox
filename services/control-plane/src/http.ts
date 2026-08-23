/**
 * Minimal HTTP kernel for the Mox Control Plane: routing, JSON body
 * parsing and error mapping on top of node:http. No framework dependency;
 * every handler is explicit about auth and tenant scoping.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

/** Registers `path/:param/segment` style routes. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const paramNames: string[] = [];
    const source = path
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), paramNames, handler });
  }

  get(path: string, handler: Handler): void {
    this.add("GET", path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add("POST", path, handler);
  }
  patch(path: string, handler: Handler): void {
    this.add("PATCH", path, handler);
  }
  delete(path: string, handler: Handler): void {
    this.add("DELETE", path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? "");
      });
      return { handler: route.handler, params };
    }
    return undefined;
  }

  hasRouteFor(method: string, pathname: string): boolean {
    return this.routes.some((r) => r.pattern.test(pathname));
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export interface HttpError extends Error {
  status?: number;
  code?: string;
  unavailable?: boolean;
}

export function httpError(message: string, status = 400, extra: { code?: string; unavailable?: boolean } = {}): HttpError {
  return Object.assign(new Error(message), { status, ...extra });
}
