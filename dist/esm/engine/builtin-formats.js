import { mp4 } from './formats/mp4.js';
import { matroska } from './formats/matroska.js';
import { ts } from './formats/ts.js';
import { avi } from './formats/avi.js';
import { flv } from './formats/flv.js';
import { audio } from './formats/audio.js';
export const builtinFormats = Object.freeze([mp4, matroska, ts, avi, flv, audio]);
