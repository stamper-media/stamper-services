#!/usr/bin/env python3
"""Mirror the TrustMark weights into MODELS_DIR (build time only; never at request time).

Source order: $TRUSTMARK_WEIGHTS_URL (our own mirror, a base URL ending in '/'),
then the Adobe CAI CDN that the `trustmark` package itself uses. Every file is
checked against the md5 list shipped in `trustmark` 0.9.2 and written atomically.

DESIGN §13.12: the Adobe CDN has been seen answering 403 to anonymous clients.
On 2026-10-01 it served the Q files (HTTP 200, checksums good). If it refuses
again: (1) mirror the three files below into a bucket and set TRUSTMARK_WEIGHTS_URL,
or (2) export ONNX graphs from the MIT-licensed weights; until either is done the
service runs with ML_WATERMARK=auto -> null watermark (no-op encode, decode never hits).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request

ADOBE_CDN = "https://cai-watermark.adobe.net/watermarking/trustmark-models/"
# md5 values copied from trustmark 0.9.2 (trustmark/trustmark.py MODEL_CHECKSUMS)
CHECKSUMS = {
    "trustmark_Q.yaml": "fe40df84a7feeebfceb7a7678d7e6ec6",
    "encoder_Q.ckpt": "700328b8754db934b2f6cb5e5185d81f",
    "decoder_Q.ckpt": "4ced90e9cfe13e3295ad082887fe9187",
}


def md5_file(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(name: str, dest: str, bases: list) -> None:
    target = os.path.join(dest, name)
    if os.path.isfile(target) and md5_file(target) == CHECKSUMS[name]:
        print(f"ok (cached) {name}")
        return
    errors = []
    for base in bases:
        url = base + name
        fd, tmp = tempfile.mkstemp(dir=dest, prefix=".part-")
        os.close(fd)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "stamper-ml-fetch/1"})
            with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            got = md5_file(tmp)
            if got != CHECKSUMS[name]:
                raise ValueError(f"md5 {got} != {CHECKSUMS[name]}")
            os.chmod(tmp, 0o644)
            os.replace(tmp, target)
            print(f"ok {name} <- {url}")
            return
        except Exception as exc:  # try the next source
            errors.append(f"{url}: {exc}")
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    raise SystemExit(f"could not fetch {name}:\n  " + "\n  ".join(errors))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", default=os.environ.get("MODELS_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"))
    args = ap.parse_args()
    os.makedirs(args.dest, exist_ok=True)
    bases = [b for b in (os.environ.get("TRUSTMARK_WEIGHTS_URL"), ADOBE_CDN) if b]
    for name in CHECKSUMS:
        fetch(name, args.dest, bases)
    return 0


if __name__ == "__main__":
    sys.exit(main())
