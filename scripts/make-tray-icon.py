"""Render the project's screen mark as a macOS monochrome template icon."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1]
for scale in (1, 2):
    size = 18 * scale
    image = Image.new('RGBA', (size * 4, size * 4))
    draw = ImageDraw.Draw(image)
    u = scale * 4
    draw.rounded_rectangle((u, 3*u, 17*u, 14*u), radius=2*u, outline='black', width=2*u)
    draw.polygon([(7*u, 6*u), (7*u, 11*u), (12*u, 8.5*u)], fill='black')
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / 'assets' / ('trayTemplate' + ('@2x' if scale == 2 else '') + '.png'))
