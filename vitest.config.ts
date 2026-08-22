import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// The include glob is relative to the invocation cwd, so it matches both
// `pnpm test` at the repo root and `vitest run` inside a workspace package.
// Imported upstream trees are explicitly excluded.
//
// Workspace packages are aliased to their TypeScript sources so tests always
// exercise current code, never a stale `dist/` build.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@mox/adapters", replacement: src("./packages/adapters/src/index.ts") },
      { find: "@mox/agent-control", replacement: src("./services/agent-control/src/index.ts") },
      { find: "@mox/agent-runtime", replacement: src("./runtime/agent-runtime/src/index.ts") },
      { find: "@mox/billing", replacement: src("./services/billing/src/index.ts") },
      { find: "@mox/channel-gateway", replacement: src("./services/channel-gateway/src/index.ts") },
      { find: "@mox/cost-engine", replacement: src("./services/cost-engine/src/index.ts") },
      { find: "@mox/integration-gateway", replacement: src("./services/integration-gateway/src/index.ts") },
      { find: "@mox/notification-service", replacement: src("./services/notification-service/src/index.ts") },
      { find: "@mox/backups", replacement: src("./packages/backups/src/index.ts") },
      { find: "@mox/platform-ops", replacement: src("./services/platform-ops/src/index.ts") },
      { find: "@mox/usage-meter", replacement: src("./services/usage-meter/src/index.ts") },
      { find: "@mox/computer-runtime", replacement: src("./runtime/computer-runtime/src/index.ts") },
      { find: "@mox/compute-providers", replacement: src("./packages/compute-providers/src/index.ts") },
      { find: "@mox/contracts", replacement: src("./packages/contracts/src/index.ts") },
      { find: "@mox/credentials", replacement: src("./packages/credentials/src/index.ts") },
      { find: "@mox/database", replacement: src("./packages/database/src/index.ts") },
      { find: "@mox/entitlements", replacement: src("./packages/entitlements/src/index.ts") },
      { find: "@mox/events", replacement: src("./packages/events/src/index.ts") },
      { find: "@mox/money", replacement: src("./packages/money/src/index.ts") },
      { find: "@mox/feature-flags", replacement: src("./packages/feature-flags/src/index.ts") },
      { find: "@mox/observability", replacement: src("./packages/observability/src/index.ts") },
      { find: "@mox/provider-health", replacement: src("./packages/provider-health/src/index.ts") },
      { find: "@mox/mox-node", replacement: src("./runtime/mox-node/src/index.ts") },
      { find: "@mox/agent-control", replacement: src("./services/agent-control/src/index.ts") },
      { find: "@mox/policy", replacement: src("./packages/policy/src/index.ts") },
      { find: "@mox/provider-sdk", replacement: src("./packages/provider-sdk/src/index.ts") },
      { find: "@mox/runtime-client", replacement: src("./packages/runtime-client/src/index.ts") },
      { find: "@mox/security", replacement: src("./packages/security/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "OpenBot-main/**",
      "OpenMausBot-main/**",
      "deepseek-harness-master/**",
    ],
  },
});