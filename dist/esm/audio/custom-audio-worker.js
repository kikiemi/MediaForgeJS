import { encodeMP2Async } from './mp2-encoder.js';
import { encodeFlacAsync } from './flac-encoder.js';
import { encodeAacLc, wrapAdts } from './aac-encoder.js';
import { encodeMP3Async } from './mp3-encoder.js';
const workerScope = self;
function createProgressReporter(jobId) {
    let lastReported = -64;
    return progress => {
        if (progress.completedFrames - lastReported < 64 && progress.completedFrames !== progress.totalFrames) {
            return;
        }
        lastReported = progress.completedFrames;
        const message = {
            kind: 'progress',
            jobId,
            progress,
        };
        workerScope.postMessage(message);
    };
}
async function encodeRequest(message) {
    const { jobId, request } = message;
    const encodeOptions = {
        onProgress: createProgressReporter(jobId),
    };
    let encodedBuffer;
    if (request.format === 'aac') {
        const result = encodeAacLc(request.pcm, request.sampleRate, request.channels, request.bitrate, {
            onProgress: (completedFrames, totalFrames) => {
                encodeOptions.onProgress?.({ completedFrames, totalFrames });
            },
        });
        encodedBuffer = wrapAdts(result).buffer;
    }
    else if (request.format === 'flac') {
        const flac = await encodeFlacAsync(request.pcm, request.sampleRate, request.channels, {
            onProgress: (completedFrames, totalFrames) => {
                encodeOptions.onProgress?.({ completedFrames, totalFrames });
            },
        });
        encodedBuffer = flac.buffer;
    }
    else {
        const encoded = request.format === 'mp3'
            ? await encodeMP3Async(request.pcm, request.sampleRate, request.channels, request.bitrate, request.vbr ? { ...encodeOptions, vbr: true } : encodeOptions)
            : await encodeMP2Async(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions);
        encodedBuffer = await encoded.arrayBuffer();
    }
    const resultMessage = {
        kind: 'result',
        jobId,
        data: encodedBuffer,
    };
    workerScope.postMessage(resultMessage, [encodedBuffer]);
}
workerScope.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.kind !== 'encode')
        return;
    void encodeRequest(message).catch((error) => {
        const errorMessage = {
            kind: 'error',
            jobId: message.jobId,
            errorMessage: error instanceof Error ? error.message : String(error),
        };
        workerScope.postMessage(errorMessage);
    });
});
const readyMessage = { kind: 'ready' };
workerScope.postMessage(readyMessage);
