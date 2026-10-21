# How MediaForgeJS is organized

English · [日本語](#日本語)

This page maps `src/`: what each folder owns, how a call flows through it, and which parts are plugins and which are
subsystems of their own. The guide's [How it is built](README.md#en-architecture) has the decision table (which
module decides what).

## Layers

Every module belongs to the layer of its top folder. An import (static, dynamic or type-only) points to a lower
layer or stays inside its own; folders of one rank are siblings and never import each other. `scripts/layers.mjs`
checks this before every build, and `test/build/layers.test.mjs` holds the checker to it.

| Rank | Folder      | Owns                                                                                       |
| ---- | ----------- | ------------------------------------------------------------------------------------------ |
| 0    | `core`      | Errors, bytes, sources and sinks, the track model, codec configuration, the part contracts |
| 1    | `formats`   | Containers, manifests, subtitles and tags: bytes to tracks and back                        |
| 1    | `codecs`    | Decoders, encoders and the WebCodecs adapters                                              |
| 2    | `stages`    | The processing stages and their runner                                                     |
| 3    | `pipeline`  | The engine: planning and running every operation, packaging, plugin composition            |
| 4    | `editing`   | `edit()`: the project of several clips and its render on the engine                        |
| 4    | `recording` | `encodeFrames()` and `recordStream()`: application frames and MediaStream capture          |
| 4    | `runtime`   | Files of Node, Bun and Deno, and the installed FFmpeg backend                              |
| 5    | `plugins`   | The library's plugins and their catalog                                                    |
| 6    | `api`       | The functions, `MediaForge` and `Media`, option reading, and the package entries           |

`editing`, `recording` and `runtime` are **subsystems**: the conversion engine does not use them. Only their own
package entries reach them through static imports (`mediaforgejs/runtime/*` for `runtime`). Every other entry loads
them on demand, so they add nothing to the startup of `mediaforgejs` or `mediaforgejs/lite`. HLS and DASH playback is
the package `packages/player` (mediaforgejs-player): a plugin that `play()` uses once an application adds it, written
against the public entries of mediaforgejs only. `layers.mjs` fails on a violation, and
`test/build/bundle.test.mjs` checks the built entries.

## Features

Inside the layers the code is cut into **features**: the unit that declares what it uses, has its own tests, and that
a change is checked against. `scripts/features.mjs` reads them off the folders, so a new folder is a new feature:

- a plugin folder (one with a `manifest.ts`) is a feature: `codecs/h264`, `formats/avi`;
- in `core`, `formats`, `codecs` and `pipeline` each subfolder is a feature (`core/io`, `formats/mp4`,
  `codecs/flac`, `pipeline/copy`), and the files directly in such a folder are one more, named after it
  (`pipeline`: the engine);
- every other top folder is one feature: `api`, `editing`, `recording`, `runtime`, `stages`, `plugins`;
- each package in `packages/` is a feature (`packages/prores`).

Each feature lists in `DEPENDENCIES` the features it may use (`core/*` names every feature of core). A use is an
import that runs, static or dynamic; type-only imports are left to the layer rule and the compiler. The check runs in
every build and in `npm test` (`test/build/features.test.mjs`) and fails when

- a feature uses a feature it does not declare, or declares one it does not use;
- the declared uses form a cycle;
- a plugin, or a shared feature (`codecs/pcm`, `codecs/shared`, `formats/detection`, `formats/metadata`,
  `formats/shared`), uses anything but core and the shared features, so that every plugin can be left out
  on its own;
- a feature has no declaration or no test file, or a test file belongs to no feature;
- a package imports anything but its own files, its dependencies and the entries of `mediaforgejs`.

`node scripts/features.mjs` prints the map: each feature with its modules, its test files and the features it uses.

A test file belongs to the feature with the longest name its path starts with: `test/<feature>.test.mjs`,
`test/<feature>-<aspect>.test.mjs` or `test/<feature>/<aspect>.test.mjs` (`test/formats/mp4-read.test.mjs`,
`test/codecs/mpeg-audio-decode.test.mjs`, `test/api/convert.test.mjs`); a package's tests are in
`packages/<name>/test/`, and `test/build/` tests the tooling. `npm run test:affected` reads the map backwards: the
changed files name their features, every feature that uses one of them, directly or through others, may break, and
their test files run.

## The tree

```
src/
  core/
    errors/          MediaForgeError and codes, diagnostics and warnings, option policy, limits, guards
    bytes/           byte readers and writers, CRC-32, synchronous raw inflate, buffer pools,
                     output data
    io/              abort and deadlines, bounded asynchronous inflate, encode steps
      sources/       Source and its implementations: Blob, buffer, HTTP ranges, cache, concatenation, streams
      sinks/         Sink and its implementations: memory, streams, backpressure, validation
    model/           TrackInfo and Sample (the track model every reader fills), codec strings and names
    contracts/       what every part implements: plugin, reader, writer, decoder, encoder, picture,
                     stage, player
    codec-config/    configuration records and headers every reader shares (image-info, Windows Media)
      audio/         AAC, ADTS, ALAC, AC-3/E-AC-3, DTS, TrueHD, FLAC, MPEG audio, Opus, Vorbis, PCM, WAVE
      video/         Annex B, AVC/HEVC/VVC parameter sets, AV1, VP8/VP9, MPEG-1/2, VC-1, DV, ProRes, Dolby Vision
  formats/           one folder per container family: reader.ts, writer.ts, read/ and write/ for their parts
    mp4/             MP4, MOV and fragmented MP4; write/ holds CMAF, sidx and the streaming box reader
    matroska/        Matroska and WebM
    mpeg-ts/         MPEG transport streams, LATM
    ogg/             Ogg (Vorbis, Opus, FLAC, Theora, extra streams)
    audio-files/     WAV, AIFF, AU, CAF, FLAC, MP3/MP2, ADTS AAC, AC-3/DTS streams
    images/          picture dimensions
    avi/ flv/ asf/ mxf/ mpeg-ps/ ivf/ iamf/ apv/   the plugin containers (apv/ also decodes APV)
    hls/ dash/       playlists and manifests, renditions, AES-128 segment encryption
    text/            subtitles: WebVTT, SRT, ASS, TTML, timed text
    metadata/        ID3, emsg, normalized tags, track JSON
    detection/       format detection: the core's signatures (the plugins' are in their manifests),
                     elementary streams, the tests of the bytes
    shared/          names, MIME types, what each container carries, the format registry's
                     parts, packed AVC/MPEG streams shared by AVI, Matroska and Ogg (vfw/),
                     the probes and windows of large inputs (large-input, position-search)
                     and the raw writers' base (elementary-stream)
  codecs/
    webcodecs/       the host decoders and encoders and the support probe
    pcm/             PCM, G.711, resampling (core)
    image/           PNG, JPEG, WebP, GIF, baseline TIFF decoding and resizing (core)
    shared/          decoder warnings, IDCT, colour conversion, FFT, the lazy encoder
    aac/ mpeg-audio/ flac/ alac/ opus/ vorbis/ ac3/ h264/ mpeg12/ mpeg4/   software codecs (plugins)
  stages/            the stage runner, transform, frame rate, remix, time-stretch, geometry options
  pipeline/          engine.ts (every operation on an opened input), engine-work.ts, types.ts
    read/            MediaFile, the format registry, track snapshots, packet indexes, reader modules
    plan/            conversion: what each track undergoes, codec choice, encoder settings, format policy
    copy/            packet copies into another container: remux plans, trims, interleaving, CMAF timing
    transcode/       the timeline of clips and its lanes: decode, stages, encode, one muxer
    codecs/          which decoder and encoder runs for each track (router.ts: the host or the
                     library), and running them
    frames/          pictures and thumbnails, image targets and inspection
    package/         HLS and DASH packaging, live HLS
    plugins/         composing the plugins in use, and the errors that name a missing plugin
  editing/           project.ts (reading an edit project), render.ts (rendering it)
  recording/         encodeFrames() and recordStream(), MediaStream capture, frame streams
  runtime/           Node, Bun and Deno files
    ffmpeg/          the installed FFmpeg backend
  plugins/           index.ts (the list of every plugin), catalog.ts (their manifests, for errors and lite)
  api/               forge.ts (MediaForge), media.ts (Media), operations.ts, picture-operations.ts, target.ts,
                     capabilities, hints, parts.ts (createParts), play.ts, surface*.ts (the names entries and
                     scripts share)
    options/         reading options, open options, request keys, plugin selection, encoder settings
    entries/         one file per package entry (11) and per script build
```

Inside a folder, files are named for their role: `reader.ts` and `writer.ts` for a container's reader and writer,
`read/` and `write/` for their parts, `decoder.ts` and `encoder.ts` for a codec, `tables.ts` and `types.ts` for
constant tables and shared types. A file does not repeat its folder's name (`formats/mp4/reader.ts`, not
`formats/mp4/mp4-demuxer.ts`). A folder with more than about 20 files gets subfolders.

Each plugin is one folder (`codecs/h264/`, `formats/avi/`, ...) with two faces:
`manifest.ts` says what the plugin adds (its decoders, encoders, readers with their signatures, writers, stages
and players, without code) and
`index.ts` is the plugin, which loads the rest of the folder on first use. Outside the folder only these two are
imported: `scripts/layers.mjs` fails on any other import of a plugin's files, apart from types and the API's
standalone building blocks (`mediaforgejs/codecs` and `formats`). `plugins/index.ts` lists the plugins and
`plugins/catalog.ts` their manifests, which name a plugin that is left out.

## Paths of each call

Each call takes this route through the tree:

| Call                               | Path through the tree                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `inspect()`, `open()`              | `api/forge` → `pipeline/engine` → `pipeline/read` (detection in `formats/detect`) → a `reader`          |
| `convert()` copying                | `api/target` → `pipeline/plan` → `pipeline/copy` → a `writer`                                           |
| `convert()` re-encoding            | `pipeline/plan` → `pipeline/transcode` (clips → lanes) → `pipeline/codecs` → `codecs/*`, `stages`       |
| `check()`, `onPlan`                | `pipeline/plan`, then the operation into a sink that keeps nothing                                      |
| `thumbnail()`, `frames()`, images  | `pipeline/frames` → `pipeline/codecs` → `codecs/image`                                                  |
| `packageMedia()`                   | `pipeline/package` → `formats/mp4/write` (CMAF), `formats/hls`, `formats/dash`                          |
| `edit()`, `audio.replace`          | `editing/project` → `editing/render` → `pipeline/transcode`                                             |
| `encodeFrames()`, `recordStream()` | `api/encode` → `recording` → the parts of `pipeline/codecs`, a `writer`                                 |
| `capabilities()`                   | `api/capabilities` → `codecs/webcodecs/support`, `formats/shared/capabilities`                          |
| `play()`, `createPlayer()`         | `api/play` → the player plugin added (mediaforgejs-player: `hls-player`, `dash-player`, `hls-playback`) |
| `HlsClient`, `playHls()`           | mediaforgejs-player → `mediaforgejs/streaming` (playlists, MPDs), `mediaforgejs/plugins`                |

An operation may take more than one path: a distinct way of carrying it out, such as reading an input described
from its ends or from its index, or writing MP4 whole or in fragments. The tables below list every path of each
operation: the one function that selects it and the condition, what that path does that the others cannot, and the
tests that reach it (their file without `.test.mjs`, and their name). A path stays only for a capability or for a
speed measured on a case users hit. Measurements were taken in Node 22 on inputs made in memory, timed against the
path that would serve the case otherwise.

### Opening an input: `inspect()`, `open()`

`FormatRegistry.open()` runs the reader's probe and reads the input whole where the probe declines.

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| Indexed at open (`Reader.read()`) | The reader has no probe, or its probe declines: an input below its format's threshold ([How an input is read](#how-an-input-is-read)), damage, or a layout a description cannot place | Reads every sample: sample counts, and damage anywhere reported at open | `test/pipeline/read-probes`: "inputs of every size are described as a full read describes them", "movies a description cannot match are read whole at open" |
| Described from the head and tail (`ProbedInput` without `index`) | MPEG-TS and Ogg whose head and tail do not meet; Matroska, WebM, MP3, FLAC and fragmented MP4 with an `mfra` from 4 MiB (each reader's probe) | Reads a few windows, without sample counts. It keeps them for later windows (`window`) and a pass (`stream`). Measured with `inspect()`: a 10-minute Matroska file of 154 MB took 10.9 ms and read 3.2 MB described, against 114 ms reading all of it indexed. An MPEG-TS of 165 MB: 30 ms against 432 ms. A 1-hour fragmented MP4 of 150 MB: 5.2 ms and 0.4 MB against 101 ms and 7.5 MB | `test/pipeline/read-probes`: "inspect() describes a large MPEG-TS from its head and tail", "inspect() describes a large Matroska file from its head and tail", "a fragmented MP4 with a fragment index opens from its ends"; `test/formats/audio-files-large`: "is described from its Info frame, reading under 1 MiB", "is described from STREAMINFO, reading under 1 MiB" |
| Described from the movie box (`ProbedInput.index`) | An MP4 without fragments whose movie box is 256 KiB or more (`Mp4Demuxer.describe()`) | Checks the sample tables without building them and keeps their counts. The first read builds the index from where the tables lie (`MediaFile.probedIndex`). Measured with `inspect()` of a 1-hour MP4 (2.3 MB movie box): 6.0 ms against 10.1 ms | `test/pipeline/read-probes`: "a large movie box is described, its tables built on the first read" |

### `Media.packets()`

The selection is made in `readPackets()` (`api/media-reads`), and `MediaFile.passServes()` decides which requests
a pass serves.

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| The index (`PacketSchedule`) | The input is indexed or its index is read, or the request has a range or `keyframesOnly` | Reads packets of any range, keyframes only, in decode order | `test/api/media`: "a Media knows its format and reads its packets"; `test/pipeline/read-passes`: "a failed read of the index fails that call only" |
| One pass (`ProbedInput.stream`, `StreamSchedule`) | A described input whose index is not read yet, a request a pass serves, and a reader that streams it (MPEG-TS, Matroska, WebM; FLAC for `packets()` alone, `packetsOnly`) | Reads the input once, where the index would be one read of the whole input and the packets another. See the copy measurement below | `test/pipeline/read-passes`: "packets() of a described … is one pass with the packets of the index", "an abort stops a pass at the next packet"; `test/formats/audio-files-large`: "open() and packets() read it once, as its index gives the frames" |

### `Media.packetAt()`

The selection is made in `packetAt()` (`api/media-reads`).

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| The index (`MediaFile.findSample()`) | An indexed input, an index already read, MPEG-TS audio, or no window holds the time | Finds any packet | `test/pipeline/read-probes`: "open() reads a large MPEG-TS as inspect() does and finds packets" |
| A window's file (`ProbedInput.window`) | A described input: a window of the reads of its open, or of the input opened again with the window's probe where its reader keeps none | Reads only the clusters, packets or pages around the time | `test/pipeline/read-windows`: "Matroska: the clusters around the packet find what the index finds", "MPEG-TS: a picture shown at the end of the head is found" |
| A window's tracks (`ProbedInput.windowTracks`) | A described fragmented MP4 whose window's moof boxes parse alone (`windowPacketAt()`) | Parses the moof boxes and reads one packet's bytes, without demuxing the window. Measured with 20 searches over a 1-hour fragmented MP4 (150 MB): after the first, 0.1 to 0.2 ms a search against 0.5 to 0.6 ms through the window's file. CPU 3 to 10 ms against 14 to 19 ms, and 1.9 MB read against 3.9 MB | `test/pipeline/read-probes`: "a fragmented MP4 with a fragment index opens from its ends" |

### `Media.segments()`

There is one path: the index, through `MediaFileWriter.iterateSegments()`. Tests: `test/api/media`: "segments start with the
init segment and come again the same".

### `convert()` copying: what it reads

The selection is made in `convert()` (`api/operations`, `copiesInOnePass()`) and `MediaFileWriter.routePackets()`.

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| The index (`sharePackets()` of one route) | An indexed input; a described one whose reader does not stream it (MP4, Ogg, MP3, FLAC); an audio copy that counts the coded samples of the whole track | Copies any range from any input | `test/pipeline/copy-passes`: "a copy that trims Opus by its pre-skip reads the index first"; the copy tests of `test/pipeline/copy*` |
| One pass (`streamedPackets()`) | A whole copy of an input described from its ends whose reader streams it (MPEG-TS, Matroska, WebM) | Reads the input once instead of twice. Measured with a copy into MP4: an MPEG-TS of 165 MB took 516 ms and read 171 MB, against 673 ms and 331 MB with its index read first. A Matroska file of 154 MB took 308 ms and read 157 MB, against 318 ms and 307 MB; the time follows the bytes on a disk or a network | `test/pipeline/copy-passes`: "a large MPEG-TS copies in one pass, and a trim reads its window", "a large Matroska copies in one pass, and a trim reads its window"; `test/pipeline/read-passes`: "copies as an indexed copy does" |
| A window of the range (`ProbedInput.window` of `range`) | A copy of a range of an input described from its ends | Reads only the window around the range | the same two `test/pipeline/copy-passes` tests; `test/pipeline/read-probes`: "a WebM range with Opus is copied from a window around it", "a Matroska copy in windows keeps a track absent from the middle" |

### `convert()` copying: how it is written

`MediaFileWriter.copyFormat()` and `copyWriter()` select the writer, for `check()` and the copy alike.
`containerLayout()` (`formats/shared/capabilities`) selects how a container is written, for copies, conversions
and encodes alike.

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| The audio file writer | An audio file target (AAC, MP1 to MP3, WAV, AIFF, AU, CAF, FLAC, Ogg) of one audio track | Writes the stream with its file headers | `test/formats/audio-files-pcm`: "… copies its codes into WAV, AIFF, AU, CAF, MOV and MKV"; `test/support/matrix`: write/wav, write/flac, … |
| Fragmented MP4 (`iterateSegments()`) | An `fmp4` target. Also an MP4, M4A or M4V copy of a track only fragments carry (`resolveRemuxFormat()`), and an MP4 copy of an input read in one pass into a sink that cannot patch (warns `MP4_FRAGMENTED`) | Writes as it reads: nothing is patched, and it carries the codecs only fragments carry | `test/pipeline/copy`: "a fragmented MP4 copy reports progress for every packet"; `test/pipeline/copy-checks`: "an MP4 copy of a track only fragments carry is written as fragmented MP4"; `test/pipeline/copy-passes`: "a sink that cannot be patched gets fragmented MP4, not a second read" |
| A container in one pass (`prepareContainer()`) | A sink that can patch, or a target outside the MP4 family. MP4 and AVI are written whole. Matroska is written as it goes, but whole with Cues and its size (where the sink can patch) when it holds several tracks of a kind or subtitles | Writes the standard layout of the container | the copy tests of `test/pipeline/copy*`; `test/api/convert-sinks`: "a forward-only sink gets Matroska of two tracks cluster by cluster" |
| MP4 in two passes (`PatchRecorder`, `replayPatches()`) | An MP4-family copy, from an index or a window, into a sink that cannot patch | Writes standard MP4 into a forward-only sink without holding the payloads: a measuring pass records the header's patches, and the second pass writes them in as it goes | `test/api/convert-sinks`: "a forward-only sink gets MP4 and MOV while the input is read, past 4 GiB" |

`check()` of a copy runs the copy into a validation sink (`validateRemux()`). A plan (`onPlan`, `Engine.plan()`)
prepares the writer without reading packets (`checkRemux()`). Both take the writer from `copyWriter()`.

### `packageMedia()`

The read is selected in `packageMedia()` (`api/operations`, `packagesInOnePass()`). The output is selected by the
target's container and `demuxed` (`packageSegments()`).

| Path | Selected when | What only it does | Tests |
| ---- | ------------- | ----------------- | ----- |
| From the index (`borrowedPackets()`) | An indexed input, or a packaged track without packets in the probe's head | Times every track from its index | `test/pipeline/package-hls`, `test/pipeline/package-dash` |
| In one pass (`ProbedInput.stream`) | A described input whose head times every packaged track | Reads the input once, as a copy does | `test/pipeline/read-passes`: "packages in one read the files an indexed package writes" |
| CMAF segments (`cmafOutput()`) | HLS with fragments, DASH, `hls+dash`, muxed or one representation a track (`demuxed`) | Writes init and media segments, each cut at the keyframe of its own tracks | `test/pipeline/package-hls`: "come as the init segment, the segments and both playlists", "give the video and the audio their own init, segments and playlist" |
| MPEG-TS segments (`transportOutput()`) | HLS with `container: 'ts'` | Writes transport stream segments, each starting with the program tables | `test/pipeline/package-hls`: "each start with the PAT and hold whole transport packets" |

HLS subtitles become WebVTT renditions, read from `packets()` of each text track. Live HLS (`packageHlsLive()`)
packages what `Media.segments()` gives.

### `encodeMp3()`, `encodeMp2()`, `encodeFlac()`, `encodeAacLc()`

One path: `api/audio-encoders` hands the planes to the library's streaming encoder in blocks of 8192 frames, as a
conversion hands its library encoder PCM chunks; the MP3 encoder selects how it weighs attacks.

| Path                                | Selected when                           | What only it does                                                                      | Tests                                                                                                          |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| streaming encoder                   | every call                              | the encoding, the same as a conversion's library encoder                               | `test/codecs/mpeg-audio-encode` "frames short inputs into whole frames", `test/codecs/flac`, `test/codecs/aac` |
| MP3 block types by the whole input  | `encodeMp3()`: the input is known whole | weighs attacks against the mean high-band energy of the whole input (`slotEnergyMean`) | `test/codecs/mpeg-audio-encode` "a whole-file encode weighs attacks against the whole input"                   |
| MP3 block types by the running mean | a conversion to MP3: the input streams  | weighs attacks against the energy read so far                                          | `test/pipeline/transcode-audio` "MP3 decodes to the length of its source: the LAME gapless trim"               |

### `decodeMp3()`, `decodeFlac()`, `decodeAacFrames()`, `decodeG711()`

One path each, selected by nothing: the frame decoder a conversion uses, over the whole input.

| Path                         | Selected when | What only it does                                                                                                                                                                                        | Tests                                                                                     |
| ---------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| frame decoder over the input | every call    | `decodeMp3()` and `decodeFlac()` find their frames themselves, as `codecs` lies below the readers; `StreamingMp3Decoder`, `decodeFlacFrame()` and `AacLcDecoder` are the same decoders a frame at a time | `test/codecs/mpeg-audio-decode`, `test/codecs/flac`, `test/codecs/aac`, `test/codecs/pcm` |

### Decoded audio of a track (`createAudioTrackSource()`, `decodeAudio()`, conversions)

The pipeline selects the host or the library decoder (`pipeline/codecs/audio-track-decoder`); the decoder brings what
it decodes to the track's shape where the stream changes, by one of two rules.

| Path                                                  | Selected when                                                                     | What only it does                                                                                                                       | Tests                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `downmixChannels()` (`codecs/pcm/audio-buffer-tools`) | the host decoder's planes, or an MPEG audio run's, differ from the track in count | folds by `mixWeights()`, each output scaled by the sum of its weights (mono the mean of the stereo fold), or spreads mono to the fronts | `test/codecs/webcodecs-audio`, `test/codecs/mpeg-audio-decode` "stereo frames in a mono track become the mean of their sides" |
| AC-3 speaker assembly (`codecs/ac3/decoder`)          | an AC-3 or E-AC-3 access unit carries speakers the track lacks                    | assembles the speakers of the independent and dependent substreams and folds the others in by `speakerFold()` unscaled, as ffmpeg       | `test/codecs/ac3`                                                                                                             |

### PCM in another rate or channel count (`normalizePcmSource()`, `remix()`, resampling)

One path, `StreamingPcmTransformer` (`codecs/pcm/streaming-pcm`), selected by nothing.

| Path                      | Selected when | What only it does                                                                                 | Tests                                  |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `StreamingPcmTransformer` | every call    | planes of the same shape pass; channels map by `downmixChannels()`, rates by `StreamingResampler` | `test/codecs/pcm`, `test/stages/audio` |

### PCM samples written (WAV, AIFF, AU, CAF; PCM tracks of MP4, MOV, Matroska)

One path, `encodePcm()` (`codecs/pcm/encoder`), selected by nothing. Its integers follow the
library's one quantizing rule, `quantizeSample()` (`core/model/pcm-quantize`), which the WAV and AVI
writers' planar input and the G.711 encoder also use.

| Path          | Selected when    | What only it does                                                              | Tests                                              |
| ------------- | ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `encodePcm()` | every PCM output | 16- or 24-bit integers rounded half up, or 32-bit floats, in either byte order | `test/codecs/pcm`, `test/pipeline/transcode-audio` |

### Audio stages (`stageAudio()`, `audio.stages`, `remix()`, the speed of edit clips)

One path, `chainedPcmSource()` (`stages/chain`): an `AudioStageChain` over the source; the caller selects whether the
stages replay.

| Path                                  | Selected when               | What only it does                                               | Tests                                                               |
| ------------------------------------- | --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| replayed stages (`stagedPcmSource()`) | a conversion's staged sound | builds fresh stages for every read from the start               | `test/stages/chain` "every replay runs fresh stages from the start" |
| the caller's stages (`stageAudio()`)  | `mediaforgejs/parts`        | runs the caller's stages, configured at the call, over one read | `test/stages/chain` "staged sound is read once", `test/api/parts`   |

### `picture.rgba()` (and `frames()` data, the pictures stages see)

`Picture` (`stages/picture`) selects by what holds the pixels.

| Path                            | Selected when                                          | What only it does                                          | Tests                                         |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| as held                         | an RGBA picture (`createPicture()`, the CPU transform) | nothing to convert                                         | `test/stages/picture`                         |
| `planarToRgba()`                | built-in decoder planes                                | converts the visible region by the stated matrix and range | `test/stages/picture`, `test/pipeline/frames` |
| canvas readback                 | a host frame the transform stage just drew             | reads the canvas it drew without drawing again             | `test/stages/transform-browser`               |
| shared canvas (`canvasRgba()`)  | a host frame where OffscreenCanvas exists              | colour-manages HDR and wide gamut to sRGB                  | `test/pipeline/frames-browser`                |
| `copyTo()` and `planarToRgba()` | a host frame without OffscreenCanvas                   | the only way to its pixels where no canvas exists          | `test/stages/picture`                         |

### The transform stage (`transformStage()`: crop, turn, mirror, resize, pad, overlays and fades)

`transformStage()` (`stages/video`) selects by the picture and the geometry; `needsRgb()` (`stages/frame-transform`)
alone decides that 4:2:2 and 4:4:4 frames become RGB.

| Path                      | Selected when                                                          | What only it does                                                                       | Tests                           |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| pass                      | the identity geometry and a frame encoders take                        | no copy                                                                                 | `test/stages/video`             |
| visible-rectangle crop    | a crop of a host frame on its chroma grid                              | crops without copying                                                                   | `test/stages/transform-browser` |
| plane orient (`orient()`) | turns, mirrors and chroma-aligned crops of 4:2:0 host frames           | keeps the frame's colour and bit depth (HDR)                                            | `test/stages/transform-browser` |
| canvas draw               | any other geometry of a host frame, or a painter, with OffscreenCanvas | draws on the GPU, colour-managed                                                        | `test/stages/transform-browser` |
| painted planes            | built-in decoder planes with a painter                                 | wraps the planes in a host frame, since painting needs a canvas                         | `test/stages/transform-browser` |
| CPU transform             | built-in decoder planes or RGBA, or a host frame without a canvas      | converts only the region (`planarToRgba()`) and transforms it (`transformRgbaRegion()`) | `test/stages/transform`         |

### The image encoders (`encodePng()`, `encodeJpeg()`, `encodeWebP()`, `encodeBmp()`, `encodeTiff()`, `encodeIco()`, the animation encoders)

Each encoder (`codecs/image/encoders`) selects its own path.

| Path                        | Selected when                                                      | What only it does                                                                                                                             | Tests                       |
| --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| host PNG                    | `encodePng()` of an opaque picture where OffscreenCanvas draws     | faster, measured in Chromium: 95 ms for 1920×1080 against 342 ms by the library, 16 against 46 ms for 640×360 (files 2.1 to 2.8 times larger) | `test/codecs/image-browser` |
| library PNG                 | a translucent picture, no canvas, a canvas that fails, APNG frames | exact alpha (a canvas premultiplies), the same bytes on every host                                                                            | `test/codecs/image`         |
| host JPEG and WebP          | `encodeJpeg()`, `encodeWebP()`, animated WebP frames               | the only JPEG and WebP encoders (ENCODE without a canvas)                                                                                     | `test/codecs/image-browser` |
| library BMP, TIFF, ICO, GIF | always                                                             | the only encoders of these formats; ICO scales with Lanczos                                                                                   | `test/codecs/image`         |

### The image decoders (`decodeStillWebp()`, `decodeAnimatedWebp()`, `decodeVp8l()`, a picture conversion's input)

`decodeStillWebp()` selects by the WebP's coding; the pipeline selects for other formats.

| Path                                          | Selected when                                      | What only it does                           | Tests                       |
| --------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | --------------------------- |
| library PNG, VP8L, GIF, APNG, baseline TIFF   | PNG, lossless WebP, GIF, APNG, a TIFF it reads     | decodes without a host                      | `test/codecs/image`         |
| host `createImageBitmap`                      | lossy WebP (VP8)                                   | the only VP8 decoder                        | `test/codecs/image-browser` |
| host `ImageDecoder` (`decodeImageWithHost()`) | the frames of other animated formats               | reads frames the library has no decoder for | `test/codecs/image-browser` |

### `RgbaResizer` and picture resizing

`RgbaResizer` (`codecs/image/rgba-resize`) selects by method and direction; `CanvasImageRenderer`
(`codecs/image/canvas-resize`) by the host's canvas. `resize()` and `resizeAsync()` run the same code; the second
yields every 8 ms and stops with a signal.

| Path                         | Selected when                                                                        | What only it does                                                                         | Tests                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| nearest, two-sample bilinear | 'nearest', or 'bilinear' enlarging                                                   | one or four source samples per pixel                                                      | `test/codecs/image` "enlarging interpolates between two samples"                |
| separable filter             | 'lanczos3', or 'bilinear' shrinking                                                  | averages the whole source area under each pixel                                           | `test/codecs/image` "shrinking averages the whole source area under each pixel" |
| canvas draw                  | a picture conversion's enlargement (bilinear or nearest) where OffscreenCanvas draws | faster, measured in Chromium: 16 ms for 640×360 to 1920×1080 against 90 ms by the library | `test/codecs/image-browser`                                                     |

Counts of these paths before → after this round: audio stages over a source 2 → 1 (`stageAudio()` ran its own copy
of the chain loop); the shape of decoded runs 3 → 2 (MPEG audio had its own channel averaging, which gives the same
samples as `downmixChannels()` for its one and two channels); PCM sample coding 2 → 1 (`encodePcm16()` for PCM tracks
beside the audio files' coder), and the 16-bit coder's second loop of host-order stores is gone (measured within 1 ms
per 10 s of 48 kHz stereo in Node); the stereo fold weights and the 4:2:2 and 4:4:4 test have one owner each
(`mixWeights()`, `needsRgb()`) instead of two and three. The other tables count as they stand.

### convert() and check()

`resolveTarget()` (`api/target`) gives the target its class, by `targetClassOf()`;
`prepareConversion()` (`pipeline/plan/conversion`) selects the path of a container or audio file
target; `check()` runs the selected path into a sink that keeps nothing (`createValidationSink()`).

| Path        | Selected when                                                                                                                                                                                                                                 | What only it does                                                                                                                                    | Tests                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Copy        | a container target whose selected tracks all fit (`copyOrReencode()`); an audio target without settings whose format carries the codec (`audioCopy()`); a conversion whose plan copies every track (the runner's copy, with the plan's rotation) | writes the input's packets: no decoder, no encoder                                                                                                   | `test/pipeline/plan`, `test/api/convert`, `test/api/targets`                            |
| Re-encode   | a container target with settings, with `copy: false`, or with a track that does not fit                                                                                                                                                      | decodes, runs the stages and encodes on the one-clip timeline (the lanes below)                                                                      | `test/pipeline/transcode`, `test/pipeline/plan-decisions`, `test/api/convert`           |
| Audio file  | an audio target (wav, aiff, au, caf, flac, aac, mp2, mp3) with settings, or whose format does not carry the codec                                                                                                                            | one track's sound, trimmed by sample at the output rate, written by the audio file writers with the input's tags (`audio-plan`, `audio-file-writer`) | `test/pipeline/transcode-audio`, `test/pipeline/transcode-precision`                    |
| Picture     | a png, jpeg or webp target of a media input                                                                                                                                                                                                  | the picture shown at `start`, taken as thumbnail() takes it (`takePicture()`)                                                                       | `test/pipeline/frames-images`                                                           |
| Animation   | a gif or apng target of a media input                                                                                                                                                                                                        | the pictures from `start` to `end` at `fps`, from frames()                                                                                           | `test/pipeline/frames-animations`                                                       |
| Still image | an image target of an image input                                                                                                                                                                                                            | decodes, resizes and encodes one picture (`ImageConverter`)                                                                                          | `test/pipeline/frames-images`                                                           |

The audio file path stays beside the timeline's audio file (edit() to an audio target): it trims one
track by sample at the output rate and keeps the input's tags, where an edit places its clips by
their times and mixes them. Both write through one `AudioFileWriter`.

A still image is decoded by one rule (`ImageConverter.convertImage()`), the router's: baseline
TIFF and lossless WebP by the library on every host; the other stills by the host where it has
`createImageBitmap` (and `ImageDecoder` for AVIF, HEIF and JPEG XL), else by the library, which
decodes PNG (`decodePng()`: any colour type and depth, Adam7) and a GIF's first picture and
refuses the rest with DECODE. An output only a host canvas writes (`HOST_ONLY_IMAGE_FORMATS`) is
refused with ENCODE before anything is decoded, by `assertPictureEncoder()`
(`pipeline/frames/picture-encoder`),
for images, pictures from video and thumbnails alike. `capabilities()` declares the formats by
the same rule: those the library decodes or writes always, the host's where one probe of it
(`codecs/image/host-formats`) finds them. Tests: `test/pipeline/frames-images`,
`test/formats/images`.

### The lanes of a re-encode

A conversion runs as a timeline of one clip (`conversionJob()`), an edit as the timeline of its
clips; a track that fits the output is a copy lane, and the functions named select how the others
decode and encode.

| Path                                        | Selected when                                                                                                                                                                                        | What only it does                                                                           | Tests                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Video decode: host / library                | `chooseVideoDecoder()`: the host VideoDecoder when it takes the configuration, unless `codecPreference: 'builtin'` and the library decodes the codec                                                  | the host's decoding (hardware) / decoding without WebCodecs                                 | `test/pipeline/transcode-video`, `test/pipeline/transcode-browser`             |
| Video encode: plugin / host                 | `openVideoEncoder()`: a plugin encoder that writes the codec (`encodeWith`), else the host VideoEncoder                                                                                              | a codec the host does not encode (ProRes) / the host's encoding                             | `test/pipeline/codecs-application`, `test/pipeline/transcode-browser`          |
| Sound decode: linear PCM / host / library   | `readsLinearPcm()`, then `decoderOrder()`: the host first unless the library is preferred; the other takes over after a failure (AUDIO_DECODER_FALLBACK)                                             | samples read without a decoder / the host's decoding / decoding without WebCodecs           | `test/pipeline/codecs-audio-decoders`, `test/pipeline/codecs-router`           |
| Sound encode: host                          | `audioEncoderOrder()`: the host first, except for PCM, G.711, MP2, MP3, 24-bit FLAC and a builtin preference; `streamHostAudio()` hands a failed host's sound to the library (AUDIO_ENCODER_FALLBACK) | the host's encoding (Opus, AAC, …)                                                          | `test/pipeline/codecs-audio-encoders`, `test/pipeline/transcode-precision`     |
| Sound encode: PCM, G.711                    | the codec                                                                                                                                                                                            | packets of samples                                                                          | `test/pipeline/codecs-audio-encoders`                                          |
| Sound encode: AAC-LC                        | `builtinAudioEncoding()`: 'aac' (the aac plugin)                                                                                                                                                     | AAC without a host encoder                                                                  | `test/pipeline/codecs-audio-encoders`                                          |
| Sound encode: FLAC, MP2, MP3                | `builtinAudioEncoding()`: 'container'; the length stated or not                                                                                                                                       | the window declared before the first packet (a stated length) or at the end (a live source) | `test/pipeline/codecs-audio-encoders`                                          |

A codec the host cannot encode is replaced by one rule (`encodableVideoCodec()`,
`encodableAudioCodec()` in `pipeline/plan/codec-choice`) for conversions, edits and recordings,
reported as CODEC_SUBSTITUTED; the strict option policy keeps the codec asked.

### thumbnail() and frames()

`extractFrames()` (`pipeline/frames/frame-extract`) is the one path; an application codec of the
track's codec decodes it, as in conversions (`openClipDecoder()`), else `chooseVideoDecoder()`
selects its decoder; `assertPictureEncoder()` (`pipeline/frames/picture-encoder`) decides whether
its pictures encode.

| Path            | Selected when                                                       | What only it does                                                                   | Tests                                                        |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Frames          | frames(), thumbnail(), a picture or animation target                | decodes from the keyframe before each time, from the index or, for an input read in one pass, by reading ahead (`StreamedFrames`); RGBA or VideoFrame | `test/pipeline/frames`, `test/api/frames`                   |
| PNG / JPEG, WebP | the picture's format                                               | PNG anywhere (the host's canvas where every pixel is opaque) / through OffscreenCanvas | `test/pipeline/frames-images`, `test/pipeline/frames-browser` |

### edit()

`runEdit()` (`editing/render`) selects by the target's class; `convert()` with `audio.replace` is an
edit of one muted clip.

| Path       | Selected when      | What only it does                                                              | Tests          |
| ---------- | ------------------ | ------------------------------------------------------------------------------ | -------------- |
| Container  | a container target | the clips on the timeline: copy lanes where every clip's packets fit, else the lanes above | `test/editing` |
| Audio file | an audio target    | the clips' sound mixed into the audio file writer (`writeAudioFile()`)         | `test/editing` |

### encodeFrames() and recordStream()

`encodeStreams()` (`recording/encode-frames`) is the one path: pictures through the host
VideoEncoder, sound through a muxer's encodeAudio(); `captureStream()` selects how a MediaStream
gives them.

| Path                       | Selected when                      | What only it does                                              | Tests                            |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Frames and blocks          | encodeFrames()                     | the application's VideoFrames and AudioData                    | `test/recording-encode-frames`   |
| Track processors           | recordStream(), MediaStreamTrackProcessor present | the stream's frames and sound as the browser hands them | `test/recording-encode-frames`   |
| Video element, AudioContext | recordStream() without the processor | the frames drawn from a video element (`elementFrames()`), the sound from an AudioContext | `test/recording-encode-frames` |

### The parts

The parts are the timeline's own selections, handed out: `decodeAudio()` decodes as the sound
lanes do, `createVideoDecoder()` and `createVideoEncoder()` select by `chooseVideoDecoder()` and
`openVideoEncoder()`, and a muxer's `encodeAudio()` encodes as the sound lanes do. `decodeAudio()`
states the frames its track presents, so `encodeAudio()` declares the length ahead (tests:
`test/api/parts`, `test/pipeline/codecs-audio-encoders`).

### play() and createPlayer() (mediaforgejs-player)

Every stream plays through one MSE core, `playStreams()` (`hls-playback`), one SourceBuffer per
stream; the player of the URL's protocol selects the streams, and `playable`, `highestOf()` and
`playableOf()` in its support what plays without adaptive quality. Tests in
`packages/player/test`.

| Path               | Selected when                                            | What only it does                                                                                                                       | Tests                                                    |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| HLS media playlist | the URL is a media playlist                              | plays its units                                                                                                                         | `hls-playback`, `play`                                   |
| HLS multivariant   | a multivariant playlist without `adaptive`               | the variant `HlsClient` chooses as it loads (`client.variant`: the highest bandwidth the browser plays)                                  | `play`, `hls-alternate-renditions`                       |
| HLS adaptive       | `adaptive: true`                                         | switches by measured bandwidth, across AUDIO and SUBTITLES groups and, where `changeType()` exists (`changesCodecs()`), to other codecs | `hls-adaptive-vod`, `hls-adaptive-live`, `hls-adaptive-parts` |
| Audio rendition    | the variant's AUDIO rendition has a playlist of its own  | a second SourceBuffer, which follows the variant (`AudioRenditionFeed`)                                                                  | `hls-alternate-renditions`                               |
| Subtitles          | SUBTITLES renditions and `media.addTextTrack`            | text tracks of WebVTT cues, which follow the variant (`SubtitleTracks`)                                                                  | `hls-alternate-renditions`                               |
| Protected HLS      | `drm`                                                    | AES-128, SAMPLE-AES and EME (`playStreamsWithDrm()`)                                                                                     | `hls-drm`, `sample-aes`, `clear-key`, `eme-lifecycle`    |
| DASH               | an MPD                                                   | the first period's video and audio sets, each from its highest playable representation                                                  | `play`, `play-browser`                                   |

### The runtime

Each host's files and `FFmpegBackend` are paths of their own hosts, selected by the entry an
application imports.

| Path            | Selected when                                   | What only it does                                          | Tests                       |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------- | --------------------------- |
| Node, Bun, Deno | `mediaforgejs/runtime/node`, `bun`, `deno`      | files and paths through the host's API (`runtime/file-io`) | `test/runtime`              |
| FFmpeg          | `FFmpegBackend`                                 | probe, copy and convert through an installed FFmpeg        | `test/runtime-ffmpeg`       |

## How an input is read

One rule holds for every format: an open describes the input, and its index is built when an operation first needs
it. `open()` reads what `inspect()` reads and nothing per sample. A reader describes an input (a `MediaFile` with
`probedInput`) whenever describing does less than indexing and gives the same result; where its description could
differ from a read of the whole input (damage, a layout it cannot place), its probe declines and the input is indexed
at open. Each format's threshold follows from that:

- an MP4 without fragments whose movie box is 256 KiB or more: that box is read whole either way, and its sample
  tables are checked as its index checks them but not built (`describeClassicSamples`). The tables of a smaller one
  build in less time than a description saves, and the first packet would read the box again. A movie whose read
  warns, or whose read a description cannot match (more than one sample description, a chapter track, an edit list
  that splices the media, a sample outside the media, a fix that changes samples), is indexed at open. The tracks
  keep their sample counts (`ProbedInput.counted`), and the index is built from the positions of the tables, the
  movie box read again (`ProbedInput.index`);
- a fragmented MP4 of 4 MiB or more with a fragment index (an `mfra` its last box `mfro` places at the end), from
  its movie box, that index and its first and last fragments (`formats/mp4/read/fragment-probe`): those reads start
  at 32 KiB at each end and grow fourfold, so on a smaller input they would read about as much as the walk over
  every `moof` header that indexes it. One without an index reads every `moof`;
- MPEG-TS, Matroska, WebM and Ogg where their head and tail do not meet (Matroska and WebM from 4 MiB, two windows
  of 2 MiB), from the head and tail: those reads would read a smaller input whole. A Matroska or WebM tail starts at
  the last cluster its Cues place, which ends every track it holds a block of; where a track ends before it, the
  tail starts a cluster before each fourfold distance from the end, the last 32 MiB as before;
- MP3 and FLAC from 4 MiB, from the header and the last frames; a smaller one is read whole in a few milliseconds and
  reports damage anywhere in it.

Packets are found by time: `Media.packets()` gives them in decode order and `Media.packetAt(trackId, time)` finds one
by presentation time. No sample index reaches user code, and `sampleCount` is only reported by `inspect()`.

Each operation then reads what it needs (`api/read-probes`, `api/media-reads`, `api/operations`,
`api/picture-operations`):

- a pass over a probed input (a copy, packaging, `frames()` at rising times) opens it again as a stream, read once
  in file order. It times the samples as the index does, carrying from one span of the pass to the next what the
  index takes from the samples after: the duration of Matroska sound stored without one, which lasts until the next
  frame (`DurationFiller`), reordered pictures and Vorbis block sizes;
- a range, a picture or a packet found by time reads a window around it: the reader places the window from the head
  and tail the open read (`ProbedInput.window()`), and `packetAt()` reads the index where the window does not hold the
  packet. The window of a packet or of a range a copy writes times reordered Matroska video as the index does, by
  the first pictures of each track (`ReorderClock`), which the head holds or which are read once before the first
  such window. A Matroska window around a time (of a packet or a picture) starts at the cluster before it and ends
  with one shown over a second after it; an MPEG-TS window around a time reads about a second around it, found by
  reading where the decode times known on each side place it (`narrowToPosition`, as Ogg and FLAC windows), and the decode times
  its search reads place the windows after it. A window's tracks are described as the open described
  them, from the tracks' first samples (their configuration, rate, channels and encoder delay), not from the
  window's first samples. `thumbnail()` opens a Matroska input with Cues from its head alone, read from 64 KiB until
  every track has a sample (up to 32 MiB), and an MPEG-TS input without its tail (`ProbeTarget.windowOnly`): the input's end
  describes nothing a picture needs. A window reads what a demux needs from the start of the input (Matroska's
  elements before its first cluster, the MPEG-TS program tables) from a small reader the probe holds, and nothing
  else before its own clusters or packets (`WindowBytes`; from a Blob, as views of what the Blob read), and a pass over its packets reads no further than its
  end (`ProbedInput.end`); a Matroska window passes over the metadata the description holds. A fragmented MP4 window
  is the fragments the index (`tfra`) of its first track places around the time, read after the movie box the probe
  holds, each timed by its own decode time (`tfdt`): the demuxer passes over the fragments before the window
  (`Mp4DemuxerOptions.fragmentsFrom`), takes its tracks from those the first window parsed from the trak boxes
  (`Mp4DemuxerOptions.movie`) and reads its fragments as views of its chunks. A pass over a fragmented MP4 reads its index. A `Media` reads every target but
  a stream from the window of what its open read. `packetAt()` of a fragmented MP4 needs no file of its window: the
  probe parses the window's fragments from their moof boxes alone, read with the box header after each, into the
  tracks the movie box keeps (`ProbedInput.windowTracks`, the same `parseFragments` and trex defaults), the `Media`
  finds the packet in them as `findSample()` finds it and reads only its bytes. The window's file still decides
  where that parse would warn or fail (a fragment without a `tfdt`, a sample outside its media data, damage), where a
  track switches sample descriptions or the movie box has chapter tracks, and where the window's file would fail its
  checks (`maxPacketBytes`, `maxSamples`, `maxIndexBytes`). The windows of the Matroska clusters and of the fMP4
  fragments are found in their index by halves (`PlaceSearch`), one by one where its times do not rise;
- an MPEG-TS input whose head holds no video keyframe (H.264 entered at I pictures without IDR, or at recovery
  points) reads its index for a pass and a window too: only a read of the whole stream tells its keyframes;
- `packets()` without a range or `keyframesOnly` of an input whose reader streams it (Matroska, MPEG-TS) reads it in
  one pass, as a copy does: the pass hands the packets in the order and with the times its index holds
  (`StreamSchedule`), and the input is not read twice. The damage the pass reads past is the `Media`'s as that of the
  index (`MediaReading.reports`): `media.warnings` lists it, and a read of the index after the pass does not report
  it to the listener again.
  A described FLAC streams for `packets()` alone (`ProbeTarget.packetsOnly`): its index is read as a read of the
  whole input reads it, and the frames found are handed over at each checkpoint of the scan, with views of the bytes
  they were read in; a copy of it reads its index, as the copy of a stream is written otherwise (into MP4 in
  fragments);
- every read of a described MP4 without fragments reads its index (`readPlan()`): its sample order is not its file
  order, so no pass streams it, and its tables place every packet without a window. The first read builds the tables
  from the movie box read again (`MediaFile.probedIndex`), with the tracks the open described; its warnings take a
  window's way, as the description declined any input whose read warns: the index finds nothing the open did not;
- what needs the whole input (`packets()` of a range or keyframes, `check()`, `decodeAudio()`, the re-encode of a
  whole input) reads its index once, and the `Media` keeps that index until `close()`.

Whichever read serves an operation, its results are those of the index, and a `Media` reads as the functions do
also once it holds its index (`readPlan()`): its results do not depend on what it read before. The functions (`convert()`, `thumbnail()`,
`frames()`, `packageMedia()`) open the input the way their operation reads it first, so that open serves the
operation, and `inspect()`, `convert()` and `check()` detect its format once (`FormatRegistry.detectFormat()`): an
image goes to its converter, a media input opens as that format. An input opened again reports to the listener only the warnings the
open did not, and `Media.warnings` holds the index's once it is read. A window reports so too, through the running
operation: what its own reads find (a configuration taken from in-band parameter sets) reaches the listener once, and
a Matroska or MPEG-TS window that finds damage holds nothing, so that the index reads and reports it.

## What an open input holds

An opened input (the `MediaFile` behind a `Media`, and the index an operation read) keeps its descriptions and index:
the tracks and their sample tables, as typed arrays. A described MP4 holds no tables until an operation builds its
index: only where they lie in the movie box and the tracks as described. A track's compact index is held by the
track itself
(`bindCompactSampleIndex`), behind its `samples` property: one pair of accessor functions serves every track, so the
copies a file makes of its reader's tracks are built in one order and share one shape. An opened input does not keep
the bytes its reads fetched. A Blob is read by one
rule (`core/io/sources/blob-source`), as each slice costs a browser request: reads asked together near each other are one
slice, a slice starts on a 64 KiB boundary and reads at least 256 KiB (back from the Blob's end) without reading held
bytes again, reads that go on forward read windows that double to 4 MiB, and the newest 8 MiB of windows are kept. A
cache reads through 64 KiB pages; a read that bypasses it takes what its pages already hold. A pass in file order starts
with the pages its first request needs, at least 256 KiB, and, while it goes on from one span into the next, reads
spans twice as long each time, up to 1 MiB; halfway through each span of 1 MiB it reads the next one ahead. A pass
that stops after a few packets (a picture from its keyframe) reads little more than they hold, and one that stops
anywhere reads at most a span and a half past where it stops. 256 KiB is a Blob's least slice: the spans doubling from it lie in
the windows the Blob reads for them, which double alike, and are views of them, where spans of other lengths would
cross windows and be copied. A pass over a Blob in whole
windows reads the next window while it uses one; its spans, its chunk scans (`ChunkReader`) and the chunks a stream or
a window demuxes (`ForwardWindows`, `WindowBytes`) are views of the windows (`registerViewReads`), which are never
rewritten, so only the packet that leaves the library is a copy. Each source
registers how it drops what it holds (`registerReleaseReads` in `core/io/sources/source-read`), and
`MediaFile.releaseReads()` drops all of it: once the input is indexed, and at the end of every `Media` operation and
of every `packets()` and `segments()` pass. The next operation reads again what it needs. Results do not change.

## How a conversion reads its input

A conversion reads each clip's input in one pass (`ClipRead` in `pipeline/transcode/shared-read`). The copies it
routes into the interleaver's lanes, the pictures the video lane decodes and the sound the audio lane decodes all take
their packets from it, and `MediaFileWriter.sharePackets()` reads, packet by packet, the earliest in decode time of
what they take next, each packet once. A lane alone is the pass of one, and so is a copy without a conversion
(`routePackets()`): packets are read for writing in one way. The pass reads on while a decoding lane has fewer than 16
packets waiting or waits for one, while the merge of the lanes waits for a copy's packet, or while no lane decodes;
otherwise it waits. Nothing is read past what the lanes take, and the read stops with them.

Where a lane does not simply follow the pass:

- A lane that goes back or skips ahead starts its reader there again, and the pass reads from there: a looped or
  replayed sound, a decoder that starts over after its fallback, FLAC reading its first frame header.
- A lane that falls behind holds at most 1024 packets or 32 MiB. The pass goes on for the other lanes and reads that
  lane's packets again once it catches up.
- Each clip and each mixed-in track has a pass of its own: two clips of one input read at the same time read it twice.
- A streamed input is copied in one pass through its stream; a conversion that decodes reads an index or a window.
- `decodeAudio()` hands its caller a source that may be read anywhere, more than once at a time: it reads packets by
  index (`readPacket()`).

## How a picture is taken

`thumbnail()` and `frames()` decode from the keyframe at or before each time asked (`pipeline/frames/frame-extract`);
the picture shown at a time is the last one that starts by it. The decoder is fed until a later picture comes out, also
for the last time asked: flushing it at the packet of the picture would change which picture some decoders give
(MPEG-4 Part 2) and the warnings of the pictures it conceals. A picture leaves as PNG through the host's canvas where
there is one and every pixel is opaque (a canvas keeps premultiplied alpha, which would change translucent pixels;
opaque ones decode the same), else through the library's encoder, byte for byte the same on every host
(`encodePng` in `codecs/image/encoders`).

## How code loads

The build groups the modules into a few chunks (`scripts/esm-chunks.mjs`). An entry loads the chunks of its static
imports. Everything else loads on demand, a family at a time:

- the engine, with what every open runs: detection, the open options, the composition of the plugins in use and their
  catalog, and the packet reads of a Media (`api/media-reads`);
- one family per main reader: MP4, Matroska, MPEG-TS, the audio files, MPEG audio;
- the AAC syntax, the conversion API with the packet copy every operation of it plans or runs, the copy of tracks, and
  the work of a conversion that decodes;
- `thumbnail()` and `frames()` (`api/picture-operations`) with the code that decodes pictures
  (`pipeline/frames/frames`), which plan no copy: they load neither the conversion API nor the conversion runner.

One rule places every module: it goes with the code that loads it, so that each common call loads the code it runs,
and nothing else, in few requests. Its data are the lists at the top of `scripts/esm-chunks.mjs`:

| List              | Holds                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHUNK_FAMILIES`  | The families above, each a chunk with what only it uses                                                                                                            |
| `READER_PARTS`    | The parts of a reader only some inputs run: fragmented or repaired MP4, Matroska metadata, compression and recovery, the FLAC, Ogg and CAF part of the audio files |
| `MAIN_READERS`    | MP4, Matroska, the audio files: what several families use goes in a chunk per set of these that use it                                                             |
| `OTHER_READERS`   | MPEG-TS, MPEG audio, AC-3/DTS/TrueHD: they name what no main reader uses                                                                                           |
| `RARE_PARTS`      | MP4 and Matroska, whose parts few inputs load: what only the parts share is kept apart                                                                             |
| `ENGINE_READERS`  | MP4 and Matroska: what both use goes with the engine                                                                                                               |
| `MAIN_WRITE`      | A copy into MP4: a shared chunk also says whether this write uses it                                                                                               |
| `WRITER_MODULE`   | The writers, which never carry a reader's code                                                                                                                     |
| `RUNTIME_ENTRIES` | The Node and Deno entries: what they share with the engine is a chunk of its own                                                                                   |

So opening a WAV file loads none of the FLAC, Ogg and CAF code, and since FLAC and Ogg are as common as WAV, what the
audio files' part shares counts as the audio files', and their open requests at most one chunk more. A family that only
another one's code loads (the Ogg reader's further streams after the audio files' part) leaves what they share to
that one.

A family is reached through a door, a tiny module that names every chunk the family imports, so a browser requests
them in one round. A chunk that loads whenever the importing one does needs no request: `api/operations` hands the
engine the packet copy it imports. A module loaded on demand that every call needs (the open options, the image
side of detection, the packet reads of a Media) is reached through one promise held for it (`loadOnce` in
`api/load-hints`), made again only after a failed load: an `import()` of a module already loaded still costs several
microseconds a call. The first `inspect()` or `open()` starts the engine and the reader together. The
reader is chosen from a Blob's type or file name at once, otherwise from the input's first bytes (`api/load-hints`),
FLAC and Ogg inputs included. Opening an MP4 in a browser therefore takes two rounds of requests after the call: the
doors, then the chunks they name. The packet reads of a Media load with the engine, so its `packets()`, `packetAt()`
and `decodeAudio()` request nothing more. An operation requests, as soon as its own code has loaded, what it runs once
the input is open (`pipeline/plan/operation-loads`): `convert()` the packet copy, the copy of tracks and the writers of
its target format, `thumbnail()` and `frames()` the code that decodes pictures and the PNG encoder. It does not wait
for the open and then the plan or the decode. The codecs load when the plan picks them (the host's or the library's),
and the copy of an input read in one pass loads its stream schedule as soon as its probe says so.

In a browser the default entry also loads that code ahead of time (`api/idle-prefetch`). Once the page is idle after
the entry has loaded, it requests the engine, the MP4, MPEG audio and Matroska readers, the metadata part of the
Matroska reader (the Tags of ffmpeg's and mkvmerge's files need it) and the AAC syntax, and the default MediaForge
sets its engine up (the composition of its plugins and the registry of readers and writers). The first call of a
typical app, which opens media after its own startup or after the user picks a file, then finds them loaded and set
up. An operation that starts before then loads only what it runs, and the prefetch is dropped, so a call made
right after the import is not slowed by it. An app that never opens media fetches about 360 kB it does not use, so
nothing loads ahead when the browser reports that the user saves data or the connection is 2G
(`navigator.connection`). The lite entry, meant for applications that count every byte, loads only on demand. A
worker that imports the default entry prefetches the same way, on purpose: it exists to process media. Outside a
browser (Node, Deno, Bun) the code comes from disk, and nothing loads ahead. `test/build/bundle.test.mjs` holds the layout and both loading
paths to this.

## Plugins and subsystems

A **plugin** is a swappable implementation behind one of the engine's contracts: a software decoder or encoder that
fills a gap in WebCodecs, a container reader or writer, or a processing stage the engine runs. The default entry
includes every plugin and loads each on first use; `plugins: { exclude }` leaves one out, and the lite entry has
none. A **subsystem** has its own lifecycle and API and is not needed by the conversion engine: it lives in its own
folder and layer and depends on the layers below it, never the reverse.

Sizes are lines of source and minified kB in the ESM build. Users are the modules outside the part that import it.

| Part                                           | Lines | kB  | Users                                 | Decision                             |
| ---------------------------------------------- | ----- | --- | ------------------------------------- | ------------------------------------ |
| H.264 decoder                                  | 11659 | 315 | plugins                               | plugin `h264` (`codecs/h264`)        |
| MPEG-1/2 video decoder                         | 2212  | 48  | plugins                               | plugin `mpeg12`                      |
| MPEG-4 Part 2 decoder                          | 5141  | 101 | plugins                               | plugin `mpeg4`                       |
| AAC: LC decoder and encoder, SBR, PS           | 6035  | 165 | audio entries, the engine's AAC paths | plugin `aac`                         |
| MPEG audio: MP1/2/3 decoder, MP2/MP3 encoder   | 5598  | 134 | audio entries, the engine's encoders  | plugin `mpegAudio`                   |
| FLAC decoder and encoder                       | 1664  | 37  | audio entries, the engine's encoders  | plugin `flac`                        |
| ALAC, Opus, Vorbis decoders                    | 7641  | 183 | plugins, the audio entry              | plugins `alac`, `opus`, `vorbis`     |
| AC-3 and E-AC-3 decoder                        | 2458  | 57  | plugins                               | plugin `ac3`                         |
| AVI, FLV, ASF, MXF, MPEG-PS, IVF               | 8788  | 208 | plugins, demux and mux entries        | six container plugins                |
| Raw IAMF and APV streams, the APV decoder      | 854   | 25  | plugins                               | plugins `iamf`, `apv`                |
| HLS and DASH playback, the HLS client          | 2651  | 67  | `play()` with the player plugin       | package mediaforgejs-player          |
| EME, ClearKey, SAMPLE-AES, HLS DRM             | 2572  | 67  | the player plugin                     | package mediaforgejs-player (`drm/`) |
| Edit projects (`edit()`, `audio.replace`)      | 1213  | 25  | `api/operations`                      | subsystem `editing/`                 |
| Recording (`encodeFrames()`, `recordStream()`) | 758   | 15  | `api/encode`                          | subsystem `recording/`               |
| Node, Bun and Deno files                       | 558   | 10  | the runtime entries                   | subsystem `runtime/`                 |
| FFmpeg process backend                         | 1374  | 27  | the runtime/ffmpeg entry              | subsystem `runtime/ffmpeg/`          |

These stay in the engine's layers because the engine itself uses them:

| Part                               | Lines | kB  | Users                                                       | Place                                        |
| ---------------------------------- | ----- | --- | ----------------------------------------------------------- | -------------------------------------------- |
| HLS and DASH packaging, live HLS   | 1720  | 38  | `pipeline/engine`                                           | `pipeline/package`                           |
| HLS and DASH manifests, CMAF, sidx | 4206  | 106 | the packagers, format detection, FFmpeg, the player package | `formats/hls`, `formats/dash`, `formats/mp4` |
| Image codecs and resizing          | 3573  | 86  | pictures and thumbnails, the stages                         | `codecs/image`                               |
| Subtitles                          | 2238  | 64  | the WebM writer, MP4 track fixes, remux plans, HLS          | `formats/text`                               |
| Metadata: ID3, emsg, track JSON    | 1262  | 34  | twelve readers and writers                                  | `formats/metadata`                           |
| The processing stages              | 1907  | 38  | fifteen engine modules                                      | `stages` (built in, same stage contract)     |

The core containers (MP4, Matroska, MPEG-TS, Ogg, the audio files, images) and codecs (PCM, G.711, raw video) are
built in: they have the reader, writer and decoder shapes of plugins but are always registered.

**The player is a package; the subsystems are not.** HLS and DASH playback lives in `packages/player`
(mediaforgejs-player), TypeScript that the main build compiles into its own `dist/` and `npm run release:pack` packs
with mediaforgejs as its peer dependency. It imports only the public entries: `mediaforgejs/plugins` (the plugin
and player contracts and `MediaForgeError`), `mediaforgejs/streaming` (playlists, MPDs, DASH segments) and the types
of `mediaforgejs`, and keeps its own small helpers (cancellation, deadlines, checked byte arrays, warnings). In the
repository it finds mediaforgejs through `packages/player/node_modules/mediaforgejs`, a link the build makes. The
subsystems (editing, recording, runtime: together about 190 kB minified, about 6% of the build) already cost the
main entries nothing, and moving one would make public internals it uses. If one moves later, the FFmpeg backend
is the best candidate: Node only, a child process, 27 kB.

## Reading and decoding audio files

The audio files (`formats/audio-files`) follow the read model of the containers: a description reads only what
states the tracks, an index holds no object per packet, and a pass reads the input once in large reads.

- **Describing.** `inspect()` asks a reader's `probe` first. MP3 (`probeRawAudio`) and FLAC (`probeFlac`) of 4 MiB
  or more are described from their header and their last frames, as MPEG-TS, Matroska and Ogg are from their ends.
  An MP3's Xing/Info or VBRI frame states the frames after it and the bytes from it on; the description stands when
  those bytes end in a run of whole frames at the end of the input or at its trailing tags (where a read of every
  frame stops), the frames at both ends share one rate and channel count, and the frames fit the bytes at the rates
  the layer allows. A FLAC's STREAMINFO states its samples; the description stands when the first frame starts the
  numbering and the last frame, whole to the end of the input with a matching CRC-16, ends at that count. The
  duration, rate, channels, gapless trim, tags and codec configuration are those of a read of every frame, through
  the same functions (`leadingTags`, `mp3Trim`, `readFlacHeader`, `flacCodecConfig`). Damage between the reads goes
  unseen there, as between the ends of a large MPEG-TS; smaller inputs, strict validation and any other layout read
  every frame, which takes a few milliseconds for 4 MiB. MP3 and FLAC have reader parts of their own (`mp3`,
  `flac`), so the formats without a description (ADTS, MP1, MP2, WAV, AIFF, AU, CAF) keep reporting `sampleCount`.
- **Positioning.** A window around a time (a `ProbeTarget` with `around` and `through`) of an Ogg input or a FLAC
  file of 4 MiB or more is found by a search over the positions the stream states, not by reading every page or
  frame: an Ogg page's granule counts the samples through its last packet, a FLAC frame header its first sample.
  `narrowToPosition` (`formats/shared/position-search`) probes 16 KiB at an offset interpolated from the positions
  found so far (the middle after two probes that each leave more than half of the span), and `bisectOggGranule`
  (`formats/ogg/positions`) and `flacWindow` take the first page or frame there whose sync, CRC and fields check.
  Positions or page numbers that fall as the offsets rise end the search. The window is read after the head (and
  for Ogg with the tail) as one input, so its packets are those of a read of every page or frame; the packets of
  the first Ogg page that completes one after the gap are left out, as that read times them from the page's granule
  in seconds. Another stream or a stream boundary on the way, a damaged window, strict validation and an ID3 tag in
  front of a FLAC read the index instead; links that share a serial, which RFC 3533 rules out, are told apart only
  where their page numbers fall. A window opens from about ten reads in a few milliseconds. The describing probe
  gives the file its `window` (`probeWindows`), so `packetAt()` opens a window from the ends and the frame
  numbering the open found, without detecting the input or reading its ends again. A window checks each page's CRC
  once: the pages of the ends (`oggStreamEnds`, 64 KiB at each end and 256 KiB when the headers or the closing
  pages need more) and those the search took are not checked again when the window is read (`checkedOggPages`).
  The head alone states the timeline (start, rate, codec delay), and a Vorbis setup header read again keeps the
  mode table parsed from it.
- **Indexing.** The readers bind compact sample indexes (`bindCompactSampleIndex`) instead of an array of sample
  objects: `AudioFrameIndex` holds MP3 and ADTS frames as offsets and sizes in typed arrays, 10 bytes a frame (a
  stream's frames all hold the same samples, so a frame's time is its position times that count over the rate,
  the same value the running sum gave); `FlacFrameIndex` holds FLAC frames in 22 bytes; `PcmPacketIndex` computes
  PCM packets from their position and holds nothing per packet. `maxIndexBytes` counts those bytes, so an
  audiobook of many hours opens within the default limit. A scan reads through `ChunkReader`, from one 64 KiB page
  where a PCM file ends at its headers, from 256 KiB where FLAC and Ogg are read whole (as a pass starts, above),
  doubling while it goes on, to 1 MiB chunks, the next while it parses one. Readers
  whose reads cover a known span (a window) read it in whole chunks. A step that changes a track's fields changes
  them in place: spreading a track into a new object reads `samples`, which builds the sample array the index
  replaces.
- **Decoding.** One decision in the router (`pipeline/codecs/router`) sends every audio track to its decoder:
  linear PCM is read, not decoded (`readsLinearPcm`), by the library without asking any decoder, as its packets are
  its samples; every other codec goes to the host AudioDecoder first when the host supports its configuration
  (unless 'builtin' is preferred) and to the library's decoder after it (`decoderOrder`), in `decodeAudio()`,
  conversions and `createAudioTrackSource()` alike. Every `AudioData` the library reads, a host decoder's output or
  one handed to `encodeFrames()`, goes through `copyAudioPlanes` (`codecs/webcodecs/audio-data`): integer samples
  are copied in their own format and scaled by a power of two, v / 2^(bits − 1), exactly as the library reads linear
  PCM, and float samples are copied as `f32-planar`. Chromium decodes FLAC to `s16` or `s32`, MP3 and MP2 to
  `s16-planar` and G.711 to `s16`, and its own conversion to float divides positive samples by 2^(bits − 1) − 1: host
  and library decoders of the same FLAC would differ, and FLAC to 16-bit WAV would move samples by one.
  `HostAudioDecoder` gathers the samples in planes of 16384 frames, handed on as they are, without a copy, when the
  next output does not fit and at a flush, so the stages after the decoder run once a block rather than once a frame. `checkedSource` checks the samples of a
  decoder's blocks for NaN and infinities in one loop without branches.
- **Encoding.** The FLAC encoder surveys each candidate subframe of a block (its channels, and of a stereo block
  mid and side) in one pass: the residual magnitudes of the fixed predictors of orders 0 to 4, the zero bits every
  sample shares, and the Welch-windowed autocorrelation (lags 0 to 8) that gives the linear predictor, whose
  residuals it then computes. A candidate's size is estimated, not counted: the linear predictor's residual coding
  over the partition orders the planner searches (up to 6), the fixed predictor's over the block, each partition
  from its residuals' zigzag sum at the best Rice parameter within one of the one the mean magnitude gives, the
  bits a shift drops taken as uniform. A stereo block takes the channel assignment whose two candidates are
  estimated smallest, and each coded subframe the predictor estimated smaller; only those two subframes are
  planned exactly, each Rice parameter from the mean magnitude by counting leading zeros. The files decode to the
  same samples; on the test corpus the estimates make them 0.002 % larger in all, and at most 0.11 % each, than
  choosing by exact counts. The MD5 of 16-bit mono and stereo audio is fed 32-bit words. The MP2 and MP3 encoders'
  analysis filterbank takes a frame of a channel per call over a history of its last 480 samples, sums each
  output's eight window taps in pairs, folds the 64 windowed values into 32 and splits the 32-point matrixing by
  its cosine symmetries (384 products instead of 2048); the MP3 MDCT folds its 36 inputs into an 18-point DCT-IV.
  The MP3 encoder quantizes a line to round(t - 0.0946), t being |x|^(3/4) over the step's 3/4 power, or one more
  when that reconstruction is nearer by more than 1e-12: the rounding is the nearest value or one below it. A
  granule's gain search gallops from the channel's last gain (steps that double until they cross the budget, then
  halving) to the smallest gain whose bits fit, then tries one gain below it and three above; the least-error
  quantization under the budget wins, so a tried gain stops at the first band whose running error passes the best
  so far. A long granule keeps its scalefactors at zero and is searched once; a short one tries both
  scalefac_scale values with up to six refinements. The frame's bit allocation finds its common gain by the same
  gallop from the last frame's. The band flatness and the bit estimate take the logarithm of products of up to 16
  factors at a time (each between 1e-12 and 1e2, or below 2^45, so a product stays a finite double). Granule
  codings, the band model and the search's kept quantizations are reused records, not objects per quantization.
  Into a container, the library's FLAC, MP3 and MP2 encoders hand the muxer each frame as they code it
  (`ContainerAudioEncoder.stream`), so a copied video lane does not wait in the interleaver for the whole sound:
  the window the muxer is told before the first packet (the priming the LAME tag states, and the declared length,
  to which the sound is completed with silence) does not depend on the end of the sound. MP2 whose frames could
  end exactly at the declared length is still encoded whole first. FLAC codes exactly the longer of the declared
  length and the source's own, whose STREAMINFO it declares before the first packet with the frame sizes and MD5
  unknown (RFC 9639 allows zero for both). The encoder's STREAMINFO follows through `setAudioCodecConfig` once the
  sound ends. A muxer that has written its header by then patches it in at `finalize()`: the Matroska
  CodecPrivate, the 'dfLa' of a fragmented MP4's init segment, or the first Ogg page with its CRC. Earlier, the
  muxer writes it into the header directly, so a sink with `patchAt` (a Blob, a file) gets the bytes of a
  whole-file encode. A sink without it keeps the declared STREAMINFO.

## Maintenance notes

The structure audit looks for folders of more than about 20 files, files of more than about 800 lines,
functions of more than about 150 lines, repeated code and stale names. What it finds and leaves, and why:

- **Folders.** `codecs/h264` holds 23 files: one decoder, whose frame worker and WebAssembly kernels the
  build wires by path (`scripts/build.mjs`, `scripts/esm-chunks.mjs`), so a subfolder would separate files
  that change together. Detection of any input is in `formats`, above every format; the byte signatures it
  reads are in `formats/detection`.
  `formats/audio-files` holds 23 files since its reader was split by input (WAV, AIFF and AU; FLAC, Ogg and
  CAF); its reader parts move into `read/` with the next split of the audio files.
- **Long files** (48). The codec bitstreams are as long as the syntax they read: the H.264 slice decoder,
  the MPEG-4 Part 2 VOP decoder, MP3, AAC (SBR, parametric stereo), Opus (SILK, CELT), AC-3 and the image
  encoders; their numeric kernels stay together for speed. The container readers and writers (MP4,
  Matroska, MPEG-TS, AVI, ASF, FLV, MXF, MPEG-PS, Ogg, the audio files) are being split into `read/` and
  `write/` parts one input shape at a time. The rest run a whole operation: the conversion timeline,
  the opened file and its remux plan, the HLS client, EME, the FFmpeg backend.
- **Long functions** (95). Factories whose inner functions share their state
  (`createHttpLicenseCallback`, `playHlsWithDrm`) would read better as classes; state machines and loops that keep their state in locals
  (`encodeMp3FrameMachine`, `writeContainer`, `HlsClient.readMedia`, `playStreams`) and parsers that
  follow a specification's syntax in its order (`parseHlsPlaylist`, `parseTtml`, `parseSliceHeader`)
  are split only where a step has a name of its own; kernels (`filterMacroblock`, the intra predictors,
  the CABAC residual) stay whole. Reader bodies are split with the readers.
- **Repeated code.** Unrolled kernel variants (H.264 CABAC, prediction, deblocking and transforms, the
  XviD IDCT, Opus bands) and code tables repeat on purpose. Each video plugin keeps its own bit reader,
  since plugin folders are private. The sinks that wrap another sink forward its methods one by one.
- **Names.** Built-in is spelled `Builtin` in every name, and the compact sample index is named for what
  it holds (`enableCompactSampleIndex`), not for the MP4 reader that had it first.

<a id="日本語"></a>

# MediaForgeJS の構成

[English](#how-mediaforgejs-is-organized) · 日本語

`src/` の地図です。フォルダーごとの担当、呼び出しの流れ、どれがプラグインでどれが独立したサブシステムかを示します。
どのモジュールが何を決めるかは、ガイドの[しくみ](README.md#ja-architecture)にある表を見てください。

## 層

モジュールは最上位フォルダーの層に属します。import（静的・動的・型のみ）は下の層か同じ層だけを指し、同じ順位の
フォルダーは互いに import しません。ビルドの最初に `scripts/layers.mjs` が確認し、`test/build/layers.test.mjs` が
その確認自体を確かめます。

| 順位 | フォルダー  | 担当                                                                           |
| ---- | ----------- | ------------------------------------------------------------------------------ |
| 0    | `core`      | エラー、バイト列、Source と Sink、トラックのモデル、コーデック設定、部品の約束 |
| 1    | `formats`   | コンテナ、マニフェスト、字幕、タグ：バイト列とトラックの相互変換               |
| 1    | `codecs`    | デコーダー、エンコーダー、WebCodecs の橋渡し                                   |
| 2    | `stages`    | 処理のステージとその実行器                                                     |
| 3    | `pipeline`  | エンジン：すべての処理の計画と実行、パッケージ化、プラグインの約束             |
| 4    | `editing`   | `edit()`：複数クリップのプロジェクトと、エンジン上での描画                     |
| 4    | `recording` | `encodeFrames()` と `recordStream()`：アプリのフレームと MediaStream の録画    |
| 4    | `runtime`   | Node・Bun・Deno のファイル、インストール済み FFmpeg のバックエンド             |
| 5    | `plugins`   | ライブラリのプラグインとその目録                                               |
| 6    | `api`       | 関数、`MediaForge` と `Media`、設定の読み取り、パッケージのエントリー          |

`editing`・`recording`・`runtime` は**サブシステム**で、変換エンジンは使いません。静的 import で届くのは
それぞれのエントリーだけです（`runtime` は `mediaforgejs/runtime/*`）。ほかのエントリーは必要になったときに読み込むので、
`mediaforgejs` と `mediaforgejs/lite` の起動時の読み込みは増えません。HLS と DASH の再生はパッケージ
`packages/player`（mediaforgejs-player）です。アプリが追加すると `play()` が使うプラグインで、mediaforgejs の公開
エントリーだけを使って書かれています。`layers.mjs` が違反で失敗し、
`test/build/bundle.test.mjs` がビルド結果を確かめます。

## 機能

層の中のコードは**機能**に分かれます。機能は使う機能を宣言し、自分のテストを持ち、変更の影響を調べる単位です。
`scripts/features.mjs` がフォルダーから読み取るので、フォルダーを作ればそれが新しい機能です：

- プラグインのフォルダー（`manifest.ts` があるもの）は機能です：`codecs/h264`、`formats/avi`。
- `core`・`formats`・`codecs`・`pipeline` では各サブフォルダーが機能で（`core/io`、`formats/mp4`、`codecs/flac`、
  `pipeline/copy`）、フォルダー直下のファイルはそのフォルダー名の機能です（`pipeline`：エンジン）。
- ほかの最上位フォルダーはそれぞれ一つの機能です：`api`、`editing`、`recording`、`runtime`、`stages`、`plugins`。
- `packages/` の各パッケージも機能です（`packages/prores`）。

各機能は使ってよい機能を `DEPENDENCIES` に並べます（`core/*` は core のすべての機能）。「使う」とは実行される
import（静的・動的）のことで、型だけの import は層の規則とコンパイラーに任せます。検査は毎回のビルドと `npm test`
（`test/build/features.test.mjs`）で走り、次のときに失敗します：

- 宣言していない機能を使う、または宣言した機能を使っていない。
- 宣言した使用関係が循環する。
- プラグインや共有の機能（`codecs/pcm`、`codecs/shared`、`formats/detection`、`formats/metadata`、
  `formats/shared`）が core と共有の機能以外を使う（どのプラグインも単独で外せるように）。
- 宣言やテストファイルのない機能がある、またはどの機能にも属さないテストファイルがある。
- パッケージが自分のファイル、自分の依存、`mediaforgejs` のエントリー以外を import する。

`node scripts/features.mjs` は地図を表示します：各機能のモジュール、テストファイル、使う機能。

テストファイルは、パスの先頭に一致する最も長い名前の機能に属します：`test/<機能>.test.mjs`、
`test/<機能>-<観点>.test.mjs`、`test/<機能>/<観点>.test.mjs`（`test/formats/mp4-read.test.mjs`、
`test/codecs/mpeg-audio-decode.test.mjs`、`test/api/convert.test.mjs`）。パッケージのテストは
`packages/<名前>/test/`、`test/build/` は道具のテストです。`npm run test:affected` は地図を逆にたどります：変わった
ファイルからその機能を求め、それを直接または間接に使う機能を壊れうるものとして、それらのテストファイルを実行します。

## フォルダーの中身

フォルダー構成は英語版の図と同じです。フォルダーの中のファイルは役割で名前を付けます：コンテナの読み手と書き手は
`reader.ts` と `writer.ts`、その部品は `read/` と `write/`、コーデックは `decoder.ts` と `encoder.ts`、定数表と共有の型は
`tables.ts` と `types.ts`。フォルダー名を繰り返さず（`formats/mp4/reader.ts`。`formats/mp4/mp4-demuxer.ts` ではない）、
ファイルがおよそ20を超えるフォルダーはサブフォルダーに分けます。

## 呼び出しの経路

呼び出しはツリーの中を次のように通ります：

| 呼び出し                           | 通る場所                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `inspect()`・`open()`              | `api/forge` → `pipeline/engine` → `pipeline/read`（判定は `formats/detect`）→ 読み手                            |
| `convert()` のコピー               | `api/target` → `pipeline/plan` → `pipeline/copy` → 書き手                                                       |
| `convert()` の再エンコード         | `pipeline/plan` → `pipeline/transcode`（クリップ → レーン）→ `pipeline/codecs` → `codecs/*`・`stages`           |
| `check()`・`onPlan`                | `pipeline/plan`、次に何も残さないシンクへ処理を実行する                                                         |
| `thumbnail()`・`frames()`・画像    | `pipeline/frames` → `pipeline/codecs` → `codecs/image`                                                          |
| `packageMedia()`                   | `pipeline/package` → `formats/mp4/write`（CMAF）・`formats/hls`・`formats/dash`                                 |
| `edit()`・`audio.replace`          | `editing/project` → `editing/render` → `pipeline/transcode`                                                     |
| `encodeFrames()`・`recordStream()` | `api/encode` → `recording` → `pipeline/codecs` の部品と書き手                                                   |
| `capabilities()`                   | `api/capabilities` → `codecs/webcodecs/support`・`formats/shared/capabilities`                                  |
| `play()`・`createPlayer()`         | `api/play` → 追加された player プラグイン（mediaforgejs-player の `hls-player`・`dash-player`・`hls-playback`） |
| `HlsClient`・`playHls()`           | mediaforgejs-player → `mediaforgejs/streaming`（プレイリスト・MPD）、`mediaforgejs/plugins`                     |

1つの処理には、それを行う別々のやり方（経路）が複数あることがあります。たとえば、入力を両端から説明して読むか索引から
読むか、MP4を一度に書くかフラグメントで書くか、です。次の表は処理ごとにすべての経路を挙げます：それを選ぶ1つの関数と
条件、その経路だけがすること、そこを通るテスト（`.test.mjs` を除いたファイルと名前）です。経路を残すのは、ほかの経路にできないことをするときか、利用者が
実際に出会う場合で測って速いときだけです。測定はNode 22で、メモリ上で作った入力に対して行い、その場合をほかの経路で
処理したときと比べています。

### 入力を開く：`inspect()`・`open()`

`FormatRegistry.open()` が読み手のprobeを実行し、probeが断ったときは入力を全体まで読みます。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 開くときに索引を作る（`Reader.read()`） | 読み手にprobeがないか、probeが断る：形式の境目より小さい入力（[入力の読み方](#入力の読み方)）、損傷、説明で位置を決められない配置 | すべての標本を読む：標本数を数え、どこの損傷も開くときに知らせる | `test/pipeline/read-probes`："inputs of every size are described as a full read describes them"、"movies a description cannot match are read whole at open" |
| 先頭と末尾から説明する（`index` のない `ProbedInput`） | 先頭と末尾が重ならないMPEG-TSとOgg。4 MiB以上のMatroska・WebM・MP3・FLACと、`mfra` のあるフラグメントMP4（各読み手のprobe） | いくつかの窓だけを読み、標本数は数えない。読んだものは後の窓（`window`）と1回の通し読み（`stream`）のために持つ。`inspect()` で測ると、10分・154 MBのMatroskaは説明で10.9 ms・3.2 MB、索引では全体を読んで114 ms。165 MBのMPEG-TSは30 msと432 ms。1時間・150 MBのフラグメントMP4は5.2 ms・0.4 MBと101 ms・7.5 MB | `test/pipeline/read-probes`："inspect() describes a large MPEG-TS from its head and tail"、"inspect() describes a large Matroska file from its head and tail"、"a fragmented MP4 with a fragment index opens from its ends"。`test/formats/audio-files-large`："is described from its Info frame, reading under 1 MiB"、"is described from STREAMINFO, reading under 1 MiB" |
| ムービーボックスから説明する（`ProbedInput.index`） | ムービーボックスが256 KiB以上でフラグメントのないMP4（`Mp4Demuxer.describe()`） | 標本表を作らずに検査し、標本数を持つ。最初の読み取りが表の位置から索引を作る（`MediaFile.probedIndex`）。1時間のMP4（ムービーボックス2.3 MB）の `inspect()` で6.0 msと10.1 ms | `test/pipeline/read-probes`："a large movie box is described, its tables built on the first read" |

### `Media.packets()`

`readPackets()`（`api/media-reads`）が選び、1回の通し読みで足りる要求かは `MediaFile.passServes()` が決めます。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 索引（`PacketSchedule`） | 索引を作った入力か索引を読み終えた入力、または範囲や `keyframesOnly` のある要求 | どの範囲も、キーフレームだけも、復号順に読む | `test/api/media`："a Media knows its format and reads its packets"。`test/pipeline/read-passes`："a failed read of the index fails that call only" |
| 1回の通し読み（`ProbedInput.stream`、`StreamSchedule`） | まだ索引を読んでいない説明した入力で、通し読みで足りる要求、通して読める読み手（MPEG-TS・Matroska・WebM。FLACは `packets()` だけ、`packetsOnly`） | 入力を1回だけ読む。索引を使うと、全体を読んで索引を作り、パケットでもう一度読む。下のコピーの測定を参照 | `test/pipeline/read-passes`："packets() of a described … is one pass with the packets of the index"、"an abort stops a pass at the next packet"。`test/formats/audio-files-large`："open() and packets() read it once, as its index gives the frames" |

### `Media.packetAt()`

`packetAt()`（`api/media-reads`）が選びます。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 索引（`MediaFile.findSample()`） | 索引を作った入力、索引を読み終えた入力、MPEG-TSの音声、またはその時刻を持つ窓がないとき | どのパケットも見つける | `test/pipeline/read-probes`："open() reads a large MPEG-TS as inspect() does and finds packets" |
| 窓のファイル（`ProbedInput.window`） | 説明した入力：開いたときの読み取りからの窓。読み手が読み取りを持たないときは、窓のprobeで入力を開き直す | その時刻のまわりのクラスター・パケット・ページだけを読む | `test/pipeline/read-windows`："Matroska: the clusters around the packet find what the index finds"、"MPEG-TS: a picture shown at the end of the head is found" |
| 窓のトラック（`ProbedInput.windowTracks`） | 窓のmoofボックスだけで解析できる、説明したフラグメントMP4（`windowPacketAt()`） | 窓をデマルチプレクスせず、moofボックスを解析してパケット1つのバイトだけを読む。1時間・150 MBのフラグメントMP4で20回探すと、2回目からは1回0.1〜0.2 ms（窓のファイルでは0.5〜0.6 ms）。CPUは3〜10 msと14〜19 ms、読むバイトは1.9 MBと3.9 MB | `test/pipeline/read-probes`："a fragmented MP4 with a fragment index opens from its ends" |

### `Media.segments()`

経路は1つです：索引から `MediaFileWriter.iterateSegments()` を通ります。テストは `test/api/media`："segments start with the
init segment and come again the same"。

### `convert()` のコピー：何を読むか

`convert()`（`api/operations` の `copiesInOnePass()`）と `MediaFileWriter.routePackets()` が選びます。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 索引（ルート1つの `sharePackets()`） | 索引を作った入力、読み手が通して読まない説明した入力（MP4・Ogg・MP3・FLAC）、トラック全体の符号化した標本を数える音声のコピー | どの入力のどの範囲もコピーする | `test/pipeline/copy-passes`："a copy that trims Opus by its pre-skip reads the index first"。`test/pipeline/copy*` のコピーのテスト |
| 1回の通し読み（`streamedPackets()`） | 両端から説明し、読み手が通して読める入力（MPEG-TS・Matroska・WebM）の全体のコピー | 入力を2回でなく1回読む。MP4へのコピーで測ると、165 MBのMPEG-TSは516 ms・171 MB、先に索引を読むと673 ms・331 MB。154 MBのMatroskaは308 ms・157 MBと318 ms・307 MB。ディスクやネットワークでは時間が読むバイトに従う | `test/pipeline/copy-passes`："a large MPEG-TS copies in one pass, and a trim reads its window"、"a large Matroska copies in one pass, and a trim reads its window"。`test/pipeline/read-passes`："copies as an indexed copy does" |
| 範囲の窓（`range` の `ProbedInput.window`） | 両端から説明した入力の範囲のコピー | 範囲のまわりの窓だけを読む | 同じ `test/pipeline/copy-passes` の2つ。`test/pipeline/read-probes`："a WebM range with Opus is copied from a window around it"、"a Matroska copy in windows keeps a track absent from the middle" |

### `convert()` のコピー：どう書くか

ライターは `MediaFileWriter.copyFormat()` と `copyWriter()` が選び、`check()` とコピーで同じです。入れ物をどう書くかは
`containerLayout()`（`formats/shared/capabilities`）が選び、コピー・変換・エンコードで同じです。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 音声ファイルのライター | 音声トラック1つの、音声ファイルの出力（AAC、MP1〜MP3、WAV、AIFF、AU、CAF、FLAC、Ogg） | ストリームをファイルのヘッダーとともに書く | `test/formats/audio-files-pcm`："… copies its codes into WAV, AIFF, AU, CAF, MOV and MKV"。`test/support/matrix`：write/wav、write/flac など |
| フラグメントMP4（`iterateSegments()`） | `fmp4` の出力。フラグメントだけが運べるトラックのMP4・M4A・M4Vへのコピー（`resolveRemuxFormat()`）。1回の通し読みで読む入力の、書き戻せないシンクへのMP4のコピー（`MP4_FRAGMENTED` で警告） | 読みながら書き、何も書き戻さない。フラグメントだけが運べるコーデックを運ぶ | `test/pipeline/copy`："a fragmented MP4 copy reports progress for every packet"。`test/pipeline/copy-checks`："an MP4 copy of a track only fragments carry is written as fragmented MP4"。`test/pipeline/copy-passes`："a sink that cannot be patched gets fragmented MP4, not a second read" |
| 1回で書く入れ物（`prepareContainer()`） | 書き戻せるシンク、またはMP4の仲間以外の出力。MP4とAVIは一度に書く。Matroskaは書きながら出すが、同じ種類のトラックが複数あるか字幕があるときは一度に書き、書き戻せるシンクならCuesと大きさも書く | 入れ物の標準の配置で書く | `test/pipeline/copy*` のコピーのテスト。`test/api/convert-sinks`："a forward-only sink gets Matroska of two tracks cluster by cluster" |
| 2回で書くMP4（`PatchRecorder`、`replayPatches()`） | 索引か窓から、書き戻せないシンクへのMP4の仲間のコピー | ペイロードを抱えずに、前にしか進めないシンクへ標準のMP4を書く。1回目でヘッダーの書き戻しを記録し、2回目で書きながらそれを入れる | `test/api/convert-sinks`："a forward-only sink gets MP4 and MOV while the input is read, past 4 GiB" |

コピーの `check()` は、検査用のシンクへコピーを実行します（`validateRemux()`）。計画（`onPlan`、`Engine.plan()`）は
パケットを読まずにライターを用意します（`checkRemux()`）。どちらもライターを `copyWriter()` から受け取ります。

### `packageMedia()`

読み方は `packageMedia()`（`api/operations` の `packagesInOnePass()`）が選び、出力は対象の入れ物と `demuxed` で選びます
（`packageSegments()`）。

| 経路 | 選ばれるとき | その経路だけがすること | テスト |
| ---- | ------------ | ---------------------- | ------ |
| 索引から（`borrowedPackets()`） | 索引を作った入力、またはprobeの先頭にパケットのないトラックを含むとき | すべてのトラックを索引で時刻付けする | `test/pipeline/package-hls`、`test/pipeline/package-dash` |
| 1回の通し読み（`ProbedInput.stream`） | 先頭がパッケージ化するすべてのトラックを時刻付けする、説明した入力 | コピーと同じく入力を1回だけ読む | `test/pipeline/read-passes`："packages in one read the files an indexed package writes" |
| CMAFのセグメント（`cmafOutput()`） | フラグメントのHLS、DASH、`hls+dash`。多重化するか、トラックごとに1つの表現（`demuxed`） | 初期化セグメントとメディアセグメントを書き、それぞれを自分のトラックのキーフレームで切る | `test/pipeline/package-hls`："come as the init segment, the segments and both playlists"、"give the video and the audio their own init, segments and playlist" |
| MPEG-TSのセグメント（`transportOutput()`） | `container: 'ts'` のHLS | 番組の表から始まるトランスポートストリームのセグメントを書く | `test/pipeline/package-hls`："each start with the PAT and hold whole transport packets" |

HLSの字幕は、テキストトラックごとの `packets()` から読んだWebVTTのレンディションになります。ライブのHLS
（`packageHlsLive()`）は `Media.segments()` が渡すものをパッケージ化します。

### `encodeMp3()`・`encodeMp2()`・`encodeFlac()`・`encodeAacLc()`

経路は1つです。`api/audio-encoders` が平面を8192フレームずつライブラリのストリーミングのエンコーダーに渡します。変換がライブラリの
エンコーダーにPCMのかたまりを渡すのと同じです。立ち上がりの比べ方はMP3のエンコーダーが選びます。

| 経路                                    | 選ばれるとき                          | その経路だけがすること                                                   | テスト                                                                                                           |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ストリーミングのエンコーダー            | いつも                                | 符号化。変換のライブラリのエンコーダーと同じ                             | `test/codecs/mpeg-audio-encode` 「frames short inputs into whole frames」、`test/codecs/flac`、`test/codecs/aac` |
| 入力全体によるMP3のブロックの種類       | `encodeMp3()`：入力全体がわかっている | 立ち上がりを入力全体の高域のエネルギーの平均（`slotEnergyMean`）と比べる | `test/codecs/mpeg-audio-encode` 「a whole-file encode weighs attacks against the whole input」                   |
| それまでの平均によるMP3のブロックの種類 | MP3への変換：入力が流れてくる         | 立ち上がりをそれまでに読んだエネルギーと比べる                           | `test/pipeline/transcode-audio` 「MP3 decodes to the length of its source: the LAME gapless trim」               |

### `decodeMp3()`・`decodeFlac()`・`decodeAacFrames()`・`decodeG711()`

経路はそれぞれ1つで、選ぶものはありません。変換が使うフレームのデコーダーを入力全体に使います。

| 経路                             | 選ばれるとき | その経路だけがすること                                                                                                                                                                  | テスト                                                                                    |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 入力全体へのフレームのデコーダー | いつも       | `decodeMp3()` と `decodeFlac()` は自分でフレームを探す（`codecs` は読み手より下の層）。`StreamingMp3Decoder`・`decodeFlacFrame()`・`AacLcDecoder` は同じデコーダーを1フレームずつ使う形 | `test/codecs/mpeg-audio-decode`、`test/codecs/flac`、`test/codecs/aac`、`test/codecs/pcm` |

### トラックの音声の復号（`createAudioTrackSource()`・`decodeAudio()`・変換）

実行環境とライブラリのどちらのデコーダーかはパイプラインが選びます（`pipeline/codecs/audio-track-decoder`）。ストリームの形が変わる
ところでは、デコーダーが2つの規則のどちらかで復号した音をトラックの形にします。

| 経路                                                   | 選ばれるとき                                                   | その経路だけがすること                                                                                                    | テスト                                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `downmixChannels()`（`codecs/pcm/audio-buffer-tools`） | 実行環境のデコーダーかMPEG音声の区間の平面の数がトラックと違う | `mixWeights()` でまとめ、各出力を重みの和に合わせる（モノラルはステレオのまとめの平均）。またはモノラルを前の左右に広げる | `test/codecs/webcodecs-audio`、`test/codecs/mpeg-audio-decode` 「stereo frames in a mono track become the mean of their sides」 |
| AC-3のスピーカーの組み立て（`codecs/ac3/decoder`）     | AC-3・E-AC-3のアクセスユニットにトラックにないスピーカーがある | 独立と従属のサブストリームのスピーカーを組み立て、ほかを `speakerFold()` で重みの和に合わせずに加える（ffmpegと同じ）     | `test/codecs/ac3`                                                                                                               |

### レートやチャンネル数の違うPCM（`normalizePcmSource()`・`remix()`・リサンプリング）

経路は1つ、`StreamingPcmTransformer`（`codecs/pcm/streaming-pcm`）で、選ぶものはありません。

| 経路                      | 選ばれるとき | その経路だけがすること                                                                               | テスト                                 |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `StreamingPcmTransformer` | いつも       | 同じ形の平面はそのまま通し、チャンネルは `downmixChannels()`、レートは `StreamingResampler` で変える | `test/codecs/pcm`、`test/stages/audio` |

### 書き出すPCMの標本（WAV・AIFF・AU・CAF、MP4・MOV・MatroskaのPCMトラック）

経路は1つ、`encodePcm()`（`codecs/pcm/encoder`）で、選ぶものはありません。整数はライブラリーの1つの量子化の
規則 `quantizeSample()`（`core/model/pcm-quantize`）に従い、WAVとAVIのライターの平面の入力とG.711の
エンコーダーも同じ規則を使います。

| 経路          | 選ばれるとき    | その経路だけがすること                                                                      | テスト                                             |
| ------------- | --------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `encodePcm()` | PCMの出力すべて | 16・24ビットの整数（0.5を切り上げて丸める）か32ビットの浮動小数を、どちらのバイト順でも書く | `test/codecs/pcm`、`test/pipeline/transcode-audio` |

### 音声のステージ（`stageAudio()`・`audio.stages`・`remix()`・編集のクリップの速さ）

経路は1つ、`chainedPcmSource()`（`stages/chain`）で、音源の上の `AudioStageChain` を動かします。ステージを読み直すかどうかは呼び出し側が選びます。

| 経路                                    | 選ばれるとき             | その経路だけがすること                                    | テスト                                                                |
| --------------------------------------- | ------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------- |
| 読み直すステージ（`stagedPcmSource()`） | 変換のステージを通した音 | 読むたびに新しいステージを作って最初から動かす            | `test/stages/chain` 「every replay runs fresh stages from the start」 |
| 呼び出し側のステージ（`stageAudio()`）  | `mediaforgejs/parts`     | 呼び出しのときに構成した呼び出し側のステージで1回だけ読む | `test/stages/chain` 「staged sound is read once」、`test/api/parts`   |

### `picture.rgba()`（`frames()` のデータ、ステージが受け取る画像も）

`Picture`（`stages/picture`）が、画素を持つものごとに選びます。

| 経路                               | 選ばれるとき                                     | その経路だけがすること                        | テスト                                        |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------- | --------------------------------------------- |
| そのまま                           | RGBAの画像（`createPicture()`、CPUの変形）       | 変換しない                                    | `test/stages/picture`                         |
| `planarToRgba()`                   | 組み込みのデコーダーの平面                       | 見える範囲を、記述された行列と範囲で変換する  | `test/stages/picture`、`test/pipeline/frames` |
| キャンバスの読み戻し               | 変形のステージが描いたばかりの実行環境のフレーム | 描き直さずに描いたキャンバスを読む            | `test/stages/transform-browser`               |
| 共有のキャンバス（`canvasRgba()`） | OffscreenCanvasのある実行環境のフレーム          | HDRや広色域をsRGBに色管理する                 | `test/pipeline/frames-browser`                |
| `copyTo()` と `planarToRgba()`     | OffscreenCanvasのない実行環境のフレーム          | キャンバスのない環境で画素を得るただ1つの方法 | `test/stages/picture`                         |

### 変形のステージ（`transformStage()`：切り抜き・回転・反転・拡大縮小・余白・重ねる描画とフェード）

`transformStage()`（`stages/video`）が画像と幾何で選びます。4:2:2・4:4:4のフレームをRGBにする判定は `needsRgb()`（`stages/frame-transform`）だけが持ちます。

| 経路                         | 選ばれるとき                                                               | その経路だけがすること                                                    | テスト                          |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| そのまま通す                 | 何もしない幾何で、エンコーダーが受け取る形式のフレーム                     | 写さない                                                                  | `test/stages/video`             |
| 見える範囲での切り抜き       | 実行環境のフレームの、色差の格子に合った切り抜き                           | 写さずに切り抜く                                                          | `test/stages/transform-browser` |
| 平面の向き変え（`orient()`） | 4:2:0の実行環境のフレームの回転・反転・色差の格子に合った切り抜き          | フレームの色とビット深度（HDR）を保つ                                     | `test/stages/transform-browser` |
| キャンバスに描く             | 実行環境のフレームのほかの幾何か描画があり、OffscreenCanvasがある          | GPUで色管理して描く                                                       | `test/stages/transform-browser` |
| 描画のある平面               | 組み込みのデコーダーの平面に描画がある                                     | 描画にはキャンバスがいるので、平面を実行環境のフレームに包む              | `test/stages/transform-browser` |
| CPUの変形                    | 組み込みのデコーダーの平面かRGBA、またはキャンバスのない実行環境のフレーム | 範囲だけを変換し（`planarToRgba()`）、変形する（`transformRgbaRegion()`） | `test/stages/transform`         |

### 画像のエンコーダー（`encodePng()`・`encodeJpeg()`・`encodeWebP()`・`encodeBmp()`・`encodeTiff()`・`encodeIco()`、アニメーションのエンコーダー）

各エンコーダー（`codecs/image/encoders`）が自分の経路を選びます。

| 経路                            | 選ばれるとき                                                         | その経路だけがすること                                                                                              | テスト                      |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 実行環境のPNG                   | 不透明な画像の `encodePng()` で、OffscreenCanvasが描ける             | 速い（Chromiumで計測）：1920×1080で95ミリ秒（ライブラリは342）、640×360で16ミリ秒（46）。ファイルは2.1〜2.8倍大きい | `test/codecs/image-browser` |
| ライブラリのPNG                 | 半透明の画像、キャンバスがない、キャンバスが失敗した、APNGのフレーム | アルファが正確（キャンバスは乗算済みにする）で、どの環境でも同じバイト                                              | `test/codecs/image`         |
| 実行環境のJPEG・WebP            | `encodeJpeg()`・`encodeWebP()`・アニメーションWebPのフレーム         | ただ1つのJPEG・WebPのエンコーダー（キャンバスがなければENCODE）                                                     | `test/codecs/image-browser` |
| ライブラリのBMP・TIFF・ICO・GIF | いつも                                                               | これらの形式のただ1つのエンコーダー。ICOはLanczosで縮める                                                           | `test/codecs/image`         |

### 画像のデコーダー（`decodeStillWebp()`・`decodeAnimatedWebp()`・`decodeVp8l()`、画像の変換の入力）

`decodeStillWebp()` はWebPの符号化で選び、ほかの形式はパイプラインが選びます。

| 経路                                                 | 選ばれるとき                                  | その経路だけがすること                     | テスト                      |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------ | --------------------------- |
| ライブラリのPNG・VP8L・GIF・APNG・基本的なTIFF       | PNG、可逆のWebP、GIF、APNG、読めるTIFF        | 実行環境なしで復号する                     | `test/codecs/image`         |
| 実行環境の `createImageBitmap`                       | 非可逆のWebP（VP8）                           | ただ1つのVP8のデコーダー                   | `test/codecs/image-browser` |
| 実行環境の `ImageDecoder`（`decodeImageWithHost()`） | ほかの形式のアニメーションのフレーム          | ライブラリにデコーダーのないフレームを読む | `test/codecs/image-browser` |

### `RgbaResizer` と画像の拡大縮小

`RgbaResizer`（`codecs/image/rgba-resize`）は方法と向きで、`CanvasImageRenderer`（`codecs/image/canvas-resize`）は実行環境のキャンバスで
選びます。`resize()` と `resizeAsync()` は同じコードを動かし、後者は8ミリ秒ごとに処理を譲り、シグナルで止まります。

| 経路                    | 選ばれるとき                                                        | その経路だけがすること                                                   | テスト                                                                            |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 最近傍、2点のバイリニア | 'nearest'、拡大の 'bilinear'                                        | 1画素に元の1点か4点を使う                                                | `test/codecs/image` 「enlarging interpolates between two samples」                |
| 分離型のフィルター      | 'lanczos3'、縮小の 'bilinear'                                       | 各画素の下の元の面積全体を平均する                                       | `test/codecs/image` 「shrinking averages the whole source area under each pixel」 |
| キャンバスに描く        | 画像の変換での拡大（バイリニアか最近傍）で、OffscreenCanvasが描ける | 速い（Chromiumで計測）：640×360から1920×1080が16ミリ秒（ライブラリは90） | `test/codecs/image-browser`                                                       |

このラウンドの前と後の経路の数：ソースの上の音声のステージは2から1（`stageAudio()` はチェーンを回すループを別に持っていた）。復号した区間の
形は3から2（MPEG音声はチャンネルを平均する処理を別に持っていたが、その1・2チャンネルでは `downmixChannels()` と同じ標本になる）。
PCMの標本の書き方は2から1（PCMトラックの `encodePcm16()` が音声ファイルのものと別にあった）。16ビットの書き方の、実行環境のバイト順で
書くもう1つのループもなくした（Nodeで48 kHzステレオ10秒あたり1ミリ秒以内の差）。ステレオにまとめる重みと4:2:2・4:4:4の判定は、2か所と
3か所でなく、それぞれ1か所（`mixWeights()`・`needsRgb()`）が持つ。ほかの表は今の数のとおり。

### convert() と check()

`resolveTarget()`（`api/target`）が `targetClassOf()` でターゲットの種類を決め、`prepareConversion()`
（`pipeline/plan/conversion`）がコンテナーと音声ファイルのターゲットの経路を選びます。`check()` は選んだ経路を
何も残さないシンク（`createValidationSink()`）へ実行します。

| 経路             | 選ばれるとき                                                                                                                                                                                       | その経路だけがすること                                                                                                   | テスト                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| コピー           | 選んだトラックがすべて入るコンテナーのターゲット（`copyOrReencode()`）、設定がなく形式がコーデックを運ぶ音声のターゲット（`audioCopy()`）、計画がすべてのトラックをコピーする変換（ランナーのコピー。計画の回転を保つ） | 入力のパケットを書く。デコーダーもエンコーダーも使わない                                                                 | `test/pipeline/plan`・`test/api/convert`・`test/api/targets`             |
| 再エンコード     | 設定のある、`copy: false` の、または入らないトラックのあるコンテナーのターゲット                                                                                                                 | 1クリップのタイムラインで復号し、ステージを通し、符号化する（下のレーン）                                                | `test/pipeline/transcode`・`test/pipeline/plan-decisions`・`test/api/convert` |
| 音声ファイル     | 設定のある、または形式がコーデックを運ばない音声のターゲット（wav・aiff・au・caf・flac・aac・mp2・mp3）                                                                                           | 1つのトラックの音を出力のレートの標本で切り、入力のタグとともに音声ファイルの書き手で書く（`audio-plan`・`audio-file-writer`） | `test/pipeline/transcode-audio`・`test/pipeline/transcode-precision`      |
| 絵               | メディアの入力の png・jpeg・webp のターゲット                                                                                                                                                    | `start` に見える絵を thumbnail() と同じく取る（`takePicture()`）                                                         | `test/pipeline/frames-images`                                             |
| アニメーション   | メディアの入力の gif・apng のターゲット                                                                                                                                                          | `start` から `end` までの絵を `fps` で frames() から取る                                                                  | `test/pipeline/frames-animations`                                         |
| 静止画           | 画像の入力の画像のターゲット                                                                                                                                                                     | 1枚の絵を復号し、大きさを変え、符号化する（`ImageConverter`）                                                            | `test/pipeline/frames-images`                                             |

音声ファイルの経路は、タイムラインの音声ファイル（音声のターゲットへの edit()）と別に残ります。1つのトラックを
出力のレートの標本で切って入力のタグを保つのに対し、編集はクリップをその時刻で置いて混ぜるからです。どちらも
1つの `AudioFileWriter` で書きます。

静止画は1つの規則（`ImageConverter.convertImage()`、ルーターと同じ）で復号します。ベースラインTIFFと
ロスレスWebPはどの実行環境でもライブラリーが、ほかの静止画は実行環境に `createImageBitmap`（AVIF・
HEIF・JPEG XLには `ImageDecoder` も）があればそれが、なければライブラリーが復号します。ライブラリーは
PNG（`decodePng()`：どの色の種類・深さも、Adam7も）とGIFの最初の絵を復号し、ほかは DECODE で拒みます。
実行環境のキャンバスだけが書く出力（`HOST_ONLY_IMAGE_FORMATS`）は、何も復号する前に
`assertPictureEncoder()`（`pipeline/frames/picture-encoder`）が ENCODE で拒みます。画像、動画からの絵、サムネイルの
どれでも同じです。`capabilities()` も同じ規則で形式を宣言します：ライブラリーが復号する・書く形式は
いつも、実行環境のものは1度の問い合わせ（`codecs/image/host-formats`）で見つかったところで。テスト：
`test/pipeline/frames-images`・`test/formats/images`。

### 再エンコードのレーン

変換は1クリップのタイムライン（`conversionJob()`）として、編集はそのクリップのタイムラインとして動きます。
出力に入るトラックはコピーのレーンになり、ほかの復号と符号化は表の関数が選びます。

| 経路                                       | 選ばれるとき                                                                                                                                                       | その経路だけがすること                                                                   | テスト                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 映像の復号：ホスト／ライブラリー           | `chooseVideoDecoder()`：ホストのVideoDecoderが構成を受けるとき。ただし `codecPreference: 'builtin'` でライブラリーが復号できるときを除く                           | ホストの復号（ハードウェア）／WebCodecsなしの復号                                         | `test/pipeline/transcode-video`・`test/pipeline/transcode-browser`        |
| 映像の符号化：プラグイン／ホスト           | `openVideoEncoder()`：コーデックを書くプラグインのエンコーダー（`encodeWith`）、なければホストのVideoEncoder                                                        | ホストが符号化しないコーデック（ProRes）／ホストの符号化                                  | `test/pipeline/codecs-application`・`test/pipeline/transcode-browser`     |
| 音の復号：リニアPCM／ホスト／ライブラリー  | `readsLinearPcm()`、次に `decoderOrder()`：ライブラリーを選ばない限りホストが先。失敗したらもう一方が引き継ぐ（AUDIO_DECODER_FALLBACK）                            | デコーダーなしで標本を読む／ホストの復号／WebCodecsなしの復号                             | `test/pipeline/codecs-audio-decoders`・`test/pipeline/codecs-router`      |
| 音の符号化：ホスト                         | `audioEncoderOrder()`：ホストが先。ただしPCM・G.711・MP2・MP3・24ビットのFLACとbuiltinの選択を除く。失敗したホストの音は `streamHostAudio()` がライブラリーに渡す（AUDIO_ENCODER_FALLBACK） | ホストの符号化（Opus・AACなど）                                                          | `test/pipeline/codecs-audio-encoders`・`test/pipeline/transcode-precision` |
| 音の符号化：PCM・G.711                     | コーデック                                                                                                                                                         | 標本のパケット                                                                           | `test/pipeline/codecs-audio-encoders`                                     |
| 音の符号化：AAC-LC                         | `builtinAudioEncoding()`：'aac'（aacプラグイン）                                                                                                                   | ホストのエンコーダーなしのAAC                                                            | `test/pipeline/codecs-audio-encoders`                                     |
| 音の符号化：FLAC・MP2・MP3                 | `builtinAudioEncoding()`：'container'。長さを示すかどうか                                                                                                          | 窓を最初のパケットの前（長さを示すとき）か終わり（ライブの音）に宣言する                   | `test/pipeline/codecs-audio-encoders`                                     |

ホストが符号化できないコーデックは、変換・編集・録画とも1つの規則（`pipeline/plan/codec-choice` の
`encodableVideoCodec()`・`encodableAudioCodec()`）で置き換え、CODEC_SUBSTITUTEDで知らせます。strictの
オプション方針では求めたコーデックのままです。

### thumbnail() と frames()

経路は `extractFrames()`（`pipeline/frames/frame-extract`）の1つです。トラックのコーデックを復号するアプリ
ケーションのコーデックがあれば変換と同じくそれが（`openClipDecoder()`）、なければ `chooseVideoDecoder()` が
デコーダーを、絵を符号化できるかは `assertPictureEncoder()`（`pipeline/frames/picture-encoder`）が決めます。

| 経路               | 選ばれるとき                                       | その経路だけがすること                                                                                                         | テスト                                                       |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| フレーム           | frames()・thumbnail()・絵とアニメーションのターゲット | 各時刻の前のキーフレームから、索引から、1回の走査で読む入力では先を読んで（`StreamedFrames`）復号する。RGBAかVideoFrame       | `test/pipeline/frames`・`test/api/frames`                    |
| PNG／JPEG・WebP    | 絵の形式                                           | PNGをどこでも（すべての画素が不透明ならホストのキャンバスで）／OffscreenCanvasで                                                | `test/pipeline/frames-images`・`test/pipeline/frames-browser` |

### edit()

`runEdit()`（`editing/render`）がターゲットの種類で選びます。`audio.replace` の `convert()` は音を消した
1クリップの編集です。

| 経路           | 選ばれるとき               | その経路だけがすること                                                                 | テスト          |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------- | --------------- |
| コンテナー     | コンテナーのターゲット     | タイムラインのクリップ。どのクリップのパケットも入ればコピーのレーン、ほかは上のレーン   | `test/editing`  |
| 音声ファイル   | 音声のターゲット           | クリップの音を混ぜて音声ファイルの書き手へ（`writeAudioFile()`）                       | `test/editing`  |

### encodeFrames() と recordStream()

経路は `encodeStreams()`（`recording/encode-frames`）の1つです。絵はホストのVideoEncoderで、音はマクサーの
encodeAudio() で符号化し、MediaStreamからの受け取り方は `captureStream()` が選びます。

| 経路                          | 選ばれるとき                                       | その経路だけがすること                                                            | テスト                            |
| ----------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| フレームとブロック            | encodeFrames()                                     | アプリケーションのVideoFrameとAudioData                                           | `test/recording-encode-frames`    |
| トラックのプロセッサー        | recordStream()。MediaStreamTrackProcessorがある    | ブラウザーが渡すとおりのストリームのフレームと音                                  | `test/recording-encode-frames`    |
| video要素・AudioContext       | プロセッサーのない recordStream()                  | video要素から描いたフレーム（`elementFrames()`）、AudioContextからの音            | `test/recording-encode-frames`    |

### 部品

部品はタイムライン自身の選び方を渡したものです。`decodeAudio()` は音のレーンと同じく復号し、
`createVideoDecoder()` と `createVideoEncoder()` は `chooseVideoDecoder()` と `openVideoEncoder()` で選び、
マクサーの `encodeAudio()` は音のレーンと同じく符号化します。`decodeAudio()` はトラックが表示する標本数を示すので、
`encodeAudio()` は長さを先に宣言します（テスト：`test/api/parts`・`test/pipeline/codecs-audio-encoders`）。

### play() と createPlayer()（mediaforgejs-player）

どのストリームも1つのMSEの中心、`playStreams()`（`hls-playback`）で、ストリームごとに1つのSourceBufferで
再生します。URLのプロトコルのプレーヤーがストリームを選び、画質を切り替えないときに再生するものは
`playable` と、support の `highestOf()`・`playableOf()` が選びます。テストは `packages/player/test` にあります。

| 経路                      | 選ばれるとき                                             | その経路だけがすること                                                                                                     | テスト                                                    |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| HLSのメディアプレイリスト | URLがメディアプレイリスト                                | その単位を再生する                                                                                                         | `hls-playback`・`play`                                    |
| HLSのマルチバリアント     | `adaptive` のないマルチバリアントのプレイリスト          | `HlsClient` が読み込むときに選ぶバリアント（`client.variant`：ブラウザーが再生できるうち帯域がいちばん高いもの）            | `play`・`hls-alternate-renditions`                        |
| HLSの画質の切り替え       | `adaptive: true`                                         | 測った帯域で切り替える。AUDIO・SUBTITLESのグループをまたぎ、`changeType()` があれば（`changesCodecs()`）コーデックの違うものにも | `hls-adaptive-vod`・`hls-adaptive-live`・`hls-adaptive-parts` |
| 音声のレンディション      | バリアントのAUDIOレンディションが自分のプレイリストを持つ | 2つ目のSourceBuffer。バリアントに追従する（`AudioRenditionFeed`）                                                           | `hls-alternate-renditions`                                |
| 字幕                      | SUBTITLESレンディションと `media.addTextTrack`           | WebVTTのキューのテキストトラック。バリアントに追従する（`SubtitleTracks`）                                                 | `hls-alternate-renditions`                                |
| 保護されたHLS             | `drm`                                                    | AES-128・SAMPLE-AES・EME（`playStreamsWithDrm()`）                                                                         | `hls-drm`・`sample-aes`・`clear-key`・`eme-lifecycle`     |
| DASH                      | MPD                                                      | 最初のピリオドの映像と音声のセットを、それぞれ再生できるうち帯域がいちばん高いリプレゼンテーションで                        | `play`・`play-browser`                                    |

### runtime

実行環境ごとのファイルと `FFmpegBackend` は、それぞれの実行環境の経路で、アプリケーションが読み込む入口で
選ばれます。

| 経路               | 選ばれるとき                                    | その経路だけがすること                                       | テスト                  |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------ | ----------------------- |
| Node・Bun・Deno    | `mediaforgejs/runtime/node`・`bun`・`deno`      | 実行環境のAPIでのファイルとパス（`runtime/file-io`）          | `test/runtime`          |
| FFmpeg             | `FFmpegBackend`                                 | インストールされたFFmpegで調べ・コピーし・変換する           | `test/runtime-ffmpeg`   |

## 入力の読み方

規則はすべての形式で1つです。開くときは入力を説明し、索引は処理が初めて必要としたときに作ります。`open()` は
`inspect()` と同じところを読み、標本ごとのものは読みません。リーダーは、説明するほうが索引を作るより少ない仕事で同じ
結果になるときは入力を説明します（`probedInput` の `MediaFile`）。説明が入力全体を読んだ結果と違いうるところ（損傷、
位置を決められない配置）ではプローブが断り、開くときに索引を作ります。形式ごとの境目はこの規則から決まります。

- フラグメントのないMP4は、ムービーボックスが256 KiB以上のとき説明します。ムービーボックスはどちらでも全体を読み、
  標本表は索引と同じく検査しますが作りません（`describeClassicSamples`）。それより小さいものの表は、説明で省ける
  時間より短く作れ、最初のパケットがムービーボックスを読み直すことになるからです。読むと警告が出るムービーや、
  説明では読んだ結果に合わせられないムービー（標本記述が2つ以上、チャプタートラック、メディアをつなぎ替える
  編集リスト、メディアの外の標本、標本を変える修正）は、開くときに索引を作ります。トラックは標本数を持ち
  （`ProbedInput.counted`）、索引は表の位置から、ムービーボックスを読み直して作ります（`ProbedInput.index`）。
- 4 MiB以上でフラグメント索引（最後のボックス `mfro` が末尾に置く `mfra`）のあるフラグメントMP4は、ムービーボックス、
  その索引、最初と最後のフラグメントから説明します（`formats/mp4/read/fragment-probe`）。その読み取りは両端の32 KiB
  から4倍ずつ広がるので、それより小さい入力では、索引を作るすべての `moof` のヘッダーの走査とほぼ同じだけ読むことに
  なるからです。索引のないものはすべての `moof` を読みます。
- MPEG-TS・Matroska・WebM・Oggは、先頭と末尾が重ならないとき（Matroska・WebMは2 MiBの窓2つ分の4 MiBから）に先頭と
  末尾から説明します。それより小さい入力はその読み取りで全体を読むことになるからです。Matroska・WebMの末尾は、Cuesが
  示す最後のクラスターからで、そこにブロックのあるトラックはそこで終わります。それより前に終わるトラックがあれば、
  末尾からの距離を4倍ずつ（最後は以前と同じ32 MiBまで）広げた位置の前のクラスターから読みます。
- MP3とFLACは4 MiBから、ヘッダーと最後のフレームから説明します。それより小さいものは数ミリ秒で全体を読め、どこの
  損傷も知らせます。

パケットは時刻で探します。`Media.packets()` は復号順に返し、`Media.packetAt(trackId, time)` は提示時刻で1つ探します。
標本の番号は利用者のコードに渡さず、`sampleCount` を返すのは `inspect()` だけです。

そのあと各処理は必要なところを読みます（`api/read-probes`・`api/media-reads`・`api/operations`・
`api/picture-operations`）。

- 先頭と末尾だけを読んだ入力を通して読む処理（コピー、パッケージ、時刻が増えていく `frames()`）は、入力を
  ストリームとして開き直し、ファイル順に1回だけ読みます。標本は索引と同じく時刻付けし、索引が後ろの標本から決めるもの
  （長さのないMatroskaの音声が次のフレームまで続く長さ（`DurationFiller`）、並べ替えのある絵、Vorbisのブロックの大きさ）を
  通し読みの区切りから次の区切りへ持ち越します。
- 範囲や1枚の絵、時刻で探すパケットは、そのまわりの窓を読みます。窓の位置はリーダーが開いたときに読んだ先頭と末尾から
  決め（`ProbedInput.window()`）、窓にパケットがなければ `packetAt()` は索引を読みます。パケットやコピーが書く範囲の窓は、
  Matroskaの並べ替えのある映像を索引と同じく各トラックの最初の絵で時刻付けし（`ReorderClock`）、その絵は先頭が持つか、
  最初のその窓の前に一度だけ読みます。時刻のまわり（パケットや絵）のMatroskaの窓はその時刻の前のクラスターから、1秒より
  後に見せる絵を持つクラスターまでです。MPEG-TSの窓はその時刻のまわり約1秒を読み、両側で分かっている復号時刻
  が示す位置を読んで探し（OggとFLACの窓と同じ `narrowToPosition`）、探すときに読んだ復号時刻で後の窓の位置を決めます。窓のトラックは、窓の最初の標本からではなく、開いたときと同じくトラックの最初の標本から説明します（構成、
  レート、チャンネル、エンコーダーの遅延）。`thumbnail()` は、CuesのあるMatroskaを64 KiBから全トラックの標本を持つまで
  （32 MiBまで）読む先頭だけで、MPEG-TSを末尾なしで開きます（`ProbeTarget.windowOnly`）。入力の終わりは絵に要るものを何も説明しません。
  窓は、入力の先頭から復号に要るもの（Matroskaの最初のクラスターより前の要素、MPEG-TSのプログラム表）をプローブが持つ
  小さなリーダーから読み、自分のクラスターやパケットより前はほかに何も読みません（`WindowBytes`。Blobからは、Blobが読んだ範囲のビューとして読みます）。窓のパケットを通して
  読むときも窓の終わりより先は読みません（`ProbedInput.end`）。Matroskaの窓は、説明が持つメタデータを読み飛ばします。
  フラグメントMP4の窓は、最初のトラックの索引（`tfra`）がその時刻のまわりに置くフラグメントで、プローブが持つムービー
  ボックスのあとに読み、各フラグメントは自分の復号時刻（`tfdt`）で時刻付けします。デマルチプレクサーは窓より前の
  フラグメントを読み飛ばし（`Mp4DemuxerOptions.fragmentsFrom`）、トラックは最初の窓がtrakボックスから読んだものを写して
  使い（`Mp4DemuxerOptions.movie`）、フラグメントはチャンクのビューとして読みます。フラグメントMP4を通して読むときは索引を読みます。
  `Media` はストリーム以外のどの対象も、開いたときに読んだものの窓から読みます。フラグメントMP4の `packetAt()` は窓のファイルを
  作りません。プローブが窓のフラグメントをmoofボックス（それぞれ直後のボックスヘッダーと一緒に読む）だけから、ムービーボックスが
  持つトラックに解析し（`ProbedInput.windowTracks`。同じ `parseFragments` とtrexの既定値）、`Media` はその中から
  `findSample()` と同じくパケットを見つけて、そのバイトだけを読みます。その解析が警告するか失敗するところ（`tfdt` のない
  フラグメント、メディアデータの外の標本、損傷）、標本記述を切り替えるトラックやチャプタートラックがあるムービー、窓のファイル
  がその検査（`maxPacketBytes`・`maxSamples`・`maxIndexBytes`）で失敗するところは、従来どおり窓のファイルが決めます。
  Matroskaのクラスターとフラグメントの窓は、索引を二分して探します（`PlaceSearch`。時刻が増えない索引は先頭から順に）。
- 先頭に映像のキーフレームがないMPEG-TS（IDRのないH.264をIピクチャーやリカバリーポイントから読むもの）は、通し読みと
  窓でも索引を読みます。そのキーフレームはストリーム全体を読まないとわかりません。
- リーダーが通して読める入力（Matroska・MPEG-TS）の、範囲も `keyframesOnly` もない `packets()` は、コピーと同じく入力を
  一度通して読みます。索引が持つ順と時刻でパケットを渡し（`StreamSchedule`）、入力を二度読みません。通し読みが読み越した
  損傷は索引のものと同じく `Media` のものです（`MediaReading.reports`）。`media.warnings` に入り、通し読みの後で索引を
  読んでもリスナーには二度届きません。
  説明したFLACは `packets()` のときだけ通して読みます（`ProbeTarget.packetsOnly`）。入力全体を読むときと同じく索引を
  読み、見つけたフレームを走査のチェックポイントごとに、読んだバイトのビューのまま渡します。FLACのコピーは索引を
  読みます。通して読む入力のコピーは書き方が変わる（MP4へはフラグメントで書く）からです。
- 説明したフラグメントのないMP4は、どの読み取りも索引を読みます（`readPlan()`）。標本の順はファイルの順ではないので
  通しては読まず、表がどのパケットの位置も窓なしで決めます。最初の読み取りが、開いたときに説明したトラックのまま、
  読み直したムービーボックスから表を作ります（`MediaFile.probedIndex`）。その警告は窓と同じ道で知らせます。説明は読むと
  警告が出る入力を断っているので、索引は開いたときに知らせていないものを見つけません。
- 入力全体が要るもの（範囲やキーフレームだけの `packets()`、`check()`、`decodeAudio()`、入力全体の再エンコード）は索引を
  一度だけ読み、`Media` は `close()` までその索引を持ちます。

どの読み方でも結果は索引から得るものと同じです。`Media` は索引を持った後も関数と同じ読み方をします（`readPlan()`）。
結果はそれまでに読んだものによりません。関数（`convert()`・`thumbnail()`・`frames()`・`packageMedia()`）は処理が
最初に読む読み方で入力を開くので、開いたものがそのまま処理に使われます。`inspect()`・`convert()`・`check()` は形式の判定も1回
です（`FormatRegistry.detectFormat()`）。画像は変換器へ渡し、メディアの入力はその形式として開きます。開き直した入力は、
開いたときに知らせていない警告だけをリスナーへ知らせ、索引を読んだ後の `Media.warnings` は索引の警告です。窓も同じく、
実行中の処理を通して知らせます。窓自身の読みで見つけたもの（帯域内のパラメーターセットから取った構成）はリスナーへ1回
届き、損傷を見つけたMatroskaやMPEG-TSの窓は何も持たず、索引がそれを読んで知らせます。

## 開いた入力が持つもの

開いた入力（`Media` の中の `MediaFile` と、処理が読んだ索引）は、トラックの説明と索引、つまりトラックとその標本表を
型付き配列で持ち続けます。説明したMP4は、処理が索引を作るまで表を持たず、ムービーボックスの中の表の位置と説明した
トラックだけを持ちます。トラックのコンパクトな索引はトラック自身が `samples` プロパティの奥に持ちます
（`bindCompactSampleIndex`）。アクセサーの関数の組はすべてのトラックで1つなので、ファイルが読み手のトラックから作る写しは
同じ順で組み立てられ、同じ形を共有します。開いた入力は、読み取りで取ってきたバイトは持ちません。Blob はスライスごとにブラウザーへの要求がかかるので、1つの規則で
読みます（`core/io/sources/blob-source`）。同時に頼まれた近い読み取りは1つのスライスにし、スライスは64 KiB境界から少なくとも256 KiB
（Blob の末尾では末尾から戻って）読み、持っているバイトは読み直しません。先へ続く読み取りは4 MiBまで倍に広がる窓で読み、新しい窓を
8 MiBまで持ちます。キャッシュは64 KiBのページで読み、キャッシュを通さない読み取りもページが持っているバイトはそこから取ります。
ファイル順のパスは、最初の要求に要るページ（少なくとも256 KiB）から始め、範囲から次の範囲へ続く間は前の倍の長さの範囲を
1 MiBまで読みます。1 MiBの範囲では、その半ばまで来たところで次の範囲を先読みします。数パケットで止まるパス（キーフレームからの1枚の絵）は、それらが持つバイトとほとんど
同じだけしか読みません。どこで止まるパスも、止まったところから先は多くても範囲1つ半しか読みません。
256 KiBはBlobの最小のスライスです。そこから倍に広がる範囲は、Blobがそれらのために同じく倍に広げて
読む窓の中に収まり、窓のビューになります。ほかの長さの範囲は窓をまたいでコピーになります。Blob を窓ごとに通して読むパスは、
窓を使う間に次の窓を読みます。その範囲、チャンクの走査（`ChunkReader`）、ストリームや窓が分離するチャンク（`ForwardWindows`・
`WindowBytes`）は窓のビューで（`registerViewReads`）、窓は書き換えられないので、コピーはライブラリーの外へ出るパケットだけです。
それぞれのソースが持つものの手放し方を登録し（`core/io/sources/source-read` の
`registerReleaseReads`）、`MediaFile.releaseReads()` がすべてを手放します。手放すのは、入力の索引ができたときと、`Media` の
各操作と `packets()`・`segments()` のパスの終わりです。次の操作は必要なところを読み直します。結果は変わりません。

## 変換が入力を読む方法

変換はクリップの入力を1回のパスで読みます（`pipeline/transcode/shared-read` の `ClipRead`）。インターリーバーのレーンへ
コピーするパケットも、映像のレーンが復号する絵も、音声のレーンが復号する音もこのパスから受け取り、
`MediaFileWriter.sharePackets()` が、それぞれが次に受け取るもののうち復号時刻の最も早いパケットを1つずつ、各パケット
1回だけ読みます。レーンが1つでも同じパスで読み、変換を伴わないコピー（`routePackets()`）も同じです。書き出しのための
パケットの読み方は1つです。パスが読み進めるのは、復号するレーンが待たせているパケットが16未満か、レーンが待っているとき、
レーンをまとめる側がコピーのパケットを待っているとき、復号するレーンがないときで、それ以外は待ちます。レーンが受け取る
先は読まず、レーンが終われば読むのも止まります。

パスにそのまま従わない場合：

- 戻るか先へ飛ぶレーンは、そこから読み手を始め直し、パスはそこから読みます。ループや繰り返しの音、代わりのデコーダーで
  やり直すデコーダー、最初のフレームヘッダーを読むFLACです。
- 遅れたレーンが持つのは最大1024パケットか32 MiBまでです。パスは他のレーンのために読み進め、追いついたレーンの
  パケットは読み直します。
- クリップと重ねる音声トラックはそれぞれ自分のパスを持ちます。1つの入力の2つのクリップを同時に読むと2回読みます。
- ストリームとして開いた入力は、ストリームを1回通してコピーします。復号する変換は索引か窓を読みます。
- `decodeAudio()` は、どこからでも、同時に何度でも読める音源を呼び出し側に渡すので、パケットを番号で読みます
  （`readPacket()`）。

## 絵の取り方

`thumbnail()` と `frames()` は、頼まれた各時刻かその前のキーフレームから復号します（`pipeline/frames/frame-extract`）。
ある時刻に見える絵は、その時刻までに始まる最後の絵です。最後に頼まれた時刻でも、後の絵が出てくるまでデコーダーに
パケットを渡します。その絵のパケットのところでフラッシュすると、デコーダーによっては出る絵が変わり（MPEG-4 Part 2）、
補った絵の警告も変わるからです。絵をPNGにするのは、ホストのキャンバスがあってすべての画素が不透明ならキャンバスで
（キャンバスはアルファを乗算して持つので半透明の画素は変わりますが、不透明な画素は同じに復号されます）、それ以外は
ライブラリーのエンコーダーで、どのホストでもバイト単位で同じです（`codecs/image/encoders` の `encodePng`）。

## コードの読み込み

ビルドはモジュールを少数のチャンクにまとめます（`scripts/esm-chunks.mjs`）。エントリーは静的な import のチャンクを
読み込み、残りは必要になったときにまとまりごとに読み込みます。

- エンジンと、すべての open が動かすもの：判定、開くときのオプション、使うプラグインの組み立てとその目録、Media の
  パケットの読み取り（`api/media-reads`）
- 主なリーダーごとに1つ：MP4、Matroska、MPEG-TS、音声ファイル、MPEG 音声
- AAC の構文、その処理がすべて計画するか実行するパケットのコピーを含む変換の API、トラックのコピー、デコードする変換の処理
- `thumbnail()`・`frames()`（`api/picture-operations`）と絵をデコードするコード（`pipeline/frames/frames`）。コピーを計画
  しないので、変換の API も変換の処理も読み込みません

すべてのモジュールを1つの規則で置きます：モジュールはそれを読み込むコードと一緒にし、よくある呼び出しが実行するコード
だけを少ない要求で読み込むようにします。規則のデータは `scripts/esm-chunks.mjs` の先頭の一覧です：`CHUNK_FAMILIES`（上のまとまり。
それぞれが自分だけの使うものを持つ）、`READER_PARTS`（一部の入力だけが動かすリーダーの部分：断片化した・修復するMP4、Matroska
のメタデータ・圧縮・復旧、音声ファイルのFLAC・Ogg・CAFの部分）、`MAIN_READERS`（MP4・Matroska・音声ファイル。複数の
まとまりが使うものは、それを使うこれらの組ごとのチャンクへ）、`OTHER_READERS`（MPEG-TS・MPEG音声・AC-3/DTS/TrueHD。
主なリーダーが使わないものの名前になる）、`RARE_PARTS`（部分を読み込む入力が少ないMP4とMatroska。部分だけが共有するもの
は分けておく）、`ENGINE_READERS`（MP4とMatroska。両方が使うものはエンジンと一緒）、`MAIN_WRITE`（MP4へのコピー。共有の
チャンクはこれが使うかどうかも区別する）、`WRITER_MODULE`（ライターはリーダーのコードを持たない）、`RUNTIME_ENTRIES`（Node
とDenoの入口がエンジンと共有するものは独立したチャンク）。

そのためWAVファイルを開くときはFLAC・Ogg・CAFのコードを読み込みません。FLACとOggはWAVと同じくらいよく使うので、音声
ファイルの部分が共有するものは音声ファイルのものと数え、それらを開くときの要求は多くても1つ増えるだけです。ほかのまとまり
のコードだけが読み込むまとまり（音声ファイルの部分の後の、Oggのリーダーの追加のストリーム）は、共有するものを先のまとまりに
任せます。

まとまりへは扉（door）を通ります。扉はまとまりが import するすべてのチャンクを名指しする小さなモジュールで、ブラウザーは
それらを1回の往復で要求します。import する側と必ず一緒に読み込まれるチャンクは要求しません：`api/operations` は import
したパケットのコピーをエンジンに渡します。必要になったときに読み込むモジュールのうち、呼び出しのたびに要るもの（開くときの
オプション、判定の画像の側、Media のパケットの読み取り）へは、そのために持つ1つの Promise を通ります（`api/load-hints` の
`loadOnce`）。作り直すのは読み込みが失敗した後だけです。読み込み済みのモジュールの `import()` でも、1回ごとに数マイクロ秒
かかるからです。最初の `inspect()`・`open()` はエンジンとリーダーを同時に読み込み始めます。
リーダーは Blob の type かファイル名からすぐに、なければ入力の先頭のバイトから選びます（`api/load-hints`）。FLAC と Ogg の
入力も同じです。そのため、ブラウザーで MP4 を開くときの要求は、呼び出しの後に扉と、扉が名指しするチャンクの2往復です。
Media のパケットの読み取りはエンジンと一緒に読み込むので、その後の `packets()`・`packetAt()`・`decodeAudio()` は何も
要求しません。処理は自分のコードを読み込むと
すぐに、入力を開いた後に動かすものを要求します（`pipeline/plan/operation-loads`）。`convert()` はパケットのコピー、トラックの
コピー、出力形式のライターを、`thumbnail()`・`frames()` は絵をデコードするコードと PNG のエンコーダーを要求します。開き
終えるのを待ってから計画やデコードに進むことはしません。コーデックは計画が選んだとき（ホストのものかライブラリのもの）に読み
込み、1回で読み通す入力のコピーは、プローブがそう告げた時点でストリームの順序づけを読み込みます。

ブラウザーでは、既定のエントリーがこのコードを前もって読み込みます（`api/idle-prefetch`）。エントリーを読み込んだ後で
ページが落ち着いたら、エンジン、MP4・MPEG 音声・Matroska のリーダー、Matroska のリーダーのメタデータの部分（ffmpeg や
mkvmerge のファイルの Tags が使います）、AAC の構文を要求し、既定の MediaForge がエンジンを用意します（使うプラグインの
組み立てと、リーダーとライターの登録）。アプリの起動やファイルの選択の
後に初めてメディアを開く、よくあるアプリの最初の呼び出しは、読み込み済みで用意のできたコードを使います。それより前に始まった処理は
自分の使うものだけを読み込み、先読みはしないので、import の直後の呼び出しが遅くなることはありません。メディアを開かない
アプリは、使わないコードを約 360 kB 余分に取得します。そのため、ユーザーがデータの節約を選んでいるか、回線が 2G だと
ブラウザーが知らせるとき（`navigator.connection`）は先読みしません。バイトを数えるアプリ向けの lite エントリーは、必要に
なったときだけ読み込みます。既定のエントリーを import するワーカーも、メディアを処理するためにあるので、意図して同じく先読み
します。ブラウザーの外（Node・Deno・Bun）ではコードをディスクから読むので、先読みしません。
`test/build/bundle.test.mjs` がこの構成と2つの読み込み方を確かめます。

## プラグインとサブシステム

**プラグイン**は、エンジンの約束の裏で差し替えられる実装です：WebCodecs にない部分を埋めるソフトウェアのデコーダーと
エンコーダー、コンテナの読み手と書き手、エンジンが動かす処理のステージ。既定のエントリーはすべてのプラグインを含み、
初めて使うときに読み込みます。`plugins: { exclude }` で外せ、lite エントリーには含まれません。**サブシステム**は独自の
寿命と API を持ち、変換エンジンには不要なもので、自分のフォルダーと層に置き、下の層に依存し、その逆はありません。

分類の表（行数、縮小後の kB、利用元、判断）は英語版と同じです。H.264・MPEG-1/2・MPEG-4 Part 2・AAC・MPEG 音声・
FLAC・ALAC・Opus・Vorbis・AC-3/E-AC-3 の各コーデック、AVI・FLV・ASF・MXF・MPEG-PS・IVF、生の IAMF・APV のストリームと
APV のデコーダーがプラグインです。HLS と
DASH の再生、HLS のクライアント・画質の自動切り替えと EME・HLS DRM はパッケージ mediaforgejs-player のプラグインです。`edit()` は
`editing/`、`encodeFrames()` と `recordStream()` は `recording/`、ファイルと FFmpeg は `runtime/` のサブシステムです。
パッケージ化、マニフェスト、画像のコーデック、字幕、メタデータ、処理のステージはエンジン自身が使うので、エンジンの層に
残ります。

**プレーヤーはパッケージ、サブシステムはそのまま。** HLS と DASH の再生は `packages/player`（mediaforgejs-player）に
あります。TypeScript で、本体のビルドが自分の `dist/` にコンパイルし、`npm run release:pack` が mediaforgejs を
peer dependency としてパックします。使うのは公開エントリーだけです：`mediaforgejs/plugins`（プラグインとプレーヤーの
約束、`MediaForgeError`）、`mediaforgejs/streaming`（プレイリスト、MPD、DASH のセグメント）と `mediaforgejs` の型。
小さな補助（中止、期限、検査したバイト列、警告）は自分で持ちます。リポジトリの中では、ビルドが作るリンク
`packages/player/node_modules/mediaforgejs` から mediaforgejs を見つけます。サブシステム（editing・recording・runtime。
合わせて縮小後およそ 190 kB、ビルドの約6%）はすでに主なエントリーの起動時に読み込まれず、移すと使っている内部を公開する
ことになります。将来移すなら、Node 専用で子プロセスを使う 27 kB の FFmpeg バックエンドが最初の候補です。

## 音声ファイルの読み取りと復号

音声ファイル（`formats/audio-files`）もコンテナと同じ読み方をします。説明はトラックを示す部分だけを読み、索引はパケット
ごとのオブジェクトを持たず、1度の読み通しは大きな読み取りで入力を1回だけ読みます。

- **説明。** `inspect()` はまず読み手の `probe` を使います。4 MiB以上のMP3（`probeRawAudio`）とFLAC（`probeFlac`）は、
  MPEG-TS・Matroska・Oggを両端から説明するのと同じく、ヘッダーと最後のフレームから説明します。MP3のXing/Infoまたは
  VBRIフレームは、その後のフレーム数とそのフレームからのバイト数を示します。そのバイト数が入力の終わりか末尾のタグ
  （すべてのフレームを読むときに止まる位置）で丸ごとのフレームの並びとして終わり、両端のフレームのレートとチャンネル数が
  同じで、レイヤーが許すビットレートでフレーム数がバイト数に収まるとき、説明が成り立ちます。FLACはSTREAMINFOがサンプル
  数を示し、最初のフレームが番号を0から始め、最後のフレームが入力の終わりまで丸ごとでCRC-16が一致し、そのサンプル数で
  終わるとき成り立ちます。長さ・レート・チャンネル・ギャップレスの切り詰め・タグ・コーデック設定は、すべてのフレームを
  読んだ結果と同じ関数（`leadingTags`・`mp3Trim`・`readFlacHeader`・`flacCodecConfig`）で求めます。読み取りの間の損傷は
  大きなMPEG-TSの両端の間と同じく見えません。それより小さい入力、strict検証、ほかの配置はすべてのフレームを読み、4 MiBなら
  数ミリ秒です。MP3とFLACは独自の読み手の部品（`mp3`・`flac`）を持つので、説明のない形式（ADTS・MP1・MP2・WAV・AIFF・
  AU・CAF）は引き続き `sampleCount` を返します。
- **位置決め。** 4 MiB以上のOggとFLACで時刻の前後の範囲（`around` と `through` を持つ `ProbeTarget`）を読むときは、
  すべてのページやフレームを読まず、ストリームが示す位置で探します。Oggのページのgranuleは最後のパケットまでのサンプル数を、
  FLACのフレームヘッダーは最初のサンプルの番号を示します。`narrowToPosition`（`formats/shared/position-search`）は
  それまでに見つけた位置から補間した位置で16 KiBを読み（範囲の半分より多く残す探りが2回続いたら中央を読みます）、
  `bisectOggGranule`（`formats/ogg/positions`）と `flacWindow` はそこで同期・CRC・各項目の確かめに通る最初のページや
  フレームを取ります。位置かページ番号がオフセットとともに減れば探すのをやめます。範囲は先頭（Oggでは末尾も）の後に
  続けて1つの入力として読むので、パケットはすべてのページやフレームを読んだときと同じです。間を飛ばした後で最初に
  パケットを完結させるOggのページのパケットは含めません。すべてを読むときは、そのページのgranuleから秒で時刻を戻して
  付けるためです。途中にほかのストリームやストリームの境界があるとき、範囲が損傷しているとき、strict検証、前にID3タグが
  あるFLACは索引を読みます。RFC 3533が禁じる、同じserialを使う連結は、ページ番号が減るところでだけ見分けます。
  範囲は約10回の読み取りで数ミリ秒で開きます。説明するprobeはファイルに `window` を渡すので（`probeWindows`）、
  `packetAt()` は入力の判別も両端の読み取りもやり直さず、開いたときに見つけた両端とフレーム番号から範囲を開きます。
  範囲を開くあいだ、各ページのCRCは1度だけ確かめます。両端のページ（`oggStreamEnds`。両端の64 KiB、ヘッダーか
  閉じるページが収まらなければ256 KiB）と探索で取ったページは、範囲を読むときに確かめ直しません
  （`checkedOggPages`）。時刻の基準（開始・レート・コーデック遅延）は先頭だけから求め、同じVorbisのsetupヘッダーを
  また読むときは、そこから解析したモード表を使い回します。
- **索引。** 読み手はサンプルのオブジェクトの配列ではなく、コンパクトなサンプル索引（`bindCompactSampleIndex`）を結び
  付けます。`AudioFrameIndex` はMP3とADTSのフレームを型付き配列の位置と大きさとして1フレーム10バイトで持ちます（
  ストリームのフレームはどれも同じサンプル数なので、フレームの時刻は位置とその数の積をレートで割った値で、累積の和と
  同じ値です）。`FlacFrameIndex` はFLACのフレームを22バイトで持ち、`PcmPacketIndex` はPCMのパケットを位置から求めて
  パケットごとには何も持ちません。`maxIndexBytes` はこのバイト数を数えるので、何時間ものオーディオブックも既定の上限で
  開けます。走査は `ChunkReader` で、ヘッダーで終わるPCMのファイルは64 KiBのページ1つから、全体を読むFLACとOggは
  （上のパスと同じく）256 KiBから読み、続く間は倍にして1 MiBのチャンクまで広げ、1つを解析する間に次を読みます。
  窓のように読む範囲が分かっているリーダーは、まるごとのチャンクで読みます。トラックの項目を変える処理はその場で
  変えます。トラックを新しいオブジェクトに展開すると `samples` を読み、索引が置き換えたサンプルの配列を作るためです。
- **復号。** 音声トラックをどのデコーダーに渡すかは、ルーター（`pipeline/codecs/router`）の1つの判断で決めます。
  リニアPCMはパケットがそのままサンプルなので、復号せずに読みます（`readsLinearPcm`）。どのデコーダーにも問い合わせず、
  ライブラリが読みます。それ以外のコーデックは、ホストが設定に対応していればホストのAudioDecoderを先に（'builtin' を
  優先する場合を除く）、ライブラリのデコーダーを後に使います（`decoderOrder`）。`decodeAudio()`・変換・
  `createAudioTrackSource()` のどれでも同じです。ライブラリが読む `AudioData` は、ホストのデコーダーの出力も
  `encodeFrames()` に渡されたものも、すべて `copyAudioPlanes`（`codecs/webcodecs/audio-data`）を通ります。整数の
  サンプルはその形式のままコピーし、2のべき乗で割ります（v / 2^(bits − 1)。ライブラリがリニアPCMを読むのと同じで、
  正確です）。floatのサンプルは `f32-planar` としてコピーします。ChromiumはFLACを `s16` か `s32` に、MP3とMP2を
  `s16-planar` に、G.711を `s16` に復号し、自身のfloatへの変換では正の値を2^(bits − 1) − 1で割ります。そのままでは
  同じFLACでもホストとライブラリのデコーダーで値が違い、16ビットのWAVへの変換でサンプルが1ずれます。
  `HostAudioDecoder` はサンプルを16384フレームの面に集め、次の出力が収まらないときとフラッシュのときに、コピー
  せずそのまま渡します。復号の後の段階はフレームごとではなくブロックごとに動きます。`checkedSource` はデコーダーのブロックのNaNと無限大を、分岐のない1つのループで
  調べます。
- **符号化。** FLACのエンコーダーは、ブロックの候補のサブフレーム（各チャンネルと、ステレオならミッドとサイド）を
  それぞれ1回の走査で調べます。0から4次の固定予測の残差の大きさ、全サンプルに共通する下位の0のビット、線形予測を
  与えるWelch窓の自己相関（ラグ0から8）です。続けて線形予測の残差を求めます。候補の大きさは数えずに見積もります。
  線形予測は計画が探す分割次数（6まで）の残差符号化を、固定予測はブロック全体を、各分割の残差のジグザグ符号の和から、
  平均の大きさが与えるRiceパラメーターの前後1以内で最良のものについて見積もります。シフトで落ちるビットは一様と
  みなします。ステレオのブロックは2つの候補の見積もりの和が最小のチャンネル割り当てを、符号化する各サブフレームは
  見積もりの小さい予測を選び、その2つのサブフレームだけを正確に計画します（各Riceパラメーターは平均の大きさから先頭の
  0の数を数えて選びます）。ファイルは同じサンプルに復号されます。テストのコーパスでは、見積もりによる大きさの増加は
  正確に数えて選ぶ場合に比べて全体で0.002 %、各ファイルで最大0.11 %です。16ビットのモノラルとステレオの音声のMD5には
  32ビットの語で渡します。MP2とMP3のエンコーダーの
  分析フィルターバンクは、チャンネルの直前の480サンプルの履歴の上で1回の呼び出しに1フレームを処理し、各出力の8つの
  窓のタップを2つずつ足し、窓をかけた64の値を32に畳み、32点の行列演算を余弦の対称性で分けます（積は2048ではなく
  384）。MP3のMDCTは36の入力を18点のDCT-IVに畳みます。MP3のエンコーダーは各線を、|x|^(3/4)をステップの3/4乗で
  割ったtについてround(t - 0.0946)に、その1つ上の再構成が1e-12より大きく近いときは1つ上に量子化します。この丸めは
  最も近い値かその1つ下です。グラニュールのゲインの探索は、チャンネルの前回のゲインから、予算をまたぐまで倍になる
  歩幅で進み、その後は半分にしながら、ビットが収まる最小のゲインを求め、さらにその1つ下と3つ上までを試します。予算内で
  誤差の最も小さい量子化を選ぶので、試すゲインの量子化は、途中までの誤差がそれまでの最良を超えた帯域で止めます。長い
  グラニュールはスケールファクターを0のまま1回だけ探し、短いグラニュールはscalefac_scaleの両方の値で最大6回の調整を
  試します。フレームのビット配分も、共通のゲインを前のフレームのゲインから同じ方法で求めます。帯域の平坦さとビットの
  見積もりは、最大16個の因数の積の対数を取ります（各因数は1e-12から1e2、または2^45未満なので、積は有限のdoubleに
  収まります）。グラニュールの符号化、帯域のモデル、探索が残す量子化は、量子化ごとのオブジェクトではなく再利用する
  記録です。入れ物へは、ライブラリのFLAC・MP3・MP2のエンコーダーが符号化した
  フレームを1つずつマルチプレクサーに渡します（`ContainerAudioEncoder.stream`）。コピーする映像のレーンが音声全体を待って
  インターリーバーにたまることはありません。最初のパケットの前に伝える範囲（LAMEタグが示すプライミングと、宣言した長さ。
  音声はその長さまで無音で補います）が音声の終わりによらないためです。フレームが宣言した長さでちょうど終わりうるMP2は、
  従来どおり全体を先に符号化します。FLACは宣言した長さと音源自身の長さの長い方をちょうど符号化し、その長さのSTREAMINFOを
  フレームの大きさとMD5を不明（RFC 9639は両方に0を認めます）として最初のパケットの前に伝えます。エンコーダーの
  STREAMINFOは音声の終わりに `setAudioCodecConfig` で届きます。そのときすでにヘッダーを書いたマルチプレクサーは、
  `finalize()` でそれを書き換えます（MatroskaのCodecPrivate、分割MP4の初期化セグメントの 'dfLa'、Oggの最初のページと
  そのCRC）。まだ書いていなければヘッダーにそのまま書くので、`patchAt` を持つ出力先（Blob・ファイル）には全体を先に
  符号化したときと同じバイトが書かれます。持たない出力先には宣言したSTREAMINFOが残ります。

## 保守のメモ

構成の監査は、ファイルがおよそ20を超えるフォルダー、およそ800行を超えるファイル、およそ150行を超える関数、繰り返しの
コード、古い名前を探します。見つけて残したものと、その理由：

- **フォルダー。** `codecs/h264` は23ファイルです。1つのデコーダーで、フレームのワーカーと WebAssembly のカーネルを
  ビルドがパスで結び付けている（`scripts/build.mjs`・`scripts/esm-chunks.mjs`）ため、サブフォルダーに分けると一緒に
  変わるファイルが離れます。どの入力の判定も、すべての形式の上の `formats` にあり、
  読むバイトの印は `formats/detection` にあります。
  `formats/audio-files` は、リーダーを入力ごと（WAV・AIFF・AU と FLAC・Ogg・CAF）に分けたので23ファイルです。リーダーの
  部品は、音声ファイルの次の分割で `read/` に移します。
- **長いファイル**（48）。コーデックのビットストリームは読む構文の長さです：H.264 のスライスデコーダー、MPEG-4 Part 2 の
  VOP デコーダー、MP3、AAC（SBR、パラメトリックステレオ）、Opus（SILK、CELT）、AC-3、画像のエンコーダー。数値計算の
  カーネルは速さのためにまとめておきます。コンテナの読み手と書き手（MP4、Matroska、MPEG-TS、AVI、ASF、FLV、MXF、
  MPEG-PS、Ogg、音声ファイル）は入力の形ごとに `read/`・`write/` の部品へ分けているところです。残りは1つの操作全体を
  動かします：変換のタイムライン、開いたファイルとリマックスの計画、HLS クライアント、EME、FFmpeg バックエンド。
- **長い関数**（95）。内側の関数が状態を共有するファクトリー（`createHttpLicenseCallback`・
  `playHlsWithDrm`）はクラスの方が読みやすくなります。状態をローカル変数に持つ状態機械と
  ループ（`encodeMp3FrameMachine`・`writeContainer`・`HlsClient.readMedia`・`playStreams`）と、仕様の構文をその順に
  読むパーサー（`parseHlsPlaylist`・`parseTtml`・`parseSliceHeader`）は、名前を付けられる段階だけを分けます。カーネル
  （`filterMacroblock`、イントラ予測、CABAC の残差）は分けません。読み手の本体は読み手と一緒に分けます。
- **繰り返しのコード。** 展開したカーネルの変種（H.264 の CABAC・予測・デブロック・変換、XviD の IDCT、Opus のバンド）と
  符号表は意図した繰り返しです。プラグインのフォルダーは非公開なので、映像のプラグインはそれぞれ自分のビット読み取りを
  持ちます。別の書き出し先を包む書き出し先は、そのメソッドを1つずつ転送します。
- **名前。** built-in はどの名前でも `Builtin` と書き、コンパクトなサンプル索引は最初に使った MP4 リーダーではなく中身に
  ちなんだ名前（`enableCompactSampleIndex`）にしました。
