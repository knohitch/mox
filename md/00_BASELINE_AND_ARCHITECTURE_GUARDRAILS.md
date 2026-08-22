# Prompt 00 — Baseline, provenance and architecture guardrails

**Recommended Codex reasoning: Ultra**

You are working in the `knohitch/mox` repository. This is the first implementation step of the full Mox platform. Do not build an MVP and do not begin feature rewrites yet.

## Goal

Create a trustworthy baseline around the three imported upstream projects so later consolidation can proceed without losing working behavior, licenses, test coverage or provenance.

## Source trees

- `OpenBot-main/`
- `OpenMausBot-main/`
- `deepseek-harness-master/`

## Required work

1. Inspect the root repository and all three projects:
   - package managers and runtime requirements;
   - build commands;
   - test commands;
   - lint/typecheck commands;
   - Docker/deployment files;
   - licenses and notices;
   - major runtime entry points.

2. Create `docs/consolidation/BASELINE.md` containing:
   - current root HEAD SHA;
   - upstream directory names;
   - each source project's license;
   - each source project's runtime/package manager;
   - each source project's known build/test commands;
   - major subsystem inventory;
   - known external dependencies;
   - baseline failures that already exist before Mox changes.

3. Create `docs/consolidation/PROVENANCE.md`:
   - map each imported project to its upstream license/notice;
   - define how copied/adapted files will be attributed;
   - explicitly preserve OpenMaus Apache-2.0 NOTICE requirements;
   - preserve MIT license text for MIT-sourced code;
   - do not invent upstream URLs if not discoverable from repository metadata.

4. Create `docs/architecture/ARCHITECTURE.md` with these hard rules:
   - one authority per concern;
   - provider-specific code behind interfaces;
   - customer VPS is untrusted;
   - external side effects are idempotent/audited;
   - Simple and Developer modes compile to one `AgentDefinition`;
   - web app is primary;
   - imported source trees are not deleted until final retirement prompt.

5. Create `docs/architecture/AUTHORITY_MATRIX.md`.
   Define exactly one final authority for:
   - identity;
   - organizations;
   - billing;
   - pricing;
   - entitlements;
   - compute ownership;
   - server desired state;
   - agent definitions;
   - agent execution;
   - model routing;
   - credentials;
   - tool policy;
   - computer/browser actions;
   - sessions/events;
   - channels;
   - notifications;
   - usage;
   - costs;
   - audit.

6. Create `docs/consolidation/SOURCE_CLASSIFICATION.md`.
   Classify major directories/modules from all three sources using:
   - KEEP;
   - PORT;
   - ADAPT;
   - REPLACE;
   - RETIRE.
   The classification must be consistent with:
   - OpenBot = control plane/computer/security donor;
   - DeepSeek Harness = runtime kernel donor;
   - OpenMausBot = GrokBot UX/provider/voice/device donor.

7. Run each source project's practical baseline tests/typecheck/build commands without trying to repair unrelated historical failures.
   Record exact results.

8. Add root-level helper scripts only if necessary to make baseline checks repeatable. Do not restructure packages yet.

## Explicitly forbidden

- Do not delete, rename or move the three upstream trees.
- Do not merge package managers yet.
- Do not replace CopilotKit yet.
- Do not port UI yet.
- Do not create billing/compute implementation yet.
- Do not change runtime behavior merely to make tests green.
- Do not push or deploy.

## Acceptance criteria

- Baseline state is reproducible.
- Licenses/provenance are documented.
- Final authority matrix exists.
- Source classification exists.
- Architecture rules are written into the repository.
- Existing failures are distinguished from new failures.
- `git diff` contains documentation/helpers only, except truly necessary test harness fixes that are clearly justified.
