import { describe, expect, it } from "vitest";
import { detectCrossOrigin } from "../src/api/http-api.js";

describe("detectCrossOrigin", () => {
  it("treats an empty API base URL as same-origin", () => {
    expect(detectCrossOrigin("", "https://app.mox.example")).toBe(false);
  });

  it("detects a different API origin", () => {
    expect(detectCrossOrigin("https://api.mox.example", "https://app.mox.example")).toBe(true);
  });

  it("treats matching origins as same-origin", () => {
    expect(detectCrossOrigin("https://mox.example", "https://mox.example")).toBe(false);
  });
});
