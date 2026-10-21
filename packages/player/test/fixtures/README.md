# Player test fixtures

## ClearKey (`clearkey.m3u8`, `init.mp4`, `seg-1.m4s` … `seg-3.m4s`)

One second of a 440 Hz tone as mono Opus in fragmented MP4, encrypted with the `cenc` scheme
(AES-128-CTR, 8-byte IVs, whole samples), and the HLS media playlist that plays it with ClearKey.
`play-browser.test.mjs` plays it through EME in the browser.

- KID: `0123456789abcdef0123456789abcdef`
- Key: `fedcba9876543210fedcba9876543210`
- The init segment carries a ClearKey `pssh` (system `1077efec-c0b2-4d02-ace3-3c1e52e2fb4b`) with
  the KID; the playlist's `EXT-X-KEY` is `METHOD=SAMPLE-AES-CTR,KEYFORMAT="org.w3.clearkey"`.

FFmpeg writes the clear fragmented MP4. Its `cenc-aes-ctr` encryption leaves the per-sample IVs
out of the fragments, so `make-clearkey.mjs` (Node only, run once, not a test) encrypts the samples
and adds `senc`, `saiz` and `saio` to each fragment and `sinf`/`tenc` to the sample entry:

```sh
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1" -ac 1 -c:a libopus -b:a 24k \
    -movflags +empty_moov+default_base_moof+frag_keyframe -frag_duration 500000 clear.mp4
node make-clearkey.mjs clear.mp4
rm clear.mp4
```

The files were made with FFmpeg 6.1.1 and Node 22; they are committed so that the test needs
neither.
