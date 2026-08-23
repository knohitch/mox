# Mox Production Repair Pack

Repository: `knohitch/mox`
Audited baseline: `6f88c388138f2b81edd6372d85d734fc6b58e278`

This is a repair sequence for the **full Mox system**, not an MVP.

## Confirmed defects this pack targets
- `apps/web` still uses `DemoMoxApi` / demo-local state.
- Billing, compute orchestration and notifications still have in-memory production-default risks.
- Billing schema/service mismatches: subscription-history uniqueness, checkout provider refs, FX/base pricing fields, and in-memory plan entitlement values.
- First-time Mox Node enrollment does not validate against a previously persisted expected one-time token.
- Mox Node cloud-init has a hard-coded control-plane URL.
- Paystack, Flutterwave, Stripe and PayPal are not implemented as real billing providers.
- Admin cannot create/broadcast notifications end-to-end; users lack a proper inbox/bell/read flow; notification ownership checks need hardening.
- No complete visual Mox admin app is wired over authoritative services.
- Production Mox Runtime still relies on a reference-engine path and does not yet prove the complete intended runtime capability set.
- Public/customer branding must be Mox only.
- Generic UI must not use “GPT” as a synonym for AI.
- The audited commit reports no GitHub commit-status checks.

## Branding rules
Public/customer-facing product/runtime/browser/agent wording must be **Mox**.

Do not expose donor/runtime identities such as OpenBot, OpenMausBot, DeepSeek Harness, or DSH when it means the donor harness.

Actual provider/model names are allowed only where technically appropriate: Models, API Connections, provider setup, actual model selection, or provider-specific diagnostics. “DeepSeek” is allowed when it means the actual model/API provider. “GPT” is allowed only when identifying an actual OpenAI GPT model/provider, not as generic AI wording.

Keep legally required third-party license/NOTICE/provenance information under `third_party/` and internal legal/provenance docs.

## Mandatory discipline for every repair prompt
Before editing:
1. `git status`
2. record branch + HEAD
3. if HEAD differs from the audited SHA, inspect newer changes and adapt; never overwrite newer work blindly
4. inspect the named code and tests
5. run relevant baseline tests

During work:
- no fake provider success
- no new in-memory production authority
- no production demo fallback
- no hard-coded secrets
- no silent catch-and-success
- preserve tenant isolation and idempotency
- add real migrations for schema changes
- fail honestly with `UNAVAILABLE`/`NOT_CONFIGURED` where third-party setup is absent

After work:
- targeted tests
- typecheck
- lint
- relevant builds
- clean/upgrade migration tests where applicable
- stop; do not automatically start the next repair
- do not push unless explicitly asked

Final report:
- old SHA
- new SHA
- branch
- files changed
- migrations
- tests/results
- remaining blockers
- next repair prompt number

## Order
00. Critical foundation / production wiring
01. Paystack + Flutterwave + Stripe + PayPal
02. Admin-to-user notifications
03. Full admin app / provider configuration
04. Mox Runtime completeness / model surfaces
05. Mox-only public branding / CI guard
06. Full production verification / release gate
