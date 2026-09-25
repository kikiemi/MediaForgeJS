import { MediaForgeError } from '../core/errors.js';
const states = new WeakMap();
export function bindMediaFileState(file, state) {
    states.set(file, state);
}
export function forgetMediaFileState(file) {
    states.delete(file);
}
export function mediaFileState(file) {
    const state = states.get(file);
    if (!state || state.signal.aborted)
        throw new MediaForgeError('Media file is closed', 'ABORT');
    return state;
}
