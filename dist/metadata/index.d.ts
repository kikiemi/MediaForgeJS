export type { MetadataValue, MetadataEntry, MetadataChapter, OpaqueMetadata, MediaMetadata, MetadataInput, MetadataOptions, } from './types.js';
export { normalizeMetadata } from './normalized.js';
export { serializeTracks, deserializeTracks } from '../core/track-json.js';
export type { Id3Frame, Id3Tag } from './id3.js';
export { parseId3Tag, writeId3Tag, createId3Tag } from './id3.js';
export type { EventMessage } from './emsg.js';
export { encodeEventMessage, decodeEventMessage, eventMessageTime } from './emsg.js';
