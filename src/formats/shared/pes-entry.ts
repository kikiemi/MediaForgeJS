/** A PES packet of one elementary stream: its times, payload and where it starts in the input. */
export interface PesEntry {
    pts: number;
    dts: number;
    /** The PES header carried PTS/DTS; pts and dts are 0 otherwise. */
    timed: boolean;
    data: Uint8Array;
    /** Program timeline segment of the PES timestamps. */
    segment: number;
    discontinuity?: boolean;
    incomplete?: boolean;
    /** Stride position of the transport packet that starts the PES. */
    pos: number;
    /**
     * Elementary-stream bytes of that PES before `data`; a joined access unit may begin in an
     * earlier PES.
     */
    skip: number;
    /**
     * No resynchronization touched the PES, so its bytes can be read again from the transport
     * packets.
     */
    clean: boolean;
    /** The NAL units of `data`, once an access unit's have been split. */
    nals?: readonly Uint8Array[];
}

export const MAX_PES_BYTES = 64 * 1024 * 1024;
