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
  /** Parsed JSON when content-type is JSON and the body is valid JSON. */
  body: unknown;
  /**
   * EXACT original request bytes (Prompt 00C §D): signature verification
   * (payment webhooks, provider callbacks) must run over the untouched
   * payload — never over a re-serialization of parsed JSON.
   */
  rawBody?: Buffer;
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
  put(path: string, handler: Handler): void {
    this.add("PUT", path, handler);
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

/**
 * Reads the EXACT raw body bytes with a hard size limit (Prompt 00C §D).
 * JSON parsing happens separately so webhook handlers can verify
 * signatures over byte-identical payloads.
 */
export function readRawBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Reject BEFORE buffering anything, but keep draining the socket so
      // the server can still deliver the 413 response (Security Repair 05A
      // §G: oversized bodies never reach parsing/verification).
      req.resume();
      reject(Object.assign(new Error("request body too large"), { status: 413, code: "body_too_large" }));
      return;
    }
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        reject(Object.assign(new Error("request body too large"), { status: 413, code: "body_too_large" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Best-effort JSON parse; never throws for non-JSON bodies. */
export function tryParseJson(raw: Buffer | undefined): unknown {
  if (!raw || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
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
  reason?: string;
}

export function httpError(message: string, status = 400, extra: { code?: string; unavailable?: boolean; reason?: string } = {}): HttpError {
  return Object.assign(new Error(message), { status, ...extra });
}

/**
 * Request log line (Prompt 00B §D): PATHNAME ONLY — query strings can
 * carry tickets/tokens and are never logged. Headers and bodies are never
 * logged either, so Authorization/Cookie/session secrets cannot leak.
 */
export function requestLogLine(method: string, rawUrl: string, status: number, durationMs: number, at = new Date()): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    // Malformed targets are logged verbatim minus any query marker.
    const q = pathname.indexOf("?");
    if (q >= 0) pathname = pathname.slice(0, q);
  }
  return `${at.toISOString()} ${method} ${pathname} -> ${status} (${durationMs}ms)`;
}
