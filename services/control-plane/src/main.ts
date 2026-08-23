/**
 * Control Plane entrypoint (Prompt 00 §B). Production composition:
 * validated fail-closed config -> durable service graph -> HTTP listener.
 * Startup aborts with a clear error when DATABASE_URL / MOX_PUBLIC_URL /
 * MOX_BOOTSTRAP_API_TOKEN are absent or PostgreSQL is unreachable.
 */

import { loadControlPlaneConfig, ConfigError } from "./config.js";
import { composeControlPlane } from "./composition.js";
import { startControlPlane } from "./server.js";

async function main(): Promise<void> {
  try {
    const config = loadControlPlaneConfig(process.env);
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    process.stdout.write(
      `mox control plane listening on :${running.port} (env=${config.env}, public=${config.publicUrl})\n`,
    );
    const shutdown = (signal: string) => {
      process.stdout.write(`received ${signal}; shutting down\n`);
      void running.close().then(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`startup failed: ${error.message}\n`);
      process.exit(78); // EX_CONFIG: configuration error
    }
    process.stderr.write(`startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

void main();
