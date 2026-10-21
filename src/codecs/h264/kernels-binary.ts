declare const __MEDIAFORGE_H264_KERNELS__: string;

/**
 * The SIMD kernel module of scripts/h264-kernels.mjs, deflated (raw DEFLATE) and in base64, filled
 * in by the build; empty in unbuilt sources.
 */
export const H264_KERNELS_BASE64 =
    typeof __MEDIAFORGE_H264_KERNELS__ === 'string' ? __MEDIAFORGE_H264_KERNELS__ : '';
