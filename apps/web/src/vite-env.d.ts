/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Mox Control Plane HTTP API. Optional in production (same-origin). */
  readonly VITE_MOX_API_URL?: string;
  /** Explicit demo-data escape hatch; honored only in dev builds. */
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv & { DEV: boolean; PROD: boolean; MODE: string };
}
