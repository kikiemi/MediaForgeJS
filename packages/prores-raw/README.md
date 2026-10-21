# mediaforgejs-prores-raw

Optional JavaScript ProRes RAW decoder. It decodes a complete `prrf` packet from
an `aprn` (RAW) or `aprh` (RAW HQ) track into an owned 16-bit linear RGGB Bayer
plane. It needs no FFmpeg executable, WebAssembly download, WebCodecs API, or
global shim. The package is **LGPL-2.1-or-later**; see `LICENSE` and `NOTICE`.
It is separate from the WTFPL MediaForgeJS core and is not imported by it.

```js
import { decodeProResRaw, decodeProResRawAsync } from 'mediaforgejs-prores-raw';

const frame = decodeProResRaw(packet.data, { codec: 'aprn' });
// frame.data: Uint16Array; frame.stride: elements per row, not bytes.
// Top-left 2×2 pattern: R G / G B. No margins have been removed.
console.log(frame.width, frame.height, frame.color, frame.recommendedCrop);

const asyncFrame = await decodeProResRawAsync(packet.data, {
    codec: 'aprn',
    signal: abortController.signal,
    tilesPerYield: 32,
});
```

The decoder handles version 0/1 RGGB frames, tile widths of 1–16 macroblocks,
adaptive DC/AC entropy coding, quantization matrices, clipped 16-bit integer
IDCT, and the frame's eight-point linearization curve. Partial right/bottom
tiles are cropped to the declared dimensions. RAW contains no alpha plane.
Other Bayer patterns, unknown versions/flags, and quantizer products that
overflow a signed 16-bit scale are rejected explicitly. RAW encoding is not
included. Ordinary ProRes (`apco` through `ap4x`) uses a different decoder.

The output is **sensor data, not display-ready RGBA**. Linearization is applied;
black-level subtraction, white balance, demosaicing, camera-to-XYZ conversion,
gain, output transfer functions, and recommended crop are not applied. The
camera metadata is returned in `frame.color`; `color.valid` checks its basic
numerical validity, not its calibration accuracy. Raw header and trailing
vendor metadata bytes are preserved in owned arrays, including information the
decoder does not interpret. Keep the original encoded packet for lossless
container copy; decoded pixels cannot recreate the packet.

`maxFrameBytes`, `maxPixels`, and `maxTiles` default to 128 MiB, 64 MiPixels, and
262,144 respectively. Checks run before output allocation. A Bayer frame uses
two bytes per visible pixel, plus bounded tile descriptors, header/metadata
copies, and approximately 4 KiB of coefficient workspace. The async function
also snapshots the encoded packet and yields between tile batches so an
`AbortSignal` can interrupt it. The synchronous function checks cancellation
between tiles but cannot process same-thread events while running. Neither
function retains decoder state or changes global APIs.

Original synthetic packets exercise both versions, all tile widths, adaptive
codebooks, saturated coefficients, custom curves/matrices, partial tiles,
malformed boundaries, and cancellation. Golden Bayer digests were obtained
from the upstream C entropy/IDCT functions at the commit recorded in `NOTICE`;
the JavaScript output matches those samples exactly. Camera-generated footage
and a camera vendor's reference decoder have not been qualified. This is a
packet decoder, not a camera ISP or a claim of real-time playback performance.

Run the repository's `npm test -- packages/prores-raw` for decoder regression
tests. The distributed `.js` files are the complete, editable implementation;
the upstream reference C sources are included in `upstream/` for attribution
and audit. No C compiler is needed to use this package.
