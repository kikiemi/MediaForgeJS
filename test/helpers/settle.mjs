// Promise helpers for tests of asynchronous I/O: scripted fetches and responses that settle when
// the test says.

/** Resolves after `ms` milliseconds (0 lets queued tasks run). */
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A promise with its resolve and reject. */
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

/** `promise`, failed if it has not settled within five seconds (room for a loaded machine). */
export async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('test operation did not settle')), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
