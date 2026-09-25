import type { AssSubtitleOptions, ParseSubtitleOptions, SubtitleOptions } from './types.js';
export declare function snapshotSubtitleOptions(options: SubtitleOptions): SubtitleOptions;
export declare function snapshotInterchangeOptions<T extends AssSubtitleOptions | ParseSubtitleOptions>(options: T): T;
