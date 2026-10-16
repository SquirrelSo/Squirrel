"""QR rendering (segno — pure Python, no native deps)."""

from __future__ import annotations

import io

import segno


def qr_svg(url: str, *, scale: int = 8, dark: str = "#1b1b1b") -> str:
    buf = io.BytesIO()
    segno.make(url, error="m").save(
        buf, kind="svg", scale=scale, border=2, xmldecl=False, svgns=True, dark=dark,
        title="Scan to join Squirrel Social",
    )
    return buf.getvalue().decode()
