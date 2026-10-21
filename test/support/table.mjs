// The support table: every feature the library declares, one cell each, read off its own
// declarations rather than kept by hand. capabilities() gives the containers read and written, the
// codecs each writer copies, the software video decoders, the image formats and the packaging
// targets; the plugin manifests give the library's audio decoders and encoders; the player
// package's manifest its protocols; the probe lists of capabilities() what the host is asked;
// OPERATION_TARGETS of api/target the target classes of each operation of the default entry. The
// cells of the host (WebCodecs, MSE, EME) run in a browser.
// The module loads in Node and in the browser test page alike.
import * as forge from 'mediaforgejs';
import { allPlugins } from 'mediaforgejs/plugins';

/**
 * The kinds of cell, in the order the report lists them, with what a case of each checks and
 * where it runs.
 */
export const KINDS = Object.freeze({
    read: { title: 'read the container', where: 'node' },
    write: { title: 'write the container', where: 'node' },
    copy: { title: 'copy the codec into the container', where: 'node' },
    decode: { title: 'decode the codec with the library', where: 'node' },
    encode: { title: 'encode the codec with the library', where: 'node' },
    'image-in': { title: 'read and decode the image format', where: 'node' },
    'image-out': { title: 'write the image format', where: 'node' },
    package: { title: 'package the presentation', where: 'node' },
    operation: { title: 'run the public operation', where: 'node' },
    'host-decode': { title: "decode the codec with the host's WebCodecs", where: 'browser' },
    'host-encode': { title: "encode the codec with the host's WebCodecs", where: 'browser' },
    play: { title: 'play the protocol with mediaforgejs-player', where: 'browser' },
});

/** How a cell reads in a report or a test: its id and what its kind checks. */
export const cellName = cell => `${cell.id}: ${KINDS[cell.kind].title}`;

/** The family of a codec string: 'avc1.42e01e' -> 'avc1'. */
export const codecFamily = codec => codec.split('.')[0];

/**
 * Every cell of the table, in a stable order:
 * { id, kind, subject, container?, media?, targetClass?, formats?, host?, where }.
 * `id` is '<kind>/<subject>', 'copy/<container>/<codec>', or 'operation/<name>/<class>' for an
 * operation that takes a target of that class ('container', 'audio', 'image' or 'package', with
 * the `formats` it takes of it; OPERATION_TARGETS of api/target declares them); a copy or decode
 * cell names its `media`; `host` marks an image format only the host decodes or writes.
 */
export async function supportTable() {
    const [capabilities, internals, targets, player, hostImages, gradients] = await Promise.all([
        forge.capabilities(),
        import('../../dist/esm/api/capabilities.js'),
        import('../../dist/esm/api/target.js'),
        import('../../packages/player/dist/index.js'),
        import('../../dist/esm/codecs/image/host-formats.js'),
        import('../helpers/support-streams.mjs'),
    ]);
    const { BUILTIN_AUDIO_DECODER_FAMILIES } =
        await import('../../dist/esm/pipeline/codecs/audio-track-decoder.js');
    const cells = [];
    const add = (kind, subject, extra = {}) =>
        cells.push({
            id: extra.container
                ? `${kind}/${extra.container}/${subject}`
                : extra.targetClass
                  ? `${kind}/${subject}/${extra.targetClass}`
                  : `${kind}/${subject}`,
            kind,
            subject,
            ...extra,
            where: extra.where ?? KINDS[kind].where,
        });

    for (const format of capabilities.containers.read) add('read', format);
    for (const format of capabilities.containers.write) add('write', format);
    for (const [media, table] of [
        ['video', capabilities.videoCopy],
        ['audio', capabilities.audioCopy],
    ])
        for (const [container, codecs] of Object.entries(table))
            for (const codec of codecs) add('copy', codec, { container, media });

    const parts = role => allPlugins.flatMap(plugin => plugin[role] ?? []);
    const libraryAudioDecode = [
        ...BUILTIN_AUDIO_DECODER_FAMILIES,
        ...parts('decoders')
            .filter(part => part.kind === 'audio')
            .flatMap(part => part.codecs),
    ];
    for (const codec of new Set(libraryAudioDecode)) add('decode', codec, { media: 'audio' });
    for (const id of capabilities.video.decoders) add('decode', id, { media: 'video' });
    const libraryEncode = parts('encoders')
        .filter(part => part.kind === 'audio')
        .flatMap(part => part.codecs);
    for (const codec of new Set(libraryEncode)) add('encode', codec);

    // capabilities() lists a format only the host decodes or writes (`host`) where this host does
    // it. The table lists it as a browser cell, whose case checks the refusal where the host lacks
    // it. A picture only the host decodes needs a fixture of known pixels, which the library's
    // encoders write (BMP, ICO) or ffmpeg wrote (the gradients of test/helpers/support-streams); a
    // format with neither would be no cell.
    const library = format => !hostImages.HOST_ONLY_IMAGE_FORMATS.includes(format);
    const fixture = format =>
        format in gradients.GRADIENTS || (library(format) && capabilities.images.includes(format));
    const union = (declared, hostOnly) => [...new Set([...declared, ...hostOnly])].sort();
    for (const format of union(capabilities.imageRead, hostImages.HOST_DECODED_FORMATS)) {
        const host = hostImages.HOST_DECODED_FORMATS.includes(format);
        if (host && !fixture(format)) continue;
        add('image-in', format, host ? { where: 'browser', host: true } : {});
    }
    for (const format of union(capabilities.images, hostImages.HOST_ONLY_IMAGE_FORMATS))
        add(
            'image-out',
            format,
            hostImages.HOST_ONLY_IMAGE_FORMATS.includes(format)
                ? { where: 'browser', host: true }
                : {},
        );
    for (const target of capabilities.packaging) add('package', target);
    const operations = Object.keys(forge)
        .sort()
        .filter(
            name =>
                typeof forge[name] === 'function' &&
                typeof forge.MediaForge.prototype[name] === 'function',
        );
    const declared = Object.keys(targets.OPERATION_TARGETS).sort();
    if (operations.join() !== declared.join())
        throw new Error(
            `OPERATION_TARGETS (api/target) declares ${declared.join(', ')}; the default entry ` +
                `has ${operations.join(', ')}`,
        );
    for (const name of operations)
        for (const [targetClass, formats] of Object.entries(targets.OPERATION_TARGETS[name]))
            if (targetClass === 'none') add('operation', name);
            else add('operation', name, { targetClass, formats });

    for (const [name] of internals.HOST_AUDIO_DECODE_PROBES) add('host-decode', name);
    for (const codec of internals.ALL_VIDEO) add('host-decode', codec);
    const libraryEncoded = new Set(
        [...libraryEncode, 'pcm'].map(codec => (codec === 'aac' ? 'mp4a' : codec)),
    );
    for (const codec of internals.ALL_AUDIO)
        if (!libraryEncoded.has(codecFamily(codec))) add('host-encode', codec);
    for (const codec of internals.ALL_VIDEO) add('host-encode', codec);
    for (const part of player.player.players)
        for (const protocol of part.protocols) add('play', protocol);

    const ids = new Set();
    for (const cell of cells) {
        if (ids.has(cell.id)) throw new Error(`the support table declares ${cell.id} twice`);
        ids.add(cell.id);
    }
    return cells;
}
