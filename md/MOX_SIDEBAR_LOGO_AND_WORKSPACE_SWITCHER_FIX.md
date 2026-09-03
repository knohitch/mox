# MOX — SIDEBAR BRANDING + WORKSPACE SWITCHER CLEANUP
# REPLACE WORKSPACE NAME WITH MOX LOGO, MOVE WORKSPACE SWITCHING OUT OF SIDEBAR

## MODEL

Use **Gemini 3.1 Pro High**.

This is a focused Customer-shell UI/UX repair.

Do not redesign the whole application.

Do not change authentication, onboarding, authorization, tenant isolation, workspace membership, routing, or business logic.

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

Rules:

- work on the current clean `master`;
- if `master` legitimately advanced, do not reset;
- re-scan the current Customer shell and styles before changing code;
- preserve all existing functionality;
- do not push automatically.

---

# PRIMARY OBJECTIVE

The top of the Customer sidebar currently displays the active workspace/organization name, for example:

`Acme Autonomous Corp`

This is unnecessary in that location because:

- the dashboard already identifies the signed-in user;
- the dashboard already shows the current workspace/organization context;
- the top-right profile area already represents the signed-in user;
- the workspace name in the sidebar consumes space and crowds the collapse control;
- when only one workspace exists, there is nothing useful to switch.

Replace the workspace selector at the top of the sidebar with the **Mox logo**.

The sidebar header should become primarily a Mox brand anchor plus a distinct collapse/expand control.

---

# TARGET SIDEBAR HEADER

Expanded:

```text
┌────────────────────────────────────┐
│ MOX LOGO                 [collapse]│
└────────────────────────────────────┘
```

or an equivalent polished layout where:

- Mox logo is on the left;
- collapse control is on the right;
- both have independent space;
- neither can overlap;
- the logo scales cleanly;
- the collapse button remains permanently visible and clickable.

Collapsed:

```text
┌────────┐
│ Symbol │
│  [>]   │
└────────┘
```

or another intentional compact treatment.

Do not show `Acme Autonomous Corp` permanently in the sidebar header.

---

# OFFICIAL MOX LOGO

Use this exact logo geometry.

Do not redraw, simplify, reinterpret, or replace it.

```svg
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 760 220"
  fill="none"
  role="img"
  aria-label="Mox"
>
  <g fill="currentColor">
    <!-- MOX SYMBOL -->
    <path d="M30 28C30 22 37 19 42 23L112 75V132L30 72V28Z"/>
    <path d="M196 28C196 22 189 19 184 23L114 75V132L196 72V28Z"/>

    <path d="M30 190C30 196 37 199 42 195L112 143L72 114L30 145V190Z"/>
    <path d="M196 190C196 196 189 199 184 195L114 143L154 114L196 145V190Z"/>

    <!-- M -->
    <path d="
      M265 52
      H292
      L344 111
      L396 52
      H423
      V178
      H397
      V91
      L344 150
      L291 91
      V178
      H265
      Z
    "/>

    <!-- O -->
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="
        M500 49
        C458 49 429 77 429 115
        C429 153 458 181 500 181
        C542 181 571 153 571 115
        C571 77 542 49 500 49
        Z

        M500 76
        C526 76 544 92 544 115
        C544 138 526 154 500 154
        C474 154 456 138 456 115
        C456 92 474 76 500 76
        Z
      "
    />

    <!-- X -->
    <path d="
      M585 54
      H618
      L653 96
      L688 54
      H721
      L670 115
      L724 178
      H691
      L653 133
      L615 178
      H582
      L636 115
      Z
    "/>
  </g>
</svg>
```

---

# IMPORTANT JSX NOTE

When embedding this SVG in React/TSX, convert SVG attribute names correctly:

```tsx
fillRule="evenodd"
clipRule="evenodd"
```

Do not leave raw HTML-style:

```text
fill-rule
clip-rule
```

inside JSX.

---

# THEME BEHAVIOR

The logo uses:

```svg
fill="currentColor"
```

Keep that.

Theme behavior must be:

```text
Dark theme  → white logo
Light theme → black / near-black logo
```

Do not maintain two different SVG files if `currentColor` can solve this.

Preferred semantic styling:

```css
.mox-sidebar-logo {
  color: var(--text);
}
```

If current light-theme `--text` is slightly charcoal rather than pure black, that is acceptable if visually strong.

If necessary, define a dedicated semantic variable:

```css
--brand-logo-color
```

with:

```text
dark  = #FFFFFF
light = #111111 or #000000
```

Do not hardcode theme checks inside the component when CSS tokens can handle it cleanly.

---

# LOGO SIZING

The full horizontal Mox logo should fit comfortably inside the expanded sidebar.

Target approximate rendered width:

```text
90–120px
```

with proportional height.

Do not stretch the SVG.

Use:

```css
width: auto;
height: ...
```

or equivalent aspect-ratio-safe styling.

The logo must remain crisp at all resolutions.

---

# COLLAPSED SIDEBAR BRAND

When the sidebar is collapsed, the full horizontal wordmark is too wide.

Use only the **Mox symbol portion** in collapsed state.

Do NOT squash the full logo into the narrow sidebar.

Preferred approach:

- extract the symbol paths into a small reusable `MoxMark` React component;
- use the full SVG/wordmark in expanded mode;
- use `MoxMark` in collapsed mode.

The symbol must use the same exact geometry from the first four paths of the supplied SVG.

Do not invent a new icon.

---

# SIDEBAR HEADER LAYOUT

Replace the current organization-switcher header arrangement.

The sidebar header should structurally reserve space for:

```text
brand | collapse control
```

Recommended:

```css
.sidebar-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  align-items: center;
  gap: 8px;
}
```

or an equivalent robust flex layout.

Requirements:

- collapse button never overlaps the logo;
- logo never overlaps the collapse button;
- collapse control never shrinks;
- no absolute-position hacks;
- no z-index workaround;
- no increasing sidebar width just to fit content.

---

# REMOVE PERMANENT WORKSPACE NAME FROM SIDEBAR

Remove the permanent `OrgSwitcher` / organization display from the top of the Customer sidebar.

Do NOT remove workspace switching functionality from Mox.

Move it to a more appropriate location.

---

# WORKSPACE SWITCHING UX

## CASE 1 — USER HAS ONE WORKSPACE

If the user belongs to only one workspace:

- do not show a switcher control;
- simply show the workspace as contextual information where it already naturally appears;
- Dashboard can continue showing:

```text
Good evening, Alex Rivera
Acme Autonomous Corp · Enterprise Tier
```

No duplicate workspace selector is needed.

## CASE 2 — USER HAS MULTIPLE WORKSPACES

If the user belongs to more than one workspace:

Expose workspace switching in the top-right profile/account menu.

Recommended structure:

```text
Alex Rivera
alex@example.com

Workspace
Acme Autonomous Corp ▾

Settings
Theme
Sign out
```

or a compact equivalent.

The workspace selector in the profile menu should:

- list real memberships;
- show current workspace;
- call existing `switchOrg(...)`;
- preserve authorization;
- close after selection;
- refresh workspace-scoped state using existing store behavior.

Do not create a second workspace-switching authority.

---

# FIX MULTI-WORKSPACE DETECTION

Review current logic equivalent to:

```ts
const memberships = me.orgs ?? [];
const multiple = memberships.length > 0;
```

This is semantically wrong if the intention is to detect whether switching is useful.

Use:

```ts
const multiple = memberships.length > 1;
```

or equivalent correct logic.

A single membership is not a switcher scenario.

---

# PROFILE MENU

Preserve current:

- user display name;
- email;
- Settings;
- Theme;
- Sign out.

Add Workspace switching only when:

```text
memberships.length > 1
```

Do not make the profile menu noisy when the user only has one workspace.

---

# DO NOT DUPLICATE IDENTITIES

Clarify the UI hierarchy:

```text
Mox logo
= product identity

Alex Rivera
= signed-in human identity

Acme Autonomous Corp
= current workspace/org identity
```

Do not display all three identities repeatedly in every chrome area.

Target:

Sidebar:
```text
Mox logo
```

Dashboard header:
```text
Alex Rivera
Acme Autonomous Corp · plan
```

Top-right:
```text
Alex Rivera profile
```

Profile menu, only when relevant:
```text
Workspace switcher
```

---

# REMOVE LEGACY SIDEBAR BRAND PLACEHOLDERS

Audit the current Customer shell for older placeholder branding such as:

```text
Mox cloud
mox.studio
orgname.studio
brand-logo-glyph = M
```

If these are still part of the active Customer sidebar branding, replace them with the official supplied Mox SVG.

Do not remove legitimate auth-page logo implementations if they already use the same exact logo correctly.

Prefer creating one reusable canonical Mox logo component so:

- auth;
- sidebar;
- future header surfaces

can share exact geometry.

Do not duplicate the same massive SVG inline in many files if a reusable component is more maintainable.

---

# REUSABLE COMPONENT

Prefer creating something like:

```text
apps/web/src/ui/MoxLogo.tsx
```

with:

```tsx
<MoxLogo variant="full" />
<MoxLogo variant="mark" />
```

or equivalent.

Requirements:

- exact supplied geometry;
- `currentColor`;
- accessible full logo;
- decorative mark can use `aria-hidden`;
- no external image fetch;
- no raster PNG dependency.

---

# LIGHT THEME

Verify:

```text
white/light sidebar
→ black/near-black Mox logo
```

It must have strong contrast.

Do not accidentally inherit blue accent color.

---

# DARK THEME

Verify:

```text
black/charcoal sidebar
→ white Mox logo
```

No gray washed-out logo.

---

# SIDEBAR COLLAPSE

Expanded:

- full wordmark visible;
- collapse button visible.

Collapsed:

- Mox symbol visible;
- expand button visible;
- nav icons centered;
- no workspace name.

Do not regress the Agents focus layout that defaults the global sidebar to compact on desktop.

---

# MOBILE

For mobile drawer:

- show full Mox logo if width allows;
- keep mobile drawer close/navigation controls separate;
- do not reintroduce workspace-name crowding;
- multi-workspace switching remains in profile/account area.

---

# UI STUDIO

Update Customer UI Studio fixtures to verify:

1. single workspace;
2. multiple workspaces;
3. long workspace name;
4. expanded sidebar;
5. collapsed sidebar;
6. dark theme;
7. light theme;
8. profile menu workspace switcher.

The single-workspace fixture should show no switcher.

The multiple-workspace fixture should expose switching through the profile menu.

---

# TESTS

Add/update tests proving:

1. expanded Customer sidebar renders official full Mox logo;
2. collapsed Customer sidebar renders official Mox mark;
3. dark theme logo is white/currentColor;
4. light theme logo is black/near-black/currentColor;
5. workspace name no longer renders in sidebar header;
6. collapse button remains independently accessible;
7. one workspace -> no workspace switcher;
8. multiple workspaces -> switcher appears in profile menu;
9. selecting another workspace calls existing `switchOrg`;
10. user identity still appears in profile area;
11. Dashboard can still display current workspace context;
12. Agents focus-layout collapse behavior still works;
13. Customer DEV fixture uses same production shell;
14. production auth/security is unchanged.

Do not make tests depend on exact pixel screenshots only.

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

The expanded sidebar should visually read as:

```text
MOX LOGO                         [collapse]
```

NOT:

```text
[collapse] [A Acme Autonomous Corp ▾]
```

Dark theme:

```text
white Mox logo
```

Light theme:

```text
black/near-black Mox logo
```

When there is only one workspace:

- there is no workspace-switcher control.

When there are multiple workspaces:

- switching is available from the profile/account menu.

The Dashboard may continue displaying:

```text
Good evening, Alex Rivera
Acme Autonomous Corp · Enterprise Tier
```

because that is useful page context.

Do not change Customer authorization, workspace membership, onboarding, or routing.

This task is complete only when the sidebar clearly represents **Mox the product**, while workspace identity is handled contextually rather than permanently occupying the brand area.
