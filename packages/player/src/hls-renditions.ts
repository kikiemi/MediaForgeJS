import type { RenditionChoice } from 'mediaforgejs/plugins';
import {
    type HlsMasterPlaylist,
    type HlsRendition,
    type HlsVariant,
    getHlsRenditions,
    selectHlsRendition,
} from 'mediaforgejs/streaming';
import { HlsClient, type HlsClientOptions, type HlsPartData } from './hls-client.js';
import { invalidArgument } from './support.js';

// The alternative renditions of an HLS variant that the player plays beside it: the audio of a
// variant whose sound is in a rendition of its own, followed across variant switches.

/** The languages of a choice as selectHlsRendition takes them. */
function languagesOf(choice: RenditionChoice | undefined): string[] | undefined {
    const language = choice?.language;
    return language === undefined
        ? undefined
        : typeof language === 'string'
          ? [language]
          : [...language];
}

/** Checks a rendition choice of the settings; undefined is no choice. */
export function checkChoice(name: string, choice: unknown): RenditionChoice | undefined {
    if (choice === undefined) return undefined;
    if (!choice || typeof choice !== 'object' || Array.isArray(choice))
        invalidArgument(`HLS playback: ${name} must be an object of name and language`);
    const { name: wanted, language } = choice as RenditionChoice;
    if (wanted !== undefined && (typeof wanted !== 'string' || !wanted))
        invalidArgument(`HLS playback: ${name}.name must be a non-empty string`);
    const languages = typeof language === 'string' ? [language] : language;
    if (
        languages !== undefined &&
        (!Array.isArray(languages) || languages.some(item => typeof item !== 'string' || !item))
    )
        invalidArgument(`HLS playback: ${name}.language must be language tags`);
    return choice as RenditionChoice;
}

/**
 * The rendition of `type` of `variant` the choice names: by NAME, else by language among the
 * renditions that may be selected automatically, else the DEFAULT=YES one, else an AUTOSELECT=YES
 * one, else the first of the group; undefined when the variant references no group.
 */
export function chosenRendition(
    master: HlsMasterPlaylist,
    variant: HlsVariant,
    type: 'AUDIO' | 'SUBTITLES',
    choice?: RenditionChoice,
): HlsRendition | undefined {
    const group = getHlsRenditions(master, variant, type);
    if (!group.length) return undefined;
    const languages = languagesOf(choice);
    const named =
        choice?.name !== undefined || languages
            ? selectHlsRendition(master, variant, {
                  type,
                  ...(choice?.name !== undefined ? { name: choice.name } : {}),
                  ...(languages ? { languages } : {}),
              })
            : undefined;
    return (
        named ??
        group.find(rendition => rendition.default) ??
        group.find(rendition => rendition.autoselect) ??
        group[0]
    );
}

/** Whether `rendition` is the variant's own stream: no URI, or the variant's. */
export function inVariant(rendition: HlsRendition, variant: HlsVariant): boolean {
    return rendition.uri === undefined || rendition.uri === variant.uri;
}

/**
 * The rendition of `variant`'s group that stands for `previous` of another group: the one of its
 * name, else of its language, else the group's choice.
 */
function matchingRendition(
    master: HlsMasterPlaylist,
    variant: HlsVariant,
    previous: HlsRendition,
    choice: RenditionChoice | undefined,
): HlsRendition | undefined {
    const group = getHlsRenditions(master, variant, 'AUDIO');
    return (
        group.find(rendition => rendition.name === previous.name) ??
        group.find(
            rendition =>
                previous.language !== undefined &&
                rendition.language?.toLowerCase() === previous.language.toLowerCase(),
        ) ??
        chosenRendition(master, variant, 'AUDIO', choice)
    );
}

/** The media sequence of a unit, with the parts of a segment counted as its sequence. */
function sequenceOf(unit: HlsPartData): number {
    return unit.type === 'part' ? unit.sequence : unit.segment.sequence;
}

/**
 * The audio of a multivariant playlist whose variants carry their sound in an AUDIO rendition: the
 * rendition of the variant playing, read by a client of its own with the main client's options (its
 * keys and decryption, its live refreshes), its units marked with that variant so their MSE type
 * comes from the variant's audio codecs. When adaptive quality moves to a variant of another
 * group, the matching rendition of that group takes over from the next media sequence.
 */
export class AudioRenditionFeed {
    #variant: HlsVariant;
    #rendition: HlsRendition;
    #client?: HlsClient;

    constructor(
        private readonly master: HlsMasterPlaylist,
        variant: HlsVariant,
        rendition: HlsRendition,
        private readonly choice: RenditionChoice | undefined,
        private readonly clientOptions: HlsClientOptions,
        private readonly partOptions: { readonly live?: boolean; readonly signal: AbortSignal },
    ) {
        this.#variant = variant;
        this.#rendition = rendition;
    }

    /** The rendition playing. */
    get rendition(): HlsRendition {
        return this.#rendition;
    }

    /** Follows the variant the video plays: its group's matching rendition plays from now. */
    follow(variant: HlsVariant): void {
        if (variant.uri === this.#variant.uri && variant.audio === this.#variant.audio) return;
        const next =
            variant.audio === this.#variant.audio
                ? this.#rendition
                : matchingRendition(this.master, variant, this.#rendition, this.choice);
        this.#variant = variant;
        // A variant that carries its own sound keeps the rendition: one stream cannot stop.
        if (next && !inVariant(next, variant)) this.#rendition = next;
    }

    /**
     * The units of the rendition playing, switching where the followed variant changes it: at the
     * next media sequence, so a segment begun in parts ends in the rendition before.
     */
    async *units(): AsyncGenerator<HlsPartData, void> {
        let playing: HlsRendition | undefined;
        let playingVariant = this.#variant;
        let iterator: AsyncIterator<HlsPartData> | undefined;
        let sequence: number | undefined;
        let last: HlsPartData | undefined;
        try {
            for (;;) {
                if (playing && playing.uri !== this.#rendition.uri && last?.type === 'part') {
                    const result = await iterator!.next();
                    if (result.done) return;
                    const unit = result.value;
                    if (sequenceOf(unit) === sequence) {
                        last = unit;
                        yield { ...unit, variant: playingVariant };
                        continue;
                    }
                    // The next segment's first unit: the new rendition plays that segment.
                    last = undefined;
                    sequence = sequenceOf(unit) - 1;
                }
                if (playing?.uri !== this.#rendition.uri) {
                    await iterator?.return?.();
                    this.#client?.close();
                    playing = this.#rendition;
                    playingVariant = this.#variant;
                    const client = new HlsClient({ ...this.clientOptions, adaptive: false });
                    this.#client = client;
                    await client.load(playing.uri!, { signal: this.partOptions.signal });
                    iterator = client.parts({
                        signal: this.partOptions.signal,
                        ...(this.partOptions.live !== undefined
                            ? { live: this.partOptions.live }
                            : {}),
                        ...(sequence !== undefined ? { startSequence: sequence + 1 } : {}),
                    });
                }
                const result = await iterator!.next();
                if (result.done) return;
                last = result.value;
                sequence = sequenceOf(last);
                yield { ...last, variant: this.#variant };
            }
        } finally {
            await iterator?.return?.();
            this.close();
        }
    }

    close(): void {
        this.#client?.close();
        this.#client = undefined;
    }
}
