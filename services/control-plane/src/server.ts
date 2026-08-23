/**
 * Control Plane HTTP server assembly (Prompt 00 §A/§B): node:http server,
 * router dispatch, uniform error mapping. Unavailability is reported
 * honestly (503 + machine-readable code) — never masked with demo data.
 */

import { createServer, type Server } from "node:http";
import type { ControlPlaneServices } from "./composition.js";
import { verifyDependencies } from "./composition.js";
import { AuthError } from "./auth.js";
import { buildApiRouter } from "./api.js";
import { httpError, readRawBody, requestLogLine, Router, sendJson, tryParseJson } from "./http.js";

export interface RunningControlPlane {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startControlPlane(services: ControlPlaneServices): Promise<RunningControlPlane> {
  const router: Router = buildApiRouter({ services });

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => undefined);
  });

  const url = new URL(services.config.publicUrl);
  const port = services.config.port;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      void url;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            services.pool.end().finally(() => undefined);
          }),
      });
    });
  });

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const started = Date.now();
    try {
      if (!req.url) throw httpError("missing request target", 400);
      const parsed = new URL(req.url, `http://localhost:${port}`);

      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const match = router.match(req.method ?? "GET", parsed.pathname);

      if (!match) {
        // Distinguish "unknown path" from "wrong method" honestly.
        throw httpError(`no route for ${req.method} ${parsed.pathname}`, 404);
      }
      let rawBody: Buffer | undefined;
      if (["POST", "PATCH", "PUT"].includes(req.method ?? "")) {
        // Prompt 00C §D: exact bytes captured BEFORE any parsing so webhook
        // signature verification sees the untouched payload.
        rawBody = await readRawBody(req);
      }
      const result = await match.handler({
        req,
        res,
        params: match.params,
        query: parsed.searchParams,
        body: tryParseJson(rawBody),
        rawBody,
      });
      if (result !== undefined && !res.writableEnded) {
        sendJson(res, 200, result);
      }
    } catch (error) {
      respondWithError(res, error);
    } finally {
      logRequest(req, res, started);
    }
  }

  /**
   * Prompt 00C §C: explicit allowlisted-origin topology. For exact matches
   * the server echoes the origin and grants credentials; there is no
   * wildcard, ever. Subdomain splits (app./api. on one registrable domain)
   * work with SameSite=Lax cookies because they are same-site.
   */
  function applyCors(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const origin = req.headers.origin;
    res.setHeader("vary", "Origin");
    if (!origin || services.config.corsOrigins.length === 0) return;
    if (services.config.corsOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,x-mox-csrf,authorization");
      res.setHeader("access-control-max-age", "600");
    }
  }

  function respondWithError(res: import("node:http").ServerResponse, error: unknown): void {
    if (res.writableEnded) return;
    if (error instanceof AuthError) {
      sendJson(res, error.status, { error: error.message, code: "unauthenticated" });
      return;
    }
    const err = error as { status?: number; message?: string; code?: string; unavailable?: boolean };
    const status = typeof err.status === "number" ? err.status : 500;
    sendJson(res, status, {
      error: err.message ?? "internal error",
      ...(err.code ? { code: err.code } : {}),
      ...(status >= 500 || err.unavailable ? { unavailable: true } : {}),
    });
  }

  function logRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, started: number): void {
    // Prompt 00B §D: pathname ONLY — query strings may carry secrets and
    // are never logged; headers/bodies never logged either.
    process.stdout.write(requestLogLine(req.method ?? "GET", req.url ?? "-", res.statusCode, Date.now() - started) + "\n");
  }
}

/** Liveness probe used by orchestrators after start. */
export async function healthcheck(services: ControlPlaneServices): Promise<boolean> {
  try {
    await verifyDependencies(services);
    return true;
  } catch {
    return false;
  }
}
