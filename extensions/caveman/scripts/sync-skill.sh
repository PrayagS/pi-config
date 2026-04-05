#!/usr/bin/env bash
# sync-skill.sh — fetch upstream caveman files, rewrite bundled base skill, and sync bundled compress skill + scripts.

set -euo pipefail

UPSTREAM_REPO="JuliusBrussee/caveman"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fetch_raw() {
	local upstream_path="$1"
	local dest="$2"
	curl -fsSL "https://raw.githubusercontent.com/$UPSTREAM_REPO/main/$upstream_path" -o "$dest"
}

echo "Fetching upstream caveman files from $UPSTREAM_REPO..."

BASE_SKILL_UPSTREAM="$TMPDIR/caveman-SKILL.md"
fetch_raw "skills/caveman/SKILL.md" "$BASE_SKILL_UPSTREAM"

python3 - <<'PY' "$BASE_SKILL_UPSTREAM" "$REPO_ROOT/base-skill/SKILL.md"
from pathlib import Path
import re
import sys

src = Path(sys.argv[1]).read_text()
lines = src.splitlines()
out = []
for line in lines:
    if "Supports intensity levels:" in line:
        line = re.sub(r"Supports intensity levels:.*", "Supports intensity levels: lite, full (default), ultra.", line)
    elif re.fullmatch(r"\s*wenyan-lite, wenyan-full, wenyan-ultra\.\s*", line):
        continue
    if line.startswith("Default: **full**. Switch:"):
        line = "Default: **full**. Switch: `/caveman lite|full|ultra`."
    table = re.match(r"^\|\s*\*\*(\S+?)\*\*\s*\|", line)
    if table and table.group(1).startswith("wenyan"):
        continue
    example = re.match(r"^-\s+(\S+?):\s", line)
    if example and example.group(1).startswith("wenyan"):
        continue
    out.append(line)
Path(sys.argv[2]).write_text("\n".join(out) + "\n")
PY

mkdir -p "$REPO_ROOT/skills/caveman-compress/scripts"
fetch_raw "caveman-compress/SKILL.md" "$REPO_ROOT/skills/caveman-compress/SKILL.md"
for script in __init__.py __main__.py benchmark.py cli.py compress.py detect.py validate.py; do
	fetch_raw "caveman-compress/scripts/$script" "$REPO_ROOT/skills/caveman-compress/scripts/$script"
done

UPSTREAM_BASE_SHA="$(curl -fsSL "https://api.github.com/repos/$UPSTREAM_REPO/commits?path=skills/caveman/SKILL.md&per_page=1" |
	grep -o '"sha": "[^"]*"' | head -1 | cut -d'"' -f4)"
UPSTREAM_COMPRESS_SHA="$(curl -fsSL "https://api.github.com/repos/$UPSTREAM_REPO/commits?path=caveman-compress/SKILL.md&per_page=1" |
	grep -o '"sha": "[^"]*"' | head -1 | cut -d'"' -f4)"

echo "Synced $REPO_ROOT/base-skill/SKILL.md"
echo "Base skill SHA: $UPSTREAM_BASE_SHA"
echo "Synced $REPO_ROOT/skills/caveman-compress/SKILL.md"
echo "Compress skill SHA: $UPSTREAM_COMPRESS_SHA"
