import { describe, expect, it } from "vitest";
import {
  CUSTOMER_PRODUCT_ROUTES,
  ONBOARDING_ROUTE,
  postAuthDestination,
  resolveCustomerOnboardingRouting,
} from "../src/domain/onboarding.js";
import {
  STUDIO_CUSTOMER_PAGES,
  STUDIO_ONBOARDING_PAGE,
  parseStudioSearch,
  serializeStudioSearch,
} from "../src/uiStudio/previewNavigation.js";
import type { OnboardingState } from "../src/api/types.js";

function state(status: OnboardingState["status"], overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    orgId: "org_1",
    status,
    currentStep: 1,
    completedSteps: [],
    persona: null,
    goals: [],
    displayName: null,
    workspaceName: null,
    modelSetupChoice: null,
    modelProviderId: null,
    agentSetupChoice: null,
    agentId: null,
    infrastructureSetupChoice: null,
    serverOrderId: null,
    connectionsSetupChoice: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    updatedByUserId: null,
    missingRequiredSteps: [1, 2, 3, 4, 5, 6],
    ...overrides,
  };
}

describe("customer onboarding routing matrix", () => {
  it("redirects an incomplete workspace from every product route to onboarding", () => {
    for (const status of ["not_started", "in_progress"] as const) {
      for (const route of CUSTOMER_PRODUCT_ROUTES) {
        const decision = resolveCustomerOnboardingRouting({ path: route, onboarding: state(status) });
        expect(decision).toEqual({ kind: "redirect", to: ONBOARDING_ROUTE });
      }
      // Root behaves like a product route for incomplete workspaces.
      expect(resolveCustomerOnboardingRouting({ path: "/", onboarding: state(status) })).toEqual({
        kind: "redirect",
        to: ONBOARDING_ROUTE,
      });
    }
  });

  it("renders onboarding standalone while incomplete and never redirects away from it", () => {
    for (const status of ["not_started", "in_progress"] as const) {
      const decision = resolveCustomerOnboardingRouting({ path: ONBOARDING_ROUTE, onboarding: state(status) });
      expect(decision).toEqual({ kind: "view-onboarding" });
    }
  });

  it("sends a completed customer who manually visits onboarding to the dashboard", () => {
    const decision = resolveCustomerOnboardingRouting({ path: ONBOARDING_ROUTE, onboarding: state("completed") });
    expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("allows completed customers on every product route and the root", () => {
    for (const route of [...CUSTOMER_PRODUCT_ROUTES, "/"]) {
      const decision = resolveCustomerOnboardingRouting({ path: route, onboarding: state("completed") });
      expect(decision).toEqual({ kind: "allow" });
    }
  });

  it("fails open when the durable state is unavailable (no redirect loops, no trapping)", () => {
    for (const route of [...CUSTOMER_PRODUCT_ROUTES, "/", ONBOARDING_ROUTE]) {
      const decision = resolveCustomerOnboardingRouting({ path: route, onboarding: null });
      expect(["allow", "view-onboarding"]).toContain(decision.kind);
      // /onboarding with unknown state still renders the flow (it re-reads).
      if (route === ONBOARDING_ROUTE) expect(decision).toEqual({ kind: "view-onboarding" });
      else expect(decision).toEqual({ kind: "allow" });
    }
  });

  it("never redirects unknown paths into onboarding", () => {
    const decision = resolveCustomerOnboardingRouting({ path: "/totally-unknown", onboarding: state("not_started") });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("contains no redirect loop between /onboarding and the dashboard", () => {
    const incomplete = resolveCustomerOnboardingRouting({ path: "/dashboard", onboarding: state("not_started") });
    expect(incomplete).toEqual({ kind: "redirect", to: ONBOARDING_ROUTE });
    const back = resolveCustomerOnboardingRouting({ path: incomplete.kind === "redirect" ? incomplete.to : "/", onboarding: state("not_started") });
    expect(back).toEqual({ kind: "view-onboarding" });

    const complete = resolveCustomerOnboardingRouting({ path: ONBOARDING_ROUTE, onboarding: state("completed") });
    expect(complete).toEqual({ kind: "redirect", to: "/dashboard" });
    const backAgain = resolveCustomerOnboardingRouting({ path: complete.kind === "redirect" ? complete.to : "/", onboarding: state("completed") });
    expect(backAgain).toEqual({ kind: "allow" });
  });
});

describe("post-auth destination (signup/login routing)", () => {
  it("sends a brand-new signup to onboarding", () => {
    expect(postAuthDestination({ signedUp: true, onboarding: state("not_started"), returnTo: null })).toBe(ONBOARDING_ROUTE);
    expect(postAuthDestination({ signedUp: true, onboarding: null, returnTo: null })).toBe(ONBOARDING_ROUTE);
  });

  it("sends an incomplete login to onboarding even with a return target", () => {
    expect(postAuthDestination({ signedUp: false, onboarding: state("in_progress"), returnTo: "/settings" })).toBe(ONBOARDING_ROUTE);
    expect(postAuthDestination({ signedUp: false, onboarding: state("not_started"), returnTo: "/dashboard" })).toBe(ONBOARDING_ROUTE);
  });

  it("sends a completed login to the safe return target or dashboard", () => {
    expect(postAuthDestination({ signedUp: false, onboarding: state("completed"), returnTo: "/billing" })).toBe("/billing");
    expect(postAuthDestination({ signedUp: false, onboarding: state("completed"), returnTo: null })).toBe("/dashboard");
    expect(postAuthDestination({ signedUp: false, onboarding: state("completed"), returnTo: "/" })).toBe("/dashboard");
  });

  it("never returns a completed customer to the onboarding wizard via returnTo", () => {
    expect(postAuthDestination({ signedUp: false, onboarding: state("completed"), returnTo: ONBOARDING_ROUTE })).toBe("/dashboard");
  });
});

describe("UI Studio onboarding preview URL state (dev-only)", () => {
  it("registers the onboarding page for the studio WITHOUT adding it to the customer sidebar nav", async () => {
    const { CUSTOMER_NAV } = await import("../src/concepts/nav.js");
    expect(STUDIO_CUSTOMER_PAGES.some((p) => p.id === STUDIO_ONBOARDING_PAGE.id)).toBe(true);
    expect(CUSTOMER_NAV.some((group) => group.entries.some((entry) => entry.to === "/onboarding"))).toBe(false);
  });

  it("round-trips the onboarding preview state in the studio URL", () => {
    const parsed = parseStudioSearch("/__ui?surface=customer&page=/onboarding&state=populated&onboarding=step3");
    expect(parsed.page).toBe("/onboarding");
    expect(parsed.onboarding).toBe("step3");
    const reparsed = parseStudioSearch(serializeStudioSearch(parsed));
    expect(reparsed.onboarding).toBe("step3");

    const other = parseStudioSearch("/__ui?surface=customer&page=/dashboard&state=populated");
    expect(other.onboarding).toBeUndefined();
    expect(serializeStudioSearch(other)).not.toContain("onboarding=");
  });

  it("rejects unknown onboarding preview states (no arbitrary fixture injection)", () => {
    expect(parseStudioSearch("/__ui?surface=customer&page=/onboarding&onboarding=bogus").onboarding).toBeUndefined();
  });
});

describe("direct demo onboarding access in development", () => {
  it("allows direct access to /onboarding without auth in dev mode", async () => {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { vi } = await import("vitest");
    vi.stubGlobal("window", {
      location: { pathname: "/onboarding", search: "", origin: "http://localhost:5173" },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      history: { pushState: () => {}, replaceState: () => {} },
    });
    const { CustomerSurface } = await import("../src/App.js");
    const { MoxPreviewProvider } = await import("../src/api/store.js");
    const { NavAdapterProvider } = await import("../src/router.js");
    const { createMockMoxStore } = await import("../src/uiStudio/mockStore.js");

    // Unauthenticated store (needsAuth = true) simulating someone typing /onboarding directly into URL
    const store = createMockMoxStore("customer", "populated", "superadmin");
    const unauthStore = { ...store, needsAuth: true, onboarding: null };

    const adapter = {
      path: "/onboarding",
      navigate: () => {},
      hrefFor: (to: string) => to,
    };

    const html = renderToString(
      React.createElement(NavAdapterProvider, {
        adapter,
        children: React.createElement(MoxPreviewProvider, {
          value: unauthStore,
          children: React.createElement(CustomerSurface),
        }),
      }),
    );

    // In dev mode, it must render the onboarding wizard directly rather than redirecting to login
    expect(html).toContain("onboarding-shell");
    expect(html).toContain("onboarding-card");
  });
});

