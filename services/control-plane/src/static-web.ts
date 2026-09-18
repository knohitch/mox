/**
 * Production SPA hosting from the control-plane process. API, webhook and
 * health routes stay JSON; every other GET/HEAD is a static file or the
 * Vite index.html rewrite.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function isReservedControlPlanePath(pathname: string): boolean {
  return pathname === "/healthz" || pathname.startsWith("/api/") || pathname.startsWith("/webhooks/");
}

export interface ResolvedWebAsset {
  filePath: string;
  contentType: string;
  cacheControl: string;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function existingFile(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export async function resolveWebFile(webDistDir: string, pathname: string): Promise<ResolvedWebAsset | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const dist = resolve(webDistDir);
  const relativePath = decoded === "/" || decoded.endsWith("/") ? "index.html" : decoded.replace(/^\/+/, "");
  const direct = resolve(dist, relativePath);
  if (!insideRoot(dist, direct)) return null;

  const found = await existingFile(direct);
  if (found) return describeAsset(found);

  if (extname(direct) === "") {
    const index = resolve(dist, "index.html");
    if (!insideRoot(dist, index)) return null;
    const html = await existingFile(index);
    if (html) return describeAsset(html);
  }
  return null;
}

function describeAsset(filePath: string): ResolvedWebAsset {
  const ext = extname(filePath).toLowerCase();
  return {
    filePath,
    contentType: MIME[ext] ?? "application/octet-stream",
    cacheControl: ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  };
}

export async function tryServeWebAsset(
  req: IncomingMessage,
  res: ServerResponse,
  webDistDir: string,
  pathname: string,
): Promise<boolean> {
  const asset = await resolveWebFile(webDistDir, pathname);
  if (!asset) return false;
  const info = await stat(asset.filePath);
  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": info.size,
    "cache-control": asset.cacheControl,
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(asset.filePath);
    stream.on("error", (error) => {
      if (!res.writableEnded) res.end();
      reject(error);
    });
    res.on("finish", () => resolvePromise());
    stream.pipe(res);
  });
  return true;
}
