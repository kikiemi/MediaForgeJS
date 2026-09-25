export function probeTsLayout(h) {
    let best = null;
    for (const stride of [188, 192, 204]) {
        for (let i = 0; i < Math.min(h.length, 1024); i++) {
            if (h[i] !== 0x47)
                continue;
            let run = 1;
            while (run < 8 && i + run * stride < h.length && h[i + run * stride] === 0x47)
                run++;
            if (run >= 3) {
                if (!best || run > best.run)
                    best = { stride, off: i, run };
                break;
            }
        }
    }
    if (!best)
        return null;
    return { stride: best.stride, off: best.stride === 192 ? Math.max(0, best.off - 4) : best.off };
}
