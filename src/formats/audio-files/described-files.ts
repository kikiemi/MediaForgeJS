// The parts of the audio file reader that FLAC, Ogg and CAF inputs run, loaded together with the
// first of them: opening a WAV, AIFF or AU file loads none of them.
export { demuxFlac, probeFlac } from './flac-reader';
export { demuxOgg, probeOgg } from './ogg-reader';
export { indexCaf } from './caf-reader';
