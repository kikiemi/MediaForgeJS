import { bufferCopy } from './codec';

// FLAC for the host's AudioDecoder, loaded only where a FLAC track is decoded through it.

/**
 * A FLAC stream of 16 silent samples, 48 kHz mono 16-bit, the library's encoder wrote: its
 * registered description ('fLaC' and STREAMINFO, FLAC_PROBE_DESCRIPTION bytes), then its frame.
 */
const FLAC_PROBE =
    '664c6143800000221000100000000d00000d0bb800f00000001070bc8f4b72a86921468bf8e8441dce51' +
    'fff87a0800000fea000000c73d';
const FLAC_PROBE_DESCRIPTION = 42;

/** Whether the host decodes FLAC from a FLACSpecificBox only; probed once. */
let flacBoxed: Promise<boolean> | undefined;

/**
 * `config` of FLAC as the host decodes it: with the registered description ('fLaC' and the
 * metadata blocks), or where the host decodes nothing from that, as Safari, which takes the
 * configuration and fails every packet, with the ISOBMFF FLACSpecificBox ('dfLa') of the blocks,
 * which Safari decodes. Other configurations are returned as they are.
 */
export async function hostFlacDecoderConfig(
    config: AudioDecoderConfig,
): Promise<AudioDecoderConfig> {
    if (config.codec !== 'flac' || !config.description) return config;
    flacBoxed ??= flacNeedsBox();
    if (!(await flacBoxed)) return config;
    return { ...config, description: flacBox(bufferCopy(config.description)) };
}

/** The FLACSpecificBox of a registered FLAC description: its metadata blocks in a 'dfLa' box. */
function flacBox(description: Uint8Array): Uint8Array<ArrayBuffer> {
    const blocks = description.subarray(4);
    const box = new Uint8Array(12 + blocks.length);
    new DataView(box.buffer).setUint32(0, box.length);
    box.set([0x64, 0x66, 0x4c, 0x61], 4);
    box.set(blocks, 12);
    return box;
}

/** Whether the host decodes the probe stream from its FLACSpecificBox and not from its own. */
async function flacNeedsBox(): Promise<boolean> {
    const stream = Uint8Array.from(FLAC_PROBE.match(/../g)!, pair => parseInt(pair, 16));
    const description = stream.subarray(0, FLAC_PROBE_DESCRIPTION);
    const frame = stream.subarray(FLAC_PROBE_DESCRIPTION);
    const shape = { codec: 'flac', sampleRate: 48000, numberOfChannels: 1 };
    if (await decodesFrame({ ...shape, description }, frame)) return false;
    return decodesFrame({ ...shape, description: flacBox(description) }, frame);
}

/** Whether a host AudioDecoder of `config` outputs audio for the one packet `frame`. */
async function decodesFrame(config: AudioDecoderConfig, frame: Uint8Array): Promise<boolean> {
    let decoded = false;
    let decoder: AudioDecoder | undefined;
    try {
        decoder = new AudioDecoder({
            output: audio => {
                decoded = true;
                audio.close();
            },
            error: () => undefined,
        });
        decoder.configure(config);
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: frame }));
        await decoder.flush();
    } catch {
        // The host decoded nothing of it.
    } finally {
        if (decoder && decoder.state !== 'closed') decoder.close();
    }
    return decoded;
}
