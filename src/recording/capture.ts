import { MediaForgeError } from '../core/errors/errors';
import { frameReader, type PcmBlock, type Pull } from './frame-streams';

/**
 * Readers over the tracks of a MediaStream; `audio` is missing when the browser cannot read its
 * sound.
 */
export interface CapturedStream {
    readonly video?: Pull<VideoFrame>;
    readonly audio?: Pull<AudioData | PcmBlock>;
    /** True when the stream has an audio track this browser cannot read. */
    readonly audioUnavailable: boolean;
}

/**
 * Readers over the first video and audio track of `stream`: MediaStreamTrackProcessor where the
 * browser has it, otherwise a playing video element and a Web Audio script processor. `withAudio`
 * false leaves the audio unread.
 */
export function captureStream(stream: MediaStream, withAudio: boolean): CapturedStream {
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = withAudio ? stream.getAudioTracks() : [];
    const processor = (
        globalThis as {
            MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
                readable: ReadableStream;
            };
        }
    ).MediaStreamTrackProcessor;

    if (processor)
        return {
            video:
                videoTrack &&
                frameReader(
                    new processor({ track: videoTrack }).readable as ReadableStream<VideoFrame>,
                ),
            audio:
                audioTrack &&
                frameReader(
                    new processor({ track: audioTrack }).readable as ReadableStream<AudioData>,
                ),
            audioUnavailable: false,
        };

    const video = videoTrack && frameReader(elementFrames(videoTrack));
    const blocks = audioTrack && contextBlocks(audioTrack);
    return {
        video,
        audio: blocks && frameReader(blocks),
        audioUnavailable: audioTrack !== undefined && !blocks,
    };
}

/**
 * Pictures of a video track drawn from a playing video element, for browsers without
 * MediaStreamTrackProcessor.
 */
function elementFrames(track: MediaStreamTrack): ReadableStream<VideoFrame> {
    if (typeof document === 'undefined' || typeof VideoFrame !== 'function')
        throw new MediaForgeError('Recording video needs WebCodecs and a document', 'ENCODE', {
            hint: 'Record in a browser page with WebCodecs.',
        });

    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.srcObject = new MediaStream([track]);

    let stopped = false;
    const finish = (): void => {
        stopped = true;
        element.pause();
        element.srcObject = null;
    };

    return new ReadableStream<VideoFrame>(
        {
            async start(controller) {
                await element.play();
                const step = (): void => {
                    if (stopped) return;
                    if (track.readyState === 'ended') {
                        finish();
                        controller.close();
                        return;
                    }
                    if ((controller.desiredSize ?? 1) > 0 && element.videoWidth > 0)
                        controller.enqueue(
                            new VideoFrame(element, {
                                timestamp: Math.round(performance.now() * 1000),
                            }),
                        );
                    schedule();
                };

                const schedule = (): void => {
                    const callback = (
                        element as HTMLVideoElement & {
                            requestVideoFrameCallback?: (callback: () => void) => number;
                        }
                    ).requestVideoFrameCallback;
                    if (typeof callback === 'function') callback.call(element, step);
                    else requestAnimationFrame(step);
                };

                schedule();
            },
            cancel: finish,
        },
        { highWaterMark: 4 },
    );
}

/**
 * Blocks of an audio track through a Web Audio script processor, for browsers without
 * MediaStreamTrackProcessor.
 */
function contextBlocks(track: MediaStreamTrack): ReadableStream<PcmBlock> | undefined {
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (typeof Context !== 'function') return undefined;

    let context: AudioContext | undefined;
    let finish = (): void => {};

    return new ReadableStream<PcmBlock>({
        start(controller) {
            context = new Context();
            const input = context.createMediaStreamSource(new MediaStream([track]));
            const channels = Math.max(1, Math.min(2, input.channelCount || 2));
            const node = context.createScriptProcessor(4096, channels, channels);

            const silent = context.createGain();
            silent.gain.value = 0;

            input.connect(node);
            node.connect(silent);
            silent.connect(context.destination);

            node.onaudioprocess = event => {
                const frames = event.inputBuffer.length;
                const planes = Array.from({ length: channels }, (_, channel) =>
                    event.inputBuffer
                        .getChannelData(Math.min(channel, event.inputBuffer.numberOfChannels - 1))
                        .slice(),
                );
                controller.enqueue({
                    planes,
                    sampleRate: event.inputBuffer.sampleRate,
                    timestamp: Math.round(
                        performance.now() * 1000 - (frames / event.inputBuffer.sampleRate) * 1e6,
                    ),
                });
            };

            finish = () => {
                node.onaudioprocess = null;
                input.disconnect();
                node.disconnect();
                silent.disconnect();
                void context?.close();
            };

            track.addEventListener('ended', () => {
                finish();
                try {
                    controller.close();
                } catch {}
            });
        },
        cancel: () => finish(),
    });
}
