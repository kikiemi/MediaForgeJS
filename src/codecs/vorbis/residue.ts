import { DecodeError } from '../../core/errors/errors';
import { ilog, type VorbisBits } from './bits';
import type { VorbisCodebook } from './codebook';

function invalid(message: string): never {
    throw new DecodeError(`Vorbis residue is invalid: ${message}`);
}

/** Residue vector decoder of Vorbis I section 8, formats 0, 1 and 2. */
export class VorbisResidue {
    readonly type: number;
    private readonly begin: number;
    private readonly end: number;
    private readonly grouping: number;
    private readonly partitions: number;
    private readonly classBook: VorbisCodebook;
    private readonly cascade: Uint8Array;
    private readonly stageBooks: (VorbisCodebook | null)[][] = [];
    private readonly stages: number;
    private readonly partValues: number;
    private readonly decodeMap: Uint8Array;
    private readonly partWords: Int32Array[] = [];
    private readonly bundle: Float32Array[] = [];
    private readonly entries: Int32Array;

    constructor(
        type: number,
        bits: VorbisBits,
        books: readonly VorbisCodebook[],
        channels: number,
    ) {
        this.type = type;
        this.begin = bits.read(24);
        this.end = bits.read(24);
        this.grouping = bits.read(24) + 1;
        this.partitions = bits.read(6) + 1;
        const classBookIndex = bits.read(8);
        if (classBookIndex < 0) invalid('the classification codebook is missing');
        this.cascade = new Uint8Array(this.partitions);
        let stageCount = 0;
        for (let j = 0; j < this.partitions; j++) {
            let cascade = bits.read(3);
            const flag = bits.read(1);
            if (flag < 0) invalid('the cascade is truncated');
            if (flag) cascade |= bits.read(5) << 3;
            this.cascade[j] = cascade;
            for (let bit = cascade; bit; bit &= bit - 1) stageCount++;
        }
        const bookList: number[] = [];
        for (let j = 0; j < stageCount; j++) {
            const index = bits.read(8);
            if (index < 0) invalid('the codebook list is truncated');
            bookList.push(index);
        }
        const classBook = books[classBookIndex];
        if (!classBook) invalid('the classification codebook is missing');
        for (const index of bookList) {
            const book = books[index];
            if (!book || book.mapType === 0) invalid('a stage codebook has no value mapping');
        }
        this.classBook = classBook;
        const dim = classBook.dim;
        if (dim < 1) invalid('the classification codebook is empty');
        let partValues = 1;
        for (let d = 0; d < dim; d++) {
            partValues *= this.partitions;
            if (partValues > classBook.entries) invalid('the classification codebook is too small');
        }
        this.partValues = partValues;
        let maxStage = 0;
        let used = 0;
        for (let j = 0; j < this.partitions; j++) {
            const stages = ilog(this.cascade[j]!);
            if (stages > maxStage) maxStage = stages;
            const stageBooks: (VorbisCodebook | null)[] = [];
            for (let k = 0; k < stages; k++)
                stageBooks.push(this.cascade[j]! & (1 << k) ? books[bookList[used++]!]! : null);
            this.stageBooks.push(stageBooks);
        }
        this.stages = maxStage;
        this.decodeMap = new Uint8Array(partValues * dim);
        for (let j = 0; j < partValues; j++) {
            let value = j;
            let mult = partValues / this.partitions;
            for (let k = 0; k < dim; k++) {
                const deco = Math.floor(value / mult);
                value -= deco * mult;
                mult /= this.partitions;
                this.decodeMap[j * dim + k] = deco;
            }
        }
        const maxWords = Math.ceil(Math.max(0, this.end - this.begin) / this.grouping / dim) + 1;
        for (let c = 0; c < channels; c++) this.partWords.push(new Int32Array(maxWords));
        this.entries = new Int32Array(this.grouping + 1);
    }

    /**
     * Adds the residue of the channels in `planes` whose `nonzero` flag is set (Vorbis I section
     * 8.6.2); each plane holds `blockSize / 2` values.
     */
    decode(
        bits: VorbisBits,
        planes: readonly Float32Array[],
        nonzero: readonly boolean[],
        blockSize: number,
    ): void {
        const ch = planes.length;
        if (this.type === 2) {
            let any = false;
            for (let i = 0; i < ch; i++) if (nonzero[i]) any = true;
            if (any) this.decodeInterleaved(bits, planes, ch, blockSize);
            return;
        }
        let used = 0;
        for (let i = 0; i < ch; i++) if (nonzero[i]) this.bundle[used++] = planes[i]!;
        if (used) this.decodePlanar(bits, used, blockSize);
        this.bundle.length = 0;
    }

    private decodePlanar(bits: VorbisBits, ch: number, blockSize: number): void {
        const samplesPerPartition = this.grouping;
        const partitionsPerWord = this.classBook.dim;
        const max = blockSize >> 1;
        const end = this.end < max ? this.end : max;
        const n = end - this.begin;
        if (n <= 0) return;
        const partValues = Math.floor(n / samplesPerPartition);
        const partWords = this.partWords;
        const decodeMap = this.decodeMap;
        for (let s = 0; s < this.stages; s++) {
            for (let i = 0, l = 0; i < partValues; l++) {
                if (s === 0) {
                    for (let j = 0; j < ch; j++) {
                        const temp = this.classBook.decode(bits);
                        if (temp === -1 || temp >= this.partValues) return;
                        partWords[j]![l] = temp * partitionsPerWord;
                    }
                }
                for (let k = 0; k < partitionsPerWord && i < partValues; k++, i++) {
                    for (let j = 0; j < ch; j++) {
                        const partition = decodeMap[partWords[j]![l]! + k]!;
                        if (!(this.cascade[partition]! & (1 << s))) continue;
                        const book = this.stageBooks[partition]![s];
                        if (!book) continue;
                        const offset = this.begin + i * samplesPerPartition;
                        const ok =
                            this.type === 0
                                ? book.decodeVsAdd(
                                      this.bundle[j]!,
                                      offset,
                                      bits,
                                      samplesPerPartition,
                                      this.entries,
                                  )
                                : book.decodeVAdd(
                                      this.bundle[j]!,
                                      offset,
                                      bits,
                                      samplesPerPartition,
                                  );
                        if (!ok) return;
                    }
                }
            }
        }
    }

    private decodeInterleaved(
        bits: VorbisBits,
        planes: readonly Float32Array[],
        ch: number,
        blockSize: number,
    ): void {
        const samplesPerPartition = this.grouping;
        const partitionsPerWord = this.classBook.dim;
        const max = (blockSize * ch) >> 1;
        const end = this.end < max ? this.end : max;
        const n = end - this.begin;
        if (n <= 0) return;
        const partValues = Math.floor(n / samplesPerPartition);
        const partWords = this.partWords[0]!;
        const decodeMap = this.decodeMap;
        for (let s = 0; s < this.stages; s++) {
            for (let i = 0, l = 0; i < partValues; l++) {
                if (s === 0) {
                    const temp = this.classBook.decode(bits);
                    if (temp === -1 || temp >= this.partValues) return;
                    partWords[l] = temp * partitionsPerWord;
                }
                for (let k = 0; k < partitionsPerWord && i < partValues; k++, i++) {
                    const partition = decodeMap[partWords[l]! + k]!;
                    if (!(this.cascade[partition]! & (1 << s))) continue;
                    const book = this.stageBooks[partition]![s];
                    if (!book) continue;
                    if (
                        !book.decodeVvAdd(
                            planes,
                            i * samplesPerPartition + this.begin,
                            ch,
                            bits,
                            samplesPerPartition,
                        )
                    )
                        return;
                }
            }
        }
    }
}
