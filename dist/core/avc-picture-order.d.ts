export interface AVCPictureOrder {
    readonly epoch: number;
    readonly poc: number;
    readonly noReordering: boolean;
}
/** H.264 8.2.1 picture order; one complete frame access unit per AVI packet. */
export declare class AVCPictureOrderReader {
    private readonly sequences;
    private readonly parameters;
    private readonly pendingSequences;
    private readonly pendingParameters;
    private picture;
    private epoch;
    private previousFrame;
    private frameOffset;
    private previousLsb;
    private previousMsb;
    beginPacket(): void;
    parameter(nal: Uint8Array, configuration?: boolean): void;
    slice(nal: Uint8Array): void;
    finishPacket(): AVCPictureOrder | undefined;
}
