import { MediaForgeError } from '../core/errors/errors';
import { linkAbortSignals } from '../core/io/abort';
import type { PlayerPart, PlayerProtocol, PlayerSettings } from '../core/contracts/player';
import type { PluginManifest } from '../core/contracts/plugin';
import { MissingParts } from '../pipeline/plugins/missing-parts';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { OptionPolicy } from '../core/errors/option-policy';
import { readPlayOptions } from './options/open-options';
import { warningOf } from './options/options';
import { PLAY_KEYS } from './options/request-keys';
import type { CommonOptions } from './types';

/**
 * How play() plays a stream. `drm` takes the options of the player in use for encrypted streams:
 * the `PlayDrmOptions` of mediaforgejs-player (key systems and license callbacks for EME).
 */
export interface PlayOptions extends PlayerSettings, CommonOptions {
    /** 'hls' or 'dash'; read from the URL (.m3u8, .mpd) or from the manifest when left out. */
    readonly protocol?: PlayerProtocol;
    /** Stops the playback, as stop() does. */
    readonly signal?: AbortSignal;
}

/** A player bound to one media element, which plays one stream at a time. */
export interface Player {
    /**
     * Plays the stream at `source` (an HLS playlist or a DASH MPD) with the player's options under
     * `options`, once the stream played before has stopped.
     */
    load(source: string | URL, options?: PlayOptions): Playback;
    /** Stops the stream playing, if any. */
    stop(): void;
}

/** A playback in progress. */
export interface Playback {
    /**
     * Settles when the playback ends: resolves after the media element's ended event, rejects with
     * the error that stopped it (ABORT after stop() or the signal).
     */
    readonly finished: Promise<void>;
    /** Stops the playback and releases the media element. */
    stop(): void;
}

/** Bytes of a manifest read to recognise its protocol. */
const SNIFF_BYTES = 4096;

/** The start of the manifest at `url`, as text. */
async function manifestHead(
    url: string,
    settings: PlayerSettings,
    signal: AbortSignal,
): Promise<string> {
    const response = await (settings.fetch ?? globalThis.fetch)(url, { signal });
    if (!response.ok)
        throw new MediaForgeError(`Manifest request failed with HTTP ${response.status}`, 'IO');
    const reader = response.body?.getReader();
    if (!reader) return (await response.text()).slice(0, SNIFF_BYTES);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (length < SNIFF_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            length += value.length;
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return new TextDecoder().decode(bytes);
}

/** The path of a URL without its query and fragment, lower case. */
const pathOf = (url: string): string => url.split(/[?#]/, 1)[0]!.toLowerCase();

/** The start of a DASH MPD: its MPD element after an XML declaration and comments. */
const MPD_START = /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<MPD[\s>]/;

/**
 * The protocol a URL (.m3u8 or .m3u, .mpd) or the start of its manifest (#EXTM3U, an MPD element)
 * shows.
 */
function streamProtocol(url: string, manifest?: string): PlayerProtocol | undefined {
    if (manifest !== undefined) {
        if (manifest.trimStart().startsWith('#EXTM3U')) return 'hls';
        return MPD_START.test(manifest) ? 'dash' : undefined;
    }
    const path = pathOf(url);
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
    return path.endsWith('.mpd') ? 'dash' : undefined;
}

/**
 * The protocol of a stream: the one asked for, else the first that a player part in use
 * recognises, or the library does, from the URL, else from the start of the manifest.
 */
async function protocolOf(
    url: string,
    options: PlayOptions,
    players: readonly PlayerPart[],
    signal: AbortSignal,
): Promise<PlayerProtocol> {
    if (options.protocol !== undefined) return options.protocol;
    const recognised = (manifest?: string): PlayerProtocol | undefined =>
        players.find(part => part.sniff?.(url, manifest) === true)?.protocols[0] ??
        streamProtocol(url, manifest);
    const fromUrl = recognised();
    if (fromUrl) return fromUrl;
    const fromManifest = recognised(await manifestHead(url, options, signal));
    if (fromManifest) return fromManifest;
    throw new MediaForgeError('The stream is neither an HLS playlist nor a DASH MPD', 'FORMAT', {
        hint: "Pass protocol: 'hls' or 'dash'.",
    });
}

/**
 * Plays `url` in `media` with the player part in use for its protocol; a protocol no part in use
 * plays fails with PLUGIN naming the plugin that does: one of the catalog, else the player of
 * mediaforgejs-player. Without any player part that fails before a request.
 */
export async function runPlayback(
    url: string,
    media: HTMLMediaElement,
    given: PlayOptions,
    use: {
        /** The player parts in use. */
        readonly players: readonly PlayerPart[];
        /** The plugins of the library, which name the plugin a protocol needs. */
        readonly catalog: readonly PluginManifest[];
        /** Aborts when the playback is stopped. */
        readonly stopped: AbortSignal;
        /** The option policy of the call, under which unknown keys warn or fail. */
        readonly policy: OptionPolicy;
        /** Receives the call's warnings. */
        readonly warn: (warning: MediaDiagnostic) => void;
    },
): Promise<void> {
    const { players, catalog, stopped } = use;
    // Unknown keys are reported as every call reports them; strict fails the playback with INPUT.
    const { settings, warnings } = readPlayOptions(given, PLAY_KEYS, use.policy);
    for (const warning of warnings) use.warn(warning);
    const options = settings as PlayOptions;
    const linked = linkAbortSignals(stopped, options.signal);
    try {
        if (linked.signal.aborted) throw new MediaForgeError('Playback stopped', 'ABORT');
        const missing = (protocol: PlayerProtocol | undefined): MediaForgeError =>
            new MissingParts(catalog).player(
                protocol ?? 'hls',
                `No player of ${protocol?.toUpperCase() ?? 'HLS or DASH'} streams is in use`,
            );
        if (!players.length) throw missing(options.protocol ?? streamProtocol(url));
        const protocol = await protocolOf(url, options, players, linked.signal);
        const part = players.find(candidate => candidate.protocols.includes(protocol));
        if (!part) throw missing(protocol);
        const play = await part.load();
        await play({
            url,
            media,
            settings: options,
            signal: linked.signal,
            warn: (code, message) => use.warn(warningOf({ code, message })),
        });
    } catch (error) {
        if (linked.signal.aborted && !(error instanceof MediaForgeError))
            throw new MediaForgeError('Playback stopped', 'ABORT');
        throw error;
    } finally {
        linked.dispose();
    }
}
