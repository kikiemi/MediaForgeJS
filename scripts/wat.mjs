// A small WebAssembly text assembler for the build: the subset of the text format (folded and flat
// instructions) the in-repo kernels use, with the 128-bit SIMD instructions, emitted as a binary
// module without an external toolchain. Supported module fields: (import "m" "n" (memory min max?
// shared?)), (import "m" "n" (func $name (param t)* (result t)*)), (func $name (export "n")? (param
// $p t)* (result t)* (local $l t)* instructions*) and active data segments (data (i32.const offset)
// "bytes") whose strings write other bytes as \hh.

const VALUE_TYPES = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b };

/** Opcodes without immediates. */
const PLAIN = {
    unreachable: [0x00],
    nop: [0x01],
    return: [0x0f],
    drop: [0x1a],
    select: [0x1b],
    'i32.eqz': [0x45],
    'i32.eq': [0x46],
    'i32.ne': [0x47],
    'i32.lt_s': [0x48],
    'i32.lt_u': [0x49],
    'i32.gt_s': [0x4a],
    'i32.gt_u': [0x4b],
    'i32.le_s': [0x4c],
    'i32.le_u': [0x4d],
    'i32.ge_s': [0x4e],
    'i32.ge_u': [0x4f],
    'i64.eqz': [0x50],
    'i64.eq': [0x51],
    'i64.ne': [0x52],
    'i32.clz': [0x67],
    'i32.ctz': [0x68],
    'i32.popcnt': [0x69],
    'i32.add': [0x6a],
    'i32.sub': [0x6b],
    'i32.mul': [0x6c],
    'i32.div_s': [0x6d],
    'i32.div_u': [0x6e],
    'i32.rem_s': [0x6f],
    'i32.rem_u': [0x70],
    'i32.and': [0x71],
    'i32.or': [0x72],
    'i32.xor': [0x73],
    'i32.shl': [0x74],
    'i32.shr_s': [0x75],
    'i32.shr_u': [0x76],
    'i32.rotl': [0x77],
    'i32.rotr': [0x78],
    'i64.add': [0x7c],
    'i64.sub': [0x7d],
    'i64.mul': [0x7e],
    'i64.and': [0x83],
    'i64.or': [0x84],
    'i64.xor': [0x85],
    'i64.shl': [0x86],
    'i64.shr_s': [0x87],
    'i64.shr_u': [0x88],
    'i32.wrap_i64': [0xa7],
    'i64.extend_i32_s': [0xac],
    'i64.extend_i32_u': [0xad],
    'i32.extend8_s': [0xc0],
    'i32.extend16_s': [0xc1],
};

/** 0xFD-prefixed SIMD opcodes without immediates. */
const SIMD_PLAIN = {
    'i8x16.swizzle': 0x0e,
    'i8x16.splat': 0x0f,
    'i16x8.splat': 0x10,
    'i32x4.splat': 0x11,
    'i64x2.splat': 0x12,
    'i8x16.eq': 0x23,
    'i8x16.ne': 0x24,
    'i8x16.lt_s': 0x25,
    'i8x16.lt_u': 0x26,
    'i8x16.gt_s': 0x27,
    'i8x16.gt_u': 0x28,
    'i8x16.le_s': 0x29,
    'i8x16.le_u': 0x2a,
    'i8x16.ge_s': 0x2b,
    'i8x16.ge_u': 0x2c,
    'i16x8.eq': 0x2d,
    'i16x8.ne': 0x2e,
    'i16x8.lt_s': 0x2f,
    'i16x8.lt_u': 0x30,
    'i16x8.gt_s': 0x31,
    'i16x8.gt_u': 0x32,
    'i16x8.le_s': 0x33,
    'i16x8.le_u': 0x34,
    'i16x8.ge_s': 0x35,
    'i16x8.ge_u': 0x36,
    'i32x4.eq': 0x37,
    'i32x4.ne': 0x38,
    'i32x4.lt_s': 0x39,
    'i32x4.lt_u': 0x3a,
    'i32x4.gt_s': 0x3b,
    'i32x4.gt_u': 0x3c,
    'i32x4.le_s': 0x3d,
    'i32x4.le_u': 0x3e,
    'i32x4.ge_s': 0x3f,
    'i32x4.ge_u': 0x40,
    'v128.not': 0x4d,
    'v128.and': 0x4e,
    'v128.andnot': 0x4f,
    'v128.or': 0x50,
    'v128.xor': 0x51,
    'v128.bitselect': 0x52,
    'v128.any_true': 0x53,
    'i8x16.abs': 0x60,
    'i8x16.neg': 0x61,
    'i8x16.all_true': 0x63,
    'i8x16.bitmask': 0x64,
    'i8x16.narrow_i16x8_s': 0x65,
    'i8x16.narrow_i16x8_u': 0x66,
    'i8x16.shl': 0x6b,
    'i8x16.shr_s': 0x6c,
    'i8x16.shr_u': 0x6d,
    'i8x16.add': 0x6e,
    'i8x16.add_sat_s': 0x6f,
    'i8x16.add_sat_u': 0x70,
    'i8x16.sub': 0x71,
    'i8x16.sub_sat_s': 0x72,
    'i8x16.sub_sat_u': 0x73,
    'i8x16.min_s': 0x76,
    'i8x16.min_u': 0x77,
    'i8x16.max_s': 0x78,
    'i8x16.max_u': 0x79,
    'i8x16.avgr_u': 0x7b,
    'i16x8.extadd_pairwise_i8x16_s': 0x7c,
    'i16x8.extadd_pairwise_i8x16_u': 0x7d,
    'i32x4.extadd_pairwise_i16x8_s': 0x7e,
    'i32x4.extadd_pairwise_i16x8_u': 0x7f,
    'i16x8.abs': 0x80,
    'i16x8.neg': 0x81,
    'i16x8.all_true': 0x83,
    'i16x8.bitmask': 0x84,
    'i16x8.narrow_i32x4_s': 0x85,
    'i16x8.narrow_i32x4_u': 0x86,
    'i16x8.extend_low_i8x16_s': 0x87,
    'i16x8.extend_high_i8x16_s': 0x88,
    'i16x8.extend_low_i8x16_u': 0x89,
    'i16x8.extend_high_i8x16_u': 0x8a,
    'i16x8.shl': 0x8b,
    'i16x8.shr_s': 0x8c,
    'i16x8.shr_u': 0x8d,
    'i16x8.add': 0x8e,
    'i16x8.add_sat_s': 0x8f,
    'i16x8.add_sat_u': 0x90,
    'i16x8.sub': 0x91,
    'i16x8.sub_sat_s': 0x92,
    'i16x8.sub_sat_u': 0x93,
    'i16x8.mul': 0x95,
    'i16x8.min_s': 0x96,
    'i16x8.min_u': 0x97,
    'i16x8.max_s': 0x98,
    'i16x8.max_u': 0x99,
    'i16x8.avgr_u': 0x9b,
    'i16x8.extmul_low_i8x16_s': 0x9c,
    'i16x8.extmul_high_i8x16_s': 0x9d,
    'i16x8.extmul_low_i8x16_u': 0x9e,
    'i16x8.extmul_high_i8x16_u': 0x9f,
    'i32x4.abs': 0xa0,
    'i32x4.neg': 0xa1,
    'i32x4.all_true': 0xa3,
    'i32x4.bitmask': 0xa4,
    'i32x4.extend_low_i16x8_s': 0xa7,
    'i32x4.extend_high_i16x8_s': 0xa8,
    'i32x4.extend_low_i16x8_u': 0xa9,
    'i32x4.extend_high_i16x8_u': 0xaa,
    'i32x4.shl': 0xab,
    'i32x4.shr_s': 0xac,
    'i32x4.shr_u': 0xad,
    'i32x4.add': 0xae,
    'i32x4.sub': 0xb1,
    'i32x4.mul': 0xb5,
    'i32x4.min_s': 0xb6,
    'i32x4.min_u': 0xb7,
    'i32x4.max_s': 0xb8,
    'i32x4.max_u': 0xb9,
    'i32x4.dot_i16x8_s': 0xba,
    'i32x4.extmul_low_i16x8_s': 0xbc,
    'i32x4.extmul_high_i16x8_s': 0xbd,
    'i32x4.extmul_low_i16x8_u': 0xbe,
    'i32x4.extmul_high_i16x8_u': 0xbf,
};

/** Memory access opcodes: bytes and natural alignment (log2). */
const MEMORY = {
    'i32.load': [[0x28], 2],
    'i64.load': [[0x29], 3],
    'i32.load8_s': [[0x2c], 0],
    'i32.load8_u': [[0x2d], 0],
    'i32.load16_s': [[0x2e], 1],
    'i32.load16_u': [[0x2f], 1],
    'i32.store': [[0x36], 2],
    'i64.store': [[0x37], 3],
    'i32.store8': [[0x3a], 0],
    'i32.store16': [[0x3b], 1],
    'v128.load': [[0xfd, 0x00], 4],
    'v128.load8x8_s': [[0xfd, 0x01], 3],
    'v128.load8x8_u': [[0xfd, 0x02], 3],
    'v128.load16x4_s': [[0xfd, 0x03], 3],
    'v128.load16x4_u': [[0xfd, 0x04], 3],
    'v128.load32x2_s': [[0xfd, 0x05], 3],
    'v128.load32x2_u': [[0xfd, 0x06], 3],
    'v128.load8_splat': [[0xfd, 0x07], 0],
    'v128.load16_splat': [[0xfd, 0x08], 1],
    'v128.load32_splat': [[0xfd, 0x09], 2],
    'v128.load64_splat': [[0xfd, 0x0a], 3],
    'v128.store': [[0xfd, 0x0b], 4],
    'v128.load32_zero': [[0xfd, 0x5c], 2],
    'v128.load64_zero': [[0xfd, 0x5d], 3],
};

/**
 * Lane memory accesses: opcode and natural alignment; they take a memory argument and a lane index.
 */
const LANE_MEMORY = {
    'v128.load8_lane': [0x54, 0],
    'v128.load16_lane': [0x55, 1],
    'v128.load32_lane': [0x56, 2],
    'v128.load64_lane': [0x57, 3],
    'v128.store8_lane': [0x58, 0],
    'v128.store16_lane': [0x59, 1],
    'v128.store32_lane': [0x5a, 2],
    'v128.store64_lane': [0x5b, 3],
};

/** Lane extraction and replacement: opcode and lane count. */
const LANES = {
    'i8x16.extract_lane_s': [0x15, 16],
    'i8x16.extract_lane_u': [0x16, 16],
    'i8x16.replace_lane': [0x17, 16],
    'i16x8.extract_lane_s': [0x18, 8],
    'i16x8.extract_lane_u': [0x19, 8],
    'i16x8.replace_lane': [0x1a, 8],
    'i32x4.extract_lane': [0x1b, 4],
    'i32x4.replace_lane': [0x1c, 4],
    'i64x2.extract_lane': [0x1d, 2],
    'i64x2.replace_lane': [0x1e, 2],
};

function unsignedLeb(value) {
    const out = [];
    let v = value >>> 0;
    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v) byte |= 0x80;
        out.push(byte);
    } while (v);
    return out;
}

function signedLeb(value) {
    const out = [];
    let v = BigInt(value);
    for (;;) {
        const byte = Number(v & 0x7fn);
        v >>= 7n;
        const done = (v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0);
        out.push(done ? byte : byte | 0x80);
        if (done) return out;
    }
}

function name(text) {
    const bytes = new TextEncoder().encode(text);
    return [...unsignedLeb(bytes.length), ...bytes];
}

/** Bytes of a data string: \hh escapes, other characters as their (single-byte) codes. */
function stringBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
        } else bytes.push(text.charCodeAt(i));
    }
    return bytes;
}

function section(id, body) {
    return [id, ...unsignedLeb(body.length), ...body];
}

function vector(items) {
    return [...unsignedLeb(items.length), ...items.flat()];
}

function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        if (c === ';' && source[i + 1] === ';') {
            while (i < source.length && source[i] !== '\n') i++;
        } else if (c === '(' && source[i + 1] === ';') {
            const end = source.indexOf(';)', i);
            if (end < 0) throw new Error('wat: unterminated block comment');
            i = end + 2;
        } else if (c === '(' || c === ')') {
            tokens.push(c);
            i++;
        } else if (/\s/.test(c)) i++;
        else if (c === '"') {
            const end = source.indexOf('"', i + 1);
            tokens.push({ string: source.slice(i + 1, end) });
            i = end + 1;
        } else {
            let j = i;
            while (j < source.length && !/[\s()]/.test(source[j])) j++;
            tokens.push(source.slice(i, j));
            i = j;
        }
    }
    return tokens;
}

function parse(tokens) {
    let i = 0;
    const read = () => {
        const token = tokens[i++];
        if (token === '(') {
            const list = [];
            while (tokens[i] !== ')') {
                if (i >= tokens.length) throw new Error('wat: missing )');
                list.push(read());
            }
            i++;
            return list;
        }
        if (token === ')') throw new Error('wat: unexpected )');
        return token;
    };
    const items = [];
    while (i < tokens.length) items.push(read());
    return items;
}

function integer(token) {
    const text = String(token).replaceAll('_', '');
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(text))
        throw new Error(`wat: expected an integer, got ${token}`);
    return BigInt(text);
}

/** Encodes the body of one function. */
class FunctionAssembler {
    constructor(module, locals) {
        this.module = module;
        this.locals = locals;
        this.labels = [];
        this.code = [];
    }

    local(token) {
        if (typeof token === 'string' && token.startsWith('$')) {
            const index = this.locals.get(token);
            if (index === undefined) throw new Error(`wat: unknown local ${token}`);
            return index;
        }
        return Number(integer(token));
    }

    label(token) {
        if (typeof token === 'string' && token.startsWith('$')) {
            const depth = this.labels.lastIndexOf(token);
            if (depth < 0) throw new Error(`wat: unknown label ${token}`);
            return this.labels.length - 1 - depth;
        }
        return Number(integer(token));
    }

    blockType(items, index) {
        const item = items[index];
        if (Array.isArray(item) && item[0] === 'result') {
            if (item.length !== 2) throw new Error('wat: block results take one type');
            return [[VALUE_TYPES[item[1]]], index + 1];
        }
        return [[0x40], index];
    }

    /** Instructions of a flat sequence; folded expressions and blocks may appear among them. */
    sequence(items, start = 0) {
        let i = start;
        while (i < items.length) i = this.instruction(items, i);
    }

    /**
     * One instruction at items[i] (flat, with its immediates following) or a folded expression;
     * returns the next index.
     */
    instruction(items, i) {
        const item = items[i];
        if (Array.isArray(item)) {
            this.folded(item);
            return i + 1;
        }
        const op = item;
        if (op === 'block' || op === 'loop' || op === 'if') {
            let j = i + 1;
            let label = null;
            if (typeof items[j] === 'string' && items[j].startsWith('$')) label = items[j++];
            const [type, next] = this.blockType(items, j);
            this.code.push(op === 'block' ? 0x02 : op === 'loop' ? 0x03 : 0x04, ...type);
            this.labels.push(label);
            return next;
        }
        if (op === 'else') {
            this.code.push(0x05);
            return i + 1;
        }
        if (op === 'end') {
            this.labels.pop();
            this.code.push(0x0b);
            return i + 1;
        }
        return this.simple(items, i);
    }

    folded(list) {
        const op = list[0];
        if (op === 'block' || op === 'loop') {
            let j = 1;
            let label = null;
            if (typeof list[j] === 'string' && list[j].startsWith('$')) label = list[j++];
            const [type, next] = this.blockType(list, j);
            this.code.push(op === 'block' ? 0x02 : 0x03, ...type);
            this.labels.push(label);
            this.sequence(list, next);
            this.labels.pop();
            this.code.push(0x0b);
            return;
        }
        if (op === 'if') {
            let j = 1;
            let label = null;
            if (typeof list[j] === 'string' && list[j].startsWith('$')) label = list[j++];
            const [type, next] = this.blockType(list, j);
            j = next;
            let thenBranch = null;
            let elseBranch = null;
            for (; j < list.length; j++) {
                const part = list[j];
                if (Array.isArray(part) && part[0] === 'then') thenBranch = part;
                else if (Array.isArray(part) && part[0] === 'else') elseBranch = part;
                else this.instruction(list, j);
            }
            if (!thenBranch) throw new Error('wat: folded if needs (then ...)');
            this.code.push(0x04, ...type);
            this.labels.push(label);
            this.sequence(thenBranch, 1);
            if (elseBranch) {
                this.code.push(0x05);
                this.sequence(elseBranch, 1);
            }
            this.labels.pop();
            this.code.push(0x0b);
            return;
        }
        // Operands (nested lists) first, then the operator with its immediates.
        const immediates = [op];
        for (let j = 1; j < list.length; j++) {
            if (Array.isArray(list[j])) this.folded(list[j]);
            else immediates.push(list[j]);
        }
        const next = this.simple(immediates, 0);
        if (next !== immediates.length)
            throw new Error(`wat: stray immediates in (${list.join(' ')})`);
    }

    memarg(items, j, natural) {
        let offset = 0;
        let align = natural;
        while (typeof items[j] === 'string' && /^(offset|align)=/.test(items[j])) {
            const [key, value] = items[j].split('=');
            if (key === 'offset') offset = Number(integer(value));
            else align = Math.log2(Number(integer(value)));
            j++;
        }
        if (!Number.isInteger(align) || align > natural)
            throw new Error(`wat: bad alignment ${items[j - 1]}`);
        return [[...unsignedLeb(align), ...unsignedLeb(offset)], j];
    }

    simple(items, i) {
        const op = items[i];
        const code = this.code;
        let j = i + 1;
        if (op in PLAIN) {
            code.push(...PLAIN[op]);
            return j;
        }
        if (op in SIMD_PLAIN) {
            code.push(0xfd, ...unsignedLeb(SIMD_PLAIN[op]));
            return j;
        }
        if (op in MEMORY) {
            const [bytes, natural] = MEMORY[op];
            const [arg, next] = this.memarg(items, j, natural);
            code.push(...bytes, ...arg);
            return next;
        }
        if (op in LANE_MEMORY) {
            const [opcode, natural] = LANE_MEMORY[op];
            const [arg, next] = this.memarg(items, j, natural);
            const lane = Number(integer(items[next]));
            if (lane >= 16 >> natural) throw new Error(`wat: lane ${lane} out of range for ${op}`);
            code.push(0xfd, ...unsignedLeb(opcode), ...arg, lane);
            return next + 1;
        }
        if (op in LANES) {
            const [opcode, count] = LANES[op];
            const lane = Number(integer(items[j]));
            if (lane >= count) throw new Error(`wat: lane ${lane} out of range for ${op}`);
            code.push(0xfd, ...unsignedLeb(opcode), lane);
            return j + 1;
        }
        switch (op) {
            case 'local.get':
            case 'local.set':
            case 'local.tee':
                code.push(
                    { 'local.get': 0x20, 'local.set': 0x21, 'local.tee': 0x22 }[op],
                    ...unsignedLeb(this.local(items[j])),
                );
                return j + 1;
            case 'br':
            case 'br_if':
                code.push(op === 'br' ? 0x0c : 0x0d, ...unsignedLeb(this.label(items[j])));
                return j + 1;
            case 'br_table': {
                const targets = [];
                while (
                    j < items.length &&
                    typeof items[j] === 'string' &&
                    !items[j].includes('.') &&
                    /^(\$|\d)/.test(items[j])
                )
                    targets.push(this.label(items[j++]));
                if (targets.length < 1) throw new Error('wat: br_table needs a default label');
                const fallback = targets.pop();
                code.push(
                    0x0e,
                    ...vector(targets.map(target => unsignedLeb(target))),
                    ...unsignedLeb(fallback),
                );
                return j;
            }
            case 'call':
                code.push(0x10, ...unsignedLeb(this.module.functionIndex(items[j])));
                return j + 1;
            case 'i32.const':
                code.push(0x41, ...signedLeb(BigInt.asIntN(32, integer(items[j]))));
                return j + 1;
            case 'i64.const':
                code.push(0x42, ...signedLeb(BigInt.asIntN(64, integer(items[j]))));
                return j + 1;
            case 'memory.copy':
                code.push(0xfc, 0x0a, 0x00, 0x00);
                return j;
            case 'memory.fill':
                code.push(0xfc, 0x0b, 0x00);
                return j;
            case 'v128.const': {
                const shape = items[j++];
                const lanes = { i8x16: 16, i16x8: 8, i32x4: 4, i64x2: 2 }[shape];
                if (!lanes) throw new Error(`wat: unsupported v128.const shape ${shape}`);
                const width = 16 / lanes;
                const bytes = [];
                for (let lane = 0; lane < lanes; lane++) {
                    let value = BigInt.asUintN(width * 8, integer(items[j++]));
                    for (let b = 0; b < width; b++) {
                        bytes.push(Number(value & 0xffn));
                        value >>= 8n;
                    }
                }
                code.push(0xfd, 0x0c, ...bytes);
                return j;
            }
            case 'i8x16.shuffle': {
                const lanes = [];
                for (let lane = 0; lane < 16; lane++) {
                    const value = Number(integer(items[j++]));
                    if (value > 31) throw new Error('wat: shuffle lane out of range');
                    lanes.push(value);
                }
                code.push(0xfd, 0x0d, ...lanes);
                return j;
            }
            default:
                throw new Error(`wat: unsupported instruction ${op}`);
        }
    }
}

/** Assembles a module in the text format subset above into its binary encoding. */
export function assembleWat(source) {
    const [moduleList] = parse(tokenize(source));
    if (!Array.isArray(moduleList) || moduleList[0] !== 'module')
        throw new Error('wat: expected (module ...)');
    const imports = [];
    const functions = [];
    const segments = [];
    for (const field of moduleList.slice(1)) {
        if (field[0] === 'import') imports.push(field);
        else if (field[0] === 'func') functions.push(field);
        else if (field[0] === 'data') segments.push(field);
        else throw new Error(`wat: unsupported module field ${field[0]}`);
    }
    const types = [];
    const typeIndex = signature => {
        const key = JSON.stringify(signature);
        let index = types.findIndex(type => JSON.stringify(type) === key);
        if (index < 0) index = types.push(signature) - 1;
        return index;
    };
    const names = new Map();
    // Imported functions come first in the function index space.
    const importedFunctions = imports.filter(field => field[3][0] === 'func');
    importedFunctions.forEach((field, index) => {
        if (typeof field[3][1] === 'string' && field[3][1].startsWith('$'))
            names.set(field[3][1], index);
    });
    const base = importedFunctions.length;
    const parsed = functions.map((field, position) => {
        const index = base + position;
        let i = 1;
        let fnName = null;
        if (typeof field[i] === 'string' && field[i].startsWith('$')) fnName = field[i++];
        if (fnName) names.set(fnName, index);
        const exports = [];
        const params = [];
        const results = [];
        const locals = [];
        const localNames = new Map();
        for (; i < field.length; i++) {
            const part = field[i];
            if (!Array.isArray(part)) break;
            if (part[0] === 'export') exports.push(part[1].string);
            else if (part[0] === 'param' || part[0] === 'local') {
                const target = part[0] === 'param' ? params : locals;
                if (typeof part[1] === 'string' && part[1].startsWith('$')) {
                    if (part[0] === 'param' && locals.length)
                        throw new Error('wat: params follow locals');
                    localNames.set(part[1], params.length + locals.length);
                    target.push(VALUE_TYPES[part[2]]);
                } else for (const type of part.slice(1)) target.push(VALUE_TYPES[type]);
            } else if (part[0] === 'result')
                for (const type of part.slice(1)) results.push(VALUE_TYPES[type]);
            else break;
        }
        return { fnName, exports, params, results, locals, localNames, body: field.slice(i) };
    });
    const module = {
        functionIndex(token) {
            const index =
                typeof token === 'string' && token.startsWith('$')
                    ? names.get(token)
                    : Number(token);
            if (index === undefined) throw new Error(`wat: unknown function ${token}`);
            return index;
        },
    };
    const importSection = imports.map(field => {
        const [, moduleName, fieldName, descriptor] = field;
        if (descriptor[0] === 'func') {
            const params = [];
            const results = [];
            for (const part of descriptor.slice(1)) {
                if (!Array.isArray(part)) continue;
                const types = part
                    .slice(1)
                    .filter(type => type in VALUE_TYPES)
                    .map(type => VALUE_TYPES[type]);
                if (part[0] === 'param') params.push(...types);
                else if (part[0] === 'result') results.push(...types);
            }
            return [
                ...name(moduleName.string),
                ...name(fieldName.string),
                0x00,
                ...unsignedLeb(typeIndex([params, results])),
            ];
        }
        if (descriptor[0] !== 'memory')
            throw new Error('wat: only memory and function imports are supported');
        const numbers = descriptor.slice(1).filter(item => /^\d+$/.test(item));
        const shared = descriptor.includes('shared');
        const flags = (numbers.length > 1 ? 1 : 0) | (shared ? 2 : 0);
        const limits = [
            flags,
            ...unsignedLeb(Number(numbers[0])),
            ...(numbers[1] ? unsignedLeb(Number(numbers[1])) : []),
        ];
        return [...name(moduleName.string), ...name(fieldName.string), 0x02, ...limits];
    });
    const functionSection = parsed.map(fn => unsignedLeb(typeIndex([fn.params, fn.results])));
    const exportSection = parsed.flatMap((fn, position) =>
        fn.exports.map(exportName => [...name(exportName), 0x00, ...unsignedLeb(base + position)]),
    );
    const codeSection = parsed.map(fn => {
        const assembler = new FunctionAssembler(module, fn.localNames);
        assembler.labels.push(null);
        assembler.sequence(fn.body);
        const groups = [];
        for (const type of fn.locals) {
            const last = groups[groups.length - 1];
            if (last && last[1] === type) last[0]++;
            else groups.push([1, type]);
        }
        const body = [
            ...vector(groups.map(([count, type]) => [...unsignedLeb(count), type])),
            ...assembler.code,
            0x0b,
        ];
        return [...unsignedLeb(body.length), ...body];
    });
    const dataSection = segments.map(([, offset, ...strings]) => {
        if (!Array.isArray(offset) || offset[0] !== 'i32.const')
            throw new Error('wat: data needs (i32.const offset)');
        const bytes = strings.flatMap(item => stringBytes(item.string));
        return [
            0x00,
            0x41,
            ...signedLeb(BigInt.asIntN(32, integer(offset[1]))),
            0x0b,
            ...vector(bytes.map(b => [b])),
        ];
    });
    const typeSection = types.map(([params, results]) => [
        0x60,
        ...vector(params.map(t => [t])),
        ...vector(results.map(t => [t])),
    ]);
    return Uint8Array.from([
        0x00,
        0x61,
        0x73,
        0x6d,
        0x01,
        0x00,
        0x00,
        0x00,
        ...section(1, vector(typeSection)),
        ...section(2, vector(importSection)),
        ...section(3, vector(functionSection)),
        ...section(7, vector(exportSection)),
        ...section(10, vector(codeSection)),
        ...(dataSection.length ? section(11, vector(dataSection)) : []),
    ]);
}
