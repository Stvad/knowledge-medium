#!/usr/bin/env bash
# Browser-bundle / tracked-files guard against accidental PRIVILEGED-KEY
# leakage. The privileged Supabase key bypasses RLS — if it lands in a
# tracked file or browser-bundled source, anyone visiting the site can
# read/write any row in any workspace. Catastrophic.
#
# Covers BOTH forms: the legacy `service_role` JWT (still valid, so still
# guarded) AND the modern `sb_secret_…` secret key / SUPABASE_SECRET_KEY env
# var that replaces it. Only the publishable/anon key is safe to bundle.
#
# This script greps over tracked files (so gitignored .env.local is not
# read or printed) for any common spelling. The data-layer-redesign §13.1
# acceptance requires this check to pass.
#
# Local-only `.env` validation is a SEPARATE manual check developers run
# on their own checkout — `git grep` cannot see gitignored files and must
# not be claimed to. The PR description includes a one-liner reminder.
set -euo pipefail

PATTERN='service[_-]?role|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|sb_secret_'
PATHS=('.env*' 'src/' 'public/' 'index.html')

# Use filename-only output so a mistakenly committed key is not echoed into
# local terminals or CI logs.
HITS=$(git grep -lIE "$PATTERN" -- "${PATHS[@]}" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "privileged-key reference found in tracked files (would ship in browser bundle):" >&2
  echo "$HITS" >&2
  echo >&2
  echo "Remove it. The secret/service-role key must never reach the browser;" >&2
  echo "only VITE_SUPABASE_URL and the publishable/anon key are safe to bundle." >&2
  exit 1
fi

echo "no privileged-key references in tracked browser-bundled paths"
