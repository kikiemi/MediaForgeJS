/**
 * The player contract: a part that plays a streaming protocol (HLS, DASH) in a media element.
 */

/** A streaming protocol a player plays. */
export type PlayerProtocol = 'hls' | 'dash';

/**
 * Which alternative rendition plays: the one of this NAME, else the first of these languages (BCP
 * 47 ranges, in order of preference).
 */
export interface RenditionChoice {
    readonly name?: string;
    readonly language?: string | readonly string[];
}

/** How a stream plays: the settings every player takes, read and checked by the API. */
export interface PlayerSettings {
    /** MSE MIME type with codecs; omitted takes the stream's own codecs. */
    readonly mimeType?: string;
    /** Calls media.play() once after the first append; default true. */
    readonly autoplay?: boolean;
    /** Seconds buffered ahead of the playhead before fetching more; default 30. */
    readonly bufferAhead?: number;
    /** Seconds of played media kept behind the playhead; default 30. */
    readonly bufferBehind?: number;
    /** Deadline of each MediaSource operation in milliseconds; default 30000. */
    readonly operationTimeoutMs?: number;
    /** Deadline of each request in milliseconds; default 30000. */
    readonly requestTimeoutMs?: number;
    /** Follows a live stream as its playlist or manifest grows. */
    readonly live?: boolean;
    /** Switches quality with the measured bandwidth where the stream offers several. */
    readonly adaptive?: boolean;
    /** The fetch the player requests with; default the global fetch. */
    readonly fetch?: typeof globalThis.fetch;
    /** Encrypted streams: options of the protocol's DRM (key systems, license callbacks). */
    readonly drm?: object;
    /**
     * The audio rendition of an HLS variant whose sound is in a rendition of its own; without it,
     * the DEFAULT=YES one, else an AUTOSELECT=YES one, else the first of the group.
     */
    readonly audio?: RenditionChoice;
    /**
     * The subtitles renditions become text tracks of the media element, the one chosen here (else
     * the DEFAULT=YES one) showing; false adds none. Default true.
     */
    readonly subtitles?: boolean | RenditionChoice;
}

/** One playback a player runs: the stream, the element and how to play it. */
export interface PlayerRequest {
    readonly url: string;
    readonly media: HTMLMediaElement;
    readonly settings: PlayerSettings;
    /** Stops the playback; the player then rejects with ABORT and releases the element. */
    readonly signal: AbortSignal;
    /** Reports what the playback leaves out but plays on without, such as subtitles that fail. */
    readonly warn?: (code: string, message: string) => void;
}

/** Plays one stream until it ends (resolves), fails or is stopped (rejects). */
export type PlayerFactory = (request: PlayerRequest) => Promise<void>;

/** A player part: the protocols it plays, how it recognises them, and its player. */
export interface PlayerPart {
    readonly id: string;
    readonly protocols: readonly PlayerProtocol[];
    /**
     * Recognises a stream of the part's first protocol from its URL, or from the start of its
     * manifest when `manifest` is given; omitted leaves the decision to the URL's extension.
     */
    readonly sniff?: (url: string, manifest?: string) => boolean;
    /** Loads the player with the first stream of its protocols. */
    readonly load: () => Promise<PlayerFactory>;
}
