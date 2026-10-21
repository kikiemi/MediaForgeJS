/** MIME type of each format the library reads or writes. */
const MIME_TYPES: Readonly<Record<string, string>> = {
    fmp4: 'video/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    ogg: 'audio/ogg',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aiff: 'audio/aiff',
    au: 'audio/basic',
    caf: 'audio/x-caf',
    gif: 'image/gif',
    apng: 'image/apng',
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ts: 'video/mp2t',
    mpeg: 'video/mpeg',
    mp2: 'audio/mp2',
    mp1: 'audio/mpeg',
    ac3: 'audio/ac3',
    eac3: 'audio/eac3',
    dts: 'audio/vnd.dts',
    truehd: 'audio/vnd.dolby.mlp',
    m4a: 'audio/mp4',
    m4v: 'video/x-m4v',
    avif: 'image/avif',
    heif: 'image/heif',
    jxl: 'image/jxl',
    asf: 'video/x-ms-asf',
    mxf: 'application/mxf',
    ivf: 'video/x-ivf',
    obu: 'video/av1',
    iamf: 'audio/iamf',
    apv: 'video/apv',
};

/** The MIME type of a format name, or application/octet-stream. */
export function mimeTypeOf(format: string): string {
    return MIME_TYPES[format] ?? 'application/octet-stream';
}

/** File name extension written for each canonical format where it differs from the format name. */
const EXTENSIONS: Readonly<Record<string, string>> = {
    fmp4: 'mp4',
    jpeg: 'jpg',
    'hls+dash': 'm3u8',
    hls: 'm3u8',
    dash: 'mpd',
};

/** The file extension for a canonical format. */
export function extensionOf(format: string): string {
    return EXTENSIONS[format] ?? format;
}
