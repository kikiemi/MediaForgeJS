import { DecodeError } from '../../core/errors/errors';
import { ilog, VorbisBits } from './bits';
import { VorbisCodebook } from './codebook';
import { VorbisFloor0, VorbisFloor1, type VorbisFloor } from './floor';
import { VorbisMdct } from './mdct';
import { VorbisResidue } from './residue';

function invalid(message: string): never {
    throw new DecodeError(`Vorbis headers are invalid: ${message}`);
}

/**
 * Splits a Xiph-laced configuration (Matroska CodecPrivate; the demuxers' codecConfig) into its
 * header packets.
 */
export function splitVorbisHeaders(config: Uint8Array): Uint8Array[] {
    if (config.length < 1) invalid('the configuration is empty');
    const count = config[0]! + 1;
    const sizes: number[] = [];
    let offset = 1;
    for (let i = 0; i < count - 1; i++) {
        let size = 0;
        for (;;) {
            if (offset >= config.length) invalid('the header lacing is truncated');
            const lace = config[offset++]!;
            size += lace;
            if (lace !== 255) break;
        }
        sizes.push(size);
    }

    const headers: Uint8Array[] = [];
    for (const size of sizes) {
        if (offset + size > config.length) invalid('a header exceeds the configuration');
        headers.push(config.subarray(offset, offset + size));
        offset += size;
    }

    headers.push(config.subarray(offset));
    return headers;
}

function expectHeader(bits: VorbisBits, packet: Uint8Array, type: number): void {
    bits.init(packet);
    if (packet.length < 7 || bits.read(8) !== type)
        invalid(`header packet type ${type} is missing`);
    for (const code of [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])
        if (bits.read(8) !== code) invalid('the header signature');
}

interface VorbisMapping {
    readonly channelSubmap: Uint8Array;
    readonly couplingMagnitude: Uint8Array;
    readonly couplingAngle: Uint8Array;
    readonly submapFloor: VorbisFloor[];
    readonly submapResidue: VorbisResidue[];
}

interface VorbisMode {
    readonly blockFlag: number;
    readonly mapping: VorbisMapping;
}

/**
 * Vorbis I decoder for one logical stream: identification and setup headers in, overlap-added PCM
 * planes out.
 */
export class VorbisDecoder {
    readonly channels: number;
    readonly sampleRate: number;
    readonly blockSizes: readonly [number, number];
    private readonly modes: VorbisMode[] = [];
    private readonly modeBits: number;
    private readonly mdct: readonly [VorbisMdct, VorbisMdct];
    private readonly windows: readonly [Float32Array, Float32Array];
    private readonly bits = new VorbisBits();
    private readonly spectrum: Float32Array[] = [];
    private readonly block: Float32Array[] = [];
    private readonly saved: Float32Array[] = [];
    private readonly nonzero: boolean[];
    private readonly bundlePlanes: Float32Array[] = [];
    private readonly bundleNonzero: boolean[] = [];
    private previousBlock = 0;

    constructor(config: Uint8Array) {
        const headers = splitVorbisHeaders(config);
        if (headers.length < 3) invalid('three header packets are required');
        const bits = this.bits;
        expectHeader(bits, headers[0]!, 1);
        if (bits.read(32) !== 0) invalid('the version is not zero');
        const channels = bits.read(8);
        const sampleRate = bits.read(32);
        bits.read(32);
        bits.read(32);
        bits.read(32);
        const small = 1 << bits.read(4);
        const large = 1 << bits.read(4);
        if (channels < 1 || sampleRate < 1) invalid('the audio shape');
        if (small < 64 || large < small || large > 8192) invalid('the block sizes');
        if (bits.read(1) !== 1) invalid('the identification framing bit');
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.blockSizes = [small, large];
        expectHeader(bits, headers[2]!, 5);
        const books: VorbisCodebook[] = [];
        const bookCount = bits.read(8) + 1;
        for (let i = 0; i < bookCount; i++) books.push(new VorbisCodebook(bits));
        const times = bits.read(6) + 1;
        for (let i = 0; i < times; i++) if (bits.read(16) !== 0) invalid('the time transform');
        const floors: VorbisFloor[] = [];
        const floorCount = bits.read(6) + 1;
        for (let i = 0; i < floorCount; i++) {
            const type = bits.read(16);
            if (type === 0) floors.push(new VorbisFloor0(bits, books, channels));
            else if (type === 1) floors.push(new VorbisFloor1(bits, books, channels));
            else invalid(`floor type ${type}`);
        }

        const residues: VorbisResidue[] = [];
        const residueCount = bits.read(6) + 1;
        for (let i = 0; i < residueCount; i++) {
            const type = bits.read(16);
            if (type < 0 || type > 2) invalid(`residue type ${type}`);
            residues.push(new VorbisResidue(type, bits, books, channels));
        }

        const mappings: VorbisMapping[] = [];
        const mappingCount = bits.read(6) + 1;
        for (let i = 0; i < mappingCount; i++) {
            if (bits.read(16) !== 0) invalid('the mapping type');
            const submaps = bits.read(1) ? bits.read(4) + 1 : 1;
            const magnitudes: number[] = [];
            const angles: number[] = [];
            if (bits.read(1)) {
                const steps = bits.read(8) + 1;
                for (let s = 0; s < steps; s++) {
                    const magnitude = bits.read(ilog(channels - 1));
                    const angle = bits.read(ilog(channels - 1));
                    if (
                        magnitude < 0 ||
                        angle < 0 ||
                        magnitude === angle ||
                        magnitude >= channels ||
                        angle >= channels
                    )
                        invalid('a coupling step');

                    magnitudes.push(magnitude);
                    angles.push(angle);
                }
            }

            if (bits.read(2) !== 0) invalid('the mapping reserved bits');
            const channelSubmap = new Uint8Array(channels);
            if (submaps > 1) {
                for (let c = 0; c < channels; c++) {
                    const submap = bits.read(4);
                    if (submap < 0 || submap >= submaps) invalid('a channel submap');
                    channelSubmap[c] = submap;
                }
            }

            const submapFloor: VorbisFloor[] = [];
            const submapResidue: VorbisResidue[] = [];
            for (let s = 0; s < submaps; s++) {
                bits.read(8);
                const floor = floors[bits.read(8)];
                const residue = residues[bits.read(8)];
                if (!floor || !residue) invalid('a submap floor or residue');
                submapFloor.push(floor);
                submapResidue.push(residue);
            }

            mappings.push({
                channelSubmap,
                couplingMagnitude: Uint8Array.from(magnitudes),
                couplingAngle: Uint8Array.from(angles),
                submapFloor,
                submapResidue,
            });
        }

        const modeCount = bits.read(6) + 1;
        for (let i = 0; i < modeCount; i++) {
            const blockFlag = bits.read(1);
            if (bits.read(16) !== 0 || bits.read(16) !== 0)
                invalid('a mode window or transform type');
            const mapping = mappings[bits.read(8)];
            if (blockFlag < 0 || !mapping) invalid('a mode mapping');
            this.modes.push({ blockFlag, mapping });
        }

        if (bits.read(1) !== 1) invalid('the setup framing bit');
        this.modeBits = ilog(modeCount - 1);
        this.mdct = [new VorbisMdct(small), new VorbisMdct(large)];
        this.windows = [vorbisWindow(small), vorbisWindow(large)];
        for (let c = 0; c < channels; c++) {
            this.spectrum.push(new Float32Array(large >> 1));
            this.block.push(new Float32Array(large));
            this.saved.push(new Float32Array(large >> 1));
        }

        this.nonzero = new Array<boolean>(channels).fill(false);
    }

    /**
     * Forgets the overlap state, as at a stream start: the next packet primes the window and yields
     * no samples.
     */
    reset(): void {
        this.previousBlock = 0;
    }

    /** Block size of an audio packet's mode (Vorbis I section 4.3.1). */
    packetBlockSize(packet: Uint8Array): number {
        const bits = this.bits;
        bits.init(packet);
        if (bits.read(1) !== 0) throw new DecodeError('Vorbis packet is not an audio packet');
        const mode = this.modes[bits.read(this.modeBits)];
        if (!mode) throw new DecodeError('Vorbis packet names a missing mode');
        return this.blockSizes[mode.blockFlag]!;
    }

    /**
     * Samples the next packet completes: a quarter of the previous and of its own block, or none
     * for the first.
     */
    packetFrames(packet: Uint8Array): number {
        const block = this.packetBlockSize(packet);
        return this.previousBlock ? (this.previousBlock + block) >> 2 : 0;
    }

    /**
     * Decodes one audio packet, writing the completed samples to the start of `out`; returns their
     * count.
     */
    decode(packet: Uint8Array, out: readonly Float32Array[]): number {
        const bits = this.bits;
        bits.init(packet);
        if (bits.read(1) !== 0) throw new DecodeError('Vorbis packet is not an audio packet');
        const mode = this.modes[bits.read(this.modeBits)];
        if (!mode) throw new DecodeError('Vorbis packet names a missing mode');
        const w = mode.blockFlag;
        if (w) {
            bits.read(1);
            bits.read(1);
        }

        const n = this.blockSizes[w]!;
        const half = n >> 1;
        const { channels, spectrum, nonzero } = this;
        const mapping = mode.mapping;
        for (let c = 0; c < channels; c++) {
            const floor = mapping.submapFloor[mapping.channelSubmap[c]!]!;
            nonzero[c] = floor.read(bits, c);
            spectrum[c]!.fill(0, 0, half);
        }

        for (let s = 0; s < mapping.couplingMagnitude.length; s++) {
            const magnitude = mapping.couplingMagnitude[s]!;
            const angle = mapping.couplingAngle[s]!;
            if (nonzero[magnitude] || nonzero[angle]) nonzero[magnitude] = nonzero[angle] = true;
        }

        for (let s = 0; s < mapping.submapResidue.length; s++) {
            const planes = this.bundlePlanes;
            const flags = this.bundleNonzero;
            planes.length = 0;
            flags.length = 0;
            for (let c = 0; c < channels; c++) {
                if (mapping.channelSubmap[c] !== s) continue;
                planes.push(spectrum[c]!);
                flags.push(nonzero[c]!);
            }

            mapping.submapResidue[s]!.decode(bits, planes, flags, n);
        }

        for (let s = mapping.couplingMagnitude.length - 1; s >= 0; s--) {
            const pcmM = spectrum[mapping.couplingMagnitude[s]!]!;
            const pcmA = spectrum[mapping.couplingAngle[s]!]!;
            for (let j = 0; j < half; j++) {
                const mag = pcmM[j]!;
                const ang = pcmA[j]!;
                if (mag > 0) {
                    if (ang > 0) pcmA[j] = mag - ang;
                    else {
                        pcmA[j] = mag;
                        pcmM[j] = mag + ang;
                    }
                } else if (ang > 0) pcmA[j] = mag + ang;
                else {
                    pcmA[j] = mag;
                    pcmM[j] = mag - ang;
                }
            }
        }

        for (let c = 0; c < channels; c++) {
            if (nonzero[c])
                mapping.submapFloor[mapping.channelSubmap[c]!]!.render(spectrum[c]!, n, c);
            else spectrum[c]!.fill(0, 0, half);
            this.mdct[w]!.backward(spectrum[c]!, this.block[c]!);
        }

        const previous = this.previousBlock;
        const frames = previous ? (previous + n) >> 2 : 0;
        for (let c = 0; c < channels; c++) {
            const block = this.block[c]!;
            const saved = this.saved[c]!;
            if (previous) this.overlapAdd(saved, previous, block, n, out[c]!);
            saved.set(block.subarray(half, n));
        }

        this.previousBlock = n;
        return frames;
    }

    /**
     * Vorbis I section 1.3.2: the previous block's right half meets this block's left half under
     * the shorter window.
     */
    private overlapAdd(
        saved: Float32Array,
        previous: number,
        block: Float32Array,
        n: number,
        out: Float32Array,
    ): void {
        const shorter = Math.min(previous, n);
        const window = this.windows[shorter === this.blockSizes[0] ? 0 : 1]!;
        const overlap = shorter >> 1;
        const savedStart = (previous >> 2) - (shorter >> 2);
        const blockStart = (n >> 2) - (shorter >> 2);
        let o = 0;
        for (let i = 0; i < savedStart; i++) out[o++] = saved[i]!;
        for (let i = 0; i < overlap; i++)
            out[o++] =
                saved[savedStart + i]! * window[overlap - i - 1]! +
                block[blockStart + i]! * window[i]!;
        for (let i = blockStart + overlap; i < n >> 1; i++) out[o++] = block[i]!;
    }
}

/** Vorbis I section 1.3.2 window, first half: sin(pi/2 sin^2(pi (i + 1/2) / n)). */
function vorbisWindow(n: number): Float32Array {
    const window = new Float32Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
        const s = Math.sin((Math.PI * (i + 0.5)) / n);
        window[i] = Math.sin((Math.PI / 2) * s * s);
    }
    return window;
}
