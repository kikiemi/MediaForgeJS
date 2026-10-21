/**
 * Motion JPEG: each packet is a whole JPEG picture (two fields of an interlaced capture in one
 * packet).
 */
export const MJPEG_VIDEO = 'mjpeg';

/** The FourCC written for Motion JPEG in AVI and VfW tracks, as ffmpeg writes it. */
export const MJPEG_WRITE_FOURCC = 'MJPG';

/** MPEG-4 systems objectTypeIndication of JPEG pictures ('mp4v' sample entries of MP4 files). */
export const MJPEG_OBJECT_TYPE = 0x6c;

/** QuickTime's sample entry type for Motion JPEG (Photo-JPEG), as ffmpeg writes it in MOV. */
export const MJPEG_QUICKTIME_ENTRY = 'jpeg';
