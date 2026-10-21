# Third-party notices

## Alpha decoder adaptation

`alpha.js` adapts the alpha delta/run unpacking algorithm from FFmpeg 6.1 `libavcodec/proresdec2.c`:

- Copyright (c) 2010–2011 Maxim Poliakovski
- Copyright (c) 2010–2011 Elvis Presley
- JavaScript adaptation, bounds checking, and full 16-bit output by MediaForgeJS contributors, 2026.
- License: GNU Lesser General Public License, version 2.1 or later. The complete license accompanies this package in `LICENSE-LGPL-2.1`.
- Original source: <https://ffmpeg.org/doxygen/6.1/proresdec2_8c_source.html>
- Corresponding adapted source is distributed directly as `alpha.js`; there is no separate compiled alpha binary. Applications can replace or modify this module.

The rest of this adapter is original code under the license in `LICENSE`.

## Unmodified optional-package dependencies

The following remain separate npm dependencies. Their source and license files are not copied into or relicensed by MediaForgeJS core:

| Component | Version | License | Source |
| --- | --- | --- | --- |
| TurboRes | 1.2.2 | MPL-2.0 | <https://github.com/Vanilagy/turbores> |
| ProRes WASM Encoder | 1.0.0 | LGPL-2.1-or-later | <https://github.com/OlivierEstevez/ProRes-WASM-encoder> |

ProRes WASM Encoder credits its codec core to FFmpeg's `proresenc_kostya.c` (Anatoliy Wasserman and Konstantin Shishkov) and its integer DCT to libjpeg's `jfdctint.c` under the IJG license. Consult that project's source and notices when redistributing its compiled WASM. Bundling this optional package does not remove the dependency licenses or the requirement to provide any source/relinking materials their licenses require.

Apple ProRes is a trademark of Apple Inc. These are independent implementations, not an Apple-certified codec. Software licenses do not provide a separate patent license.
