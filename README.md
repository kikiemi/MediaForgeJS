# MediaForgeJS

**[English](#english) | [日本語](#japanese) | [Русский](#russian)**

---

<a name="english"></a>

## MediaForgeJS (English)

Media inspection, conversion, editing, streaming packaging, and playback for the browser, Node.js, and Deno—without external runtime dependencies.

### The Philosophy (Why Another Media Library?)

If you have ever tried to process video or audio in JavaScript, you already know the two traditional paths of sorrow:

1. **The Server Path:** Upload a 500 MB video file to a backend server just to trim the first three seconds, pay a cloud provider the price of a small sandwich for the bandwidth, and pray your `child_process` spawning `ffmpeg` doesn't hang because someone uploaded a Matroska file with a cursed subtitle track.
2. **The WASM Monolith Path:** Force your users to download a 30 MB WebAssembly blob on a 3G connection just to find out whether an MP3 file is stereo or mono, watching their browser tab slowly consume all available RAM until the OS puts it out of its misery.

**MediaForgeJS** takes a third path. It is a pure, self-contained JavaScript and TypeScript media toolkit that respects both your bundle size and your sanity. 

When the host environment (like a modern browser) offers hardware-accelerated **WebCodecs**, MediaForgeJS happily uses them. When the host does not (like Node.js, Deno, or a browser that refuses to cooperate), MediaForgeJS smoothly falls back to its own built-in software decoders, encoders, demuxers, and muxers. And when two containers share a compatible stream, it copies packets directly without re-encoding a single pixel or sample.

---

### What Can It Actually Do?

MediaForgeJS is not just a wrapper around a single API; it is a full media pipeline packed into a modular library:

* **Deep Media Inspection (`inspect`, `open`):** Detect file formats from raw byte signatures—even when an MP3 file has a broken 20 KB ID3v2 album art tag sitting in front of the first frame, or when an MPEG-TS stream has lost its synchronization. Read track layouts, codec strings, bitrates, sample counts, chapters, cover art, and container tags.
* **Smart Conversion & Remuxing (`convert`, `check`):** Convert between dozens of video, audio, and image formats. If the target container already supports the input codec (for example, moving H.264 and AAC from MKV to MP4), MediaForgeJS performs a lossless packet copy at disk speed. You can run `check()` beforehand to get a complete execution plan without writing a single byte.
* **Non-Linear Timeline Editing (`edit`):** Join multiple clips, trim ranges, change playback speed, and mix multiple background audio tracks. Clips that start on keyframes with matching codec configurations are stitched together at the packet level without re-encoding; only the segments that actually require pixel or sample changes are re-encoded.
* **Audio DSP & Mastering Pipeline:** Includes built-in multi-channel speaker matrix remixing (such as folding 5.1 surround down to stereo using ITU-R BS.775 weights while properly handling LFE), pitch-preserving time-stretching, sample rate conversion, volume attenuation, fade-in/out, looping, and a lookahead peak limiter so your mixed tracks never clip into digital distortion.
* **Video Geometry & Stage Pipeline (`frames`, `thumbnail`, `transform`):** Extract decoded video frames as RGBA buffers or `VideoFrame` objects. Generate poster thumbnails. Crop on the chroma grid (zero-copy when possible), rotate in 90-degree increments, flip horizontally or vertically, resize with aspect-ratio containment/covering, and pad with custom hex background colors.
* **Streaming Packaging & MSE Playback (`packageMedia`, `play`, `createPlayer`):** Slice media into **HLS** (`m3u8` + `ts` or `fmp4` segments) or **MPEG-DASH** (`mpd`) presentations in memory or directly to disk, complete with WebVTT subtitle segmentation. Play them back in the browser using the companion player plugin.
* **Live Recording & Frame Encoding (`encodeFrames`, `recordStream`):** Turn an async generator of `VideoFrame` / `AudioData` objects or a live `MediaStream` (from a `<canvas>`, webcam, or microphone) directly into an MP4, WebM, MKV, or audio file with automatic encoder delay (pre-skip) compensation.

---

### Key Architectural Features

* **Pre-built `dist/` Included in the Repository:** We believe you shouldn't have to fight a build toolchain just to try a library. The `dist/` directory is committed and ready to use. Clone the repository, point a `<script>` tag or an ES module `import` at `dist/`, and start forging media immediately.
* **Modular Entry Points (`mediaforgejs` vs `mediaforgejs/lite`):** Use the default entry for the full suite of containers and codecs, or import `mediaforgejs/lite` for a minimal core and cherry-pick only the plugins (`avi`, `flac`, `aac`, `h264`, `mpegAudio`, etc.) your application actually needs.
* **Graceful Codec Routing & Concealment:** The router tries hardware/host `WebCodecs` first and falls back to built-in codecs automatically if the host fails mid-stream. Damaged audio frames or lost Opus packets are concealed in place so your timeline never drifts out of sync.
* **Lenient by Default, Strict on Command:** Passed `{ fsp: 60 }` instead of `{ fps: 60 }`? In default (`lenient`) mode, MediaForgeJS normalizes out-of-range options, repairs odd crop dimensions, and emits a structured warning (`OPTION_UNKNOWN: did you mean fps?`). Set `optionPolicy: 'strict'` when you want it to throw an `INPUT` error instead.
* **Universal I/O (`MemorySink`, `FileSource`, `FileSink`, `FFmpegBackend`):** Process `Blob`, `Uint8Array`, or custom range-readers in memory, or stream gigabytes of media through Node.js and Deno file handles with automatic write batching and backpressure (`drain()`). If you happen to have native `ffmpeg` installed on a server, `mediaforgejs/runtime/ffmpeg` can drive it through the exact same interface.

---

### Installation & Setup

Because `dist/` is included directly in the repository, you have several ways to load MediaForgeJS depending on how much you trust `npm` today.

#### 1. Direct from GitHub or npm

```bash
npm install github:kikiemi/MediaForgeJS
# or once published to npm:
npm install mediaforgejs

```

#### 2. Directly in the Browser (No Bundler Required)

Since `dist/` is right there in the repo, you can serve `dist/MediaForgeJS.min.js` (or `dist/MediaForgeJS.lite.min.js`) directly:

```html
<!-- Classic UMD/IIFE bundle -->
<script src="./dist/MediaForgeJS.min.js"></script>

<!-- Or as standard ES Modules directly from dist/ -->
<script type="module">
  import { inspect, convert, edit } from './dist/esm/api/entries/index.js';
</script>

```

---

### Quick Start

#### 1. Inspecting a Media File

Find out what is inside a file without decoding the whole thing:

```javascript
import { inspect } from 'mediaforgejs';

const info = await inspect(fileOrBlob, { sampleCounts: true });

console.log(`Format: ${info.format}, Duration: ${info.duration}s`);
for (const track of info.tracks) {
  console.log(`Track #${track.id} [${track.type}]: codec=${track.codec}`);
}

```

#### 2. Converting & Remuxing

Convert a file to another format. If the streams are compatible, MediaForgeJS copies the packets automatically:

```javascript
import { convert, check } from 'mediaforgejs';

// Optional: Check what MediaForgeJS plans to do before running the conversion
const report = await check(inputBlob, { to: 'mp4', audio: { bitrate: '128k' } });
if (report.supported) {
  console.log('Execution plan:', report.plan);
}

// Run the conversion
const result = await convert(inputBlob, {
  to: 'mp4',
  video: {
    width: 1280,
    height: 720,
    fit: 'contain',
    background: '#000000',
  },
  audio: {
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
  },
  onProgress: event => {
    console.log(`Progress: ${(event.fraction * 100).toFixed(1)}%`);
  },
});

// result.blob is ready for download or upload

```

#### 3. Non-Linear Editing & Audio Mixing

Join clips, trim them, adjust speeds without ruining the pitch, and loop background music under the video:

```javascript
import { edit } from 'mediaforgejs';

const { blob, plan, warnings } = await edit(
  {
    clips: [
      {
        input: introMp4,
        start: 0.5,
        end: 5.0,
        audio: { fade: { in: 0.5 } },
      },
      {
        input: mainClipMp4,
        speed: 1.5, // Time-stretches audio while keeping the original pitch!
        audio: { volume: 0.8 },
      },
    ],
    audio: [
      {
        input: bgmMp3,
        offset: 0,
        loop: true,
        volume: 0.25,
      },
    ],
  },
  {
    to: 'mp4',
    audio: { sampleRate: 48000, channels: 2 },
  }
);

```

#### 4. Packaging for HLS or DASH

Turn an MP4 into an HLS presentation ready for any static file server:

```javascript
import { packageMedia } from 'mediaforgejs';
import { writePackageToDirectory } from 'mediaforgejs/runtime/node';

const presentation = await packageMedia(movieBlob, 'hls', {
  container: 'ts',
  targetDuration: 4,
});

// In the browser, presentation.files is a Map of filenames to file data.
// In Node.js, you can write the entire presentation straight to a directory:
await writePackageToDirectory(presentation.files.values(), './public/stream', {
  overwrite: true,
});

```

#### 5. Using the Lite Entry & Plugins

Keep your bundle lean by loading only what you need:

```javascript
import { MediaForge } from 'mediaforgejs/lite';
import { flac, avi } from 'mediaforgejs/plugins';

const forge = new MediaForge({
  plugins: [flac, avi],
});

const { blob } = await forge.convert(aviBlob, 'flac');

```

---

### Subpath Exports Overview

| Import Path | Description |
| --- | --- |
| `mediaforgejs` | Default entry with core + all standard format and codec plugins. |
| `mediaforgejs/lite` | Minimal core entry (MP4, MOV, MKV, WebM, TS, Ogg, WAV, AIFF, CAF, AU, etc.) without heavy plugins. |
| `mediaforgejs/plugins` | Individual plugins (`aac`, `ac3`, `alac`, `apv`, `asf`, `avi`, `flac`, `flv`, `h264`, `iamf`, `ivf`, `mpeg12`, `mpeg4`, `mpegAudio`, `mpegPs`, `mxf`, `opus`, `vorbis`). |
| `mediaforgejs/parts` | Low-level pipeline building blocks (`decodeAudio`, `createMuxer`, `stageAudio`, `remix`, `timeStretch`, `transform`, `frameRate`). |
| `mediaforgejs/codecs` | Direct access to standalone encoders/decoders (`encodeAacLc`, `encodeFlac`, `encodeMp3`, `encodeMp2`, `encodePng`, `AnimatedGifEncoder`, `ApngEncoder`, etc.). |
| `mediaforgejs/formats` | Format detection (`detectFormat`, `detectSourceFormat`) and direct Muxer/Demuxer classes. |
| `mediaforgejs/io` | `MemorySink` and stream I/O primitives. |
| `mediaforgejs/runtime/node` | Node.js `FileSource`, `FileSink`, and `writePackageToDirectory`. |
| `mediaforgejs/runtime/deno` | Deno `FileSource` and file system integration. |
| `mediaforgejs/runtime/ffmpeg` | `FFmpegBackend` for driving native `ffmpeg`/`ffprobe` binaries when available. |

---

### License

Licensed under the **WTFPL** (Do What The Fuck You Want To Public License). See the `LICENSE` file for the full legal masterpiece.

---

---
<a name="japanese"></a>
## MediaForgeJS (日本語)

外部ランタイム一切不要。ブラウザ、Node.js、Denoのすべてで動作する、メディア解析・変換・非破壊編集・ストリーミングパッケージング・再生ライブラリ。

### 開発の背景（なぜまたメディアライブラリを作ったのか）

JavaScriptで動画や音声を扱おうとしたことがある方なら、これまで人類が歩んできた「2つの茨の道」をご存知のはずです。

1. **サーバー丸投げの道:** たった3秒の動画をトリミングするためだけに500MBのMP4をバックエンドへアップロードさせ、クラウド事業者に昼食代くらいの通信費を貢ぎ、誰かがアップロードした謎のエンコードのMKVファイルによってサーバー上の `ffmpeg` プロセスがゾンビ化するのを祈りながら見守る道。
2. **巨大WASMモノリスの道:** 「このMP3ファイルがステレオかモノラルか調べる」という控えめな目的のために、ユーザーに30MBを超えるWebAssemblyバイナリをダウンロードさせ、ブラウザのメモリがみるみる溶けてタブがクラッシュするのを眺める道。

**MediaForgeJS** は「第3の道」を行きます。外部バイナリに依存せず、純粋なJavaScript / TypeScriptで構築された、あなたのバンドルサイズと精神衛生を尊重するメディアツールキットです。

モダンブラウザのようにホスト環境がハードウェアアクセラレーション対応の **WebCodecs** を提供している場合は、それを最大限に活用します。一方、Node.jsやDeno、あるいはWebCodecs非対応の環境では、ライブラリ内蔵のソフトウェアデコーダ・エンコーダ・デマルチプレクサ・マルチプレクサへとシームレスにフォールバックします。さらに、変換先のコンテナが元のコーデックをそのまま格納できる場合は、1ピクセルも1サンプルも再エンコードせず、パケットをそのまま高速コピー（リマックス）します。

---

### MediaForgeJS で何ができるのか？

単なるAPIラッパーではなく、メディア処理パイプラインのすべてが1つのライブラリに詰まっています。

* **徹底的なメディア解析 (`inspect`, `open`):** ファイル先頭のバイト列（マジックナンバーや同期ワード）からフォーマットを自動判別します。先頭に壊れた20KBのID3v2アルバムアートが付いたMP3だろうと、ヘッダのない生ストリームだろうと、粘り強くフレームを探し出します。トラック構成、コーデック種別、サンプル数、チャプター、カバーアート、各種メタデータタグを正確に読み取ります。


* **スマートな変換とロスレスコピー (`convert`, `check`):** 多数の動画・音声・画像フォーマット間の相互変換に対応。入力と出力のコンテナ間でコーデックに互換性がある場合（例：MKV内のH.264 + AACをMP4へ移す場合など）、再エンコードをスキップしてパケットをそのままコピーします。実際に変換を始める前に `check()` を呼べば、1バイトも書き出さずに「どのトラックがコピーされ、どのトラックが再エンコードされるか」という実行プラン（`plan`）を確認できます。


* **ノンリニア編集とスマート結合 (`edit`):** 複数の動画クリップの結合、トリミング、再生速度の変更、BGMトラックのミキシングを行えます。同じコーデック設定を持ちキーフレームから始まるクリップ同士であれば、パケットレベルでギャップなく結合し、キーフレーム外でカットされた箇所やエフェクトが必要な箇所だけを再エンコードします。


* **本格的なオーディオDSP・マスタリング処理:** 5.1chサラウンドからステレオへのダウンミックス（ITU-R BS.775係数に準拠し、スピーカーマスクも考慮）、ピッチを維持したままのタイムストレッチ（再生速度変更）、リサンプリング、音量調整、フェードイン・フェードアウト、BGMのオフセット指定ループ、さらに複数トラックを大音量でミックスしても波形がクリップして音割れしないためのリミッターまで内蔵しています。


* **映像ジオメトリ変換とステージパイプライン (`frames`, `thumbnail`, `transform`):** 動画からデコード済みフレームをRGBAバッファまたは `VideoFrame` として順次取り出すイテレータや、指定秒数のサムネイル画像生成に対応。クロマグリッドに沿ったゼロコピークロップ、90度単位の回転、上下左右の反転、アスペクト比を維持したリサイズ（`contain` / `cover`）、背景色パディングなどを一貫して処理します。


* **ストリーミング配信用パッケージングと再生 (`packageMedia`, `play`, `createPlayer`):** メディアファイルを **HLS**（`m3u8` + `ts` または `fmp4` セグメント）や **MPEG-DASH**（`mpd`）形式にメモリ上またはディレクトリへ直接パッケージングします。さらにプレイヤープラグインを使えば、ブラウザの Media Source Extensions (MSE) を通じてそのまま再生可能です。


* **リアルタイム録画・フレームエンコード (`encodeFrames`, `recordStream`):** `<canvas>` やWebカメラから得られる `MediaStream`、あるいは自作の `VideoFrame` / `AudioData` の非同期ジェネレータを直接MP4やWebM、MKV、音声ファイルへエンコードします。OpusやAACなどのエンコーダ遅延（プリスキップ）もコンテナ側で正確に補正されます。



---

### 設計上の特徴

* **ビルド済みの `dist/` をリポジトリに同梱:** 「ライブラリをちょっと試したいだけなのに、まずビルド環境の構築とTypeScriptのバージョン合わせで半日潰れる」という悲劇をなくすため、本リポジトリには最初からビルド済みの `dist/` が含まれています。クローンしてそのままブラウザの `<script>` タグや `import` で読み込めます。


* **用途に応じたエントリ分割 (`mediaforgejs` と `mediaforgejs/lite`):** すべての標準プラグイン入りのデフォルトエントリだけでなく、コア機能だけに絞った `mediaforgejs/lite` を用意。必要なフォーマットやコーデックのプラグイン（`flac`, `aac`, `avi`, `h264` など）だけを選んで追加できます。


* **賢いコーデックルーターとエラー隠蔽（コンシールメント）:** ホスト環境に `WebCodecs` があれば優先的に利用し、途中でホスト側のデコーダやエンコーダがエラーを吐いた場合は、即座に内蔵ソフトウェア処理へ引き継ぎます。また、破損した音声パケットや欠落したOpusパケットがあっても、タイムラインがズレないよう無音補間やパケットロス隠蔽（PLC）を行って最後まで処理を完走します。


* **普段は寛容、求められれば厳格 (`lenient` / `strict`):** うっかり `{ fps: 60 }` を `{ fsp: 60 }` とタイポしても、デフォルトの `lenient` モードでは処理を止めず、`OPTION_UNKNOWN: did you mean fps?` という親切な警告を出しつつ処理を続行します。奇数のクロップサイズなども自動で偶数に丸めて報告します。一切の妥協を許したくない場合は `optionPolicy: 'strict'` を指定すれば即座にエラーとして弾くことができます。


* **環境を選ばないI/O設計:** メモリ上の `Blob` や `Uint8Array` だけでなく、Node.jsやDenoのファイルシステムと直結する `FileSource` / `FileSink` を提供。64KiB単位の書き込みバッチ処理や適切なバックプレッシャー制御（`drain()`）により、巨大なファイルもメモリを食い潰さずに高速処理できます。



---

### インストールと導入方法

リポジトリ内に `dist/` が含まれているため、用途に合わせて好きな方法で導入できます。

#### 1. GitHub または npm からインストール

```bash
npm install github:kikiemi/MediaForgeJS
# npm公開後:
npm install mediaforgejs

```

#### 2. ブラウザから直接読み込む（バンドラ不要）

リポジトリ内の `dist/` にあるバンドルファイルをそのままHTMLから読み込めます。

```html
<!-- 単一ファイルのminバンドルとして読み込む場合 -->
<script src="./dist/MediaForgeJS.min.js"></script>

<!-- ES Modulesとしてdist/から直接インポートする場合 -->
<script type="module">
  import { inspect, convert, edit } from './dist/esm/api/entries/index.js';
</script>

```

---

### クイックスタート

#### 1. メディアファイルの構造を調べる (`inspect`)

ファイル全体をデコードすることなく、コンテナフォーマットやトラック情報を瞬時に取得します。

```javascript
import { inspect } from 'mediaforgejs';

const info = await inspect(fileOrBlob, { sampleCounts: true });

console.log(`フォーマット: ${info.format}, 長さ: ${info.duration}秒`);
for (const track of info.tracks) {
  console.log(`トラック #${track.id} [${track.type}]: codec=${track.codec}`);
}

```

#### 2. フォーマット変換とリサイズ (`convert`, `check`)

変換前に `check()` で処理計画を確認し、`convert()` で変換を実行します。タグやチャプター、カバー画像も可能な限り変換先へ引き継がれます。

```javascript
import { convert, check } from 'mediaforgejs';

// 事前に変換プランを確認（ファイル書き出しは行われません）
const report = await check(inputBlob, { to: 'mp4', audio: { bitrate: '128k' } });
if (report.supported) {
  console.log('実行プラン:', report.plan);
}

// 変換を実行
const result = await convert(inputBlob, {
  to: 'mp4',
  video: {
    width: 1280,
    height: 720,
    fit: 'contain',
    background: '#000000',
  },
  audio: {
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
  },
  onProgress: event => {
    console.log(`進捗: ${(event.fraction * 100).toFixed(1)}%`);
  },
});

```

#### 3. クリップの結合・速度変更・BGMミキシング (`edit`)

複数の動画クリップを繋ぎ合わせ、ピッチを保ったまま倍速再生したり、フェードやBGMループを重ねたりできます。

```javascript
import { edit } from 'mediaforgejs';

const { blob, plan, warnings } = await edit(
  {
    clips: [
      {
        input: clipA,
        start: 0.5,
        end: 2.0,
        audio: { fade: { in: 0.5 } },
      },
      {
        input: clipB,
        end: 1.0,
        speed: 2.0, // デフォルトでピッチを維持したまま2倍速にタイムストレッチされます
        audio: { volume: 0.25 },
      },
    ],
    audio: [
      {
        input: musicMp3,
        start: 3.5,
        offset: 1.0, // 1秒地点からBGMを開始
        loop: true,  // 動画の最後までループ
        volume: 0.5,
      },
    ],
  },
  {
    to: 'mp4',
    audio: { sampleRate: 48000, channels: 2 },
  }
);

```

#### 4. HLS / DASH ストリーミングパッケージの作成 (`packageMedia`)

MP4などのメディアから、そのまま配信サーバーに置けるHLSプレイリストとセグメント群を生成します。

```javascript
import { packageMedia } from 'mediaforgejs';
import { writePackageToDirectory } from 'mediaforgejs/runtime/node';

const pack = await packageMedia(movieBlob, 'hls', {
  container: 'ts',
  targetDuration: 2,
});

// Node.js環境なら、生成されたファイル群を一括でディレクトリに書き出せます（パストラバーサル防止チェック付き）
await writePackageToDirectory(pack.files.values(), './output/hls', {
  overwrite: true,
});

```

#### 5. Liteエントリとプラグインの選択読み込み

必要な機能だけを組み合わせてバンドルサイズを最小限に抑えられます。

```javascript
import { MediaForge } from 'mediaforgejs/lite';
import { flac, avi } from 'mediaforgejs/plugins';

const forge = new MediaForge({
  plugins: [flac, avi],
});

const { blob } = await forge.convert(aviBlob, 'flac');

```

---

### ライセンス

本ライブラリは **WTFPL** (Do What The Fuck You Want To Public License) の下で公開されています。煮るなり焼くなり、お好きなようにお使いください。

---

---
<a name="russian"></a>

## MediaForgeJS (Русский)

Анализ, конвертация, нелинейный монтаж, упаковка для стриминга и воспроизведение медиафайлов в браузере, Node.js и Deno — без внешних зависимостей и сторонних рантаймов.

### Философия проекта

Если вам когда-либо приходилось обрабатывать видео или звук на JavaScript, вы наверняка знакомы с двумя классическими путями страданий:

1. **Путь сервера:** Заставить пользователя загрузить 500-мегабайтный видеофайл на бэкенд ради обрезки первых трёх секунд, оплатить облачному провайдеру трафик по цене хорошего обеда и молиться, чтобы дочерний процесс `ffmpeg` не завис навсегда из-за кривой дорожки субтитров в очередном MKV.
2. **Путь гигантского WASM-монолита:** Заставить браузер клиента скачивать 30 МБ WebAssembly через мобильный интернет только ради того, чтобы узнать битрейт MP3-файла, а затем наблюдать, как вкладка пожирает всю оперативную память и падает.

**MediaForgeJS** предлагает третий путь. Это полностью автономный инструментарий на чистом JavaScript и TypeScript, который бережёт как размер вашего бандла, так и ваши нервные клетки.

Когда среда выполнения (например, современный браузер) предоставляет аппаратное ускорение через **WebCodecs**, MediaForgeJS с удовольствием использует его. Когда WebCodecs недоступны (в Node.js, Deno или старых браузерах), библиотека прозрачно переключается на собственные встроенные программные декодеры, кодеры, демультиплексоры и мультиплексоры. А если целевой контейнер поддерживает исходный кодек напрямую, MediaForgeJS просто копирует пакеты данных без перекодирования единого пикселя или сэмпла.

---

### Что именно умеет библиотека?

MediaForgeJS — это не просто обёртка над одним API, а полноценный конвейер обработки медиа:

* **Глубокий анализ медиаданных (`inspect`, `open`):** Определение формата по первым байтам и сигнатурам потока — даже если перед аудиофреймами MP3 застрял повреждённый ID3v2-тег с обложкой на 20 КБ, или если контейнер MP4 начинается с огромного блока `free` перед `moov`. Чтение параметров дорожек, кодеков, битрейта, глав (chapters), обложек и метаданных.


* **Умная конвертация и ремуксинг (`convert`, `check`):** Преобразование между десятками видео-, аудио- и графических форматов. Если перекодирование не требуется, выполняется прямое копирование потоков (`copy`) с сохранением таймингов и ключевых кадров. Функция `check()` позволяет заранее получить точный план выполнения (`plan`) без записи данных.


* **Нелинейный монтаж и склейка (`edit`):** Объединение нескольких клипов, обрезка по времени, изменение скорости и сведение фоновой музыки. Клипы с одинаковыми параметрами кодека, начинающиеся с ключевого кадра, склеиваются на уровне пакетов без потери качества; перекодируются только те участки, где это действительно необходимо.


* **Обработка звука и мастеринг:** Встроенное сведение многоканального звука (например, 5.1 в стерео по стандарту ITU-R BS.775 с учётом маски каналов и отсечением LFE), изменение скорости без искажения высоты тона (`time-stretch`) или со сдвигом тона (`shift-pitch`), ресэмплинг, фейды, зацикливание музыки и встроенный лимитер, предотвращающий клиппинг при сложении громких дорожек.


* **Геометрия видео и покадровая обработка (`frames`, `thumbnail`, `transform`):** Извлечение кадров в виде массивов RGBA или объектов `VideoFrame`, генерация превью (`thumbnail`). Кадрирование (без копирования памяти при попадании в сетку цветности 4:2:0), поворот кратно 90 градусам, отражение, масштабирование с режимами `contain` / `cover` и заливкой фона.


* **Упаковка для стриминга и воспроизведение (`packageMedia`, `play`, `createPlayer`):** Генерация пакетов **HLS** (`m3u8` + сегменты `ts` или `fmp4`) и **MPEG-DASH** (`mpd`) прямо в памяти или на диске, а также воспроизведение через Media Source Extensions (MSE) с помощью плагина плеера.


* **Запись потоков и кодирование кадров (`encodeFrames`, `recordStream`):** Запись `MediaStream` (с холста `<canvas>`, камеры или микрофона) или асинхронного генератора `VideoFrame` / `AudioData` напрямую в файл MP4, WebM, MKV или аудиоформаты с точной компенсацией задержки кодера (pre-skip).



---

### Ключевые особенности архитектуры

* **Готовая папка `dist/` прямо в репозитории:** Вам не нужно настраивать сборщики и компиляторы просто чтобы запустить библиотеку. Скомпилированная директория `dist/` уже включена в репозиторий: клонируйте проект и подключайте файлы напрямую в браузере или в Node.js.


* **Модульность (`mediaforgejs` и `mediaforgejs/lite`):** Используйте основную точку входа со всеми плагинами или подключите облегчённое ядро `mediaforgejs/lite` и добавьте только нужные плагины (`flac`, `aac`, `avi`, `h264` и др.).


* **Отказоустойчивая маршрутизация кодеков:** Если аппаратный `AudioDecoder` или `AudioEncoder` браузера даёт сбой посреди файла, библиотека автоматически подхватывает процесс встроенным программным кодеком без потери сэмплов. Повреждённые фреймы AAC или потерянные пакеты Opus аккуратно маскируются (PLC), сохраняя синхронизацию звука и видео.


* **Дружелюбная обработка ошибок (`lenient` / `strict`):** Опечатались и передали `{ fsp: 60 }` вместо `{ fps: 60 }`? В режиме по умолчанию библиотека исправит нечетные размеры кадрирования, нормализует битрейт и выдаст понятное предупреждение (`did you mean fps?`). Для строгой валидации достаточно включить `optionPolicy: 'strict'`.


* **Универсальный ввод-вывод:** Работайте с `Blob` и `Uint8Array` в оперативной памяти или используйте потоковые `FileSource` и `FileSink` для Node.js и Deno с пакетной записью и контролем очереди (`drain()`), а при наличии установленного в системе `ffmpeg` подключайте `FFmpegBackend` из `mediaforgejs/runtime/ffmpeg`.



---

### Установка и подключение

Поскольку папка `dist/` уже присутствует в репозитории, вы можете подключить MediaForgeJS любым удобным способом.

#### 1. Установка через GitHub или npm

```bash
npm install github:kikiemi/MediaForgeJS
# или из реестра npm:
npm install mediaforgejs

```

#### 2. Прямое подключение в браузере (без сборщиков)

Файлы из каталога `dist/` готовы к работе сразу после клонирования репозитория:

```html
<!-- Подключение минифицированного бандла -->
<script src="./dist/MediaForgeJS.min.js"></script>

<!-- Или использование стандартных ES-модулей напрямую из dist/ -->
<script type="module">
  import { inspect, convert, edit } from './dist/esm/api/entries/index.js';
</script>

```

---

### Быстрый старт

#### 1. Инспекция медиафайла

```javascript
import { inspect } from 'mediaforgejs';

const info = await inspect(fileOrBlob, { sampleCounts: true });

console.log(`Формат: ${info.format}, Длительность: ${info.duration} сек.`);
for (const track of info.tracks) {
  console.log(`Дорожка #${track.id} [${track.type}]: кодек=${track.codec}`);
}

```

#### 2. Конвертация и проверка плана выполнения

```javascript
import { convert, check } from 'mediaforgejs';

// Проверяем план до начала конвертации
const report = await check(inputBlob, { to: 'mp4', audio: { bitrate: '128k' } });
if (report.supported) {
  console.log('План выполнения:', report.plan);
}

// Запускаем конвертацию
const result = await convert(inputBlob, {
  to: 'mp4',
  video: {
    width: 1280,
    height: 720,
    fit: 'contain',
    background: '#000000',
  },
  audio: {
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
  },
  onProgress: event => {
    console.log(`Прогресс: ${(event.fraction * 100).toFixed(1)}%`);
  },
});

```

#### 3. Монтаж клипов и сведение звука

```javascript
import { edit } from 'mediaforgejs';

const { blob, plan, warnings } = await edit(
  {
    clips: [
      {
        input: clipA,
        start: 0.5,
        end: 2.0,
        audio: { fade: { in: 0.5 } },
      },
      {
        input: clipB,
        end: 1.0,
        speed: 2.0, // Ускорение в 2 раза с сохранением исходной высоты тона!
        audio: { volume: 0.25 },
      },
    ],
    audio: [
      {
        input: musicMp3,
        start: 3.5,
        offset: 1.0,
        loop: true,
        volume: 0.5,
      },
    ],
  },
  {
    to: 'mp4',
    audio: { sampleRate: 48000, channels: 2 },
  }
);

```

#### 4. Упаковка в HLS и запись на диск в Node.js

```javascript
import { packageMedia } from 'mediaforgejs';
import { writePackageToDirectory } from 'mediaforgejs/runtime/node';

const pack = await packageMedia(movieBlob, 'hls', {
  container: 'ts',
  targetDuration: 2,
});

await writePackageToDirectory(pack.files.values(), './output/hls', {
  overwrite: true,
});

```

---

### Лицензия

Распространяется под лицензией **WTFPL** (Do What The Fuck You Want To Public License). Делайте с этим кодом всё, что вашей душе угодно.
