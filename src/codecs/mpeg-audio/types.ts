/** The options of the streaming MPEG audio encoders. */
export interface MpegAudioEncodeOptions {
    /** MP3 only: variable bitrate around the bitrate, with a seek table in the Info frame. */
    readonly vbr?: boolean;
    /** Called after each encoded frame, with the frames expected in all. */
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
    readonly signal?: AbortSignal;
}
