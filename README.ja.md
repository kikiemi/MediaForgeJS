# MediaForgeJS

[English](README.md) · 日本語

ファイルの検査、再圧縮しないコンテナ変換、音声・映像変換、字幕処理、ストリーミングを扱うTypeScriptライブラリです。ES Modules、TypeScriptの型定義、単一ファイルのブラウザー用バンドルを提供します。

本体に実行時のnpm依存はなく、FFmpegも必須ではありません。ローカルの入力はローカルで処理でき、メディアをアップロードするサーバーは不要です。映像の再符号化には実行環境のWebCodecs、または明示的に登録したコーデックを使用します。ProResコーデックとFFmpeg連携は任意の追加機能です。

このREADMEは **5.4.0** を対象としています。コンテナの読み書き、コーデックの復号・符号化、プレイヤーでの再生は別の機能です。コーデック名を認識できても、すべての処理に対応するわけではありません。

## インストール

### 配布用tarballを使用する

本体のtarballを取得し、組み込み先のアプリケーションのディレクトリでインストールします。

```sh
npm install ./mediaforgejs-5.4.0.tgz
```

配布一式では、このファイルは `release/` にあります。実際の保存先に合わせてパスを変更してください。この方法はnpmレジストリでの公開状況に依存しません。tarballにはビルド済みJavaScriptと型定義が含まれるため、利用側でのビルドは不要です。

本体と**任意の6拡張をまとめてオフライン導入**する場合は、配布一式を展開したディレクトリで次を実行します。導入先には空のディレクトリ、または未作成のパスを指定してください。

```sh
node release/offline/install.mjs ./offline-consumer
```

このインストーラーには、manifestと依存パッケージのarchiveを含む `release/` 全体が必要です。Node.jsとnpmは別途用意してください。詳細は[オフライン・ローカル利用](docs/README.md#offline)を参照してください。

### ブラウザー用バンドルを使用する

次のHTMLを `dist/` と同じ階層から配信します。別の場所に配置する場合はscriptのパスを変更してください。

```html
<input id="media-file" type="file">
<pre id="result"></pre>
<script src="./dist/MediaForgeJS.min.js"></script>
<script>
  const workflow = new MediaForgeJS.MediaWorkflow();
  const result = document.getElementById('result');

  document.getElementById('media-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const info = await workflow.inspect(file);
      result.textContent = JSON.stringify({
        format: info.format,
        tracks: info.tracks.map(({ id, type, codec }) => ({ id, type, codec })),
      }, null, 2);
    } catch (error) {
      result.textContent = String(error);
    }
  });
</script>
```

CDNは不要です。バンドルは `MediaForgeJS` と `MediaForgeJSReady` をグローバルに追加します。`MediaForgeJS.noConflict()` はAPIを返し、置き換えたグローバルを元に戻します。ES Modulesのimportでは、これらのグローバルは追加しません。本体バンドルにProResコーデックの依存パッケージは含まれません。

ローカルで処理できることと、すべてのブラウザーAPIが `file://` で動作することは別です。モジュールを使うアプリではローカルHTTPサーバーを使用し、WebCodecs、Worker、MSE、ProResそれぞれの実行条件を確認してください。セキュアコンテキストやcross-origin isolationを必要とする経路があります。

## 基本的な使い方

新規のファイル処理には `MediaWorkflow` を使用します。入力には `File`、`Blob`、`ArrayBuffer`、型付き配列などのビュー、ライブラリの `Source` を渡せます。

### 検査とリマックス

リマックスは、復号・再符号化せずに圧縮パケットを別のコンテナへコピーする処理です。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

const workflow = new MediaWorkflow();

export async function toMatroska(input: Blob): Promise<Blob> {
  const job = await workflow.open(input, {
    onWarning: warning => console.warn(warning.message),
  });

  try {
    console.log(job.inspect().tracks);
    const request = { operation: 'remux', format: 'mkv' } as const;
    const support = job.probe(request);
    if (!support.supported) throw new Error(support.reason);
    return await job.toBlob(request);
  } finally {
    job.close();
  }
}
```

出力先が、選択したコーデックとトラック構成に対応している必要があります。未対応トラックを黙って捨てることはありません。保持できない任意メタデータは既定で警告します。損失を拒否する場合は、入力を開くオプションに `metadataPolicy: 'error'` を指定します。

`probe()` は全パケットを読み込まない設定照会です。`await job.check(request, { maxBytes })` は、出力を保持せずに全パケットと最終処理まで実行します。事前検証は必須ではなく、`check()` の後に出力すると処理は2回になります。検証に成功しても、特定プレイヤーでの再生や、その後の書き込み先でI/O障害が起きないことまでは保証しません。

### 音声変換・進捗・キャンセル

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function toMp3(input: Blob, signal?: AbortSignal): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'audio',
    format: 'mp3',
    bitrateKbps: 192,
    signal,
    onProgress: ({ fraction }) => console.log(`${Math.round(fraction * 100)}%`),
  }, {
    open: {
      signal,
      onWarning: warning => console.warn(warning.message),
    },
  });
}
```

`AbortController` の `signal` を渡し、`abort()` で中止します。Workflowの進捗 `fraction` は `0`〜`1` です。`audio` 操作のビットレートは `bitrateKbps`、`convert` 操作の `audioBitrate` と `videoBitrate` はbits/sで指定します。時刻の単位は秒です。

組み込みの音声経路は、対応するPCM、AAC-LC、MPEG Layer I/IIをJavaScriptで復号します。MP3の復号には、実行環境の `AudioDecoder` または登録したデコーダーが必要です。音声が複数ある場合は、既定音声が一意に定まる場合を除き、`trackId` で選択します。

PCMとFLACの再符号化出力は16bitです。浮動小数PCMや16bitを超える整数PCMには、明示的な `allowPrecisionLoss: true` が必要です。元の精度を保持したい場合は、再符号化ではなくリマックスを使用してください。

対応するPCMまたはAAC-LC入力からは、WebCodecsやFFmpegを使わずにM4Aへ変換することもできます。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

export async function toM4a(input: Blob): Promise<Blob> {
  return new MediaWorkflow().toBlob(input, {
    operation: 'convert',
    format: 'm4a',
    audioCodec: 'mp4a.40.2',
  });
}
```

### Blobへ蓄積せずファイルへ出力する

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
        open: { maxIndexBytes: 128 * 1024 * 1024 },
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

入力と出力には別のファイルを指定してください。出力先はopen時に切り詰められます。成功した書き込みはSinkを閉じますが、処理の初期段階で拒否された場合はWorkflowがSinkを引き受ける前に失敗するため、例では呼び出し側でも `abort()` しています。呼び出し側が渡したSourceは、呼び出し側で閉じます。

`toBlob()` は出力全体を保持し、既定で **256 MiB** に制限します。`write()`、`check()`、`toReadableStream()` に既定の出力バイト上限はありません。必要に応じて `maxBytes` を指定してください。ストリームはバックプレッシャーに対応しますが、コンテナの索引にはメモリが必要です。`patchAt()` を持たないSinkへのstandard MP4/MOV出力では、圧縮データを保持することがあります。**全形式・全経路で一定のメモリ量を保証するものではありません。** 詳細は[メモリ使用量](docs/README.md#memory)を参照してください。

## 対応する処理と形式

次の表は実装されている経路の概要です。コンテナ、プロファイル、サンプル形式、ブラウザー機能のあらゆる組み合わせに対応するという意味ではありません。条件は[対応範囲・制限](docs/README.md#formats)に記載しています。

| 分野 | 対応範囲 |
| --- | --- |
| コンテナ入力 | MP4/MOV/M4A/M4V/3GP、分割MP4、Matroska/WebM、MPEG-TS、AVI、FLV |
| 音声入力・索引化 | ADTS AAC、MPEG Audio Layer I/II/III、WAV/RF64、FLAC、Ogg Opus/Vorbis、AIFF/AIFC・AU・CAFの対応PCM部分集合 |
| パケットコピー出力 | MP4/MOV/M4A/M4V/3GP、分割MP4、MKV/WebM、TS、AVI、FLV、WAV、FLAC、Ogg、AIFF/AIFC、AU、CAF、一致するraw AAC/MPEG音声。コーデックと配置による制約あり |
| 組み込み音声符号化 | AAC-LC、MP2、MP3、FLAC、WAV/AIFF/AU/CAFのPCM。M4A内のAAC-LCは `operation: 'convert'` で処理 |
| 映像の再符号化 | 実行環境のWebCodecsと明示的に登録した映像コーデック。設定と実行環境に依存 |
| 画像出力 | 画像・Converter APIによるPNG、JPEG、WebP、BMP、TIFF、ICO、GIF、APNG。入力復号と一部の符号化はブラウザーAPIに依存 |
| 字幕テキスト | SRT、WebVTT、ASS/SSA、対応するTTML/DFXP/IMSCのテキストと時刻。完全な装飾描画・字幕焼き込みは対象外 |
| ストリーミング | HLS取得と自動画質選択、対応する低遅延PART処理、fMP4/CMAF向けの分割出力、任意のMSE再生、静的DASHの参照計画 |
| メタデータ | トラック名・タイトル・言語・既定/強制指定、対応するMatroskaタグ・章・添付ファイル、損失時の診断 |

MPEG-TS出力はAVC/HEVC映像最大1本と対応する複数音声を扱い、合計64トラック以内です。WebMではWebMのコーデック制約を適用し、任意のMatroskaコーデックを許可しません。既定の映像変換経路で再符号化できるのは映像最大1本・音声最大1本です。コピーだけの処理では、互換性のある複数トラックを保持できます。

HLSはLL-HLSの全機能を実装したものではありません。DASHは静的manifestから参照を計画する機能で、完全な自動画質切り替えプレイヤーではありません。EME連携はブラウザーのCDMとアプリケーション側のライセンス処理を使用します。商用CDM、ライセンスサービス、任意のDRMコンテンツをオフライン復号する機能は提供しません。

### 画像と字幕

画像は `MediaWorkflow` のファイル処理ではなく、Converter APIを使用します。

```ts
import { MediaForgeConverter } from 'mediaforgejs/converter';

export async function toWebP(input: Blob): Promise<Blob> {
  const converter = new MediaForgeConverter({
    outputFormat: 'webp',
    width: 1280,
    imageFit: 'scale-down',
    imageQuality: 0.9,
  });
  return converter.convertImage(input);
}
```

この画像変換例には、対応するブラウザーの画像・Canvas APIが必要です。一方、字幕テキストの変換にブラウザーは不要です。

```ts
import { parseSubtitles, writeSubtitles } from 'mediaforgejs/text';

export function srtToWebVtt(srt: string): string {
  return writeSubtitles(parseSubtitles(srt, { format: 'srt' }), 'webvtt');
}
```

字幕テキストを変換できることと、リマックス時に埋め込み字幕を自動変換することは別です。[Converter API](docs/README.md#migration)と[API一覧](docs/README.md#reference)も参照してください。

## 必要な機能だけ組み込む

既定のWorkflowは組み込み形式、ネイティブ音声処理、実行環境の映像変換を登録します。`workflow/core` は、それらを登録しない構成から始まります。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow/core';
import { mp4 } from 'mediaforgejs/engine/formats/mp4';
import { ts } from 'mediaforgejs/engine/formats/ts';

export const workflow = new MediaWorkflow({ formats: [mp4, ts] });
```

この構成は検査やリマックスなどのパケット処理用です。再符号化には音声・変換モジュールを明示的に追加します。`dist/` 内部のファイルを直接importするのではなく、公開されたサブパスを使用してください。

パケット単位の処理には `MediaEngine` を使用できます。そのほかに `io`、`text`、`metadata`、`demux/*`、`mux/*`、`audio/*`、`streaming/*`、`drm/*` の入口があります。実行環境別のアダプターは `runtime/node`、`runtime/bun`、`runtime/deno`、任意の `runtime/ffmpeg` に分かれています。既存のConverter/Pipeline APIも利用でき、旧名FlowCastの別名は明示的な互換入口からのみ提供します。

## 任意の拡張とProRes

下表の音声・配信・DRM・FFmpeg用パッケージは、本体APIの再エクスポートです。実装を別々に複製したものではありません。ProRes用の2パッケージは追加コーデックを提供します。

| パッケージ | 用途 |
| --- | --- |
| `mediaforgejs-audio` | 音声処理と音声Workflowの入口 |
| `mediaforgejs-streaming` | HLS、静的DASH、CMAF、自動画質選択、再生の入口 |
| `mediaforgejs-drm` | 明示的に使うEME、HLS保護、ライセンス処理の入口 |
| `mediaforgejs-ffmpeg` | 別途インストールしたFFmpeg/ffprobeとの連携。実行ファイルは同梱しない |
| `mediaforgejs-prores` | TurboResとprores-wasm-encoderを使う、任意の通常ProRes WASM復号・符号化 |
| `mediaforgejs-prores-raw` | 任意のJavaScript ProRes RAWパケットデコーダー |

本体は、通常ProResの `apco`、`apcs`、`apcn`、`apch`、`ap4h`、`ap4x` を、対応するMOVとMKVの間でコピーできます。ProRes RAWの `aprn`、`aprh` のパケットコピーにはstandard MOVを使用します。復号・符号化には、それぞれの拡張が必要です。

通常ProRes拡張は対応する10/12bit YUVとalphaを復号し、progressive・BT.709のRGBA8入力から6プロファイルへ符号化します。8bit入力を高bit深度の原素材と同じ精度にするものではありません。ProRes RAWの復号結果は16bit linear RGGB Bayerで、現像済みのRGB画像ではありません。RAW符号化、demosaic、カメラ用ISPは含みません。

本体が実行時依存を持たなくても、**通常ProRes拡張には追加の実行時依存があります。** 別途インストールするか、オフライン配布一式を使用してください。導入前に[ProRes APIと制限](docs/README.md#prores)を確認してください。

## 開発と検証

ソースのターゲットはES2022です。開発にはNode.jsとnpmを使用し、Node CIは22・24を対象に設定しています。公開するのはES Modulesで、独立したCommonJSビルドはありません。Node・Bun・Denoで動く部分があっても、ブラウザー専用処理に必要なAPIが自動で追加されるわけではありません。

ソースのディレクトリで実行します。

```sh
npm ci
npm run build
npm run check
npm run release:pack
npm run test:release
npm run release:verify
```

オフライン配布一式では、レジストリへ接続せずに開発用依存を導入することもできます。

```sh
node release/offline/install.mjs . --development
```

このコマンドは `node_modules` のない、新しいソース展開先で実行してください。

`npm test` は本体の回帰試験です。`npm run check` は型・書式・任意コーデックの試験も実行します。`release:verify` は梱包済みパッケージを分離した利用側ディレクトリへ導入し、公開型と選択した実処理を検証します。標準のNodeテストはローカルの素材を使い、FFmpegやメディアのダウンロードは不要です。

Nodeの試験合格は、実ブラウザーでの再生結果ではありません。同梱資料では、Chrome/Firefox/Safari、商用DRM、カメラ実写のProRes RAW、ブラウザーでの長時間・高解像度ProResの検証完了までは確認できません。実ブラウザーでの検証は `release:verify` とは別です。[テスト](docs/README.md#development)、[ブラウザーCI](docs/README.md#browser-testing)、[検証条件と未検証範囲](docs/README.md#development)を参照してください。

## ドキュメント

[使い方ガイド](docs/README.md)に、英語と日本語を1ファイルでまとめています。コード例は両言語共通です。

| 調べたいこと | 参照先 |
| --- | --- |
| まず動かす | [導入](docs/README.md#install)、[検査とリマックス](docs/README.md#workflow) |
| ファイルを変換する | [音声](docs/README.md#audio)、[動画](docs/README.md#video)、[画像](docs/README.md#images)、[字幕](docs/README.md#subtitles) |
| 読み込みと保存 | [ファイル・HTTP](docs/README.md#io)、[メモリ](docs/README.md#memory)、[メタデータ](docs/README.md#metadata) |
| 配信を扱う | [HLS](docs/README.md#hls)、[DASH](docs/README.md#dash)、[fMP4・CMAF](docs/README.md#segments)、[DRM](docs/README.md#drm) |
| 配置・組み込み | [ProRes](docs/README.md#prores)、[必要な部品だけ使う](docs/README.md#modules)、[オフライン利用](docs/README.md#offline) |
| 既存コード・保守 | [移行](docs/README.md#migration)、[困ったとき](docs/README.md#troubleshooting)、[ビルドと配布](docs/README.md#development) |

## ライセンス

本体は [WTFPL](LICENSE) です。任意拡張とその依存には別の条件があります。`mediaforgejs-prores` の宣言は `(WTFPL AND LGPL-2.1-or-later)`、TurboResはMPL-2.0、prores-wasm-encoderはLGPL-2.1-or-later、`mediaforgejs-prores-raw` はLGPL-2.1-or-laterです。

各構成要素を再配布する際は、対応するLICENSE、NOTICE、第三者ライセンス通知、ソース資料を保持してください。本体のライセンスが、任意コーデックや外部FFmpegビルドのライセンスを置き換えることはありません。
