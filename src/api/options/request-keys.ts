/** Settings of frame extraction, which the API snapshots and the workflow normalizes. */
export const FRAME_KEYS = [
    'format',
    'times',
    'every',
    'maxFrames',
    'trackId',
    'width',
    'height',
    'fit',
    'crop',
    'rotate',
    'flip',
    'stages',
    'signal',
] as const;

/** Settings of one picture: the frame geometry, the time and the image format. */
export const THUMBNAIL_KEYS: readonly string[] = [
    ...FRAME_KEYS.filter(
        key => key !== 'times' && key !== 'every' && key !== 'maxFrames' && key !== 'format',
    ),
    'time',
    'to',
    'quality',
];

/** Settings of play() and of a player. */
export const PLAY_KEYS: readonly string[] = [
    'protocol',
    'mimeType',
    'autoplay',
    'bufferAhead',
    'bufferBehind',
    'operationTimeoutMs',
    'requestTimeoutMs',
    'live',
    'adaptive',
    'fetch',
    'drm',
    'audio',
    'subtitles',
    'signal',
];
