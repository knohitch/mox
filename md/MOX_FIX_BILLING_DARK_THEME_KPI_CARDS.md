# MOX — FIX BILLING KPI CARDS IN DARK THEME

## MODEL

Use **Gemini 3.1 Pro High**.

This is a focused visual-system bug fix.

Do not redesign Billing functionality.
Do not change billing authority, plans, invoices, subscription logic, payment flows, entitlements, pricing data, or API contracts.

---

# REPOSITORY

Work directly in:

`E:\MyCodes\Mox`

Use the latest clean `master`.

Before editing:

```cmd
git fetch --prune origin
git switch master
git branch --show-current
git rev-parse HEAD
git rev-parse origin/master
git status --short
```

If `master` has legitimately advanced, do not reset it.

Re-scan the current Billing view, `KpiCard` primitive and theme styles before changing code.

Do not push automatically.

---

# BUG

On the Customer Billing page, the three summary items at the top:

- Commercial access
- Current plan
- Open invoices

appear as proper elevated/flex/grid cards in Light theme, but in Dark theme they visually collapse into plain floating text on the page background.

The content is still present, but the card surfaces disappear.

This makes the Billing page inconsistent between themes.

---

# ROOT CAUSE TO VERIFY

Current Billing uses:

```tsx
<section className="kpi-row" aria-label="Billing summary">
  <KpiCard ... />
  <KpiCard ... />
  <KpiCard ... />
</section>
```

The shared `KpiCard` primitive renders:

```tsx
<div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
  ...
</div>
```

The current shared CSS includes behavior equivalent to:

```css
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.kpi {
  background: var(--bg-rock);
  border: none;
  border-radius: var(--r-lg);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
```

Dark theme currently defines:

```css
--bg: #09090b;
--bg-rock: #09090b;
```

Therefore:

```text
KPI surface = same color as page canvas
```

and no visual boundary remains.

Light theme separately adds:

```css
[data-theme="light"] .kpi {
  box-shadow: var(--shadow-md);
}
```

which is why the cards are visible in Light mode.

Re-verify current source before editing.

---

# REQUIRED RESULT

The Billing summary must visually render as three intentional cards in BOTH themes.

Dark theme should look approximately:

```text
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│ COMMERCIAL ACCESS  │  │ CURRENT PLAN       │  │ OPEN INVOICES      │
│                    │  │                    │  │                    │
│ Active             │  │ Scale Team Plan    │  │ 0                  │
│ all services on    │  │ v1 · pro           │  │ awaiting payment   │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

The cards must use the existing Mox dark graphite surface hierarchy.

Do not simply draw a bright border around them.

---

# FIX THE DESIGN-SYSTEM TOKEN, NOT JUST BILLING

This is a shared `KpiCard` primitive.

Fix the semantic card surface correctly so other pages using `KpiCard` also behave consistently.

Do not add a Billing-only hack unless there is a clear reason.

Preferred direction:

```css
.kpi {
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-sm);
}
```

or an equivalent token-based implementation consistent with the current Mox design system.

Dark theme already has an elevated card surface such as:

```text
--surface-card
--bg-card
--bg-card-elevated
```

Use the correct semantic surface.

Do NOT use:

```css
background: #18181b;
```

directly inside the Billing component if a semantic token already represents this.

---

# DARK THEME TARGET

Dark Billing KPI cards should have:

- graphite card surface clearly distinguishable from the page;
- subtle border or shadow;
- same radius as shared Mox cards;
- strong white primary text;
- muted secondary text;
- semantic green/amber/red/accent values;
- no giant glow;
- no excessive elevation.

Conceptually:

```text
Page                #09090b
KPI card            #18181b-ish semantic surface
Elevated/hover      #27272a-ish
Border              subtle rgba white
```

Use current theme tokens rather than hardcoded equivalents where possible.

---

# LIGHT THEME TARGET

Do not regress the current Light theme.

Light KPI cards should remain:

- white;
- elevated above the white/light canvas;
- subtle shadow;
- readable;
- consistent with other Light Mox panels/cards.

Do not accidentally give Light cards dark-theme borders or heavy shadows.

---

# IMPORTANT — CARD LAYOUT

The cards are already rendered inside a responsive CSS grid.

Preserve:

```css
.kpi-row {
  display: grid;
}
```

Do not rewrite this as arbitrary absolute positioning.

At normal desktop widths the Billing summary should remain three columns.

At narrower widths it should wrap responsibly.

---

# TEXT HIERARCHY

Inside each KPI:

## Label
Examples:

```text
COMMERCIAL ACCESS
CURRENT PLAN
OPEN INVOICES
```

Keep compact uppercase metadata styling.

## Value
Examples:

```text
Active
Scale Team Plan
0
```

Remain visually dominant.

## Hint
Examples:

```text
all services on
v1 · pro
awaiting payment
```

Use secondary/muted text, not the same brightness as the primary value.

If current `.kpi-hint` uses full `var(--text)`, consider using the correct secondary token:

```css
color: var(--text-dim);
```

provided this remains accessible in both themes.

---

# SEMANTIC TONES

Preserve existing tone behavior:

```text
Commercial access Active -> green
Denied -> warning/error as currently defined

Current Plan -> appropriate current state tone

Open invoices 0 -> good
Open invoices > 0 -> warn
```

Do not change billing business semantics.

---

# BILLING PANELS

While fixing this page, verify the rest of Billing still has a coherent visual hierarchy:

- Subscription
- Plans
- Invoices

Do NOT redesign these sections.

Only correct obvious theme inconsistency resulting from shared tokens.

---

# THEME PARITY AUDIT

After fixing KPI cards, inspect the same `KpiCard` primitive anywhere else it is used.

Verify that:

```text
Dark
Light
```

both display an actual visual card.

Do not leave other pages with the same invisible-dark-card bug.

---

# UI STUDIO

Update/verify Billing in UI Studio.

Test:

1. Dark theme / populated
2. Light theme / populated
3. Dark theme / empty
4. Light theme / empty
5. Dark theme / gated/error if Billing supports those states

Use the same production Billing components.

Do not build a Studio-only visual fix.

---

# RESPONSIVE QA

Verify Billing at:

```text
1920px
1440px
1280px
1024px
768px
390px
```

Expected:

- wide screen -> 3 summary cards in row;
- narrower layouts -> clean responsive wrapping;
- no text overflow;
- plan names may wrap or truncate intentionally;
- no horizontal page overflow.

---

# ACCESSIBILITY

Ensure:

- card text maintains sufficient contrast;
- semantic color is not the only indicator;
- muted text remains legible;
- no important information disappears on Dark theme;
- screen-reader semantics remain unchanged.

---

# DO NOT TOUCH

Do not change:

- Stripe/payment provider logic;
- checkout;
- cancellation;
- reconciliation;
- invoice authority;
- subscription state;
- commercial access;
- pricing calculations;
- regional pricing;
- API calls;
- entitlements;
- test/demo billing data.

This is presentation-layer repair.

---

# TESTS

Add/update focused tests where appropriate.

Prove:

1. Billing renders 3 KPI components with populated data.
2. `KpiCard` uses a semantic card surface.
3. Dark theme does not resolve KPI background to the same visual canvas treatment by an accidental `--bg-rock` dependency.
4. Light theme remains correct.
5. responsive KPI grid remains.
6. semantic tones remain.
7. billing functionality is untouched.
8. UI Studio uses the production Billing view.

Avoid brittle exact CSS-value snapshots where possible.

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
git diff --check
```

Do not weaken tests.

---

# ACCEPTANCE CRITERIA

The exact Billing summary shown in the reported screenshot must no longer appear as plain text floating on the dark page.

In Dark theme:

```text
Commercial access
Current plan
Open invoices
```

must each have a clearly visible but restrained Mox graphite card surface.

In Light theme:

the existing elevated white-card appearance remains polished.

The solution must be implemented through the shared semantic card/theme system, not a one-off Billing-only hardcoded color fix.
