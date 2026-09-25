import { type MetadataPolicy } from '../core/diagnostics.js';
import type { MP4DemuxResult, MP4TrackInfo } from '../demux/mp4-demuxer.js';
type MetadataTrack = Pick<MP4TrackInfo, 'id' | 'matroskaTrackUid' | 'language' | 'name' | 'title' | 'default' | 'forced' | 'commentary'>;
export declare function reportConversionMetadata(result: Pick<MP4DemuxResult, 'matroskaPassThrough' | 'matroskaUnsupportedTags'>, format: string, tracks: readonly MetadataTrack[], policy: MetadataPolicy | undefined, label: string): void;
export {};
