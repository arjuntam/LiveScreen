"""Render the project's editable screen mark as Windows and tray assets."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'assets'
root.mkdir(exist_ok=True)
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs><linearGradient id="b" x2=".8" y2="1"><stop stop-color="#347CFF"/><stop offset="1" stop-color="#153FB9"/></linearGradient></defs>
<rect x="8" y="8" width="240" height="240" rx="54" fill="url(#b)"/>
<rect x="43" y="57" width="170" height="120" rx="14" fill="none" stroke="#FFFFFF" stroke-width="12"/>
<path d="M104 97v42l38-21z" fill="#FFFFFF"/>
<path d="M101 203h54m-27-26v26" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"/>
<circle cx="207" cy="62" r="22" fill="#153FB9"/><circle cx="207" cy="62" r="13" fill="#73F0C5"/>
</svg>'''
(root / 'livescreen.svg').write_text(svg)
scale=4
size=256*scale
im=Image.new('RGBA',(size,size))
pixels=im.load()
for y in range(size):
    t=y/(size-1)
    color=tuple(round(a*(1-t)+b*t) for a,b in zip((52,124,255),(21,63,185)))+(255,)
    for x in range(size): pixels[x,y]=color
mask=Image.new('L',im.size);d=ImageDraw.Draw(mask)
d.rounded_rectangle(tuple(v*scale for v in (8,8,248,248)),radius=54*scale,fill=255)
im.putalpha(mask);d=ImageDraw.Draw(im)
d.rounded_rectangle(tuple(v*scale for v in (43,57,213,177)),radius=14*scale,outline='white',width=12*scale)
d.polygon([(104*scale,97*scale),(104*scale,139*scale),(142*scale,118*scale)],fill='white')
d.line([(128*scale,177*scale),(128*scale,203*scale)],fill='white',width=12*scale)
d.rounded_rectangle((95*scale,197*scale,161*scale,209*scale),radius=6*scale,fill='white')
for radius,color in [(22,(21,63,185)),(13,(115,240,197))]:
    d.ellipse(((207-radius)*scale,(62-radius)*scale,(207+radius)*scale,(62+radius)*scale),fill=color)
im.save(root/'livescreen-mac.png')
im=im.resize((256,256),Image.Resampling.LANCZOS)
im.save(root/'livescreen.png')
im.save(root/'livescreen.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Rendered LiveScreen screen mark in SVG, PNG and multi-size ICO.')
