/**
 * The processing-stage contract: a stage transforms the decoded pictures or sound of one track
 * between the decoder (or the frames an application hands in) and the encoder or picture output.
 * The built-in transforms are stages too.
 */

/** Properties of the pictures flowing between two video stages. */
export interface VideoStreamInfo {
    /** Pixels of every picture. */
    readonly width: number;
    readonly height: number;
    /** Nominal pictures per second, where known. */
    readonly fps?: number;
}

/**
 * One picture between stages, owned by whoever holds it: a stage either emits it (handing it on) or
 * closes it. Timestamps and durations are seconds on the output timeline.
 */
export interface VideoPicture {
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
    readonly duration: number;
    /** The host WebCodecs frame when the picture is one; it stays owned by the picture. */
    readonly frame?: VideoFrame;
    /**
     * Asks the encoder to start a keyframe at this picture, such as the first picture of a new
     * scene.
     */
    readonly keyframe?: boolean;
    /**
     * Straight RGBA8 pixels, width × height × 4 bytes. The array may be shared: copy it before
     * changing it.
     */
    rgba(): Promise<Uint8Array>;
    /** The same pixels shown at another time; the new picture is owned separately. */
    retime(timestamp: number, duration: number): VideoPicture;
    close(): void;
}

/** Hands a picture to the next stage, which then owns it. */
export type EmitPicture = (picture: VideoPicture) => void;

/**
 * A video stage. `process` receives every picture in presentation order and emits zero or more
 * pictures in presentation order; `flush` emits what it still holds at the end of the stream. The
 * chain awaits each call, so a stage may be asynchronous; it closes the stage once, after the last
 * flush or on failure.
 */
export interface VideoStage {
    readonly type: 'video';
    /** Shown in reports, such as 'resize' or 'fps'. */
    readonly name: string;
    /**
     * The stream this stage emits for an input stream; omitted keeps the input's. Called once,
     * before any picture.
     */
    configure?(input: VideoStreamInfo): VideoStreamInfo;
    process(picture: VideoPicture, emit: EmitPicture): void | Promise<void>;
    flush?(emit: EmitPicture): void | Promise<void>;
    close?(): void;
}

/** Properties of the sound flowing between two audio stages. */
export interface AudioStreamInfo {
    readonly sampleRate: number;
    readonly channels: number;
    /**
     * The speakers of the channels as WAVE_FORMAT_EXTENSIBLE bits, one bit a channel, when the
     * source knows them; absent is the common layout of the count. A stage that keeps the channel
     * count keeps the mask unless it states another.
     */
    readonly channelMask?: number;
}

/** Planar float samples of every channel, equally long; the arrays belong to the receiver. */
export type AudioPlanes = readonly Float32Array[];

/** Hands samples to the next stage. */
export type EmitAudio = (planes: AudioPlanes) => void;

/** An audio stage: contiguous blocks of samples in, contiguous blocks out, in order. */
export interface AudioStage {
    readonly type: 'audio';
    readonly name: string;
    configure?(input: AudioStreamInfo): AudioStreamInfo;
    process(planes: AudioPlanes, emit: EmitAudio): void | Promise<void>;
    flush?(emit: EmitAudio): void | Promise<void>;
    close?(): void;
}

/**
 * A stage a plugin offers, or a target names directly. `create` builds a fresh stage for every run
 * (a check and the write are two runs), with the options the target gives.
 *
 * @example
 * ```ts
 * const grey: StageDefinition = {
 *     type: 'video',
 *     name: 'grey',
 *     create: () => ({
 *         type: 'video',
 *         name: 'grey',
 *         async process(picture, emit) {
 *             const data = (await picture.rgba()).slice();
 *             for (let at = 0; at < data.length; at += 4) data[at] = data[at + 2] = data[at + 1]!;
 *             const { width, height, timestamp, duration } = picture;
 *             emit(createPicture({ data, width, height, timestamp, duration }));
 *             picture.close();
 *         },
 *     }),
 * };
 * await convert(file, { to: 'mp4', video: { stages: [grey] } });
 * ```
 */
export interface StageDefinition<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> {
    readonly type: Stage['type'];
    readonly name: string;
    readonly description?: string;
    create(options?: unknown): Stage;
}

/**
 * A stage of a target: a definition, the name of a plugin's stage, or that name with options for
 * `create`.
 */
export type StageRequest<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> =
    StageDefinition<Stage> | string | { readonly name: string; readonly options?: unknown };
