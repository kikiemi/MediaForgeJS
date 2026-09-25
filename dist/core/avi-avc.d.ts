import type { ByteReader } from '../io/chunk-reader.js';
import { type AVCPictureOrder } from './avc-picture-order.js';
export declare const MAX_AVI_AVC_CONFIG_BYTES: number;
interface AVCInspection {
    isKeyframe: boolean;
    annexB: boolean;
    parameters: Uint8Array[];
    parameterBytes: number;
    pictureOrder?: AVCPictureOrder;
}
export declare class AVIAVCReader {
    codecConfig: Uint8Array | undefined;
    private lengthSize;
    private readonly prefersLengths;
    private parameters;
    private parameterBytes;
    private readonly order;
    constructor(extra?: Uint8Array);
    get codec(): string | undefined;
    inspect(reader: ByteReader, start: number, size: number, checkAbort: () => void): Promise<AVCInspection>;
    private validateConfiguration;
    private inspectLengths;
    private inspectAnnexB;
    private nalType;
    private readNal;
    private readParameter;
}
export {};
