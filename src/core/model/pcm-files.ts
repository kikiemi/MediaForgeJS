import type { ContainerFormat } from './media';

/** The audio files that hold PCM. */
export const PCM_AUDIO_FORMATS = new Set<ContainerFormat>(['wav', 'aiff', 'au', 'caf']);
