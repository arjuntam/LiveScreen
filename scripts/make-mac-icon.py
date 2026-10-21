"""Create the macOS icon from this project's existing 1024 px screen mark."""
from pathlib import Path
from PIL import Image
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='livescreen-icon-') as temp:
 folder=Path(temp)/'LiveScreen.iconset';folder.mkdir()
 original=Image.open(root/'assets/livescreen-mac.png')
 for size in [16,32,128,256,512]:
  for ratio in [1,2]:
   original.resize((size*ratio,size*ratio),Image.Resampling.LANCZOS).save(folder/f'icon_{size}x{size}{"@2x" if ratio==2 else ""}.png')
 subprocess.run(['iconutil','-c','icns',str(folder),'-o',str(root/'assets/livescreen.icns')],check=True)
print('macOS ICNS generated from the existing project mark.')
