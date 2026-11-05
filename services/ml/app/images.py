"""Image loading with pixel/byte limits and staging-dir confinement for path mode."""

from __future__ import annotations

import io
import os
import warnings

from PIL import Image, ImageOps

from .errors import Forbidden, InvalidInput, NotFound, TooLarge


def resolve_staging_path(raw: object, staging_dir: str) -> str:
    """Return the real path of `raw` if it is an existing file inside `staging_dir`."""
    if not isinstance(raw, str) or not raw:
        raise InvalidInput("path must be a non-empty string")
    if "\x00" in raw:
        raise InvalidInput("path contains a NUL byte")
    root = os.path.realpath(staging_dir)
    real = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(root, raw))
    if os.path.commonpath([root, real]) != root:
        raise Forbidden("path is outside STAGING_DIR")
    if not os.path.isfile(real):
        raise NotFound("path does not exist")
    return real


def read_path_bytes(raw: object, staging_dir: str, max_bytes: int) -> bytes:
    real = resolve_staging_path(raw, staging_dir)
    if os.path.getsize(real) > max_bytes:
        raise TooLarge("file exceeds MAX_UPLOAD_BYTES")
    with open(real, "rb") as fh:
        return fh.read()


def load_rgb(data: bytes, max_pixels: int) -> Image.Image:
    """Decode image bytes to an RGB PIL image, refusing more than `max_pixels` pixels."""
    if not data:
        raise InvalidInput("empty image")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data))
            w, h = img.size
            if w * h > max_pixels:
                raise TooLarge(f"image has {w * h} pixels, limit is {max_pixels}")
            img.load()
    except TooLarge:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise TooLarge(str(exc)) from exc
    except Exception as exc:  # PIL raises many types for corrupt input
        raise InvalidInput(f"cannot decode image: {exc.__class__.__name__}") from exc
    # DESIGN §5 step 0: images are processed EXIF-rotated (captures keep Orientation);
    # the output JPEG carries no EXIF, so the rotation must be baked into the pixels.
    try:
        img = ImageOps.exif_transpose(img)
    except Exception as exc:
        raise InvalidInput(f"cannot apply EXIF orientation: {exc.__class__.__name__}") from exc
    if img.mode != "RGB":
        if img.mode in ("RGBA", "LA", "P") or "transparency" in img.info:
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.getchannel("A"))
            img = bg
        else:
            img = img.convert("RGB")
    return img


def to_jpeg(img: Image.Image, quality: int, icc_profile: "bytes | None" = None) -> bytes:
    """Encode RGB as JPEG; `icc_profile` (e.g. Display P3 from the source) is carried over."""
    buf = io.BytesIO()
    extra = {"icc_profile": icc_profile} if icc_profile else {}
    img.save(buf, format="JPEG", quality=quality, subsampling=0, optimize=True, **extra)
    return buf.getvalue()


# Pillow's own bomb guard stays on, at a ceiling well above any configured limit.
Image.MAX_IMAGE_PIXELS = 1_000_000_000
