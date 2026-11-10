#!/usr/bin/env python3
"""Generate the 1024x1024 app icon: lime pixel-art person on the site's dark green. Stdlib only.

Usage: python3 ios/tools/make-app-icon.py   (writes the AppIcon set's icon-1024.png)
Opaque RGB, no alpha, no text. 56 px cells; the 8x13 figure leaves 20%+ margin on every side.
"""
import struct, zlib, pathlib

SIZE, CELL = 1024, 56
BG, FG = (15, 31, 16), (198, 241, 157)

# 8 wide x 13 tall. '#' = lime.
SPRITE = [
    "..####..",
    ".######.",
    ".#.##.#.",   # eyes
    ".######.",
    "..####..",
    "........",
    ".######.",
    "########",
    "#.####.#",
    "#.####.#",
    "..####..",
    "..#..#..",
    "..#..#..",
]

out = pathlib.Path(__file__).resolve().parent.parent / "ConferenceCompanion/Assets.xcassets/AppIcon.appiconset/icon-1024.png"

rows_n, cols_n = len(SPRITE), len(SPRITE[0])
x0 = (SIZE - cols_n * CELL) // 2
y0 = (SIZE - rows_n * CELL) // 2

raw = bytearray()
for y in range(SIZE):
    raw.append(0)  # filter: none
    r = (y - y0) // CELL
    for x in range(SIZE):
        c = (x - x0) // CELL
        on = 0 <= r < rows_n and 0 <= c < cols_n and SPRITE[r][c] == "#"
        raw.extend(FG if on else BG)

def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
out.write_bytes(png)
print("wrote", out, len(png), "bytes")
