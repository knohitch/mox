#!/bin/sh
set -eu

if [ "${MOX_SKIP_MIGRATIONS:-0}" != "1" ]; then
  node packages/database/scripts/migrate.mjs
fi

exec node services/control-plane/dist/main.js
