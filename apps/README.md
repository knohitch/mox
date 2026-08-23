# apps/

Mox-owned user-facing applications. The web app is primary (Architecture
Rule 6); desktop/mobile shells come later. Product surfaces must expose Mox
identity only. Do not import from vendored reference snapshots; depend on
`@mox/*` packages only.
