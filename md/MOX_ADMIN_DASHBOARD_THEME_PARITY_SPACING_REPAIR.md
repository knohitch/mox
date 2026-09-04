# MOX — ADMIN DASHBOARD THEME PARITY + SPACING REPAIR
# FIX JAM-PACKED METRICS, OPERATIONAL PANELS, INVISIBLE CARDS, AND LIGHT-THEME BUTTON CONTRAST

## MODEL

Use **Gemini 3.1 Pro High**.

This is a focused Admin UI repair on top of the Admin/Customer visual unification work already completed.

Do NOT redesign the Admin information architecture.

Do NOT change Admin API calls, RBAC, staff capabilities, billing authority, compute authority, customer isolation, Support isolation, or authentication.

---

# REPOSITORY

Work directly in:

`E:\MyCodes\Mox`

Use the CURRENT LOCAL WORKING TREE as authoritative.

IMPORTANT:

The Admin theme-unification work may contain local changes newer than the last pushed GitHub commit.

Therefore:

```cmd
cd /d E:\MyCodes\Mox
git branch --show-current
git status --short
git rev-parse HEAD
```

Rules:

- branch must be `master`;
- DO NOT reset;
- DO NOT checkout an older commit;
- DO NOT discard existing local Admin UI work;
- if the tree is dirty, preserve those changes and repair on top of them;
- re-scan the actual current local source before editing;
- do not push automatically.

---

# PRIMARY OBJECTIVE

Fix the Admin Dashboard so Dark and Light themes have identical layout hierarchy and equivalent surface visibility.

Current visual defects:

1. The seven platform overview metrics are jam-packed together:

```text
Customers               142
Active subscriptions    118
Active servers          326
Runtime health          894/894
Notification jobs       2
Abuse reports           0
Recorded revenue        48,200.00 USD
```

They need more breathing room and a deliberate responsive layout.

2. The three operational panels are also cramped:

```text
Provider incidents
Recent notification jobs
Open abuse
```

They need to use the available width and have more spacing between panels.

3. On Light theme, some buttons use a dark background with dark text, making their labels difficult or impossible to read.

4. Theme parity is broken:

### Dark theme

These cards are visible:

```text
Payment failures
Provisioning failures
Degraded runtime agents
Provider incidents
```

but the seven platform overview metric cards visually disappear / merge into the page.

### Light theme

The seven platform overview cards are visible,

but these four attention cards visually disappear / merge into the page:

```text
Payment failures
Provisioning failures
Degraded runtime agents
Provider incidents
```

This means two different card families are not using the same semantic surface system.

Fix the root design-system problem.

---

# CODEBASE FINDINGS TO RE-VERIFY

The repository currently/previously contains these patterns.

## Attention cards

`AdminView.tsx` uses:

```tsx
<div className="needs-attention-grid" aria-label="Needs attention">
  <div className="needs-chip">
    <strong>{m.paymentFailures}</strong>
    <span>Payment failures</span>
  </div>

  ...
</div>
```

The CSS has used:

```css
.needs-attention-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.needs-chip {
  border: none;
  background: var(--bg-card);
  border-radius: var(--r-md);
  padding: 12px 14px;
}
```

Light theme currently has values equivalent to:

```css
--bg: #ffffff;
--bg-card: #ffffff;
```

so without a border/shadow the cards disappear into the page.

---

## Platform overview metrics

`AdminView.tsx` has historically had an Admin-only component:

```tsx
function Metric({ label, value, detail }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
```

and:

```tsx
<div className="admin-metrics">
  <Metric label="Customers" ... />
  <Metric label="Active subscriptions" ... />
  <Metric label="Active servers" ... />
  <Metric label="Runtime health" ... />
  <Metric label="Notification jobs" ... />
  <Metric label="Abuse reports" ... />
  <Metric label="Recorded revenue" ... />
</div>
```

Older CSS contains dark-only assumptions such as:

```css
.admin-metric {
  background: #141920;
}
```

and Admin-specific values such as:

```css
--admin-ink: #eef2f5;
```

If the recent UI unification refactor changed these, inspect the CURRENT implementation and fix the equivalent problem there.

Do not restore old hardcoded colors.

---

## Operational panel grid

The three lower panels are currently rendered through:

```tsx
<div className="grid grid-3">
  <Card title="Provider incidents">...</Card>
  <Card title="Recent notification jobs">...</Card>
  <Card title="Open abuse">...</Card>
</div>
```

The generic grid has historically used:

```css
.grid-3 {
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}
```

For exactly three cards on a wide screen, `auto-fill` can reserve additional empty tracks.

That causes the three actual panels to occupy only part of the available row instead of expanding cleanly across it.

This is a concrete layout issue.

---

## Generic button bug

Current shared CSS has historically included:

```css
button {
  background: #24304a;
  color: var(--text);
  border: 1px solid #35435f;
}
```

This is dark-theme-specific.

In Light mode:

```text
background = dark blue
text = dark theme text token resolved for Light
```

which can create dark-on-dark / low-contrast buttons.

Remove this hardcoded cross-theme assumption.

---

# PART 1 — CREATE ONE ADMIN DASHBOARD CARD LANGUAGE

The following MUST all use the same semantic Mox surface hierarchy:

```text
Needs-attention cards
Platform overview metric cards
Operational panels
```

They may differ in size and density, but not in theme behavior.

Use semantic tokens such as:

```text
--surface-card
--surface-card-hover
--border-default
--border-strong
--shadow-sm
--shadow-md
--text
--text-dim
```

or the current equivalent.

Do NOT create:

```text
darkAdminCard
lightAdminCard
```

as separate component logic.

Theme differences belong in tokens.

---

# PART 2 — CARD SURFACE PARITY

Every Admin Dashboard card must remain visually distinguishable from the canvas in BOTH themes.

## Dark

Target:

```text
Canvas
near-black

Card
graphite, clearly but subtly elevated

Border
subtle light alpha

Shadow
restrained
```

Conceptually:

```text
Canvas      #09090b
Card        #18181b-ish
Hover       #27272a-ish
```

Use existing semantic tokens.

---

## Light

Target:

```text
Canvas
white / near-white

Card
white

Separation
subtle border and/or restrained shadow
```

Since white cards can sit on a white canvas, Light MUST use sufficient:

- shadow;
- border;
- or slightly tinted canvas/surface distinction.

Do not rely on background color alone.

---

# PART 3 — NEEDS-ATTENTION ROW

The four top cards:

```text
Payment failures
Provisioning failures
Degraded runtime agents
Provider incidents
```

should be a deliberate responsive four-card row.

Desktop target:

```text
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ 0                    │  │ 0                    │  │ 0                    │  │ 0                    │
│ Payment failures     │  │ Provisioning failures│  │ Degraded runtime...  │  │ Provider incidents   │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

Use more breathing room.

Recommended:

```css
gap: 16px;
```

or around 16–20px.

At wide desktop:

```css
grid-template-columns: repeat(4, minmax(0, 1fr));
```

At medium:

```text
2 × 2
```

At mobile:

```text
1 column
```

Do not use a configuration that creates invisible empty tracks.

The cards must be visible in Light AND Dark.

---

# PART 4 — PLATFORM OVERVIEW METRICS

The seven cards should NOT be compressed into seven narrow boxes in one row.

Preferred desktop composition:

```text
Row 1:
Customers
Active subscriptions
Active servers
Runtime health

Row 2:
Notification jobs
Abuse reports
Recorded revenue
```

In other words:

```text
4 + 3
```

This creates breathing room and allows longer values such as:

```text
48,200.00 USD
894/894
```

to render comfortably.

Recommended wide-screen grid:

```css
grid-template-columns: repeat(4, minmax(0, 1fr));
gap: 16px;
```

Then:

```text
<= 1200-ish: 3 columns
<= 900-ish: 2 columns
mobile: 1 column
```

Use appropriate existing breakpoints rather than blindly copying these exact numbers.

Do NOT use:

```css
repeat(auto-fill, minmax(170px, 1fr))
```

if it results in seven cramped columns.

---

# METRIC CARD CONTENT SPACING

Each overview metric card should have intentional internal rhythm:

```text
Label

Primary value

Optional detail
```

Recommended:

```text
padding: 16–18px
min-height: around 104–116px
gap: 8px
```

Do not over-pad.

Example:

```text
Runtime health

894/894

agents healthy
```

should not render as:

```text
894/894agents healthy
```

There must be clear vertical separation between value and detail.

Recorded revenue should render cleanly.

Preferred:

```text
48,200.00
USD
```

or:

```text
48,200.00 USD
```

depending on the shared metric component.

Do not allow the currency to collide with the value.

---

# PART 5 — USE SHARED METRIC PRIMITIVES WHERE POSSIBLE

Mox already has shared:

```tsx
<KpiCard />
<MetricCard />
<Card />
<Panel />
```

If the current Admin `Metric` component only exists to reproduce shared visual behavior, replace/refactor it to use the shared primitive.

Do not force shared components if Admin needs a legitimately different semantic layout.

But there should not be a separate hardcoded Admin-only card theme.

---

# PART 6 — OPERATIONAL PANELS MUST USE THE AVAILABLE WIDTH

Current:

```text
Provider incidents
Recent notification jobs
Open abuse
```

must be spaced apart and should span the available Admin content width.

The existing `grid-3` definition using:

```css
repeat(auto-fill, minmax(240px, 1fr))
```

is dangerous here because `auto-fill` preserves empty tracks.

For this exact three-panel composition use an intentional grid.

Desktop:

```css
grid-template-columns: repeat(3, minmax(0, 1fr));
gap: 18px;
```

or equivalent.

Tablet:

```text
2 columns + 1
```

Small:

```text
1 column
```

Do NOT let the three cards occupy only the left half of a wide page.

---

# PART 7 — FIX EMPTY OPERATIONAL PANELS

The current empty states are visually oversized.

Example:

```text
Provider incidents

[ giant empty box ]
No records.
```

For an operational Admin dashboard, empty is GOOD.

Use a compact positive/neutral empty state.

Preferred:

```text
Provider incidents

No provider incidents.
```

or:

```text
No records.
```

inside a restrained panel body.

Do not create a 180–250px empty illustration area just to show a gray circle.

The panel itself can remain substantial enough for balance, but its empty content should not look like a broken placeholder.

---

# PART 8 — FIX LIGHT-THEME BUTTON CONTRAST GLOBALLY

This is important.

Do NOT only patch the Refresh button.

Find the shared generic button rule.

Remove hardcoded dark-only values such as:

```css
button {
  background: #24304a;
  color: var(--text);
  border: 1px solid #35435f;
}
```

Replace them with semantic button tokens or shared Button classes.

Recommended tokens:

```text
--button-bg
--button-bg-hover
--button-border
--button-text

--button-primary-bg
--button-primary-text

--button-danger-bg
--button-danger-text
--button-danger-border
```

Dark conceptual values:

```text
Default background: graphite
Default text: near-white
Default border: subtle light alpha
```

Light conceptual values:

```text
Default background: white / light gray
Default text: near-black
Default border: subtle dark alpha
```

Primary:

```text
Mox accent background
white text
```

Danger:

```text
semantic red tint
semantic red text
```

Do not hardcode exact colors in individual Admin components if tokens already exist.

---

# BUTTON STATES TO VERIFY

Verify in BOTH themes:

- Refresh
- form submit buttons
- Staff & Access actions
- Enable
- Disable
- Revoke
- Create invite
- any Admin primary action
- dropdown/menu buttons
- topbar/profile controls

Check:

```text
normal
hover
focus
disabled
danger
primary
ghost
```

No button text may disappear because foreground and background converge.

---

# PART 9 — DO NOT USE `filter: brightness(...)` AS THE ONLY HOVER SYSTEM

If the generic button still uses:

```css
button:hover {
  filter: brightness(1.15);
}
```

review it.

A semantic hover background is more predictable across Light/Dark.

Prefer:

```text
background: var(--button-bg-hover)
border-color: var(--button-border-hover)
```

where possible.

Do not cause icons/text to blur or unexpectedly change contrast.

---

# PART 10 — LIGHT/DARK PARITY MATRIX

After the repair, the EXACT SAME card groups must be visible in both themes.

## Group A — Needs attention

```text
Payment failures
Provisioning failures
Degraded runtime agents
Provider incidents
```

Dark: visible cards.
Light: visible cards.

## Group B — Overview

```text
Customers
Active subscriptions
Active servers
Runtime health
Notification jobs
Abuse reports
Recorded revenue
```

Dark: visible cards.
Light: visible cards.

## Group C — Operational

```text
Provider incidents
Recent notification jobs
Open abuse
```

Dark: visible panels.
Light: visible panels.

No group may disappear into the canvas in either theme.

---

# PART 11 — ADMIN CONTENT WIDTH

The Admin Dashboard should use available desktop width intelligently.

Check current rules such as:

```css
.main > .admin-console {
  max-width: var(--content-max);
}
```

and current StaffShell/Main width.

Do not blindly remove all content constraints.

But at 1440–1920px, make sure:

- metric grids use the available content width;
- operational panels use the width;
- large blank right-side areas are not caused by CSS grid empty tracks;
- Admin does not look compressed into the left half of the viewport.

The first fix should be the grid definitions.

Only adjust the Admin content max-width if there is still unnecessary dead space after correcting grids.

---

# PART 12 — REMOVE REMAINING DARK-ONLY ADMIN VISUAL TOKENS

Search for:

```text
--admin-line
--admin-ink
--admin-copper
--admin-teal
#141920
#24304a
#35435f
```

and other Admin/generic hardcoded dark colors.

For each:

- replace generic presentation use with semantic Mox theme tokens;
- retain a hardcoded value only when it is truly a brand/semantic color and works in both themes.

Do not leave:

```css
color: #eef2f5;
```

on an element that must support Light mode.

---

# PART 13 — PRESERVE THE OFFICIAL MOX LOGO

Do not regress the recent Admin shell logo work.

Admin must keep:

```tsx
<MoxLogo variant="full" />
```

expanded and:

```tsx
<MoxLogo variant="mark" />
```

collapsed.

Dark:

```text
white logo
```

Light:

```text
dark logo
```

Do not edit the official SVG geometry.

---

# PART 14 — PRESERVE AUTHORIZATION

Do NOT change:

```text
visibleAdminTabs
hasSurfaceCapability
canManageStaff
staffSession
Admin login
Support login
Customer/Admin/Support route separation
```

The Admin UI may change visually only.

---

# PART 15 — UI STUDIO VISUAL QA

Use the current development Studio.

Inspect:

## Dark

```text
http://localhost:5173/__ui?surface=admin&page=dashboard&role=superadmin&state=populated&theme=dark
```

## Light

```text
http://localhost:5173/__ui?surface=admin&page=dashboard&role=superadmin&state=populated&theme=light
```

You MUST visually inspect both.

Do not claim completion from tests alone.

Compare them side by side.

---

# REQUIRED SCREENSHOT-SCENARIO CHECK

The populated fixture containing approximately:

```text
Customers              142
Active subscriptions   118
Active servers          326
Runtime health          894/894
Notification jobs       2
Abuse reports           0
Recorded revenue        48,200.00 USD
```

must show:

- clearly visible cards in Dark;
- clearly visible cards in Light;
- comfortable spacing;
- no content collision;
- no seven-card cramped row.

The attention fixture with four zeros must show four visible cards in both themes.

---

# PART 16 — RESPONSIVE QA

Verify at:

```text
1920px
1440px
1280px
1024px
768px
390px
```

Recommended behavior:

## Needs attention

```text
wide: 4
medium: 2
mobile: 1
```

## Overview metrics

```text
wide: 4 + 3
medium: 3 / 2
tablet: 2
mobile: 1
```

## Operational panels

```text
wide: 3
medium: 2 + 1
mobile: 1
```

Avoid horizontal page overflow.

---

# PART 17 — TESTS

Add/update focused tests.

At minimum prove:

1. Dashboard renders four attention cards.
2. Dashboard renders all seven overview metrics.
3. Dashboard renders three operational panels.
4. Metric values/details remain separate DOM elements.
5. Overview grid no longer forces seven narrow columns.
6. Operational grid does not use an empty-track-producing layout for exactly three cards.
7. Shared button styling is theme-semantic, not hardcoded dark-only.
8. Light theme button text remains readable.
9. Dark theme button text remains readable.
10. both attention and overview cards use theme-aware semantic surfaces.
11. Admin capability gating remains unchanged.
12. UI Studio uses the production AdminView.
13. Customer and Support surfaces are not regressed.

Avoid giant exact-CSS snapshots.

---

# VERIFICATION

Run:

```cmd
pnpm --filter @mox/web test
pnpm --filter @mox/web run typecheck
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm public-branding-scan
pnpm secret-scan
pnpm scan:authority
pnpm dependency-security
git diff --check
```

No database migration should be necessary.

Do not weaken tests.

---

# FINAL VISUAL ACCEPTANCE CHECK

Before stopping, visually answer YES to all:

### Theme parity

- Are all four attention cards visible in Light?
- Are all four attention cards visible in Dark?
- Are all seven overview cards visible in Light?
- Are all seven overview cards visible in Dark?
- Are all three operational panels visible in both?

### Spacing

- Are the seven overview metrics no longer jam-packed?
- Do the three operational panels use the row width?
- Is there at least ~16px visual separation between major cards?

### Buttons

- Can I clearly read Refresh in Light?
- Can I clearly read Refresh in Dark?
- Are Admin form/action buttons readable in both?

### Content

- Does `894/894` have visible separation from `agents healthy`?
- Does `48,200.00 USD` render without collision?
- Do empty operational cards look intentional rather than like giant placeholders?

### Regression

- Is the official Mox logo still correct?
- Does sidebar collapse still work?
- Is Admin authorization unchanged?
- Are Customer and Support unaffected?

If any answer is NO, continue refining.

---

# REPORT

Create:

`docs/verification/ADMIN_DASHBOARD_THEME_PARITY_SPACING_REPAIR.md`

Include:

- files changed;
- root causes;
- grid changes;
- card-surface changes;
- button-token changes;
- Light/Dark comparison;
- responsive results;
- tests/results;
- confirmation authorization unchanged.

After verification, create a LOCAL commit:

`fix(admin-ui): repair dashboard spacing and theme parity`

Do not push.
