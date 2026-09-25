import { checkAbort, yieldTask } from './lifetime.js';
import { restoreAlpha16 } from './packet.js';

export function ownedFrame(native, packet, info, timing, config) {
    let data = native.frameData.slice();
    const bitDepth = native.pixelFormat.endsWith('12') ? 12 : 10;
    const alphaBitDepth = info.alpha === 2 ? 16 : info.alpha ? bitDepth : 0;
    const format = info.alpha === 2 ? native.pixelFormat.replace('AP', 'P') + 'A16' : native.pixelFormat;
    const chromaDivisor = native.pixelFormat.includes('422') ? 2 : 1;
    const layout = [];
    let offset = 0;
    for (let plane = 0; plane < (alphaBitDepth ? 4 : 3); plane++) {
        const width = plane === 1 || plane === 2 ? native.codedWidth / chromaDivisor : native.codedWidth;
        layout.push(Object.freeze({ offset, stride: width * 2 }));
        offset += width * native.codedHeight * 2;
    }
    if (offset !== data.length) throw new Error('Unexpected ProRes decoder plane layout');
    if (info.alpha === 2) restoreAlpha16(packet, info, data, layout[3], native.codedWidth, native.codedHeight);
    const frame = {
        get data() {
            if (!data) throw new Error('ProRes frame is closed');
            return data;
        },
        format,
        bitDepth,
        alphaBitDepth,
        originalAlphaBitDepth: info.alpha === 2 ? 16 : info.alpha ? 8 : 0,
        codedWidth: native.codedWidth,
        codedHeight: native.codedHeight,
        visibleWidth: native.visibleWidth,
        visibleHeight: native.visibleHeight,
        displayWidth: native.visibleWidth,
        displayHeight: native.visibleHeight,
        layout: Object.freeze(layout),
        pixelAspectRatio: Object.freeze({ ...native.pixelAspectRatio }),
        colorPrimaries: native.colorPrimaries,
        colorTransfer: native.colorTransfer,
        colorMatrix: native.colorMatrix,
        colorRangeFull: native.colorRangeFull,
        colorSpaceAssumed: native.colorMatrix === 0 || native.colorMatrix === 2,
        scanType: native.scanType,
        timestamp: timing.timestamp,
        duration: timing.duration,
        get closed() {
            return data === null;
        },
        close() {
            data = null;
        },
        async toRGBA(options = {}) {
            checkAbort(options.signal);
            const input = frame.data;
            if (options.allowPrecisionLoss !== true)
                throw new Error('ProRes RGBA8 conversion requires allowPrecisionLoss: true');
            if (![0, 1, 2].includes(frame.colorPrimaries) || ![0, 1, 2, 6].includes(frame.colorTransfer)) {
                throw new Error('ProRes RGBA conversion does not support this color space or HDR transfer');
            }
            const matrix = frame.colorSpaceAssumed ? config.unspecifiedColorMatrix : frame.colorMatrix;
            if (![1, 5, 6].includes(matrix))
                throw new Error('ProRes RGBA conversion does not support this color matrix');
            const kr = matrix === 1 ? 0.2126 : 0.299;
            const kb = matrix === 1 ? 0.0722 : 0.114;
            const kg = 1 - kr - kb;
            const rCr = 2 * (1 - kr);
            const gCb = (2 * kb * (1 - kb)) / kg;
            const gCr = (2 * kr * (1 - kr)) / kg;
            const bCb = 2 * (1 - kb);
            const scale = 2 ** (bitDepth - 8);
            const alphaMax = 2 ** alphaBitDepth - 1;
            const chromaShift = chromaDivisor === 2 ? 1 : 0;
            const [yPlane, cbPlane, crPlane, alphaPlane] = layout;
            const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
            const width = frame.visibleWidth;
            const height = frame.visibleHeight;
            const rgba = new Uint8Array(width * height * 4);
            const clip = value => Math.max(0, Math.min(255, Math.round(value * 255)));
            // Keep the pixel loop synchronous so it can be optimized independently
            // of the async continuation, while still yielding every 64 rows.
            const convertRows = (start, end) => {
                for (let y = start; y < end; y++) {
                    checkAbort(options.signal);
                    const yRow = yPlane.offset + y * yPlane.stride;
                    const cbRow = cbPlane.offset + y * cbPlane.stride;
                    const crRow = crPlane.offset + y * crPlane.stride;
                    const alphaRow = alphaPlane ? alphaPlane.offset + y * alphaPlane.stride : 0;
                    const outputRow = y * width * 4;
                    for (let x = 0; x < width; x++) {
                        const pixelByte = x * 2;
                        const chromaByte = (x >> chromaShift) * 2;
                        const luma = (view.getUint16(yRow + pixelByte, true) / scale - 16) / 219;
                        const cb = (view.getUint16(cbRow + chromaByte, true) / scale - 128) / 224;
                        const cr = (view.getUint16(crRow + chromaByte, true) / scale - 128) / 224;
                        const p = outputRow + x * 4;
                        rgba[p] = clip(luma + rCr * cr);
                        rgba[p + 1] = clip(luma - gCb * cb - gCr * cr);
                        rgba[p + 2] = clip(luma + bCb * cb);
                        rgba[p + 3] = alphaBitDepth
                            ? Math.round((view.getUint16(alphaRow + pixelByte, true) * 255) / alphaMax)
                            : 255;
                    }
                }
            };
            for (let y = 0; y < height; y += 64) {
                convertRows(y, Math.min(height, y + 64));
                if (y + 64 <= height) await yieldTask();
            }
            checkAbort(options.signal);
            return { data: rgba, width, height };
        },
    };
    return frame;
}
