/**
 * The Deno entry, mediaforgejs/runtime/deno: Deno files as sources and sinks, and the web stream
 * adapters.
 */
export { HttpSource } from '../../core/io/sources/http-source';
export type { DenoFileHandle } from '../../runtime/deno';
export { FileSink, FileSource } from '../../runtime/deno';
export type { FileSinkOptions, FileSourceOptions } from '../../runtime/file-io';
export { sourceToReadableStream } from '../../core/io/sources/source-stream';
export { StreamSource } from '../../core/io/sources/stream-source';
export { WritableStreamSink } from '../../core/io/sinks/writable-stream-sink';
