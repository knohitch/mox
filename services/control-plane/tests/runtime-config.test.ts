import { describe, expect, it } from "vitest";
import { ConfigError, loadControlPlaneConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://mox:mox@localhost:5432/mox",
  MOX_PUBLIC_URL: "https://mox.example",
};

describe("control-plane Mox Runtime config", () => {
  it("production requires explicit full Mox Runtime mode and command", () => {
    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        NODE_ENV: "production",
        MOX_RUNTIME_MODE: "disabled",
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        NODE_ENV: "production",
        MOX_RUNTIME_MODE: "reference-dev",
        MOX_RUNTIME_COMMAND: "node",
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        NODE_ENV: "production",
        MOX_RUNTIME_MODE: "full",
      }),
    ).toThrow(ConfigError);

    const config = loadControlPlaneConfig({
      ...baseEnv,
      NODE_ENV: "production",
      MOX_RUNTIME_MODE: "full",
      MOX_RUNTIME_COMMAND: "mox-runtime",
      MOX_RUNTIME_ARGS: "--stdio --profile production",
    });
    expect(config.runtimeMode).toBe("full");
    expect(config.runtimeCommand).toBe("mox-runtime");
    expect(config.runtimeArgs).toEqual(["--stdio", "--profile", "production"]);
  });

  it("parses per-user platform admin capabilities and keeps the legacy all-capability allowlist", () => {
    const config = loadControlPlaneConfig({
      ...baseEnv,
      MOX_PLATFORM_ADMIN_USER_IDS: "admin-all",
      MOX_PLATFORM_ADMIN_CAPABILITIES: "admin-read:admin.read|admin.notifications.write,admin-billing:admin.billing.write",
    });
    expect(config.platformAdminCapabilities["admin-all"]).toEqual(["*"]);
    expect(config.platformAdminCapabilities["admin-read"]).toEqual(["admin.read", "admin.notifications.write"]);
    expect(config.platformAdminCapabilities["admin-billing"]).toEqual(["admin.billing.write"]);
  });
});
