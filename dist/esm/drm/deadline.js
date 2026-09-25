export function createDeadline(timeoutMs) {
    const now = typeof performance === 'undefined' ? Date.now : performance.now.bind(performance);
    const expires = now() + timeoutMs;
    return () => now() >= expires;
}
