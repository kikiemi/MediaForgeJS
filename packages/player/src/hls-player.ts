import { MediaForgeError, type PlayerFactory } from 'mediaforgejs/plugins';
import type { HlsMasterPlaylist, HlsVariant } from 'mediaforgejs/streaming';
import { HlsClient, type HlsClientOptions, type HlsPartData } from './hls-client.js';
import {
    type HlsPlaybackOptions,
    type PlaybackHooks,
    type PlaybackStream,
    playStreams,
} from './hls-playback.js';
import type { HlsDrmPlaybackOptions } from './drm/hls-drm.js';
import { AudioRenditionFeed, checkChoice, chosenRendition, inVariant } from './hls-renditions.js';
import type { SubtitleTracks } from './hls-subtitles.js';
import { changesCodecs, codecsType, invalidArgument } from './support.js';

/** Whether the browser's MSE plays the codecs of a variant (true where it cannot tell). */
function playable(variant: HlsVariant): boolean {
    const mime = codecsType(variant.codecs, undefined, !!variant.resolution);
    return !mime || typeof MediaSource !== 'function' || MediaSource.isTypeSupported(mime);
}

/** `units` with each unit marked with the variant it plays, as `see` learns of each. */
async function* marked(
    units: AsyncIterable<HlsPartData>,
    fixed: HlsVariant | undefined,
    see: (variant: HlsVariant) => void,
): AsyncGenerator<HlsPartData, void> {
    for await (const unit of units) {
        if (unit.variant) see(unit.variant);
        yield unit.variant || !fixed ? unit : { ...unit, variant: fixed };
    }
}

/**
 * The player plugin's HLS player: the client fetches the playlists and the fMP4 units (following a
 * live playlist and switching variants when asked), MSE plays them, and protected units go through
 * EME with the key systems of `settings.drm`. A variant whose sound is in an AUDIO rendition plays
 * it in a SourceBuffer of its own beside the picture (the rendition of `settings.audio`, else the
 * group's default), and its SUBTITLES renditions become text tracks of the element.
 */
export const playHlsStream: PlayerFactory = async ({ url, media, settings, signal, warn }) => {
    const audioChoice = checkChoice('audio', settings.audio);
    const subtitlesSetting = settings.subtitles ?? true;
    if (typeof subtitlesSetting !== 'boolean') checkChoice('subtitles', subtitlesSetting);
    if (settings.adaptive !== undefined && typeof settings.adaptive !== 'boolean')
        invalidArgument('HLS playback: adaptive must be a boolean');
    const drm = settings.drm as Omit<HlsDrmPlaybackOptions, keyof HlsPlaybackOptions> | undefined;
    const protection = drm ? await import('./drm/hls-drm.js') : undefined;
    const clientOptions: HlsClientOptions = {
        signal,
        ...(settings.fetch ? { fetch: settings.fetch } : {}),
        ...(settings.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: settings.requestTimeoutMs }
            : {}),
        ...(protection ? { encryptionHandlers: [protection.createHlsDrmHandler(drm!)] } : {}),
    };
    const live = settings.live;
    const partOptions = { signal, ...(live !== undefined ? { live } : {}) };

    // The client chooses the variant to start on, among those the browser plays, and switches
    // across AUDIO and SUBTITLES groups, whose renditions follow it here, and to other codecs where
    // the SourceBuffers change theirs (and no mimeType holds them).
    const switchCodecs = settings.mimeType === undefined && changesCodecs();
    const client = new HlsClient({
        ...clientOptions,
        playable,
        ...(settings.adaptive ? { adaptive: { switchGroups: true, switchCodecs } } : {}),
    });
    let audio: AudioRenditionFeed | undefined;
    let subtitles: SubtitleTracks | undefined;
    try {
        const loaded = await client.load(url, { signal });
        const master: HlsMasterPlaylist | undefined = loaded.type === 'master' ? loaded : undefined;
        // The renditions start from the variant the client starts on: without adaptive quality
        // the one it plays through, with it the first its segments come from.
        const variant = master && client.variant;
        if (master && !variant)
            throw new MediaForgeError('HLS: the playlist lists no variant', 'FORMAT');
        if (master && !settings.adaptive) await client.load(variant!.uri, { signal });

        const rendition = master && chosenRendition(master, variant!, 'AUDIO', audioChoice);
        if (master && rendition && !inVariant(rendition, variant!))
            audio = new AudioRenditionFeed(
                master,
                variant!,
                rendition,
                audioChoice,
                clientOptions,
                partOptions,
            );
        if (master && subtitlesSetting !== false && typeof media.addTextTrack === 'function') {
            const { SubtitleTracks } = await import('./hls-subtitles.js');
            subtitles = new SubtitleTracks(
                media,
                master,
                variant!,
                typeof subtitlesSetting === 'object' ? subtitlesSetting : undefined,
                clientOptions,
                { ...partOptions, warn },
            );
        }

        const units = marked(
            client.parts(partOptions),
            settings.adaptive ? undefined : variant,
            seen => audio?.follow(seen),
        );
        // A variant's sound in a rendition of its own plays beside the picture; the variant's
        // codecs give each stream its own, so `mimeType` names the picture's.
        const streams: PlaybackStream[] = audio
            ? [
                  { units, mimeType: settings.mimeType, kind: 'video' },
                  { units: audio.units(), kind: 'audio' },
              ]
            : [{ units, mimeType: settings.mimeType }];
        const playback: HlsPlaybackOptions = {
            autoplay: settings.autoplay,
            bufferAhead: settings.bufferAhead,
            bufferBehind: settings.bufferBehind,
            operationTimeoutMs: settings.operationTimeoutMs,
            signal,
        };
        const hooks: PlaybackHooks = {
            offset: (discontinuity, seconds) => subtitles?.offset(discontinuity, seconds),
            variant: (next, start) => subtitles?.follow(next, start),
        };

        if (protection)
            await protection.playStreamsWithDrm(media, streams, { ...drm!, ...playback }, hooks);
        else await playStreams(media, streams, playback, hooks);
    } finally {
        subtitles?.stop();
        audio?.close();
        client.close();
    }
};
