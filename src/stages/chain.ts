import { MediaForgeError, errorMessage } from '../core/errors/errors';
import { layoutMask } from '../core/model/channel-layout';
import type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';
import type {
    AudioPlanes,
    AudioStage,
    AudioStreamInfo,
    VideoPicture,
    VideoStage,
    VideoStreamInfo,
} from '../core/contracts/stage';
import { pictureOf, type Picture } from './picture';

/**
 * A stage's own failure as ENCODE, naming the stage; library errors and aborts keep their identity.
 */
function stageFailure(name: string, error: unknown): unknown {
    if (
        error instanceof MediaForgeError ||
        (error instanceof DOMException && error.name === 'AbortError')
    )
        return error;
    return new MediaForgeError(`Stage '${name}' failed: ${errorMessage(error)}`, 'ENCODE');
}

/** Receives a warning code and message, such as STAGE_CLOSE_FAILED. */
export type StageWarn = (code: string, message: string) => void;

/**
 * Closes every stage once. A failing close does not stop the others, and since the outcome of the
 * run stands it is reported as STAGE_CLOSE_FAILED rather than thrown.
 */
function closeStages(
    stages: readonly (VideoStage | AudioStage)[],
    warn: StageWarn | undefined,
): void {
    for (const stage of stages) {
        try {
            stage.close?.();
        } catch (error) {
            warn?.(
                'STAGE_CLOSE_FAILED',
                `Stage '${stage.name}' cleanup failed: ${errorMessage(error)}`,
            );
        }
    }
}

/** Builds a stage for one run; every run creates its own, so stage state never crosses runs. */
export interface StageFactory<Stage extends VideoStage | AudioStage> {
    /** The stage's name, for reports. */
    readonly name: string;
    create(): Stage;
}

/** Creates one run's stages, checking each is a stage of `type`. */
export function createStages<Stage extends VideoStage | AudioStage>(
    type: Stage['type'],
    factories: readonly StageFactory<Stage>[] = [],
): Stage[] {
    return factories.map(factory => {
        const stage = factory.create();
        if (
            !stage ||
            stage.type !== type ||
            typeof stage.name !== 'string' ||
            !stage.name ||
            typeof stage.process !== 'function'
        )
            throw new MediaForgeError(
                `A ${type} stage needs type '${type}', a name and process()`,
                'INPUT',
            );
        return stage;
    });
}

function checkVideoInfo(name: string, info: VideoStreamInfo): VideoStreamInfo {
    const { width, height, fps } = info ?? ({} as VideoStreamInfo);
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        (fps !== undefined && !(Number.isFinite(fps) && fps > 0))
    )
        throw new MediaForgeError(`Stage '${name}' configured an invalid video stream`, 'INPUT');
    return { width, height, ...(fps !== undefined ? { fps } : {}) };
}

/**
 * The stream a stage configured, checked; its speaker mask is the one it states, else the input's
 * while the channel count holds, and a mask that does not fit the count is dropped.
 */
function checkAudioInfo(
    name: string,
    info: AudioStreamInfo,
    input?: AudioStreamInfo,
): AudioStreamInfo {
    const { sampleRate, channels } = info ?? ({} as AudioStreamInfo);
    if (
        !Number.isInteger(sampleRate) ||
        sampleRate < 1 ||
        sampleRate > 768000 ||
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 8
    )
        throw new MediaForgeError(`Stage '${name}' configured an invalid audio stream`, 'INPUT');
    const mask = info.channelMask ?? (input?.channels === channels ? input.channelMask : undefined);
    return mask !== undefined && layoutMask(channels, mask) === mask
        ? { sampleRate, channels, channelMask: mask }
        : { sampleRate, channels };
}

/**
 * Runs pictures through video stages in order into `sink`, one picture at a time: each picture a
 * stage emits goes through the rest of the chain before the stage's next output. Pictures handed to
 * the chain belong to it.
 */
export class VideoStageChain {
    /** The stream the last stage emits. */
    readonly output: VideoStreamInfo;
    /** The stream each stage declared it emits. */
    private readonly declared: VideoStreamInfo[] = [];
    private closed = false;

    constructor(
        private readonly stages: readonly VideoStage[],
        input: VideoStreamInfo,
        private readonly sink: (picture: Picture) => void | Promise<void>,
        private readonly warn?: StageWarn,
    ) {
        let info = checkVideoInfo('input', input);
        for (const stage of stages) {
            try {
                if (stage.configure) info = checkVideoInfo(stage.name, stage.configure(info));
            } catch (error) {
                throw stageFailure(stage.name, error);
            }
            this.declared.push(info);
        }
        this.output = info;
    }

    /** Stage names in order, for reports. */
    get names(): readonly string[] {
        return this.stages.map(stage => stage.name);
    }

    push(picture: Picture): Promise<void> {
        return this.run(0, picture);
    }

    /** Flushes every stage in order; what a stage still held passes through the stages after it. */
    async finish(): Promise<void> {
        for (let index = 0; index < this.stages.length; index++) {
            const stage = this.stages[index]!;
            if (!stage.flush) continue;
            await this.forward(index, emit => stage.flush!(emit));
        }
    }

    private async run(index: number, picture: Picture): Promise<void> {
        if (this.closed) {
            picture.close();
            throw new MediaForgeError('The stage chain is closed', 'ABORT');
        }
        if (index === this.stages.length) return this.sink(picture);
        const stage = this.stages[index]!;
        try {
            await this.forward(index, emit => stage.process(picture, emit));
        } catch (error) {
            // A failed run releases the picture whatever the stage did with it; closing is
            // idempotent.
            picture.close();
            throw error;
        }
    }

    /**
     * Collects what stage `index` emits during `step` and runs each picture through the following
     * stages.
     */
    private async forward(
        index: number,
        step: (emit: (picture: VideoPicture) => void) => void | Promise<void>,
    ): Promise<void> {
        const stage = this.stages[index]!;
        const emitted: Picture[] = [];
        let open = true;

        const emit = (picture: VideoPicture): void => {
            const owned = pictureOf(picture);
            if (!open) {
                owned.close();
                throw new MediaForgeError(
                    `Stage '${stage.name}' emitted after its call returned`,
                    'INPUT',
                );
            }
            if (
                !Number.isFinite(owned.timestamp) ||
                !Number.isFinite(owned.duration) ||
                owned.duration < 0
            ) {
                owned.close();
                throw new MediaForgeError(
                    `Stage '${stage.name}' emitted a picture without finite timing`,
                    'INPUT',
                );
            }

            const { width, height } = this.declared[index]!;
            if (owned.width !== width || owned.height !== height) {
                owned.close();
                throw new MediaForgeError(
                    `Stage '${stage.name}' emitted a picture of another size`,
                    'INPUT',
                    { hint: 'Return the output size from configure() when a stage changes it.' },
                );
            }

            emitted.push(owned);
        };

        try {
            await step(emit);
        } catch (error) {
            for (const picture of emitted) picture.close();
            throw stageFailure(stage.name, error);
        } finally {
            open = false;
        }

        for (let at = 0; at < emitted.length; at++) {
            try {
                await this.run(index + 1, emitted[at]!);
            } catch (error) {
                for (const rest of emitted.slice(at + 1)) rest.close();
                throw error;
            }
        }
    }

    /** Closes every stage once; a failing close does not stop the others and is reported. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        closeStages(this.stages, this.warn);
    }
}

/** Runs sample blocks through audio stages in order into `sink`. */
export class AudioStageChain {
    readonly output: AudioStreamInfo;
    /** The channel count each stage declared it emits. */
    private readonly channels: number[] = [];
    private closed = false;

    constructor(
        private readonly stages: readonly AudioStage[],
        input: AudioStreamInfo,
        private readonly sink: (planes: AudioPlanes) => void | Promise<void>,
        private readonly warn?: StageWarn,
    ) {
        let info = checkAudioInfo('input', input);
        for (const stage of stages) {
            try {
                if (stage.configure) info = checkAudioInfo(stage.name, stage.configure(info), info);
            } catch (error) {
                throw stageFailure(stage.name, error);
            }
            this.channels.push(info.channels);
        }
        this.output = info;
    }

    push(planes: AudioPlanes): Promise<void> {
        return this.run(0, planes);
    }

    async finish(): Promise<void> {
        for (let index = 0; index < this.stages.length; index++) {
            const stage = this.stages[index]!;
            if (stage.flush) await this.forward(index, emit => stage.flush!(emit));
        }
    }

    private async run(index: number, planes: AudioPlanes): Promise<void> {
        if (this.closed) throw new MediaForgeError('The stage chain is closed', 'ABORT');
        if (index === this.stages.length) {
            if (planes[0]?.length) await this.sink(planes);
            return;
        }
        const stage = this.stages[index]!;
        await this.forward(index, emit => stage.process(planes, emit));
    }

    private async forward(
        index: number,
        step: (emit: (planes: AudioPlanes) => void) => void | Promise<void>,
    ): Promise<void> {
        const stage = this.stages[index]!;
        const emitted: AudioPlanes[] = [];
        let open = true;

        try {
            await step(planes => {
                if (!open)
                    throw new MediaForgeError(
                        `Stage '${stage.name}' emitted after its call returned`,
                        'INPUT',
                    );
                if (
                    !Array.isArray(planes) ||
                    planes.length !== this.channels[index] ||
                    planes.some(
                        plane =>
                            !(plane instanceof Float32Array) || plane.length !== planes[0]!.length,
                    )
                )
                    throw new MediaForgeError(
                        `Stage '${stage.name}' emitted planes of the wrong count or length`,
                        'INPUT',
                    );
                emitted.push(planes);
            });
        } catch (error) {
            throw stageFailure(stage.name, error);
        } finally {
            open = false;
        }

        for (const planes of emitted) await this.run(index + 1, planes);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        closeStages(this.stages, this.warn);
    }
}

/** The stream `source` holds, its speaker mask with it, as the first stage receives it. */
export function streamOf(source: {
    readonly sampleRate: number;
    readonly channels: number;
    readonly channelMask?: number;
}): AudioStreamInfo {
    const { sampleRate, channels, channelMask } = source;
    return channelMask !== undefined
        ? { sampleRate, channels, channelMask }
        : { sampleRate, channels };
}

/**
 * The sound of `source` through stage chains, the one way audio stages run over a source: each read
 * runs the chain `open` returns for it, which hands what it emits to the sink it is given, over the
 * source from its start. `output` is what the chains emit (rate, channels, speaker mask), and
 * `estimatedFrames` scales with its rate.
 */
export function chainedPcmSource(
    source: ReplayablePcmSource,
    output: AudioStreamInfo,
    open: (sink: (planes: AudioPlanes) => void) => AudioStageChain,
): ReplayablePcmSource {
    return {
        sampleRate: output.sampleRate,
        channels: output.channels,
        estimatedFrames: Math.max(
            1,
            Math.round((source.estimatedFrames * output.sampleRate) / source.sampleRate),
        ),
        ...(output.channelMask !== undefined ? { channelMask: output.channelMask } : {}),
        async *chunks(signal) {
            const ready: AudioPlanes[] = [];
            const chain = open(planes => {
                ready.push(planes);
            });
            try {
                for await (const planes of source.chunks(signal)) {
                    await chain.push(planes);
                    yield* ready.splice(0);
                }
                await chain.finish();
                yield* ready.splice(0);
            } finally {
                chain.close();
            }
        },
    };
}

/**
 * The sound of `source` after audio stages, as a replayable source: every replay builds fresh
 * stages with `create` and runs the source through them from the start.
 */
export function stagedPcmSource(
    source: ReplayablePcmSource,
    factories: readonly StageFactory<AudioStage>[],
    warn?: StageWarn,
): ReplayablePcmSource {
    if (!factories.length) return source;
    const create = (): AudioStage[] => createStages('audio', factories);
    const probe = new AudioStageChain(create(), streamOf(source), () => {}, warn);
    probe.close();
    return chainedPcmSource(
        source,
        probe.output,
        sink => new AudioStageChain(create(), streamOf(source), sink, warn),
    );
}
