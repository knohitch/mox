# MOX — PHASE 05
# COMPLETE MODEL CONNECTION PROBES + PRODUCTIZE CLI/RUNTIME ENGINE STATE

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Preserve onboarding, DEV direct access, customer/system credential isolation, model routing abstractions and all security gates. Do not push.

## A. REAL MODEL CONNECTION PROBES

Customer BYOK/model connections already exist, but real connection probing has historically been unavailable. Finish it.

### Credential rules

Customer secret:
- resolve through CustomerCredentialService/customer vault;
- never return plaintext after save;
- never place plaintext in DB/API/logs;
- preserve org/reference AAD binding;
- rotate/delete/audit through canonical authority.

Mox system-provider secret:
- use SystemCredentialService/system store;
- never mix with customer rows;
- Admin only;
- no org ownership on system credential/model tables.

### Provider probe adapter

Do not hardcode provider probing in React.

Use/create provider-adapter capability similar to:

```ts
probeConnection(...) -> {
  status: "connected" | "degraded" | "invalid_credentials" | "unavailable",
  checkedAt,
  latencyMs?,
  reasonCode?,
  safeMessage?
}
```

Normalize/sanitize provider errors. Never echo raw provider payloads containing credentials.

### Dynamic model discovery

When provider supports model listing:
- query available models;
- normalize into Mox model registry;
- capability-validate before activation;
- do not hardcode each future model version;
- preserve task/capability-based routing architecture.

### UI

Customer Models supports connect/test/status/last checked/rotate/disconnect/discovered models. Admin intelligence supports system-provider health without revealing credentials.

## B. CLI/RUNTIME ENGINE STATE

Re-scan current CLI architecture. `/api/cli-engines` has historically returned 501 because old CLI engine state was not tracked, while current CLI increasingly uses canonical model/runtime state.

Productize the concept truthfully.

Preferred:
- derive CLI/runtime availability from real configured runtime/model/connector authority;
- avoid a second display-only database;
- if `cli-engines` is obsolete, update callers to canonical `/api/models`/runtime state, keep a safe backwards-compatible projection/deprecation path, and document it;
- never preserve a fake permanent feature just because an old API method exists.

## TESTS

Cover valid key, invalid key, timeout, redaction, org isolation, customer/system vault separation, dynamic discovery normalization, new-model validation, health persistence if used, CLI state truthfulness, browser bundle secret absence, and updated DEV Models fixtures.

Run credential/model/control-plane/web/CLI suites and full gates. Run PostgreSQL if persistence changes.

Report:
`docs/verification/PRODUCT_COMPLETION_05_MODEL_PROBES_CLI_STATE.md`

Local commit:
`feat(models): add vault-backed connection probes and runtime state`

Do not push.
