# ──────────────────────────────────────────────
# Regenerate the Material Icons subset font.
#
# The web app self-hosts Material Icons Outlined (see apps/web/src/app/icons.css).
# The full font is 151KB — the single largest asset on first load. This script
# subsets it to the icons the app actually references (token scan of
# apps/web/src) plus the letter glyphs their ligatures are built from.
#
# Run after adding NEW icon names:
#   python scripts/subset-icons.py
#
# Requirements: pip install fonttools brotli
# The full .woff2 is committed next to the subset as the regeneration source;
# re-fetch it from fonts.gstatic.com if it is ever missing.
#
# TWO-STEP ORDER MATTERS (this exact order was a live bug once):
#   Step A: PRUNE the full font's GSUB to the ~120 ligatures the app uses.
#           Material icons render via LIGATURES — the letter sequence
#           p-e-r-s-o-n maps to the person glyph. If subsetting runs first
#           WITH letters present, GSUB closure pulls in every one of the
#           2195 ligature rules and their icon outlines (~130KB subset).
#           If subsetting runs first WITHOUT letters, every letter glyph is
#           dropped, no ligature can fire, and every icon site-wide renders
#           as raw text — the bug this script exists to prevent.
#   Step B: subset the pruned font to the icon codepoints + a-z 0-9 _.
#           Now closure only sees the ~120 surviving ligatures.
# ──────────────────────────────────────────────

import os
import re

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

# 2. Keep only tokens the font knows (glyph names = icon names).
f = TTFont(FULL)
name_to_code = {n: c for c, n in f.getBestCmap().items()}
icon_names = {t for t in tokens if t in name_to_code}
icon_codes = sorted({name_to_code[t] for t in icon_names})
print(f"tokens scanned: {len(tokens)} | icons referenced: {len(icon_codes)}")

# 3. STEP A — prune GSUB on the FULL font BEFORE subsetting. A ligature is
#    kept iff its LigGlyph is one of the icon glyphs we keep.
pruned = 0
gsub = f.get('GSUB')
if gsub and gsub.table.LookupList:
    for lookup in gsub.table.LookupList.Lookup:
        for st in lookup.SubTable:
            if hasattr(st, 'ligatures'):
                for first in list(st.ligatures.keys()):
                    survivors = [lig for lig in st.ligatures[first] if lig.LigGlyph in icon_names]
                    pruned += len(st.ligatures[first]) - len(survivors)
                    if survivors:
                        st.ligatures[first] = survivors
                    else:
                        del st.ligatures[first]
    print(f"ligatures pruned: {pruned}")

# 4. STEP B — subset to the icon codepoints plus the ligature alphabet.
#    Letters/digits/underscore MUST survive or no ligature can ever fire.
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['liga', 'rlig', 'ccmp']
opts.name_IDs = [1, 2]
opts.notdef_outline = True
LIGATURE_COMPONENTS = (
    list(range(0x61, 0x7B))   # a-z — the ligature alphabet
    + list(range(0x30, 0x3A)) # 0-9 — names like looks_one, battery_5_bar
    + [0x5F]                  # _   — underscore inside multi-word names
)
s = subset.Subsetter(options=opts)
s.populate(unicodes=sorted(set(icon_codes) | set(LIGATURE_COMPONENTS)))
s.subset(f)

f.flavor = 'woff2'
f.save(OUT)

print(f"full:   {os.path.getsize(FULL) // 1024} KB")
print(f"subset: {os.path.getsize(OUT) // 1024} KB  -> {OUT}")
