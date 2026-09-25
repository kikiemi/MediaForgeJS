# MediaForgeJS guide / 使い方

This is the practical guide for **MediaForgeJS 5.4.0**. Start with `MediaWorkflow` for file inspection, remuxing, and audio/video conversion. The lower-level APIs are there when you need to work with packets, subtitles, or streaming yourself.

**MediaForgeJS 5.4.0** の使い方をまとめたページです。ファイルの情報を見る、形式を変える、音声や動画を変換する、といった用途なら、まず `MediaWorkflow` から始めてください。パケットや字幕、配信データを直接扱いたくなったら、後半のAPIを使えます。

English and Japanese share this page and its code examples. Examples marked `ts` are ES modules; each function receives the file, URL, or output destination from your application. Browser examples need the browser APIs mentioned beside them.

英語と日本語を同じページに載せ、コード例は共通にしています。`ts` の例はESモジュールです。関数の引数には、アプリで選んだファイル、URL、保存先などを渡してください。ブラウザーが必要な例は、その場で条件を説明しています。

[Project overview / 概要](../README.md) · [日本語の概要](../README.ja.md)

<a id="contents"></a>
## Contents / 目次

| Start from what you need / 目的から探す | Sections / 項目 |
| --- | --- |
| Getting started / まず動かす | [Choose an API / APIを選ぶ](#start) · [Install / 導入](#install) · [Inspect and remux / 検査と形式変更](#workflow) |
| Convert files / ファイルを変換する | [Audio / 音声](#audio) · [Video / 動画](#video) · [Progress and batch / 進捗と一括処理](#jobs) |
| Read and save / 読み込みと保存 | [Files, HTTP, streams / 入出力](#io) · [Memory / メモリ](#memory) · [Supported formats / 対応形式](#formats) |
| Keep the right data / 情報を扱う | [Warnings and recovery / 警告と回復](#recovery) · [Metadata / メタデータ](#metadata) · [Packets / パケット](#packets) |
| Images and text / 画像とテキスト | [Images / 画像](#images) · [Subtitles / 字幕](#subtitles) |
| Streaming / 配信 | [HLS](#hls) · [DASH](#dash) · [fMP4 and CMAF / 分割MP4](#segments) · [Encryption and DRM / 暗号化](#drm) |
| Optional parts / 必要に応じて追加 | [ProRes and RAW](#prores) · [Modules and FFmpeg / 部品とFFmpeg](#modules) · [Offline use / オフライン](#offline) |
| Existing code and maintenance / 既存コードと保守 | [Converter and migration / 旧APIと移行](#migration) · [Troubleshooting / 困ったとき](#troubleshooting) · [Build and release / 開発と配布](#development) · [Type reference / 型定義](#reference) |

<a id="start"></a>
## 1. Choose an API / 最初に使うAPIを選ぶ

For most file tools, one `MediaWorkflow` instance is enough. There are three output operations. Choosing the right one saves both processing time and surprises.

普通のファイル変換ツールなら、`MediaWorkflow` を1つ作れば始められます。出力の操作は大きく3種類です。何を変えたいのかに合わせて選ぶと、不要な処理を避けられます。

| Goal / やりたいこと | API | What happens / 処理内容 |
| --- | --- | --- |
| Read file information / ファイル情報を見る | `workflow.inspect(input)` | Reads the format and tracks; does not encode media.<br>形式とトラックを調べます。再圧縮はしません。 |
| Change the container / 入れ物だけ変える | `operation: 'remux'` | Copies encoded packets into a compatible container.<br>圧縮済みデータを対応するコンテナへコピーします。 |
| Convert or trim audio / 音声を変換・切り出しする | `operation: 'audio'` | Decodes selected audio, processes it, and encodes the result.<br>選択した音声を復号し、加工して書き出します。 |
| Change video or audio encoding / 映像・音声の圧縮方式を変える | `operation: 'convert'` | Copies tracks that need no change; transcodes the others.<br>変更不要なトラックはコピーし、必要なものを再圧縮します。 |
| Resize or convert images / 画像を変換・拡縮する | `MediaForgeConverter` | Uses the image conversion path.<br>画像用の変換処理を使います。 |
| Convert subtitle text / 字幕テキストを変換する | `parseSubtitles()` / `writeSubtitles()` | Reads and writes text and timing.<br>本文と表示時刻を読み書きします。 |

**Remuxing is not transcoding.** Moving H.264 packets from MP4 to MKV does not need a video decoder. Moving them to WebM is a different matter: WebM does not accept H.264, so you need to choose a supported codec and transcode.

**リマックスと再圧縮は別の処理です。** H.264の入ったMP4をMKVへ移すだけなら、映像デコーダーは不要です。一方、WebMにはH.264をそのまま入れられません。WebMで使えるコーデックを選び、再圧縮する必要があります。

The core does not require an FFmpeg executable. That does not mean every codec is implemented in JavaScript: video conversion normally uses the host's WebCodecs, and some paths need additional codecs or browser APIs. Local file processing does not require an upload service.

本体にFFmpeg実行ファイルは不要です。ただし、すべてのコーデックをJavaScriptで自前実装しているわけではありません。動画変換は通常、実行環境のWebCodecsを使い、処理によっては追加コーデックやブラウザーAPIが必要です。ローカルファイルの処理にアップロード先サーバーは必要ありません。

<a id="install"></a>
## 2. Install and run / 導入して動かす

### Use a release tarball / 配布tarballを使う

From your application directory, install the core tarball from the release. Adjust the path to where you saved it. The tarball already contains JavaScript and TypeScript declarations; application users do not need to build the source.

アプリのディレクトリで、配布物に含まれる本体tarballをインストールします。パスは保存場所に合わせてください。JavaScriptと型定義はビルド済みなので、利用するだけならソースのビルドは不要です。

```sh
npm install ./mediaforgejs-5.4.0.tgz
```

The complete source/release ZIP places this file in `release/`. This command uses a local file and does not assume that 5.4.0 is published to the npm registry. The package provides ES modules, not a separate CommonJS build.

ソースと配布物をまとめたZIPでは、tarballは `release/` にあります。この方法はローカルファイルを使うため、npmレジストリに5.4.0が公開されていることを前提にしません。提供するモジュール形式はESMです。別のCommonJSビルドはありません。

### A browser page without a bundler / バンドラーを使わないブラウザーの例

Save this page next to `dist/`, serve it locally, and choose a file. It displays the file's tracks without uploading the selected file. Adjust the script path when copying the bundle into another project.

このページを `dist/` の隣に置き、ローカルサーバーで開いてファイルを選びます。選択したファイルをアップロードせず、トラック情報を表示します。別のプロジェクトへコピーするときは、スクリプトのパスを変えてください。

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>MediaForgeJS file inspector</title>
<input id="file" type="file">
<pre id="result"></pre>
<script src="./dist/MediaForgeJS.min.js"></script>
<script>
  const workflow = new MediaForgeJS.MediaWorkflow();
  const fileInput = document.getElementById('file');
  const result = document.getElementById('result');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.disabled = true;
    result.textContent = 'Reading…';
    try {
      const info = await workflow.inspect(file);
      result.textContent = JSON.stringify(info, null, 2);
    } catch (error) {
      result.textContent = String(error);
    } finally {
      fileInput.disabled = false;
    }
  });
</script>
</html>
```

The bundle creates `MediaForgeJS` and `MediaForgeJSReady`. `MediaForgeJS.noConflict()` returns the API and restores the globals it replaced. ESM imports do not create those globals. The core bundle does not contain the optional ProRes dependencies.

このバンドルは `MediaForgeJS` と `MediaForgeJSReady` を作ります。`MediaForgeJS.noConflict()` はAPIを返し、置き換えたグローバル変数を元へ戻します。ESMのインポートでは、これらのグローバル変数を作りません。通常ProResの追加依存も本体バンドルには含まれません。

### Runtime requirements / 実行環境について

File inspection, packet copying, supported native audio processing, subtitle text, and metadata do not need the DOM. Use the Node, Bun, or Deno file adapter for local file handles. Image decoding/drawing and host video codecs have their own requirements; installing the Node adapter does not install a video codec.

ファイル検査、パケットのコピー、対応する自前音声処理、字幕テキスト、メタデータにはDOMは不要です。ローカルファイルのハンドルにはNode・Bun・Deno用のアダプターを使います。画像の復号・描画や動画コーデックには別の条件があり、Node用アダプターを入れるだけで映像コーデックが増えるわけではありません。

Use a local HTTP server rather than assuming `file://` will work for modules, workers, or media APIs. Check secure-context requirements and, for ProRes, the [local browser setup](#offline). Test the actual browser/OS/codec combination you intend to use.

モジュールやWorker、メディアAPIを使うときは、`file://` で動くと決めつけず、ローカルHTTPサーバーを使ってください。セキュアコンテキストの条件や、ProResの[ローカルブラウザー設定](#offline)も確認します。実際に使うブラウザー・OS・コーデックの組み合わせで動作確認してください。

<a id="workflow"></a>
## 3. Inspect and remux / ファイルを調べて形式を変える

`inspect()` is the smallest starting point. The result contains the detected format, track descriptions, and warnings. Track IDs belong to that input file; use the returned IDs rather than guessing that the first audio track is `1`.

まずは `inspect()` で情報を取れます。結果には検出した形式、トラック情報、警告が入っています。トラックIDは入力ファイルごとの値です。「最初の音声は1」と決めつけず、取得したIDを使ってください。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function inspectFile(input: Blob) {
  const info = await new MediaWorkflow().inspect(input);
  for (const track of info.tracks) {
    console.log(track.id, track.type, track.codec, track.language);
  }
  return info;
}
```

Open a job when you want to inspect and then process the same file. This example copies compatible tracks to MKV. It rejects unsupported layouts rather than silently throwing tracks away.

同じファイルを調べてから処理する場合は、Jobとして開きます。次の例は対応トラックをMKVへコピーします。対応外の構成なら、トラックを黙って捨てるのではなくエラーになります。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function toMatroska(input: Blob): Promise<Blob> {
  const job = await new MediaWorkflow().open(input, {
    onWarning: warning => console.warn(warning.code, warning.message),
  });
  try {
    const request = { operation: 'remux', format: 'mkv' } as const;
    const support = job.probe(request);
    if (!support.supported) throw new Error(support.reason);
    return await job.toBlob(request);
  } finally {
    job.close();
  }
}
```

To keep only selected tracks, add `trackIds: [/* IDs from inspect() */]` to the remux request. This is an explicit selection, not automatic conversion of unsupported subtitles or codecs. The output container may assign new track IDs.

特定のトラックだけを残すなら、リマックスのリクエストに `trackIds: [/* inspect()で取得したID */]` を追加します。これは明示的な選択であり、未対応の字幕やコーデックを自動変換する指定ではありません。出力先ではトラックIDが振り直される場合があります。

### `probe()` or `check()`? / `probe()` と `check()` の使い分け

| Method / メソッド | Use it for / 使いどころ |
| --- | --- |
| `job.probe(request)` | A synchronous configuration check. It does not scan packet contents.<br>設定の簡易確認です。同期処理で、パケットの中身は走査しません。 |
| `await job.check(request, { maxBytes })` | Executes the output pipeline and finalization without saving the output.<br>出力を保存せず、実際の出力処理と最終処理まで実行します。 |
| `job.toBlob(request, { maxBytes })` | Collects the complete result in memory.<br>完成した出力全体をメモリに保持します。 |
| `job.write(sink, request, { maxBytes })` | Writes to a supplied destination.<br>指定した出力先へ書き込みます。 |
| `job.toReadableStream(request, options)` | Produces bytes as the reader consumes them.<br>読み手の進行に合わせて出力バイトを渡します。 |

A check followed by a write runs the work twice. For a normal conversion button, writing directly and handling errors is usually enough. `check()` returns its diagnostics in `warnings`; it does not call your progress or warning callbacks. It cannot promise that a later disk write or a particular media player will succeed.

`check()` の後で書き出すと、処理は2回走ります。普通の変換ボタンなら、直接書き出して例外を処理する形で十分なことが多いです。`check()` の診断は `warnings` に返り、進捗・警告コールバックは呼びません。後のディスク書き込みや、特定プレイヤーでの再生成功を保証するものでもありません。

`toBlob()` defaults to a 256 MiB output limit. `check()` does not share that default: pass the same `maxBytes` to both when comparing them under the same limit.

`toBlob()` の既定出力上限は256 MiBです。`check()` に同じ既定上限はないため、同じ条件で確かめる場合は両方に同じ `maxBytes` を渡してください。

<a id="audio"></a>
## 4. Convert and trim audio / 音声を変換・切り出しする

The audio operation selects one audio track, decodes it, optionally resamples or changes the channel count, and writes the chosen format. Here, seconds 1 through 8 become a 48 kHz stereo MP3. Use a source long enough to contain that interval, and adjust the range for your application.

音声操作では1本の音声トラックを選び、復号した後、必要に応じてサンプルレートやチャンネル数を変えて出力します。次の例は1秒から8秒までを、48 kHz・ステレオのMP3にします。その区間を含む長さの素材を使い、アプリに合わせて時刻を変えてください。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function audioExcerpt(input: Blob, signal?: AbortSignal): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'audio',
    format: 'mp3',
    sampleRate: 48_000,
    channels: 2,
    bitrateKbps: 192,
    start: 1,
    end: 8,
    signal,
  }, { open: { signal } });
}
```

`start` is inclusive and `end` is exclusive, in presentation seconds after input trim metadata. Without a range, the operation uses the available audio. With several audio tracks, specify `trackId` unless there is exactly one default audio track. The API does not choose a language for you.

`start` を含み、`end` を含まない区間を使います。単位は、入力のトリム情報を反映した後の表示時刻の秒です。区間を省略すると利用可能な音声を扱います。音声が複数ある場合は、既定音声が1本に決まる場合を除き `trackId` を指定してください。言語を自動で選ぶAPIではありません。

| Input/output / 入出力 | Scope / 範囲 |
| --- | --- |
| Built-in decoding / 組み込み復号 | Supported PCM, AAC-LC, MPEG Audio Layer I/II.<br>対応するPCM、AAC-LC、MPEG Audio Layer I/II。 |
| MP3 decoding / MP3の復号 | Needs a host `AudioDecoder` or a registered decoder.<br>実行環境の `AudioDecoder` または登録したデコーダーが必要です。 |
| Audio-operation output / 音声操作の出力 | `wav`, `aiff`, `au`, `caf`, `aac`, `mp2`, `mp3`, `flac` |
| PCM and FLAC re-encoding / PCM・FLACへの再符号化 | Produces 16-bit samples. Wider integer or floating PCM needs `allowPrecisionLoss: true`.<br>16 bitで出力します。それより広い整数PCMや浮動小数PCMには `allowPrecisionLoss: true` が必要です。 |

For bit-preserving PCM container changes, use `remux`, not an audio conversion. Even FLAC output does not mean a conversion from higher-precision PCM preserves every original bit. Unsupported channel layouts, discontinuous PCM timelines, and unsupported edits are rejected rather than guessed.

PCMのビット列を維持して入れ物だけ変えたい場合は、音声変換ではなく `remux` を使います。FLAC出力でも、高精度PCMからの変換で元の全ビットを維持するとは限りません。未対応のチャンネル配置、PCMの不連続な時刻、未対応の編集は、推測して詰め直さず拒否します。

### AAC in M4A / M4AにAACを入れる

Use `convert` for M4A. Supported PCM and AAC-LC inputs can use the built-in AAC-LC path without WebCodecs or FFmpeg. Do not use `format: 'm4a'` with `operation: 'audio'`.

M4Aには `convert` を使います。対応するPCMやAAC-LC入力なら、WebCodecsやFFmpegなしで組み込みのAAC-LC処理を使えます。`operation: 'audio'` に `format: 'm4a'` を指定する形ではありません。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function toM4a(input: Blob): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'convert',
    format: 'm4a',
    audioCodec: 'mp4a.40.2',
    audioBitrate: 128_000,
  });
}
```

<a id="video"></a>
## 5. Convert video / 動画を変換する

Use `convert` when you need to change the video codec, size, frame rate, or audio settings. This browser-oriented example requests H.264/AAC MP4 at 1280 × 720. The browser must support the input decoder and requested encoder; resizing also needs `OffscreenCanvas`.

映像コーデック、寸法、フレームレート、音声設定を変えたい場合は `convert` を使います。次は1280 × 720のH.264/AAC MP4を作る、ブラウザー向けの例です。入力のデコーダーと出力のエンコーダーに実行環境が対応している必要があり、サイズ変更には `OffscreenCanvas` も必要です。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function to720p(input: Blob, signal?: AbortSignal): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'convert',
    format: 'mp4',
    videoCodec: 'avc1.42001f',
    width: 1280,
    height: 720,
    videoBitrate: 2_000_000,
    audioCodec: 'mp4a.40.2',
    audioBitrate: 128_000,
    signal,
  }, { open: { signal } });
}
```

Copy-only conversions can keep multiple compatible video and audio tracks. The default transcoding path handles at most one video and one audio track; use `trackIds` when you need to select from a larger set. It does not silently turn a multi-audio file into a single-audio file.

コピーだけの変換なら、対応する複数の映像・音声を保持できます。既定の再圧縮処理が扱うのは映像最大1本、音声最大1本です。それより多い入力から選ぶ場合は `trackIds` を指定します。複数音声を黙って1本に減らすことはありません。

A codec name in the registry is not an installed decoder or encoder. The same code can work on one host and fail on another. `probeNativeCodec()` can query host support; the actual conversion still needs to handle errors. The separate [ProRes adapter](#prores) has its own restrictions and is not a general resize/fps/HDR pipeline.

レジストリにコーデック名があることと、デコーダーやエンコーダーが利用できることは別です。同じコードでも実行環境によって結果は変わります。ホストの対応は `probeNativeCodec()` で照会できますが、変換時の例外処理は必要です。[ProRes用アダプター](#prores)にも独自の制限があり、汎用の拡縮・fps変更・HDR処理ではありません。

### Units / 単位

| Option / オプション | Unit / 単位 |
| --- | --- |
| Workflow audio `bitrateKbps` | kilobits per second / kbps |
| Workflow convert `audioBitrate`, `videoBitrate` | bits per second / bit/s |
| Legacy Converter `audioBitrate`, `videoBitrate` | kilobits per second / kbps |
| `start`, `end`, packet timestamps | seconds / 秒 |
| `sampleRate`, `audioSampleRate` | Hz |
| `width`, `height` | pixels / ピクセル |
| Workflow progress `fraction` | `0` to `1` / 0〜1 |

The bitrate units differ between Workflow conversion and the legacy Converter. For example, 192 kbps is `192_000` in a Workflow convert request, but `192` in a legacy Converter config.

Workflowの `convert` と従来のConverterでは、ビットレートの単位が違います。192 kbpsなら、Workflowの `convert` には `192_000`、従来Converterには `192` を指定します。

<a id="jobs"></a>
## 6. Progress, cancellation, and jobs / 進捗・中止・一括処理

Pass a signal to both opening and processing when the whole operation should be cancellable. Call `abort()` from your cancel button. The callback receives a progress object; `fraction` is not already a percentage.

読み込みから処理まで中止できるようにするには、open設定と処理リクエストの両方にシグナルを渡します。キャンセルボタンから `abort()` を呼んでください。進捗コールバックにはオブジェクトが渡り、`fraction` は百分率ではなく0〜1です。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export function startAudioConversion(input: Blob) {
  const controller = new AbortController();
  const signal = controller.signal;
  const result = new MediaWorkflow().toBlob(input, {
    operation: 'audio',
    format: 'wav',
    signal,
    onProgress: ({ fraction, message }) => {
      console.log(`${Math.round(fraction * 100)}%`, message ?? '');
    },
  }, { open: { signal } });

  return { result, cancel: () => controller.abort() };
}
```

Handle the returned promise's rejection, including cancellation. A job accepts only one active operation at a time. Use separate jobs for separate concurrent files, and put `job.close()` in `finally` when opening jobs yourself.

返されたPromiseの失敗は、中止の場合も含めて処理してください。1つのJobで同時に実行できる操作は1つです。別ファイルを並列処理するときは別のJobを使い、自分で開いたJobは `finally` で `close()` します。

For small batch outputs, `batch()` returns results in input order. One failure does not stop unrelated items. Each successful item is a complete Blob, so this is not the best choice for a queue of very large outputs.

小さめのファイルをまとめて変換するなら、`batch()` が入力順で結果を返します。1件の失敗だけで他の項目を止めません。成功した結果は完成したBlobなので、大容量出力を大量にためる用途には向きません。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function batchToWav(inputs: readonly Blob[], signal?: AbortSignal) {
  const results = await new MediaWorkflow().batch(
    inputs.map(input => ({
      input,
      request: { operation: 'audio' as const, format: 'wav' as const },
    })),
    { concurrency: 2, signal },
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') console.log(index, result.value.size);
    else console.error(index, result.reason);
  }
  return results;
}
```

### Who closes what? / 後始末は誰がする？

Workflow's one-shot methods release their internal jobs. Finished or cancelled stream/segment iterations also release their jobs. A source you open and supply remains yours to close. After a write has started, Workflow closes the sink on success and calls its optional `abort()` on failure. If opening or planning fails before writing starts, your sink has not been taken over: clean it up yourself.

Workflowの単発メソッドは内部Jobを解放します。ストリームやセグメントの列挙も、終了・中止時に内部Jobを解放します。ただし、自分で開いて渡したSourceは自分で閉じます。書き出し開始後は、成功時にWorkflowがSinkを閉じ、失敗時に任意の `abort()` を呼びます。openや計画の段階で失敗した場合、Sinkはまだ引き受けられていないので、呼び出し側で後始末してください。

<a id="io"></a>
## 7. Files, HTTP, and streams / ファイル・HTTP・ストリーム

### Write directly to a file / ファイルへ直接書く

For large files, avoid reading the whole input into a buffer and avoid collecting a Blob. Use a `FileSource` and `FileSink`. This Node example copies compatible AVC/HEVC and supported audio tracks to MPEG-TS.

大きなファイルでは、入力全体をバッファに読み込んだり、出力全体をBlobにまとめたりするのを避け、`FileSource` と `FileSink` を使います。次はNodeで、対応するAVC/HEVCと音声トラックをMPEG-TSへコピーする例です。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';
import { FileSource, FileSink } from 'mediaforgejs/runtime/node';

export async function remuxFile(inputPath: string, outputPath: string): Promise<void> {
  const source = await FileSource.open(inputPath);
  try {
    const sink = await FileSink.open(outputPath);
    try {
      await new MediaWorkflow().write(source, sink, {
        operation: 'remux',
        format: 'ts',
      }, {
        open: {
          maxIndexBytes: 128 * 1024 * 1024,
          cacheBytes: 4 * 1024 * 1024,
        },
      });
    } catch (error) {
      await sink.abort(error);
      throw error;
    }
  } finally {
    await source.close();
  }
}
```

**Use different input and output files. `FileSink.open()` truncates the output.** `abort()` closes the handle but does not undo bytes already written. For replacement of an existing file, write to a different temporary path and rename it only after success. `FileSink.abort()` tolerates repeated calls; do not assume the same contract for an arbitrary custom sink.

**入力と出力には別のファイルを使ってください。`FileSink.open()` は出力先を切り詰めます。** `abort()` はハンドルを閉じますが、書き込んだバイトを元へ戻しません。既存ファイルを置き換えるなら、別の一時ファイルへ書き、成功後に名前を変更してください。`FileSink.abort()` は複数回呼べますが、独自Sinkでも同じとは限りません。

The Bun adapter is `mediaforgejs/runtime/bun`; Deno uses `mediaforgejs/runtime/deno`. Check their declaration files for handle types and host requirements. `open()` owns the opened handle. `from(handle)` normally borrows it; `closeHandle: true` transfers responsibility. Do not share a borrowed handle's mutable cursor with other code during an operation.

Bun用は `mediaforgejs/runtime/bun`、Deno用は `mediaforgejs/runtime/deno` です。ハンドル型や環境の条件は各型定義を確認してください。`open()` は開いたハンドルを所有し、`from(handle)` は通常、借用します。`closeHandle: true` で管理責任を渡せます。処理中は、借用ハンドルの読み書き位置を他のコードと共有しないでください。

### Stream the output / 出力をストリームで渡す

`toReadableStream()` returns a stream immediately. Errors from opening or conversion appear while reading it. Start consuming it; do not wait for an entire output to finish before attaching the reader.

`toReadableStream()` はストリームをすぐに返します。openや変換のエラーは、そのストリームを読むときに伝わります。出力全体の完成を待ってから読み始めるのではなく、作成後に消費を開始してください。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function streamToDestination(
  input: Blob,
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const output = new MediaWorkflow().toReadableStream(input, {
    operation: 'remux',
    format: 'ts',
    signal,
  }, {
    open: { signal },
    highWaterMark: 1024 * 1024,
    maxBytes: 2 * 1024 * 1024 * 1024,
  });
  await output.pipeTo(destination, { signal });
}
```

A browser application can supply a writable file stream when its host supports one. `WritableStreamSink` adapts a Web writable stream, while `nodeWritableSink()` adapts a Node writable. These adapters do not make a forward-only destination seekable.

対応するブラウザーなら、ファイルへの書き込みストリームを出力先にできます。WebのWritableStreamには `WritableStreamSink`、NodeのWritableには `nodeWritableSink()` を使えます。ただし、前方にしか書けない出力先が、アダプターだけでランダム書き込み可能になるわけではありません。

### Read a remote file by range / リモートファイルを範囲読み込みする

Use `HttpSource` for a stable, range-readable file. Pass a URL from your application; the following function also requires a strong resource validator so it does not silently combine changing versions of the file.

内容が安定し、範囲読み込みに対応したファイルには `HttpSource` を使います。URLはアプリから渡してください。次の例では強いリソース検証子も必須にし、途中で変わったファイルを黙って混ぜない設定にしています。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';
import { HttpSource } from 'mediaforgejs/io';
import { createRetryFetch } from 'mediaforgejs/io/retry-fetch';

export async function inspectRemote(url: string, signal?: AbortSignal) {
  const source = await HttpSource.open(url, {
    signal,
    requireValidator: true,
    requestTimeoutMs: 30_000,
    fetch: createRetryFetch({ maxRetries: 2 }),
  });
  try {
    return await new MediaWorkflow().inspect(source, { signal });
  } finally {
    await source.close();
  }
}
```

The server must return correct `206` and `Content-Range` responses. In a cross-origin browser request, expose the needed `Content-Range`, `ETag`, and `Last-Modified` headers. `requireValidator: true` rejects a source without a strong validator. Without it, the source warns when strong validation is unavailable; a size and date alone cannot detect every change.

サーバーには正しい `206` 応答と `Content-Range` が必要です。ブラウザーから別オリジンへアクセスする場合は、必要な `Content-Range`、`ETag`、`Last-Modified` をCORSで公開してください。`requireValidator: true` は強い検証子がない入力を拒否します。指定しない場合も、強い検証ができなければ警告します。サイズと日付だけですべての内容変更を検知できるわけではありません。

A server without Range support is rejected by default. `fallback: 'buffer'` together with an explicit `maxBytes` permits whole-file buffering during opening. This is not a large-file streaming shortcut. `StreamSource.from()` and `nodeReadableSource()` also retain the full input up to their explicit limit and wait for EOF. For supported fMP4 before EOF, use [readCmafSegments](#segments).

Range非対応のサーバーは既定で拒否します。`fallback: 'buffer'` と明示的な `maxBytes` を指定すれば、open時に入力全体を保持できます。ただし、大容量向けの逐次処理ではありません。`StreamSource.from()` と `nodeReadableSource()` も、明示した上限まで全入力を保持し、EOFを待ちます。対応するfMP4を受信途中から扱う場合は [readCmafSegments](#segments) を使います。

`createRetryFetch()` retries eligible GET/HEAD requests, not DRM POSTs or failures that occur after a successful response has been returned and its body is being read. `maxRetries` counts retries after the first attempt. The caller's request timeout still needs to cover the retries and body read.

`createRetryFetch()` が再試行するのは対象条件に合うGET/HEADです。DRMのPOSTや、成功応答を返した後の本文読み取り失敗は自動再送しません。`maxRetries` は最初の試行とは別の再試行回数です。利用側では再試行と本文読み取りを含むタイムアウトも設定してください。

<a id="memory"></a>
## 8. Memory and large files / メモリと大きなファイル

Streaming helps, but it is not the same as constant memory. The input format can still need an index, standard MP4 output needs sample tables, codecs need working memory, and your application may be retaining results.

ストリームを使うと全量保持を減らせますが、それだけでメモリ使用量が一定になるわけではありません。入力形式によっては索引が必要で、標準MP4出力にはサンプル表が残り、コーデックにも作業領域が必要です。アプリ側で結果を保持している分も加わります。

| Path / 処理 | What stays in memory / メモリに残るもの |
| --- | --- |
| `FileSource` / `BlobSource` | Read ranges and cache, plus format indexes.<br>読み取り範囲とキャッシュ、形式ごとの索引。 |
| `BufferSource` | The full input; copied by default.<br>入力全体。既定ではコピーも作ります。 |
| `StreamSource` / `nodeReadableSource` | The full retained input up to `maxBytes`.<br>`maxBytes` まで保持した入力全体。 |
| `toBlob()` / `MemorySink` | The complete output.<br>出力全体。 |
| Standard MP4/MOV output | Sample tables; without `patchAt()`, encoded payload may also be retained.<br>サンプル表。`patchAt()` がない出力先では圧縮データも保持する場合があります。 |
| fMP4 / `segments()` | The current fragment and input indexes.<br>現在の断片と入力索引。 |
| ProRes | Frame planes, WASM memory, queued work, and frames you keep.<br>画像プレーン、WASM領域、待機中の処理、利用側が保持するフレーム。 |
| `batch()` | Concurrent jobs and all completed Blobs.<br>同時実行Jobと、完成した全Blob。 |

Useful opening limits are `maxPacketBytes` (default 64 MiB), `maxSamples` (2,000,000), `maxIndexBytes` (128 MiB), and `cacheBytes` (4 MiB). `cacheBytes: 0` disables retained input pages. These are library budgets, not a cap on total process memory.

open時の主な制限は `maxPacketBytes`（既定64 MiB）、`maxSamples`（200万）、`maxIndexBytes`（128 MiB）、`cacheBytes`（4 MiB）です。`cacheBytes: 0` で入力ページの保持を無効にできます。いずれもライブラリ内の予算であり、プロセス全体のメモリ上限ではありません。

Prefer a patch-capable file sink for large standard MP4/MOV output. For supported fragmented output, bound fragment size and consume each fragment before keeping another. Raising `maxBytes` on `toBlob()` only allows a larger retained output; it does not change how that output is stored.

大きな標準MP4/MOVは、後から書き換えられるファイルSinkへ出すのが基本です。対応する分割出力では断片の容量を制限し、受け取った断片を順に処理します。`toBlob()` の `maxBytes` を増やしても、保持を許す出力が大きくなるだけで、保存方法は変わりません。

5.4.0 uses more compact MP4 indexes, but it does not promise constant memory for every 100 GB input. A sparse-source offset test is not a full end-to-end test of a 100 GB movie.

5.4.0ではMP4索引をコンパクトにしていますが、あらゆる100 GB入力を一定メモリで処理できるという意味ではありません。疎な仮想入力での大きなオフセットの試験と、100 GBの動画全体の処理は別です。

<a id="formats"></a>
## 9. Supported formats / 対応形式

Read this as a list of implemented paths, not a promise that every codec can be read, decoded, encoded, and played in every container. For a specific file, inspect its tracks and use `probe()` or `check()` for the output request.

次の表は実装している処理の範囲です。すべてのコーデックを、すべてのコンテナで読み取り・復号・符号化・再生できるという意味ではありません。個別のファイルはトラックを調べ、出力リクエストを `probe()` や `check()` で確認してください。

### Packet input / パケットとして読み込める形式

| Format / 形式 | Notes / 条件 |
| --- | --- |
| MP4, MOV, M4A, M4V, 3GP, fMP4 | Multiple video/audio tracks and supported subtitle entries.<br>複数の映像・音声と、対応する字幕エントリー。 |
| MKV, WebM | Supported video/audio/subtitle tracks; Matroska chapters and attachments.<br>対応する映像・音声・字幕。Matroskaの章と添付ファイルも扱います。 |
| MPEG-TS | First program, supported video and audio; up to 64 tracks.<br>先頭番組の対応映像・音声。最大64トラック。 |
| AVI, FLV | Supported AVC and audio layouts, not every codec historically used by these containers.<br>対応するAVCと音声構成。各コンテナで使われる全コーデックではありません。 |
| ADTS AAC, MP1/MP2/MP3 | Encoded-frame indexing. Unsupported or changing configurations may be rejected.<br>圧縮フレームの索引化。未対応構成や設定変更は拒否する場合があります。 |
| WAV/RF64 | Supported integer 8/16/24/32-bit or float 32/64-bit PCM, 1–32 channels.<br>対応する整数8/16/24/32 bit、浮動小数32/64 bitのPCM、1〜32チャンネル。 |
| FLAC, Ogg Opus/Vorbis | Native FLAC and a single Ogg logical stream.<br>native FLACと、単一のOgg論理ストリーム。 |
| AIFF/AIFC, AU, CAF | Supported mono/stereo PCM subsets. CAF here is packed LPCM, not general ALAC/AAC-in-CAF decoding.<br>対応するモノラル・ステレオPCMの範囲。CAFはpacked LPCMで、CAF内ALAC/AACの汎用復号ではありません。 |

Raw MP3 indexing does not fully interpret Xing/LAME gapless trim. Indexing an MP3 is also different from decoding it. WAVE precision and channel-mask information can be preserved by compatible packet-copy paths; the audio conversion path has narrower sample/layout limits.

raw MP3の索引化ではXing/LAMEのギャップレス・トリムを完全には解釈しません。MP3の索引化と復号も別の機能です。WAVEの精度やチャンネルマスクは対応するコピー処理で保持できますが、音声変換で扱えるサンプル形式・配置はそれより限定されます。

### Packet-copy output / 再圧縮しない出力

| Output / 出力 | Main restrictions / 主な制限 |
| --- | --- |
| Standard MP4/MOV | Supported AVC/HEVC/AV1 and AAC/AC3/EAC3. MOV also accepts supported ProRes/ProRes RAW packets.<br>対応するAVC/HEVC/AV1とAAC/AC3/EAC3。MOVでは対応するProRes/ProRes RAWパケットも扱います。 |
| MP4/M4A/M4V auto mode | Can select fragmented output for supported Opus/FLAC/ALAC/VP9 or subtitle layouts. M4A is audio-only.<br>対応するOpus/FLAC/ALAC/VP9や字幕構成では分割出力を選ぶ場合があります。M4Aは音声のみです。 |
| MKV | Multiple compatible tracks; supported PCM/MPEG Audio/ProRes and text/ASS/SSA/D_WEBVTT subtitles.<br>対応する複数トラック。PCM、MPEG Audio、ProRes、テキスト・ASS/SSA・D_WEBVTT字幕。 |
| WebM | VP8/VP9/AV1, Opus/Vorbis, D_WEBVTT. Not arbitrary Matroska codecs.<br>VP8/VP9/AV1、Opus/Vorbis、D_WEBVTT。任意のMatroskaコーデックではありません。 |
| MPEG-TS | At most one AVC/HEVC video; multiple supported AAC/AC3/EAC3/MPEG audio tracks; at most 64 tracks total.<br>AVC/HEVC映像は最大1本、対応音声は複数。合計最大64トラック。 |
| AVI | One AVC video and one supported PCM audio track.<br>AVC映像1本と対応PCM音声1本。 |
| FLV | One AVC video and one AAC audio track.<br>AVC映像1本とAAC音声1本。 |
| WAV, FLAC, Ogg | One compatible audio track. Ogg output is Opus or Vorbis.<br>対応する音声1本。Ogg出力はOpusまたはVorbis。 |
| AIFF/AIFC, AU, CAF | One supported mono/stereo PCM track, with representable precision and layout.<br>出力先で精度・配置を表現できる、対応するモノラル・ステレオPCM1本。 |
| Raw AAC/MPEG audio | One matching audio track; ADTS output is AAC-LC.<br>一致する音声1本。ADTS出力はAAC-LC。 |
| fMP4 / `CmafWriter` | Supported video, audio, and `wvtt`/`stpp` subtitle sample entries.<br>対応する映像・音声と `wvtt` / `stpp` 字幕エントリー。 |

`CodecRegistry.canMux()` is a family-level hint, not validation of a complete track configuration. `codecConfig`, profile, dimensions, channel layout, timing, and track attributes also matter. A codec identifier such as VVC or Dolby Vision does not by itself add a new decoder, encoder, or writer.

`CodecRegistry.canMux()` はコーデック系統の組み合わせを調べる目安で、完全なトラック設定の検証ではありません。`codecConfig`、プロファイル、寸法、チャンネル配置、時刻、属性も関係します。VVCやDolby Visionなどの識別名があっても、それだけでデコーダー・エンコーダー・writerが増えるわけではありません。

<a id="recovery"></a>
## 10. Warnings and damaged input / 警告と破損ファイル

There are two separate policies. `validation` controls recoverable structural problems. `metadataPolicy` controls detected losses of optional metadata. Setting `strict` does not automatically make every missing tag an error.

設定は2つに分かれています。`validation` は回復可能な構造上の問題、`metadataPolicy` は検出した任意メタデータの損失を扱います。`strict` にするだけで、すべてのタグ損失がエラーになるわけではありません。

| Setting / 設定 | Behavior / 動作 |
| --- | --- |
| `validation: 'compatible'` | Default for Workflow/Engine. Warns and recovers where the remaining structure is usable.<br>Workflow/Engineの既定。残った構造を利用できる範囲で、警告して回復します。 |
| `validation: 'strict'` | Rejects structural problems requiring recovery.<br>回復が必要な構造上の問題を拒否します。 |
| `metadataPolicy: 'warn'` | Default. Warns about detected optional metadata losses.<br>既定。検出した任意メタデータの損失を警告します。 |
| `metadataPolicy: 'error'` | Rejects detected metadata losses rather than continuing.<br>検出したメタデータ損失を許さず停止します。 |

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function remuxWithMetadataChecks(input: Blob): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'remux',
    format: 'mkv',
  }, {
    open: {
      validation: 'compatible',
      metadataPolicy: 'error',
      onWarning: warning => console.warn(warning.code, warning.message),
    },
  });
}
```

Recovery keeps complete packets whose positions and timing can be established. It can handle supported truncated MP4/TS/audio tails or resynchronize supported audio frames. It cannot reconstruct a missing MP4 `moov`, invent reference frames, repair arbitrary compressed payloads, or make unsupported encryption readable.

回復で使うのは、位置や時刻を確定できる完全なパケットです。対応するMP4・TS・音声の末尾切断や、音声フレームの再同期を扱えます。一方、失われたMP4の `moov`、欠けた参照フレーム、任意の圧縮データ、未対応の暗号化を復元するものではありません。

Truncated AVI requires explicit `aviRecovery: 'complete-packets'` in the open options. Strict validation still rejects damage. H.264 packets whose display order cannot be established may be dropped with a warning, and recovered tracks can report `incomplete`.

切断AVIの回復は、open設定の `aviRecovery: 'complete-packets'` で明示的に有効にします。strictでは破損を拒否します。表示順を確定できないH.264パケットは警告して除外する場合があり、回復したトラックには `incomplete` が付くことがあります。

Check `warnings`, callbacks, and `incomplete`, then test the result in your player. A recovered video may remain undecodable until the next independent frame. Direct low-level demuxers and the incremental MP4 readers have their own defaults; `readCmafSegments()` defaults to strict, not compatible.

`warnings`、コールバック、`incomplete` を確認し、出力もプレイヤーで確かめてください。回復できた動画でも、次の独立フレームまでは復号できない場合があります。低水準demuxerや逐次MP4リーダーには別の既定値があり、`readCmafSegments()` の既定はcompatibleではなくstrictです。

<a id="metadata"></a>
## 11. Metadata and track flags / メタデータとトラック属性

Remuxing preserves supported information, not every possible container tag. Track names, titles, language, default/forced/commentary flags, alpha information, Matroska tags, chapters, and attachments depend on the destination.

リマックスは対応する情報を保持しますが、あらゆるコンテナの全タグを移せるわけではありません。トラック名、タイトル、言語、既定・強制・解説フラグ、透過情報、Matroskaのタグ・章・添付ファイルは、出力先の表現能力に左右されます。

MP4's `default` reflects its track-enabled flag; the player decides which enabled track to select. Forced subtitle information can be preserved in supported entries, but an equivalent forced audio/video attribute cannot be written to MP4. WebM does not keep Matroska chapters and attachments. Unsupported losses appear in output diagnostics; use `metadataPolicy: 'error'` when preserving detected information is required.

MP4の `default` はトラックの有効フラグに対応し、実際にどれを選ぶかはプレイヤーによります。対応する字幕の強制表示情報は保持できますが、音声・映像の同等の強制属性をMP4へは書けません。WebMはMatroskaの章や添付ファイルを保持しません。表現できない情報は診断に現れるので、検出した情報の保持が必須なら `metadataPolicy: 'error'` を使います。

Some Matroska VP8/VP9 packets carry `alphaData` separately from the main image packet. Keep both when writing packets yourself. A destination that cannot represent that alpha is not a reason to discard it silently.

MatroskaのVP8/VP9では、映像本体と別の `alphaData` を持つパケットがあります。自分でパケットを書き出す場合は両方を引き渡してください。出力先が対応しないからといって、透過を黙って捨てる扱いにはしません。

### Save track descriptions as JSON / トラック情報をJSONで保存する

Track descriptions may contain 64-bit Matroska UIDs and codec bytes. Use the helpers for a round trip. They restore descriptions, not the source file, packet index, or a usable open job.

トラック情報には64 bitのMatroska UIDやコーデック設定のバイト列が入ることがあります。保存して戻すならヘルパーを使えます。ただし、復元するのは説明情報であり、入力ファイルやパケット索引、開いたJobではありません。

```ts
import { serializeTracks, deserializeTracks } from 'mediaforgejs/metadata';
import type { MediaTrack } from 'mediaforgejs/engine';

export function copyTrackDescriptions(tracks: readonly MediaTrack[]) {
  const json = serializeTracks(tracks);
  return deserializeTracks(json);
}
```

`JSON.stringify()` also works on the original returned track objects, which have a local `toJSON`. Spreading those objects removes that non-enumerable helper, so use `serializeTracks()` for copied descriptions. Do not turn a UID into a JavaScript number and expect all 64 bits to survive.

返された元のトラックオブジェクトには局所的な `toJSON` があり、`JSON.stringify()` も使えます。ただし、スプレッドで複製すると非列挙のヘルパーは消えるため、複製した情報には `serializeTracks()` を使ってください。UIDをJavaScriptのnumberへ変換すると、64 bitを正確に保てるとは限りません。

ID3 and timed-event helpers are independent APIs: `createId3Tag`, `parseId3Tag`, `writeId3Tag`, `encodeEventMessage`, and `decodeEventMessage`. For ID3 edits, rebuild with `createId3Tag()` or edit the frame model; the `metadata` view is a projection, not the authoritative edit buffer. These helpers do not enable automatic tag transfer for every remux path.

ID3や時刻付きイベントには独立したAPIがあります。`createId3Tag`、`parseId3Tag`、`writeId3Tag`、`encodeEventMessage`、`decodeEventMessage` です。ID3を編集するときは `createId3Tag()` で作り直すか、フレームモデルを編集します。`metadata` は読み取り用の投影で、編集の本体ではありません。これらを使えることと、全リマックス経路でタグが自動移植されることは別です。

<a id="packets"></a>
## 12. Work with encoded packets / 圧縮パケットを直接扱う

Use `MediaEngine` when you need packet access rather than a completed conversion. This example reads one video track around 10–12 seconds. It is packet inspection, not a ready-to-play clip editor.

完成した変換結果ではなくパケットに触りたい場合は、`MediaEngine` を使います。次は1本の映像トラックを10〜12秒付近で読む例です。パケット検査であって、そのまま再生できるクリップを作る編集処理ではありません。

```ts
import { MediaEngine } from 'mediaforgejs/engine';

export async function inspectPackets(input: Blob): Promise<void> {
  const file = await new MediaEngine().open(input);
  try {
    const video = file.tracks.find(track => track.type === 'video');
    if (!video) return;
    const index = file.findSample(video.id, 10, { keyframe: true, mode: 'before' });
    if (index !== undefined) console.log(await file.readPacket(video.id, index));
    for await (const packet of file.packets({
      trackIds: [video.id], start: 10, end: 12,
    })) {
      console.log(packet.trackId, packet.timestamp, packet.decodeTimestamp, packet.data.length);
    }
  } finally {
    file.close();
  }
}
```

`timestamp` is presentation time (PTS), `decodeTimestamp` is decode time (DTS), and both use seconds. `findSample()` searches presentation time. `packets({ start, end })` filters the half-open decode-time interval and merges selected tracks in decode order. Those different time bases matter around B-frames.

`timestamp` は表示時刻（PTS）、`decodeTimestamp` は復号時刻（DTS）で、いずれも秒です。`findSample()` は表示時刻で検索します。`packets({ start, end })` は開始を含み終了を含まない復号時刻の区間で絞り、トラックを復号順にまとめます。Bフレーム付近では、この違いが重要です。

`readPacket()` returns independent bytes and the sample's codec configuration. Keep the source's contents and size unchanged while the file is open. `file.close()` releases internal input/index references but does not close a borrowed source; later packet reads and output operations fail.

`readPacket()` は独立したバイト列と、そのサンプルのコーデック設定を返します。ファイルを開いている間は、入力Sourceのサイズと内容を変えないでください。`file.close()` は内部の入力・索引への参照を解放しますが、借用Sourceは閉じません。その後のパケット読み込みや書き出しは失敗します。

At this level, `file.checkRemux()` is the synchronous configuration check, while `await file.validateRemux()` executes the output pipeline. `MP4Demuxer.readSample(sample)` only works when its parsed input is unambiguous; use `readSample(input, sample)` after successfully parsing multiple different inputs with the same demuxer. For normal applications, Workflow or `MediaFile` makes ownership easier.

このレイヤーでは、`file.checkRemux()` が同期の設定確認、`await file.validateRemux()` が実処理の検証です。`MP4Demuxer.readSample(sample)` は解析済み入力が一つに定まる場合に使えます。同じdemuxerで異なる入力を複数正常に解析した後は、`readSample(input, sample)` で入力を明示します。通常のアプリでは、Workflowや `MediaFile` の方が入力の管理をしやすくなります。

Custom demuxers can be registered explicitly with `registerDemuxer({ formats, demux })`, then selected using an explicit `format` on open. The result must follow the public demux-result structure. Registration does not add automatic unknown-format detection or a codec implementation.

独自demuxerは `registerDemuxer({ formats, demux })` で登録し、open時に `format` を明示して選べます。結果は公開されたdemux結果の構造に合わせます。登録するだけで未知形式の自動判定やコーデック実装が追加されるわけではありません。

<a id="images"></a>
## 13. Convert and resize images / 画像を変換・拡縮する

Images use `MediaForgeConverter`, not a Workflow operation. This example fits the image inside a 1280 × 720 box without changing its aspect ratio. Browser image decoding and drawing APIs are required by this path.

画像はWorkflowの操作ではなく、`MediaForgeConverter` で扱います。次は縦横比を維持し、1280 × 720の枠内に収める例です。この処理には、ブラウザーの画像復号・描画APIが必要です。

```ts
import { MediaForgeConverter } from 'mediaforgejs/converter';

export async function resizeImage(input: Blob): Promise<Blob> {
  return new MediaForgeConverter({
    outputFormat: 'png',
    width: 1280,
    height: 720,
    imageFit: 'inside',
    imageResize: 'lanczos3',
  }).convert(input);
}
```

Use `imageFit: 'scale-down'` to avoid enlarging a smaller image. Resize filters include `nearest`, `bilinear`, and `lanczos3`. Image output APIs cover PNG, JPEG, WebP, BMP, TIFF, ICO, GIF, and APNG, with input decoding and some encoders depending on browser support. Do not read this as a promise to decode every camera or graphics format.

小さな画像を拡大したくない場合は `imageFit: 'scale-down'` を使います。補間方式は `nearest`、`bilinear`、`lanczos3` です。画像の出力APIはPNG、JPEG、WebP、BMP、TIFF、ICO、GIF、APNGを扱いますが、入力の復号や一部エンコーダーはブラウザーに依存します。あらゆるカメラ・画像形式を復号できるという意味ではありません。

### Transparency and animation / 透過とアニメーション

BMP/TIFF can retain alpha. JPEG rejects transparent pixels rather than silently choosing a background. GIF accepts fully transparent or opaque pixels, not partial alpha. Resize edges can introduce partial transparency: composite onto the background you want before requesting JPEG or GIF.

BMP/TIFFはalphaを保持できます。JPEGでは勝手に背景色を決めず、透明画素があれば拒否します。GIFが扱うのは完全透明か完全不透明で、半透明ではありません。拡縮した輪郭に半透明が生まれることもあるので、JPEGやGIFにする場合は、必要に応じて希望の背景色へ合成してから渡してください。

GIF/APNG conversion preserves representable finite playback counts. `AnimatedGifEncoder.fromPlayCount()` uses total plays: `0` is infinite and `1` is once. The older constructor has different historical rules. A static image's `fps` setting is rejected rather than ignored. Revoke any object URL your application creates once it is no longer in use.

GIF/APNG間では、表現可能な有限の再生回数を維持します。`AnimatedGifEncoder.fromPlayCount()` は総再生回数で、`0` が無限、`1` が1回です。従来のコンストラクターには別の規則があります。静止画像への `fps` 指定は無視せず拒否します。アプリで作ったObject URLも、使わなくなった時点で解放してください。

<a id="subtitles"></a>
## 14. Subtitle text and timing / 字幕の本文と時刻

The text API reads and writes SRT, WebVTT, ASS/SSA, and the supported TTML/DFXP/IMSC text/timing subset. Start with text conversion; it does not need a browser renderer.

テキストAPIはSRT、WebVTT、ASS/SSA、対応範囲のTTML/DFXP/IMSCを読み書きします。まずは字幕ファイルの変換から使えます。テキストと時刻の変換に、ブラウザーの描画機能は必要ありません。

```ts
import { parseSubtitles, writeSubtitles } from 'mediaforgejs/text';

export function subtitlesToVtt(input: string | Uint8Array): string {
  const document = parseSubtitles(input, {
    onWarning: warning => console.warn(warning.code, warning.message),
  });
  return writeSubtitles(document, 'webvtt', {
    onWarning: warning => console.warn(warning.code, warning.message),
  });
}
```

To cut out a time range and move it to zero, clip first and apply an offset. In the example below, a cue from seconds 9–13 is clipped to 10–13 and moved to 0–3.

区間を切り出して先頭を0秒にするには、切り出し範囲とオフセットを指定します。次の例では9〜13秒の字幕を10〜13秒に切り、0〜3秒へ移します。

```ts
import { parseSrt, writeWebVtt } from 'mediaforgejs/text';
import { editSubtitles } from 'mediaforgejs/text/edit';

export function subtitleExcerpt(): string {
  const document = parseSrt('1\n00:00:09,000 --> 00:00:13,000\nHello / こんにちは\n');
  const excerpt = editSubtitles(document, {
    startTime: 10,
    endTime: 20,
    offset: -10,
  });
  return writeWebVtt(excerpt);
}
```

All times here are seconds. `editSubtitles()` does not mutate the input; unchanged style/header data may still be shared. It rejects timing edits it cannot safely rewrite, including embedded WebVTT timestamps and unsupported time-dependent ASS clipping. Do not use a negative offset that would produce negative output times.

ここでの時刻はすべて秒です。`editSubtitles()` は入力を変更しませんが、変更のないスタイルやヘッダーは共有することがあります。WebVTT本文内の埋め込み時刻や、対応しないASSの時間依存装飾の切り詰めなど、安全に書き換えられない操作は拒否します。出力時刻が負になるオフセットも指定できません。

Styles and identifiers that the destination cannot represent can produce warnings. DFXP/IMSC are supported text-subset names, not full profile certification. TTML external entities and DTDs are not processed. There is no complete ASS/TTML renderer or subtitle burn-in engine here.

出力先で表せない装飾やIDは警告の対象です。DFXP/IMSCは対応するテキスト部分集合の名前で、全プロファイルへの適合認証ではありません。TTMLの外部エンティティやDTDは処理しません。完全なASS/TTML描画や字幕焼き込みのエンジンも含みません。

For embedded subtitles, `toSubtitleChunks()` and the WebVTT sample/block helpers are available. MP4 `wvtt`, WebM `D_WEBVTT`, and Matroska `S_TEXT/WEBVTT` use different payload structures. Remuxing does not silently convert between those structures just because the displayed text would be similar.

埋め込み字幕には `toSubtitleChunks()` やWebVTTのsample/blockヘルパーを使えます。MP4の `wvtt`、WebMの `D_WEBVTT`、Matroskaの `S_TEXT/WEBVTT` は格納構造が違います。表示する本文が似ていても、リマックスがこれらを黙って相互変換するわけではありません。

<a id="hls"></a>
## 15. HLS fetching and playback / HLSの取得と再生

`HlsClient` fetches media; it is not itself a player. With adaptive mode enabled it can select a supported variant from a master playlist. The example takes a **master playlist URL**, logs complete segments, and runs until a VOD ends or a live operation is cancelled. For a media playlist URL, set `adaptive: false` instead.

`HlsClient` はメディアを取得する部品で、それ自体はプレイヤーではありません。adaptiveを有効にすると、マスタープレイリストから対応する画質を選べます。次の例には **master playlistのURL** を渡します。完成セグメントを表示し、VODの終了またはライブ処理の中止まで進みます。media playlistを直接渡す場合は `adaptive: false` に変更してください。

```ts
import { HlsClient } from 'mediaforgejs/streaming/hls';
import { createRetryFetch } from 'mediaforgejs/io/retry-fetch';

export async function receiveHls(masterUrl: string, signal?: AbortSignal): Promise<void> {
  const client = new HlsClient({
    signal,
    adaptive: true,
    fetch: createRetryFetch({ maxRetries: 2 }),
    requestTimeoutMs: 30_000,
    onWarning: warning => console.warn(warning.code, warning.message),
  });
  try {
    await client.load(masterUrl);
    for await (const unit of client.segments({ live: true })) {
      console.log(unit.segment.sequence, unit.segment.discontinuitySequence);
      console.log(unit.initData, unit.data, unit.variant);
    }
  } finally {
    client.close();
  }
}
```

Without adaptive mode, a media playlist can be loaded directly. When starting from a master, select a non-I-frame variant and load its URI before iterating. Without `live: true`, iteration uses the current snapshot. A client has one active load/refresh/iteration at a time. Closing it cancels pending work and it cannot be reused.

adaptiveを使わない場合は、media playlistを直接読み込めます。masterから始める場合は、I-frame専用ではないvariantを選び、そのURIを読み込んでから列挙します。`live: true` を省略すると現在のスナップショットだけを扱います。1つのclientで同時に動かせるload・refresh・列挙は1つです。closeすると待機中の処理を中止し、そのclientは再利用できません。

Keep `initData`, timing, and discontinuity information with the media. Concatenating every returned byte array is not a general way to produce a playable file. Initialization data is reissued when needed, including supported variant changes.

メディアと一緒に `initData`、時刻、不連続情報を扱ってください。返った配列をすべて連結すれば再生可能なファイルになる、というものではありません。初期化データは、対応する画質切替など必要な場面で再通知されます。

### Adaptive selection and low-latency parts / 自動画質選択とPART

`adaptive: true` uses measured fetch bandwidth. With no `initialBandwidth`, it begins at the lowest available bandwidth; upward changes normally need several good samples. Switches require compatible codecs/groups, aligned timing, and independent boundaries. When a candidate cannot be aligned or fetched, the client can warn and keep the current variant rather than pretending the switch succeeded.

`adaptive: true` は取得帯域の測定値を使います。`initialBandwidth` がなければ低帯域から始め、上げる際には通常、複数回の良好な測定を待ちます。切替には、コーデック・groupの互換性、時刻の一致、独立した境界が必要です。候補の時刻を合わせられない、取得できないといった場合は、成功したことにせず警告して現在の画質を続けます。

`parts()` returns published PARTs, falling back to complete segments where appropriate without downloading a parent twice. It supports the documented clear/AES-128 paths and optional protection handlers. It does not implement blocking reload, speculative PRELOAD fetching, or every LL-HLS feature. Delta updates need usable prior playlist history; unsupported date-range delta updates are rejected.

`parts()` は公開済みPARTを返し、必要に応じて完成セグメントへフォールバックします。親セグメントを二重取得しません。対応する非暗号化・AES-128と任意の保護ハンドラーを使えますが、blocking reload、PRELOADの投機取得、LL-HLSの全機能は含みません。delta更新には使える前回履歴が必要で、未対応のdate-range deltaは拒否します。

The default request timeout is 30 seconds; default playlist and segment/MAP limits are 2 MiB and 64 MiB. These bound individual resources, not all memory used by decryption, copies, or your consumer.

リクエストの既定期限は30秒、プレイリストの既定上限は2 MiB、セグメント・MAPは64 MiBです。個々のリソースを制限する値で、復号、コピー、利用側の保持を含む総メモリ量ではありません。

### Play supported fMP4 HLS / 対応するfMP4 HLSを再生する

Pass a master playlist URL, as in the fetch example. Call this from a user-initiated browser action. It uses MSE and needs the correct MIME type for the actual stream. The MIME type is a parameter so the example does not claim every stream is H.264/AAC.

ブラウザーでユーザー操作から呼び出す例です。MSEを使うため、実際の配信に合うMIME typeが必要です。すべての配信をH.264/AACと決めつけないよう、MIME typeは引数にしています。

```ts
import { HlsClient } from 'mediaforgejs/streaming/hls';
import { playHls } from 'mediaforgejs/streaming/hls-playback';

export async function playStream(
  video: HTMLVideoElement,
  masterUrl: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> {
  const client = new HlsClient({ signal, adaptive: true });
  try {
    await client.load(masterUrl);
    await playHls(video, client.parts({ live: true }), {
      signal,
      mimeType,
      bufferAhead: 15,
      bufferBehind: 10,
    });
  } finally {
    client.close();
  }
}
```

This playback path takes complete fMP4 units, at most one video and/or audio track, and supported edit/timeline layouts. It is not a TS-to-MSE transmuxer or a synchronizer for separate audio/video renditions. Pause/resume uses the media element. Completion waits for actual playback `ended`; a live or paused stream can remain active until cancelled.

この再生処理が受け取るのは完全なfMP4単位で、映像・音声はそれぞれ最大1本、編集・時刻構成も対応範囲内に限ります。TSをMSE向けに変換する機能や、別URIの音声・映像を同期する機能ではありません。一時停止・再開はメディア要素で行います。完了は実際の `ended` を待つため、ライブや一時停止中は中止するまで処理が続く場合があります。

`bufferAhead` and `bufferBehind` use seconds. A single unit or long GOP can exceed those targets. Autoplay rejection is returned to the caller, not ignored. `autoplay: false` leaves starting playback to your app. The function cleans up its own MSE connection and object URL, not resources created independently by your application.

`bufferAhead` と `bufferBehind` は秒です。1単位や長いGOPによって目標を超える場合があります。自動再生が拒否されれば利用側へエラーを返します。再生開始をアプリで管理するなら `autoplay: false` にします。終了時に解放するのは、この関数が作ったMSE接続とObject URLです。

### Choose audio or subtitles / 音声・字幕を選ぶ

`getHlsRenditions(master, variant, type)` lists the referenced group. `selectHlsRendition(master, variant, { type: 'AUDIO', languages: ['ja-JP', 'en'] })` selects a candidate using the requested language/default rules. An explicit `name` is an exact selection; `forced` and `channels` can filter candidates. Fetch a separate URI with a separate client when fetching it alongside video; synchronization remains your responsibility. Language aliases such as `jpn` and `ja` are not automatically equated.

`getHlsRenditions(master, variant, type)` は参照groupの一覧を返します。`selectHlsRendition(master, variant, { type: 'AUDIO', languages: ['ja-JP', 'en'] })` は言語や既定指定の規則で候補を選びます。`name` は完全一致の明示選択、`forced` や `channels` は絞り込みです。別URIを映像と同時に取得するなら別clientを使い、同期は利用側で行います。`jpn` と `ja` のような別名も自動で同一視しません。

`parseHlsPlaylist()` and `serializeHlsPlaylist()` read/write supported playlist models. They do not preserve every unknown extension tag, comment, or original formatting. `AdaptiveQualityController` is also available separately for custom selection logic; using it with DASH does not add a DASH downloader.

`parseHlsPlaylist()` と `serializeHlsPlaylist()` は対応するプレイリストモデルを読み書きします。未知の拡張タグ、コメント、元の整形をすべて保持するものではありません。独自の選択処理には `AdaptiveQualityController` も単独で使えますが、DASHに組み合わせただけでDASH取得機能が増えるわけではありません。

<a id="dash"></a>
## 16. Static DASH planning / 静的DASHの参照計画

DASH support turns a static MPD into references you can fetch. It is not a complete adaptive DASH player. Select representations, fetch initialization/media resources, and manage playback in your application.

DASH機能は、静的MPDから取得すべきリソースの参照を作ります。完全な自動適応DASHプレイヤーではありません。Representationの選択、初期化・メディアの取得、再生管理はアプリ側で行います。

```ts
import { parseDashManifest, iterateDashSegments } from 'mediaforgejs/streaming/dash';

export function listDashSegments(xml: string, manifestUrl: string): void {
  const manifest = parseDashManifest(xml, { baseUrl: manifestUrl });
  for (const period of manifest.periods) {
    for (const group of period.adaptationSets) {
      const representation = group.representations[0];
      if (!representation) continue;
      console.log(representation.initialization);
      for (const segment of iterateDashSegments(representation, {
        start: 10, end: 20, maxSegments: 1000,
      })) {
        console.log(segment.url, segment.byteRange, segment.presentationTime);
      }
    }
  }
}
```

Use the MPD's absolute HTTP(S) URL as `baseUrl`. Supported structures include SegmentTemplate/Timeline/List, inherited BaseURL, and multiple Periods. `start`/`end` select overlapping segments in presentation seconds; they do not trim the bytes inside a segment. Raw `time`, `duration`, and `number` use `bigint` ticks/counts; `timescale` converts ticks to seconds.

`baseUrl` にはMPDの絶対HTTP(S) URLを使います。対応する構造にはSegmentTemplate/Timeline/List、BaseURLの継承、複数Periodがあります。`start` / `end` は表示秒で重なるセグメントを選び、セグメント内部のバイトを切る指定ではありません。元の `time`、`duration`、`number` はbigintのtick・番号で、秒への換算に `timescale` を使います。

Pass the original parsed representation to the iterator; spreading or restoring it from JSON does not recreate its internal plan. Dynamic MPD, ContentProtection, hierarchical sidx, and unsupported external-reference structures are rejected.

iteratorにはパーサーが返した元のRepresentationを渡してください。スプレッドやJSONからの復元では、内部の計画は再現されません。dynamic MPD、ContentProtection、階層sidx、未対応の外部参照構造は拒否します。

For SegmentBase, use `await resolveDashManifest(xml, { baseUrl, readIndex })`. Your `readIndex(resource, signal)` must return exactly the requested byte range as a `Uint8Array`. The library does not fetch it implicitly. Keep resource identity stable across index and media reads. `parseSidx()` is available for reading a complete sidx box directly.

SegmentBaseには `await resolveDashManifest(xml, { baseUrl, readIndex })` を使います。利用側の `readIndex(resource, signal)` は、要求された範囲と正確に同じ長さのUint8Arrayを返します。ライブラリが暗黙にHTTP取得することはありません。索引とメディアの読み込みでリソースの同一性も維持してください。完全なsidx boxを直接読む `parseSidx()` もあります。

<a id="segments"></a>
## 17. fMP4 and CMAF-style segments / 分割MP4を扱う

### Split a supported file / 対応ファイルを分割して出力する

`workflow.segments()` returns initialization data followed by media fragments. Handle one item at a time and save its bytes to your own storage. The function below accepts a destination callback instead of inventing a storage API.

`workflow.segments()` は初期化データに続いてメディア断片を返します。1件ずつ処理して、自分の保存先へ書き込んでください。次の例は保存APIを決めつけず、出力先のコールバックを受け取ります。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';
import type { MediaSegment } from 'mediaforgejs/engine';

export async function exportSegments(
  input: Blob,
  save: (segment: MediaSegment) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for await (const segment of new MediaWorkflow().segments(input, {
    targetDuration: 2,
    maxBufferedBytes: 16 * 1024 * 1024,
    requireKeyframe: true,
    signal,
  }, { signal })) {
    await save(segment);
  }
}
```

`targetDuration` is a target, not a maximum. Keyframes, discontinuities, and buffer limits affect the actual boundaries. Check each media fragment's `independent` flag. Splitting does not align unrelated video tracks' keyframes or manufacture missing independent frames.

`targetDuration` は目標で、最大長ではありません。キーフレーム、不連続、容量上限により実際の境界は変わります。メディア断片の `independent` を確認してください。複数映像のキーフレームを勝手に揃えたり、欠けた独立フレームを作ったりはしません。

### Read fragments before EOF / 受信完了前から断片を読む

```ts
import { readCmafSegments } from 'mediaforgejs/streaming/mp4';

export async function receiveFragments(
  input: ReadableStream<Uint8Array>,
  consume: (kind: 'init' | 'media', data: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for await (const segment of readCmafSegments(input, {
    signal,
    validation: 'compatible',
    maxBoxBytes: 32 * 1024 * 1024,
    maxSegmentBytes: 64 * 1024 * 1024,
    onWarning: warning => console.warn(warning.code, warning.message),
  })) {
    await consume(segment.kind, segment.data);
  }
}
```

This reader handles a complete ftyp/moov initialization and supported moof-relative moof+mdat fragments across arbitrary input chunk boundaries. It is not a reader for progressive MP4, absolute data offsets, or every multi-mdat layout. Compatible mode can discard an incomplete tail after valid initialization; the default is strict.

このリーダーは、完全なftyp/moov初期化と、対応するmoof相対配置のmoof+mdatを、任意の入力chunk境界をまたいで読みます。progressive MP4、絶対オフセット、あらゆる複数mdat構成のリーダーではありません。compatibleなら有効な初期化後の不完全な末尾を除外できますが、既定はstrictです。

To inspect packets in one returned fragment, combine the latest initialization bytes and that fragment with `ConcatSource`, then open it with `MediaEngine`. Do not retain the whole live stream just to inspect the next fragment. `iterateMp4Boxes()` exposes the lower-level box iterator.

返された1断片のパケットを調べるには、最新の初期化データとその断片を `ConcatSource` でまとめ、`MediaEngine` で開きます。次の断片を調べるためにライブ全体を保持する必要はありません。box単位の低水準APIには `iterateMp4Boxes()` があります。

### Build fragments from encoded samples / 圧縮済みサンプルから断片を作る

`CmafWriter` muxes samples you have already encoded. This function takes raw AAC-LC access units for 48 kHz stereo, 1024 samples per frame. Do not pass PCM, complete ADTS frames, or an arbitrary AAC configuration.

`CmafWriter` は、すでに符号化したサンプルを格納します。次の関数が受け取るのは、48 kHz・ステレオ・1フレーム1024サンプルのraw AAC-LC access unitです。PCM、ADTSヘッダー付きフレーム、別のAAC設定を渡す例ではありません。

```ts
import { CmafWriter } from 'mediaforgejs/streaming/cmaf';

export function makeAacFragment(frames: readonly Uint8Array[]) {
  if (frames.length === 0) throw new Error('At least one AAC frame is required');
  const writer = new CmafWriter({
    tracks: [{
      id: 1,
      type: 'audio',
      codec: 'mp4a.40.2',
      timescale: 48_000,
      sampleRate: 48_000,
      channelCount: 2,
      codecConfig: Uint8Array.of(0x11, 0x90),
    }],
    maxBufferedBytes: 16 * 1024 * 1024,
    maxBufferedSamples: 100_000,
  });
  const init = writer.createInitSegment();
  let dts = 0n;
  for (const data of frames) {
    writer.addSample({
      trackId: 1, data, decodeTimestamp: dts,
      duration: 1024, isKeyframe: true,
    });
    dts += 1024n;
  }
  return { init, segment: writer.flush() };
}
```

For repeated fragments, reuse the writer and flush before its buffer limits. `flush()` returns a contiguous byte array; `flushTo(sink)` writes with backpressure and returns metadata. `flushTo()` does not close your sink. Do not modify the writer while a flush is active.

複数の断片を作るならwriterを再利用し、バッファ上限になる前にflushします。`flush()` は連続した配列を返し、`flushTo(sink)` はバックプレッシャーを待って書き、メタデータを返します。`flushTo()` はSinkを閉じません。flush中にwriterを変更しないでください。

`addSample()` uses integer track ticks; `addChunk()` uses seconds. AVC/HEVC samples must use the configured length-prefixed NAL layout, not Annex B. `codecConfig` is the relevant configuration payload, not a complete box. Timed events use `addEvent()`; producer reference time can be supplied when flushing. Event timing uses its own timescale, and producer NTP time is unsigned 32.32 fixed point.

`addSample()` はトラックの整数tick、`addChunk()` は秒を使います。AVC/HEVCサンプルは設定に合うlength-prefix付きNALであり、Annex Bではありません。`codecConfig` は対応する設定payloadで、box全体ではありません。時刻付きイベントは `addEvent()`、producer reference timeはflush時に指定できます。イベントには独自のtimescaleがあり、producerのNTP時刻は符号なし32.32固定小数です。

These are fragmented ISO BMFF building blocks, not certification of every CMAF profile or a complete packaging server. Encryption and every gapless/preroll reconstruction are not added by the writer.

これらは分割ISO BMFFを組み立てる部品で、CMAF全プロファイルの適合認証や完成した配信サーバーではありません。writerだけで暗号化やあらゆるgapless・preroll再構築が追加されるわけでもありません。

<a id="drm"></a>
## 18. Encrypted HLS and DRM / 暗号化HLSとDRM

Use this section for content and keys your application is authorized to access. Fetching encrypted segments, decrypting supported clear-key formats, and asking a browser CDM to play protected media are different operations.

ここでは、アプリが利用する権限を持つコンテンツと鍵を扱います。暗号化セグメントの取得、対応する鍵形式での復号、ブラウザーCDMによる保護コンテンツの再生は、それぞれ別の処理です。

| Input / 入力 | Path / 処理 |
| --- | --- |
| Identity AES-128 | Built-in HLS WebCrypto CBC/PKCS7 decryption for supported segments and independently encrypted PART/MAP resources.<br>対応セグメントと独立暗号化されたPART/MAPを、HLSの組み込みWebCryptoで復号。 |
| Identity SAMPLE-AES | Optional `createSampleAesHandler()` for complete supported AVC/AAC TS or packed ADTS resources.<br>完全な対応AVC/AAC TS・packed ADTSに `createSampleAesHandler()` を追加。 |
| fMP4 SAMPLE-AES / SAMPLE-AES-CTR | `createHlsDrmHandler()` plus `playHlsWithDrm()` retains encryption and uses the browser CDM.<br>暗号化を維持し、ブラウザーCDMへ渡します。 |
| Custom protection / 独自方式 | Explicit `HlsEncryptionHandler` and application-provided key handling.<br>明示的なハンドラーと利用側の鍵処理。 |

The software SAMPLE-AES path does not cover HEVC, Dolby audio, software fMP4 decryption, incomplete cross-resource PES data, or TS PARTs. `HlsClientOptions.keyLoader` can replace key fetching; it does not bypass key authorization. A CDM-oriented handler marks output with `encryption`: do not feed those bytes to an ordinary clear-media conversion path.

ソフトウェアSAMPLE-AESは、HEVC、Dolby音声、fMP4のソフトウェア復号、リソースをまたぐ不完全なPES、TS PARTを対象にしません。`HlsClientOptions.keyLoader` で鍵取得を差し替えられますが、鍵の認可を回避する機能ではありません。CDM向けハンドラーの出力には `encryption` が付くので、通常の平文変換へ渡さないでください。

### Connect a configured DRM service / 設定済みのDRMサービスへ接続する

The example takes a master playlist URL and application-supplied `HlsDrmOptions`, including the key system, license callback, and any required certificate. Set `adaptive: false` when loading a media playlist directly. This keeps credentials and service-specific wire formats out of a generic example.

この例にはmaster playlistのURLと、key system、ライセンスコールバック、必要な証明書を含む `HlsDrmOptions` を渡します。media playlistを直接読み込む場合は `adaptive: false` に変更してください。認証情報やサービス固有の通信形式を、汎用サンプルへ埋め込まない構成です。

```ts
import { HlsClient } from 'mediaforgejs/streaming/hls';
import {
  createHlsDrmHandler,
  playHlsWithDrm,
  type HlsDrmOptions,
} from 'mediaforgejs/streaming/hls-drm';

export async function playProtectedStream(
  video: HTMLVideoElement,
  masterUrl: string,
  drm: HlsDrmOptions,
  signal: AbortSignal,
): Promise<void> {
  const client = new HlsClient({
    signal,
    adaptive: true,
    encryptionHandlers: [createHlsDrmHandler(drm)],
  });
  try {
    await client.load(masterUrl);
    await playHlsWithDrm(video, client.parts({ live: true }), {
      ...drm,
      signal,
      bufferAhead: 15,
      bufferBehind: 10,
    });
  } finally {
    client.close();
  }
}
```

Supported mappings include Widevine, PlayReady, and standard-EME FairPlay configurations, subject to the actual browser/CDM and content. The library does not supply a commercial CDM, license service, account, or unrestricted offline decryption. FairPlay here is not the legacy WebKit API or a replacement for native HLS `src=` playback.

対応する対応付けにはWidevine、PlayReady、標準EMEのFairPlay設定がありますが、実際のブラウザー・CDM・コンテンツの対応が必要です。商用CDM、ライセンスサービス、アカウント、制限のないオフライン復号を同梱するものではありません。ここでのFairPlayは旧WebKit APIやネイティブHLSの `src=` 再生を置き換えるものでもありません。

`createHttpLicenseCallback()` sends binary POST requests and returns binary responses. JSON/XML/base64-wrapped services need their own `license(request)` adapter. Certificate and license failures are errors, not reasons to silently try unrelated services. Never infer a license endpoint from untrusted content and send credentials to it.

`createHttpLicenseCallback()` はバイナリのPOSTとバイナリ応答用です。JSON・XML・base64などで包むサービスには独自の `license(request)` を用意します。証明書やライセンスの失敗はエラーで、無関係なサービスへ黙って切り替える理由にはしません。信用できないコンテンツからライセンス先を推測して認証情報を送らないでください。

For a lower-level integration, `EmeController.attach()` manages temporary sessions and application-provided license callbacks. `createClearKeyLicense()` serves only keys explicitly supplied by the application. Clean up your playback/MSE connection before closing the controller when the host requires it. `addSession()` completing does not mean a license has become usable, and `done` can reject asynchronously.

低水準の連携には `EmeController.attach()` があり、一時セッションと利用側のライセンスコールバックを管理します。`createClearKeyLicense()` が返すのは、アプリで明示的に渡した鍵だけです。ホストが必要とする場合は再生・MSE接続を片付けてからcontrollerを閉じます。`addSession()` の完了はライセンス使用可能を意味せず、`done` も非同期に失敗する場合があります。

Node protocol tests and ClearKey checks do not establish commercial-service compatibility. Use the [separate browser/service tests](#browser-testing) for your deployment. Persistent-license/offline DRM workflows are not provided here.

Nodeの通信モデル試験やClearKeyの確認で、商用サービスとの互換性が確定するわけではありません。利用環境では[ブラウザー・サービスの別試験](#browser-testing)を行います。永続ライセンスを使うオフラインDRMの仕組みは、このAPIには含まれません。

<a id="prores"></a>
## 19. ProRes and ProRes RAW / ProResとProRes RAW

Ordinary ProRes and ProRes RAW are different bitstreams. Packet copying belongs to the core; decoding/encoding is opt-in. You do not need the codec extension merely to copy compatible ProRes packets between MOV and MKV.

通常ProResとProRes RAWは別のビットストリームです。パケットのコピーは本体、復号・符号化は任意の追加機能です。対応するProResパケットをMOVとMKVの間でコピーするだけなら、コーデック拡張は不要です。

| Feature / 機能 | Scope / 範囲 |
| --- | --- |
| Ordinary ProRes packet copy / 通常ProResのコピー | `apco`, `apcs`, `apcn`, `apch`, `ap4h`, `ap4x`; supported MOV/MKV paths.<br>対応するMOV/MKV経路。 |
| Ordinary ProRes decoding / 通常ProResの復号 | Optional WASM codec; supported 10/12-bit planar YUV and alpha layouts.<br>任意WASMコーデック。対応する10/12 bit planar YUVとalpha。 |
| Ordinary ProRes encoding / 通常ProResの符号化 | Six profiles from progressive BT.709 RGBA8 input; alpha needs `ap4h`/`ap4x`.<br>progressive・BT.709のRGBA8から6プロファイル。alphaは `ap4h` / `ap4x`。 |
| ProRes RAW packet copy / RAWのコピー | `aprn` / `aprh` in standard MOV; not ordinary ProRes-in-MKV.<br>standard MOV。通常ProResとしてMKVへ流用しません。 |
| ProRes RAW decoding / RAWの復号 | Optional JavaScript decoder to linear 16-bit RGGB Bayer for supported version 0/1 inputs.<br>対応するversion 0/1を線形16 bit RGGB Bayerへ復号する任意JavaScript拡張。 |

### Add the ordinary ProRes codec / 通常ProResコーデックを追加する

Install the core and extension tarballs. The ordinary ProRes extension also needs its declared dependencies; use the [full offline installer](#offline) when the network/cache is unavailable.

本体と拡張のtarballを入れます。通常ProRes拡張には宣言済みの外部依存も必要です。ネットワークやキャッシュがない環境では、[完全オフライン用インストーラー](#offline)を使ってください。

```sh
npm install ./release/mediaforgejs-5.4.0.tgz ./release/mediaforgejs-prores-5.4.0.tgz
```

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow/core';
import { createVideoTransform } from 'mediaforgejs/workflow/video';
import { mp4 } from 'mediaforgejs/engine/formats/mp4';
import { matroska } from 'mediaforgejs/engine/formats/matroska';
import { proResVideoCodec } from 'mediaforgejs-prores';

export async function encodeProRes(input: Blob): Promise<Blob> {
  const formats = [mp4, matroska];
  const workflow = new MediaWorkflow({
    formats,
    transform: createVideoTransform({ formats, codecs: [proResVideoCodec] }),
  });
  return workflow.toBlob(input, {
    operation: 'convert',
    format: 'mov',
    videoCodec: 'ap4h',
    allowPrecisionLoss: true,
  });
}
```

`allowPrecisionLoss: true` explicitly permits reduction to RGBA8 where this encoder path needs it. It is not a lossless 10/12-bit-to-10/12-bit workflow. Use remuxing to preserve the original compressed data. Ordinary ProRes MOV uses standard output, so large files need a suitable patch-capable sink.

`allowPrecisionLoss: true` は、この符号化経路で必要になるRGBA8への精度低下を明示的に許します。10/12 bit素材を同じ精度で無損失変換する処理ではありません。元の圧縮データを保ちたいならリマックスを使ってください。通常ProRes MOVはstandard出力なので、大容量では適切なpatch可能Sinkが必要です。

The registered video-codec path processes one video and can copy compatible audio/subtitles. Resize, fps conversion, simultaneous audio transcoding, HDR development, and interlaced-to-progressive conversion are not supported by that adapter. It may combine a registered codec on one side with supported WebCodecs on the other.

登録型映像コーデックの処理は映像1本を扱い、対応する音声・字幕をコピーできます。このアダプターでは、拡縮、fps変更、同時の音声再圧縮、HDR現像、interlacedからprogressiveへの変換は扱いません。片側を登録コーデック、もう片側を対応WebCodecsにする組み合わせも可能です。

For packet-level work, use `createProResDecoder()` and `createProResEncoder()` from `mediaforgejs-prores`. Close returned frames after use, then close the codec. Await each encode when you do not need concurrency; the bounded queue is not a place to store a whole movie. A synchronous WASM frame cannot be cancelled halfway through.

パケット単位では、`mediaforgejs-prores` の `createProResDecoder()` と `createProResEncoder()` を使います。返されたフレームは使用後に閉じ、コーデックも閉じます。並列化が不要なら1フレームずつawaitしてください。上限付きキューへ動画全体をため込む使い方ではありません。同期WASM処理の1フレームを途中で中断することもできません。

Decoded 16-bit alpha planes are not interchangeable with every WebCodecs alpha format. `toRGBA({ allowPrecisionLoss: true })` is an SDR conversion, not HDR tone mapping or a full color-management pipeline. Release any copied plane/RGBA arrays you retain. Browser WASM caches can outlive the wrapper, so Node memory measurements do not describe every browser.

復号した16 bit alphaプレーンを、あらゆるWebCodecsのalpha形式と同一扱いしないでください。`toRGBA({ allowPrecisionLoss: true })` はSDR向けで、HDRトーンマッピングや完全な色管理ではありません。保持したプレーン・RGBA配列も不要になれば参照を外します。ブラウザーのWASMキャッシュがラッパーより長く残る場合があり、Nodeのメモリ測定をそのまま当てはめられません。

### Decode RAW / RAWを復号する

```ts
import { decodeProResRawAsync } from 'mediaforgejs-prores-raw';

export async function decodeRawPacket(data: Uint8Array, signal?: AbortSignal) {
  return decodeProResRawAsync(data, {
    codec: 'aprn',
    signal,
    tilesPerYield: 32,
  });
}
```

Pass a supported raw packet and the correct `aprn`/`aprh` codec. `frame.data` is a `Uint16Array`; `stride` counts elements per row, not bytes. The result is Bayer data, not a display-ready RGB image. Black-level correction, white balance, demosaicing, camera-to-XYZ conversion, gain, and recommended crop are left to the caller using the returned metadata. RAW encoding is not included. Compatibility with all camera-recorded variants is not established by synthetic test packets.

対応RAWパケットと、正しい `aprn` / `aprh` を渡してください。`frame.data` はUint16Arrayで、`stride` はバイト数ではなく1行の要素数です。結果はBayerデータで、そのまま表示できるRGB画像ではありません。黒レベル補正、ホワイトバランス、demosaic、camera-to-XYZ変換、gain、推奨cropは、返されたメタデータを使って利用側で処理します。RAWの符号化は含みません。合成パケットの試験だけで、全カメラ実写形式の互換性が確定するわけでもありません。

The core is WTFPL. Ordinary ProRes uses TurboRes (MPL-2.0) and prores-wasm-encoder (LGPL-2.1-or-later), and its extension includes LGPL-covered helper code. The RAW extension is LGPL-2.1-or-later. “No FFmpeg executable required” does not mean these optional codecs contain no FFmpeg-derived code. Keep the applicable license notices and supplied source material with the components you redistribute.

本体はWTFPLです。通常ProResはTurboRes（MPL-2.0）とprores-wasm-encoder（LGPL-2.1-or-later）を使い、拡張にはLGPL対象の補助コードも含みます。RAW拡張はLGPL-2.1-or-laterです。「FFmpeg実行ファイル不要」は、任意コーデックにFFmpeg由来コードがないという意味ではありません。再配布する部品のライセンス表示と同梱ソースを維持してください。

<a id="modules"></a>
## 20. Pick only the parts you need / 必要な部品だけ使う

The usual `mediaforgejs/workflow` entry registers the built-in formats and conversion parts. `workflow/core` starts empty. Use it when you know which formats and operations your application needs, not as a drop-in import replacement with identical defaults.

通常の `mediaforgejs/workflow` は組み込みの形式と変換部品を登録します。`workflow/core` は空から始まります。必要な形式・操作が決まっているときに使う入口で、インポート先だけ変えても同じ既定機能になるわけではありません。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow/core';
import { audio } from 'mediaforgejs/engine/formats/audio';
import { pcmAudio } from 'mediaforgejs/workflow/audio-pcm';

export const pcmWorkflow = new MediaWorkflow({
  formats: [audio],
  audio: pcmAudio,
});
```

This is a small PCM-focused composition. `workflow/audio-decode` supplies `nativeAudioDecoder` for the supported built-in compressed audio decoders; `workflow/audio-core` exposes `createWorkflowAudio()` for selected output encoders. `workflow/audio` provides the usual native audio output collection. Converter and Pipeline also have explicit core compositions.

これはPCM中心の小さな構成です。対応する圧縮音声の組み込み復号は `workflow/audio-decode` の `nativeAudioDecoder`、出力エンコーダーの選択構成は `workflow/audio-core` の `createWorkflowAudio()` を使います。通常の自前音声出力一式は `workflow/audio` にあります。ConverterとPipelineにも明示的なcore構成があります。

| Optional package / 任意パッケージ | Role / 役割 |
| --- | --- |
| `mediaforgejs-audio` | Audio entry points / 音声の入口 |
| `mediaforgejs-streaming` | Streaming entry points / 配信の入口 |
| `mediaforgejs-drm` | DRM entry points / DRMの入口 |
| `mediaforgejs-ffmpeg` | Explicit external FFmpeg backend / 外部FFmpegへの明示的な接続 |
| `mediaforgejs-prores` | Ordinary ProRes codec and WASM dependencies / 通常ProResコーデックとWASM依存 |
| `mediaforgejs-prores-raw` | ProRes RAW decoder / ProRes RAWデコーダー |

The first four are convenience entry packages sharing the core, not replacements that remove the core's installed files. Subpath imports and your bundler determine which code reaches an application bundle. Keep the core and extension versions compatible; the supplied release uses 5.4.0 throughout.

最初の4つは本体を共有する入口パッケージで、本体のインストール済みファイルを分割して消す仕組みではありません。アプリのバンドルへ入るコードは、サブパスのインポートとバンドラーに左右されます。本体と拡張は互換のある版を揃えてください。同梱配布はすべて5.4.0です。

### Use an installed FFmpeg explicitly / 導入済みFFmpegを明示的に使う

This is optional and separate from the FFmpeg-free core paths. You must install FFmpeg and ffprobe yourself. The adapter does not download them or add them to the browser bundle.

これはFFmpeg不要の本体処理とは別の任意機能です。FFmpegとffprobeは利用側で導入します。アダプターが自動取得したり、ブラウザーバンドルへ追加したりはしません。

```ts
import { FFmpegBackend } from 'mediaforgejs/runtime/ffmpeg';

export async function remuxWithFfmpeg(inputPath: string, outputPath: string) {
  const backend = new FFmpegBackend();
  return backend.remux(inputPath, outputPath, {
    format: 'mkv',
    timeoutMs: 120_000,
    maxInputBytes: 1024 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024 * 1024,
  });
}
```

`capabilities()` queries that installed binary; `probe()` returns ffprobe-style stream fields. `convert()` transcodes only the requested codec types, while `remux()` copies. `exportDirectory()` creates an HLS/DASH VOD package in a new directory; it is not a live packager, encrypted ABR ladder, or arbitrary FFmpeg command-line wrapper.

`capabilities()` は導入された実行ファイルの能力、`probe()` はffprobe形式のストリーム情報を返します。`convert()` は指定した種類を再圧縮し、`remux()` はコピーします。`exportDirectory()` は新規ディレクトリへHLS/DASHのVODを作ります。ライブ配信、暗号化ABR ladder、任意のFFmpeg引数を渡す汎用ラッパーではありません。

The backend targets Node/Bun process execution. Source input is spooled to a bounded temporary file; forward-only sink output needs a supported muxer, and MP4 sink output needs `fragmentedMp4: true`. Unlike Workflow, this backend leaves borrowed sources/sinks open for you to close or abort. File output is finalized before publication; output-size checks are not strict temporary-disk quotas.

このバックエンドはNode/Bunのプロセス実行向けです。Source入力は上限付き一時ファイルへ保存し、前方書き込みSinkには対応muxerが必要です。MP4のSink出力には `fragmentedMp4: true` を指定します。Workflowと違い、借用Source/Sinkは自動で閉じず、利用側でclose・abortします。ファイル出力は完成後に公開しますが、出力サイズ検査は一時ディスクの厳密な使用量上限ではありません。

<a id="offline"></a>
## 21. Offline and local use / オフライン・ローカル利用

For the complete offline setup, keep the entire `release/` directory, including the manifest, dependency archives, toolchain, and installer. Bring Node.js and npm separately. The installer checks the manifest's archives; deleting “unused-looking” pieces from that set can make validation fail.

完全オフラインで使う場合は、manifest、依存archive、toolchain、インストーラーを含む `release/` 全体を持ち込みます。Node.jsとnpmは別途用意してください。インストーラーはmanifestに記録された配布物を検証するため、不要そうな部品を部分的に消すと検証に失敗する場合があります。

Run from the source/release root. The destination must be empty or not yet exist. This installs the core and all six optional packages using local archives, without relying on a shared npm cache.

ソース・配布物のルートで実行します。保存先は空、または未作成のディレクトリにしてください。共有npmキャッシュを前提にせず、ローカルarchiveから本体と6拡張を入れます。

```sh
node release/offline/install.mjs ./offline-consumer
```

The generated application's `package.json` uses local `file:` references. Adjust those archive paths if you move the project and reinstall. After installation, runtime imports do not need the original `release/` path. Optional platform packages may be omitted according to their declared OS/CPU restrictions; missing required dependencies are errors.

生成されたアプリの `package.json` はローカルの `file:` 参照を使います。移動後に再インストールする場合はarchiveのパスも直してください。インストール後の実行には、元の `release/` の位置は不要です。OS・CPU条件のある任意依存は宣言に従って省略する場合がありますが、必須依存の欠落はエラーです。

The ordinary ProRes dependencies embed their WASM in JavaScript and do not fetch a WASM file from a CDN during codec use. Host software—browsers, CDMs, Node/npm, and an optional external FFmpeg—is not supplied by this offline dependency set. HLS, HTTP, or license calls still access whatever endpoints your app explicitly configures.

通常ProResの依存はJavaScript内にWASMを持ち、コーデック使用時にCDNからWASMを取得しません。一方、ブラウザー、CDM、Node/npm、任意の外部FFmpegといったホスト側ソフトウェアは、この依存一式には含まれません。HLS、HTTP、ライセンス通信を使えば、アプリで明示した接続先にはアクセスします。

### Local browser check / ローカルブラウザーで確かめる

```sh
node release/offline/browser.mjs ./offline-consumer
```

Open the loopback URL printed by the server. It serves installed local packages, supplies isolation headers for the codec test, and blocks external connections from the test page with CSP. The browser performs the actual codec check and writes `offline-browser-report.json` in the consumer directory. Starting the server alone is not a passed browser test.

表示されたループバックURLを開きます。インストール済みのローカルパッケージを配信し、コーデック試験用の隔離ヘッダーを設定し、試験ページの外部接続をCSPで禁止します。実際の確認はブラウザー側で行い、利用側ディレクトリへ `offline-browser-report.json` を保存します。サーバーを起動しただけでは試験合格ではありません。

### Build offline / オフラインで開発用依存を入れる

Use a fresh source directory without `node_modules`. The development mode installs the lockfile's local dependency set without rewriting the source package manifests.

`node_modules` がない新しいソース展開先で使います。developmentモードは、ソースのpackage manifestを書き換えず、lockfileに対応するローカル依存を入れます。

```sh
node release/offline/install.mjs . --development
npm run build
npm run check
```

To install only the separate verification tools, use `node release/offline/install.mjs ./offline-toolchain --toolchain`. Those tools are not runtime requirements for an ordinary application.

独立した検証ツールだけを入れるなら、`node release/offline/install.mjs ./offline-toolchain --toolchain` を使えます。通常のアプリ実行に必要な依存ではありません。

<a id="migration"></a>
## 22. Existing Converter code and migration / 既存Converterと移行

You do not need to rewrite working Converter/Pipeline code merely to adopt 5.4.0. They remain available, and images still use the Converter path. New file-based tools are generally easier to express with Workflow's input/job/output methods.

5.4.0にするだけなら、動いているConverter/Pipelineのコードをすべて書き直す必要はありません。引き続き使え、画像もConverterで扱います。新しいファイル処理ツールは、入力・Job・出力を分けたWorkflowの方が組み立てやすくなっています。

```ts
import { MediaForgeConverter } from 'mediaforgejs/converter';

export async function legacyAudioConversion(input: Blob): Promise<Blob> {
  return new MediaForgeConverter({
    outputFormat: 'mp3',
    audioBitrate: 192,
    audioSampleRate: 48_000,
  }).convert(input);
}
```

`convertToSink()` and `convertToReadableStream()` are also available. `convertBatch()` is the older batch helper. `converter/core` and `pipeline/core` accept explicit format/processing components as their second constructor argument. Missing processing pieces are errors, not a reason to silently import everything.

`convertToSink()` と `convertToReadableStream()` も使えます。`convertBatch()` は従来の一括処理ヘルパーです。`converter/core` と `pipeline/core` は、コンストラクター第2引数へ形式・処理部品を渡せます。必要な部品がなければエラーになり、黙って全機能を読み込むことはありません。

For unchanged same-format operations, the legacy path may copy original bytes rather than re-encode. Explicit precision-preserving container changes belong in the packet-remux API. Do not apply Workflow's bitrate/progress conventions to legacy APIs without checking their types.

同じ形式で変更指定がない場合、従来経路は再圧縮ではなく元のバイトをコピーすることがあります。精度を維持したコンテナ変更はパケットのリマックスAPIで行います。Workflowのビットレートや進捗の規則を、型を確認せず従来APIへ当てはめないでください。

### From 4.x Workflow to 5.x / 4.xのWorkflowから移行する

| Old use / 以前の使い方 | Current use / 現在の使い方 |
| --- | --- |
| Configuration-only `job.check(request)` / 設定だけの確認 | `job.probe(request)` |
| Execute a dry run / 出力の試運転 | `await job.check(request, { maxBytes })` |
| Different Workflow progress shapes / 操作ごとに異なるWorkflow進捗 | `({ fraction, message, packets, packetBytes })` |
| PCM-only default Workflow / PCMのみの既定Workflow | The ordinary entry includes native audio and conversion parts; use `workflow/core` for a smaller composition.<br>通常入口は自前音声と変換部品を含みます。小さな構成は `workflow/core`。 |

Engine's `checkRemux()` stays synchronous; `validateRemux()` is the execution check. Do not add an unconditional `check()` before every write unless you want to perform the operation twice. Converter/Pipeline method names and progress shapes are not redefined by this Workflow migration.

Engineの `checkRemux()` は同期のままで、実処理検証は `validateRemux()` です。2回処理する必要がなければ、毎回の書き出し前に無条件で `check()` を挟まないでください。このWorkflowの移行で、Converter/Pipelineのメソッド名や進捗形式まで変わるわけではありません。

### Older FlowCast names / 旧FlowCast名

Import `FlowCastConverter` and `FlowCastError` explicitly from `mediaforgejs/compat/flowcast` when maintaining old code. The normal bundle does not create the old globals. An old global-based page can load `dist/compat/flowcast.global.js` after the normal bundle. Build output is configured with `MEDIAFORGE_DIST_DIR`, not `FLOWCAST_DIST_DIR`.

旧コードを保守する場合は、`mediaforgejs/compat/flowcast` から `FlowCastConverter` と `FlowCastError` を明示的にインポートします。通常バンドルは旧グローバル名を作りません。旧名を使うページでは、通常バンドルの後で `dist/compat/flowcast.global.js` を読み込みます。ビルド出力先は `FLOWCAST_DIST_DIR` ではなく `MEDIAFORGE_DIST_DIR` です。

<a id="troubleshooting"></a>
## 23. Troubleshooting / 困ったとき

Start with the error code and warnings, then inspect the actual track codec/configuration. A filename extension alone rarely explains why a conversion failed.

まずエラーコードと警告を見て、実際のトラックのコーデック・設定を確認します。拡張子だけでは、変換失敗の理由は分からないことが多いです。

| Symptom / 症状 | What to check / 確認すること |
| --- | --- |
| `probe()` succeeds but output fails / 簡易確認は通るのに出力に失敗 | Probe does not read every packet or test the destination. Inspect the actual error; use `check()` only when a full dry run is useful.<br>probeは全パケットや保存先を検査しません。実際の例外を確認し、試運転が必要な場合に `check()` を使います。 |
| `FORMAT` or an incompatible track / 形式・構成エラー | Check codec, track count, required config bytes, metadata policy, and destination restrictions.<br>コーデック、トラック数、設定バイト、メタデータ方針、出力先の制限を確認します。 |
| `DECODE` / `ENCODE` | Confirm the host codec is available and the requested precision, profile, alpha, and dimensions are supported.<br>ホストのコーデックと、精度・プロファイル・透過・寸法への対応を確認します。 |
| `OOM` or output-byte limit / メモリ・出力容量上限 | Check index/sample limits and retained Blobs. Prefer file/stream output; raising one limit does not remove others.<br>索引・サンプル数の上限やBlob保持を確認します。ファイル・ストリーム出力を検討してください。 |
| `ABORT` / 中止 | Check whether your controller, job, or consumer cancelled. Treat deliberate cancellation separately from an unexpected failure.<br>controller・Job・読み手が中止していないか確認し、意図した中止と障害を分けます。 |
| Remote file rejected / HTTP入力が拒否される | Check Range/206, CORS-exposed headers, validator, timeout, and whether the file changed.<br>Range/206、CORS公開ヘッダー、検証子、期限、ファイル変更を確認します。 |
| MP3 can be inspected but not converted / MP3の情報は見えるのに変換できない | The packet reader is not an MP3 decoder. Supply a supported host/custom decoder.<br>パケット読み取りとMP3復号は別です。対応するホスト・独自デコーダーが必要です。 |
| Some audio tracks are missing from the request / 複数音声を処理できない | Select the intended `trackId`/`trackIds`; confirm whether the operation is copy-only or actual transcoding.<br>`trackId` / `trackIds` と、コピーか再圧縮かを確認します。 |
| Transparent image rejected / 透過画像が拒否される | JPEG has no alpha and GIF does not accept partial alpha in this path. Composite an explicit background first.<br>JPEGのalphaやGIFの半透明は扱えません。必要な背景へ先に合成します。 |
| A stream appears stuck / ストリームが進まない | Consume output concurrently. A paused player or backpressured destination can intentionally stop further production.<br>出力を並行して読みます。一時停止や保存先の待機で、生成が止まることもあります。 |
| Playback fails though remux succeeded / 書き出せても再生できない | Test MIME, player codec support, initialization data, keyframes, and timeline—not just container writing.<br>MIME、プレイヤーの対応、初期化、キーフレーム、時刻を確認します。 |
| ProRes works in Node, not in a page / Nodeでは動くがブラウザーで動かない | Check local import resolution, browser APIs, isolation headers, and the actual browser's WASM behavior.<br>ローカルimport解決、API、隔離ヘッダー、実ブラウザーのWASM動作を確認します。 |

For a useful bug report, include the MediaForgeJS version, browser/OS or runtime version, input track summary, exact request, and complete error/warnings. A small reproducible file or a generator is much easier to debug than a screenshot of “failed.” Remove private media, authorization headers, and license/key material before sharing.

不具合報告には、MediaForgeJSの版、ブラウザー・OSまたはランタイムの版、入力トラックの概要、実際のリクエスト、エラーと警告を載せてください。「失敗しました」の画面だけより、小さな再現ファイルや生成器があると原因を追いやすくなります。個人情報を含む素材、認証ヘッダー、ライセンスや鍵は共有前に除いてください。

<a id="development"></a>
## 24. Build, test, and release / ビルド・テスト・配布

This section is for a source checkout, not an installed runtime tarball. Test code, CI configuration, and build scripts stay in the source repository; they do not need to be shipped inside an application's runtime package.

ここからはインストール済みの実行用tarballではなく、ソース一式を使う場合の話です。テスト、CI、ビルドスクリプトはソースリポジトリに置き、アプリの実行用パッケージへ含める必要はありません。

### Local development / 手元で開発する

The source targets ES2022 and the supplied Node CI uses Node 22/24. Install dependencies, build, and run checks from the project root. For a disconnected machine, replace `npm ci` with the [offline development command](#offline).

ソースのターゲットはES2022で、同梱Node CIはNode 22/24を使います。プロジェクトルートで依存を入れ、ビルドと検査を実行してください。未接続の環境では、`npm ci` を[オフライン開発用コマンド](#offline)へ置き換えます。

```sh
npm ci
npm run build
npm run check
```

| Command / コマンド | Checks / 確認する内容 |
| --- | --- |
| `npm test` | Core regressions using local/original fixtures.<br>ローカル・独自素材を使う本体の回帰試験。 |
| `npm run test:codecs` | Optional codec tests, including actual ordinary ProRes WASM and RAW decoding.<br>通常ProResの実WASM処理やRAW復号を含む任意コーデック試験。 |
| `npm run check` | Types, formatting, core tests, and codec tests.<br>型、書式、本体試験、コーデック試験。 |
| `npm run test:corpus` | Generated format/recovery fixtures.<br>生成した形式・回復素材の試験。 |
| `npm run test:release` | Offline release/installer behavior.<br>オフライン配布・インストーラーの試験。 |
| `npm run release:verify` | Installed packed artifacts, public types, and selected actual operations in isolated offline consumers.<br>独立したオフライン利用側での配布物、公開型、選択した実処理。 |

The standard Node suite does not need downloaded media or an external FFmpeg executable. Some WebCodecs/MSE tests use protocol models; those test control flow and contracts, not actual browser decoding. Performance scripts such as `bench:demux` and `bench:workflow` are comparisons, not universal speed guarantees.

標準Node試験には、メディアのダウンロードや外部FFmpeg実行ファイルは不要です。一部のWebCodecs/MSE試験はモデルを使い、処理の流れや契約を確認します。実ブラウザーの復号結果ではありません。`bench:demux` や `bench:workflow` などの性能測定も比較用で、あらゆる環境の速度保証ではありません。

<a id="browser-testing"></a>
### Browser and service tests / ブラウザーと実サービスの試験

Install the actual browser and matching driver. The supplied workflow is in `.github/workflows/browser-ci.yml`; Safari needs a suitable macOS host and Remote Automation. A prepared harness is not a completed browser run.

実際のブラウザーと対応するドライバーを用意します。同梱ワークフローは `.github/workflows/browser-ci.yml` にあります。Safariには適切なmacOSとRemote Automationが必要です。ハーネスを準備しただけでは、ブラウザーを実行したことにはなりません。

```sh
node --test test/browser/harness.test.mjs
node scripts/browser-ci.mjs --prepare-only
node scripts/browser-ci.mjs --browser chrome
node scripts/browser-ci.mjs --browser firefox
node scripts/browser-ci.mjs --browser safari
```

Reports go under `artifacts/browser/<browser>/` by default. Check `status`, individual checks, and `browserExecuted` together. `prepared` is preparation only; `skipped` is not passed. A created browser session alone does not prove successful decoding or playback. The browser checks cover their generated media, not all codec profiles, phones, or production streams.

結果は既定で `artifacts/browser/<browser>/` に入ります。`status`、個別の試験、`browserExecuted` を合わせて確認します。`prepared` は準備のみ、`skipped` は合格ではありません。セッションができただけで、復号・再生に成功したことにはなりません。ブラウザー試験の対象も生成した素材であり、全プロファイル・スマートフォン・本番配信ではありません。

For commercial DRM, inject authorized service configuration into `MEDIAFORGE_DRM_SERVICE_JSON` through secret management, then run a separate service check. Do not paste credentials into documentation or commit the configuration.

商用DRMは、権限のあるサービス設定を秘密情報管理から `MEDIAFORGE_DRM_SERVICE_JSON` へ渡し、別途試験します。認証情報を文書へ貼り付けたり、設定をコミットしたりしないでください。

```sh
node scripts/browser-ci.mjs --browser chrome --drm-service --require-service
```

The service JSON includes `keySystem`, `manifestUrl`, `mimeType`, `expectedDurationSeconds`, and a `license` object with `url` and any required headers/credentials. It can set `media.allowedOrigins`, `minUsableKeys`, `minKeyChanges`, and `configurations`; FairPlay needs the service's `certificateBase64`. The harness expects an authorized HTTPS, 2–120 second, zero-start fMP4 VOD media playlist with `ENDLIST`, not an arbitrary live/master playlist. Its generic license helper uses binary POST/response; service-specific wrappers need an adapter.

サービスJSONには `keySystem`、`manifestUrl`、`mimeType`、`expectedDurationSeconds`、`url` と必要なヘッダー・credentialsを持つ `license` を指定します。`media.allowedOrigins`、`minUsableKeys`、`minKeyChanges`、`configurations` も設定でき、FairPlayにはサービスの `certificateBase64` が必要です。試験対象は認可済みHTTPSの、0秒始まり・2〜120秒・ENDLIST付きfMP4 VOD media playlistであり、任意のlive/masterではありません。汎用ライセンス処理はバイナリPOST/応答なので、独自形式にはアダプターが必要です。

The workflow uses `MEDIAFORGE_DRM_CHROME`, `MEDIAFORGE_DRM_FIREFOX`, and `MEDIAFORGE_DRM_SAFARI` secrets. Physical Safari and commercial DRM jobs are opt-in. Keep untrusted pull-request code away from a credentialed runner. Read the actual report rather than assuming a workflow file establishes a successful run.

ワークフローのsecret名は `MEDIAFORGE_DRM_CHROME`、`MEDIAFORGE_DRM_FIREFOX`、`MEDIAFORGE_DRM_SAFARI` です。実機Safariや商用DRMのジョブは明示的に有効にします。認証情報のあるrunnerで信用できないpull requestを実行しないでください。ワークフローの存在を成功記録とみなさず、実際のレポートを確認します。

Neither `release:verify` nor this guide certifies completed Chrome/Firefox/Safari, commercial DRM, every camera's ProRes RAW, or long-running high-resolution browser ProRes tests. Those need their own recorded runs on the intended systems.

`release:verify` やこのガイドは、Chrome/Firefox/Safari、商用DRM、全カメラのProRes RAW、ブラウザーでの長時間・高解像度ProRes試験の完了証明ではありません。対象環境で別の実行記録が必要です。

### Package a release / 配布物を作る

After testing the source, repack it. Documentation is copied into the core tarball, so changing a Markdown file also means repacking any prebuilt release you distribute.

ソースを検査したら、配布物を作り直します。文書も本体tarballへ入るため、Markdownを変更した場合も、一緒に配るビルド済みreleaseを再梱包してください。

```sh
npm run build
npm run check
npm run release:pack
npm run test:release
npm run release:verify
```

`release:pack` builds the seven project tarballs and their manifest, keeping optional ProRes dependencies and development tools separately under `release/offline/`. The offline dependency closure is verified rather than silently omitting missing archives. If dependencies changed, prepare their original locked archives before packing offline.

`release:pack` は7つのプロジェクトtarballとmanifestを作り、ProResの外部依存や開発ツールを `release/offline/` に分けます。依存の一式を検証し、足りないarchiveを黙って省略しません。依存を更新した場合は、オフライン梱包の前にlockfileに対応する原本archiveを用意してください。

`release:verify` creates fresh consumers, installs local archives with networking blocked, checks public declarations, and runs selected media operations. It can run from a release-containing source ZIP before installing development dependencies:

`release:verify` は新しい利用側環境を作り、ネットワークを遮断してローカルarchiveを導入し、公開型と選択したメディア処理を確認します。releaseを含むソースZIPなら、開発用依存を入れる前でも次を実行できます。

```sh
node scripts/release.mjs verify
```

Only publish the project's own verified tarballs, using an account authorized for those package names. A local package command does not publish anything. Do not republish `release/offline/` dependencies under this project's name.

公開するのはプロジェクト自身の検証済みtarballで、各パッケージ名への権限があるアカウントを使います。ローカルでの梱包コマンドだけでは何も公開されません。`release/offline/` の外部依存を、このプロジェクト名で再公開しないでください。

### What stays in the repository? / リポジトリに残すもの

Keep source, functional tests, fixture generators, build scripts, package manifests/lockfile, and useful CI in the development repository. The runtime package is selected by `package.json`'s `files`: built code, declarations, README files, this guide, and licenses. Generated release archives can be distributed separately from Git history. Do not remove third-party license notices or editable source supplied with the optional codecs as “test clutter.”

開発リポジトリには、ソース、機能試験、素材生成器、ビルドスクリプト、package manifest・lockfile、有用なCIを残します。実行用パッケージは `package.json` の `files` で選び、ビルド済みコード、型、README、このガイド、ライセンスを入れます。生成済みreleaseはGit履歴とは別に配れます。第三者ライセンス表示や任意コーデックの同梱ソースを、不要なテストとして削除しないでください。

Keep the changelog when release history is useful. It is not needed at runtime; neither is the formatter configuration. Removing a development file may still require updating the scripts that refer to it.

版ごとの変更を追いたい場合はチェンジログを残します。チェンジログや書式設定は実行時には不要ですが、開発用ファイルを削除するときは、それを参照するスクリプトも確認してください。

<a id="reference"></a>
## 25. Where to look next / 詳しい引数を調べる

The shipped declaration files are the reference for exact arguments and return types in this version. Use the entry below that matches the task you are working on. Imports in the examples use public package subpaths; the links below open their declaration files.

この版の正確な引数と返り値は、同梱の型定義で確認できます。必要な処理に対応する入口を、下の一覧から選べます。コード例のimportは公開サブパスを使い、下のリンクは対応する型定義を開きます。

| API | Reference / 型定義 |
| --- | --- |
| Workflow requests, progress, options / リクエスト・進捗・設定 | [workflow/types.d.ts](../dist/workflow/types.d.ts) |
| Workflow methods / メソッド | [workflow/core.d.ts](../dist/workflow/core.d.ts) · [workflow/job.d.ts](../dist/workflow/job.d.ts) |
| Engine, tracks, remux, segments / トラック・リマックス・分割 | [engine/engine-core.d.ts](../dist/engine/engine-core.d.ts) |
| Sources and sinks / 入出力 | [io/index.d.ts](../dist/io/index.d.ts) · [runtime/node.d.ts](../dist/runtime/node.d.ts) |
| Converter and Pipeline / 従来の変換API | [converter.d.ts](../dist/converter.d.ts) · [pipeline.d.ts](../dist/pipeline.d.ts) |
| Subtitle API / 字幕 | [text/index.d.ts](../dist/text/index.d.ts) · [text/edit.d.ts](../dist/text/edit.d.ts) |
| Metadata / メタデータ | [metadata/index.d.ts](../dist/metadata/index.d.ts) |
| HLS fetch and playback / HLS取得・再生 | [streaming/hls-client.d.ts](../dist/streaming/hls-client.d.ts) · [streaming/hls-playback.d.ts](../dist/streaming/hls-playback.d.ts) |
| DASH and CMAF | [streaming/dash.d.ts](../dist/streaming/dash.d.ts) · [streaming/cmaf.d.ts](../dist/streaming/cmaf.d.ts) |
| Incremental MP4 input / 逐次MP4入力 | [streaming/mp4-stream.d.ts](../dist/streaming/mp4-stream.d.ts) |
| DRM | [streaming/hls-drm.d.ts](../dist/streaming/hls-drm.d.ts) · [drm/eme-controller.d.ts](../dist/drm/eme-controller.d.ts) |
| External FFmpeg / 外部FFmpeg | [runtime/ffmpeg.d.ts](../dist/runtime/ffmpeg.d.ts) |

Optional codecs ship their own README, types, licenses, and third-party notices. Keep those with their packages; they describe codec-specific settings that do not belong to the core Workflow options.

任意コーデックにはそれぞれREADME、型、ライセンス、第三者通知を同梱しています。本体Workflowの設定とは別のコーデック固有設定を説明しているため、各パッケージと一緒に維持してください。

[Back to contents / 目次へ](#contents)
