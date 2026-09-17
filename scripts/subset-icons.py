# ──────────────────────────────────────────────
# Regenerate the Material Icons subset font.
#
# The web app self-hosts Material Icons Outlined (see apps/web/src/app/icons.css).
# The full font is 151KB — the single largest asset on first load. This script
# subsets it to the glyphs the app actually references (token scan of
# apps/web/src) → ~8KB, keeping the ligature features that make
# <span class="icon">school</span> render as the glyph.
#
# Run after adding NEW icon names:
#   python scripts/subset-icons.py
#
# Requirements: pip install fonttools brotli
# The full .woff2 is committed next to the subset as the regeneration source;
# re-fetch it from fonts.gstatic.com if it is ever missing.
# ──────────────────────────────────────────────

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'apps', 'web', 'src')
FULL = os.path.join(ROOT, 'apps', 'web', 'public', 'fonts', 'material-icons-outlined.woff2')
OUT = os.path.join(ROOT, 'apps', 'web', 'public', 'fonts', 'material-icons-outlined.subset.woff2')

from fontTools import subset
from fontTools.ttLib import TTFont

# 1. Scan every lowercase word-ish token in the web sources. Over-matching is
#    fine (a few unused glyphs cost bytes, not correctness); under-matching
#    would render blank icons, so keep patterns generous.
tokens = set()
for dirpath, _, files in os.walk(SRC):
    for name in files:
        if not name.endswith(('.tsx', '.ts')):
            continue
        text = open(os.path.join(dirpath, name), encoding='utf-8', errors='ignore').read()
        tokens.update(re.findall(r"[\"']([a-z][a-z0-9_]+)[\"']", text))
        tokens.update(re.findall(r">([a-z][a-z0-9_]+)<", text))

# 2. Keep only tokens the font knows (glyph names = ligature names).
f = TTFont(FULL)
name_to_code = {n: c for c, n in f.getBestCmap().items()}
codes = sorted({name_to_code[t] for t in tokens if t in name_to_code})
print(f"tokens scanned: {len(tokens)} | glyphs kept: {len(codes)}")

# 3. Subset, preserving the ligature features that make names render.
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['liga', 'rlig', 'ccmp']
opts.name_IDs = [1, 2]
opts.notdef_outline = True
s = subset.Subsetter(options=opts)
s.populate(unicodes=codes)
s.subset(f)
f.flavor = 'woff2'
f.save(OUT)

print(f"full:   {os.path.getsize(FULL) // 1024} KB")
print(f"subset: {os.path.getsize(OUT) // 1024} KB  → {OUT}")
