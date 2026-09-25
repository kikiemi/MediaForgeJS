import { mediaFileState } from '../engine/file-state.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { assertSink } from '../io/sink-backpressure.js';
import { MemorySink } from '../io/sinks.js';
import { createValidationSink } from '../io/validation-sink.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { audioPlan } from './audio-plan.js';
import { checkSignal, outputLimit, snapshotRequest } from './requests.js';
import { snapshotAudio, snapshotDecoder, snapshotTransform } from './modules.js';
import { executeWithSink } from './execution.js';
import { outputStream, snapshotStreamOptions } from './output-stream.js';
import { withOutputLimit } from './output-sink.js';
export class MediaJob {
    busy = false;
    currentFile;
    audio;
    audioDecoder;
    transform;
    constructor(file, audio, audioDecoder, transform) {
        mediaFileState(file);
        this.currentFile = file;
        this.audio = snapshotAudio(audio);
        this.audioDecoder = snapshotDecoder(audioDecoder);
        this.transform = snapshotTransform(transform);
    }
    get file() {
        if (!this.currentFile)
            throw new MediaForgeError('Media job is closed', 'ABORT');
        return this.currentFile;
    }
    acquire() {
        if (this.busy)
            throw new MediaForgeError('This media job already has an operation in progress', 'INPUT');
        this.busy = true;
    }
    inspect() {
        const file = this.file;
        mediaFileState(file);
        return { format: file.format, title: file.title, tracks: file.tracks, warnings: file.warnings };
    }
    diagnostics() {
        const state = mediaFileState(this.file);
        return new DiagnosticContext({
            validation: state.diagnostics.validation,
            metadataPolicy: state.diagnostics.metadataPolicy,
        });
    }
    failure(error, diagnostics) {
        if (!(error instanceof MediaForgeError))
            throw error;
        return { supported: false, code: error.code, reason: error.message, warnings: diagnostics?.warnings ?? [] };
    }
    probe(request) {
        let acquired = false;
        let diagnostics;
        try {
            this.acquire();
            acquired = true;
            const snapshot = snapshotRequest(request);
            diagnostics = this.diagnostics();
            if (snapshot.operation === 'remux') {
                const support = this.file.checkRemux({ ...snapshot, onProgress: undefined });
                return support.supported ? { ...support, operation: 'remux' } : support;
            }
            if (snapshot.operation === 'convert') {
                if (!this.transform)
                    throw new MediaForgeError('Native video transform is not installed', 'FORMAT');
                return this.transform.probe(this.file, { ...snapshot, onProgress: undefined }, diagnostics);
            }
            return audioPlan(this.file, { ...snapshot, onProgress: undefined }, diagnostics, this.audio, this.audioDecoder).support;
        }
        catch (error) {
            return this.failure(error, diagnostics);
        }
        finally {
            if (acquired)
                this.busy = false;
        }
    }
    async check(request, options = {}) {
        let acquired = false;
        let diagnostics;
        try {
            this.acquire();
            acquired = true;
            const maxBytes = outputLimit(options, Number.MAX_SAFE_INTEGER);
            const snapshot = snapshotRequest(request);
            diagnostics = this.diagnostics();
            if (snapshot.operation === 'remux') {
                const support = await this.file.validateRemux({ ...snapshot, onProgress: undefined }, { maxBytes });
                return support.supported ? { ...support, operation: 'remux' } : support;
            }
            return await this.execute(createValidationSink(maxBytes), { ...snapshot, onProgress: undefined }, diagnostics, true);
        }
        catch (error) {
            return this.failure(error, diagnostics);
        }
        finally {
            if (acquired)
                this.busy = false;
        }
    }
    async write(sink, request, options = {}) {
        this.acquire();
        try {
            assertSink(sink);
            const maxBytes = outputLimit(options, Number.MAX_SAFE_INTEGER);
            await this.execute(withOutputLimit(sink, maxBytes), snapshotRequest(request));
        }
        finally {
            this.busy = false;
        }
    }
    async execute(sink, request, diagnostics = this.diagnostics(), silent = false) {
        checkSignal(sink.signal);
        const file = this.file;
        const state = mediaFileState(file);
        if (request.operation === 'remux') {
            const total = state.tracks
                .filter(track => !Array.isArray(request.trackIds) || request.trackIds.includes(track.description.id))
                .reduce((sum, track) => sum + track.description.sampleCount, 0);
            await file.remux(sink, {
                ...request,
                onProgress: request.onProgress
                    ? progress => request.onProgress({
                        ...progress,
                        fraction: Math.min(1, progress.packets / Math.max(1, total)),
                    })
                    : undefined,
            });
            return {
                supported: true,
                operation: 'remux',
                outputFormat: request.format,
                layout: 'standard',
                warnings: [],
            };
        }
        const plan = request.operation === 'audio'
            ? audioPlan(file, request, diagnostics, this.audio, this.audioDecoder)
            : undefined;
        if (request.operation === 'convert' && !this.transform)
            throw new MediaForgeError('Native video transform is not installed', 'FORMAT');
        const support = plan?.support ??
            this.transform.probe(file, request, diagnostics);
        return executeWithSink(sink, [state.signal, request.signal], async (output, signal, invoke) => {
            if (!silent)
                for (const warning of diagnostics.warnings)
                    invoke(() => state.diagnostics.warn(warning));
            const onProgress = !silent && request.onProgress
                ? (progress) => invoke(() => request.onProgress(progress))
                : undefined;
            if (request.operation === 'audio')
                await this.audio.encode(plan.source, output, {
                    ...plan.config,
                    signal,
                    onProgress: onProgress ? (fraction, message) => onProgress({ fraction, message }) : undefined,
                });
            else {
                let delivering = false;
                const active = new DiagnosticContext({
                    validation: diagnostics.validation,
                    metadataPolicy: diagnostics.metadataPolicy,
                    onWarning: warning => {
                        if (!delivering)
                            return;
                        diagnostics.warn(warning);
                        if (!silent)
                            invoke(() => state.diagnostics.warn(warning));
                    },
                });
                for (const warning of diagnostics.warnings)
                    active.warn(warning);
                delivering = true;
                await this.transform.write(file, output, { ...request, signal, onProgress }, active);
            }
            return { ...support, warnings: diagnostics.warnings };
        });
    }
    async toBlob(request, options = {}) {
        this.acquire();
        try {
            const maxBytes = outputLimit(options);
            const snapshot = snapshotRequest(request);
            const sink = new MemorySink({ maxBytes });
            await this.execute(sink, snapshot);
            return sink.toBlob(snapshot.format === 'fmp4'
                ? 'video/mp4'
                : DemuxerRegistry.getMimeType(snapshot.format));
        }
        finally {
            this.busy = false;
        }
    }
    toReadableStream(request, options = {}) {
        this.acquire();
        try {
            const snapshot = snapshotRequest(request);
            const streamOptions = snapshotStreamOptions(options);
            return outputStream(async (sink) => {
                try {
                    await this.execute(sink, snapshot);
                }
                finally {
                    this.busy = false;
                }
            }, streamOptions);
        }
        catch (error) {
            this.busy = false;
            throw error;
        }
    }
    segments(options = {}) {
        this.acquire();
        let iterator;
        try {
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new MediaForgeError('Expected segment options', 'INPUT');
            const { trackIds, targetDuration, maxBufferedBytes, maxBufferedSamples, requireKeyframe, signal } = options;
            iterator = this.file.segments({
                trackIds: Array.isArray(trackIds) ? trackIds.slice() : trackIds,
                targetDuration,
                maxBufferedBytes,
                maxBufferedSamples,
                requireKeyframe,
                signal,
            });
        }
        finally {
            this.busy = false;
        }
        const job = this;
        return (async function* () {
            job.acquire();
            try {
                yield* iterator;
            }
            finally {
                job.busy = false;
            }
        })();
    }
    close() {
        const file = this.currentFile;
        this.currentFile = undefined;
        file?.close();
    }
}
