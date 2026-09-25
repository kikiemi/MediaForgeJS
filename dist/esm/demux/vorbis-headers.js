import { DemuxError } from '../core/errors.js';
class Bits {
    bytes;
    at = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    skip(count) {
        if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length * 8 - this.at) {
            throw new DemuxError('Truncated Vorbis setup header');
        }
        this.at += count;
    }
    read(count) {
        const start = this.at;
        this.skip(count);
        let value = 0;
        for (let bit = 0; bit < count; bit++)
            value += ((this.bytes[(start + bit) >>> 3] >>> ((start + bit) & 7)) & 1) * 2 ** bit;
        return value;
    }
}
function ilog(value) {
    return value === 0 ? 0 : 32 - Math.clz32(value);
}
function requireValue(valid, label) {
    if (!valid)
        throw new DemuxError(`Invalid Vorbis ${label}`);
}
export function vorbisModes(setup, channels) {
    const bits = new Bits(setup);
    bits.skip(56);
    const books = bits.read(8) + 1;
    let entriesTotal = 0;
    const book = (index) => requireValue(index < books, 'codebook reference');
    for (let index = 0; index < books; index++) {
        requireValue(bits.read(24) === 0x564342, 'codebook signature');
        const dimensions = bits.read(16);
        const entries = bits.read(24);
        entriesTotal += entries;
        requireValue(dimensions > 0 && entries > 0 && entriesTotal <= 4_000_000, 'codebook size (maximum four million entries)');
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
        }
        else {
            const sparse = bits.read(1);
            for (let entry = 0; entry < entries; entry++) {
                if (!sparse || bits.read(1))
                    lengths[bits.read(5) + 1]++;
            }
        }
        let available = 1;
        let used = 0;
        for (let length = 1; length <= 32; length++) {
            available = available * 2 - lengths[length];
            used += lengths[length];
            requireValue(available >= 0, 'oversubscribed codebook');
        }
        requireValue(used > 0 && (available === 0 || (used === 1 && lengths[1] === 1)), 'undersubscribed codebook');
        const lookup = bits.read(4);
        requireValue(lookup <= 2, 'codebook lookup type');
        if (lookup) {
            bits.skip(64);
            const valueBits = bits.read(4) + 1;
            bits.skip(1);
            let values = entries * dimensions;
            if (lookup === 1) {
                values = Math.floor(entries ** (1 / dimensions));
                while ((values + 1) ** dimensions <= entries)
                    values++;
                while (values ** dimensions > entries)
                    values--;
            }
            bits.skip(values * valueBits);
        }
    }
    const times = bits.read(6) + 1;
    for (let index = 0; index < times; index++)
        requireValue(bits.read(16) === 0, 'time transform');
    const floors = bits.read(6) + 1;
    for (let index = 0; index < floors; index++) {
        const type = bits.read(16);
        requireValue(type <= 1, 'floor type');
        if (type === 0) {
            bits.skip(8 + 16 + 16 + 6 + 8);
            const count = bits.read(4) + 1;
            for (let entry = 0; entry < count; entry++)
                book(bits.read(8));
        }
        else {
            const partitions = bits.read(5);
            const classes = [];
            let maxClass = -1;
            for (let entry = 0; entry < partitions; entry++) {
                const value = bits.read(4);
                classes.push(value);
                maxClass = Math.max(maxClass, value);
            }
            const dimensions = [];
            for (let entry = 0; entry <= maxClass; entry++) {
                dimensions.push(bits.read(3) + 1);
                const subclasses = bits.read(2);
                if (subclasses)
                    book(bits.read(8));
                for (let child = 0; child < 1 << subclasses; child++) {
                    const value = bits.read(8);
                    if (value)
                        book(value - 1);
                }
            }
            bits.skip(2);
            const rangeBits = bits.read(4);
            const values = new Set([0, 1 << rangeBits]);
            for (const entry of classes)
                for (let value = 0; value < dimensions[entry]; value++) {
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
        const cascades = [];
        for (let entry = 0; entry < classes; entry++) {
            const low = bits.read(3);
            cascades.push(low | ((bits.read(1) ? bits.read(5) : 0) << 3));
        }
        for (const cascade of cascades)
            for (let bit = 0; bit < 8; bit++)
                if (cascade & (1 << bit))
                    book(bits.read(8));
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
                requireValue(magnitude < channels && angle < channels && magnitude !== angle, 'channel coupling');
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
    const modes = [];
    const count = bits.read(6) + 1;
    for (let index = 0; index < count; index++) {
        modes.push(bits.read(1) !== 0);
        requireValue(bits.read(16) === 0 && bits.read(16) === 0 && bits.read(8) < mappings, 'mode');
    }
    requireValue(bits.read(1) === 1, 'setup framing flag');
    return modes;
}
export function vorbisPacketBlock(prefix, modes, small, large) {
    const bits = new Bits(prefix);
    requireValue(bits.read(1) === 0, 'audio packet type');
    const mode = bits.read(ilog(modes.length - 1));
    requireValue(mode < modes.length, 'audio packet mode');
    if (modes[mode])
        bits.skip(2);
    return modes[mode] ? large : small;
}
export function vorbisCodecConfig(headers) {
    const laces = [];
    for (const header of headers.slice(0, 2)) {
        let remaining = header.length;
        while (remaining >= 255) {
            laces.push(255);
            remaining -= 255;
        }
        laces.push(remaining);
    }
    const config = new Uint8Array(1 + laces.length + headers.reduce((sum, header) => sum + header.length, 0));
    config[0] = 2;
    config.set(laces, 1);
    let offset = 1 + laces.length;
    for (const header of headers) {
        config.set(header, offset);
        offset += header.length;
    }
    return config;
}
