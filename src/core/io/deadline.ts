export function createDeadline(timeoutMs: number): () => boolean {
    const now = typeof performance === 'undefined' ? Date.now : performance.now.bind(performance);
    const expires = now() + timeoutMs;
    return () => now() >= expires;
}
