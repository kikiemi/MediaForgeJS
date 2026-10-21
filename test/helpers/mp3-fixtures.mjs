// MP3 fixtures produced by ffmpeg 6.1.1 (libmp3lame 3.100) from a deterministic two-tone signal
// (toneSignal below):
//   ffmpeg -i tone.wav -c:a libmp3lame -ar <sampleRate> <arguments> <name>.mp3
// Each entry also carries 1024 frames of ffmpeg's own float decode (-f f32le), quantized to int16,
// starting at presentation frame 2048, so the built-in decoder is checked against an independent
// implementation offline.

function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/**
 * The signal encoded into every fixture: 440 + 1760 Hz left, 660 + 2640 Hz right, written as 16-bit
 * WAV.
 */
export function toneSignal(rate, channels, frames) {
    const planes = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
        const t = i / rate;
        planes[0][i] =
            0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 1760 * t);
        if (channels > 1)
            planes[1][i] =
                0.3 * Math.sin(2 * Math.PI * 660 * t) + 0.15 * Math.sin(2 * Math.PI * 2640 * t);
    }
    return planes;
}

export const MP3_FIXTURES = Object.freeze([
    {
        name: 'mpeg1-44100-joint-64k',
        arguments: '-b:a 64k',
        sampleRate: 44100,
        channels: 2,
        sampleFrames: 44100,
        referenceStart: 2048,
        referenceFrames: 1024,
        bytes: () =>
            base64Bytes(
                'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAoAAAhdwAMDBISGBgYHx8lJSUrKz' +
                    'ExMTg4Pj4+RERKSkpRUVdXV11dY2NjampwcHB2dnx8fIODiYmJj4+VlZWcnKKioqiorq6utbW7u' +
                    '7vBwcfHx87O1NTU2trg4ODn5+3t7fPz+fn5//8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAV8' +
                    'AAAAAAAAIXekI6lZAAAAAAAAAAAAAAAAAAAAAP/7UEQAAAEbAF3tBEAMI2AL76CMAYW8RVwZrAA' +
                    'ArgssAzMQAAAA3CU5dQIAD7ygIOB8Hy76gQBB0uD+CAIcH36nfv////39BERAAo0oTdbAAD4Pg+' +
                    'OLh95c+6XB+UlwfBB3WD5/U79/R7+hNIRzKghbWAuCCGNYWqbHum56r3/+gEjSURblQEkiLWpof' +
                    '/3m/6YFTvUDQl+dVEnC3SfwRlD3SGY08MxvE/VrH7PfzIxJ38AsCvl0ugK8YzAVAs+WBoS/Og0q' +
                    'cwAzawAKAAAAGkv/+1JEBYERXw1V/2sgCCvCi3/nrACFGDFJzjNqoKSJqfm00VApazBE0a3mZwK' +
                    'rlOlrTlNed78o1Fmu/qaZUK1CSrq8DlLMhgjRUGHwAABXSKMrZ2miI6ElaFpWoSqYSuZoI6iS2v' +
                    'a3+a4PAHouD0k7QoAAimIAwBG12Q2wwCg00ZJTRINQGLHct2GRgTc8mH6ic0uEscRQh/IrLgAJO' +
                    'BAAb1AbSG5p6R9FwxLOLNtOloFErQEkzkkMv+6KWYgcxseUJRoAABAZAAAAAH+dlgReU//7UkQH' +
                    'AzFXDFBzotsYLeJ6Pmw7ggT8NT6Oo4qAqono+bZVGAHDYzOmozJDQFAS16GXeXK4trgErahCH8G' +
                    'ygHMibsAAb4CgAAH8o5NJ29lxe08/zMRIkNXea7D0td6M5SmHpb3+QfxiRxL/ItoLdIAAHAFI5b' +
                    'DC2ZgsGBpfGhpMGBguAJdhYRh6RgCj7xPyQOxgawlvDIkxAAHNgv5v4zuMOW5BeM/QzM+HQDGJK' +
                    'OWgRJTLyl6f60qiNAzwiiqoLKWqAAAHIDWVzI2gkDDBYYzT//tSRAeBMWkQTqO8EWArwno+cDt0' +
                    'BUQxR84zaqCpCek5wW3QHtTlBhMJghnL/LpL/NOs9nb979V4gK2ITHEvwPwToogAPMgoAABupDb' +
                    'WJW7DKwoEDUsqBSChdhocIn5BP2AH/yP9wUbTKy7ZfrqAACKUgBAEvZw/6whgMHmqpqanCIcBEw' +
                    '2ttYWmAG5dYvcnLlQhiiL4P5E5QAA2oF1tkCN76MjeAhB5gmhmFAIrDFn5l1mXWegwxf9U/UdNG' +
                    'hrPo08qEABAKRAEAAB2nBaUhNP/+1JEBwExVQ1Q86LbGCsiel5tlFQFFEE+jvKkoKEJ6Xm2URgA' +
                    'QwMoIyMnQuLionMRd5hrTbXAIvOEHbAfaLfMiswAAj4CgAAHOy2LQ6xKlSOOMygAJq6h0DxNPia' +
                    'fcmMXu/qXWRwGp8pQ2J2AABwBFFN2IFyzBgKjTuAjmQqAQzLsLCMPSMHMTp+mYAVbQKgQ3Q845w' +
                    'gACRgL+Dlrsf9rkPq4K7cycSA6dCSdLSUts6fOz/WqolQMt8RhtLUAADAqIAgAAIzDTgpHAgUmg' +
                    '/qZ+P/7UkQKATFKDVFzjNo4KgJ6bm2URASoMVXtJyqgkYmqubTRGE6Dy5X6JoJB876J+kzdYOvx' +
                    'GsW+ZFWQAKcsFAAANV4w7b+MPfQRgJuVeDkksPgMJ54Tzxemh/1LrJQAXWqHidyAFRegCwAE+4k' +
                    'vchYc218O1toimw92GRheHICNT5MUFVQpYfkXuAAGvQfdRpalDS00JtbA7BIjiZkCiVoCSZySsv' +
                    '/WrOhC0XG8aAingOAAA7TgukqqocYlFA4ijKqzqxZyVqz3CRtfLCCqUUmc//tSRBIDMSUMVeNmy' +
                    'xwk4mseYZBGhDgxUo0LLHCNCa05h7Tii0MQEryCiAAGWMNPrKn1rMxMeYCD1cB0nHojHryUyd//' +
                    'XqBLyThASmYMIV3GGvqAHD0BoBk6YDWHDWAUwp8Ds+cAJTinh+RaGUDaKBuZuQseHGvssElgcFC' +
                    'dT00la+Q1XVfMsbX9auBTZQpoBp5gwAAAANZYE0lBEhxMdvwEav8zGBn5Z021nox03EEpBT4/Iq' +
                    'yEBvEAoAABuo7bDIbaxDaNhz4r6V1GBvpK4hL/+1JEIQERLwxU62LLHCUiav5gMnSEhDFh7DMI8' +
                    'I+JrfjwKgK6QDX+R6gEXldkAENJYDwAD5pqNfRQjZquRTnEf2HkgFyXSSoV0k8+WHqK0ci8uYI8' +
                    '0DmBiGPgGGXwR9sIGCFcDhciwqplOJZnhwq/qZwDsKRkBt9g0AAAAO00mJNxR2MSpgMRQy3aEsm' +
                    'UFBi9x8te3NBIgY0fkWhzA2igcgAA/UzHo62K6woLEoQ+WgeJp8Ip9EmMXu/oJ8FZx5ogEKoCid' +
                    'dxEwy0hxdUAwxGtP/7UkQuAzEwDFVrbKKcJKJrXmGNRoQoMUqNr2qwiomt+PAqAuhrETeADj99O' +
                    '6tZfRXAPyLy6gjzYPuhli4KMlirFSKWzGS+JyhytNJW2eqJx31M4BbFimIAUjpAAAAAUxRubimU' +
                    'KA8xfMTqNZUtl7oFcYdx6eTVueHLBmx9UU5guf4SAAAazjDtxh24wpWfOpcpoRoKaEU0jabP/09' +
                    'QHTtJ+EBF+g0ACFL0l7uMTN1FEubaK7dsgBcB4coXLSiaBln5Xo/ITcABRv/O6j7sofdg//tSRD' +
                    '0BMTMM03OZoSgkImruYZJEBHQxVa0nKPCNiat5pM0YFdugBmKvEzINGWgZNMKKy/X6GsDqh5FKZ' +
                    'AFUWXA8AAAAFMkbW5JkwUIqAYz0sk0jjJMWfTM9fWiuSEr4PbkHl0BHi6cwAAxlIGGuD3ag+QRu' +
                    'QsLMOE6lCGiXRkEiXenY/gI4XcIBL8BgADyq/ljjrEOTIExjNwoJBXFAcXle6q+rxZJRSn1+QaX' +
                    'UDaKpyAslgc6ED/RgFoDQVqFPTSVr5DVdV8yxtal9NDgpWSH/+1JESoERNAxZey95PCWia349Km' +
                    'KEdDFTrTMnMJSJrXgXtDpTAENJUCoAAAAXKmk8KizYQrNTprBeRyyOwui80O001seiJgzOQqnMF' +
                    'z++hAADOkjbsRt2I2rYcKSSUM1mYwFMwFM1E15dD4DKWk3EAk/AcAgZfj9rUZefmovu3iu3bfRf' +
                    'YDw5Q6WqMhSVTSmF+QeGMEealyA1K2UJzuwwOUKHih5M8s8zWBp0XGr6dqs9fdDg5smKZAFkWnA' +
                    '6AAAAFzJ6vEorHhiJTaqko0A2Hf/7UkRWgREuDFf7TJHMJWJq7mQzdARsMVWMpyqwk4mteYY1ik' +
                    'Wx8jlCorVfHKWYdnIK6iAq0wogABvTxswibdLrRgBk+8Wsrqd2HgyTYNBVFnV2fg/WkfJgCGusB' +
                    'YABtU44o09lh/2Dejfq4diJt0Byd6O9hUqslKvIPkoAvX9P8i7qRd1KNQU850hgyiAyKkIqQyVJ' +
                    'md6+7bgpLePqUwBTSEAoAAAAFMUjm6pLNFC91QWsMgVnkUPgii9Q21pF0JqFZ5B6cQSe/pEAAI3' +
                    '8a2/j//tSRGMBMTMMWfssehwmAmr+ZTJihFgxVeyjKqCOias5lNEYO6RrZ6KhwLtVX2lNZ0YldP' +
                    'mr+rs+wDUho6XQARFlgOgAKxERIHXpLwUUmPYV27b6MLBeHOFSKUVgqDSCJyE1BAc7/UAG6kNuA' +
                    '7a5JWoYY2IoUPOCRlodPsKXX6+7cA+7yapjAENJYDgAAAAROEQ4CWy9QpAJ1BLojFpGpWfqpUqq' +
                    '1XxugP4PbkFlgAGrscAAA1uIOnEG5zCbZi9eXcD0+AaTj0KizGhmTs9XZ9H/+1JEcAERMAxXe0y' +
                    'SLCbCas4HNAwEhDFl7CWqsI6Jq3mkzRgDlFjyhZsmAKbdAHQAGSqFyBt2mH+0P8N+lYyiJtgBS+' +
                    'u41KKwhKtJR7yCwxgSvMMIH9eRm8gbPOpfHCDWQqPQDCSZAdJzp0TXu6+6PAP7yLWTAGReUDoAA' +
                    'AAR5EYFBK2kOoNsy4MeXm640iYalssTS+ESraUY8gsoIDF7kAAAH4OWuyNv5G1SHxOGTAP7TMpd' +
                    'qUu1KbgwpvTsb/qnAVXtNdYAAPQDTlGGhoQAYf/7UkR8ARE2DFh7GngcKiJqjm2URgSYMVXspyq' +
                    'gmAmsOYZFGvnZFOA12HDxAeudmCHcV5sDLWVaKo7IRa02t5BIgA/iaryiG30ZWlQYBFJu7sgJsq' +
                    'ek9Ff5J5y2Mv+IOsXSPdw4GugYOyVAACAaQAQAAFbktW7JOjoYGC0ZGCoXJ2qqOoURaRY5NlJ9a' +
                    'rQ8kuCPYp7ILDAAK+A4AABvUTdB914R9FwwrOBQGDI9Comnx690C20/1pVFEDfRDWI9ZAAAcAMF' +
                    'SiTwGgXMPACOHzCO//tSRISBMTMMVXtryjgqImqOaFp0BPA1Po4zioCmCegRwO3QEAECB3B0EME' +
                    'yyBTYN6r3p6syI0EPVAY2JeR84xwoABPgL/J6Ezz8y4vKbJgJg0RIau87sapXejOUph6W9/kf7g' +
                    'o22Tntl+uqIAAHADKVDknSGgwDyYFqKZig7lUJJpsnU4Vc1K929ut+9R0d0IdNa28gsKQC9cDgA' +
                    'AH5xhy4w5b+JhgfKZAGIy0EiSdEk6149e7+tVRZA0EJGJ9YYANOW6oWPAoDh7OIB9A4Thj/+1JE' +
                    'igExWQxRc6zaOCpien5tlEYFtEE4juKmwK0J6PnA7gg6A6aPaZBKtset3KtbW7kdIfOGR2tvII6' +
                    'AAtVAm6jW1MGtqYOGFgo5X4BTdA9iB5y3FJfSAH/5/uPGcxtN6QXaYAAxS1BoAABcyZMeaqVQgI' +
                    'qIKhBsbAH4QSgG0fI4np2AulXiTCbWfI9QAA8cDgAAGq7oMDaQkfMKpjM2XogW0yV+paFI6Bg07' +
                    '/WrOgYR4uLaYAAAMgCgA4rFnyVrIhAcPAw+DB4RqWOA8asgFf/7UkSJCzFPDU6jHuCAKeJ6jmmU' +
                    'RgUENTiO44ZAoonpObDt0DlmHfA0q+o0K2ELDFmBAEfATmVLGn9XNKRGBHDagIE1dQ6B4mnxNPu' +
                    'TGL3f66yUAwv04wb09UAABwGuVMpP0sAcVRnKnlkoyjAGJztPY4pyF1rWl3MGJYvLSbmxCyySog' +
                    'DVoKAAAfg77EIfa5D61AOHmKhAirgRJRyIRjZ0+d//VUWQgtLiLMoABgeEDQA4y/ZO+SMQSUFJG' +
                    'iwjmwMgBWIcZUam3wqWIdUdhC0y//tSRI0BMUMMU3OM0joogmqebNRiBQQxQ84jaqiliel5tlFQ' +
                    'qggbQ4Jh2SATdhc8oVXN7FGmHKdyI3SP/GI2m3/r1AgyqSZTAlRKUGgAAAAP4wV4s4MKtgLhdhU' +
                    'FgS6AaN9BpRa+cNYD+7hh5J7gQB78HAAAN1GlqUNLTQiaSgXgkDy06HxZPh1VRJDm3f1qzoALJO' +
                    'NhAAAAZAEABlqvoSx4eFT6ykjxSYXZI+kFqdDV9eD/6TKmiPL5gh8z1AgD14PrdaZmoBrLJNjrT' +
                    'eHV4Ar/+1JEkgExPw1PI6vioimCen5tlEYEqDFLza9o6I0Jq3jMzGojGIjHvpTJ3/6l5wDEMUI0' +
                    '6nEAUlwwaAAAABgKb0laIVQcLeYXB3gR7ZfIIWE1rWt3wqVJ5MfnJJZYQBa4GAAAPdQFzUBc2Qp' +
                    'z4GDGBXepX+jNM7Maxppba5/WqopgZ+ImmJ8gwBDXXBaAAy5Xsib1vj+GJ+nMZO+8cbKM11oy9p' +
                    'DZUzKF+SiWAFztCNWEsECWCC8Ch7/CRUfqMjgCPxybpEH/6k84BkkKEceCAP/7UkSbgTEyDFl5+' +
                    'XiMKIJqrm2URgTcMUXNp2qokomquaZRGGRtcEoAAAAYEnbJGjodAvaFzImjwywfxYGEfK3I53C+' +
                    'VMSh/kopwAXvggAAA1XfRlb6MDmGFgDakAJWgZJmRMZeutH/1oZmB58nHAgAAegGur2ZqhcCh6d' +
                    'lUoPXJMO0kGkNHQ7ClMKsvlAexyRi1nsZ5JqcgB40H/VDJKGDJlD403JWd+rLLndl0ttcDAJv+f' +
                    '/qHNDY075iAFM8QCgAAAAcFhUFrYJQcwDxMJ3Q//tSRKSBMToMVHtr0qgrAmqOP1Q4BGgxVeynK' +
                    'qCRiar4zNDYR7ZfAjzkm086tRmEoYOp8krqYErSCgAAHcHfXRD7iRdUJ7GsYKVwERKMTJbZaTlP' +
                    '/1oawOQeXJIAQm1AOgAIpBwGRPKyY5SIfJNWXu6ZEFoou0mu+EypmUl8k0IAHF6Dap3YYfDDW4Y' +
                    'SrPtnATl9pl6o7NDJxdt2/+yeYAdRaVEBQdVAACEsQAgAAHSYzBC2xgPGHdMYcDilamDiQO6gQf' +
                    'xOSN+4EZB1I65zJKz/+1JErgExNgxVe2zKOCaiar5pM0YE3DU+ji+KgJKJqrmhZdCgBK8QogABu' +
                    'o4a5GVoYV3gAPy4xcpBkWVQemzjDNp6+6GsAszyAQQAQpjAVAATBQqirbLVOy3G1qn3UiB0HhFf' +
                    'TUn7gRkmpTm7JLbAAM/Y4Aft6GZzD10CqJl9OggCk+AaOx6fO+lMnf6uyegBzh5ogMeqcwBUbWA' +
                    'sAAAAHRY1Ba2EO5gFiAG04JOXNGHGY825t6/o/KjpSnyTQ6AbRUuYAAJqAy0IGO4CxAGCGv/7Uk' +
                    'S4ATEzDFR7eKEoJqJq/mGSRoR0MVPtLyjgngmp+aTRiGU9J0hquNFXVfKGNrr7ocCexNEAAEDpA' +
                    'CAAO802LOqXSOQbg8aSxbeJyR6QGttX6C5BLJ7bskkKIDGbbAB+DtsMdthj/oJD+zjOgCS0Co9H' +
                    'IdFVg8bN6uz6ADMEqIC/iAafgOAAA0pNtuiS6ShgtcBgiGy/i6B/DwII+P1jc/QzKipS27JPKgB' +
                    'Rm44AABqu7C54YcOUKHmSRpQKi1UEJaUi5AfbzZ6/bcFRZ9Y///tSRMIBEUcMUnOJ0qgnAmruZZ' +
                    'NGhIAxUe0nKOChCao5tlEYUgMlxQcVLX6Zafuo3q5yNDIDoPANHlTif2ArKh5S+7JIyiAI0Oogb' +
                    '1AbcG5qGUKfxhrTAy06A4dT4KS1EhGK7urs+wDUhoztUQAROkAKAAAAHRUceNRQVC5iyzmKwqrY' +
                    '1uH4EfsTrWs6vYbkCsp5uyS25ACxuOAAAfyB20i7yTygJ57pgQgUrhFMlpkt9k+d/r7tpAc8SfW' +
                    'McoACAloAYABrzBZc/KAI/HgN1Kv/+1JEygERNQxVe2/JWCYia04F7Q6EdDFL7aNKoKKJqfmmUR' +
                    'BS7ZnNQSAk6dXYmQGSmm7JNLEBRfbP5xhy4w5cYWHOATCBIqVAYhWIVrezv6uz6IGqCHpAVSAAA' +
                    'AhACAAAAB0lH1kCoEgAUDJHKDIwUDAECUhGIMnVwLI+P1kPe4P4ECSDzeWnbnWCAAV+W6j7socN' +
                    'TAGgOYJC0bC6YZigMRAM5rnSGekNHYCKnr3LlSsqPiwNWqPmEQtTYoAELMByWXRVxi2pxs6DxFK' +
                    'JmkAJRf/7UkTUBxEzDFVjbMo8J8Jqnm2URgQIMVSMpyjwnQmrOaZRGkE1cOUzM/EbkAGVwLsk0O' +
                    'YG0VLkBrboMjaQlvMJ/jL6QPT4BpOPQqLMaGZO/1dkuG2ZFQADAAB0VsCoYMgMBUJsxHFVTRcmT' +
                    'BgIDAMB0AaFBa9X852itWf7yjBgLlIlwdfw1/yUXUAAVoEAAAP7Jnvg5oUOgUEHQrcYoIYOBTEX' +
                    'ejNM/suxlUO2ufxB1i6R8N/A10DBWTIBCyAoACxkwXeVygGN2kgdzKtb+JzU//tSRN+BMUcMUvu' +
                    'L0qgowmqOaZRGBHAxTe0fSqCQiar5pNEYAgIttC/Q90Cva7JtTEBxvhP4P+ziNuRG12HDABAYGq' +
                    '4QTJaCRJadVOz/WlrA9caOFWAADwBQAAAAyJD9QwQgaYDC4Zj8MeAuGEhpdxYi10wGST/Kepd2N' +
                    'gIDIKtItO3OuCAAbQdV4Ya2yhHsCAUYOjOb/cSZ2BKTAA38Io70jnLYy/5HlMo7Hc+eyaqYxBk9' +
                    'iAAAOwMAd1ryuS1xiITnffmdyEocQlQN0Zig0AP/+1JE6QMRihBP+6yqqDGiicR0XHQEYDFKjbN' +
                    'o8JSJrTmGQRouSUSrGhEBAsA9lFp251ydAABSgTemlqUNLSMX2OCIxB6DFYVEgE4r9S20BRZgoB' +
                    'Rb/VN6eE4LQlug4R4qZABDSGA6AAAAGYocGZiIJ4wR2mvSJjs7DAJg27uaZjJkNC8Bn5N6oQF64' +
                    'IAAAP5anYsy3JkJvbaE4KT4AolGIjHtmT53/6l5wDGr0o0iAADgBBdymqYQCAUwrDQ2wmA2lDII' +
                    'E1Jtn68hQA2G02LRc//7UkTqATGOD83DPuiMMWJ6DnA7ggRIMU2to0qwlImq+aZNGFAgHLAFY0V' +
                    'XbllwQAC+BzOMP+5Cxy0BhKCJ3YBpm0R5geAyYrDnZjQLRspIWkv9UuyQkAEzAg52b4KHWdWqYg' +
                    'AjbmAcAAAAI83eIMjQYMhugEeOW5EYftyAMP8ZpEs/VcSKFOzsnEqQJX6DgAAGsEsEDsQIbRANb' +
                    'OGhUXsP3LLb8Q/GEE//XnAF1Ko2gAAAAggAAHJa8sUs0YQBea4xiazBaEB8qxujIUETtY+C//tS' +
                    'ROsBMX0QT2u7qUgwAom0dDx0BWRBPY4iqqC1ieh5wu2YgxGakBAQZgKo4qv51xCACsBqu0hStpC' +
                    'aYiAQEi+YCeKZBBkCgxSSYK/UVl1noMMX/VLtAgWYM7EF2yYy0XZTAERZUDoAAAAjrcImyCAwZe' +
                    'n3SKna+FAEwNueoVHt0S8HkBjyb1AADTwMAAAbypZVKX2qsyOB2QQh8tA8TT4mn3JjF7v9dZwCD' +
                    '9UYYAAA4AZ0sVB4zFMMRKN3sGN0xIAwupRs/UqEADs5tflql/L/+1JE5QExMAxYeymKPCeCaq5p' +
                    'lEYFoEE7bo6sYMsJ5tHT9ZnGVCBThbHpbl4W5aACdBAwH4O+xBr6gjjiwAOjkEyaNEUXKWFcqMv' +
                    '9S5WZdZ7/lu42MzXkleY8KXuxdTAAECswCAAAjzM3QSPAgmNF+o0MJi0aRDOBHBAPH+M0hV21To' +
                    'clCM6O5NFMAJ7oEAAANV4w7b+MPcAKg51WqZwBwxTuxK6kNyinGv+R/uCDMI+kwQv6AAAagHJa8' +
                    'qUssYPBuaxzWasBqDg2XA9DAUETOv/7UkTkgTE9DFT7bMqoJqJqvjNUKAW4QT3OmqxgwwonEdFx' +
                    '0LOSsqsSDwFJABcLGr+ddGMAA2sE3UhtwIbaQ6YwDjDM+BxDXtFYGltqW2uBApv9U/UfNDiKfNG' +
                    'jijAAEBgwBAAAglkDS0JhgGF5lRFJlKF4GARAOu9xGHgWx2Hs5JURDmMPnx3JkxgACsAQAABrc1' +
                    'BM09LxCANm8/GIxwDgawZxYepXelvQoEX/Q+q7dDou1+KQIG75gAGCSQBADlM5f5hoFBRo6MGiw' +
                    'UjSpy+M//tSROSBESsMWPssgiwnAmqeaZRGBaBBOIx0o8DACeh1wO4KqdFnNrhpdQxJBEVkdyb0' +
                    '6AL14R+cYd+MO/FFGThDi1oaQgCFKIUoooiVrP60MzA7+TjgIAAHAEkZGlQCQNMGBgNP+gObGAw' +
                    '2DwEAExFBy/jTLfKe5V/WM0MYAS71Ll4NywAHICBgAABuow9EyNuwl+YEDR0mkGdRFBNAz+DKGS' +
                    'UNQDX/HhXdA9TLdSkAwfnz48gAg1AM5WGVKBQAMHA/NU6fNSg7BQZJ4tiZShP/+1JE5gExUgxRc' +
                    '4zaOCuiek5sO3QFVEE8jqKsQKeJ6TnBbdCZ1Z6rKrEgOHK0JW6l1k3YAJeHquyhKtWwKgMQR3MU' +
                    'rx4UgW0r11orA07bCYkX/k/65/2W82uVAAAGIFC4CVYEYYNi+alcWdDL5hwHAIBpjqCF12n2O2L' +
                    '9nHKrBQ5mA63UusmqwApgwOAAAN6ethEFtEkpCBGvfgyGqxQ6B4mnwin0SYxe7+gnTJgD6RSogG' +
                    'r/NEAILkF/nJa0iaYJERtbnG0RAGA1bz0u0tFrtv/7UkTnATFhDFDzqdqoL4J6DnBbdATIMUnOC' +
                    '2xglImq+aTNGLhpaKEiTsGpo7k0dTAUaAUQP446uIfaZA6SJxmqmDLQGRUhBJDJCTM7/dDWAOZ5' +
                    'AEALAACRwAl4o2IwGb98hsY0GLAoEBRGxBxHxnHN099wIfoE9DChYwruNTEwwTqb/lceyoIEzwx' +
                    'A8AAAPo5EOJps7ZO3BBIcBqLDiv2mO1pgj+SmLkPNm6CHTdRMEEAP0iayBmZvqBAAAD7oCJe3/j' +
                    '8fj8AADt8Q+cc+umv+//tSROoDMWoQTqO8EWAxAnoNcDt0hVA1PI6jjECeiaoRsuXS0R1CWwnQk' +
                    'ygiyibhYPGQbMjsaLce5BHuovJOi/h7C6FgwA7yRPDuMjb8eY9ycPAqNSas1MqX8ly6Uy4bFxNd' +
                    'bLUl/zxfc3MEEFm6ksxRutgCy//EAASDcfj4UACEaAOBadKg0NyUu2QZRCSWzhWxwtGEGxjPj/D' +
                    'SYkkdP8XjRiA+axyP+E4PxUEgmIhCOiSKkG38AsHobB4JQkD58001Dv+HA/cXiggNCpNgTAT/+1' +
                    'JE6AMRYQ1Oox3ggC7Cel1tlFSEtDFCjhdsYJYJq7mUzRqW/aMMqkULcIcS6OnTRQ1lgoadKporl' +
                    'c+3RIGJJaaRI7JEiRlgYKwkAiWybM+SMuCjoQ3wXxRwMFaaRRYllV5nGomY9VUqFWBgJlATBTYV' +
                    'TEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UkTrgAGPD1DFc2AKNSKK/6' +
                    'zIAIyQ7Xu49oAZip1vNxhwAlVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tSZKqP8YcYwQc8wAIYwlhA4wwAQAABpAAAACAAADSAAA' +
                    'AEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVU=',
            ),
        /** Interleaved int16 samples decoded by ffmpeg, scaled by 32768. */
        reference: () =>
            base64Bytes(
                'nwGz1+7+KdFM/Q7Npvy+y9z8P829/TfRDv8D14sAyN3vAZDk9wJy6mQDsO4DA9DwrAGu8En/gu7' +
                    'X+9TqYvdt5gjyOOL66yHfceXy3bTeN98M2Crjw9Gq6SLMPPJmxyD8w8NkBlvBDhBDwDQYecAiHu' +
                    'zBcyF5xBoi7cdkIAzM7xyP0JEYL9U5FKPZzhCp3Q0PCeFvD5fjFhI55ckW5eX8HKLl4iOL5Ikqy' +
                    'uIAMJTgczMr3kw01NtIMtbZgi1z2Gwm59fDHWDYchQA2ncL1dy5A9zg7/0B5oP6HeyG+fvyrvpb' +
                    '+mH99AHLAHsJAQSkEBwGKxdfBtQcUQRxIdD/5CQV+SEnrvAuKGznIihD3iYnLtZtJQjQOSNuzM0' +
                    'gr8tyHrvNaRwn0vAaQtg2GiXfXxra5Xwbe+uMHVbvfiAB8S4kafBrKNvt+Czt6Y8xdeXnNWHhuj' +
                    'mY3sU83d3PPqzfrj8r5EY/J+uNPRX0jTom/mA2ZQgxMdUROSuYGbwkCB8BHtAhVRf2If8Q2h9BC' +
                    'yYcUAa4F1MCfxNi/1wQgf0AD6P80w+r/OUSav3sF6f+TR4hADIlkwGpK7cCxDBOA7szIQMHNAYC' +
                    'eDHk/zgssvzKJHj49RtS86gSa+3fCfzmdgJJ4Bn9mtkh+jnTjPlxzQL7gcjf/Z7ESAHwwVMEjsA' +
                    'fBnvA/AWqwYAD+8OY/j/Hj/c8y/3urc+75UrUvtzM2P3U7dxIz3TgMMwz4/LLC+Vvzu3lMNPf5X' +
                    'nZ9eRg4Ffj8OY34U3s1N7O73LcGPFY2irwythb7QXYTuk82Nzkkdn24Bncfd7W3ynetuRq4JfqV' +
                    '+VI8a7si/jY9RoA/v+pBykK7A5fE54VyBqAG8sfYSAhIh4k3SGmJm4f/CeIGzAoDhdqJ+8S2SUH' +
                    'ELsj/A5VISsQ7R6UE8cc4BgiG2cfMxpOJh4anyz7Gm8xzhz9M4gf0TMMI8YwKicYK6grViNDMFA' +
                    'asTT8EKw4UwjuOy8BPD4v/Gk/nvlTP2357T00+zs7Q/5VN7oBYDKqBJMsOAYvJrsFfB/XAsUYiv' +
                    '1TEir2agxh7UMHD+QKAy3b1/+x07f9Y86g/MfLdvwNzBL9A887/ibUsv+r2jMBpeF2Ah3oOwM77' +
                    'UgDZPBxAkjxlQD476j92+yw+aDowvQr5Abva+Cy6EDeB+JY3k3bE+HQ1Hrm2c457qrJqvd9xe0B' +
                    'fsIFDMfA/BRhwAEcQ8GJIFHDXCJgxqIhN8rVHpTOuRow0zUWwdc5EgLcmQ+23/IOquKNELvkXBT' +
                    'Y5fUZAOakIETlhifI46MtvOEWMlzfKTTt3HMztdrhL/rYwSn717Ah7deIGPnYRA8329gGq94VAE' +
                    'vjivv26HP5f++u+av2xPsz/vj+zgVlAi4NHgUMFFAGJhpfBUgfAQJNI0X8HSaS9Lgnn+stKFLim' +
                    'yeo2TQmjNIxJL3N1iGvy2offMwzHeXPcBtV1Vka+9sWGuXiwhoh6WUc4u30HprwVSIN8VsmXe/Q' +
                    'Kv/rcC+v5/QzUuMSONnfhjsZ3hI+st6FP/Phuj/U56A+7+84PJL5lDjYA9czww02LmIW7SfzHEU' +
                    'h+SCJGk8iARQsIfQNHB6cCOYZKQR2FbgAuBFZ/ncPBf0+D6b8RxEW/XIVIP5HG4f/CCIGAc0oVw' +
                    'KiLjgDpzJtAzc0xgL2MiAB5y5s/mMoqfoWIOv13xZW8LoNHOqUBXzjNf++3Bz7LdZx+RHQBvqxy' +
                    'lX8SMaZ/wTD6wIEwWEFU8AyBu7A0AS9wgEBlsXj+kXJ7/KJzeLpG9Kp4LHWPdgG24XR294wzfrh' +
                    'pcs95O3Mj+W60OvlatZf5SbdC+T74xzi/OnM32buXd248BfbyfA/2cfuFdg269LX2eag2Jvimtp' +
                    'n38zdDN4q4hvfnefW4vjtIukD9Y3xe/xb+xUEoAWGC14PhRKsF88Y0R0sHmAhcyJDIowlwiBuJ3' +
                    'MdJSgmGc8nyRSXJkQRtSRZD2sihA8AIPMRuR1yFtcbgByVGlIjHhr+KZEajy/6GzAzUh5FNIQhg' +
                    'zJmJfwtxSkaJ14ukR7tMksVKDdBDMc6XgSNPV7+Qz+y+sI/c/n2PmL62Dzr/Hg5QwD3NH0Dgi+1' +
                    'BVcpJwa8IlYE+RsUAFwVlPkqD1nxoQkt6PMEA99EAdLWpP570BP9ocx//JrLxPxgzbH9k9EK/4b' +
                    'XjABa3vABGeXyAtzqVQPq7uUC0fB+AXjwCf8e7oT7Ver+9uvllvHN4X3r497u5PPdMd6C347Xv+' +
                    'NR0YDqwMtA8xnHOf2Pw3kHQ8EEEUbA9hiYwKUeJMKxIcbEGiJMyDUgdsynHADRSRif1QkUDtrKE' +
                    'AneQg9a4eEP1uO/EmTlmRf75d4dpuW7JH7kQSuu4n8wb+CqMwDeNTSp2+YxrtniLFTYoyXU1+gc' +
                    'XdihEw/axwr33DsDEeGs/Ufme/py7LD5XPP3+sX6s/1iAg8B5wkeBAwRAQaJFwIGJR2zA7Ih+P4' +
                    'TJRX4PCed7zYoZOYZKF3dDSd+1Uolms8OI0nMoCDNy0ceD85GHJ7S2BrC2C8amN9rGinmnBuZ68' +
                    'EdO+/HIK7wiiTq79UoQO1sLU3pCDLo5F82/OArOm7eKT323SE/CuDqP8jkaD/z65Q9+/R4Og7/M' +
                    'TY4CeowgBLfKgwaUiRAH44dziHfFsUhjBCMH9UK0BvxBXIXBgJeEyj/cBBc/VIPk/xjEKz8qhN7' +
                    '/dYYxP5GH0QAIya3AXos1gJfMWMDEzQnAxg0+QFDMcD/yyt0/DkkIvhVG+TyFBLo7GsJaOY1Aqj' +
                    'fEv3y2FT6ktLx+dHMh/vtx2z+HcTEAYfBpgQ/wDUGScDIBZXBAAMCxNT9YMeV9nHL5+3wz6Pklt' +
                    'TA2xjZMdQ03b/Or+Dxy1zj/Msd5bTO5uWd073l89m65MzgBOM259LgWuxi3pnv+9uh8OTZe+9h2' +
                    'Ijsr9dx6P7XEuRy2VngHNwj3vzfH97/5LLgAevq5c7xeu0n+cT2xADvAFkIAgubDwgUQhYyGxIc' +
                    '7x/cIAIifCSKIecm/B4dKBIbNiiuFlcnvRKzJRQQiSNSDx4hxRC5HmgUnhzYGQobayAyGkEnOBp' +
                    'oLTIb+TEiHT00+R/DM5QjczDGJ5EqUSyxIvIwpxlgNWkQUjnsB4U8AgG+PkH80D/q+Zw/5vkXPs' +
                    'b7RjvU/kE3MAIxMu8ETiw6BtglcwUbH0YCXxi7/PERMPUQDFXs+AYK49ACS9qz/wbTqf37zaj8q' +
                    'MuT/C/MQP1Zz3X+mtTy/yTbcQEK4q0CWehjAz/tWwMo8GkC0vBwAFPvYv0b7En53+c89IPjZO70' +
                    '3/rnDt4/4XTefdp+4QDUK+cRzh3v88iq+N7E7QL8wewMZsCyFSPAeRwnwb0gVsNRIoHGZSFvynw' +
                    'e3M5bGoDT7BUQ2BwSSty4D+/fUw/Q4i4RyuQwFc7l6Bre5Z0hDOVpKH7jWC5m4YgyAd9NNJPcRz' +
                    'Nl2m4vutgYKdLX6CDg17wXC9mNDmnbTQb+3sT/u+N5+4Hpnfkf8AX6Wfcy/On+Zv+EBrkC3A1CB' +
                    'awUNAayGv0Eux9aAaMjZvtXJpDz1CeT6i0oV+GDJ9bYByb40fYjcc2TIa3LJB+8zPAcV9A3G+LV' +
                    'LhqJ3P0ZW+O+Gmzpdhzz7RsfbvCPIqnwpSbO7iQrW+vJLw/nTDTQ4mI4it/IOw3ePz7v3pk/eeK' +
                    'xP5boeD7Z8PA7jvouOMoEVjOTDp4t/hZFJ04dkyARIdQZLCJRE90gUA22HQoIghmuAy0VWACdER' +
                    'T+mA/c/J8PlvzkERv9PhY2/i0cpv/wIigBnCl1AkAvSwMEM28DSTSzAr4y9QBtLib+uSdK+lIfd' +
                    'PUbFsrvDg2B6RYF2OLx/hfcFvuJ1ab5eM9n+ijKzfzUxRAAqMJHA8LAjQUuwB0G48BzBMrCXQC4' +
                    'xQT6d8no8cbNzehd0qHf9NZc10Tb39AP39TMIeKWy1XkJc2V5SnR4OX81kXlv93j44Lk6eFZ6pP' +
                    'fie4k3Zvw4tpt8BTZOe7514zqydct5q/YB+LD2gbfD97x3YniUd8V6F7jh+7z6aT1lPIp/X78yw' +
                    'TABj0MYBA2E3gYdBlXHsAemCHxIjMi7yV4ILcnBB1TKK8Y4ydnFJQmDxGgJGIPSiLWD9cfihKQH' +
                    'UIXsxtzHXwaTCQVGuEqmho/MBccljODHlQ0xyE6MrglYy0gKkUmvi6bHUszURR9N2ELDzuyA8A9' +
                    '9v1eP5T6wj+c+dk+wfqgPGr9JjnEAI405AMIL+cF0igSBjEi8QNwG2P/2xSk+LcOQfBBCQvnqQT' +
                    '13RMB9tWM/ubPFP1izJb8s8vv/MjN6v030kz/S9jQACPfMALI5SoDWet/AyXv/QLG8IEBKvD1/p' +
                    '7tWfu86bz2VeVB8VbhF+um3n7kAt663eTfGNdy5OHQdetcy2P0x8Zs/lLDnggewf8RPMCwGanAE' +
                    'R9Ows0hBsXtIZ7I0R/WzCQcZtHDFwXWnRNt2o4QXN5FD5zhKBAD5EUTeeVQGPjlrh6K5YklTuTw' +
                    'K27i9zAk4Ngzst0QNF7bcDFu2SUsJdizJLzX4Bth2JwSMdrgCTjdigJx4T39w+ZS+gXtx/kA9D/' +
                    '7cvsW/hEDcgGRCmkEpxEdBhEY4AWUHUsDBCJQ/kYlOfdRJ6PuLyhl5fgnddzYJsXUBSUlz8IiIs' +
                    'xSIPbL/h1+zgccQtOpGoTZEhpd4GIa2OanGxzs3x2E7/UguPDDJLrvFSnj7Kwt2uhDMnbkjzam4' +
                    'Eo6Sd4zPRTeEj9x4ME/deUkP9rsNj0H9gM6JwCoNUIKVDBiE0AqshqxI54f8RziIU0WliEJECkf' +
                    'aApSG5wF8BbKAfESBv8tEFP9Rg+g/JMQzPwSFKj9Zhn4/usfeQDDJucB+yz7Aq0xeAMdNCgD1TP' +
                    'lAbgwlv8CKzb8RCPQ908ahPIVEX/sjAj85YkBP9+m/JPYKfpC0gH6lMzE+8jHwf4SxBsClsHlBG' +
                    'nASgaKwKcF6sGjAmXEQP3Mx9n14MsU7V3Q0uP61Avbb9ms03vde87k4PfLfeNLzCzlQ8/k5VvUr' +
                    'uXK2qLkpOHn4vfntuDw7Eze+O/w28Xw59lp73bYTezX1yHoO9jF48PZJuCA3B/eceBY3oHlL+GM' +
                    '66fmXfJr7rb51vdOAQgC2QgJDA0Q5BSjFs4bYBxAIBQhByKfJEoh9CaIHhgofxogKBcWMyc7EoU' +
                    'lvg9WIzQP6yDmEIoewRR3HFsa7xoCISUa0ic8GtgtRxswMkcdKTQrIF4z0iPBLwoonSmXLJEhND' +
                    'F4GJg1Rw96OfIGmTxHALo+0PuxP8b5YT8F+sA9FvzVOj3/ujaXApkxOAWqK1AGLyVIBXMe2AHAF' +
                    'xD8XxFb9JILbeuQBizigAKS2X3/itKK/c7NnfzPy5j8psxO/RHQiP581QMAFtx6Ae/iqAIX6UwD' +
                    'w+0vA2nwJgLP8BYAF+/0/LnryPhw567zIOPP7bffYucK3qzgtN712QTiidPt5w==',
            ),
    },
    {
        name: 'mpeg1-48000-vbr-mono',
        arguments: '-q:a 5',
        sampleRate: 48000,
        channels: 1,
        sampleFrames: 48000,
        referenceStart: 2048,
        referenceFrames: 1024,
        bytes: () =>
            base64Bytes(
                'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tUwAAAAAAAAAA' +
                    'AAAAAAAAAAAAAWGluZwAAAA8AAAArAAATyAArKzQ0OTk9PT1CQkdHTExMUVFWVlpaWl9fZGRpaW' +
                    'lubnNzeHh4fHyBgYaGhouLkJCVlZWamp6eo6OjqKitrbKysre3vLzAwMDFxcrKz8/P1NTZ2d7e3' +
                    'uLi5+fs7Ozx8fb2//8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAPAAAAAAAAAE8gkpgb0AAAA' +
                    'AAAAAAAAAAAAAAAA//vExAAACgw3WnTEgCoClKt/O1CADv2toBuI5PsSAQAgBwmRze99ve8EAoC' +
                    'gICgkYg/MPf8AAEf4eH//gDvM//A3/8cA/+AY//DwB3wAMP/oeAGfAAw9/Q8AEfAAw9/R4AI/BG' +
                    'HgAAAudgAG3qYWCgYCgYAAIIjBUSDDAWTWnXW7mBwuhwo1jYAL5kDCP6UZgcDrHCYGS1JQCgSCw' +
                    'XAgG5gDK4PCELAsAwDgCMcLmAqCiGmgGEwlhkYckXKkp+K1IcOcOcUUVspXyKkVMi8TRj/+XSZM' +
                    'i8XjEu/wkDQlCX+DQlCQNCWwrAOAAAAICR6R/MGBzDrE/e8M/EgMHL3dNQVdrFZ23LpVFm5KBAF' +
                    'COLF2lQ9Gg07X2Db3YgUJqEaMkI0wgcCGuyaIgHQWESupIWuieF7mVfoYzMoAoAAAFeBCmYB3Iw' +
                    'GaI4pyCHQj0oGUdTS/YlhtgnQA5QAOAAupM2D1OCYdkd6JiOtwK8lZMCrSNnSanizLYip5FCUE3' +
                    'BbcgAaAAHAAAACmKCJnpCDBSxOA6AoEs+ZG84xIxQ7iyuWylwgQ0nQBzBZdZPUfQNm7ihLmpJuI' +
                    'inEBqKcEXTAawytpAFakMlkOaJQ1NNXqB/7aALAAACDBwm8ElSQc44noCh1CoKQjesrp+JAa4OQ' +
                    'ANsADgARNcjtoYGETadZSQGXq4QfXe1xy21sX4PvWppspJ4NU4Au6FqVgCNgAcAAAALtVM1kv8Y' +
                    'aN57BKAsFXyjDZHBcJtLNuBqWmlTSQa5HGiLLpaDO/7B93MEJZkh+vgRpehQVYkbSEYgBsPBk/p' +
                    '0lXZkK70OkG3foAkAAAWMlbAy1ZURXCeaBAyfmcYJO53qoh0x/FJ4J4ARogDgAICRlTZSoIdmzG' +
                    '8wdCtwR7YO3j//tExN0AxhQzSV29gCh6he549i0U3tmvcey/ZqtkHe5qyT71MxWiwAMwAPAAAAA' +
                    'cqFKELPMOAo90Fx6Is9pkMMjZ40q3FJDasyl0gtrPIOa7TAtu+gftuhCS/wWOzIYK2JL9YaUrYc' +
                    'xvm1GdqLWmcmhkcmr5Br3bAKAAAIWnRD67ImNGV/LAHiWCATjrSx+xuMAhaDjAFaAB4ADOVhnBQ' +
                    'nGDDyc2UQGE//sUxP6ARCwvccexSmCiBik1x+jcLLl0u0IojCyLyPF9Z6xTkcQi7FfAMdtgBRAA' +
                    'cAAAAUDS3AQnmDD0c0UoCECx1SOQutiAuv5GdelToiPgc0i5VKFd/SDd36ISsZMG//sUxP8AxYw' +
                    'zR62zaKCBBe35hLVUHl2xIaOL5xEuYZdiejHnhnUpVdj8Kb0V+QjNuhCQAABVUqCeNHRsaXyJ7s' +
                    'LDtfZI24x7VjeY/hmeZoAUoAHAAU1RGgVZxhwEnugk//sUxP4ARBQvc8exRuCohmk1zWCsTEVcb' +
                    'JH0aO0YOIVJo/114BDtO6OcukzBOhXABsgAcAAAAF1hEtsRUGOzRkeaOhGxsAfhs72wf3kJtWZS' +
                    '3YU6m0JOzWCW76Br37AK//sUxP4AxbgxR65nZCB8ha45hjUUbZUEDqWU5EpV8gAeSwkFYEWFhZX' +
                    'LcYhA5Kr8CP7MMKAAAEvUBSqohY9KxBDWIoUEXkyhhUEtRHyQFuagAcQAHAAli73YRPMKF47s//' +
                    'sUxP0AREwvb8w9pSCphmk1jehEgQUNFdoOLsXewwCVsF0u48YWyHwGuJT4A5TVYAlYAHAAAADOl' +
                    'hXCQxMImw62kQUqZK0KAVhlhW37fg+zalTdR3wd5wFVFd/2EZ+Y//sUxPwAxaAxSahzQGB9Ba35' +
                    'hjVMAW8KhjcxEKC06kf38Xe76dC6wjkwKQosZBvQ+wbe7ECgAAATUI0ZIRphA4ENdk0RAOgsIld' +
                    'SQtdE8L3M/QxmZQBQrwIUzAO5GAzR//sUxPsARBwvccwxRuCohmk1xmkVHFOQQ6EelAyjqaX7Es' +
                    'NsE6AHKABwAAAAupM2D1OCYdkd6JiOtwK8lZMCrSNnSanizLYip5FCUE3BbdAA0AAFMUETPSEGC' +
                    'licB0BQ//sUxPsAxWwxSa4zSmCABa45h7SkJZ8yN5xiRih3FlctlLhAhpOgDmCy6yeo+gbN3FCQ' +
                    'AABzUk3ERTiA1FOCLpgNYZW0gCtSGSyHNEoammuoH/toAsgwcJvBJUkHOOJ6//sUxPqARDgvb8w' +
                    'xqmCqBmk1xmlMAodQqCkI3rK6fiQGuDmABtgAcAAAARNcjtoYGETadZSQGXq4QfXe1xy21sX4Pv' +
                    'WppspJ4NU4Au6FqWAI12qmayX+MNG89glAWCr5//sUxPmAxXAxSaxvQiB6ha45hijcRhsjguE2l' +
                    'm3A1LTSppINcjjRFl0tBneq+wfdzBCQAABmSH6+BGl6FBViRtIRiAGw8GT+nSVdmQrvR0g279AE' +
                    'rGStgZasqIrhPNAg//sUxPmARCgvc8w9ZKCnhmk1xGlMZPzOMEnc71UQ6Y/ik8E6wAjRAHAAAAC' +
                    'AkZU2UqCHZsxvMHQrcEe2Dt497Zr3Hsv2arZB3uask+9TMVowAMwAIcqFKELPMOAo90Fx//sUxP' +
                    'kAxXwxSa5rBWB8Ba55hKlM6Is9pkMMjZ40q3FJDasyl0gtrPIOa7TAtur6B+26EJAAAC/wWOzIY' +
                    'K2JL9YaUrYcxvm1GdqLWmcmhkcn5Br3bAKhadEPrsiY0ZX8//sUxPkAxCQvc8exaKB7he449ilM' +
                    'sAeJYIBOOtLH7G4wCFoOVWAK0ADwAAAAzlYZwUJxgw8nNlEBhCy5dLtCKIwsi8jxfWesU5HEIux' +
                    'XwDHbYAUQAFA0twEJ5gw9HNFK//sUxP6AxUwxSa4/RuCihmjRtm0UAhAsdUjkLrYgLr+RnXpU6I' +
                    'j4HNIuVShXeukG7v0QkAAAWMmDDy7YkNHF84iXMMuxPRjzwzqUqux+FN6PkIzboQlVUqCeNHRsa' +
                    'XyJ//sUxPqAxFgvb8wlqqB4he549ijc7sLDtfZI24x7VjeY/hmeZqAFKABwAAAApqiNAqzjDgJP' +
                    'dBImIq42SPo0dowcQqTR/rrwCHad0c5dJmCdGADZAALrCJbYioMdmjI8//sUxP+BxYAzSa5rBWC' +
                    'ghijRzOyE0dCNjYA/DZ3tg/vITasyluwp1NoSdmsEt1X6Br37AKAAAG2VBA6llORKVfIAHksJBW' +
                    'BFhYWVy3GIQOT+BH9mGFJeoClVRCx6ViCG//sUxPqAxDQtccwxqKB/he35h7SksRQoIvJlDCoJa' +
                    'iPkgLc0gAcQAHAAAAEsXe7CJ5hQvHdkCChortBxdi72GAStgul3HjC2Q+A1xKfAHKWAJWAAzpYV' +
                    'wkMTCJsOtpEF//sUxP8AxYgzSaxvQiClBikRDmgMKmStCgFYZYVt+34Ps2pU3Ud8HecBVRXf+wj' +
                    'PzACwAAB4VDG5iIUFp1I/v4u9306F1hHJgUhRYyDej7Bt7sQKE1CNGSEaYQOBDXZN//sUxPmAxD' +
                    'gtb8wxqmB5he45hijcEQDoLCJXUkLXRPC9zKpM+hjMygCgAAAV4EKZgHcjAZojinIIdCPSgZR1N' +
                    'L9iWG2CdADlAA4AC6kzYPU4Jh2R3omI63AryVkwKtI2//sUxP6AxYAzSa4zSKiehikRxmlMdJqe' +
                    'LMtiKnkUJQTcFt2ABoAAcAAAAKYoImekIMFLE4DoCgSz5kbzjEjFDuLK5bKXCBDSdAHMFl1k9R9' +
                    'A2buKEuakm4iKcQGopwRd//sUxPoAxFAtccw9pSB9Be35hjVMMBrDK2kAVqQyWQ5olDU00uoH/t' +
                    'oAsAAAIMHCbwSVJBzjiegKHUKgpCN6yun4kBrg5AA2wAOABE1yO2hgYRNp1lJAZerhB9d7XHLb/' +
                    '/sUxP6AxYwzSa4zSmCfBikRjehEWxfg+9ammykng1TgC7oWpmAI2ABwAAAAu1UzWS/xho3nsEoC' +
                    'wVfKMNkcFwm0s24GpaaVNJBrkcaIsuloM7/sH3cwQlmSH6+BGl6F//sUxPmAxCQtccwxRuB7Be5' +
                    '5h6yUBViRtIRiAGw8GT+nSVdmQrvR6Qbd+gCQAABYyVsDLVlRFcJ5oEDJ+Zxgk7neqiHTH8Ungn' +
                    'gBGiAOAAgJGVNlKgh2bMbzB0K3BHtg//sUxP8AxXgzSa4jSmCghikRzWCs7ePe2a9x7L9mq2Qd7' +
                    'mrJPvUzFaHAAzAA8AAAAByoUoQs8w4Cj3QXHoiz2mQwyNnjSrcUkNqzKXSC2s8g5rtMC276B+26' +
                    'EJL/BY7M//sUxPqAxDAtc8wlSmB6he549i0UhgrYkv1hpSthzG+bUZ2otaZyaGRyVfkGvdsAoAA' +
                    'AhadEPrsiY0ZX8sAeJYIBOOtLH7G4wCFoOMAVoAHgAM5WGcFCcYMPJzZRAYQs//sUxP8ARCwvcc' +
                    'exSmCiBik1x+jcuXS7QiiMLIvI8X1nrFORxCLsV8Ax22AFEABwAAABQNLcBCeYMPRzRSgIQLHVI' +
                    '5C62IC6/kZ16VOiI+BzSLlUoV39IN3fohKxkwYe//sUxP+AxYwzR62zaKCBBe35hLVUXbEho4vn' +
                    'ES5hl2J6MeeGdSlV2PwpvQr5CM26EJAAAFVSoJ40dGxpfInuwsO19kjbjHtWN5j+GZ5mgBSgAcA' +
                    'BTVEaBVnGHASe6CRM//sUxP6ARBQvc8exRuCohmk1zWCsRVxskfRo7Rg4hUmj/XXgEO07o5y6TM' +
                    'E6KsAGyABwAAAAXWES2xFQY7NGR5o6EbGwB+GzvbB/eQm1ZlLdhTqbQk7NYJbvoGvfsApt//sUx' +
                    'P6AxbgxR65nZCB8ha45hjUUlQQOpZTkSlXyAB5LCQVgRYWFlctxiEDk1fwI/swwoAAAS9QFKqiF' +
                    'j0rEENYihQReTKGFQS1EfJAW5qABxAAcACWLvdhE8woXjuyB//sUxP2AREwvb8w9pSCphmk1jeh' +
                    'EBQ0V2g4uxd7DAJWwXS7jxhbIfAa4lPgDlKpgCVgAcAAAAM6WFcJDEwibDraRBSpkrQoBWGWFbf' +
                    't+D7NqVN1HfB3nAVUV3/YRn5gB//sUxPyAxaAxSahzQGB9Ba35hjVMbwqGNzEQoLTqR/fxd7vp0' +
                    'LrCOTApCixkG9H7Bt7sQKAAABNQjRkhGmEDgQ12TREA6CwiV1JC10Twvcz9DGZlAFCvAhTMA7kY' +
                    'DNEc//sUxPuARBwvccwxRuCohmk1xmkVU5BDoR6UDKOppfsSw2wToAcoAHAAAAC6kzYPU4Jh2R3' +
                    'omI63AryVkwKtI2dJqeLMtiKnkUJQTcFt0ADQAAUxQRM9IQYKWJwHQFAl//sUxPuAxWwxSa4zSm' +
                    'CABa45h7SknzI3nGJGKHcWVy2UuECGk6AOYLLrJ6j6Bs3cUJAAAHNSTcRFOIDUU4IumA1hlbSAK' +
                    '1IZLIc0ShqaawAwDgAQelu7ypDDq4/m7M/F//sUxPsARDgvb8wxqmCqBmk1xmlMzCwNocFsTf9o' +
                    'du/L4nD7KFSABGOEGW4Q5GDtCgCQCGOABxCDJc9YFAWBAADHRkNXfYEAMkAgBByP5xMEmFgIYRC' +
                    'URZRTGJBQZGCj//sUxPoAxXAxSaxvQiB6ha45hijcqA0CPrEDA8IzQ5bsWyiVcMN0HEwEUoi/sF' +
                    'RK2rxh6x2GxJ/sd8V+3BQSERlrURf1/ZrLXd/D+UjsZxR/n+lMZjNb////8LeedjCm//sUxPoAR' +
                    'Cgvc8w9ZKCnhmk1xGlMlVWlpa1N////+FvPOxhhbCoKiIK+HwQAYfBAFREFQVEXwGHwQAYfBB3/' +
                    '5cP1TEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sUxPmAxXwxSa5rBWB8Ba55hKlMVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVV//sUxPmAxCQvc8exaKB7he449ilMVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    '//sUxP8AxUwxSa4/RuCihmjRtm0UVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sUxPsARFgvb8wlqqCyhm' +
                    'kqt7AEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tUxPiAFMzRU/nNkEAAADSDgAAEVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
            ),
        /** Interleaved int16 samples decoded by ffmpeg, scaled by 32768. */
        reference: () =>
            base64Bytes(
                'TtVN2drczt8N4oTjMOQY5FDj+eE84EreV9yb2krZldin2J/Zk9uL3oPiaecf7X3zUvpmAX4IXw/' +
                    'SFaEbpCC5JMwn1incKvIqNCrOKO0myiSZIpQg7B7NHVsdrR3PHr4gbSO/Jo4qrC7iMvc2sjrbPU' +
                    'JAvEErQn5BrT/CPNM4ADR2LmkoEiKuG3YVow9kCuIFOQJ4/6H9qfx5/O/83v0U/1kAeAE6Am8C8' +
                    'QGfAGr+SvtK93zyAu0I58HgZtox1F7OI8mzxDTBxL5zvUS9Lr4ZwOTCYsZgyqbO+tIk1/DaMt7F' +
                    '4JPijuO54yHj4uEh4Ave1tu42enXntYH1kzWidfQ2STde+HA5s/se/OQ+tQBCQn0D1sWDRziILs' +
                    'kiCdFKfwpxCnAKBsnCSXCIn8gdx7eHN4bmhsmHIwdxh/CImMmfirhLlUznzeDO8o+QkHCQi1Dck' +
                    'KLQIU9dzmENNousChAIscbgxWqD24K9gVfArf/Af4v/Sn9zP3p/k0AwAEIA+8DRATeA54CcQBS/' +
                    'Uj5afTW7rvoTuLI22XVYs/5yVvFssEdv6y9ZL08vh7A5cJnxm7Kwc4n02TXQ9uW3jnhEOMR5Dvk' +
                    'm+NN4nbgRN7r26XZq9cy1mvVgdWR1q7Y3dsV4EHlP+vi8fb4QQCFB4UOCBXbGtMf0yPHJqoohCl' +
                    'rKYEo8CbqJKgiYiBRHqcckBsxG58b5RwAH+AhaCVxKcktPDKNNoI64z1+QClCxUI+Qo9Avz3kOR' +
                    '81nC+PKTIjwRx5FpEQOwugBt8CCAAg/h796vxk/WH+rv8VAVwCTwO6A3UDXQJfAHL9nPnu9Ijvk' +
                    '+lD48/cc9Zs0PPKOsZtwq2/DL6TvTm+7b+LwuvF2skgzoLSx9a42ibe6+Dq4hXka+T248/iGeEC' +
                    '37zcgNqF2AXXL9Yu1iLXH9kr3EHgTeUt67jxufj3/zUHNg7BFKEarB/CI88mzCi/Kb4p6ChoJ24' +
                    'lMSPrINMeHR32G4Ab1RsAHf4ewiEvJR8pYy3FMQs2+TlaPfo/rUFVQt1BP0CAPbY5/zSJL4UpLi' +
                    'O+HHMWhRAlC38GsALL/9X9xvyI/Pv89P1C/6wA/AH7AnUDQQM8AlAAdv2x+RL1ue/P6YXjFd261' +
                    'rDQMstyxp7C1b8svqu9TL75v5XC9cXlyS7OlNLf1tfaTN4W4RvjS+Sj5C/kBuNM4S7f39yZ2pPY' +
                    'Btck1hfWAdf12PzbDuAZ5fzqjPGV+Nz/JQcxDsYUrxrCH9wj6iblKNIpyCnmKFgnTiUCI64gih7' +
                    'LHJ4bKBuCG7ccxB6bISAlKimKLQgyaDZwOuY9lkBWQgVDj0LtQCc+UTqMNQYw8SmIIwgdrhayEE' +
                    'kLmgbFAt3/5v3X/Jv8Ef0O/mD/0AAmAioDqgN7A3wClgDA/f/5YvUJ8BzqzONR3efWytA1y1vGa' +
                    'MJ/v7W9FL2WvSi/rsH+xOXILc2c0fbVBdqY3YbgseIH5IXkMuQm44Lhcd8m3djawtgb1xfW4tWg' +
                    '1mbYPtsm3wzk0elM8Ev3k/7oBQwNxBPYGRwfbSOzJuUoByosKnEp/ycIJsMjaCEzH1cdBhxkG4w' +
                    'bjhxpHhIhcCRcKKgsHjGDNZ05Mj0MQP5B5kKsQkdBuz4aO4E2GzEbK7kkMx7EF6kRFQw1ByoDCg' +
                    'Dd/Z78OfyR/Hv9x/4+AKYByAJxA3ADowLxAE3+ufpD9gfxLevl5Gfe8Ne90QrMC8fxwuC/7r0ov' +
                    'Ym9Ar90wbjEm8jlzF3RxdXm2Y3dkODQ4jrkyeSE5ILj4uHS34PdLdsL2VXXP9b31Z/WUNgU2+je' +
                    'vONy6eDv1fYX/mkFjQxJE2QZsh4OI2ImoijTKQYqWSnyJwQmxCNsITUfVB36G00baBtaHCYewCA' +
                    'OJO4nMSyhMAU1ITm9PKI/o0GeQnlCK0G2Piw7qTZXMWcrEiWVHiwYERJ6DJQHgQNWAB7+0vxi/L' +
                    'D8k/3Z/k4AuAHeAo0DlwPWAjEBmv4T+6n2dvGj617l4N5k2CjSaMxZxyzDBcD9vSC9bL3RvjPBa' +
                    'cRDyIrMAdFu1ZjZS91c4KviJeTC5IrkkeP34efflN022wfZP9cV1rbVSNbi15DaUt4Y48ToLu8m' +
                    '9nD90AQIDNoSEBl6HvMiYya9KAQqSSqoKUcoWSYTJLAhaB90HQIcPRtAGxwc1B1eIKIjfCfAKzg' +
                    'wqTTZOI08jz+vQcpCxkKWQT4/yztbNxYyLSzYJVQf3xizEgYNBgjYA5EAPv7Z/FP8j/xl/aT+Fw' +
                    'CEAbMCbwOJA9sCSgHH/lP7+fbV8Qvsy+VO383YiNK6zJrHWcMcwP29Cb1AvZG+48ANxODHJMyd0' +
                    'BHVRtkI3SzgkOIf5NLkruTI4z7iOuDu3ZLbYNmQ11nW6dVm1unXf9oo3tbibejF7q317fxIBIAL' +
                    'WBKYGBAenCIfJo8o7ClGKrcpZyiGJkgk6CGgH6cdLhxdG1IbHxzIHUMgeiNKJ4cr+y9tNKI4Xzx' +
                    'tP51ByULYQrtBdj8UPLI3eDKWLEQmvh9CGQsTUA1ACP4DpAA9/sf8Mvxi/DD9bf7j/1kBlwJmA5' +
                    'cDAgONASf/zfuM93zywuyM5hHgjdk801zNJcjHw2rAKb4UvSm9Xb6WwKzDcceuyyjQo9Tl2Lnc8' +
                    '99v4hfk4uTU5P/jgeKC4DXez9uN2afXVNbD1RzWetfs2XPdAuKA58Xto/Tg+0ADhQpxEcsXZB0S' +
                    'IrslUCjRKUoq1ymcKMgmkiQyIuIf2x0=',
            ),
    },
    {
        name: 'mpeg2-22050-stereo-32k-id3',
        arguments: '-b:a 32k -id3v2_version 3 -write_id3v1 1 -metadata title=...',
        sampleRate: 22050,
        channels: 2,
        sampleFrames: 22050,
        referenceStart: 2048,
        referenceFrames: 1024,
        bytes: () =>
            base64Bytes(
                'SUQzAwAAAAAARVRJVDIAAAAYAAAATWVkaWFGb3JnZSBNUDMgZml4dHVyZQBUU1NFAAAADwAAAEx' +
                    'hdmY2MC4xNi4xMDAAAAAAAAAAAAAAAP/zcAAAAAAAAAAAAAAAAAAAAAAAAEluZm8AAAAPAAAAKQ' +
                    'AAEXIAEBAWFhwcHCIiKCgoLi40NDQ6OkBARkZGTExSUlJYWF5eXmRkampqcHB2dnx8fIKCiIiIj' +
                    'o6UlJSamqCgpqamrKyysrK4uL6+vsTEysrK0NDW1tzc3OLi6Ojo7u709PT6+v//AAAAAExhdmM2' +
                    'MC4zMQAAAAAAAAAAAAAAACQD3gAAAAAAABFyj8ALawAAAAAA//NAZAAF2F9mK6MMAQZABvJxQRA' +
                    'ADwD3ABd3d3f92eTJp3ZMAECER/+7u7u//3+IBgYPv/lwfB//UCZ/SCHAb+c6f6NWAQWpHsBg+D' +
                    '8osHw+8Rn08QHO3B9P/KBhrU33f21ogTgyyiH/80JECwT0Y2oAzDQAieFC1AGSaACIJNRpGK822' +
                    'K0W/1/qSFgFsqHsDtrF0F82Kgrv2kl5eMeshonU4CUGAgkCkmqIb6UFVqf///0kv/MQ6hZUUcR4' +
                    'r/EeK6qAMfSF8OUO4PaBsFAf06D/80BEDwSkY1Yw6kwAi/kunQHVoAHZ0hEjJ0Ult//+lWTJMjO' +
                    'Al8CehcT4iAcD/1OozKo/gOGgGvheAMHgUARWJk1ZT6Lf////9Rk5iGBQMAxAVRBtxJGJFSiKF9' +
                    'QCAsmJkTwnUDqcaP/zQkQNBIhjNBBaHDqLKTKJoA7qaAHJJHnb///08K8oGRqTGwwFzwP73UtiQ' +
                    'gAKB/oyO5QwUkqBaY+uXFAEIMmCw8Tpsi9SP/////7oE+AYOQWvZIG6ahut+dAwPomi6RUNXAe3' +
                    'U2gsBP/zQEQQBPRlMABS3SyK2S6A4BdqaoeTZn///9eFeABUVyggDBCAQGz6/J+8sQEH9M4BG38' +
                    'XeWUMMRzOKR6IhZLUPXQHVLVdv/////s54thaSFQWPBumoVkX1AIemKReFygcADHB2Ssz//NCRB' +
                    'AEQGM4EFLcLYoRMppQoCkI////XrOYIRWUB0wA4Re5vZfVAhAA4AYf71qWcJUU4Cl0DxUhKgRBR' +
                    '3FU2RfWr/9jYChIHyiEN1qFZdUXzBodVsaVyj/dtVXTvW///+tSZQCEXg4C//NARBkEOGM4EAe1' +
                    'FYgBMrZQoCcKgYCSIK5cbx9UCIAKgBh/XsnTQL4XQALQjCKalqX2f//CAQVUSLrUL10XyBgd1cq' +
                    'ZrJ/U7SoZ7j////WpZQCEXifQMCC0GdMbJWZYAhQADoAA4H//80JEKgQ4ZTgQB7UUiJkyuxiQJQ' +
                    'i1S61FkJ8BrZTGkaui/Uv/+oIICpERdaQvT6oXzBIcVsaVrR++/6op3Jv///rUssBMXjNgYEGgL' +
                    '6YYJWRWArIDwAGA/q3QoJoDnginEicXRV3b//D/80BEOQRAZTgQB7UUiIE2xligIQqQHiD1S8iX' +
                    'gtSNt/qAEByYpF4QlA3oIiDmlZF/W6AqC1GswIlhfJN7PYrAWEF4ADAf7qWYVLOAWQHYSAtTZkm' +
                    'fWr//CQMIVqZMbCMRtvX6wAQbGf/zQkRIA+xlOABYHFaIwTbKWGghCiJdEJgN4aRQ5xVSb1u4VB' +
                    'WLBcwI5A+3PLPYrAaoKcADgf1qoG90HKgPUW4mUlpLVs//+EQUhASYaFIOSJF1D+oAQFZikXhZo' +
                    'GzxCwbCVjV/91iQOv/zQERZA/xlOABYHFaIqTbWWJAbCjQjAEADWc/NoWBYgXgAMB/stRmpMwOh' +
                    'rA15FxtHnRdtX//CMgLWTBoWyQG+6vrAwAg0LyJdEdAbo1Bh9iqk3+6xAIRYhmALED3k6tNiMA0' +
                    'QL4AG//NCRGkD7GM6UFgcVojBNspYgCEKA/Wpd0HY3YrBVw7S8jRV3Z//4FggByx6Fw3EkHX6gM' +
                    'AQMy6kXhHIG45UAfUrIv/jWIAyJFMAZIFp5+aYGAsQLwAFA/3UswWgZmAa8LdEUGyfZ2fX//NAR' +
                    'HoEGGU4AFgcVoiRMs5YmBsK//wFoUBhy4gbiaFt+sDAKDAvIl0R0Bt9V6HvFVJv+ZDgREi+BNwB' +
                    'xk7tMDAfQGsAAHA/rVY3ZzSiCAEqHqkikirZ//8ZiMHPJQuF8KApKg////T/80JEigP4YzgAWBx' +
                    'WiLkyyliAGwpgIF9LlTLxPZrYRpl1nL//locA4kawZ1gFun9pgYDsACkAAoH92qTUmYDrBJIBkk' +
                    'IuMVZ52fqX//QBrYH8ImaIJjUP1fmIGn5EGIqMqA8AgHne4IH/80BEmwP0YzgAWBxWiKEy5nhoG' +
                    'wogHDhLyL///+3b1GFgTAyHmAnkGm4NMNhqlyJBIAQD+is41uchazTEo8P6iUBDUwOAGGw0XTJF' +
                    'W3/////7JkUAJNQItIRM0QTF46r6QGCALpFSeP/zQkSrBChjOFB0HFaJeTKueKAnCHOAgAEDsFT' +
                    'QCaQY1Sb///27Yn0vQcd4M2Ix7BRpMqqlSf09V4g+7AC84EDxiW3nda8YwBxEgE2WzEuePs6///' +
                    '///3Y3HYBgsrAjigo5OGBmGSJV+v/zQES3BWxnLgBS3SyLsTKFoBcqaCBgjC0RYnSAgRAEB1bq6' +
                    'BKIKXkX///9s7EvUACDvFNkMPAUeGaqlQgAKB/Mmneo4SroxAVz8hAMLgAwYAV3P6Xi6kjZJv//' +
                    '///s5VAJBoU4JCmi//NCRK8FCGUwAFodOoyJMnQgDypOCxdKF9QGOYl0vE0GQQNvDsg6UnkUv//' +
                    '/t3CnQQCxHlWOjI4Ao/cqDAAgH87KQPKIbaQIQMwqqPkowgfHiN7KM87av/////7JE6AkkgpdSS' +
                    'ZSxuNV//NARKgFAGUwAFodOouZLoWgDypoAJAz6wM/DZGlX0dI3OklGbSP///0KBfBIBAoWwT0A' +
                    'BVQJukCwgLAAQD+pFFI1skaheoA72QUgyKSKXSRf/+EJhWRpHlGIiRoBAj5GBgR2bUqWBP/80JE' +
                    'pASAYzYQUt0siwkyiaAW6mi0tkZLTYpf///QTQL4IAgChnAjxABwYRciBSADwAKB/QetBMuEPE2' +
                    'AEkcDQJCC9gcwrs7dP/+oxBOOCnkZI1UiH+KlBAz6wM+DZGlX0cv4S06lyR//80BEpwRgYTrAT7' +
                    'UiiTkyuligJQr//+gtAvgkEgWJYD7UAqJCfIgegAMgAGA/rSSRSuiTQCxUD5DhZQnEnkUketL/+' +
                    'sIWILKSDIuiLUWlAKAwwCBGzlWZib9VopbLsUv///oUDMGgSP/zQkSyBHxhOHAHtRSKcTKeWKgp' +
                    'CBwvAXjADYkImJAqADwAFA/Um1SdNAmwQCANUJHeSbUHbQT//rCdRDRZx0+VRNw3mQBgM/A142R' +
                    'qsyN47DZdS5I////QWgZg0CwUEYCXcBMuEmqBYv/zQES4BFRhOnBPtSKJ+TKqeKApCAVgAMB/Ui' +
                    'ikjRMjEL9AHQxzRYjVJFLqR//rCNlUS4h5uSwzQqmVDAgwIBOzlTLJODM2YLTYpf///UtAzBoIA' +
                    'oHgBW0Bd2D2eWAqADwAFA/Wg9aF//NCRMAEUGE8wAO1FImRNrpYoCcKBMmAQhQNiEGwRBOmh02/' +
                    '/rCNx3iuE2blQc8bzAAIwBABQAyxqt2NRYtR+jNZH///6qjMIAcHiAXLwLgAl1QIwAaABAP9JJF' +
                    'KpEmgKGQOcSGWE4l5//NARMsERGE8wEu1IonJNsJYoCUKFJHrSb/9YQLQWDitCLl80FfISvpAaZ' +
                    'SREvECBIAoGyC0gapJoxSX///6t1I+QCkNAUYJkkRrox6Q3+LAYgB8ACAfkNQDwp4wysAGB2hmi' +
                    '2wekzT/80JE1ARQYzpwA7UUiZk2uligJwoWrb//////UZglVBS2QQvpoDPlqgvogf+FYukNBMAA' +
                    'Go2gIYmIqZL///+rdyPkgiQEYHgKRma0KdtKgWAAcACgf6KKRipZSGdAXIQGhR2I5CzRBTb/80B' +
                    'E3wQ4YUEgA7UUijEyrligKQpFJtSP/6jMEooKfxcBPl8uB/yrC+kB+yVS8Q4GgAQNLVEAyyTRir' +
                    '///6t3KEsCIiIYHk2LmCxadtCwKQAeABAP4MYM6SNsMMFMz4TQoCGIV8Fq7v/zQkTnBQxnMgBS3' +
                    'SyKyTKeWA7oaN//////QMwKOwXbjIE+ZmAiZqoL7AYIQKFYukNBqAADRPR0NXEyZL96oSqIAkEB' +
                    'gehYaTLNpbaFkAQD/dSzhZJQXoJgQDAzhA58yAHgoAYohjIZEv/zQETnBMRlNFBO3SyLMTKeWKg' +
                    'pCHjVJq0v/uaE+AAYwRfcdhumgKe1///8jBKAvgWHnCGAFTNajAQkw1VDL///6buQSOjwBiUMK5' +
                    'vPwALQOdWXWRhAYf1yAcYctUhgCAZh0RRzsSZE//NCROcE0GU0UE7dLIr5MppYDuhoNwFANukfO' +
                    'HVLs//////2c8SYGAgiDy2Ng3TOCKrV/AwJgANjUmQ3QGU9/Yyxipf+qpCIhYcGA6WD4i61LkLA' +
                    'zAAZAAKB/tUtSzg/gmqA2KUfw+xV//NAROgEpGU0UFgdVovhMoEAqCsISRfqR//uGLApiIQ3TUK' +
                    'y6v///IwTAH4FizpDgC5lMRwI8xKrW3+NaIiMYAEdBhHs55IC6OTuy6lCSAw/pY4BG3IWOAgAMP' +
                    'RpOjR2EhtEQCNhjxj/80JE5gV8ZywAeF1IjBkyfOAXamicWq7f/////ZI1IMBgBMAXGQ2T61CWm' +
                    '9UAz8A4ExsakyG6Ax4wHC6RDTJf+WI6FBIsAXVgcwu9ShIGYADIABQP961LUdH4IFoGeTDoD6lZ' +
                    'FJutX///80BE3QQIZTgAWBxWiUkyqnigKQhIGh4HTiIutIXp9f//5fMGwBdvX6ZEOATmSddMX1e' +
                    'KZBKn//+z8tQ6CQVjDEAIMCVUsy8AMS8TXY1ShJP3rtJG3cYmgoYHgKY0Dkf0EaAi+IAXUP/zQk' +
                    'TqBShnLAB4HVaMOTJ84BdqaOdGJTNbemf/////0kTImRNwGBM8B0UBC4TZEvB/STX8CQJisalEM' +
                    'mAxDwPHUYqX/28OgASNgV8oCtL/UoSBEAFQAKB/dql1nCPCNgBZkPFuNXNXbf/zQETjBBxjOKBY' +
                    'HFaJaTKqeKApCEv/+oJYBwhBUyRJ4MWjbdX7DAmYTFnSJAFzC8kAUVj104tX///dj5IAJAQAEUA' +
                    'DALGUDH4CMQGICTRiVDAAoAFA/kdgtyx+1qGGQGeHCAkJU9n1//NCRO8GBGcoAHheSI2ZMnAgB2' +
                    'o0mjFJe7f/////qWRwNFwA0ThSJQPFYUiMVw+B9TC6wNOsOB8wJAtKoDAMYnEkY+cCYskGYzhaD' +
                    'gLZUihAkxDmPf////1IFMi4zYYsAAAgGUBYBjne//NARNwDxGM4AFgcVomJNrZYmCcKgYoDgIgw' +
                    'RMsldBBkENOghQQ+gsuGjfgyABgAQCAXUAD9NRMJpqMCKD+FjYGX9gVxAHCwscFADspvoILTT//' +
                    '/Wm9N6HoJpmAxgNyAIcgbFixoIGb/80JE6gV4ZywAB9YUjBE2jbgPKmgfP/gh+Xh/D4jP8P8u+t' +
                    'WAAAAVCIECAVCoVgAAADMwDgCZZEAwIQImsNLTKxjhyYN3jTU6PY4Tml3MBCAWzMkvBt8MZiDCH' +
                    'jjS/4gAURxidDUnxmH/80BE4gp8lzoMrtQAkhkqmb9UoAJJJUkv8qJkEJxiYJxAwpav/5OGhwuG' +
                    'iRcND5gaZ5WgrAILHw3EoKFg+AAAAGyQHJUyxAAAxRe5cD2VJYpUvuZOjwy6AFhv5kkjyqbqN1J' +
                    'JI+gaFf/zQkSYDFz3bS/JwAEZAesGX5OBAsoEE1ot9MUMXypoLZL/5IJjmE4xFCcNDBJLV//EFB' +
                    'wEoKAGQIsK0HASQyg4JaeUTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/zQ' +
                    'GQlAAABpADgAAAAAANIAcAAAKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
                    'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqVEFHTWVkaWFGb3J' +
                    'nZSBNUDMgZml4dHVyZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAP8=',
            ),
        /** Interleaved int16 samples decoded by ffmpeg, scaled by 32768. */
        reference: () =>
            base64Bytes(
                'lt8DNOjaOTAQ2H0i4NhFEF7e9AB66O/5EvbX+zAFRAKCE0sG6B5XAvAlS/UvKDfjWCZF0wMi88t' +
                    'PHaPPTxpe24cafeiJHjzw0CVh79su8eeRNwvgvT2H3p8/LudZPJT4KjS/DFwoPxz5GhciTg5OHl' +
                    'wEyxVh/p4PivwREfL9xBreAEEoLANlMugCMzPC/hkpb/bOF7zqZwZi3ZT7ndAc+qbGff8owWAF2' +
                    'sAlBVbFmPs0zcfqYtYD2ajek8015NXMEOb41VLkdOMf4A/uXdvC8DTYaOuI2Mnied3z3RrnVOJj' +
                    '9LLwcwOnBPoR3xbLHe8gXCWuICIoQhmwJlERiiJRD8Qd+hV7Gr0iSRofL+AdMjTYJFguyy08H6k' +
                    '2/Aw6Per+qj+z+f087/xQNX0D0yleBn8coQCgDyvySgXj39P+ItGK/NnLqP1s0YQA+90CA4rqHw' +
                    'O98HT/Tu6W9zTmMuwA3+vePN/20czpk8dD/IPBFxCewAYensTjITPMuRxZ1SAU1t0bD8XjPxIP5' +
                    'iYdr+ScKq3gZTPd2ycyathRJkXYdBSq3N8Dy+XA+sDy6/q6AfMAbxAoBqYcTAS9JBX5CyiB5wIn' +
                    'W9YPI6bMQB7ozbQaVdgdGs7lSB007+4jQfDBLMrpvzVF4a08xN2kPwrkjj3l82U2Jgg+K1MZAh6' +
                    'NIfsQoR9HBowXWf88EJ78vg9t/eEXMQAyJdQCzTBLAxc0FgBNLKz4DRyb7fwJb+BB/VPTw/mMyC' +
                    'P+8cGdBHbAQQb2w87+PMsh71PU2dz+3GbPSeMczALmZdMC5ZPgOOFu7GXcGvGw2DvtGNiq5PTbT' +
                    'd6T5EngLvGe7AsA8P/mDj4TfhuKHxskgCHyJyMbVyecEqAj0A7NHo8TAxt2HwYaqSzBHPEzDSOn' +
                    'MLgrOCPMNPwQDzxeAYo/+PkKPqD7ajcXAqEscAaEH+kCWRIp9ksHFuTk/9TTsvwEzCr9Qs/N/8/' +
                    'ajQIQ6FgDKPCZAKTvp/lQ6PLuNuDr4ULestRz5pDJmvdtwtsLXMC9G1bDECJEypweQdMfFhHcrA' +
                    '+y4rgQ2eUjGj/lpyez4Scy59x+M/rY1yn317UYS9saB2bj1/uf7/P5Uv4p/0cNOgU2Gm0FUSNQ/' +
                    'LInsOuNJ77ZHCTQzVEfg8xVG0nV+xnI4kocvO07Iufwtird69gzNeNnO/zdYD/T4XY+ye9jOLED' +
                    'AS5AFg8h3yDOEx4hcQjhGZkAuhHy/EMPD/17FYv/FyJhArYueANSNCoBBS+u+jUgVvDXDXrjUP8' +
                    'p1ov5scpt/ArDAQNiwEIG1MIHAWXJ6/I/0pzgLdt00R/ilMuv5avQeOUW3S3i5+ln3ZvwRNmj7t' +
                    'bXteah2kvfN+IL3wzuHumV/F77ogteD+cYyx2CIjgibSdqHbwnyxSQJGkPzR8PEp4bnxzlGRYqx' +
                    'xs8M1whhjKoKRwn2jJXFbg6eAQxP9X63j6G+lk5XgBcL8IFkiJZBDcVlvmFCTfoNwHn1hj9vMzb' +
                    '/HfNL/+S1x4CFuWGA93uqwFp8Kn7S+qw8cbh/eTs3ZXXsePEyybzlsNXB1XA0xg9wpQhcMggICv' +
                    'ROBg62rYQguHGD4LleBe15ZwksOJrMPfdMjSf2e4sx9f4HAnazgoW4ab9guyg+dv6pv3/CSEEmh' +
                    'cbBrYhIf8xJ8jv/Sd53SEloc9tIMTLDhyU0vYZnd9lG7brlCDd8KYoce3ZMQrl/Tl53vI+AOA3P' +
                    '+LrSDoF/7wwhxIpJFUfvhbcIb8K2hv6AVATWv0rD7P8dBPP/g8fxgFOLHMD+TMJAjYxhvwvJPry' +
                    'BBKE5hkCFtkv+vvMYvtMxK0Bb8A2BsLBHQOEx8f2DNDc5C3ZZNTA4BXMLuXJztTlAdoj40rnid6' +
                    '57w/ap+/Y15/ok9l84BHgK94G69zlHfmg9kMI0QolFgAbuyDWIccm2R4YKJAWlyX3DwMhoRCBHK' +
                    'sZExoLJxEbwjHVH5gzoCd9KsowshkmORIIjj55/Gk/IPoROwP//zERBa0llAU/GOv8/Qug7MkCs' +
                    'dqr/WvOmfyQzHr+1NRyARjiXgMq7WECsfBc/QTsPfR74wfoCd6Z2mXhOs7a7hHFegKdwB8VXMEk' +
                    'ILDG4yADzwEaMNjkEQvgLA/j5AUV9+VlIZnjGi4d3yA0gtpoL+7XFCEm2egOF987AJjpGfpt96T' +
                    '8lAYcA7oUjwbGH7sBXib98zIozeEMJmzSmCEOzPccmNA2GqXcxhpl6SAfTPClJpvuwi/R5lM4Q9' +
                    '8pPp7elz816Nc7HPpAMxIOMyfFHMgZpiFIDUAdqAPQFA7+WQ+O/MARLP4cHBwBmSk/Aw0zqALVM' +
                    'h3+6Sdu9WsWf+mFBRvcmvuCz+765cWHAN3A7QUGwbwE4cVC+vPNCukf15rXNN8LzXHkQ83z5fDW' +
                    '7+NH5J7fK+7v2gHwDNgq6sjYu+Et3rbdMugl47v1TPLUBGQGLxMTGKceQyHJJUogJCiyGGQmORE' +
                    'eIhAQbR10F2UaaCSNGkswfh5jNLYliS28Lt4ddje3C7I9R/6tP9D5gjx2/Ww00AOuKPMFTxtO/5' +
                    '0OQPCaBAHeh/7tz5n8oMvw/QTS1ADb3icDEevwApPw3v6K7Z/2VeX56qjeot3V39XQT+vKxjj+M' +
                    'cHREcbA/R4pxfkh98xHHCHWwBNv3lUPDeQ6E/3lkB5S5NUrK+DUM2nbjDE42OYkedjUElPdrgLe' +
                    '5ln6GPQu+yMDXwGyER4GlR1vAz8le/cgKLLlxCYE1awiQszqHX7Omxp22Vsa0+bhHZnvyyTs77c' +
                    'tGemWNtfgMj0f3rY/U+UgPcT1ijX1CR0qdBrQHL4h7w8aH4wF3xYB/wMQovxDEK399xh9AEwm+A' +
                    'JNMRsDoDN+//sqr/dmGlnsqAgY37H8INL2+bHHrP6Mwd4EjcDFBXTEi/32y4DtFNV925Ld186N4' +
                    '37M6uVm1J3kmOGq4Obs4tvO8GzYa+w62OfjjNws3pjlEuF88h/ubgGbASgQcBRwHOMfoCQSIQoo' +
                    'ahobJzYSOiMnD28enxTdGs8gNBqmLUodFDTdI9ovpSzbIaQ1sA+ePLIArD8b+rM9TfymNrgCkit' +
                    'yBl0eDwJPEa30iAaM4n//39Kp/P/LYv0S0BsA8dvBAuHoRgM88CgAAO/V+Gnn1+2t37Pgj96R06' +
                    'PnuMhD+f/BVw1kwHwcxsPmIfjK1B0H1FMVt9xsDxPjQRHk5Tgb+uS0KD7hjzJv3PEysdh9KAXYG' +
                    'RfG2+MFSuRt+9HwT/qk/9T/hQ6XBS8bDQXoIzD73ic86mAnnNi8I4TN7x4qzR8bjNYSGgjkuBxo' +
                    '7vIiyvCRKzjrpzSa4vk7/N2PP67iMD5J8bA3RAX/LEYX7R/9IL4SbCCfB98YHQAHEc78Rw8u/S8' +
                    'Ww/8KI4QCSi9dAxI0tQDoLd35oh4873IMP+Ki/gHVuvnKySr9h8K1A1DAYQYpw10A/sm68fHSed' +
                    '/I2/jQfeIHzMDl39FB5YDeyeHm6gLd0fAM2STu8df95SXb9t4h44HfQu9Y6uv95vznDJAQ7RkoH' +
                    'isjrCGyJ1QcrCfKE08kAw+JH2wSgRtvHQ8awipBHDQzGCKVMYQqgyWnM64TRztfA10/nfqXPgr7' +
                    'pzgZAV0uGwZ1IfUDLBSM+LcIB+e+ADHW9fztzPf8js5k/x3ZPAJx5mQDie8wAUzw0fq+6ZHwYeH' +
                    'B4zHebdbD5OHKtfQaw8gITcCSGZzCYyEVyTcf59EkF9vaERDj4d0Pj+UqGHblaCVB4rswhd2oM1' +
                    'vZnivZ11sbiNqECQDiIv277ev5OPxf/kgLsASgGAUGWSJN/mgnie7YJ2fcwyRDzwogS8zUG77TC' +
                    'Brd4NAbeexLIdzwhSnV7LAyVOSXOjveJz+S4PM+Ku2QOYoAri+tE/QisB+ZFWUh2An3Gm8BlhIx' +
                    '/RMP1vwUFBb/EyD+AR8tbQMRNKcBaTC/+78i4PGEEEDlHQHc1wD6AczY+7vDSAJZwGIGH8KFAjT' +
                    'IhvXe0HDj7Nls00Dh/8tY5ZnPp+VN27ric+gQ3kLwutl179XXB+j+2RTg7eB63j7sCeeF+mD4ow' +
                    'mIDEkXEhx+IfohGCc7HgUouRVBJX8PmiDfEDocghoTGvwnaxssMoAgFDN9KBQpqDHbF9E5dgbaP' +
                    'pb7PT8O+m46af/+MFcFfCQ3BRQXy/sJCxLrLAJS2XD9z82v/PXMuf4A1qsBeeNiAyjuDQL48KX8' +
                    'tusx8xjjy+Yo3mDZXuI6zZbwc8R6BHbAvhapwe0gU8fIIM7PYhnw2FcRkeAoDxflohXW5U8iOeO' +
                    '9Lqje9TMq2kUu4dc/H4HZ9Azg377+vOpg+cX4jfzqBy8D2hVDBoogxAC0JnryIyg74LUlZtEpIf' +
                    '7Lohx/0SMaHN4JG9TqtR888XEn8O6XMNXm/Th+33w+g992P+LpPztC/EcyGRAFJhcelxj8IUcMw' +
                    'Bz8AvkTw/24Dpj8pxFp/nIcXwHqKVYDyzJuAqoxg/3lJXv0CBRU6GkD59pF+nzOfPo6xagApcAS' +
                    'BkTBbwR9xmX5wc7t5+7X09bU3yLNwuRqzu7l4tij42zmMd/i75Pa8/Dv13LqDdnU4eDeLt5G6U7' +
                    'kC/cG9DAGKwhhFEIZhh9pIT0maR8wKD0XISbVD7ghPw8VHVAXRBqZJL4aOjABH5MzdSbdK4wvsR' +
                    'smOLAJEz7//KA/iPkBPPP9hzOABIwnPgYjGuj+lw1V798DGt0p/qnPj/xYzBv+mtMIAcngNQOu7' +
                    'LQCavFG/pntsfUK5dPpod5y3Ijgzs/I7BjGDwDuwGAT9MC2H7TFsyG2zVAb49azEgffxA5d5GET' +
                    '/OU1Hw/kZCzK37UzGdtyMCTY/yLE2K8QCN71APDnePll9R37egSpAeESJwZzHsgCtSUj9jEoGeS' +
                    'JJtXTTiIFzJgdVs9+Ggnbihp+6F4exPB/JVbwei7/6Dk3yuCIPbfeoD/V5pg8+/efNEcM9CgvHJ' +
                    'obcSLcDs4ewQQQFpD+Wg+G/DgQyv2QGacAGicCA6Ux4AL7Mur+PinG9vYXNes4Bufd6foT0R359' +
                    'caH/j/B2AS2wEAFAMU//MDMpOvp1a/ZRN7MzfnjoswC5qfVbORs41Hgl+6O29rxTtjE7HjY++M2' +
                    '3aHeqOZq4tPzavDbAmkEdREFF24dlyEzJaMhLSgaGuMmpBHQIvIOCB4PFaYarCFOGlcuvR3wM5c' +
                    'khy5/LYIfaTbsDBw9QP69P334Rj2J+8c1XQJlKt4FFR3LACMQt/KmBV7gAP8x0Yz8Z8uN/bjQYg' +
                    'B33e4CmeotA4Lxrf+T7/f3iOet7PHfa9+R32HSpOnVx//7j8EjEHLAnh5ExO8iwMvZHeXU3BR43' +
                    'SYPjeOcEQPmJxzH5LUp2ODxMgTcNDJ12J0mI9iTFFTcdQNH5bj5H/KB+RMBmv/eD0wFQBwdBI8k' +
                    'bvkTKADoNCeY1lYjasyAHk3N2Rq21xcameUWHa3vmiNc8WEsMetrNYTifjyD3g==',
            ),
    },
    {
        name: 'mpeg25-8000-mono-16k',
        arguments: '-b:a 16k',
        sampleRate: 8000,
        channels: 1,
        sampleFrames: 12000,
        referenceStart: 2048,
        referenceFrames: 1024,
        bytes: () =>
            base64Bytes(
                'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAA' +
                    'AAEluZm8AAAAPAAAAFwAADcgAGhoaGiQkJCQvLy8vLzk5OTlDQ0NDTk5OTk5YWFhYY2NjY21tbW' +
                    '1teHh4eIKCgoKNjY2NjZeXl5ehoaGhrKysrKy2tra2wcHBwcvLy8vL1tbW1uDg4ODr6+vr6/X19' +
                    'fX/////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQCoAAAAAAAAA3IL/VADAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MoxAAc2hqsdU84AAZuA2AXve9' +
                    '73velKUpSlKXvDfv4+/d5U/yDiFhqxDyFquu8UpSmv/m99//mGN/+e///+YZ//+YYYeeeeeePjc' +
                    'H4AADBIYfG5M8HAQBAEAQB8HwfB8CAh34PgQEDmD/R8HwfB8CAgCG//wfB8CAgCAYvB8PqgAFAw' +
                    'gBKAoAxwoIMvCkf/+MoxA8hGzK9mZSgAvIqQEmhzv8QGHJA2QYA4FJwD1lg+kdYHaniDyGkFIqZ' +
                    'F4vf/jki5RcpNEWIsYl3//0epJJEul3///UkZGJOkaAwdIiXVJJedAqVACXjib9RNg3JAOvG7cx' +
                    'LpdSLyS0UVJPR////88ovJzU4jKKSRDjExICXi9X///4ywCQAwDAGwBQB/+MoxA0f0ipIAdewAE' +
                    'AFgMABAIgMBXArAMDfAvgMDtCKAMHDQ3AMLmCCAMFzApAMB1AeAMA3ACwAQBcDAJAA0DABAAcMY' +
                    'H////////////62yiQQg4dQG7wMAACgMDYfwMW5OgNilmwN14xAMH4HgQAjAwUATC00P8HLF5Ei' +
                    'p5X///4pELBAYAB4GEwoBi0X/+MoxBAcWi5AAK38mAGRieBoVQAYKQEVgZZigrgYyADXgYIiA+A' +
                    'YDIARhQA2CQAKACADA2FCzxc////////////qXlanZE9rFkIQMBcYKwLJgtCmmcdR4ZSImBg2As' +
                    'mBSBEYBgBZZJIlnVLlS2uK///14CMAMLAGEIAI8A4YIYEphPBBGM6Pme/Ha5vqjHmL/+MoxCEdI' +
                    'io8AAesSCBDGE2CWYKQHgGCAFAGBEC4AABgFwAl3///////////+gmeLI5AjsLXADQDgYBAPAYG' +
                    'wqgYWijAFFHA762EA5VBSBYoYFgygiBECgARDhgEHJs4uv//+TtBRGBQBJgDAMgED4EBLgEhowk' +
                    'P9jBDGoJAgwoBoYAYCYCgBwWAYF5iYn///+MoxC8Y6ipMAAesSP/////////+tS2NyIDjE4BgsA' +
                    '4DgGEUBIGA0bQGRvz4GKYaIGBsGQGAIBoN+DLorYgJkxs1///+M6GEgFg4GDEAZssBskoHtnGIs' +
                    'JSc0chpqxBwmHSBoCgrQcBuA8A4IQBBfEOiQ////////////2SMimOgV8MgARASAYCoDAaM0DDc' +
                    '/+MoxE4aQipIAKesgBjA4hDGA2jgwAw4ANACCMAwBEMFCcRpFQwMUv//99FzpeMvSoMBEB8wQgY' +
                    'jDJGDNz6600CxMzCuBeMEcC0wIgGjAIAKAQA6KCw9n/////////////1LUmXCDiyAy2DYIAwJgP' +
                    'AwmBaABGCBjb8IBjQGICYKwQgGDIInodJHGbnn///+/+MoxGgZQipMAAesTESEeg2PAYGAIGDA2' +
                    'Bg8fAYcSYGAqhBQGGyHvgGDtgzQGAdAPoAIBcBEALC94KABIXKEGn////////////98atahgxqq' +
                    'Uw4C4NJIxZJo+P+M6wHkxfB4wcAcHAUj6wZ+aO6Eqv///i9DHgKBwBQwGXGAbQaB8ThiTBDnRij' +
                    'ia2QL5h9g/+MoxIYZSiJMAK36mQAcGAYEoBIAoDQaAGDBodZD///////////+tB0CLjKCC4WgAY' +
                    'AQDgYGASAYVxTgYNBTAaiPDgaExcgYKgQAEgBD0BZ5DCbLhoOq///38WOhonkQgFGAOBuYGwSBh' +
                    'akKm1F+KZ2Y0phQBDGCGB+YEgEhgHAGAIBcugpvZ////////////+MoxKMaUiJIAKesgf//rSSL' +
                    'peIqLmDEIGAEBAGCYOYGFQdIG2jZwGoUZQGF4HIGB8CQGAYAIN3B8ozRqZGqVf///jnBq0GygMF' +
                    'AcDDAjAxGRgMgJ0DAqwiYDGJkEADDawa4DAhgIMDAIwC4BwAGG/AMAAoWPBqk3////////////q' +
                    'T5diDhrkQTgQAowEQL/+MoxLwa2ipIAAesTMwRAyjBXBNM49Ywy0AcDBRAFEgIE42gPPFJfXwV/' +
                    '//////////////Sj5IAMSAKgUBAwJQDA4KkwswCTHECCPzFHo4hAbDGDAnMKICAwTQKwMqlAAMA' +
                    'VEg0BHP///////////6zmNmjhDfqsKwBx4EUwdQNjBZGGM3PD0ybBazBtBqM/+MoxNMbEiZIAK3' +
                    '8mAqAtMBEBAwAAA0JTDZVZl1nqv///YR4A0AwRCAAYXAYLGwBqFAx5KDA0Q/Mx6Z1PMRHDIzAwg' +
                    'Q4wF0CFMBCATAMFQHgMFIBQFAWANALJH///////////+maGxSGfD9AsnAMAUBgFBOBgaDEBhZLy' +
                    'BjGB2B8IjOB17AyBjEACAMIoBgG/+MoxOkd2i48APU8tKBIBwXJEyHATB1K///9wxsAAAEgYAmA' +
                    'PAYBYAWgYCcAsgYDeBHAYGACMgYOWHQAZ5813AZEWFsAYL0BygYEeAqABAJoC7AOkwN6AMQyJ//' +
                    '//////////1GdyjfhdaGgKADzAGgAYwEcAlMC+AejAFgfMwUhDiMB1B6DAOgI0wB0A8MA/+MoxP' +
                    'Qe8io4AK/sgCABsCgBBe1gUlo5Da5V///9QN7gOAFAEgEoEQBgA4BiAwHwAmAwQcCbAwooJSA1Y' +
                    '1GcAzBwHgAwjUCtAwPoBqAwIcBhA3MkDPMAMKZAQQJr///////////+x+diLYFljAAAhARBgGBg' +
                    'Bg8mA0OcYiYnxyzqGm50G2YjoKhg4AUmBuAg/+MoxPshSi40ALz+tGA0AGEAJJct/H4lSv//t54' +
                    'FgAQHAH4GAgAAIGArgGAGAqgTgGATAmIBATkBgQpAGBiyXVaBhkIzCBgTwRkBgNoIyBgOAE8B4n' +
                    'QHrEgMkALTxUW/////aq3/7ev//7KKZDKeHExwEAAGAHgBpgEQBAYCOAimBJATBgsoPCYEQFvGK' +
                    'qNi/+MoxPggOiowAL08tKYlSF8mAqAbAqAviMAuFABchABk/2APxB9F3//1////1Xp6ddv//or/' +
                    '//3DogEAkDA4cAw4JQMhEEDNJgA2AuwMHRCdAM+CScgMizB6AMGGAjQMCZAIgDgGwBwAsAAALgY' +
                    'ACAEAGAApP////////////6NNKoi8TPUlhEAiAQPDAoEb/+MoxPonoi4kAL0+tDC8FnNqCQ41AR' +
                    'KjDKBhME8CowJAETAPACBwAKl0Jmozav///SDowEAAgAIAeFgAAgBcDARgEIDAqwLsDBvAqQDPD' +
                    'U+ADIcghwDBhQLkDArAGYDAYQE0DVsQM4aAw4kAgET3///////7////oGdibcBTMuAYAYBZgKAR' +
                    'GByC2YTwohhB/+MoxN4e8io4AK38mIf5p/3lGgUJMYOoH5gMAGFm1BGduQ/8vsZ1///9g2EBQRA' +
                    'YsB4GRRcBlM/AZIdYGWe4BgXAw+BjJ9nmBhvgm2BgPYNEAgDHAwCYBeAwDYAMBYCKAkAugSALhs' +
                    'N////+3//////1mUph1+mmrWLomAIgAxgHABaYFSCFGByhQxj66UOY/+MoxOUe2io4AL08tLiBI' +
                    '5ggYF8YDgAumAdgGBgDgAuYAWADIAX6lLvS3v//q////7lfqf///iOwMABACwsWAwA4AWAwC8An' +
                    'AwAcBEAwM4EyAwXQJ0AyBISiAxaUHBAwI8BZAwC8ACAwCgAKAAADguiGJwtDT////////////0D' +
                    'AvkXHQLMC0QBcB4GBkG4G/+MoxOwj8i4sAK3+mCHGyBhZG6Bu+aCBqVJCBiXDOBhDAqH5A2oF9C' +
                    'ybppEAIAMIEAAQK///nhy2q1KMvgoh//+HJ+8JCcwsChYQGJQD6thvlVBwYpy55sKDg4JmFgoYS' +
                    'EBqtlGbQn+szc0TgSK4GKgMBhsGg2PgHAgAYB/7bbRc4ggILkDGYHPKZOf//e5f/+MoxN8esiJQ' +
                    'AVewAV1KMyYLBDxyOcFfAAIoEpsJkVO6KZsTYGChUBgEWCdTIqOgRw6xSAkQY+ASVAMUDcBAADo' +
                    'xHIvBr//5o6DUGs1mgIAYQgAO+FnQx4S0MQh7QtIZdE3DGh8IpL//9BqDWazWa2K1DFIekLlDVo' +
                    'gMMyHyiFhkQ+USkNEQRE7DZE6jFQcS/+MoxOc5M8KVmZyoAKgCy5d9a4dGTrS761gJQlRHR9da6' +
                    'mBIAImpjI+9k5MT2EkiSYu2+q32VtZmdq5ppvU2ppvm1Nb////9Dpxz845B45RqaPADABC0VA+G' +
                    'zmmoPBoqYLAyCoKwaO5YOcRdR7iLqPcRdR7iLqPcRdR7iLqPcRJMQU1FMy4xMDCqqqqqqqqq/+M' +
                    'oxIUdKh6EVcw4AKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
                    'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
                    'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
            ),
        /** Interleaved int16 samples decoded by ffmpeg, scaled by 32768. */
        reference: () =>
            base64Bytes(
                '0tNTwF3PKeQ+4dXXY+pTEu4n8B8BG1Iumz84LwEMj/y1Akn7Rdorwe/K0OFg4yrYfeRIC50mXyI' +
                    'RGrEpgz63NN4RE/2CAev+BOFUw/nGmt7+5GPZmd/LAxckrCQWGk0lQzxHOU0Yk/4IAHwBv+fBxs' +
                    'DDstrj5Ujb29sn/FogkSb6GmMhCjmyPAUfIQGM/voCLO5Py4HBT9br5ZndWNmu9HkbyyeYHC0eE' +
                    'TXYPr8lvwRV/XoDBvTN0GrAsdH+5AvgDdio7ZUVIii8HtQbojCuPzAsXQmm/CMDF/n91pbAHc0X' +
                    '41ji3tdT5+AOaicnIW0aAyw5PxQy3A62/CkCOP2b3RLC3chJ4D7kq9jp4ZYHhCWSI/0ZeyeLPSI' +
                    '3CBWz/ccATwBd5N3EPcW13ITlQdqY3QAAZCK0JXUaTiPIOiM7ohu3/0T/VQL46t/Ie8KJ2P7lZN' +
                    'x22mj4ER5LJ7sbuB8pN/A9ZiLPAuX9VAMm8ezNy8AA1I3lzN6L2BvxqBgYKJ8d6RztMnM/BynxB' +
                    'uz8aQOo9s7TUcBfzybkNeHO12HqUxLsJ+0fAhtWLqA/PC8FDJP8twJK+0XaKMHqysvhXeMp2Hvk' +
                    'RAudJmQiFxqzKYI+uzTkERX9fAHl/gPhVMPzxpLe+uRm2ZzfygMXJLMkIBpRJUI8RjlQGJX+AgB' +
                    'yAbnnwMa9w6va3uVL2+PbK/xaIJcmBRtrIQk5rzwHHyMBh/7uAiPuTst/wUfW4+Wb3WLZsvR4G9' +
                    'EnpRw3HhI11T7CJcIEUP1uA/3zy9BmwKbR9uQO4BPYqe2WFSooyh7dG6Mwrz83LGEJn/wXAxD5/' +
                    'NaPwBDND+Na4uTXVOfeDnAnNSF3GgQsNz8YMuIOtPwdAjD9m90SwtXIP+A95LPY7+GTB4MlmiMI' +
                    'Gn0nhD0hNw4Vtf2/AEYAXeTixDvFrNyB5Unan939/18iuSWAGlEjwjogO6gbu/8//0wC9+rjyHr' +
                    'Cgdj65Wncfdpo+A4eTifEG74fJjfsPWgi0wLh/UoDIPHuzczA+9OI5dDeldgh8acYGiipHfIc6j' +
                    'JpPwQp9Abo/FoDnPbP01fAXM8g5Drh3ddt6lIS6if1HwwbVi6UPzQvBQyS/K0CPftC2i7B7srI4' +
                    'V3jMdiG5EoLnSZlIhwatymAPrQ04REU/XoB3/794FTD9caR3vjkZ9mh384DFyS0JCQaViVCPEQ5' +
                    'URiX/gEAbAG158DGvcOl2tjlS9vn2yz8WCCXJgwbciELOa48CR8pAYn+6gIe7k3Lf8FD1t3ll91' +
                    'i2bT0eBvQJ6ccPB4WNdc+wyXFBFL9bQP688nQZcCl0fPkC+AS2KrtlhUqKMoe3xulMLA/NixhCa' +
                    'D8GAMP+fnWj8ARzRDjWeLj11Xn4g5yJzMhdhoGLDs/FzLdDrH8HwIw/ZXdC8LVyETgPuSu2O3hm' +
                    'geLJZwjBRp/J409JTcJFa79vwBHAFnk2MQ1xa7chOVG2pvdAgBpIr8lfxpSI8k6JTulG7X/PP9M' +
                    'AvTq28h0woHY/OVo3HvaavgVHlQnxRu+Hyo38T1oIs4C3v1LAx/x6M3FwPnTieXP3pHYIPGsGB8' +
                    'oqh3yHO8ycj8IKfEG5/xeA572ydNOwFnPIOQ24dTXaOpWEu8n9B8LG1sunz85LwQMk/yzAkL7Pt' +
                    'onwezKyuFa4yrYgeRMC54mYSIYGrgphD62NN4RFP1/AeT+/eBSw/jGmN775GXZn9/QAxkksCQcG' +
                    'lIlRDxEOUoYkf4EAHQBt+e8xr7DsNrg5Ujb4Nsv/GAglib/GmohEDmzPAIfHgGL/vcCI+5Gy3zB' +
                    'Ttbo5ZTdV9m09IAbzyeZHDIeGjXdPr4lvARX/XwDAvTG0GbAsdH85AfgCdio7ZgVIyi7HtUbpjC' +
                    'wPzAsXgmo/CYDF/n81pbAHs0X41Xi3NdU5+EOaCckIW4aByw6PxIy2w65/CwCN/2Y3RLC38hJ4D' +
                    'nkp9jr4ZkHgyWQI/4ZgSeOPSE3BxW2/coATQBZ5NzEPcWz3IDlP9qZ3QEAYiK0JXgaUSPJOiI7o' +
                    'xu5/0T/VAL46uDIfMKJ2P7lZdx32mn4ER5KJ7obth8mN+49ZCLNAuL9UwMn8e7NzMAB1JDl0d6Q' +
                    '2B7xqRgaKKEd6BzoMm0/BCnuBuf8YgOl9s/TU8BfzyjkO+HV12bqVRLuJ/AfAxtVLpw/Ny8ADI3' +
                    '8swJG+0HaJ8HuytHhYuMs2IDkTgukJmMiEhqxKYM+tTTYEQv9ewHn/gDhUMP4xp7eBeVq2aDf0g' +
                    'MfJLIkGRpLJT88QTlFGIv+//9yAbjnvsbBw7Pa5eVO2+bbMfxgIJYmARtqIQo5rDwAHx8Bif7wA' +
                    'iDuScuBwUzW5OWW3V/ZuPR9G84noBw6Hho12D6+JcIEV/10A/rzxdBmwKzR9OQF4A3YrO2YFSUo' +
                    'wh7dG6kwsT8yLF8JpvwgAxH5+NaSwBrNFeNW4t/XVufjDm0nKSFuGgQsOD8RMtgOsvwnAjf9mt0' +
                    'SwuDITuBD5K/Y7uGaB4YlkSP6GXgnhj0cNwEVrv3EAE0AXeTfxEHFutyK5Ufand0EAGUitCV0Gk' +
                    'wjxDodO50bs/9B/1IC9+rfyH7CjNgC5mjce9ps+BQeTCe7G7gfJjfsPWEiywLg/VADJPHszczAA' +
                    'dSQ5dLektgg8aoYHCikHesc5zJrPwQp7wbk/F4DovbR01TAXM8l5D7h29do6lMS7yf2HwgbUi6X' +
                    'PzgvBAyN/KwCQPtD2irB6srK4WDjMdg=',
            ),
    },
    {
        name: 'mpeg25-11025-stereo-24k',
        arguments: '-b:a 24k',
        sampleRate: 11025,
        channels: 2,
        sampleFrames: 11025,
        referenceStart: 2048,
        referenceFrames: 1024,
        bytes: () =>
            base64Bytes(
                'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA/+NAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAASW5mbwAAAA8AAAAWAAAOSAAZGRkZJCQkJCQvLy8vOjo6OjpFRUVFUFBQUFBbW1' +
                    'tbZmZmZmZxcXFxfHx8fHyHh4eHkpKSkpKdnZ2dnaioqKizs7Ozs76+vr7JycnJydTU1NTf39/f3' +
                    '+rq6ur19fX19f////8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAQvAAAAAAAADkixjRTtAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/jMGQACDS5ZA+jCAEJ+AbyPUEQAnGEAqLu7u7' +
                    '35EREZ4vWMIAAAEI9TgYGLABBCE/nOc/5G///kIc5/U4AAAg7DH//KAmD59QYf/8HwcBAEHEAff' +
                    'o8hJJGk+9AcAYPg+D7wQBAELIIAg6H1CAEz5flAx+/+IAff////BB0uaXCBApQCAQBItyAAAABg' +
                    'LwIvlAfOCchkSyBSZFyaP/jMkQdCWThet/BTAESumLRnYKIAAMUPQ5QzQ5xj/l0upJJf/9H//Ut' +
                    'EjRBf1mQlH7C+Fwl1SSS0UY9t/JhvBoSnQ7ggAgBhQMAAAMAAwF4YvlC+ZF4mvyiToBYFfwFeMZ' +
                    'gKgWeOaOaZF4vf+Yl0upJJf/rRR///////9aki8XRF0qP1ygHn/1x8B5+DRUv/+kkkXSZHUBEAA' +
                    'YhHAH/4zJEDwgExUYE6tQBEcJOjEfBqACLcUBsoagYoA5EBSQ4UCLGz////////60ZkQIRkJuE/' +
                    'AVAQGGxABqIBgBAkT6al4/JGAIAP///whVEhpIjlAEhQDFomA5SywMTC0AIPAYHAgY2FLGy0f//' +
                    '///////////+iYkXMHODNgYUNQAzuCyIQcXh9jMkWPsq//92MSgM+CCAwG+CA4LA/+MyRA8HOMU' +
                    'uAELdbJAqPlgAsC1RmDFYyhFy+aG4vCX////////6t3JKShoYBAEuUt6Ypo+ezACNA0v2Bp2+Q/' +
                    '///1opIl4iogMBgEBKB5AnEA0FENQAxWCPEek8apI//+kIxAkDMPWD5QbkgAgmAwmRMA0IhcAwD' +
                    'AFDLwypNTq1//7Ox0jBXwIQDAFyFADFPAC4LRxchFy+aG4lhP/jMEQcB7TFLABG/WyRMlJQArAt' +
                    'UC////////9W60RGQ2MKAERVMAgHMWahPjghDAeWq/UttMI////0kjEvEyMsF0QMBYQgPxPCwAg' +
                    '3Bo4GQMWQX2IKXkUm//2ceQoF8NqDlQFgCgRCEAtigDBaI4EgJhuhdjUIGT5aPsr//3ZZQGPAoA' +
                    'ADArwYDoQCILgxmCLl80TFMJfjlKRUIP/jMkQgBmDDLgBYHYiRmk5QALAtUAMNiRIEAsw7yU6SC' +
                    '0IAZlsPUoz////RRMi6TQxoYGAwDBLA9qegAwWADDvAZGhPhbyOIupI//9kw4gBoKQceJ9C2oBg' +
                    'OgML9tANRAgAMBoDwv4ITjKEDL5o9f//TZZQHLBugBgZ10B10BAFsxmCLl80TEsJfzKlEYHBBGI' +
                    '+ggDzCPtzcoOS5TX/4zJELgZIwy4AWB2IjlpGaAKwK1OYapSukf///9S0jEpDOgRAoBq1dSA0AI' +
                    'hoGHsFwyRqk3//1imBgoc80IGAsAAMe+YD5wYAaAYuAg5BCLl8Sv//TZZMDlg3kAwO5kA7rAcC2' +
                    'YzBFy+aJiIEv52dUCGiYStCwImAP+mWQeohOjEpm5tYgP////UtRiPoEgGgZvl4BqkvAYXgKjtN' +
                    '/+MyREoGOMcuAFgdiIzqTnAEsCtSm///WLoWcR5kSQgwDG6QAZogZsbBXGQIOXzBdf/+pNlkwLP' +
                    'CwAGCncAHxIEQDAAxZBBy+XEwyQl//92NycCxsFhchgkCgFQAJFgY8wkg3oL8lCyYJjjA////9a' +
                    'jpYGqCYEgMy7fQyMVQMOoEBpGrt//9YpwrQhpAhmguZAyCyQB9yCgGFtJIhP/jMERsBzjHLABYF' +
                    'oaNUkZsBLArUSfM6f/+pOmXBlwtcAwS2eA9BAWCx8XARcvlxMO4W+GcYEYIhxEr9KoEmD3Vm74a' +
                    'oBHblFepmOMD////1LOFkbgNAKgZIHJB+pXAw8AFGybM///1i+DfBzRzhQQCACBjHdgeGCoWnC4' +
                    'SeIifWEr//qXcuDnhkQDA/IoDvoAwLexwEXL6CYiBb//jMkSEBnDHLgBYHYiNikZsBLArUYZygZ' +
                    'BsIFl7EZzCysTk0Hy9DvyynwDzA////9ajpYG6EwKAYl3QiJEQAYHsNo87f//kOC7BwkGEJgIAH' +
                    'AwJpFAxvAlDIw5JNENOMfb//kZOXBzwwABgploB8KAcBYAYuAg5fMEwyQt////////9eq8QGQvA' +
                    'QgwwkOYkRmeSgqLAgzeKT9gPMD//4zJEogYQxTAAWB2IjWJObASwLVD///rUs4R4vAhA6BgZhQG' +
                    'LxmwUJAMQ+z///Y3CgCRsjiE3BAA8CiwwMGIMQ6g1ygOsmDQ+1f/+panNCDhigDBXDAD6EAoCwA' +
                    'xkCDl8wTDJD//+tR0jAhBqBgAAGM8HBgYUh+gHbXBwFBUyELZoHigD////1qWYD7BoAoDEcsMQE' +
                    'IIAwK8lzz///+MyRMQHQMUuAAbdXo2aTmgEsC1Q/yPD6k4fJQL9gYO0IG0wmIKEXLguccwnDdD/' +
                    '3q7q/FGnlrDBRVsOwoBQSAjXo78blFcqADUf////////1LOFkbgQBdAwCgTC34AYCwGIgoAHR8A' +
                    'gFgghoQto9Fo3LI////61GZQHWHEAPBuBo3wcBgFAOGWwMbgIhMC2edv///////vBO8IAVv/jME' +
                    'TbBxzFLgBYFoaNCk50BrArULErdwwBAkxupc7dC0ICRWN1HHdyMU+C/96u3LUgZODgBDBjUuPNY' +
                    'BISAzT4ccgZMGYSAYW////////9SzIoi1AQDGBhBAuDZQGBMCgGJRyQHXEGwAwSQseE4juKp+pH' +
                    '///+6jpQIeK4De4BATAN73rQMDAEAbUAyPhRDayQPs7f/6zgTAODdP/jMkT1CHzHKAAD1jiQMk5' +
                    'cArA7UkSwY0PdBECMDFkP8AMR4KBQBwAxRBYyCEwZqv/erta1IG3L8GCqcgdtgAg0BOrx3ybJgz' +
                    'CQCD/////////WkYjlAOCGBhZAWAMAIDAWBoDDRHgDgaEoDAoAELmhZJBi68ZH///+yzAmxyBN4' +
                    'EAAADABQFkDFZyGoDAKwBcAEADAwTwB6C5BJmj/4zJE+AjgxyYAA9Y2kPJOVAKwLVDs////////' +
                    'usSAEmAKAGmkoCWhMBkBAwyCqDSxAwBwMIsAMv1zopMXctXcrUme9GgwRyKAehwRANs0h8mzA6E' +
                    'QCP////////2SNSLALAhACGGDZ4DAGBoDB5LgDUyE4DAIAEPiGVIsYqT////uozJggYhIFiYGAg' +
                    'KQHkT/oGDICwAABAMlokww/+MyRPUIwMcoAAPWNpQCTlACuD1QuRA3Qdv/9ZkCQAQBgdhc8FzoA' +
                    'AAwMCIMAMTUygN2oagMEACQbnCUSDGqgarV2tTSFs5EAAYK4lwu5gRATrMfsmygdCICH///////' +
                    '/7OeJIAwA4DA/wDgDAAgmAwNXkAy8hoAMAOH7DGkOMVKo////6zAmyACE4WAAwGhNA+F94AwdgV' +
                    'AwAgJA//jMETnCATHKgAD1kQSikZQALAtUSLCmDfCJmibf/9khNoEgrhgoLmQCADgAhAAwjXyAz' +
                    '2iIAwCATC+QpEZ4pm54/UMf/9BZTJMZwZAZQDACDkDDSGUDSkDgDCgD4AIFgYwFICFBHhDP////' +
                    '///901KMDp8FAOACAwMLBgBEeBMAhp4sgihUL7pID////DlRMcsaYpADAQoAykXAP/jMkTjCATH' +
                    'KAAD1kSSUk5QArAtUPqasDIonCxkDFYXAwCBwt7Nygaf//////////////FSDL4fODbgGDgwBWn' +
                    'BZkR8GqCCC2EHL5gIACCACCAgDACcAQEAHpnPC4A+eN4cwMggYdRYWmjJAZOAgKC8OQAxeegFAp' +
                    'b8CQAHPLhEP/GuMmNMqE//+bqZBZv5YGNACF3piDgEDN92EaD/4zJE4QjAx0AIq1QAEsJKfAVCq' +
                    'AMYGFwOIg0/4GEwKK0/gZXEgYJD1xuClBbCTIIKU////Td2TN0NSDf////m6BcOm5XZMnzA0POa' +
                    'eSY7vC4BKeMGPT8QQFDhy6h1gfJugGa0QsdAH0rOBmRGiNg4kD89QAzKjEPT8fxH4t5UIP/+OMw' +
                    'NGSNP/80T////oLTdE3InxuCLA1mADE0I/+MwRNgQ5ZFW38bUAR/rInwBjagAv/F0JiCGNAMYQn' +
                    '/LhoWQ1wFgIBR/AMcQcBVLw4Bof////l9AuHSuV2TK5gaHnNFXKRVbf+qqX11j/l9ACnKAf8BoG' +
                    'BwMoHMBmJqQ7gYQKH+EJybKR9kfIQlyLGJyv/U+ic//Mi+RQiIhYMlCyLUqYo/wviIUJAaRIjmk' +
                    'cUzNkkqv/5UK5eLp/+MyRFgNFQlQAMxQABoqqvZfjWgCwyNzQ1NkTH/8EwKDQkIgEKsCgai0AB0' +
                    'YCgYBUbAAGpe8T0OT4J4AbdHG4N0Ksio70jowqP+OhaXjFSS1/x+HmPAlSSMf/0UH///Um5qbEk' +
                    'TR2Ez//+yKRmbEiaIpLXVmKLJJOr/+J4MOUh4ksOIrJBAtLB6k4nxdepVMQU1FMy4xMDBVVVVVV' +
                    'f/jMmQOAAABpADgAAAAAANIAcAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
                    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=',
            ),
        /** Interleaved int16 samples decoded by ffmpeg, scaled by 32768. */
        reference: () =>
            base64Bytes(
                'jciD9FPaqtJ95QfQluL/6JXZFO8q2rXfyOzM50QKmQ3XIQki9idYFVsgYBH+GeUoviDzMggy8Bb' +
                    '8Pl/7Hzrg/+Uj6ASLCuXpUP1Qzd/+j9Z0A1PuXfz86j3m793BzI7xZ8CJF6rHfSBa2SURPOWHFg' +
                    '3jlC/42eAtpNlFDEfrr/mTCK4D6iAZABcoEt/rINDLERp/3vsfwvD/MNXlpj6F3/Q6Mv1vJXsey' +
                    'gt6HKL9Kw+M/ssdYgOPMzP9jyW/5zgD/838+pLAEAbRxjL4VNif1eTkLs5540/mZtoX8DjZG+HZ' +
                    '6dDk3wY2CewfxyEpKFYXfSEqEDca4SVMH+Uz+y8vG0A+6fy0O07+7SbWBRANGO4D/u7OQf7D00c' +
                    'Dkuz2/cnsM+lH3j/Pfu3NwAQUCMZ5IVLXlhKE5DoU2uM9LdXaRDDY2EYQeejr+TAFRQLlHlcCLC' +
                    'gt4wgi6stfGlvboh418PQu4+fPPX/eZDyV+GQoORxYDkAebP6aD/j9yxopA2Uytf4RKarqawaM0' +
                    'Cn6GsFjBUjFkftQ1gTZIeTbzEDkb+NR27nwhtjM4h3nW+J3A6gEzx3zICgoVRmVImIPjhrAIvcd' +
                    'NjTgLU0fSj3x/gg93/zdKUwGqw8r8t3+HdGs/VTR/QJ26mn/Ve4l7BDf6dHQ6XXBHBCNxPshRdU' +
                    '+FLHjTBKh5JUq1tscMkPYZxTK5ab6uQHFAKocGgQYKGHnJSOczMwaT9hcHTLvzyzk6bk8AN6dPR' +
                    '30UitzGQ0RxB9h/3IQaP0BGMcCvjAJADUsku37CUzTtPnjwWIE3sOO/jPUwNws4wrM8ORg4F3c6' +
                    '/AT2LLkieRq4Pz/+f90G5Ef9CdVG7EjFQ8aG5Yf1Bz0M8MrSyMXPHoBGj6a+7ssSgZ1EhD29//U' +
                    '0y79Ps+JAvjnlgCR7/XuP+C31IbmacLYC0XD/SEn0x0WneLKEDblqyfn3GUz9temGF3j6/tE/j7' +
                    '/MBpgBbwnoesxJOjNahtr1VUctO24KsHraTsA3oE+3O8VLisW3hPsIJoAphEB/YUVTAKtLhsB5y' +
                    '5Q8NcNJta1+f7CJwO7whcBINK34Afiyctx5UHdbd2h8N3XquY34gbfi/xT++IYph12JzQdqiRBD' +
                    '78bjBzgGygzsikBJ7g6bgTjPpr6by/ZBVMVnPlMAe/W3PyWzQ0CNOWXAWvwp/HC4ZrXwuOdw2gH' +
                    'NcKGIRDRIRhh4ccPoOWhJPXdGjTQ19kcGuGo/dH6tv2IFxYGJye/7yclu88jHL3SehvF664obu3' +
                    '6OYbeND/268IwfxLMFrwhCAI5E7f8ahO/ATws/gEYMfHy7RES2Sr6SsSyAb3BHAMD0NXktOAZzM' +
                    'zlG9qF3tfv2Neq6BTgM94h+cT2KRYvG80m5h6fJecPjByuGR0b1jGsJ2YqLznPB3A/8PkEMggFQ' +
                    'hjN/MsCcNqb/G3McAE24lsC2PAz9ILjj9p/4QjFzgJWwX4g/M4oGgHgOA/s5YMhE983NOnX7iAX' +
                    '3+P/b/dV/LsUWQZeJrzzDCYb0vkca9DMGoDprSbc7ls4et+dP3HoQjN2DscZEiKnA/wUjvyoER8' +
                    'BdymrArYybvUYFhXcFvvcxSgA/cCqBO/ND+k33wnN+eUe16Dfpe4J2KTqKd7s3bz1YvI4EzQY2S' +
                    'VHIHMm5BB1Hf8Wjxr+L7clWy16N38LtD+p+XM07gNSG57/lARJ3o782cvIAB/f5wLX8Jj2cuWc3' +
                    'cffwsYe/rvA4B7szBocaN4cD/vlYx4s4LszOdjTJFTdnAIZ9C37tRErBkYlgffLJv/U7x2Bzlsa' +
                    '4ubHJPDvkzbN4LY/WuWMNRsKzxziIYMF7BaW/FgQcwB8JhoDxDO191caHt+N/LHHnf6KwLUF98t' +
                    'H7Zvdjs745UvUt+D37HHYc+yM3CnefvJC7i8QvxSnJE8hHCdDEmsepRQvGr0t2yPZL6Q1eA+rP9' +
                    'f5nTaUAlAe8wF+BlvipfzXyxsA+dtCA1rwyvh356Xgod6uyHj5ZMC1HADL6R3A3HoP6OVhG0Hhs' +
                    'DK32G0o09vEBeXwT/qZDpIF9yPz+mcnUNjxHg/NFBoC5PYioPCsNGzijD/D4qM3iwXYHykhjAfx' +
                    'GMT8fg/B/2AjWgM7NNL5iB4v4oP+v8km/VPARQYOymfx2dui0MflwNHF4eTqBtkK7ijb2N5Q73f' +
                    'q+AzjEDEj7CGjJ+cTeR+lEgQaJSsZItQxrjOeE2A/ffqeOBYBZSHPA6oIjeby/GjMav/e2GwDZu' +
                    '/U+nnpvuMF3t7K8/ROwAUaHcl/H+faRRCa5ZEYR+IkMV3ZqSuH2koJvO3K+UsLnARdIvz92yf42' +
                    'wggIMwAGvLgQCHf8KcyReQjP7zgkTnmAPYi5R/VCfgaKP0mDw//QiBuAxg0yfuNIkzl9QAKzNf7' +
                    'W8BQBjTIR/Xw2TXTYuWTz8fic+jC2VHv/tn33zjsI+edCbwMeiERIgIoxRWWIBgRCxpOKHUgOTO' +
                    'dMdEX0D6c+2Y6hf92JCMFBQvA6nD9jc29/u/VZQMF7qb8ZevN5vXdQs2x8ITA5RZjx8Yg+9hqER' +
                    'rlARY44yUvLNpuLorZDQ3I6qT58AdjA4MgnQAUKOPfHiG/yyAa2d24H7vwlTBH5nA+QN8sOz/89' +
                    'SUaHkMM4RzI/TEPbv4jHVIDYDN6/VAmT+jOA4POwPq2wPYFjsbx+PfXR9bE5NnNp+PD5Z7aTfAe' +
                    '2XDhVuk/5DcGTAiCH64hKCi9F7Mh7Q9FGjolAh8GNIgvCRwGPkH97zv+/XsnAAaNDfbuJv5Szxv' +
                    '+PNMzAzPsPv4j7crpYt7Jz7Hs88BCE8HFnyHx1uESZeTIEw7kvSwU27UwxNgZEfjnBvqHBP4Beh' +
                    '7CAiwoBOQ/Iv3Lbxq72lkeC/B/Lkfojz1S3pc8qPfrKLcb0g6UHo7+vQ/S/TsaEQMiMvf+wSk96' +
                    'x0HF9EM+kTBOQUJxTP89NW42QLkn8xy5NDiktvI8HjYJeOk5ufh0gK3A2EduiAiKMEZySJND6Aa' +
                    'IiKyHTw0bC0lIAY9bf81PZr8YCpVBigQ9/IG/5rRi/3Y0OUC9emm/5bus+xA33XSGemmwUUPU8Q' +
                    'IIufUoBSK4/sRyeQLKhDccjI22EgVVeXi+hQBegA3HGUECSg36FQjzMzhGrDXIB3l7mUsPOp5PO' +
                    '7dyD0989Ir1hiLEQcgk/+tEFP9iRe2AmswRADOLBruvQrT07L5FsIsBKvDEP/b03fdAuPoyxDlv' +
                    'd+P3NvwBdgH5RnkFuBc/xX/ABtCH98nuhvaIx8PLRsMH5sc4zNbKw0k1jsHAj4+Zfs1LTgG8hK6' +
                    '9isAWtQa/drOdQJr580Auu9774HgQdX35aLCBgsVw/chztKJFnHimxBX5R8nIN2XM/DXehnw4jn' +
                    '8o/3r/rgZggWnJ2fsXyQ0zoQb2dQfHFPtTCoW7CA7F96jPhnvki59FWEUIiHRAPoR6PwdFS8COS' +
                    '5LAVwv1vCiDrTWxPk4w9kChsJ8Ab3RgOHT4c7LkOWf3KrdffDc1xHnyuHb3ub7cPpmGDIdYyePH' +
                    'eEkYA/jG/sbsRvqMkcpridtOhMFBT9z+vIvsgXeFT/6iQGc18P8V83qAaHkwAGG8CvyGeIs2Ezj' +
                    '2sODBgDCWCGm0IQYJOGjD7rlAyQ03iQ01NelHbDgEP4n+nD9AxcsBgwnjfBdJS7QTBxI0k8bXet' +
                    'BKL3tqDmw3k4/P+tEMbkRXhfRIU0CiBOj/AUTmwGxKyUCbzF387oSrdlO+pTEaAGPwXcDmc+t5X' +
                    'PgQczk5YbZx96n7+LXEums3xzecfji9ZoVoBqoJi8f0CUOELYcHhnzGn4xOycCK9U4gwiCP9v5h' +
                    'DLWBNoYZf0ZAzDbivxIzEoBm+F+At/wuPTj4y7bH+Fbxd8BL8E0IJPOjRq73y0P/+XjIFbfJjT4' +
                    '17khtt5pAMH2FvwmFFMGMSZ+9Dkmp9ImHQHQqRr66EAmFe/8N7rfpj/P57szmw1dGhAi+QNjFYP' +
                    '8ZRH4AOQoxwLzMuz18xa03Fz7N8bW/+LA3wSMzePp8N5NzQjmh9bj31DuINgB69Pd9t0T9ZHxoR' +
                    'KMF6QlhCCZJi0RoR2JFm4akS9JJd4tFDdFDLE/qvniNKYD5RsTAOoEEN+G/NDLoQB/3gADxPAV9' +
                    '9nlQd6M3ybHOf2nwH4ejMx7HCDeLA8K5swdcuCMM1XYhyUA3TADbPP6+hURDQYJJS348Cac1R0e' +
                    'M847GljmViQa8CY2HeGvP9jk/TVACWsdyCHhBVEXkfwoEEoA4yUxA+AzNPgjG8rf4/wcyE/+ecD' +
                    'UBZLLEu5K3e3OAObL0/vgmeyQ2MrsOtxJ3s/xhu2HDwoUYyR4IT8nkhKeHjsUGBo+LW8jPzA3NT' +
                    '4Qnz/p+Q03RALxHlMC5QYn46j86Mvy/17bUgM38EP54+dQ4YHeHsmb+FjAPxyaykMeZ9ydD+flz' +
                    'xqC4Wgy2NgQKYbbZQY38CT67g1fBa4jjPuHJ/zYKB/UzAIab+OOIrzwPTTN4n8/XeISOK8EfSD+' +
                    'IPgHXBnK/GQPl//DImgDOzRK+kwf3OLp/jLK2PxHwEoGpskn8n3bFNHF5U7RB+J56irZWO7c2g7' +
                    'foe7Q6UkMJRDmIgQixCc/FLIfSxL1GZoqsSEgMj0zYxROP576CznEAAoiHAQaCVzn+/yUzEH/T9' +
                    'h2AzjvR/vk6Wnk/N1UyyH0SsB9GbrIxx+K2m4QkeUCGIPixDCC2TQsQ9rxCRTtrfmdCmMECSKM/' +
                    'vAnt9w9IAPM+Bll4OMg8/A7MrPkDD9s4PI5BACUI58fSQpaGz79Eg/u/pcfdQP4MzD8RiPt5WsB' +
                    'gcyN+2DARgbaxwv2ktnJ00/lNs/44v7n5Nmd78DZReCZ64rm8gjmCyIhESISKCYWyiDHEAYaqic' +
                    'fIGozNjGjGLk+2fvFOi3/EyVbBXsLnuuG/dzNm/5f1WkDuO0L/c3rbecE3rfN2++GwDUWBcf+IJ' +
                    'vYrxEI5YIVbeOuLlLa8C5O2doNKeqr+UUHHQMtIBgBKSi24FYhvMseGjXdYR+h8CkwreZTPgHfh' +
                    'ztO+5Emqx25DD8d3v1FD0r+jBxSAzAz2P0NJ+3ocgT+zpb6w8DbBTrGoPmZ1+vWruSLzdfjL+XH' +
                    '2mzw7Ni84cHouOOLBWcHIB+NISwoIxjjIcIPRxqkJLIeJjQcL90c3j2g/To8tf0QKCAGCg7C70z' +
                    '+sM8D/rjSMwPP65f+de1n6n7eT9Dw6xDBiRJ4xcYhktYwE0TkXhM25EAsPNsfMZbY4hFj5xn60w' +
                    'OyAQoeJgMlKNPkbSIPzHYaIdoOHurvFC6z6GM9L97iPMf2hSk+G1oP6x6//toPv/2jGRAD1zFM/' +
                    '2Mq2Ou+B5/R4flkwQkFvsTS/I7VbNrX42vMkeRB4rbb6PBL2IvjE+aC4SAC1gLvHIggGCgoGvgi' +
                    'Lw+tGnwhch0yNAot4yDbPNT/ez1L/PUqVgaxELnzPP8Y0nz9cNDhAozp8//o7g==',
            ),
    },
]);
