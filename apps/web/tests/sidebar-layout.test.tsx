import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { CustomerShell } from "../src/shell/CustomerShell.js";
import { StaffShell } from "../src/App.js";
import { ThemeProvider } from "../src/ui/theme.js";

// Mock the router and store
vi.mock("../src/router.js", () => ({
  Link: ({ children, className }: any) => <a className={className}>{children}</a>,
  useRoute: () => ({ navigate: vi.fn(), path: "/" }),
  useNavSection: () => ({ section: undefined }),
}));

vi.mock("../src/api/store.js", () => {
  const me = { displayName: "Test", email: "test@mox.test", orgId: "1", orgs: [] };
  const mockContext = {
    me,
    agents: [],
    staffSession: { ...me, capabilities: ["admin.read", "support.read"] },
    signOut: vi.fn(),
    switchOrg: vi.fn(),
  };
  return {
    useMox: () => mockContext,
  };
});

describe("Unified Sidebar Architecture", () => {
  it("Customer nav items use the shared nav-item class", () => {
    const html = renderToString(
      <ThemeProvider>
        <CustomerShell activePath="/dashboard">Content</CustomerShell>
      </ThemeProvider>
    );
    expect(html).toContain('class="nav-item');
    expect(html).toContain('class="nav-scroll"');
  });

  it("Admin nav items use the shared nav-item class", () => {
    const html = renderToString(
      <ThemeProvider>
        <StaffShell surface="admin">Content</StaffShell>
      </ThemeProvider>
    );
    expect(html).toContain('class="nav-item');
    expect(html).toContain('class="nav-scroll"');
  });

  it("Support nav items use the shared nav-item class", () => {
    const html = renderToString(
      <ThemeProvider>
        <StaffShell surface="support">Content</StaffShell>
      </ThemeProvider>
    );
    expect(html).toContain('class="nav-item');
    expect(html).toContain('class="nav-scroll"');
  });
});
