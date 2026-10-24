#!/usr/bin/env bash
# Release a version: bump it, check it, push it, wait for CI, then tag it and
# publish the GitHub release with its CHANGELOG section as the notes.
#
#   scripts/release.sh 1.2.0            # release
#   scripts/release.sh 1.2.0 --dry-run  # every check, nothing changed
#
# Before running: the code and a "## 1.2.0" CHANGELOG section are written, and
# everything else is committed. Each step stops the release when it fails, so a
# version is only tagged once its own commit has passed CI.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }

v=${1:-}
dry=${2:-}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh <major.minor.patch> [--dry-run]"
[ -z "$dry" ] || [ "$dry" = --dry-run ] || die "unknown option $dry"

current=$(python3 -c 'import json; print(json.load(open(".claude-plugin/plugin.json"))["version"])')
python3 - "$v" "$current" <<'PY' || die "$v isn't newer than the current $current"
import sys
new, cur = (tuple(map(int, x.split("."))) for x in sys.argv[1:3])
sys.exit(0 if new > cur else 1)
PY

[ "$(git branch --show-current)" = main ] || die "not on main"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main isn't level with origin/main; pull or push first"
git rev-parse -q --verify "refs/tags/v$v" > /dev/null && die "tag v$v exists already"
grep -q "^## $v\$" CHANGELOG.md || die "CHANGELOG.md has no \"## $v\" section"
# Only the CHANGELOG may be uncommitted; the bump below is the release commit
others=$(git status --porcelain | grep -v ' CHANGELOG.md$' || true)
[ -z "$others" ] || die "uncommitted changes besides CHANGELOG.md:
$others"

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
awk -v h="## $v" '$0 == h {f=1; next} /^## /{f=0} f' CHANGELOG.md > "$notes"
[ -s "$notes" ] || die "the \"## $v\" section is empty"

if [ "$dry" = --dry-run ]; then
  echo "== checks at $current (dry run: nothing is bumped, committed or pushed)"
  scripts/check.sh
  echo
  echo "Would bump $current -> $v, commit, push, wait for CI, tag v$v and publish with these notes:"
  cat "$notes"
  exit 0
fi

echo "== bump $current -> $v"
python3 - "$v" <<'PY'
import json, pathlib, re, sys
v = sys.argv[1]
p = pathlib.Path(".claude-plugin/plugin.json")
d = json.loads(p.read_text())
d["version"] = v
p.write_text(json.dumps(d, indent=2) + "\n")
r = pathlib.Path("README.md")
s, n = re.subn(r"badge/release-v[0-9.]+-([0-9a-f]+)\" alt=\"release v[0-9.]+\"", f'badge/release-v{v}-\\1" alt="release v{v}"', r.read_text())
if n != 1:
    sys.exit("README release badge not found")
r.write_text(s)
PY

echo "== checks"
scripts/check.sh || die "checks failed; the bump is left uncommitted for you to fix or revert"

echo "== commit and push"
git add .claude-plugin/plugin.json README.md CHANGELOG.md
git commit -q -m "$v"
git push -q origin main
sha=$(git rev-parse HEAD)

echo "== waiting for CI on ${sha:0:7}"
run=''
for _ in $(seq 1 30); do
  run=$(gh run list --commit "$sha" --workflow check.yml --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [ -n "$run" ] && break
  sleep 4
done
[ -n "$run" ] || die "no CI run appeared for ${sha:0:7}; tag it by hand once CI passes"
gh run watch "$run" --exit-status > /dev/null || die "CI failed on ${sha:0:7} (gh run view $run); not tagged"

echo "== tag and publish v$v"
git tag "v$v"
git push -q origin "v$v"
gh release create "v$v" --title "Locum $v" --notes-file "$notes"
