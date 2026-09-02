import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { OnboardingView } from "../src/views/OnboardingView.js";
import { MoxPreviewProvider } from "../src/api/store.js";
import { NavAdapterProvider, type NavAdapter } from "../src/router.js";
import { createMockMoxStore } from "../src/uiStudio/mockStore.js";

// The router's useRoute reads window.location when initializing state; the
// NavAdapter covers navigation, but the initializer still runs under SSR.
beforeAll(() => {
  vi.stubGlobal("window", {
    location: { pathname: "/onboarding", search: "", origin: "http://localhost:5173" },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    history: { pushState: () => {}, replaceState: () => {} },
  });
});

/**
 * Rendered via react-dom/server like the other component tests: the onboarding
 * flow must be a STANDALONE full-screen surface (NO customer sidebar), reuse
 * the shared design-system primitives, and expose an accessible progress
 * indicator. Studio fixtures keep this free of any real authority.
 */

const adapter: NavAdapter = {
  path: "/onboarding",
  navigate: () => {},
  hrefFor: (to) => to,
};

function renderOnboarding(onboardingState: "step1" | "step6" | "error" | "provider-unavailable"): string {
  const store = createMockMoxStore("customer", onboardingState === "error" ? "error" : "populated", undefined, onboardingState);
  return renderToString(
    React.createElement(NavAdapterProvider, {
      adapter,
      children: React.createElement(MoxPreviewProvider, {
        value: store,
        children: React.createElement(OnboardingView),
      }),
    }),
  );
}

describe("OnboardingView (standalone, no sidebar)", () => {
  it("renders the focused onboarding shell with NO sidebar or app chrome", () => {
    const html = renderOnboarding("step1");
    expect(html).toContain("onboarding-shell");
    expect(html).toContain("onboarding-card");
    // The customer sidebar / topbar must never appear in the flow.
    expect(html).not.toContain('class="sidebar');
    expect(html).not.toContain("sidebar-desktop");
    expect(html).not.toContain("nav-scroll");
    expect(html).not.toContain("topbar-customer");
  });

  it("uses the shared design-system primitives (buttons, tokens, badges)", () => {
    const html = renderOnboarding("step1");
    expect(html).toContain("btn btn-primary");
    expect(html).toContain("onboarding-option");
  });

  it("exposes an accessible progress indicator with step semantics", () => {
    const html = renderOnboarding("step1");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="6"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain("Step <strong>1</strong> of");
    expect(html).toContain('aria-current="step"');
  });

  it("renders form labels and semantic radio groups on the workspace step", () => {
    const html = renderOnboarding("step1");
    expect(html).toContain('for="onb-display-name"');
    expect(html).toContain('for="onb-workspace-name"');
    expect(html).toContain('type="radio"');
    expect(html).toContain("Which best describes you?");
  });

  it("shows the readiness review with distinct statuses on the final step", () => {
    const html = renderOnboarding("step6");
    expect(html).toContain("Readiness review");
    expect(html).toContain("Workspace");
    expect(html).toContain("AI model");
    expect(html).toContain("First agent");
    expect(html).toContain("Infrastructure");
    expect(html).toContain("Connections");
  });

  it("surfaces load failure honestly instead of pretending progress exists", () => {
    const html = renderOnboarding("error");
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("Step <strong>1</strong>");
  });

  it("marks unavailable Mox-managed models as unusable (no fake managed access)", () => {
    const html = renderOnboarding("provider-unavailable");
    expect(html).toContain("Mox-managed model configuration is not available");
  });
});
