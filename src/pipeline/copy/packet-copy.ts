/**
 * The write side of media files, loaded with the first writer a check or copy needs: MediaFile's
 * writing half, the copy planner and the sinks and cue clipping that go with it. Inspecting and
 * opening an input loads none of it.
 */
export { MediaFileWriter } from './media-file-writer';
export { snapshotRemux } from './copy-options';
export { filePlanner } from './remux-plan';
export { clipCue } from './trim-plan';
export { BLOB_PART_BYTES, MemorySink } from '../../core/io/sinks/sinks';
export { createValidationSink } from '../../core/io/sinks/validation-sink';
export { withOutputLimit } from '../../core/io/sinks/output-sink';
