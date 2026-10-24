#!/usr/bin/env bash
# Validate, type-check and test the plugin.
#
#   scripts/check.sh [path/to/claude-code.d.ts]
#
# The type file is Claude Code's plugin API for the installed build. It's written
# when the plugin-authoring skill loads; without a path, the newest one on disk is
# used, and type-checking is skipped if there is none. Needs npx for TypeScript.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

types=${1:-$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)}

echo "== release badge"
# The README's release badge is static (a private repo's releases aren't visible
# to shields.io), so it must name the manifest's version
version=$(python3 -c 'import json; print(json.load(open(".claude-plugin/plugin.json"))["version"])')
grep -q "badge/release-v$version-" README.md || { echo "README release badge doesn't say v$version"; exit 1; }
echo "v$version"

echo "== validate"
claude plugin validate . 2>&1 | grep -E '✔|✘|❯ .*(error|refus)' || true
claude plugin validate . > /dev/null 2>&1 || { echo "validation failed"; exit 1; }

if [ -n "$types" ] && [ -f "$types" ]; then
  echo "== type-check against $types"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$types", "$root/hooks", "$root/types", "$root/tests"]
}
EOF
  npx -y -p typescript@5.6.3 tsc -p "$tmp/tsconfig.json"
  echo "types ok"
else
  echo "== type-check skipped: no claude-code.d.ts found (load the plugin-authoring skill once, or pass its path)"
fi

echo "== tests"
out=$(claude plugin test . 2>&1)
echo "$out" | grep -E '^\(fail\)| pass$| fail$'
echo "$out" | grep -qE '^ 0 fail$' || { echo "$out" | sed -n '/(fail)/,/^(pass/p' | head -40; exit 1; }
echo "all checks passed"
