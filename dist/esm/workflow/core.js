import { MediaEngine } from '../engine/engine-core.js';
import { snapshotOpenOptions } from '../engine/open-options.js';
import { MediaForgeError } from '../core/errors.js';
import { linkAbortSignals } from '../core/abort.js';
import { assertSink } from '../io/sink-backpressure.js';
import { checkSignal, outputLimit, snapshotRequest } from './requests.js';
import { snapshotAudio, snapshotDecoder, snapshotTransform } from './modules.js';
import { outputStream, snapshotStreamOptions } from './output-stream.js';
import { MediaJob } from './job.js';
export { MediaJob } from './job.js';
export class MediaWorkflow {
    engine;
    audio;
    audioDecoder;
    transform;
    constructor(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('Expected workflow options', 'INPUT');
        const { formats, demuxers, codecs, audio, audioDecoder, transform } = options;
        this.engine = new MediaEngine({ formats, demuxers, codecs });
        this.audio = snapshotAudio(audio);
        this.audioDecoder = snapshotDecoder(audioDecoder);
        this.transform = snapshotTransform(transform);
    }
    async open(input, options = {}) {
        const snapshot = snapshotOpenOptions(options);
        checkSignal(snapshot.signal);
        return new MediaJob(await this.engine.open(input, snapshot), this.audio, this.audioDecoder, this.transform);
    }
    async inspect(input, options = {}) {
        const job = await this.open(input, options);
        try {
            return job.inspect();
        }
        finally {
            job.close();
        }
    }
    async check(input, request, options = {}) {
        let job;
        let linked;
        try {
            const maxBytes = outputLimit(options, Number.MAX_SAFE_INTEGER);
            const open = snapshotOpenOptions(options.open);
            const snapshot = snapshotRequest(request);
            checkSignal(open.signal);
            linked = linkAbortSignals(open.signal, snapshot.signal);
            job = await this.open(input, { ...open, signal: linked.signal, onWarning: undefined });
            return await job.check({ ...snapshot, signal: linked.signal, onProgress: undefined }, { maxBytes });
        }
        catch (error) {
            if (!(error instanceof MediaForgeError))
                throw error;
            return { supported: false, code: error.code, reason: error.message, warnings: [] };
        }
        finally {
            job?.close();
            linked?.dispose();
        }
    }
    async write(input, sink, request, options = {}) {
        assertSink(sink);
        const maxBytes = outputLimit(options, Number.MAX_SAFE_INTEGER);
        const open = snapshotOpenOptions('open' in options ? options.open : options);
        checkSignal(open.signal);
        checkSignal(sink.signal);
        const snapshot = snapshotRequest(request);
        const linked = linkAbortSignals(open.signal, snapshot.signal, sink.signal);
        let job;
        try {
            job = await this.open(input, { ...open, signal: linked.signal });
            await job.write(sink, { ...snapshot, signal: linked.signal }, { maxBytes });
        }
        finally {
            job?.close();
            linked.dispose();
        }
    }
    async toBlob(input, request, options = {}) {
        const limit = outputLimit(options);
        const open = snapshotOpenOptions(options.open);
        checkSignal(open.signal);
        const snapshot = snapshotRequest(request);
        const linked = linkAbortSignals(open.signal, snapshot.signal);
        let job;
        try {
            job = await this.open(input, { ...open, signal: linked.signal });
            return await job.toBlob({ ...snapshot, signal: linked.signal }, { maxBytes: limit });
        }
        finally {
            job?.close();
            linked.dispose();
        }
    }
    toReadableStream(input, request, options = {}) {
        const streamOptions = snapshotStreamOptions(options);
        const open = snapshotOpenOptions(options.open);
        const snapshot = snapshotRequest(request);
        checkSignal(open.signal);
        return outputStream(async (sink, signal) => {
            const linked = linkAbortSignals(open.signal, snapshot.signal, signal);
            let job;
            try {
                job = await this.open(input, { ...open, signal: linked.signal });
                await job.write(sink, { ...snapshot, signal: linked.signal });
            }
            finally {
                job?.close();
                linked.dispose();
            }
        }, streamOptions);
    }
    segments(input, options = {}, openOptions = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('Expected segment options', 'INPUT');
        const { trackIds, targetDuration, maxBufferedBytes, maxBufferedSamples, requireKeyframe, signal } = options;
        const snapshot = {
            trackIds: Array.isArray(trackIds) ? trackIds.slice() : trackIds,
            targetDuration,
            maxBufferedBytes,
            maxBufferedSamples,
            requireKeyframe,
            signal,
        };
        const open = snapshotOpenOptions(openOptions);
        checkSignal(signal);
        checkSignal(open.signal);
        const workflow = this;
        return (async function* () {
            const linked = linkAbortSignals(open.signal, signal);
            let job;
            try {
                job = await workflow.open(input, { ...open, signal: linked.signal });
                yield* job.segments({ ...snapshot, signal: linked.signal });
            }
            finally {
                job?.close();
                linked.dispose();
            }
        })();
    }
    async batch(items, options = {}) {
        if (!Array.isArray(items) || !options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('Expected batch items and options', 'INPUT');
        const { concurrency = 2, signal } = options;
        checkSignal(signal);
        if (!Number.isSafeInteger(concurrency) || concurrency < 1)
            throw new MediaForgeError('concurrency must be a positive safe integer', 'INPUT');
        const snapshots = items.map(item => {
            try {
                if (!item || typeof item !== 'object' || Array.isArray(item))
                    throw new MediaForgeError('Expected a batch item', 'INPUT');
                const { input, request, options: output = {} } = item;
                const maxBytes = outputLimit(output);
                const open = snapshotOpenOptions(output.open);
                return { input, request: snapshotRequest(request), options: { maxBytes, open } };
            }
            catch (reason) {
                return { reason };
            }
        });
        const results = new Array(snapshots.length);
        let next = 0;
        const worker = async () => {
            while (next < snapshots.length) {
                const index = next++;
                const item = snapshots[index];
                if ('reason' in item) {
                    results[index] = { status: 'rejected', reason: item.reason };
                    continue;
                }
                const linked = linkAbortSignals(signal, item.request.signal);
                try {
                    checkSignal(linked.signal);
                    results[index] = {
                        status: 'fulfilled',
                        value: await this.toBlob(item.input, { ...item.request, signal: linked.signal }, item.options),
                    };
                }
                catch (reason) {
                    results[index] = { status: 'rejected', reason };
                }
                finally {
                    linked.dispose();
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
        return results;
    }
}
