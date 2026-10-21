# MediaForgeJS Developer Guide / 開発者ガイド

**[English Guide](#guide-en) | [日本語ガイド](#guide-ja) | [Руководство на русском](#guide-ru)**

---

<a name="guide-en"></a>

## 1. English Guide

### 1.1 Overview & Core Concepts

MediaForgeJS is organized around a simple rule: **do the least destructive work possible while guaranteeing a valid output file.**

When you hand a file to `convert()`, `edit()`, or `packageMedia()`, the library goes through three distinct phases:

1. **Sniffing & Demuxing:** MediaForgeJS reads only the bytes it needs from the input source. It skips past damaged ID3 tags, locates `moov` boxes even when preceded by padding, and extracts track metadata, codec configurations, tags, chapters, and packet tables.
2. **Planning (`plan`):** Before encoding anything, the planner inspects the target container and your requested options.
   * If a track's codec is already supported by the target container and you haven't asked to resize, trim off a keyframe, or resample it, the track is marked as `copy`.
   * If pixel or sample changes are required, the track is marked as `encode` along with the processing stages (`transform`, `frameRate`, `remix`, `time-stretch`, `resample`) it will run through.
3. **Execution & Muxing:** Packets are copied or routed through the codec and stage pipelines into the output sink (`MemorySink`, `FileSink`, or custom sink).

### 1.2 Choosing an Entry Point

Because `dist/` is included in the repository, you can import from package subpaths or directly from `dist/esm/api/entries/`:

* **`mediaforgejs` (`./dist/esm/api/entries/index.js`):** The batteries-included entry. Loads the core containers plus all built-in format and codec plugins.
* **`mediaforgejs/lite` (`./dist/esm/api/entries/lite.js`):** The core-only entry. Reads and writes common containers (`mp4`, `mov`, `mkv`, `webm`, `ogg`, `ts`, `wav`, `flac`, `mp3`, etc.) and relies on the host's WebCodecs or plugins you explicitly pass in.
* **`mediaforgejs/plugins` (`./dist/esm/api/entries/plugins.js`):** Individual plugins you can pass to `new MediaForge({ plugins: [...] })` or exclude via `{ plugins: { exclude: ['avi'] } }`.

### 1.3 Core Operations

#### `inspect(input, options?)` & `open(input, options?)`
* `inspect()` returns a summary object (`format`, `duration`, `tracks`, `tags`, `warnings`) and closes the source immediately.
* `open()` returns a live `Media` session object so you can iterate over raw packets (`for await (const packet of media.packets())`), run multiple `media.check()` calls, or `media.convert()` without re-parsing the header. Always call `media.close()` when finished.

#### `check(input, target, options?)` & `convert(input, target, options?)`
* `check()` validates options and returns `{ supported, plan, warnings, reason?, code? }` without writing any output.
* `convert()` executes the plan and returns `{ blob, format, mimeType, filename, plan, warnings }`.

#### `edit(project, target)`
Combines multiple clips and audio tracks on a timeline:
* `project.clips`: Array of `{ input, start?, end?, speed?, video?: { rotate?, flip?, crop?, ... }, audio?: { volume?, fade?: { in?, out? }, speed?: 'shift-pitch' } }`.
* `project.audio`: Array of background audio tracks `{ input, start?, end?, offset?, loop?, volume? }`.

#### `frames(input, options?)` & `thumbnail(input, options?)`
* `frames()` is an async generator yielding decoded video pictures (`{ width, height, timestamp, duration, data }`, or `VideoFrame` when `format: 'videoframe'` is set).
* `thumbnail()` extracts a single frame at `{ time }` and encodes it to an image format (`png`, `bmp`, `tiff`, `ico`, `gif`, `apng`, `webp`, `jpeg`, `avif`).

#### `encodeFrames(source, options)` & `recordStream(stream, options)`
* `encodeFrames()` takes an async iterable of `VideoFrame`s (or `{ video, audio }` iterables of `VideoFrame` and `AudioData`) and encodes them into a container. Every frame handed over is automatically `.close()`d after encoding.
* `recordStream()` records a browser `MediaStream` until `.stop()` is called.

#### `packageMedia(input, target, options?)`
Packages media into streaming presentations (`hls` or `dash`), returning `{ entry, files }`, where `files` is a `Map` of segment and manifest filenames to their descriptors.

### 1.4 Audio & Video Stages (`mediaforgejs/parts`)

When you need custom processing pipelines or want to plug into `video.stages` / `audio.stages`:

* **Video Stages:**
  * `transform({ crop, rotate, flip, width, height, fit })`: Crops, turns in 90-degree steps, mirrors, and resizes frames. Crops aligned to the 4:2:0 chroma grid on host `VideoFrame`s are zero-copy.
  * `frameRate(fps)`: Retimes a stream onto a fixed frame grid, repeating or dropping frames as needed while preserving keyframe requests.
* **Audio Stages:**
  * `remix({ sampleRate, channels, speed })`: Folds or expands channel layouts (respecting the source's speaker `channelMask` and BS.775 downmix weights) and resamples audio.
  * `timeStretch(factor)`: Changes playback speed (from `0.05x` to `20x`) while preserving pitch and keeping transient attacks sharp.

### 1.5 Error Codes & Option Policies

Every error thrown by MediaForgeJS is a `MediaForgeError` with a `.code` and an optional `.hint` telling you how to fix it:

* `INPUT`: Invalid arguments, out-of-range settings (under `optionPolicy: 'strict'`), or empty inputs.
* `DEMUX`: Unrecognized file signature or truncated header.
* `FORMAT`: The container cannot hold the requested codec or dimensions.
* `DECODE` / `ENCODE`: Missing host WebCodecs support or corrupted bitstream (under strict validation).
* `PLUGIN`: The operation requires a plugin that was excluded or not loaded in `mediaforgejs/lite` (the error's `.plugin` property names the exact plugin to add).
* `IO`: File system error, existing file without `overwrite: true`, or output exceeding `maxOutputBytes`.
* `OOM`: Picture dimensions or byte budgets exceeding safety limits (e.g., > 8192x4320).
* `ABORT`: Cancelled via `AbortSignal` or called on a closed resource.

### 1.6 Formats and codecs

The support matrix below is verified automatically against the test suite (`npm run support -- --docs`):

<!-- support-table en: written by npm run support -- --docs -->

**Everything the library declares, generated from the support table**

| Container | Read | Written | Video copied into it | Audio copied into it |
| --- | --- | --- | --- | --- |
| `3gp` | ✔ | ✔ | `avc1` `avc3` `mpeg4v` | `mp4a` `evrc` `qcelp` |
| `aac` | ✔ | ✔ | – | – |
| `ac3` | ✔ |  | – | – |
| `aiff` | ✔ | ✔ | – | – |
| `apv` | ✔ | ✔ | `apv1` | – |
| `asf` | ✔ |  | – | – |
| `au` | ✔ | ✔ | – | – |
| `av1` | ✔ |  | – | – |
| `avi` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `mpeg1v` `mpeg2v` `mpeg4v` `wmv1` `wmv2` `wmv3` `vc1` `dvvideo` `mjpeg` | `pcm` `pcm-s16le` `mp1` `mp2` `mp3` `ac-3` `wmav1` `wmav2` `wmapro` `wmalossless` `wmavoice` |
| `caf` | ✔ | ✔ | – | – |
| `dts` | ✔ |  | – | – |
| `eac3` | ✔ |  | – | – |
| `flac` | ✔ | ✔ | – | – |
| `flv` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `av01` | `mp4a` |
| `iamf` | ✔ | ✔ | – | `iamf` |
| `ivf` | ✔ | ✔ | `av01` `vp8` `vp9` `vp09` | – |
| `m4a` | ✔ | ✔ | – | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `evrc` `qcelp` `mhm1` `mha1` `iamf` |
| `m4v` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mkv` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp8` `vp9` `vp09` `theora` `apco` `apcs` `apcn` `apch` `ap4h` `ap4x` `mpeg1v` `mpeg2v` `mpeg4v` `wmv1` `wmv2` `wmv3` `vc1` `dvvideo` `mjpeg` | `mp4a` `opus` `vorbis` `flac` `alac` `ulaw` `alaw` `mp1` `mp2` `mp3` `ac-3` `ec-3` `dtsc` `dtsh` `dtsl` `dtse` `mlpa` `pcm` `pcm-u8` `pcm-s16le` `pcm-s24le` `pcm-s32le` `pcm-s16be` `pcm-s24be` `pcm-s32be` `pcm-f32le` `pcm-f64le` `wmav1` `wmav2` `wmapro` `wmalossless` `wmavoice` |
| `mov` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `apco` `apcs` `apcn` `apch` `ap4h` `ap4x` `aprn` `aprh` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `ulaw` `alaw` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-u8` `pcm-s8` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mp1` | ✔ | ✔ | – | – |
| `mp2` | ✔ | ✔ | – | – |
| `mp3` | ✔ | ✔ | – | – |
| `mp4` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `mlpa` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mpeg` | ✔ |  | – | – |
| `mxf` | ✔ |  | – | – |
| `obu` | ✔ |  | – | – |
| `oga` | ✔ |  | – | – |
| `ogg` | ✔ | ✔ | – | `opus` `flac` |
| `ogv` | ✔ |  | – | – |
| `opus` | ✔ |  | – | – |
| `ps` | ✔ |  | – | – |
| `truehd` | ✔ |  | – | – |
| `ts` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `vvc1` `vvi1` `av01` `vc1` `mpeg1v` `mpeg2v` `mpeg4v` | `mp4a` `ac-3` `ec-3` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` |
| `vob` | ✔ |  | – | – |
| `wav` | ✔ | ✔ | – | – |
| `webm` | ✔ | ✔ | `av01` `vp8` `vp9` `vp09` | `opus` `vorbis` |
| `wma` | ✔ |  | – | – |
| `wmv` | ✔ |  | – | – |

- Decoded by the library: `pcm` `ulaw` `alaw` `ima4` `mp4a` `mp1` `mp2` `mp3` `flac` `alac` `opus` `vorbis` `ac-3` `ec-3` `uncompressed` `h264` `mpeg2video` `mpeg4-part2` `apv`
- Encoded by the library: `aac` `mp2` `mp3` `flac`
- Image formats read and decoded by the library: `apng` `gif` `png` `tiff` `webp`
- Image formats read, and decoded by the host where it can: `avif` `bmp` `heif` `ico` `jpeg` `jxl`
- Image formats written by the library: `apng` `bmp` `gif` `ico` `png` `tiff`
- Image formats written by the host's canvas where it can: `avif` `heif` `jpeg` `jxl` `webp`
- Packaging targets: `hls` `dash` `hls+dash`
- Played by `mediaforgejs-player`: `hls` `dash`
- Decoded by the host's WebCodecs where it can: `aac` `mp3` `opus` `flac` `vorbis` `ac-3` `ec-3` `ulaw` `alaw` `avc1` `hvc1` `vp8` `vp09` `av01`
- Encoded by the host's WebCodecs where it can: `opus` `vorbis` `avc1` `hvc1` `vp8` `vp09` `av01`
- Copied as streams built by their specification, which checks that a copy carries them, not that they decode: `dvh1` `dvhe` `vvc1` `vvi1` `wmv3` `vc1` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `wmapro` `wmalossless` `wmavoice`

<!-- /support-table en -->

---

<a name="guide-ja"></a>

## 2. 日本語ガイド

### 2.1 概要とパイプラインの仕組み

MediaForgeJS の基本方針はシンプルです。出力ファイルの正当性を保証しつつ、可能な限り元のデータを劣化させない（無駄な再エンコードをしない）ことです。

`convert()` や `edit()`、`packageMedia()` を呼び出すと、内部では以下の3つのフェーズが順に実行されます。

1. **フォーマット判別とデマルチプレクス (Sniffing & Demuxing):**
   入力ソースから必要なバイト範囲だけを読み取ります。先頭に巨大なID3v2タグや破損したジャケット画像があってもスキップしてフレームを見つけ出し、トラック情報、コーデック設定、メタデータタグ、チャプター、カバーアートを抽出します。
2. **実行プランの策定 (`plan`):**
   実際にデータを書き出す前に、出力先コンテナの仕様と指定されたオプションを照らし合わせます。
   * 出力先コンテナがそのコーデックに対応しており、リサイズやサンプリングレート変更、キーフレーム外でのカットなどが不要であれば、そのトラックは **`copy`（ロスレスパケットコピー）** と判定されます。
   * 画素や音声サンプルの加工が必要な場合は **`encode`** と判定され、必要な処理ステージ（`transform`, `frameRate`, `remix`, `time-stretch`, `resample`）が組み込まれます。
3. **パイプライン実行とマルチプレクス (Execution & Muxing):**
   策定されたプランに従い、パケットの直接コピー、またはデコード・ステージ処理・エンコードを経て、`MemorySink` や `FileSink` へ出力します。

### 2.2 エントリポイントの選び方

リポジトリにはビルド済みの `dist/` が含まれているため、パッケージ名でのインポートはもちろん、`./dist/esm/api/entries/` から直接読み込むことも可能です。

* **`mediaforgejs` (`./dist/esm/api/entries/index.js`):**
  すべての標準フォーマット・コーデックプラグインが最初から組み込まれた標準エントリです。迷ったらこちらを使ってください。
* **`mediaforgejs/lite` (`./dist/esm/api/entries/lite.js`):**
  コア機能のみを含む軽量エントリです。MP4, MOV, MKV, WebM, TS, Ogg, WAV, AIFF, CAF, AU などの主要コンテナを扱えます。追加のフォーマットやソフトウェアコーデックが必要な場合は、`mediaforgejs/plugins` から必要なプラグインだけを渡します。
* **`mediaforgejs/plugins` (`./dist/esm/api/entries/plugins.js`):**
  `avi`, `flv`, `asf`, `mxf`, `mpegPs`, `flac`, `aac`, `mpegAudio`, `opus`, `vorbis`, `ac3`, `alac`, `h264`, `mpeg12`, `mpeg4`, `apv`, `iamf`, `ivf` などの個別プラグインを提供します。各プラグインは完全に独立しており、必要なものだけを追加（`add`）または除外（`exclude`）できます。

### 2.3 主要APIの使い方

#### `inspect(input, options?)` と `open(input, options?)`
* **`inspect()`:** ファイルのフォーマット、長さ、トラック一覧、タグ情報を取得して即座にクローズします。`{ sampleCounts: true }` を渡すとサンプル数も集計します。
* **`open()`:** ファイルを開いた状態の `Media` オブジェクトを返します。`for await (const packet of media.packets())` で生パケットを順次読み出したり、複数のフォーマットに対して `media.check()` や `media.convert()` を繰り返し実行したりできます。使い終わったら `media.close()` を呼んでください。

#### `check(input, target, options?)` と `convert(input, target, options?)`
* **`check()`:** 出力を一切書き出さずに、指定した変換が可能かどうか（`supported`）、どのトラックがコピーまたは再エンコードされるか（`plan`）、どんな警告が出るか（`warnings`）を事前検証します。
* **`convert()`:** 変換を実行し、`{ blob, format, mimeType, filename, plan, warnings }` を返します。`audio: { replace: musicBlob }` のように指定すれば、映像を一切再エンコードせずに音声トラックだけを差し替えることも可能です。

#### `edit(project, target)`
複数のクリップや音声トラックをタイムライン上で編集・結合します。
* 同じコーデック設定かつキーフレームから始まるクリップ同士は、再エンコードなしのパケットコピーで高速かつギャップレスに結合されます。
* クリップごとに `start`, `end`, `speed`（再生速度）、`audio: { volume, fade: { in, out }, speed: 'shift-pitch' }`、`video: { rotate, flip, crop }` などを指定できます。
* BGMトラック（`project.audio`）には `offset`（開始位置）や `loop: true`（ループ再生）を設定でき、音量がフルスケール（1.0）を超える場合は内蔵リミッターが波形を潰さずに自動でピークを抑えます。

#### `frames(input, options?)` と `thumbnail(input, options?)`
* **`frames()`:** デコードされた映像フレームを順次返す非同期ジェネレータです。
* **`thumbnail()`:** 指定した `time`（秒）のフレームを静止画フォーマット（PNG, BMP, TIFF, ICO, WebP, JPEG, AVIF など）として書き出します。

#### `encodeFrames(source, options)` と `recordStream(stream, options)`
* **`encodeFrames()`:** `VideoFrame` や `AudioData` の非同期イテラブルを受け取り、コンテナへエンコードします。渡されたフレームはエンコード後にライブラリ側で自動的に `.close()` されるため、メモリリークの心配がありません。
* **`recordStream()`:** `<canvas>` やカメラの `MediaStream` をリアルタイムに録画し、`recording.stop()` でファイルを取得します。

### 2.4 ステージパイプライン (`mediaforgejs/parts`)

変換や編集時に内部で動く処理ステージは、`mediaforgejs/parts` から単体で呼び出したり、自作ステージを `video.stages` / `audio.stages` に追加したりできます。

* **映像ステージ (`transform`, `frameRate`):**
  * 90度単位の回転、反転、クロップ、リサイズ（`contain` / `cover` / `fill`）、背景色指定（`#00ff00` などの16進カラーコード — CanvasがないNode環境でも解釈可能）に対応。
  * 4:2:0（I420）フレームのクロマグリッド（偶数座標）に沿ったクロップは、ピクセルコピーを行わないゼロコピーの可視領域変更として高速処理されます。
* **音声ステージ (`remix`, `timeStretch`):**
  * `remix()` はソースのスピーカー配置マスク（`channelMask`）を認識し、5.1chからステレオへのダウンミックスやモノラル化、サンプリングレート変換を行います。
  * `timeStretch()` は0.05倍〜20倍の範囲で、ピッチ（音程）とアタック感を保ったまま長さを伸縮させます。

### 2.5 エラーコードとオプションポリシー

MediaForgeJS が投げるエラーはすべて `MediaForgeError` インスタンスであり、プログラムで判別しやすい `.code` と、解決方法を示す `.hint` を持っています。

* **`PLUGIN`:** 必要なプラグインが読み込まれていません。`error.plugin` に不足しているプラグイン名（例: `'avi'`, `'mpeg4'`）が入っているため、どのプラグインを追加すべきか一目で分かります。
* **`INPUT`:** 引数不正、または `optionPolicy: 'strict'` 時に範囲外のオプションが渡された場合に発生します。デフォルトの `lenient` モードでは、タイポや範囲外の値は自動補正され、`warnings` に `OPTION_NORMALIZED` や `OPTION_UNKNOWN` として記録されます。
* **`FORMAT` / `DEMUX` / `DECODE` / `ENCODE` / `IO` / `OOM` / `ABORT`:** それぞれのフェーズに応じた明確なコードが返されます。

### 2.6 対応フォーマット・コーデック一覧 (Formats and codecs)

以下のサポート表は、テストスイート（サポートマトリクス）から `npm run support -- --docs` によって自動生成・検証されます。

<!-- support-table ja: written by npm run support -- --docs -->

**ライブラリが宣言するすべて（対応表から生成）**

| 入れ物 | 読む | 書く | コピーする動画 | コピーする音声 |
| --- | --- | --- | --- | --- |
| `3gp` | ✔ | ✔ | `avc1` `avc3` `mpeg4v` | `mp4a` `evrc` `qcelp` |
| `aac` | ✔ | ✔ | – | – |
| `ac3` | ✔ |  | – | – |
| `aiff` | ✔ | ✔ | – | – |
| `apv` | ✔ | ✔ | `apv1` | – |
| `asf` | ✔ |  | – | – |
| `au` | ✔ | ✔ | – | – |
| `av1` | ✔ |  | – | – |
| `avi` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `mpeg1v` `mpeg2v` `mpeg4v` `wmv1` `wmv2` `wmv3` `vc1` `dvvideo` `mjpeg` | `pcm` `pcm-s16le` `mp1` `mp2` `mp3` `ac-3` `wmav1` `wmav2` `wmapro` `wmalossless` `wmavoice` |
| `caf` | ✔ | ✔ | – | – |
| `dts` | ✔ |  | – | – |
| `eac3` | ✔ |  | – | – |
| `flac` | ✔ | ✔ | – | – |
| `flv` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `av01` | `mp4a` |
| `iamf` | ✔ | ✔ | – | `iamf` |
| `ivf` | ✔ | ✔ | `av01` `vp8` `vp9` `vp09` | – |
| `m4a` | ✔ | ✔ | – | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `evrc` `qcelp` `mhm1` `mha1` `iamf` |
| `m4v` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mkv` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp8` `vp9` `vp09` `theora` `apco` `apcs` `apcn` `apch` `ap4h` `ap4x` `mpeg1v` `mpeg2v` `mpeg4v` `wmv1` `wmv2` `wmv3` `vc1` `dvvideo` `mjpeg` | `mp4a` `opus` `vorbis` `flac` `alac` `ulaw` `alaw` `mp1` `mp2` `mp3` `ac-3` `ec-3` `dtsc` `dtsh` `dtsl` `dtse` `mlpa` `pcm` `pcm-u8` `pcm-s16le` `pcm-s24le` `pcm-s32le` `pcm-s16be` `pcm-s24be` `pcm-s32be` `pcm-f32le` `pcm-f64le` `wmav1` `wmav2` `wmapro` `wmalossless` `wmavoice` |
| `mov` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `apco` `apcs` `apcn` `apch` `ap4h` `ap4x` `aprn` `aprh` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `ulaw` `alaw` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-u8` `pcm-s8` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mp1` | ✔ | ✔ | – | – |
| `mp2` | ✔ | ✔ | – | – |
| `mp3` | ✔ | ✔ | – | – |
| `mp4` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `dvh1` `dvhe` `vvc1` `vvi1` `av01` `vp9` `vp09` `apv1` `mpeg1v` `mpeg2v` `mpeg4v` `mjpeg` | `mp4a` `ac-3` `ec-3` `alac` `flac` `opus` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` `mlpa` `evrc` `qcelp` `mhm1` `mha1` `iamf` `pcm` `pcm-s16le` `pcm-s16be` `pcm-s24le` `pcm-s24be` `pcm-s32le` `pcm-s32be` `pcm-f32le` `pcm-f32be` `pcm-f64le` `pcm-f64be` |
| `mpeg` | ✔ |  | – | – |
| `mxf` | ✔ |  | – | – |
| `obu` | ✔ |  | – | – |
| `oga` | ✔ |  | – | – |
| `ogg` | ✔ | ✔ | – | `opus` `flac` |
| `ogv` | ✔ |  | – | – |
| `opus` | ✔ |  | – | – |
| `ps` | ✔ |  | – | – |
| `truehd` | ✔ |  | – | – |
| `ts` | ✔ | ✔ | `avc1` `avc3` `hvc1` `hev1` `vvc1` `vvi1` `av01` `vc1` `mpeg1v` `mpeg2v` `mpeg4v` | `mp4a` `ac-3` `ec-3` `mp1` `mp2` `mp3` `dtsc` `dtsh` `dtsl` `dtse` |
| `vob` | ✔ |  | – | – |
| `wav` | ✔ | ✔ | – | – |
| `webm` | ✔ | ✔ | `av01` `vp8` `vp9` `vp09` | `opus` `vorbis` |
| `wma` | ✔ |  | – | – |
| `wmv` | ✔ |  | – | – |

- ライブラリが復号する: `pcm` `ulaw` `alaw` `ima4` `mp4a` `mp1` `mp2` `mp3` `flac` `alac` `opus` `vorbis` `ac-3` `ec-3` `uncompressed` `h264` `mpeg2video` `mpeg4-part2` `apv`
- ライブラリが符号化する: `aac` `mp2` `mp3` `flac`
- ライブラリが読んで復号する画像形式: `apng` `gif` `png` `tiff` `webp`
- 読む画像形式（復号はできる場合にホスト）: `avif` `bmp` `heif` `ico` `jpeg` `jxl`
- ライブラリが書く画像形式: `apng` `bmp` `gif` `ico` `png` `tiff`
- ホストのキャンバスが書く画像形式（できる場合）: `avif` `heif` `jpeg` `jxl` `webp`
- パッケージ化の対象: `hls` `dash` `hls+dash`
- `mediaforgejs-player` が再生する: `hls` `dash`
- ホストのWebCodecsが復号する（できる場合）: `aac` `mp3` `opus` `flac` `vorbis` `ac-3` `ec-3` `ulaw` `alaw` `avc1` `hvc1` `vp8` `vp09` `av01`
- ホストのWebCodecsが符号化する（できる場合）: `opus` `vorbis` `avc1` `hvc1` `vp8` `vp09` `av01`
- 仕様から組み立てたストリームでコピーを確かめる（コピーが運ぶことを確かめ、復号できることは確かめない）: `dvh1` `dvhe` `vvc1` `vvi1` `wmv3` `vc1` `dtsh` `dtsl` `dtse` `evrc` `qcelp` `mhm1` `mha1` `wmapro` `wmalossless` `wmavoice`

<!-- /support-table ja -->

---

<a name="guide-ru"></a>

## 3. Руководство на русском

### 3.1 Архитектура и принципы работы

Главная задача MediaForgeJS — **выполнять минимально разрушительную обработку данных, гарантируя корректный выходной файл.**

Любая операция (`convert()`, `edit()`, `packageMedia()`) проходит три этапа:

1. **Анализ и демультиплексирование:** Библиотека читает только необходимые участки файла через интерфейс источника (`Source`), пропускает битые метаданные в начале потока, находит заголовки фреймов и извлекает таблицы пакетов, теги и главы.
2. **Планирование (`plan`):** Планировщик проверяет совместимость исходных дорожек с целевым контейнером. Если дорожку не нужно масштабировать, обрезать мимо ключевого кадра или менять частоту дискретизации, выбирается действие `copy` (прямое копирование пакетов). В противном случае строится цепочка стадий (`stages`) и кодировщика (`encode`).
3. **Выполнение и мультиплексирование:** Пакеты копируются или проходят через декодер, стадии обработки и кодер в приёмник данных (`MemorySink` или потоковый `FileSink`).

### 3.2 Точки входа и плагины

Поскольку скомпилированная директория `dist/` уже находится в репозитории, вы можете импортировать модули как по имени пакета, так и напрямую из `./dist/esm/api/entries/`:

* **`mediaforgejs`:** Полная сборка со всеми стандартными плагинами контейнеров и кодеков.
* **`mediaforgejs/lite`:** Облегчённое ядро без тяжёлых плагинов. Если при работе в `lite`-режиме встретится формат, требующий плагина (например, AVI или MPEG-4 Part 2), библиотека выбросит ошибку с кодом `PLUGIN` и точным именем нужного плагина в свойстве `error.plugin`.
* **`mediaforgejs/plugins`:** Набор независимых плагинов (`aac`, `ac3`, `alac`, `apv`, `asf`, `avi`, `flac`, `flv`, `h264`, `iamf`, `ivf`, `mpeg12`, `mpeg4`, `mpegAudio`, `mpegPs`, `mxf`, `opus`, `vorbis`).

### 3.3 Работа с файловой системой (Node.js и Deno)

Для обработки больших файлов без загрузки всего объёма в оперативную память используйте потоковые источники и приёмники из `mediaforgejs/runtime/node` (или `mediaforgejs/runtime/deno`):

```javascript
import { convert } from 'mediaforgejs';
import { FileSource, FileSink } from 'mediaforgejs/runtime/node';

const source = await FileSource.open('./input.mkv');
const sink = await FileSink.open('./output.mp4');

try {
  await convert(source, 'mp4', { copy: true, sink });
} finally {
  await source.close();
  await sink.close();
}

```

`FileSink` автоматически группирует мелкие записи в буферы по 64 КиБ, поддерживает произвольные патчи заголовков (`patchAt` — например, для записи `STREAMINFO` с MD5-хешем при потоковом кодировании FLAC) и корректно обрабатывает обратное давление (`drain()`).
