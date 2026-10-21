// mediaforgejs-player: HLS and DASH playback through Media Source Extensions for mediaforgejs, as a
// plugin of its play() and createPlayer(), and the parts it is made of.
import type { MediaForgePlugin, PlayerFactory } from 'mediaforgejs/plugins';
import type { HlsDrmPlaybackOptions } from './drm/hls-drm.js';
import type { HlsPlaybackOptions } from './hls-playback.js';

/** A player part's factory, loaded with the first stream of its protocol. */
const loads = (load: () => Promise<PlayerFactory>) => {
    let loaded: Promise<PlayerFactory> | undefined;
    return () => {
        loaded ??= load().catch(error => {
            loaded = undefined;
            throw error;
        });
        return loaded;
    };
};

/**
 * Playback of HLS and DASH streams in a media element, which play() and createPlayer() use once it
 * is added (`plugins: { add: [player] }`): the HLS client with adaptive quality, live playlists,
 * EME and HLS DRM, and a DASH player for static MPDs of fMP4, both through Media Source
 * Extensions. Each player loads with the first stream of its protocol.
 */
export const player: MediaForgePlugin = Object.freeze({
    name: 'player',
    description:
        'HLS and DASH playback (Media Source Extensions, adaptive quality, live streams, EME and ' +
        'HLS DRM)',
    players: Object.freeze([
        Object.freeze({
            id: 'hls',
            protocols: Object.freeze(['hls'] as const),
            load: loads(async () => (await import('./hls-player.js')).playHlsStream),
        }),
        Object.freeze({
            id: 'dash',
            protocols: Object.freeze(['dash'] as const),
            load: loads(async () => (await import('./dash-player.js')).playDashStream),
        }),
    ]),
});

/** The `drm` option of play() and createPlayer() for encrypted HLS: key systems and licenses. */
export type PlayDrmOptions = Omit<HlsDrmPlaybackOptions, keyof HlsPlaybackOptions>;

export type {
    HlsAdaptiveOptions,
    HlsClientOptions,
    HlsPartData,
    HlsPartOptions,
    HlsSegmentData,
    HlsSegmentOptions,
    HlsVariantChange,
} from './hls-client.js';
export { HlsClient } from './hls-client.js';
export type { HlsPlaybackOptions } from './hls-playback.js';
export { playHls } from './hls-playback.js';
export type {
    HlsDecryptionRequest,
    HlsEncryptionContext,
    HlsEncryptionHandler,
    HlsKeyLoader,
} from './encryption.js';
export type {
    HlsDrmInitDataRequest,
    HlsDrmKeySystem,
    HlsDrmOptions,
    HlsDrmPlaybackOptions,
    HlsDrmSessionOptions,
} from './drm/hls-drm.js';
export { createHlsDrmHandler, playHlsWithDrm } from './drm/hls-drm.js';
export type { HlsDrmInitData } from './drm/hls-drm-data.js';
export type { AdaptiveQualityOptions } from './adaptive-quality.js';
export { AdaptiveQualityController } from './adaptive-quality.js';
export { EmeController } from './drm/eme-controller.js';
export type {
    EmeControllerOptions,
    EmeKeyStatus,
    EmeKeyStatusesChange,
    EmeLicenseCallback,
    EmeLicenseRequest,
} from './drm/eme-controller.js';
export { createClearKeyLicense } from './drm/clear-key.js';
export { createHttpLicenseCallback } from './drm/http-license.js';
export type { HttpLicenseOptions } from './drm/http-license.js';
export {
    createSampleAesHandler,
    decryptSampleAesAac,
    decryptSampleAesAvc,
} from './drm/sample-aes.js';
