import { createPcmCopyMuxer } from './pcm-copy.js';
export function createWaveCopyMuxer(track, sink) {
    return createPcmCopyMuxer('wav', track, sink);
}
