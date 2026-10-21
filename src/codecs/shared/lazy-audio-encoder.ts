const LOAD = Symbol('load audio encoder');

/**
 * Stands for an encoder of StreamingAudioCodecs until the first encoding with it loads it, so the
 * built-in encoders stay out of the initial load. Only createStreamingAudioOutput resolves it,
 * through encoderLoader().
 */
export function lazyAudioEncoder<T>(load: () => Promise<T>): T {
    return Object.freeze({ [LOAD]: load }) as unknown as T;
}

/** The loader of a lazyAudioEncoder() placeholder; undefined for a loaded encoder. */
export function encoderLoader(entry: unknown): (() => Promise<never>) | undefined {
    return entry && typeof entry === 'object'
        ? (entry as { readonly [LOAD]?: () => Promise<never> })[LOAD]
        : undefined;
}
