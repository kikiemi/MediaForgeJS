/** Bounded coefficient tables persist; pixel row scratch belongs to one frame. */
export declare class LanczosResizer {
    private readonly sourceWidth;
    private readonly sourceHeight;
    private readonly width;
    private readonly height;
    private first?;
    private second?;
    constructor(sourceWidth: number, sourceHeight: number, width: number, height: number);
    resize(source: Uint8ClampedArray): Generator<void, Uint8ClampedArray>;
}
