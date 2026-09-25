export interface AnimatedFrame {
    rgba: Uint8ClampedArray;
    delayMs: number;
}
export interface AnimatedImage {
    width: number;
    height: number;
    frames: AnimatedFrame[];
    /** Total animation plays; zero means infinite. */
    loopCount: number;
}
export declare function decodeAnimatedGif(bytes: Uint8Array, maxTotalPixels: number, signal?: AbortSignal): Promise<AnimatedImage>;
export declare function decodeApng(bytes: Uint8Array, maxTotalPixels: number, signal?: AbortSignal): Promise<AnimatedImage>;
export declare function scaleRgbaNearest(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray;
