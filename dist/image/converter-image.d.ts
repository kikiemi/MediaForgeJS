import type { MediaForgeJSConfig } from '../core/converter-config.js';
import type { ContainerFormat } from '../types/media.js';
export interface ConverterImageHost {
    detectFormat(file: File | Blob): Promise<ContainerFormat>;
}
/** Still/animated image and video-frame capture responsibilities for the converter. */
export declare class ConverterImage {
    private readonly config;
    private readonly host;
    constructor(config: MediaForgeJSConfig, host: ConverterImageHost);
    convertImage(file: File | Blob, format?: ContainerFormat): Promise<Blob>;
    private reportProgress;
    private bitmap;
    private finishCanvas;
    private finishImage;
    private encodeCanvas;
    private convertAnimatedImage;
    videoToImage(file: File | Blob, format: ContainerFormat): Promise<Blob>;
    assertAnimatedImageBudget(totalFrames: number, width: number, height: number, format: string): void;
    private videoToAnimatedImage;
    private seekVideo;
    private waitForVideo;
}
