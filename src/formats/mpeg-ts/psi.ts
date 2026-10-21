import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxError } from '../../core/errors/errors';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { sameBytes } from '../../core/bytes/bytes';
import { TS_PACKET } from './stream-types';
import { u32be } from '../../core/bytes/byte-fields';
import { crc32MpegUpdate } from '../../core/bytes/crc32-mpeg';

/** Gathers the PSI sections (PAT, PMT) of one PID from its transport packets. */
export class PsiSectionReader {
    /**
     * The section being assembled. Other tables (SDT, EIT, private sections) may share a PSI PID; a
     * 12-bit length bounds every section, and the buffer grows to it only for a section that long.
     */
    private data = new Uint8Array(1024);
    private used = 0;
    private length = 0;
    private lastCc = -1;
    private lastPayload: Uint8Array | null = null;

    /**
     * Sections completed by one transport packet. Under compatible validation a damaged packet or
     * section is reported and skipped, and assembly resumes at the next section start, as PSI
     * tables repeat.
     */
    readSections(pkt: Uint8Array, diagnostics: DiagnosticContext): Uint8Array[] {
        try {
            return this.read(pkt);
        } catch (error) {
            if (diagnostics.validation !== 'compatible' || !(error instanceof DemuxError))
                throw error;
            this.used = 0;
            this.length = 0;
            this.lastCc = -1;
            this.lastPayload = null;
            diagnostics.warn({
                code: 'TS_PSI_DAMAGED',
                format: 'ts',
                message: 'Ignored a damaged PSI packet; waiting for its next repetition',
            });
            return [];
        }
    }

    private read(pkt: Uint8Array): Uint8Array[] {
        demuxAssert((pkt[1]! & 0x80) === 0, 'TS PSI packet has its transport error indicator set');
        demuxAssert((pkt[3]! & 0xc0) === 0, 'TS PSI packet is scrambled');
        const control = (pkt[3]! >> 4) & 3;
        demuxAssert(control !== 0, 'TS PSI packet has no adaptation or payload control');
        const hasAdapt = (control & 2) !== 0;
        const hasPayload = (control & 1) !== 0;
        const offset = hasAdapt ? 5 + pkt[4]! : 4;
        demuxAssert(offset <= TS_PACKET, 'TS PSI adaptation field exceeds its packet');

        const discontinuity = hasAdapt && pkt[4]! > 0 && (pkt[5]! & 0x80) !== 0;
        if (discontinuity) {
            this.used = 0;
            this.length = 0;
            this.lastCc = -1;
            this.lastPayload = null;
        }

        if (!hasPayload) return [];
        demuxAssert(offset < TS_PACKET, 'TS PSI packet declares an empty payload');
        const payload = pkt.subarray(offset);
        const cc = pkt[3]! & 15;
        if (cc === this.lastCc) {
            demuxAssert(
                this.lastPayload !== null && sameBytes(payload, this.lastPayload),
                'TS PSI continuity counter repeats with different payload bytes',
            );
            return [];
        }
        demuxAssert(
            this.used === 0 || this.lastCc < 0 || cc === ((this.lastCc + 1) & 15),
            'TS PSI continuity counter jumps inside a section',
        );
        this.lastCc = cc;
        this.lastPayload = payload.slice();

        const sections: Uint8Array[] = [];
        let start = 0;
        if (pkt[1]! & 0x40) {
            start = 1 + payload[0]!;
            demuxAssert(start <= payload.length, 'TS PSI pointer exceeds its packet payload');
            if (this.used > 0) {
                this.append(payload.subarray(1, start), sections, false);
                demuxAssert(this.used === 0, 'TS PSI pointer interrupts an unfinished section');
            }
            this.append(payload.subarray(start), sections, true);
        } else if (this.used > 0) {
            this.append(payload, sections, false);
        }

        return sections;
    }

    private append(bytes: Uint8Array, sections: Uint8Array[], mayStart: boolean): void {
        let offset = 0;
        while (offset < bytes.length) {
            if (this.used === 0 && (!mayStart || bytes[offset] === 0xff)) return;
            const target = this.length || 3;
            const count = Math.min(target - this.used, bytes.length - offset);
            this.data.set(bytes.subarray(offset, offset + count), this.used);
            this.used += count;
            offset += count;

            if (this.used === 3 && this.length === 0) {
                this.length = 3 + (((this.data[1]! & 15) << 8) | this.data[2]!);
                if (this.length > this.data.length) {
                    const data = new Uint8Array(3 + 0xfff);
                    data.set(this.data.subarray(0, this.used));
                    this.data = data;
                }
            }

            if (this.used === this.length) {
                sections.push(this.data.slice(0, this.length));
                this.used = 0;
                this.length = 0;
            }
        }
    }
}

export function validatePsiSection(section: Uint8Array): void {
    // Only the syntax indicator is checked: some muxers set the '0' bit after it or clear the
    // reserved bits, and the CRC still covers the section.
    demuxAssert((section[1]! & 0x80) !== 0, 'TS PSI section has invalid syntax flags');
    demuxAssert(section[6]! <= section[7]!, 'TS PSI section number exceeds its last section');
    demuxAssert(crc32MpegUpdate(0xffffffff, section) === 0, 'TS PSI section CRC is invalid');
}

export function sectionCrc(section: Uint8Array): number {
    const end = section.length - 4;
    return u32be(section, end);
}

function validatePsiDescriptors(section: Uint8Array, start: number, end: number): void {
    demuxAssert(end <= section.length - 4, 'TS PMT descriptor loop exceeds its section');
    while (start < end) {
        demuxAssert(start + 2 <= end, 'TS PMT descriptor header is truncated');
        start += 2 + section[start + 1]!;
        demuxAssert(start <= end, 'TS PMT descriptor exceeds its declared loop');
    }
}

/**
 * Descriptor loops must hold whole descriptors. Under compatible validation a loop whose last
 * descriptor overruns it is read up to that descriptor, as the stream entries around it are intact;
 * the loop must still end in its section.
 */
export function checkPmtDescriptors(
    section: Uint8Array,
    start: number,
    end: number,
    diagnostics: DiagnosticContext,
): void {
    try {
        validatePsiDescriptors(section, start, end);
    } catch (error) {
        if (
            diagnostics.validation !== 'compatible' ||
            end > section.length - 4 ||
            !(error instanceof DemuxError)
        )
            throw error;
        diagnostics.warn({
            code: 'TS_PMT_DESCRIPTOR_DAMAGED',
            format: 'ts',
            message: 'Ignored a PMT descriptor that overruns its loop',
        });
    }
}
