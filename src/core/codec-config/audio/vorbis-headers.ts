import { DemuxError } from '../../errors/errors';
import { sameBytes } from '../../bytes/bytes';

class Bits {
    private at = 0;
    constructor(private readonly bytes: Uint8Array) {}
    skip(count: number): void {
        if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length * 8 - this.at) {
            throw new DemuxError('Truncated Vorbis setup header');
        }
        this.at += count;
    }
    /** The next `count` bits, the first one lowest (Vorbis I, 2.1.4), a byte at a time. */
    read(count: number): number {
        let at = this.at;
        this.skip(count);
        let value = 0;
        for (let got = 0, scale = 1; got < count;) {
            const shift = at & 7;
            const take = Math.min(8 - shift, count - got);
            value += ((this.bytes[at >>> 3]! >>> shift) & ((1 << take) - 1)) * scale;
            scale *= 1 << take;
            got += take;
            at += take;
        }
        return value;
    }
}

function ilog(value: number): number {
    return value === 0 ? 0 : 32 - Math.clz32(value);
}

function requireValue(valid: boolean, label: string): void {
    if (!valid) throw new DemuxError(`Invalid Vorbis ${label}`);
}

/** The setup header parsed last and its mode flags: a seek reads the same header again. */
let parsed: { setup: Uint8Array; channels: number; modes: readonly boolean[] } | undefined;

/** The block flags of the packet modes of a setup header, parsed without decoding audio. */
export function vorbisModes(setup: Uint8Array, channels: number): readonly boolean[] {
    if (parsed?.channels === channels && sameBytes(parsed.setup, setup)) return parsed.modes;
    const bits = new Bits(setup);
    bits.skip(56);
    const books = bits.read(8) + 1;
    let entriesTotal = 0;
    const book = (index: number): void => requireValue(index < books, 'codebook reference');
    for (let index = 0; index < books; index++) {
        requireValue(bits.read(24) === 0x564342, 'codebook signature');
        const dimensions = bits.read(16);
        const entries = bits.read(24);
        entriesTotal += entries;
        requireValue(
            dimensions > 0 && entries > 0 && entriesTotal <= 4_000_000,
            'codebook size (maximum four million entries)',
        );
        const lengths = new Uint32Array(33);
        if (bits.read(1)) {
            let length = bits.read(5) + 1;
            let done = 0;
            while (done < entries) {
                requireValue(length <= 32, 'ordered codebook length');
                const count = bits.read(ilog(entries - done));
                requireValue(count <= entries - done, 'ordered codebook count');
                lengths[length] = count;
                done += count;
                length++;
            }
        } else {
            const sparse = bits.read(1);
            for (let entry = 0; entry < entries; entry++) {
                if (!sparse || bits.read(1)) lengths[bits.read(5) + 1]!++;
            }
        }
        let available = 1;
        let used = 0;
        for (let length = 1; length <= 32; length++) {
            available = available * 2 - lengths[length]!;
            used += lengths[length]!;
            requireValue(available >= 0, 'oversubscribed codebook');
        }

        // As in libvorbis, a codebook without used entries is valid until a packet reads from it,
        // and a single entry takes a one-bit codeword.
        requireValue(
            used === 0 || available === 0 || (used === 1 && lengths[1] === 1),
            'undersubscribed codebook',
        );
        const lookup = bits.read(4);
        requireValue(lookup <= 2, 'codebook lookup type');
        if (lookup) {
            bits.skip(64);
            const valueBits = bits.read(4) + 1;
            bits.skip(1);
            let values = entries * dimensions;
            if (lookup === 1) {
                values = Math.floor(entries ** (1 / dimensions));
                while ((values + 1) ** dimensions <= entries) values++;
                while (values ** dimensions > entries) values--;
            }
            bits.skip(values * valueBits);
        }
    }
    const times = bits.read(6) + 1;
    for (let index = 0; index < times; index++) requireValue(bits.read(16) === 0, 'time transform');
    const floors = bits.read(6) + 1;
    for (let index = 0; index < floors; index++) {
        const type = bits.read(16);
        requireValue(type <= 1, 'floor type');
        if (type === 0) {
            bits.skip(8 + 16 + 16 + 6 + 8);
            const count = bits.read(4) + 1;
            for (let entry = 0; entry < count; entry++) book(bits.read(8));
        } else {
            const partitions = bits.read(5);
            const classes: number[] = [];
            let maxClass = -1;
            for (let entry = 0; entry < partitions; entry++) {
                const value = bits.read(4);
                classes.push(value);
                maxClass = Math.max(maxClass, value);
            }
            const dimensions: number[] = [];
            for (let entry = 0; entry <= maxClass; entry++) {
                dimensions.push(bits.read(3) + 1);
                const subclasses = bits.read(2);
                if (subclasses) book(bits.read(8));
                for (let child = 0; child < 1 << subclasses; child++) {
                    const value = bits.read(8);
                    if (value) book(value - 1);
                }
            }
            bits.skip(2);
            const rangeBits = bits.read(4);
            const values = new Set<number>([0, 1 << rangeBits]);
            for (const entry of classes)
                for (let value = 0; value < dimensions[entry]!; value++) {
                    const point = bits.read(rangeBits);
                    requireValue(!values.has(point), 'repeated floor coordinate');
                    values.add(point);
                }
        }
    }
    const residues = bits.read(6) + 1;
    for (let index = 0; index < residues; index++) {
        requireValue(bits.read(16) <= 2, 'residue type');
        const begin = bits.read(24);
        requireValue(bits.read(24) >= begin, 'residue range');
        bits.skip(24);
        const classes = bits.read(6) + 1;
        book(bits.read(8));
        const cascades: number[] = [];
        for (let entry = 0; entry < classes; entry++) {
            const low = bits.read(3);
            cascades.push(low | ((bits.read(1) ? bits.read(5) : 0) << 3));
        }
        for (const cascade of cascades)
            for (let bit = 0; bit < 8; bit++) if (cascade & (1 << bit)) book(bits.read(8));
    }
    const mappings = bits.read(6) + 1;
    for (let index = 0; index < mappings; index++) {
        requireValue(bits.read(16) === 0, 'mapping type');
        const submaps = bits.read(1) ? bits.read(4) + 1 : 1;
        if (bits.read(1)) {
            const steps = bits.read(8) + 1;
            for (let step = 0; step < steps; step++) {
                const magnitude = bits.read(ilog(channels - 1));
                const angle = bits.read(ilog(channels - 1));
                requireValue(
                    magnitude < channels && angle < channels && magnitude !== angle,
                    'channel coupling',
                );
            }
        }
        requireValue(bits.read(2) === 0, 'mapping reserved bits');
        if (submaps > 1)
            for (let channel = 0; channel < channels; channel++)
                requireValue(bits.read(4) < submaps, 'submap');
        for (let map = 0; map < submaps; map++) {
            bits.skip(8);
            requireValue(bits.read(8) < floors && bits.read(8) < residues, 'mapping floor/residue');
        }
    }
    const modes: boolean[] = [];
    const count = bits.read(6) + 1;
    for (let index = 0; index < count; index++) {
        modes.push(bits.read(1) !== 0);
        requireValue(bits.read(16) === 0 && bits.read(16) === 0 && bits.read(8) < mappings, 'mode');
    }
    requireValue(bits.read(1) === 1, 'setup framing flag');
    parsed = { setup: setup.slice(), channels, modes };
    return modes;
}

export function vorbisPacketBlock(
    prefix: Uint8Array,
    modes: readonly boolean[],
    small: number,
    large: number,
): number {
    return vorbisPacketBlockAt(prefix, 0, prefix.length, modes, small, large);
}

/** vorbisPacketBlock() of the `length`-byte packet at `at` in `bytes`. */
export function vorbisPacketBlockAt(
    bytes: Uint8Array,
    at: number,
    length: number,
    modes: readonly boolean[],
    small: number,
    large: number,
): number {
    const width = ilog(modes.length - 1);
    // The packet type and mode number fit the first byte for the 64 modes a setup header may
    // define.
    if (width > 7 || length === 0) {
        const reader = new Bits(bytes.subarray(at, at + length));
        requireValue(reader.read(1) === 0, 'audio packet type');
        const mode = reader.read(width);
        requireValue(mode < modes.length, 'audio packet mode');
        if (modes[mode]) reader.skip(2);
        return modes[mode] ? large : small;
    }
    const first = bytes[at]!;
    requireValue((first & 1) === 0, 'audio packet type');
    const mode = (first >>> 1) & ((1 << width) - 1);
    requireValue(mode < modes.length, 'audio packet mode');
    if (modes[mode] && 3 + width > length * 8)
        throw new DemuxError('Truncated Vorbis setup header');
    return modes[mode] ? large : small;
}

/**
 * The three header packets of Matroska/Xiph-laced Vorbis configuration; undefined when the lacing
 * is malformed.
 */
export function xiphHeaders(config: Uint8Array): Uint8Array[] | undefined {
    if (config[0] !== 2) return undefined;
    let offset = 1;
    const lengths: number[] = [];
    for (let header = 0; header < 2; header++) {
        let length = 0;
        let next: number;
        do {
            if (offset >= config.length) return undefined;
            next = config[offset++]!;
            length += next;
        } while (next === 255);
        lengths.push(length);
    }
    lengths.push(config.length - offset - lengths[0]! - lengths[1]!);
    if (lengths[2]! < 0) return undefined;
    return lengths.map(length => config.subarray(offset, (offset += length)));
}

/**
 * The short and long block sizes and the mode flags of Matroska/Xiph-laced Vorbis configuration,
 * which time its audio packets; undefined when the configuration is malformed.
 */
export function vorbisBlocks(
    config: Uint8Array,
): { small: number; large: number; modes: readonly boolean[] } | undefined {
    const [identification, , setup] = xiphHeaders(config) ?? [];
    if (identification?.length !== 30 || !setup) return undefined;
    const sizes = identification[28]!;
    try {
        const modes = vorbisModes(setup, identification[11]!);
        return { small: 1 << (sizes & 15), large: 1 << (sizes >>> 4), modes };
    } catch {
        return undefined;
    }
}

export function vorbisCodecConfig(headers: readonly Uint8Array[]): Uint8Array {
    const laces: number[] = [];
    for (const header of headers.slice(0, 2)) {
        let remaining = header.length;
        while (remaining >= 255) {
            laces.push(255);
            remaining -= 255;
        }
        laces.push(remaining);
    }
    const config = new Uint8Array(
        1 + laces.length + headers.reduce((sum, header) => sum + header.length, 0),
    );
    config[0] = 2;
    config.set(laces, 1);
    let offset = 1 + laces.length;
    for (const header of headers) {
        config.set(header, offset);
        offset += header.length;
    }
    return config;
}
