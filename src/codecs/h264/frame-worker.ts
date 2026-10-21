import { ControlBlock, type FrameJob, FrameJobRunner, JOB_QUEUED } from './frame-job';
import { type H264Kernels, kernelImports, type KernelMemory } from './kernels';

/**
 * Messages to a frame worker: `init` binds it to a decoder's shared kernel memory, compiled
 * kernels, scratch block and control block; `job` offers a frame job; `release` drops the decoder
 * once it is closed.
 */
export type FrameWorkerMessage =
    | {
          readonly type: 'init';
          readonly memory: WebAssembly.Memory;
          readonly module: WebAssembly.Module;
          readonly scratch: number;
          readonly control: number;
      }
    | { readonly type: 'job'; readonly job: FrameJob }
    | { readonly type: 'release' };

interface NodeWorkerThreads {
    readonly parentPort: {
        on(event: 'message', listener: (message: FrameWorkerMessage) => void): void;
    } | null;
}

let runner: FrameJobRunner | null = null;
let memory: WebAssembly.Memory | null = null;

/** Jobs offered to this worker that may still be queued, in decoding order. */
const offered: FrameJob[] = [];

/** Runs the first offered job no thread has taken, until none is left. */
function work(active: FrameJobRunner): void {
    const control = active.control;
    for (;;) {
        let index = 0;
        while (index < offered.length && control.state(offered[index].job) !== JOB_QUEUED) index++;
        offered.splice(0, index);
        const job = offered.shift();
        if (!job) return;
        if (control.claim(job.job)) active.run(job);
    }
}

function bind(
    shared: WebAssembly.Memory,
    module: WebAssembly.Module,
    scratch: number,
    control: number,
): void {
    const kernels = new WebAssembly.Instance(module, kernelImports(shared))
        .exports as unknown as H264Kernels;
    let view = new Uint8Array(shared.buffer);
    const kernelMemory: KernelMemory = {
        kernels,
        scratch,
        get buffer() {
            return shared.buffer;
        },
        get bytes() {
            if (view.length !== shared.buffer.byteLength) view = new Uint8Array(shared.buffer);
            return view;
        },
    };
    memory = shared;
    runner = new FrameJobRunner(kernelMemory, new ControlBlock(shared.buffer, control, true));
}

function receive(message: FrameWorkerMessage): void {
    if (message.type !== 'job') {
        offered.length = 0;
        if (message.type === 'init')
            bind(message.memory, message.module, message.scratch, message.control);
        else runner = memory = null;
        return;
    }
    if (!runner) return;
    offered.push(message.job);
    // Views of a shared memory end where it ended when they were made; the decoding thread may have
    // grown it since.
    memory!.grow(0);
    work(runner);
}

const host = globalThis as {
    process?: { getBuiltinModule?(name: string): unknown };
    onmessage?: unknown;
};
const threads = host.process?.getBuiltinModule?.('node:worker_threads') as
    NodeWorkerThreads | undefined;
if (threads?.parentPort) threads.parentPort.on('message', receive);
else host.onmessage = (event: MessageEvent<FrameWorkerMessage>) => receive(event.data);
