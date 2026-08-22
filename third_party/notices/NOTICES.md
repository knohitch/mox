# Mox Upstream Notices

This directory preserves the license and notice obligations of the projects
Mox was consolidated from. The vendored reference trees live outside version
control (see `.gitignore`) at the repository root; their licenses are
preserved here so attribution survives their eventual removal.

## OpenBot

- License: MIT, Copyright (c) 2026 CopilotKit
- Full text: `licenses/openbot-LICENSE-MIT.txt`
- Mox usage: concepts and patterns adapted into the control plane, computer
  gateway, credentials model and admin surfaces. Adapted files carry
  provenance headers; no code imports from the vendored tree.

## OpenMausBot

- License: Apache-2.0 (author metadata: Milind Soni)
- Full text: `licenses/openmausbot-LICENSE.txt`
- NOTICE obligations: Apache-2.0 §4(d) requires preserving NOTICE contents.
  The vendored tree ships no separate `NOTICE` file; this document serves as
  the attribution record for any adapted fragments (voice provider concepts,
  provider-driver metadata mirrors, device/CUA capability modeling).
- Mox usage: structural mirrors only (`packages/adapters/src/openmaus-providers.ts`
  documents "no import from OpenMausBot-main").

## DeepSeek Harness

- License: MIT, Copyright (c) 2026 DeepSeek
- Full text: `licenses/deepseek-harness-LICENSE-MIT.txt`
- Mox usage: runtime kernel concepts consolidated into
  `runtime/agent-runtime` (DSH model seam). Structural mirrors only;
  no import from the vendored tree.
