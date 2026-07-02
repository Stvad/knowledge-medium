#!/usr/bin/env bash
# Ensure the gh-pages branch actually gets *published* by GitHub Pages, retrying
# the flaky publisher on transient failures.
#
# Why this exists: production and PR previews are served from the gh-pages branch
# ("Deploy from a branch"). Each push to gh-pages auto-triggers GitHub's own
# "pages build and deployment" run, which we do NOT author and cannot configure.
# That publisher is intermittently flaky: its deploy step returns
#   "Deployment failed, try again later."
# or stalls in deployment_queued. When a push's publish fails, that push's
# content stays 404 until the *next* successful publish sweeps it in — so a
# preview (or a master deploy) can silently fail to go live. GitHub's own remedy
# for the error is, literally, to try again. This script does that automatically:
# it watches the latest Pages build and, on error/stall, requests a rebuild
# (POST /pages/builds) — the same manual re-run we used to do by hand.
#
# Requires: a GITHUB_TOKEN with `pages: write` in $GH_TOKEN, and $GITHUB_REPOSITORY.
# Run this AFTER the step that pushes to gh-pages.
set -euo pipefail

: "${GH_TOKEN:?set GH_TOKEN to a token with pages:write}"
: "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY (owner/repo)}"

api="https://api.github.com/repos/${GITHUB_REPOSITORY}/pages"
auth=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

ROUNDS="${PAGES_PUBLISH_ROUNDS:-4}"      # rebuild requests before giving up
POLLS="${PAGES_PUBLISH_POLLS:-40}"       # status polls per round (~10s each)

# Prints "<id> <status>" for the latest build; status is one of
# queued|building|built|errored|none (null -> none).
latest() {
  curl -fsS "${auth[@]}" "$api/builds/latest" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or 0, d.get("status") or "none")'
}

# Baseline: the newest build that already exists before we start waiting. We only
# accept a "built" whose id is GREATER than this, so a build that ran *before*
# our push landed can never be mistaken for our publish. (Any newer built — even
# one triggered by another PR's push — is fine: it rebuilds the whole branch
# HEAD, which already includes our push.)
base="$(latest | awk '{print $1}')"
echo "baseline Pages build id: $base"

for round in $(seq 1 "$ROUNDS"); do
  # Round 1 relies on the auto-build our gh-pages push already triggered. Later
  # rounds explicitly request a fresh build (the "try again later" retry).
  if [ "$round" -gt 1 ]; then
    echo "== requesting a Pages rebuild (round $round/$ROUNDS) =="
    curl -fsS -X POST "${auth[@]}" "$api/builds" >/dev/null || true
    sleep 10
  fi
  for _ in $(seq 1 "$POLLS"); do
    read -r id st < <(latest || echo "0 none")
    echo "  latest build id=$id status=$st (baseline $base)"
    if [ "$id" -gt "$base" ]; then
      case "$st" in
        built)   echo "Pages published (build $id)."; exit 0 ;;
        errored) echo "  build errored — will retry"; base="$id"; break ;;
      esac
    fi
    sleep 10
  done
done

echo "::error::gh-pages did not publish after ${ROUNDS} rebuild attempts"
exit 1
