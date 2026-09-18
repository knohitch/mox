import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const distDir = path.resolve(process.env.MOX_WEB_DIST_DIR || "/app/apps/web/dist");
const port = Number(process.env.PORT || 80);
const rawApiBaseUrl = (process.env.VITE_MOX_API_URL || "").trim();
const publicDemo = ["1", "true", "yes", "on"].includes(
  (process.env.MOX_PUBLIC_DEMO || "").trim().toLowerCase(),
);

if (!rawApiBaseUrl) {
  process.stderr.write("web startup failed: VITE_MOX_API_URL is required when MOX_PROCESS_TYPE=web\n");
  process.exit(78);
}

let apiBaseUrl;
try {
  const parsed = new URL(rawApiBaseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("must use https outside localhost");
  }
  apiBaseUrl = parsed.toString().replace(/\/$/, "");
} catch (error) {
  process.stderr.write(
    `web startup failed: invalid VITE_MOX_API_URL (${error instanceof Error ? error.message : String(error)})\n`,
  );
  process.exit(78);
}

try {
  const info = await stat(distDir);
  if (!info.isDirectory()) throw new Error("not a directory");
} catch (error) {
  process.stderr.write(
    `web startup failed: MOX_WEB_DIST_DIR is unavailable at ${distDir} (${error instanceof Error ? error.message : String(error)})\n`,
  );
  process.exit(78);
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

function commonHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function sendFile(req, res, filePath, cacheControl) {
  commonHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream");
  res.setHeader("cache-control", cacheControl);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    })
    .pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");

    if (requestUrl.pathname === "/healthz") {
      commonHeaders(res);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(JSON.stringify({ ok: true, service: "mox-web" }));
      }
      return;
    }

    if (requestUrl.pathname === "/mox-runtime-config.js") {
      commonHeaders(res);
      res.statusCode = 200;
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      const body = `window.__MOX_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify({ apiBaseUrl, publicDemo })});\n`;
      if (req.method === "HEAD") res.end();
      else res.end(body);
      return;
    }

    if (publicDemo && (req.method === "GET" || req.method === "HEAD") && requestUrl.pathname === "/") {
      commonHeaders(res);
      res.statusCode = 302;
      res.setHeader("location", "/login");
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      commonHeaders(res);
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    const relative = pathname.replace(/^\/+/, "");
    const candidate = path.resolve(distDir, relative || "index.html");
    if (!candidate.startsWith(distDir + path.sep) && candidate !== path.join(distDir, "index.html")) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (await fileExists(candidate)) {
      const immutable = candidate.includes(`${path.sep}assets${path.sep}`);
      sendFile(req, res, candidate, immutable ? "public, max-age=31536000, immutable" : "no-cache");
      return;
    }

    sendFile(req, res, path.join(distDir, "index.html"), "no-cache");
  } catch {
    if (!res.headersSent) {
      commonHeaders(res);
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }
    res.end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`mox web listening on :${port} (api=${apiBaseUrl}, publicDemo=${publicDemo})\n`);
});

const shutdown = (signal) => {
  process.stdout.write(`received ${signal}; shutting down mox web\n`);
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
