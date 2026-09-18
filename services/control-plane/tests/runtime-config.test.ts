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

  it("parses platform admin roles and never escalates legacy ids to wildcard", () => {
    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        MOX_PLATFORM_ADMIN_USER_IDS: "admin-unmapped",
      }),
    ).toThrow(/no role\/capability mapping/);

    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        MOX_PLATFORM_ADMIN_CAPABILITIES: "admin-legacy:*",
      }),
    ).toThrow(/not mapped to superadmin/);

    const config = loadControlPlaneConfig({
      ...baseEnv,
      MOX_PLATFORM_ADMIN_USER_IDS: "admin-all",
      MOX_PLATFORM_ADMIN_ROLES: "admin-all:superadmin,admin-support:support,admin-ops:ops_admin",
      MOX_PLATFORM_ADMIN_CAPABILITIES: "admin-read:admin.read|admin.notifications.write,admin-billing:admin.billing.write",
    });
    expect(config.platformAdminRoles["admin-all"]).toBe("superadmin");
    expect(config.platformAdminRoles["admin-support"]).toBe("support");
    expect(config.platformAdminRoles["admin-ops"]).toBe("ops_admin");
    expect(config.platformAdminCapabilities["admin-read"]).toEqual(["admin.read", "admin.notifications.write"]);
    expect(config.platformAdminCapabilities["admin-billing"]).toEqual(["admin.billing.write"]);
  });

  it("rejects a missing MOX_WEB_DIST_DIR and accepts an existing directory", () => {
    expect(() =>
      loadControlPlaneConfig({
        ...baseEnv,
        MOX_WEB_DIST_DIR: "/definitely-not-a-mox-web-dist",
      }),
    ).toThrow(/MOX_WEB_DIST_DIR does not exist/);

    const config = loadControlPlaneConfig({
      ...baseEnv,
      MOX_WEB_DIST_DIR: process.cwd(),
    });
    expect(config.webDistDir).toBe(process.cwd());
  });
});
