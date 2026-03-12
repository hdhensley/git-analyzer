# Build Assets

This directory contains build assets for the Git Analytics Dashboard application.

## Required Icons

To build distributable packages, add the following icon files:

- `icon.icns` - macOS application icon (512x512 or larger)
- `icon.ico` - Windows application icon (256x256)
- `icons/` - Linux icons directory with PNG files at various sizes:
  - `16x16.png`
  - `32x32.png`
  - `48x48.png`
  - `64x64.png`
  - `128x128.png`
  - `256x256.png`
  - `512x512.png`

## Generating Icons

You can use tools like:
- [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder)
- [png2icons](https://www.npmjs.com/package/png2icons)

Or online services like:
- https://www.icoconverter.com/
- https://cloudconvert.com/

Start with a 1024x1024 PNG source image for best results.
