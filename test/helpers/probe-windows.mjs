import { distUrl } from './dist-paths.mjs';

// The probes of large inputs read head and tail windows of 2 MiB growing fourfold to 32 MiB. A test
// file that calls scaleProbeWindows() divides them by PROBE_SCALE for its whole process, so inputs
// of a few megabytes take the paths of inputs of hundreds: described from their ends, copied in one
// pass, read in windows. Byte bounds that follow from the windows are written in probe mebibytes
// (PROBE_MIB); the 1 MiB reads of a pass and the 64 KiB pages of a source's cache do not change.

const { PROBE_WINDOWS } = await import(distUrl('esm/formats/shared/probe-windows.js'));

export const PROBE_SCALE = 4;
export const MiB = 2 ** 20;
/** A mebibyte of the probe windows: 2 of them are the first window, 32 the largest. */
export const PROBE_MIB = MiB / PROBE_SCALE;

const FULL = { ...PROBE_WINDOWS };
const SCALED = { first: 2 * PROBE_MIB, last: 32 * PROBE_MIB };

/** Divides the probe windows by PROBE_SCALE for the rest of the test file's process. */
export function scaleProbeWindows() {
    Object.assign(PROBE_WINDOWS, SCALED);
}

/**
 * Gives the test of context `t` the library's own probe windows, for inputs sized against those,
 * until it ends.
 */
export function atFullScale(t) {
    const scaled = { ...PROBE_WINDOWS };
    Object.assign(PROBE_WINDOWS, FULL);
    t.after(() => Object.assign(PROBE_WINDOWS, scaled));
}
