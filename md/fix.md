# MOX DASHBOARD — FIX WORKSPACE SETUP CARD LIFECYCLE

Work directly in:

`E:\MyCodes\Mox`

Use the latest clean `master`.

## OBJECTIVE

Fix the Customer Dashboard `WorkspaceSetupCard`.

The current dashboard incorrectly continues rendering a large "Workspace setup" panel after all meaningful workspace setup has been completed.

Current example:

- First agent — Done
- Model provider — Done
- Server — Done
- Apps & channels — Done
- API token — Optional

Yet the entire setup card remains visible and says:

`One last thing to configure — optional, at your own pace.`

This is incorrect UX.

---

# ROOT CAUSE TO VERIFY

Inspect:

`apps/web/src/views/WorkspaceSetupCard.tsx`

The component currently uses logic equivalent to:

```ts
const remaining = items.filter((item) => item.status !== "done").length;

if (remaining === 0) return null;