# Mox Provenance & License Attribution

Status: **Baseline (Step 1 of consolidation).** This document maps each
imported project to its upstream license and notice obligations, and defines
how every file Mox copies or adapts from those trees will be attributed.

Principle: **we attribute only what the repository metadata actually shows.**
Where an upstream URL is not discoverable from the imported files (manifests,
READMEs, badges, NOTICE files), we record "upstream URL not recorded in
imported metadata" rather than inventing one.

---

## 1. Imported projects and their licenses

### `OpenBot-main/`

| Field | Value |
|---|---|
| License | **MIT** (`OpenBot-main/LICENSE`, "Copyright (c) 2026 CopilotKit") |
| Declared in | root + workspace `package.json` files (`"license": "MIT"`) |
| Upstream URL | `https://github.com/CopilotKit/openbot` (from CI badge in `README.md`) |
| NOTICE file | None shipped |
| Third-party notices | None shipped at tree root (dependency licenses live in each package's own metadata) |

MIT obligations when copying: retain the copyright + permission notice in all
copies or substantial portions. Mox satisfies this via the per-file header
(§2) and the preserved license texts in `docs/consolidation/licenses/`.

### `OpenMausBot-main/`

| Field | Value |
|---|---|
| License | **Apache-2.0** (`OpenMausBot-main/LICENSE`) |
| Declared in | `package.json` (`"license": "Apache-2.0"`) |
| Upstream URL | `https://github.com/milind-soni/OpenMausBot` (from `package.json` `repository`) |
| NOTICE file | **Yes — `OpenMausBot-main/NOTICE`** (see §3; preservation is mandatory) |
| Embedded third-party code | `third_party/cua-driver/` — MIT ("Copyright (c) 2025 Cua AI, Inc."), shipped with its own `LICENSE.md`, `THIRD_PARTY_NOTICES.md`, `SBOM.cdx.json`, `about.toml`, and `Inter-OFL-1.1.txt` (Inter font, SIL Open Font License 1.1) |

Apache-2.0 obligations when copying (see §2/§3): include the license,
carry prominent modified-file notices, retain copyright/patent/trademark
attribution notices, and propagate the NOTICE file contents.

### `deepseek-harness-master/`

| Field | Value |
|---|---|
| License | **MIT** (`deepseek-harness-master/LICENSE`, "Copyright (c) 2026 DeepSeek") |
| Declared in | root `package.json` (`"license": "MIT"`) |
| Upstream URL | `https://github.com/deepseek-ai/deepseek-harness` (from `README.md` clone instructions) |
| NOTICE file | No Apache-style NOTICE; ships generated **`THIRD_PARTY_NOTICES.md`** (do not hand-edit; regenerate via `pnpm run gen-third-party-notices`) |
| Vendored source | `vendor/` (cordis, cosmokit, schemastery, cordis plugins) — all MIT, each directory preserves its upstream `LICENSE`; upstream commits recorded in `vendor/README.md` |
| First-party native | `native/landlock-run` — BSD 3-Clause (first-party to the harness project) |
| Patched dependency | `patches/node-pty@1.2.0-beta.15.patch` (pnpm patch; the patch file is the record of the modification) |
| Special payloads | `@anthropic-ai/claude-agent-sdk` platform payloads — declared license "SEE LICENSE IN README.md"; distribution is governed by the authorization statement in `THIRD_PARTY_NOTICES.md`. Do not redistribute these payloads outside the terms recorded there. |
| Python SDK | `python/` — MIT project code; runtime deps pydantic (MIT), hatchling (MIT); tooling uv (MIT/Apache-2.0), pytest (MIT) |

MIT obligations when copying: same as OpenBot (retain copyright + permission
notice). If Mox copies the generated `THIRD_PARTY_NOTICES.md` content or the
vendored `vendor/` directories, copy the files as-is including their embedded
upstream `LICENSE` files.

---

## 2. How copied/adapted files are attributed

Every file whose content originates (wholly or substantially) in one of the
imported trees carries a provenance header immediately after the license
identifier, before any other comment or code:

```
// Ported from: OpenBot-main/server/src/credentials.ts
// Upstream license: MIT (c) 2026 CopilotKit — see docs/consolidation/licenses/OpenBot-LICENSE
// Imported at: <root HEAD SHA of the import commit>
// Adapted: <one line describing the adaptation, or "verbatim copy">
```

Rules:

1. **Verbatim copies** keep the header with `Adapted: verbatim copy` and must
   not otherwise be edited. If a verbatim copy later needs changes, it is
   reclassified as adapted and the header updated.
2. **Adapted files** must state what changed in the `Adapted:` line. For
   files under Apache-2.0 (OpenMausBot), this header **is** the "prominent
   notice stating that you changed the files" required by Apache-2.0 §4(b) —
   it must not be removed.
3. **Substantial fragments** (a function, class, or algorithm lifted from an
   imported file into a Mox-authored file) get the same header on the
   containing file, naming the source path.
4. **New Mox files** carry no ported-from header. Mox's own license applies.
5. The import commit SHA recorded is the Mox root HEAD at the time the file
   was copied, so the exact source state is recoverable from git history.
6. License texts are preserved verbatim in `docs/consolidation/licenses/`:
   - `OpenBot-LICENSE` (MIT — CopilotKit)
   - `OpenMausBot-LICENSE` (Apache-2.0)
   - `OpenMausBot-NOTICE` (see §3)
   - `deepseek-harness-LICENSE` (MIT — DeepSeek)
   - `cua-driver-LICENSE` (MIT — Cua AI, Inc.)
   - `Inter-OFL-1.1` (SIL Open Font License 1.1, for the Inter font bundled
     in `OpenMausBot-main/third_party/cua-driver/`)
   Any distribution of Mox that includes ported code must include the
   corresponding texts.

## 3. OpenMausBot Apache-2.0 NOTICE — explicit preservation

`OpenMausBot-main/NOTICE` reads:

> OpenMausBot
> Copyright 2026 Milind Soni and OpenMausBot contributors
>
> OpenMausBot was relicensed from the MIT License to the Apache License,
> Version 2.0, with the consent of all contributors whose copyright was
> incorporated before the transition.

Because the Work includes a NOTICE file, Apache-2.0 §4(d) requires that any
Derivative Work Mox distributes include a readable copy of these attribution
notices. Therefore:

1. The NOTICE contents are preserved verbatim at
   `docs/consolidation/licenses/OpenMausBot-NOTICE` and must be carried into
   any distributed artifact that contains ported OpenMausBot code (as a
   `NOTICE` file, in the source distribution, or in the third-party notices
   display — per §4(d) any one of the allowed locations).
2. Mox may append its own attribution notices alongside, but must not modify
   or remove the OpenMausBot notice text.
3. The relicensing history (MIT → Apache-2.0 with contributor consent) means
   **older MIT-licensed copies of OpenMausBot code may exist elsewhere**; the
   imported tree is Apache-2.0 and that is the license that governs what we
   copied. Do not relabel ported OpenMausBot code as MIT.
4. Apache-2.0 §6 (trademarks): the names "OpenMausBot", "Maus", and
   "SupaMaus" are not Mox trademarks and are used only as required for
   attribution.

## 4. What we do not do

- We do not invent upstream URLs, versions, or commit SHAs that are not
  discoverable from the imported repository metadata.
- We do not strip, rewrite, or "clean up" upstream license headers, NOTICE
  files, SBOMs, or generated third-party notices.
- We do not relicense ported code. Ported code keeps its upstream license;
  Mox's own license applies only to Mox-authored code.
- We do not copy the `@anthropic-ai/claude-agent-sdk` platform payloads or
  other specially-licensed payloads beyond the terms already recorded in
  `deepseek-harness-master/THIRD_PARTY_NOTICES.md` without a fresh review.