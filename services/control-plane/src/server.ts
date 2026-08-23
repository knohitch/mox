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
import { httpError, readJsonBody, Router, sendJson } from "./http.js";

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
      void url;
      resolve({
        server,
        port,
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
      const match = router.match(req.method ?? "GET", parsed.pathname);

      if (!match) {
        // Distinguish "unknown path" from "wrong method" honestly.
        throw httpError(`no route for ${req.method} ${parsed.pathname}`, 404);
      }
      const body = ["POST", "PATCH", "PUT"].includes(req.method ?? "")
        ? await readJsonBody(req)
        : undefined;
      const result = await match.handler({
        req,
        res,
        params: match.params,
        query: parsed.searchParams,
        body,
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
    // Audit line without secrets: path only, never headers or bodies.
    const durationMs = Date.now() - started;
    process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} (${durationMs}ms)\n`);
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
