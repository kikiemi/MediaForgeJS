/**
 * One implementation fetched on first use: every caller of `load` shares one fetch, and a fetch
 * that fails is tried again by the next call.
 */
export function lazy<T>(fetch: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () =>
        (pending ??= Promise.resolve()
            .then(fetch)
            .catch(error => {
                pending = undefined;
                throw error;
            }));
}
