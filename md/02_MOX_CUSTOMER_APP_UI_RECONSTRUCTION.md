# MOX — PROMPT 02
# Customer App UI/UX Reconstruction

## ROLE

Operate directly on the current canonical:

`E:\MyCodes\Mox`

Start only after Prompt 01 has been reviewed, committed, pushed, and local `master` is clean and synchronized.

Do not assume the old SHA. Re-scan current `master` and record actual HEAD.

Do not commit or push.

---

# OBJECTIVE

Transform the customer-facing Mox web app from an engineering skeleton into a polished commercial AI-agent platform while preserving the authentication/surface separation from Prompt 01.

This prompt is primarily frontend/UI/UX.

Do not redesign backend authorities just for UI convenience.

Do not invent fake data.

---

# ABSOLUTE CUSTOMER-ONLY RULE

Customer application must contain no visible or discoverable product navigation for:
- Mox Admin;
- Mox Support;
- platform operations;
- wholesale provider cost/margin;
- abuse operations;
- internal notification campaigns;
- runtime administration;
- payment-provider administration;
- compute-provider administration.

No Admin/Support link in:
- sidebar;
- profile menu;
- settings;
- footer;
- mobile menu;
- empty states;
- search/command results.

Backend authorization remains mandatory even though links are absent.

---

# TARGET CUSTOMER INFORMATION ARCHITECTURE

Use a grouped sidebar.

## HOME
- Home

## BUILD
- Agents
- Agent Rooms
- Deployments

## INFRASTRUCTURE
- Servers
- Models

## CONNECT
- Apps & Integrations
- Channels

## ACCOUNT
- Usage
- Billing
- Settings

Do not add navigation for functionality that is not real.

Sidebar:
- collapsible on desktop;
- drawer on mobile;
- selected state clear but restrained;
- icons allowed if they improve scanability;
- avoid dependency addition solely for icons unless justified.

---

# TOP BAR

Create a useful top bar using real state:
- current workspace/org;
- org switcher when multiple memberships exist;
- notifications;
- profile/account menu;
- sign out;
- responsive menu control;
- optional search only if backed by real destinations.

Never expose staff capabilities here.

---

# CUSTOMER HOME DASHBOARD

Rebuild Home into a useful operational overview.

Use authoritative API data only.

Recommended sections where current APIs support them:

## Context
- concise workspace heading/greeting;
- workspace name;
- plan/tier if authoritative;
- high-level health/status.

## KPI cards
Possible real metrics:
- total agents;
- active/running agents;
- deployments;
- open approvals;
- server count/health;
- current usage/credits.

Only show metrics derivable correctly.

## Active work
Useful current/recent agents, deployments, approvals, or servers.

## Usage
Show concise usage visualization only if API supports real data.
No fabricated history.

## Quick actions
Only real actions or safe navigational shortcuts.

## Recent activity
Only if authoritative events support it.

---

# VISUAL SYSTEM

Create/normalize design tokens.

Target:
- sophisticated dark neutral base;
- restrained Mox accent;
- strong text contrast;
- subtle layered surfaces;
- consistent spacing rhythm;
- consistent radii;
- clear typography hierarchy;
- compact but readable density;
- intentional hover/focus/active states;
- minimal visual noise.

Avoid:
- giant empty regions;
- excessive bordered cards;
- tiny low-contrast text;
- dashboard made entirely from identical rectangles;
- neon/gamer aesthetics;
- gratuitous gradients;
- fake decorative charts;
- arbitrary colors.

---

# AUTH PAGE POLISH

Prompt 01 creates functional auth pages.

Polish customer:
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`

Keep them outside logged-in app shell.

Do not alter staff authorization logic.

---

# CORE CUSTOMER VIEWS

Review and improve every customer-facing view:
- Agents;
- Agent Rooms;
- Servers;
- Deployments;
- Models;
- Apps & Integrations;
- Channels;
- Usage;
- Billing;
- Settings;
- Notifications.

For each:
- clear title/subtitle;
- real primary action when available;
- polished loading;
- honest empty state;
- honest error state;
- responsive tables/cards;
- human-readable values before raw IDs where available;
- no unnecessary backend jargon;
- no secrets/provider credentials.

Do not silently remove existing functionality.

---

# SETTINGS / ACCOUNT UX

Where supported, organize customer Settings into:
- profile/account;
- workspace;
- authentication/security;
- personal/API tokens;
- preferences;
- notification preferences.

Do not put Mox staff/admin controls here.

---

# BILLING

Customer Billing may show:
- plan/subscription;
- invoices;
- status;
- usage/entitlements.

Never show:
- wholesale cost;
- Mox margin;
- payment-provider keys/configuration;
- platform pricing administration;
- internal reconciliation controls.

---

# RESPONSIVENESS

Validate at:
- 1440+ desktop;
- ~1280 laptop;
- tablet;
- ~390px mobile.

Requirements:
- no shell horizontal overflow;
- responsive tables;
- sidebar collapse/drawer;
- auth forms fit mobile;
- topbar remains usable;
- practical touch target sizes.

---

# ACCESSIBILITY

At minimum:
- semantic headings;
- form labels;
- keyboard navigation;
- visible focus;
- aria labels for icon-only controls;
- contrast;
- reduced-motion respect;
- no color-only information.

---

# LOADING / ERROR BEHAVIOR

Before authenticated identity is established:
- do not render customer dashboard shell.

If control plane is unavailable:
- intentional service-unavailable view;
- no fake healthy metrics;
- no demo data shown as authoritative.

After authenticated:
- localized transient errors can render within shell without destroying navigation.

---

# CODE STRUCTURE

Prefer reusable components.

Do not put the whole frontend back into one `App.tsx`.

Keep coherently separated:
- router;
- public/auth layouts;
- customer shell;
- nav;
- page views;
- UI primitives;
- state/API layer.

Do not replace React/Vite.

Do not add a large UI framework unless absolutely necessary and explicitly justified.

---

# TESTS

Add/update tests proving:
- customer nav has expected items;
- customer nav never exposes Admin/Support;
- collapsed/mobile nav behavior where feasible;
- auth pages exclude app shell;
- Home renders authoritative values from API mocks;
- loading/error/empty states;
- org switcher only uses server-provided memberships;
- logout works;
- protected-route behavior from Prompt 01 remains intact.

---

# VERIFICATION

Run:

```cmd
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm public-branding-scan
pnpm secret-scan
pnpm scan:authority
pnpm dependency-security
git diff --check
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

No migration should normally be needed.

---

# FINAL REPORT

Create:

`docs/verification/CUSTOMER_APP_UI_RECONSTRUCTION.md`

Report:
1. baseline SHA;
2. files changed;
3. component/layout structure;
4. final customer nav;
5. Home changes;
6. each customer page improved;
7. auth visual changes;
8. responsive behavior;
9. accessibility changes;
10. Admin/Support non-disclosure verification;
11. tests/totals;
12. commands/results;
13. dependency additions if any;
14. remaining Critical/High/Medium findings;
15. confirmation no commit/push occurred.

STOP after report.
