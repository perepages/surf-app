"""Cam snapshots -> WebP of at most MAX_WEBP_BYTES.

Uses Pillow, which this project installs ONLY in GitHub Actions (jobs/requirements-images.txt;
never add it to jobs/requirements.txt). Without Pillow, or if anything goes wrong, `to_webp`
returns None and the caller stores the original image instead (with a warning), so a run never
loses a snapshot over this.

Steps: shrink to MAX_WIDTH; quality 80, 70, 60, 50; if still too big, shrink to the size that
should fit and try again (never below MIN_WIDTH). Measured 2026-11-26: Windy previews 9-20 KB
JPEG -> 5-16 KB WebP; a 2.2 MB 12 MP photo -> 94 KB in ~5 s.
"""
from __future__ import annotations

import io

MAX_WEBP_BYTES = 100 * 1024
QUALITIES = (80, 70, 60, 50)
MIN_WIDTH = 320
# Wider frames (e.g. 2452 px city cams) are first shrunk to this: plenty for counting people.
MAX_WIDTH = 1600


def pillow_available() -> bool:
    try:
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


def to_webp(data: bytes, max_bytes: int = MAX_WEBP_BYTES) -> bytes | None:
    """The image as WebP (<= max_bytes), or None if Pillow is missing or it can't be done."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as src:
            img = ImageOps.exif_transpose(src).convert("RGB")  # drops EXIF/GPS too
        if img.width > MAX_WIDTH:
            img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)), Image.LANCZOS)
        for _ in range(4):
            size = 0
            for quality in QUALITIES:
                out = io.BytesIO()
                img.save(out, "WEBP", quality=quality, method=4)
                size = out.tell()
                if size <= max_bytes:
                    return out.getvalue()
            # Still too big at the lowest quality: shrink so the area fits (bytes ~ pixels), -10%.
            scale = min(0.9, (max_bytes / size) ** 0.5 * 0.9)
            if img.width * scale < MIN_WIDTH:
                return None
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        return None
    except Exception:
        return None
