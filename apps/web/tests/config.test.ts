import { describe, expect, it } from "vitest";
import { resolveWebConfig, WebConfigError } from "../src/config.js";

describe("resolveWebConfig", () => {
  it("uses same-origin API when production builds omit VITE_MOX_API_URL", () => {
    expect(resolveWebConfig({ PROD: true } as ImportMeta["env"])).toEqual({
      mode: "production-api",
      apiBaseUrl: "",
    });
  });

  it("still requires an explicit API URL in development", () => {
    expect(() => resolveWebConfig({ PROD: false, DEV: true } as ImportMeta["env"])).toThrow(WebConfigError);
  });

  it("accepts an explicit https control-plane URL", () => {
    expect(
      resolveWebConfig({
        PROD: true,
        VITE_MOX_API_URL: "https://api.mox.example/",
      } as ImportMeta["env"]),
    ).toEqual({
      mode: "production-api",
      apiBaseUrl: "https://api.mox.example",
    });
  });
});
