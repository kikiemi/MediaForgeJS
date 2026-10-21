/**
 * Tiny pictures of the formats only some hosts decode, which capabilities() asks the host's
 * createImageBitmap to decode where neither its canvas nor the library's encoders make one: grey
 * squares by ffmpeg 6.1.1 (libaom-av1, libx265, libjxl), in base64.
 *
 * - avif (308 bytes): `ffmpeg -f lavfi -i "color=c=gray:s=8x8" -frames:v 1 -c:v libaom-av1
 *   -still-picture 1 -pix_fmt yuv420p -crf 50 sample.avif`
 * - heif (361 bytes): `ffmpeg -f lavfi -i "color=c=gray:s=16x16,format=yuv420p" -frames:v 1
 *   -c:v libx265 -x265-params info=0:crf=40:log-level=error -f hevc sample.hevc`, then
 *   `node test/helpers/make-heif.mjs sample.hevc sample.heic 2 2 2`
 * - jxl (32 bytes): `ffmpeg -f lavfi -i "color=c=gray:s=8x8" -frames:v 1 -c:v libjxl
 *   -distance 0 sample.jxl`
 */
const SAMPLES = {
    avif:
        'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAA' +
        'AAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEA' +
        'AAATAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNw' +
        'ZQAAAAAAAAAIAAAACAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lw' +
        'bWEAAAAAAAAAAQABBAECgwQAAAAbbWRhdAoFGAi/bAIyChyAAABYAABABMA=',
    heif:
        'AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABPW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAA' +
        'AAAAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABXQAAAAwAAAAjaWluZgAAAAAAAQAAABVp' +
        'bmZlAgAAAAABAABodmMxAAAAAMFpcHJwAAAAo2lwY28AAAB0aHZjQwEBYAAAAJAAAAAAAB7wAPz9+PgAAA8DoAAB' +
        'ABhAAQwB//8BYAAAAwCQAAADAAADAB6VmAmhAAEAKEIBAQFgAAADAJAAAAMAAAMAHqCIRZZWaryvAWgIAAADAAgA' +
        'AAMAyECiAAEABkQBwXPQiQAAABRpc3BlAAAAAAAAABAAAAAQAAAAE2NvbHJuY2x4AAIAAgACAAAAABZpcG1hAAAA' +
        'AAAAAAEAAQOBAgMAAAAUbWRhdAAAAAgoAa8E2Pq94A==',
    jxl: '/wpBQCQIAgEAVABLGIsVwklBXiACgAAAAAAAAAAAAAA=',
} as const;

/** The bytes of the sample of `format`. */
export function imageSample(format: keyof typeof SAMPLES): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(SAMPLES[format]), char => char.charCodeAt(0));
}

/** Whether there is a sample of `format`. */
export const hasImageSample = (format: string): format is keyof typeof SAMPLES => format in SAMPLES;
