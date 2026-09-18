#!/bin/sh
set -eu

process_type="${MOX_PROCESS_TYPE:-combined}"

case "$process_type" in
  web)
    exec node scripts/serve-web.mjs
    ;;
  api|combined)
    if [ "${MOX_SKIP_MIGRATIONS:-0}" != "1" ]; then
      node packages/database/scripts/migrate.mjs
    fi
    exec node services/control-plane/dist/main.js
    ;;
  *)
    echo "invalid MOX_PROCESS_TYPE: $process_type (expected web, api, or combined)" >&2
    exit 78
    ;;
esac
