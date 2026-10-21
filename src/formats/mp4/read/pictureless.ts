import type { Source } from '../../../core/model/types';
import type { Sample } from '../../../core/model/track';

/** What the NAL units of one AVC/HEVC sample hold. */
interface SampleUnits {
    /** Holds a coded slice (H.264 types 1-5 and 20, HEVC VCL types 0-31). */
    readonly picture: boolean;
    /** Its first slice is an IDR (H.264) or IRAP (HEVC) picture. */
    readonly randomAccess: boolean;
}

const NO_PICTURE: SampleUnits = Object.freeze({ picture: false, randomAccess: false });

/**
 * Classifies the length-prefixed NAL units of `bytes` up to the first slice: a whole sample when
 * `complete`, or its head, when the offset of the unit that starts past the head is returned
 * instead of an answer.
 */
export function sampleUnits(
    bytes: Uint8Array,
    lengthSize: number,
    hevc: boolean,
    complete: true,
): SampleUnits;
export function sampleUnits(
    bytes: Uint8Array,
    lengthSize: number,
    hevc: boolean,
    complete: boolean,
): SampleUnits | { readonly next: number };
export function sampleUnits(
    bytes: Uint8Array,
    lengthSize: number,
    hevc: boolean,
    complete: boolean,
): SampleUnits | { readonly next: number } {
    let at = 0;
    while (at + lengthSize < bytes.length) {
        let length = 0;
        for (let index = 0; index < lengthSize; index++) length = length * 256 + bytes[at + index]!;
        const header = bytes[at + lengthSize]!;
        const type = hevc ? (header >> 1) & 0x3f : header & 0x1f;
        if (hevc ? type < 32 : (type >= 1 && type <= 5) || type === 20)
            return { picture: true, randomAccess: hevc ? type >= 16 && type <= 23 : type === 5 };
        if (length === 0) return NO_PICTURE;
        at += lengthSize + length;
    }
    return complete || at === 0 ? NO_PICTURE : { next: at };
}

/** Bytes read at a time while walking the NAL units of a sample to its first slice. */
const WALK_BYTES = 256;

/**
 * Walks one sample's NAL units from the source, reading only the unit headers up to its first
 * slice.
 */
async function readSampleUnits(
    source: Source,
    sample: Sample,
    lengthSize: number,
    hevc: boolean,
): Promise<SampleUnits> {
    if (sample.data) return sampleUnits(sample.data, lengthSize, hevc, true);
    let base = 0;
    for (;;) {
        const size = Math.min(WALK_BYTES, sample.size - base);
        if (size <= lengthSize) return NO_PICTURE;
        const bytes = await source.read(sample.offset + base, size);
        const result = sampleUnits(bytes, lengthSize, hevc, base + size >= sample.size);
        if (!('next' in result)) return result;
        base += result.next;
    }
}

/**
 * Joins samples that hold no picture (only parameter sets, SEI or delimiters) to the access unit
 * that follows them, as ISO/IEC 14496-15 5.3.2 requires one access unit, with its picture, per
 * sample. The joined sample keeps the picture's times, and its duration runs to the next picture.
 * Keyframes follow the pictures: an IDR (IRAP) picture is a random access point whatever the sync
 * sample table marks, and no other picture is. Units after the last picture (an end of sequence)
 * end its access unit. Returns undefined when every sample holds a picture.
 */
export async function joinPicturelessSamples(
    source: Source,
    samples: readonly Sample[],
    lengthSize: number,
    hevc: boolean,
    breathe: () => Promise<void>,
): Promise<{ samples: Sample[]; joined: number } | undefined> {
    const units: SampleUnits[] = [];
    for (let index = 0; index < samples.length; index++) {
        if ((index & 0xff) === 0) await breathe();
        units.push(await readSampleUnits(source, samples[index]!, lengthSize, hevc));
    }

    if (units.every(unit => unit.picture) || !units.some(unit => unit.picture)) return undefined;

    const groups: { members: Sample[]; picture: number }[] = [];
    let pending: Sample[] = [];
    for (let index = 0; index < samples.length; index++) {
        pending.push(samples[index]!);
        if (!units[index]!.picture) continue;
        groups.push({ members: pending, picture: pending.length - 1 });
        pending = [];
    }
    groups[groups.length - 1]!.members.push(...pending);

    const out: Sample[] = [];
    let joined = 0;
    let position = 0;

    for (let group = 0; group < groups.length; group++) {
        const { members, picture } = groups[group]!;
        const next = groups[group + 1];
        const trailing = next ? next.members.slice(0, next.picture) : [];
        const duration = [...members.slice(picture), ...trailing].reduce(
            (sum, member) => sum + member.duration,
            0,
        );

        const merged: Sample = {
            ...members[picture]!,
            duration,
            isKeyframe: units[position + picture]!.randomAccess,
        };

        if (members.length > 1) {
            joined += members.length - 1;
            merged.size = members.reduce((sum, member) => sum + member.size, 0);
            const contiguous = members.every(
                (member, index) =>
                    !member.data &&
                    (index === 0 ||
                        member.offset === members[index - 1]!.offset + members[index - 1]!.size),
            );
            if (contiguous) merged.offset = members[0]!.offset;
            else {
                const data = new Uint8Array(merged.size);
                let offset = 0;
                for (const member of members) {
                    data.set(
                        member.data ?? (await source.read(member.offset, member.size)),
                        offset,
                    );
                    offset += member.size;
                }
                merged.data = data;
            }
        }

        out.push(merged);
        position += members.length;
    }

    return { samples: out, joined };
}
