# Presentation fixtures

`high-resolution-image.pdf` is generated test artwork: one 8001 × 6692 RGB
image with four solid colour quadrants and an opaque grayscale soft mask.
Both streams use Flate compression. The source pixels exceed the old
16-megapixel PDF.js image limit while the rendered preview remains small.
The UI test checks actual quadrant pixels, not merely a valid PNG header.
It contains no user document, company material, fonts or external resources.

`audible-video.mp4` is generated test artwork: a blue frame and a 660 Hz
sine tone, two seconds long, H.264/AAC. It contains no recorded speech, music
or user media. Tests check the player's mute state and Electron audible state.
