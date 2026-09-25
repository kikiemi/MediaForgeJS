# MediaForgeJS 5.4.0

TypeScript製のメディアライブラリです。ファイルの検査、再圧縮しない形式変換、音声変換、HLS/PART、字幕、メタデータを扱います。共通本体の実行時依存はなく、FFmpegは明示的に追加する任意のバックエンドです。

## インストール

この配布版はZIPを展開してインストールできます。npmレジストリへの公開は未実施です。

```sh
npm install ./MediaForgeJS-main
```

本体と6拡張のnpm tarball、オフライン導入に必要なProRes依存を`release/`に同梱しています。[配布手順](docs/RELEASING-JA.md)を参照してください。

完全オフラインでの導入、CDNを使わないブラウザー構成、ローカルファイル利用は[オフライン利用](docs/OFFLINE-JA.md)を参照してください。

## まず使う

新規コードは`MediaWorkflow`から始めます。入力にはBlob、Uint8Array、Sourceを渡せます。

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow';

const workflow = new MediaWorkflow();

export async function copyToTs(input: Blob): Promise<Blob> {
    return workflow.toBlob(input, { operation: 'remux', format: 'ts' });
}

export async function convertAudio(input: Blob): Promise<Blob> {
    return workflow.toBlob(input, {
        operation: 'audio', format: 'mp3', bitrateKbps: 192,
    });
}

export async function convertToM4a(input: Blob): Promise<Blob> {
    return workflow.toBlob(input, {
        operation: 'convert', format: 'm4a', audioCodec: 'mp4a.40.2',
    });
}
```

`remux`は選択した全トラックをコピーします。対象形式が扱えないトラック構成やコーデックはエラーにし、保持できない任意メタデータは既定で警告して続行します。音声変換で音声が複数ある場合は、唯一の既定音声を使うか、`trackId`を指定します。

通常入口は`convert`も登録済みです。対応PCMやAAC-LCからM4Aへの変換はFFmpeg・WebCodecsなしで動きます。映像変換はWebCodecsを使用し、任意のProRes拡張でソフトウェアの復号・符号化も利用できます。

同じ入力を検査してから処理するときはJobを開き、使い終わったら閉じます。

```ts
const job = await workflow.open(input, {
    onWarning: warning => console.warn(warning.message),
});
try {
    console.log(job.inspect().tracks);
    const request = { operation: 'remux', format: 'mkv' } as const;
    const support = await job.check(request);
    if (!support.supported) throw new Error(support.reason);
    const output = await job.toBlob(request);
} finally {
    job.close();
}
```

`check()`はパケット処理とfinalizeまで実行するため、本出力と合わせると処理は2回です。通常の出力に必須ではありません。設定だけの軽い照会には`probe()`を使います。

## 大きなファイルを出力する

```ts
import { FileSource, FileSink } from 'mediaforgejs/runtime/node';

const source = await FileSource.open('input.mp4');
try {
    const sink = await FileSink.open('output.ts');
    try {
        await workflow.write(source, sink, { operation: 'remux', format: 'ts' }, {
            open: { maxIndexBytes: 128 * 1024 * 1024 },
            maxBytes: 4 * 1024 * 1024 * 1024,
        });
    } catch (error) {
        await sink.abort(error);
        throw error;
    }
} finally {
    await source.close();
}
```

`write()`は出力全体をBlobに蓄積しません。`check`・`toBlob`・`write`の単発APIは共通の`{open, maxBytes}`を使えます。`toBlob`の既定上限は256 MiBです。`check`・`write`・ストリームは既定の出力上限を設けず、明示した`maxBytes`を適用します。入力の索引は形式に応じて保持します。全経路で一定のメモリ量になるわけではありません。[メモリ使用量](docs/MEMORY-JA.md)と[Workflow API](docs/WORKFLOW-JA.md)を参照してください。

## 主なネイティブ経路

| 用途 | 対応 |
| --- | --- |
| 複数音声 → MPEG-TS | AAC、AC3、EAC3、MPEG Audio。映像はAVC/HEVC最大1本、合計64トラック以内 |
| AVI H.264 → MKV/MP4 | 設定・NAL格納形式・Bフレームの表示時刻を復元する |
| ProRes MOV ↔ MKV | 6プロファイルのコピー。任意WASM拡張で復号・RGBA8入力からの符号化も可能 |
| ProRes RAW | aprn/aprhのMOVコピー。任意JavaScript拡張で16bit linear RGGB Bayerへ復号 |
| 複数映像＋複数音声 | MP4/MOV、MKV、分割MP4の対応コーデック |
| AVI PCM → MKV | 対応する整数・浮動小数PCMをコピー |
| 音声変換 | PCM、AAC-LC、MPEG Layer I/IIをJavaScriptで復号。PCM/AAC-LC/MP2/MP3/FLACへ符号化 |
| メタデータ | MP4の名前・タイトル・既定指定、字幕のforced、Matroskaの対象付きタグなど |
| 配信と再生 | HLS/PART取得・対応する暗号復号、静的DASH計画、任意登録のMSE/EME連携 |

MP3の復号とProRes拡張以外の映像変換はホストのWebCodecs等が必要です。ProResの色深度・透過・RAW現像の範囲は[ProRes API](docs/PRORES-JA.md)を参照してください。コンテナとコーデックには設定・配置による条件があります。[対応表](docs/SUPPORT-JA.md)、[保護HLS](docs/PROTECTED-HLS-JA.md)、[ストリーミング](docs/STREAMING-JA.md)に範囲を記載しています。

## 必要な機能だけ組み込む

```ts
import { MediaWorkflow } from 'mediaforgejs/workflow/core';
import { mp4 } from 'mediaforgejs/engine/formats/mp4';
import { ts } from 'mediaforgejs/engine/formats/ts';

export const workflow = new MediaWorkflow({ formats: [mp4, ts] });
```

`workflow/core`は空の構成から始まります。音声・映像処理も必要なモジュールだけ追加できます。パケット単位の処理には`MediaEngine`、低水準操作には`demux/*`・`mux/*`・`audio/*`を使えます。[API一覧](docs/API-JA.md)、[従来Converter/Pipeline](docs/CONVERSION-JA.md)も利用できます。旧名FlowCastは[明示的な互換入口](docs/MIGRATION-4-JA.md)だけに残しています。

## 開発と検証

```sh
npm ci
npm run build
npm run check
npm run release:pack
npm run release:verify
```

標準テストは独自の生成素材・固定素材で実行し、FFmpegや外部メディアのダウンロードは不要です。任意の互換性検査ではFFmpegを出力の検査器として使います。[テストの実行](docs/TESTING-JA.md)、[対応範囲](docs/SUPPORT-JA.md)、[ブラウザーCI](docs/BROWSER-CI-JA.md)を参照してください。Chrome/Firefox/Safariと商用DRMの実環境結果は未取得です。WASMの実測条件と未検証範囲は[検証結果](docs/VERIFICATION-JA.md)を参照してください。
