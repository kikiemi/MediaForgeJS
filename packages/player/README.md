# mediaforgejs-player

HLS and DASH playback through Media Source Extensions for MediaForgeJS: the plugin that `play()` and
`createPlayer()` use, and the parts it is made of.

```sh
npm install mediaforgejs mediaforgejs-player
```

```ts
import { MediaForge } from 'mediaforgejs';
import { player } from 'mediaforgejs-player';

const forge = new MediaForge({ plugins: { add: [player] } });
const playback = forge.play('https://example.com/live/master.m3u8', video, { adaptive: true });
playback.finished.catch(error => console.warn(error.code, error.message));
```

Without this plugin, `play()` and `createPlayer()` of mediaforgejs fail with `PLUGIN` before any request.
Each player loads with the first stream of its protocol.

| What plays |                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HLS        | fMP4 (CMAF) units with at most one video and one audio track: VOD and live playlists, low-latency parts, adaptive variants, AUDIO renditions in a SourceBuffer of their own, WebVTT SUBTITLES renditions as text tracks, AES-128, SAMPLE-AES, EME DRM (`cenc`, `cbcs`) |
| DASH       | Static MPDs of fMP4 segments (SegmentTemplate, SegmentList, SegmentTimeline, SegmentBase with sidx): the first period's video and audio, each from its highest representation, on one timeline                                                                         |

MPEG-TS segments are not transmuxed; dynamic MPDs, protected DASH and DASH quality switching are not played.
The `audio` and `subtitles` options of `play()` choose the renditions (`{ name?, language? }`; `subtitles: false`
adds no text tracks).

The parts, for applications that drive playback themselves: `HlsClient` (playlists, segments, parts, adaptive
variants, live refreshes), `playHls` (fMP4 units into MediaSource), `AdaptiveQualityController`, and for encrypted
streams `createHlsDrmHandler`, `playHlsWithDrm`, `EmeController`, `createClearKeyLicense`,
`createHttpLicenseCallback`, `createSampleAesHandler`, `decryptSampleAesAac` and `decryptSampleAesAvc`.
`PlayDrmOptions` is the `drm` option of `play()`. The library supplies integration pieces, not a CDM or a license
service: use them only with media and keys you are authorized to access.

The HLS playlist and DASH MPD parsers, renditions, CMAF writing, packaging and AES-128 segment encryption stay in
`mediaforgejs/streaming`; this package uses them through that entry. The guide of mediaforgejs
(`docs/README.md` in its package) describes playback under "Play an HLS or DASH stream" and "Encrypted playback".

## 日本語

MediaForgeJSのための、Media Source ExtensionsによるHLSとDASHの再生です。`play()` と `createPlayer()` が使う
プラグインと、それを作る部品を含みます。

```sh
npm install mediaforgejs mediaforgejs-player
```

`new MediaForge({ plugins: { add: [player] } })` のようにプラグインを追加すると、`play()` と `createPlayer()` が
HLSとDASHを再生します。追加しないと、どちらもリクエストの前に `PLUGIN` で失敗します。プレーヤーはそれぞれの
プロトコルの最初のストリームで読み込まれます。

再生できるのは、映像1本と音声1本までのfMP4（CMAF）のHLS（VODとライブ、低遅延のパート、バリアントの切り替え、
自分のSourceBufferで再生するAUDIOのレンディション、テキストトラックにするWebVTTのSUBTITLESのレンディション、
AES-128・SAMPLE-AES・EMEのDRM）と、fMP4セグメントの静的なDASH MPDです。MPEG-TSのセグメントは変換せず、動的なMPD・
保護されたDASH・DASHの画質の切り替えは再生しません。`play()` の `audio` と `subtitles` でレンディションを選びます
（`{ name?, language? }`。`subtitles: false` ではテキストトラックを加えません）。

再生を自分で組み立てるアプリケーションのために、`HlsClient`・`playHls`・`AdaptiveQualityController` と、暗号化された
ストリームのための `createHlsDrmHandler`・`playHlsWithDrm`・`EmeController`・`createClearKeyLicense`・
`createHttpLicenseCallback`・`createSampleAesHandler`・`decryptSampleAesAac`・`decryptSampleAesAvc` も公開します。
`PlayDrmOptions` は `play()` の `drm` 設定の型です。用意するのは組み込み用の部品で、CDMやライセンスサービスでは
ありません。権限のあるメディアと鍵にだけ使ってください。

HLSプレイリストとDASH MPDの解析、レンディション、CMAFの書き込み、パッケージ化、セグメントのAES-128暗号化は
`mediaforgejs/streaming` にあり、このパッケージもそのエントリーを通して使います。
