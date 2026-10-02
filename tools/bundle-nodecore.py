#!/usr/bin/env python3
"""Bundle NodeCore's Lua for the in-page mod loader.

Writes data/nodecore-src.zip: every .lua, .conf, .txt and .csv file under the
game's mods/ folder, plus game.conf and LICENSE. Textures, sounds and
models are left out; the loader only runs code.

Usage:
  git clone https://gitlab.com/sztest/nodecore.git /tmp/nodecore
  python3 tools/bundle-nodecore.py /tmp/nodecore
"""
import os, subprocess, sys, zipfile

game = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'nodecore-src.zip')
commit = subprocess.run(['git', '-C', game, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in ('game.conf', 'LICENSE'):
        z.write(os.path.join(game, name), 'nodecore/' + name)
    for root, dirs, files in os.walk(os.path.join(game, 'mods')):
        dirs[:] = sorted(d for d in dirs if d not in ('textures', 'sounds', 'models', 'locale', '.git'))
        for f in sorted(files):
            if f.endswith(('.lua', '.conf', '.txt', '.csv')):
                full = os.path.join(root, f)
                z.write(full, 'nodecore/' + os.path.relpath(full, game))
    z.writestr('nodecore/COMMIT', commit + '\n')
print('wrote', out, os.path.getsize(out), 'bytes, commit', commit)
