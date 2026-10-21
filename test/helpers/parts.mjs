// Parts of the plugin contract that tests build: a reader part around a test's reader.

/**
 * A reader part from a test's reader `{ formats, read, probe?, sniff?, priority? }`, whose load
 * resolves with the reader itself.
 */
export function readerPart(reader) {
    return {
        id: reader.formats[0],
        formats: reader.formats,
        ...(reader.sniff ? { sniff: reader.sniff } : {}),
        ...(reader.priority !== undefined ? { priority: reader.priority } : {}),
        load: async () => reader,
    };
}

/**
 * The decoder and encoder parts of an application video codec written as one object
 * `{ id, supportsDecode, supportsEncode, createDecoder, createEncoder }`: both replace the host for
 * their codecs.
 */
export function codecParts(codec) {
    // The methods are taken once, as a plugin's parts are: changing the object later changes
    // nothing.
    const { id, supportsDecode, supportsEncode, createDecoder, createEncoder } = codec;
    return {
        decoders: [
            {
                kind: 'video',
                id,
                codecs: name => supportsDecode.call(codec, name),
                replacesHost: true,
                load: async () => config => createDecoder.call(codec, config),
            },
        ],
        encoders: [
            {
                kind: 'video',
                id,
                codecs: name => supportsEncode.call(codec, name),
                load: async () => config => createEncoder.call(codec, config),
            },
        ],
    };
}
