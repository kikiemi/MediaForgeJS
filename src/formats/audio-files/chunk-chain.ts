import { DemuxError } from '../../core/errors/errors';
import { reportDamage, type AudioIndexContext } from './index-context';

/** How the chunk chain of one format reads and names itself. */
export interface ChunkChainFormat {
    /** The format's name in messages: 'WAVE', 'AIFF', 'CAF'. */
    readonly name: string;
    /** The prefix of its damage codes; lowercase, the format its reports name. */
    readonly code: string;
    /** Bytes of a chunk header. */
    readonly header: number;
    /** One failure for a chain of more than 4096 chunks and one cut inside a chunk header. */
    readonly failure?: string;
}

/**
 * A walk through the chunk chain of a WAVE, AIFF or CAF file, from `position` to `end`: at most
 * 4096 chunks, the event loop let run every 256. A lenient read ends the walk where the end of the
 * input cuts a chunk header, or a chunk other than the audio data, once the audio data was found:
 * it reports the format's TRUNCATED_CHUNK damage and sets `clamped`.
 */
export class ChunkChain {
    /** The end of the input cut the chain. */
    clamped = false;
    /** Chunks walked so far. */
    chunks = 0;

    constructor(
        private readonly context: AudioIndexContext,
        private readonly chain: ChunkChainFormat,
        private readonly lenient: boolean,
        public position: number,
        public end: number,
    ) {}

    /**
     * The header of the chunk at `position`; undefined at the end of the chain, or at a header cut
     * by the end of the input once the audio data was found (`data`) in a lenient read.
     */
    async next(data: boolean): Promise<Uint8Array | undefined> {
        const { context, chain, position } = this;
        if (position >= this.end) return undefined;
        if (++this.chunks > 4096)
            throw new DemuxError(chain.failure ?? `${chain.name} chunk chain exceeds 4096 chunks`);
        if (this.end - position < chain.header) {
            if (!this.lenient || !data)
                throw new DemuxError(chain.failure ?? `${chain.name} chunk chain is truncated`);
            this.cut(`Ignoring an incomplete ${chain.name} chunk header at the end of the input`);
            return undefined;
        }
        if ((this.chunks & 255) === 0) await context.checkpoint();
        return context.read(position, chain.header);
    }

    /**
     * The length of chunk `id` whose `length` bytes and pad byte start at `body`: its own when they
     * end before the chain does, else in a lenient read the bytes up to the end when the chunk is
     * the audio data (`audio`) or follows it (`data`); otherwise the read fails with `message`.
     */
    fit(id: string, body: number, length: number, audio: boolean, data: boolean, message: string) {
        if (length <= this.end - body && (length & 1) <= this.end - body - length) return length;
        if (!this.lenient || (!audio && !data)) throw new DemuxError(message);
        this.cut(
            `${this.chain.name} '${id}' chunk is cut by the end of the input; keeping what remains`,
        );
        return this.end - body;
    }

    /** Reports the end of the input cutting the chunk at `position`. */
    cut(message: string): void {
        const { code } = this.chain;
        reportDamage(
            this.context,
            'warn',
            code.toLowerCase(),
            `${code}_TRUNCATED_CHUNK`,
            this.position,
            message,
        );
        this.clamped = true;
    }
}
