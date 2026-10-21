type SchedulerLike = {
    setImmediate?: (fn: () => void) => unknown;
};
const yieldWaiters: Array<() => void> = [];
let yieldChannel: MessageChannel | null = null;

/**
 * Resolves in a later macrotask so pending tasks run first: setImmediate, else a MessageChannel,
 * and a timer only where neither exists. scheduler.yield() is deliberately not used: its
 * continuation runs ahead of other same-priority tasks, so a loop waiting for codec dequeue or
 * output callbacks would starve them and never return.
 */
export function yieldEventLoop(): Promise<void> {
    const g = globalThis as SchedulerLike;
    if (typeof g.setImmediate === 'function') {
        return new Promise(resolve => g.setImmediate!(resolve));
    }
    if (typeof MessageChannel !== 'undefined') {
        if (!yieldChannel) {
            yieldChannel = new MessageChannel();
            yieldChannel.port1.onmessage = () => {
                yieldWaiters.shift()?.();
            };
        }
        return new Promise(resolve => {
            yieldWaiters.push(resolve);
            yieldChannel!.port2.postMessage(0);
        });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}
