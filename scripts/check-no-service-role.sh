#!/usr/bin/env bash
# Browser-bundle / tracked-files guard against accidental service-role
# leakage. Supabase's `service_role` key bypasses RLS — if it lands in a
# tracked file or browser-bundled source, anyone visiting the site can
# read/write any row in any workspace. Catastrophic.
#
# This script greps over tracked files (so gitignored .env.local is not
# read or printed) for any common spelling. The data-layer-redesign §13.1
# acceptance requires this check to pass.
#
# Local-only `.env` validation is a SEPARATE manual check developers run
# on their own checkout — `git grep` cannot see gitignored files and must
# not be claimed to. The PR description includes a one-liner reminder.
set -euo pipefail

PATTERN='service[_-]?role|SUPABASE_SERVICE_ROLE_KEY'
PATHS=('.env*' 'src/' 'public/' 'index.html')

# Use filename-only output so a mistakenly committed key is not echoed into
# local terminals or CI logs.
HITS=$(git grep -lIE "$PATTERN" -- "${PATHS[@]}" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "service-role reference found in tracked files (would ship in browser bundle):" >&2
  echo "$HITS" >&2
  echo >&2
  echo "Remove it. The service-role key must never reach the browser; only" >&2
  echo "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are safe to bundle." >&2
  exit 1
fi

echo "no service-role references in tracked browser-bundled paths"
