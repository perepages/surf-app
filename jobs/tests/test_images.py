"""jobs/images.py (WebP for cam snapshots). Skipped where Pillow isn't installed.

python -m unittest jobs.tests.test_images
"""
import io
import random
import unittest

from jobs import images


@unittest.skipUnless(images.pillow_available(), "Pillow not installed")
class WebpTest(unittest.TestCase):
    def jpeg(self, w: int, h: int) -> bytes:
        from PIL import Image
        rnd = random.Random(1)
        img = Image.frombytes("RGB", (w, h), bytes(rnd.getrandbits(8) for _ in range(w * h * 3)))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=95)
        return out.getvalue()

    def test_small_stays_sharp(self):
        from PIL import Image
        webp = images.to_webp(self.jpeg(400, 224))
        self.assertIsNotNone(webp)
        with Image.open(io.BytesIO(webp)) as im:
            self.assertEqual((im.format, im.size), ("WEBP", (400, 224)))

    def test_noise_fits_the_cap(self):
        # Random noise is the worst case for compression: must still end <= the cap.
        webp = images.to_webp(self.jpeg(2000, 1200), max_bytes=100 * 1024)
        self.assertIsNotNone(webp)
        self.assertLessEqual(len(webp), 100 * 1024)

    def test_not_an_image(self):
        self.assertIsNone(images.to_webp(b"not an image"))


if __name__ == "__main__":
    unittest.main()
