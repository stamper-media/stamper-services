"""Regenerate the JPEG fixtures from scikit-image's bundled sample photos."""

import os

from PIL import Image
from skimage import data

HERE = os.path.dirname(os.path.abspath(__file__))

if __name__ == "__main__":
    Image.fromarray(data.astronaut()).resize((1024, 768), Image.LANCZOS).save(
        os.path.join(HERE, "scene-1024x768.jpg"), quality=90
    )
    Image.fromarray(data.coffee()).save(os.path.join(HERE, "coffee-600x400.jpg"), quality=90)
