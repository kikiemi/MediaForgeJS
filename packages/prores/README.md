# mediaforgejs-prores

Optional ordinary Apple ProRes decoding and encoding for MediaForgeJS. Install it only in applications that need ProRes processing:

```sh
npm install mediaforgejs mediaforgejs-prores
```

The core MediaForgeJS package does not import this package. There is no FFmpeg executable, FFmpeg WASM distribution, or WebCodecs global replacement. The encoder dependency contains a small codec derived from FFmpeg; its license remains LGPL-2.1-or-later.

| Operation | Supported input/output |
| --- | --- |
| Decode | `apco`, `apcs`, `apcn`, `apch`, `ap4h`, `ap4x`; native 10/12-bit planar YUV; progressive and interlaced; 8/16-bit source alpha |
| Encode | The same six profiles, from packed straight-alpha RGBA8; progressive; BT.709, limited-range output |
| Alpha encode | RGBA8 transparency in `ap4h` and `ap4x`; other profiles reject nonopaque input |
| RGBA conversion | Explicit 10/12-bit color and alpha reduction to RGBA8; supported SDR BT.709 primaries/transfer and BT.709/BT.601 matrices |
| ProRes RAW | Separate codec; unsupported by these factories |

High-depth or YUV encoder input, HDR tone mapping, color-primary conversion, and interlaced encoding are unsupported and rejected. The encoder's RGBA8 input is not a 10/12-bit mastering source. Rate control is selected by the ProRes profile; an explicit nonzero `bitrate` request is rejected.

## Decode packets

Use MediaForgeJS demuxing to obtain complete ProRes frame packets. Matroska packets must have their size/`icpf` header restored before direct decoding; MediaForgeJS's normal packet API does this.

```js
import { createProResDecoder } from 'mediaforgejs-prores';

const decoder = await createProResDecoder({ codec: 'ap4h', width: 1920, height: 1080 });
try {
    const frame = await decoder.decode({ data: encodedPacket, timestamp: 0, duration: 1 / 25 });
    try {
        // Owned Y/Cb/Cr/(alpha) planes with byte offsets and strides.
        consumePlanar(frame.data, frame.format, frame.layout);
        // Optional and explicitly lossy:
        const rgba = await frame.toRgba({ allowPrecisionLoss: true });
    } finally {
        frame.close();
    }
} finally {
    await decoder.close();
}
```

All timestamps and durations are **seconds**. Each packet produces one frame. Frames remain valid after later calls and after closing the decoder; callers own them and should close them after use. `data` access and conversion after closing a frame throw. A retained `Uint8Array` reference follows ordinary JavaScript ownership and cannot be revoked by `close()`.

Planes contain little-endian samples in the low bits of 16-bit words. `codedWidth`/`codedHeight` include padding; the visible rectangle begins at the upper left. `pixelAspectRatio`, `scanType`, and numerical color metadata are retained. `I444P12A16` (or `I422P12A16`) has 12-bit color planes and a full 16-bit alpha plane. This custom format is deliberately distinct from WebCodecs `I444AP12`: passing it to a consumer that only supports 12-bit alpha requires an explicit conversion. Eight-bit source alpha is represented without loss in the decoder's 12-bit alpha plane.

`toRgba()` requires `allowPrecisionLoss: true`. It converts the visible rectangle, keeps interlaced lines in their existing order, and does not deinterlace. Unknown color matrix metadata defaults to BT.709; `colorSpaceAssumed` exposes that assumption and `unspecifiedColorMatrix: 5` or `6` selects BT.601. Known unsupported primaries or transfer functions, including PQ and HLG, are rejected. Chroma expansion uses nearest samples; this is a simple SDR conversion, not a mastering color pipeline.

## Encode packets

```js
import { createProResEncoder } from 'mediaforgejs-prores';

const encoder = await createProResEncoder({ codec: 'ap4h', width: 1920, height: 1080 });
try {
    const packet = await encoder.encode({
        data: rgbaBytes, format: 'RGBA', width: 1920, height: 1080,
        timestamp: 0, duration: 1 / 25,
    });
    // packet is a MediaForgeJS video EncodedChunk. Mux it into MOV or MKV.
    muxer.addVideoChunk(packet);
} finally {
    await encoder.close();
}
```

RGBA input must contain exactly `width * height * 4` bytes, straight alpha, and BT.709 RGB code values. `Uint8Array` and `Uint8ClampedArray` are accepted. The resulting packet is an intra/key frame with independently owned bytes. The adapter uses the dependency's packet API without building an intermediate MOV or accumulating a sample index.

## Using it with MediaForgeJS

The package exports `prores`, a MediaForgeJS plugin, so ProRes joins a conversion like any other plugin:

```js
import { MediaForge } from 'mediaforgejs';
import { prores } from 'mediaforgejs-prores';

const forge = new MediaForge({ plugins: { add: [prores] } });
const { blob } = await forge.convert(input, { to: 'mov', video: { codec: 'ap4h' }, allowPrecisionLoss: true });
```

The same decoder gives `forge.frames()` and `forge.thumbnail()` their ProRes pictures.

`proResVideoCodec` is ProRes as one `VideoCodecProvider` object that decodes and encodes (the type is exported by `mediaforgejs/plugins`); the `prores` plugin offers the same factories as a decoder part and an encoder part that replace the host for ProRes. It identifies only the six ordinary ProRes FourCCs. Importing the adapter registers nothing globally. Decoder and encoder dependencies load only when their respective factory is called.

## Lifetime

The conversion option permits native high-depth frames to pass through the RGBA8 encoder input. Packet-copy operations do not reduce precision. Interlaced conversion, unsupported color spaces, and alpha-dropping outputs remain rejected.

Always await each `decode()`/`encode()` for straightforward backpressure. At most `maxQueueSize` calls are accepted (default 4); excess calls reject without retaining the input. `queueSize`, `desiredSize`, and `flush()` expose completion. `close()` is idempotent, stops new work, cancels queued work, and waits for active work before disposing the codec. Frames already returned remain caller-owned. An `AbortSignal` cancels queued work and preserves its abort reason. Native synchronous WASM work cannot be interrupted mid-frame; the adapter yields between frames and releases resources after that frame settles.

Default limits are 8192 × 8192 padded pixels and 256 MiB per input packet. Decoder `concurrency` defaults to zero for portable execution without workers; this runs a frame on the calling thread. Nonzero worker concurrency and shared memory depend on the host environment. Browser WASM needs SIMD support; shared memory also needs cross-origin isolation. Browser execution is not part of this release's Node codec verification.

## Licenses

The adapter's original code is WTFPL. `alpha.js` is an attributed LGPL-2.1-or-later adaptation of FFmpeg's alpha unpacker, retaining full 16-bit precision. Unmodified npm dependencies retain their own licenses: TurboRes is MPL-2.0; prores-wasm-encoder is LGPL-2.1-or-later and includes an IJG-derived integer DCT. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). These components are not relicensed under the core package's WTFPL license.
