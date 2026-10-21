// MPEG-1/2 video fixtures produced by ffmpeg 6.1.1 with the commands above each entry; `md5` lists
// ffmpeg's own decode of every frame in presentation order (ffmpeg -i <file> -pix_fmt <format> -f
// framemd5 -), hashed over the visible Y, U and V planes packed without padding.

function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// ffmpeg -f lavfi -i testsrc2=size=70x46:rate=25 -frames:v 6 -c:v mpeg1video -q:v 5 -bf 2 -g 6
// -aspect 4:3 -f mpeg1video mpeg1.m1v
export const MPEG1_FIXTURE = Object.freeze({
    name: 'mpeg1.m1v',
    codec: 'mp4v.6a',
    format: 'I420',
    width: 70,
    height: 46,
    displayWidth: 60,
    interlaced: undefined,
    md5: [
        '2760f2afc2f6f67a52460a9b5079f6ec',
        '485bace1c1f2d24dab9ec73707204c65',
        '485bace1c1f2d24dab9ec73707204c65',
        'd82e1dbb24bc108f4f35df466bbbd4db',
        'a54489e5930d98c3cbf1813211e21ce0',
        '1dd60ca7eb8140b559d2098d90be0571',
    ],
    bytes: () =>
        base64Bytes(
            'AAABswRgLtP//+AYAAABuAAIAEAAAAEAAA//+AAAAQEr+cIwCYmAUKDSGoakZgHP6U9P2QhCH6fx2z2' +
                '8BiTABwBUMQGpw1GL4Zs5DxeDX2JQGMxZLAeDHZZ1YBXJQACYhjQGxRQAelJIbZOJiSagYGJThw03hA' +
                '/67BZQaACcAOQMuTAQwUAORmJXDcBQDAGRhxKAyaATOobecANgBsGAGBQFg35JKCSysSiWkM6UZCtwl' +
                'JJJP6yRfRAGgCH4mgMAKlBiEF7YYnEkrBoYEljXR22/3O3NTfJJgA6AHAFUdJRMfb9HAuQ98nH5KEpy' +
                'd8O+u4TQAwAFRCzlgOm3+RgCkB3//zttg3/8VtccBMgl8AxDUjQKhhZQYUNRmALeGEzoDSVt8f1ZlOd' +
                '7UA7QM4BoGochBhSC0DU5wGxLDMgol7/ndXdTn+8YMDSGgvowFSHso4tIBINGHu7hBIDjL58BCAakMC' +
                'pMKLDXL+GsNT0tgM4ol7f/DPsNAcnGsu8AAuAdADQAdBhDDSEgDGDSwwMTnIZZaQ3dOxWKT0ljV8IyH' +
                'ZZ15UChYDoBijpDON2T0ckoShKO3QlCWSj4d9vfQgHRQbgDEAOQMjCZgCjgJxm5SA1IFOGYN6DhgGTQ' +
                'CZ1PebANEAZSAOyGWNAYkwNDCYGEspDcB3yYQuUTQMI3x6X2GcZ+SPfTADMAdAMCGQw0CobsTQ1KAxK' +
                'Sy0Yv9LoDAG36ULLQgJWXu2JGy7tAoAhDf8gZthqcOVt+BlX4R+pW+WSfaEMBMAXAOkZIaU26cjLDf0' +
                'pSchCEfpT+O292iGAYAC4mjSGkMdy8GEkCuLJeCCUBhyWNAeDHZdiAQoJXAHxNQNAdEwMKDSiWXnAKu' +
                'GkzIDAMo/53Vxvbc/3cLQXwDEAOwMuTAQwUAOxmJQGQCoDAGRhwwDJoDh1PADAAcAMEoGsjclF9SNn6' +
                'C/sTFFJxLTtkqT+skc+6QDAB2kAuAd9IDoMQGJTsGdIZiV8UkYnl/o6OSt9n3bKWnXhJgAuAGhDR0lE' +
                'J9v0cC5D3ycfvuXvuK+qQQR4AdAig4JX4TQTf2QAfZKSGAxJo0DKCwCxGJrNg1IYUMLTsOGm4IHe4t0' +
                'gVAdBhMDejZHzI52fOjf7qy0ft1Y47XxADoAfgISaGZPIZD3dOAJy2+yfsnBPUnZ8vnn+AAAABAiv5W' +
                'AaAhg5QCMAGvqyGYH1gBoCGDlAIwAa+rIZgfcCQCdICtN7QAsOATAjgqASwW9F0Ln3Quco2+cATgeDy' +
                'JfKALgRPwBERblXVALgRPwBERblX0oBiCH7hoCIAGmt0HX0LYGkngLrHbA0k8BdMo+2AHgIf2kEcD5H' +
                '12UpSxvn4AAABAyv5oAwAYkIMISEJS3zmJH8dq0BOAOQEBMGEsms7sBYvnMORde9AAMQRAYEj9ABlfO' +
                'EwBAUGk3P0r/6vh346+vBAKgDUNANQByAaAGheRgzoDUOjfFsGAUL+X/8B7Oq/LAg84BcCL9AlAYaCa' +
                'B3dBB2wBgCL7glAoFQTQS9ZfQb58BMAMAHQaNdJNUx3QLABRfmoAlAYFAGQBUBjp5LAy41uSCUc2w+/' +
                'zaAKABqAZAF4BWAHxNAySgMDQLBqGGjWJKMO515oBuUPJ3vsYIB6CJ4gkBAJn1fKr9rBA1wDENAHQAt' +
                'ATgMCZiklBgBY3L36QkCgYnv0JRj+OOvVISMWGI/Ncj3uABGAmBF/ACAsAGF1QKgCkAfBgalCQKt8wI' +
                'gITR2HFXevYAD8EP2DQEQJYHqwGABeTQ0v74o51bj8A9vSBAMQ3gDMAfk0hENkIQAwLDdwxXfBpMQB8' +
                'bmZPMv5wCDxADoEX5BKBCaCaB0BB4gB0CL8glAhNBNA76vS88AOyxyCeQb8jBBHAGABKQwCMoE0DgAA' +
                'AQAA1//4gAAAAQEqmWygH4o4iOrfnb+A2B0WfgOGwB4bjQIdt3G6AB5uQHIkAxANQDUCoBmBVIaTSw0' +
                'lEshpJhMLIZYbiFiGG7gYRvgPFYY+ZStvgnwYBQhBgDomIKKQjJGBmLLwYhCS+hAz//LX+/FOSH9TAD' +
                'plMKJ3O530DR/h/NMgGQB6d1nZ2gOE/gQNUcbAHyxIDUWuBmAVN1KD6mEQDbKHuB3KeA24C0SY3O+gG' +
                'oC4xwvtAxAI8zi2fjH0AscwQYTlLMgIE58aKCzm6qmAH/PYBez87eAB4Lw4DjLgFy1qI7LOU3Z38DkA' +
                'i2gImCANHisyvAPwF5OzizqiAAOl7rUHc7nfQMACAty2gDkcA1c9+rQBsBDqUxygnwAAAAECKqQAexn' +
                'AAAABAyqNAPwt4GT/HwM/+4oezVNAN4AHFRAAHo9nciLhYdAA7IvY4wTAA9qJALoBoT4DguAPQDd2XT' +
                'gAAAEAAF//+IgAAAEBKvHP9YAN4BgAaAGgFADICiCYTCgwDJKISCaTSiEUTOQ+QgzoJZYzmp/7JGjxs' +
                'GgVAqTQHZN5ZaUjHL5RXDenFYv7tjFbCjjh1fgB3XrAaA2f9eaAcwAP68gAdECBr/4AAAECKrNYAAAB' +
                'Ayr1gygM/6Bx/7+sGD/qwAAAAQAAn//4iAAAAQEq8c/1gA3gGABoAaAUAMgKIJhMKDAMkohIJpNKIRR' +
                'M5D5CDOglljOan/skaPGwaBUCpNAdk3llpSMcvlFcN6cVi/u2MVsKOOHV+AHdesBoDZ/15oBzAA/ryA' +
                'B0QIGv/gAAAQIqs1gAAAEDKvWDKAz/oHH/v6wYP+rAAAABAAFX//iAAAABASqRABsBuBwAa4Ad1WA0B' +
                's/6mgHMAD+pAA6IEDX/wAAAAQIqczgAAAEDKqwZQGaQBx/4B9M4AAABAAEf//iIAAABASq29YOoDO8A' +
                'AAECKrNYAAABAyqzWA==',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=96x64:rate=25 -frames:v 10 -c:v mpeg2video -q:v 12 -bf 2 -g 6
// -flags +ildct+ilme -top 1 -alternate_scan 1 -intra_vlc 1 -non_linear_quant 1 -qmax 28 -dc 10
// -aspect 16:9 -intra_matrix 8,9,...,71 -inter_matrix 16,17,...,79 -f mpeg2video interlaced.m2v
export const INTERLACED_FIXTURE = Object.freeze({
    name: 'interlaced.m2v',
    codec: 'mp4v.61',
    format: 'I420',
    width: 96,
    height: 64,
    displayWidth: 114,
    interlaced: 'top-field-first',
    md5: [
        '3d9170f7cd41d2a6a0e8d1b531bd71b5',
        'ec808cad2463c72617065203eb377cf9',
        '0f7d29022bed15e5cb59fb5369da071f',
        'a22a694228b35e215221f5d54bd76153',
        '5da1e0a93fe326efaa0fce15301f757f',
        'c00dc982566cb3d82d8880d582f94874',
        'aa0ece8a6149c446a41bb4150a3cb571',
        'e6160a52f48498b7dd59941cb5e34876',
        '01a8950f7c1c1a4474815ab6a4541623',
        '4f52aa413e42a26a50a5fd8aee798f28',
    ],
    bytes: () =>
        base64Bytes(
            'AAABswYAQDP//+AaEBIgMCIUFiQyQFBCNCYYGig2RFJgcGJURjgqHB4sOkhWZHKAgnRmWEo8Lj5MWmh' +
                '2hIZ4alxOXmx6iIp8bn6MjxARGCAZEhMaISgwKSIbFBUcIyoxOEA5MiskHRYXHiUsMzpBSElCOzQtJh' +
                '8nLjU8Q0pLRD02Lzc+RUxNRj9HTk8AAAG1FIIAAQAAAAABuAAIAEAAAAEAAA//+AAAAbWP//ucAAAAA' +
                'QFjfzhnRjvh7zygRABLuLYVS4uyL4t6Ln2Ty0aGAZcXKBMLhcb3ctI8J5gCPAB1hlwafSLzmYcPb7RN' +
                'ugAnEnAjf+OAJioA90EIAjgpAJb85/jqANBAqQIlquWhc8rktKH6W39W3HEHi2yDaCEAPcK8eHutABo' +
                '2+KkQjYI5y5V0JmywLljJ9PjBfGXS9CLuSjD5LUb1sBCALtfdCLn/3jPMYCKAI7rN8TW5UBC/3zXxwT' +
                'XADx3GeQ0EX/vkVjglUb8rNfSfA+gPhwGN9Y38X/3u5RWl2hpYaPAKcKCK2+0gDz+OAxp+0d+XFygTC' +
                '4W3LAG32d0/LC9obNlgXLC2udtoAaiTgRv/HF8FQB7QQgB3FWAS3gICEATa+6EXP/rs8xgIoAjus3xV' +
                'vkHv5fMJtvhfWZaf4N+7PucXZQAYz03ZlWFjq2/De8AB/07dhZ513JbKlLmbZFbviRVBCAG5GhgBTwX' +
                'LAEuB8LjfWoCF/lm85xYPrgBg7pxOQPUEP/rn2dxClVZjfbM3QQv7COcCN/1wCGAKVAAU6CEAX0VcoC' +
                'Vv7zAHgiez+LUkgJAAm+ruc5yWrBl2N4HvpBx8ABfPTXXKkLHStvg4oRBHOblLCZuWIXC5sqtBQiCeM' +
                '3YWEXclQqlzLUb6JV/07F2gkf+u/5geMGiuuo8IVWwav90WLkBI/9wAfTIYhY0T31HBKo3i/biUAP8K' +
                'iAQHUcNwEIAZ5ZQ2N+j+zsfBDw6QdSyFtJ+FBbb6cRPpgGHn6GAZcXKBMLhcaET6YBh5+hgGXFygTC4' +
                'XG9bNoIX+Ik4Eb/xwBMVAHughAEcFIBLSbQQv8RJwI3/jgCYqAPdBCAI4KQCW/Lvpx6AkACv9XBqxv5' +
                'qAHYmhttBI/6cAQPDE1gAAAQJjfy2gIQBt+ATQBAAW+ZJavgDKIQ2UEMA4APATQBAAW+YAMW8c3wl/M' +
                '5BN/9NJKt/R+0AE0IwJoBIBUCaAL5Eht9shUbjExuYzt49Lb+MXB0raHtsPbe8ps9Pb7GUAPwPbyXyu' +
                'pTby76QJISm+eaHVvqoBM3z8Amb9ugBS3rSAFrb0GAZbfA5W+aE1vRk1sn0wyN+s2+eOwhVIS0bfUW6' +
                '/OUXxl0hXZKMPkpTeKcWjffM0EH+3BPJgCOfTDLg0++7+Mw4ejfAZAA8fzCUlIWzKvhY35kJy9kC5YF' +
                '02EPLssCrlRgAAAQNjfzVFupGwRL6ugALzSS3mvfihbfpNo34b1DbaX42klv9Uv/zOncZDFo52ZgAMp' +
                'I285/xDwixp/xDwixv36CGAQAC0DgPaAh/8AAsA8Dm8dzgQ/8hBdQaCmAJrf8/3HEBC/v+A+yDQoEoA' +
                'V7b85gDEicgKtjQAYkTkBVsb+2zRv5HAHnFAepG/uJ9bf5NPJbaz2XI3pGjf9PwA77gDxa34ljar541' +
                'zyiqArgFVu178V8HVv3e2PadG/KCO88mLW/0ZAHe5dxUCyiSrb8bkfrYGVuV88WBlb+p39kEV82Khay' +
                'AehJb8/i3Uidh1AIcLIVAuN/Lr6ACJ+zZAvG+Od/RQA3+mb3EWym5ZlszYs/V3IUG+FYAAAAEEY35Da' +
                'NGjfzO3+4Db9tAhgEAAtA4D2gIf/AALAPA5vTNG/OfZQQv8hJwYCmAJjf8kpENBC/v+TgwLBKAFc2/o' +
                'I0aNG/h1v9Ym3+Vto0aN/3AN/N7b+gjRo0b+Z2/3Abf0AaNGjfze3/GOwAAAAQAA1//7gAAAAbWBH/u' +
                'cAAAAAQFizIdY6iQAzv6JoangVJpN/cRu7YAh6YpGJSEYAHm1bM6z40BlXgB7XA2MqEWMIiUb/E+DSU' +
                'CGAaV/haAA56OhJh4xDrHMNo8DQ3AAy6cRIwB8Bog1AY1QJgAaSk4K6urwDEhoUAYAUzcUWBRKOMDts' +
                'kvuIaJpKcAsQUCWAKhLrWeA3SlJEiv9gUf/EE5KcQE6Ddk8FEARIBChHOOHo8AAAAECYqSIM4ueCjyd' +
                'OqGLuONF8+4ypdRv5rt3ecALeEoZZK7bJbAuS1vNSmxvYPzfl0m4PLM2yFw8YrerACivihBQHo35Pqv' +
                'J2xAlRxDJTAAAAQNib1+JhoBOBqDQCYDcAaBvBDAIDVtgWP/tAFwa4IQBZDW2MBT/9RUR/NcsaDHVq9' +
                '3MzwShcjxaedpJ/p2ixg0kAA+qA9tAISZvk4ldjD8ByJoYkDJSyN7O8AmAThiSEkNKRlt0DC+oJRwpJ' +
                'OgAAAEEYm6Eg0AnA1BoBMBuAYExwQgBwwF7/7wCAhOCEASQgXv/Ux5DlU8D2ABllEesvgc3+wedic/g' +
                'AAABAABf//u4AAABtYERG5wAAAABAWPPH2kIxKQgB/ydfX5q2d6FOAc05mJwRwO7fhT6FED76JqHQWG' +
                'YAgAbhI0EoAMpKfoEQAUANkE7gMEcINMAqkNTqBV/8QR9yuRk6wVQBEk8bg1A4zo8AAABAmJWucVdK/' +
                'AuHMDRIaspoMGAZYawtbMFuMINj74F34AM34AM3gAAAQNirmvxNJ4wAGAG5JwwAGIGoCn4DjrbAkf+o' +
                'BO/8RAMFgKOtsCR/4UCd/0VM51Dqcw7y25E4HddgxgA05jaWOIIGpO7twAZJUR9FJx+YAGaHM4DxJOC' +
                '9AAAAQRirnMSSeMABgBuScMABiBqDCgPYE7/1IJ3/iYmFAewJ3/hYJ3/ZdVorAAAAQAAn//7uAAAAbW' +
                'BERucAAAAAQFi5jfMbAH1c6AWyO9CnAOacwMLxHwG8/lH4if8wUMf8VZIALMRAC3k4AP0l/EaAXAA4T' +
                'owDbAA9R4AAAECY19W+a11T3MfDE8lqQHvucT4z11wAAABA2Kua/E0njAAYAbknDAAYgagKfgOOtsCR' +
                '/6gE7/xEAwWAo62wJH/hQJ3/RVr9XXnjHl4DkZrDrzsbS3A595OXoMLzOoV3R3znDxYEdAAAAEEYq5z' +
                'EknjAAYAbknDAAYgagwoD2BO/9SCd/4mJhQHsCd/4WCd/2XVaKhwAAABswYAQDP//+AaEBIgMCIUFiQ' +
                'yQFBCNCYYGig2RFJgcGJURjgqHB4sOkhWZHKAgnRmWEo8Lj5MWmh2hIZ4alxOXmx6iIp8bn6MjxARGC' +
                'AZEhMaISgwKSIbFBUcIyoxOEA5MiskHRYXHiUsMzpBSElCOzQtJh8nLjU8Q0pLRD02Lzc+RUxNRj9HT' +
                'k8AAAG1FIIAAQAAAAABuAAIAgAAAAEAAI//+AAAAbWP//ucAAAAAQFjfz0nRAhG5eeUCIAJu5LYVS4r' +
                '5F8Wx32BDAFeNDACnguWAJcLhcb7Ot5ydmAI4AOnGXBp9+vOZhw9W+lXbQAQ/JwI3/mFcFQAFOghAFc' +
                'FIASt+C9Xc3mlhWpfXHzYWUP2N/Z/DuBAAeF5IPojyABn1eKPAeNvj/0+MFc5cL0Jm5YNPllVp9PjBf' +
                'GXS9CLuSjD5LUbrghgGbX68IuAD1/GeYwEUAVwrH0MU1s0BC/1lfHBNcAOncZ5DQRf+3isdA1UbxTdA' +
                'KYH0B8OAxvrG/z9+/eyiNLtDSw0ZQQv+nFBGhLb7mAPP44DGn7R35cXKBMLhbcsAbfZ3T8sL2hs2WBc' +
                'sLbpS0EL/MSCV/44BwVAHtBCAHcUgEt83gIQBNr7oRc/+uzzGAigCO6zfFW+Fe/l8yh9oBFSFl2F+Df' +
                '0bzZ1dhQANZ6bsyrCw1t+GN4AD/p27CzzruS2VKXM2yK3fEiqCEANyNDACnguWAJcD4XG+tQEL/LN5z' +
                'iwfXADB3TicgeoIf/XPs7iFKqzG+2Zughf2Ec4Eb/rgEMAUqAAp0EIAvoq5QErf3wAPBE9n8WpJASAB' +
                'N9Xc5zktWDLsb5n30g4+AAvnprrlSFjpW3wcUIgjnNylhM3LELhc2VWv6EQXxZp5VkrtslsoTJbG9tV' +
                '+07F2gkf+u/5kNGDRHXUeEKrec+VI+ZMkDXgB8JlmQBVbMtWFKiUtvK+zs0AtyWRBxQYGE7bg0Kb9EE' +
                'cQEIAnkOkHUDZPxW31j+ETONdsL2lFbllg2fvC43RIn0yAFnJ+gPHbslSofA+eqt5bhz5yI8kixb5Tj' +
                'uv2UPofXyUYWfApvqy0iAB89AEcAHztyuGngBzzJhw+2qMb4EjceVlOQ+ec5npPxZaCT/3krfyn/xOv' +
                'zYXqnXyvVKCaBnLICSAM+xgAAABAmN/OCAhAGQjAmgCAAt8yS14BO3iAQwDgA8BNAEABb5gAxbB1POw' +
                'kt+Y6XOQTf/fMkq37u8EIBGEZQSwCQCwE0AXyJDb6STG4BMbdhzYDm5ia38qSkCFttuQ1uthbeXPbYe' +
                '32PN88reRxi1t8ModZY1DfWACZvnN/Fb+hs/Mb6bPzG3uoH2NrgcreXwPjdBvntKMjfrT9DnOJYH2Nv' +
                'oLdfnKL4y6QrslGHyUpuQ320sAewi7cKLD5/pZYUCP/xeEvpG+GcCEAQ/vKQjKCZ/7jtUAhjfz28EL/' +
                'd3WwhmwEwATX4njlYAAAAEDY381RbqRsES+roAC80kt5r34oW36Tb1oIf+YAfAm/+AAsNJDfi/EJ6aW' +
                'CT/6lABmW3+m315ADSvFQyWjZ8XeCH0uEpt8v/4h4RY0/4h4RY37XaN9R27A3Ub/HgXw4B7sxt8HAFZ' +
                'G5gDzY2UAV/TkBVsb+vwIf9AAJwTf+QTwBCcCaAG31Rv40AHQogC/Z6bZARgBX9agJQAe5SVW/YxL0y' +
                'klSS2/zQ/PFru+NKo7dhZCsvo3yoW6iNKBr//be3Y4ycOKb/oxAHL82w4LKJDfixnnuHhZRIbeR7dXx' +
                'vc/PGvg6t91+Z+S56gc30Kghf9WUGwAFvk/r3OFVC2/vn6y/cy8WeIHq2/MwkVVgytp5dadUCm/TgDh' +
                'vHAOG/i4EMBIXDQopv1YAX+6OPxaeAuYAAABBGN+Q29aCH/mAHwJv/gALDSQ3kmjfzjPzcgAM7IS7G/' +
                '2keCEARwJ5UKALHd6CYAHm0lNv1o0b6Y0bEAeeYQrf8z4A0J4CpW36wBD/oABOCb/yCeAITgTQA2+qN' +
                'Gjf53uBCAI4EcKFgFjusBMADzISm/0APtJKtv8rbRo0b/tkb+c239BGjRo38zt/uA2/U335orH20qFJ' +
                'IB6ElvgwA/cAHW/nDiybCr6Ae37TaN/JXegB51tzwRv+ZMAQfbgAckfFcA843aZJEyFkybVUIGDmAAA' +
                'AQAAH//7uAAAAbWBERucAAAAAQFjXornNYq88w3OQTzAJJVJQE5ZAIHgwEX/xPwJQBOKxGTyh9pSN5Y' +
                '0Ev/0aMAInyidGgaYgvp1AAtcjMM8AAABAmNcKqtOa/1pmYinBHci6LXgMKCia3/J29HgPyA9nAPgAY' +
                'tAAAABA2JXa/Nn4tomIGi21OZsz++rU5iQuQlAxN+e86D+cX4B/XDYl+Swq5Gw7QAAAAEEYldXK6tnI' +
                'caRl/8iaQBMic6LSL4AMimMOJKSef4AAAEAAF//+7gAAAG1gREbnAAAAAEBY89Jsiu7xH6Uq88DALxq' +
                'Cfl5cGZeIZecBXshOJ/Jpe2C5DjQA9L4WAVpzcwEUAZBSJIKoAfJ+CcR9IcFP/3E7gW48cnQAAABAmL' +
                'kteTnQuua+85xF4AHumy3I7KIq4AAAAEDYq7X5s/FtExA0W2rmOV1qcxIpJy6Thib89coI5Mh1ZZOrq' +
                'ABtXDYl3cjCoAAAAEEYqyOQ5UGX/+UPBqABgAAAQABV//7gAAAAbWBH/ucAAAAAQFihMzxeAjpxwAOa' +
                'r+dZ8y6Om4GxlYFFPLWo4AH8WgIW2EqWRVQ6A9+QQH1RiPhuA5/jhe3koCd9wAffQCZKdigK9O6uxLJ' +
                'SQ0YcxwBX8sKg38At5D/CwG5L2SHdsRMq8E7gAwGcnuN1cI6AAYkvE4YM4+AAAABAmKAyDmkaDHAfXc' +
                '0JIevfkarC01FqjqhEXiIBvLiHkEoBtyOTcEAlgBu5HrrwAN2vK4AOc8AAAABA2KHwEAIv+4L4AUjhO' +
                'A4NIEQwwEIAYNOBK/8KJhZGTgOWvzZ+LaJiBottcBeJFFoAbFgdwHImhnbqiYj8m8IQY/k8EIAbbFpN' +
                'bAL7gKMDFF4YnfQDACiFYZly2A1JZzpLDTrhQI9eJqJ5KONy6gKh4BgBUrpQnJyxfjY06AqkpAY5L53' +
                'ZDKA3AAAAQRih0BACL/uC+AFIwTwOb+AqGsQgwE7/wsmFAAzSBqeAvHgB8CGAaCf/4ACwAFsnBOTiLE' +
                'INYB0TSYWwBBwO5OIsshxJLfMQQNSUcaM5GyVEG5G/WwewS452JBH5OgAAAEAAN//+7gAAAG1gREbnA' +
                'AAAAEBY17Vvvl0dejQYf/7zzLgdO6nC64DXfToG5LLFgNmzcSdMcWCb/5y+4WmAW4DcAv3ABZ4AAABA' +
                'mJW64VK3wPZjNzcR94lgEw0AHbWeNIMAAABA2PFy+SQTwBAAWgajHxE4AL8UkAGequcC44j4DCUeZcY' +
                '2cnNTgVOQncpKE4nbxn5AvHo/gF1OawZv/4AAAEEYnMdJhJAyCaAKCf/61H8AHG8WkBQjgAswJn/qSk' +
                'EWq5wPHgHQIYBIBYCaAGBsaQbPcg6KSAoSGJBMADSjgAy+qtnA0aS2zEEDUlnGEVHXifFINUADP/igJ' +
                'Yjmj4AAAEAAR//+7gAAAG1gREbnAAAAAEBY19WuePpYYfhCzQ+NvXnmXA6d1OF1wGu+gG/GFZBPSGk1' +
                'IzB3bxZKAzkkonGgEZ0ccTwGhA0e+5OEk8if6AAAAECY18rq9eznYvEQDeXAAAAAQNjxcvkkE8AQAFo' +
                'Gox8ROAC/FJABnqrnAuJScSko5Ei0BCVRW/L+GYxzwH8ngWJPFEhnIF4GHTEJR8JngHv67yKy3hXu88' +
                'rcJRnI3k9TuTs56g6AAABBGJzHSYSQMgmgCgn/+tR/ABxvFpAUI4ALMCZ/6kpBFqucDx4B0CGASAWAm' +
                'gBgbGkGz3IOikgKEhiQTAA0o4AMvqrZQYO',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -frames:v 4 -c:v mpeg2video -pix_fmt yuv422p -q:v
// 10 -g 1 -dc 9 -f mpeg2video intra422.m2v
export const INTRA_422_FIXTURE = Object.freeze({
    name: 'intra422.m2v',
    codec: 'mp4v.65',
    format: 'I422',
    width: 64,
    height: 48,
    displayWidth: 64,
    interlaced: undefined,
    md5: [
        '1366c16652e8169f7a3b17ffde3f7167',
        '1366c16652e8169f7a3b17ffde3f7167',
        '1366c16652e8169f7a3b17ffde3f7167',
        'f4fc8ed37e075c104a6526134d1f382a',
    ],
    bytes: () =>
        base64Bytes(
            'AAABswQAMCP//+AYAAABtRhcAAEAAAAAAbgACABAAAABAAAP//gAAAG1j//3QIAAAAEBU/zhgGyAzJL' +
                'N7Gv/+rbZf4i7wagBMWjJ+fZPQAlcaBIYSXFNai98AVFuMyAM7ls+R05kfinHqH3rvkgFYBaNAsA4Ab' +
                'tmGkoYNYcNNJAu7wB8GJJhWLKzEvIcS3IN9KQuUGEMmBpySsn7iUN78eK+HAeSgP6f2vvCFuxMWASJD' +
                'sjP74fAQAJiaV2KfO3WXvvud8++vUJAHwBkVn4YaxJDV/mbZL+8qVnAK09y0JyM+wDkYhkthI5Q63hu' +
                'YAsTnKRsnPwEg1DIcDtylAOwKoCNzb8SAqTQG/xae4QTn907hJOYWSmvsS8EYLcUBn84RfxwBuQhg11' +
                'DRhyRo12GDGGuKZ7Z8QgK7fLb/Af33N3yvuJvq4xIAfgFY0CwDgAtbDBoGBg1hw00kC7ywZhvAdl9w0' +
                'pKEIG7MBklFMkZsP5zKHe/pkAExRQSSjux9wE1KCaVyuvfbk+/EA1OGZlMGFFOOTk7/AdvrG6wR//ek' +
                'BF8zgcughgUAdYoC6Ff7Hpf9ztt34de1ADwA0GDRinGHhrjRzO7imvPAVzAFSc5SEZOf4BwNRsgbuLH' +
                'qH3uGSAWgNxoQSAG7KGkoYNYcNNJAu/RQwBgEKQr9g+/LwDICoAdBiSikjMN5fwdsRL8uJnwxa3KLKc' +
                'enp/YDt+h7f7Nzg1BfUcjIywOQAAAAQJT/LBCAJsHkezFmWkhAE2DyPZizLweSeJ99oAaHEwEcAPAA0' +
                'jknifABocTAFWABpfYSddi46TrsXmIvz8NPDpogNPDr+V3QLMufdAsy/YsfekWSPPHwWSPfYSddi46T' +
                'rsXia8gB0A44kiaekA6AccSRNAAAAEDU/zUTCaUgrb9azOPtRNAYkIpnSzuYkgXrb6AAhASB5EvkQMJ' +
                'SlWP/v0UAfBpQaWTCYjuWMZhBXcjXx5MAc4PI19oAKgQ/8AKAkf+AlgCJv54WAYgOkI/5agFSQAYXqg' +
                'Qf7QEAIv/YJQAZYAML70A7BDAFSHEfX2G6SgGBD+Ui/nEB2jhidkq7OT/fiBCJHE3iADkEP/pAI4AeA' +
                'Bqm/5IjcPu4TSaUUz9nczkCl9BANQEgCMiX+jqAE5C/JN9yQ+SgzpSrZiPfupMAc4PI11gGIIYBIaAi' +
                'ABrr5BYCchIR/0qEJIF6oAE4DAEX/wAgLABhfTgHYIYAqQ4j6+wX8ulE0r5XvjAC4pIDsmdIZhuxfzi' +
                '23It92QiRxN8wAFgIYBYaCP/0kEsAMqAAAABswQAMCP//+AYAAABtRhcAAEAAAAAAbgACADAAAABAAA' +
                'P//gAAAG1j//3QIAAAAEBU/zhgGyAzJLN7Gv/+rbZf4i7wagBMWjJ+fZPQAlcaBIYSXFNai98AVFuMy' +
                'AM7ls+R05kfinHqH3rvkgFYBaNAsA4AbtmGkoYNYcNNJAu7wB8GJJhWLKzEvIcS3IN9KQuUGEMmBpyS' +
                'sn7iUN78eK+HAeSgP6f2vvCFuxMWASJDsjP74fAQAJiaV2KfO3WXvvud8++vUJAHwBkVn4YaxJDV/mb' +
                'ZL+8qVnAK09y0JyM+wDkYhkthI5Q63huYAsTnKRsnPwEg1DIcDtylAOwKoCNzb8SAqTQG/xae4QTn90' +
                '7hJOYWSmvsS8EYLcUBn84RfxwBuQhg11DRhyRo12GDGGuKZ7Z8QgK7fLb/Af33N3yvuJvq4xIAfgFY0' +
                'CwDgAtbDBoGBg1hw00kC7ywZhvAdl9w0pKEIG7MBklFMkZsP5zKHe/pkAExRQSSjux9wE1KCaVyuvfb' +
                'k+/EA1OGZlMGFFOOTk7/AdvrG6wR//ekBF8zgcughgUAdYoC6Ff7Hpf9ztt34de1ADwA0GDRinGHhrj' +
                'RzO7imvPAVzAFSc5SEZOf4BwNRsgbuLHqH3uGSAWgNxoQSAG7KGkoYNYcNNJAu/RQwBgEKQr9g+/LwD' +
                'ICoAdBiSikjMN5fwdsRL8uJnwxa3KLKcenp/YDt+h7f7Nzg1BfUcjIywOQAAAAQJT/LBCAJsHkezFmW' +
                'khAE2DyPZizLweSeJ99oAaHEwEcAPAA0jknifABocTAFWABpfYSddi46TrsXmIvz8NPDpogNPDr+V3Q' +
                'LMufdAsy/YsfekWSPPHwWSPfYSddi46TrsXia8gB0A44kiaekA6AccSRNAAAAEDU/zUTCaUgrb9azOP' +
                'tRNAYkIpnSzuYkgXrb6AAhASB5EvkQMJSlWP/v0UAfBpQaWTCYjuWMZhBXcjXx5MAc4PI19oAKgQ/8A' +
                'KAkf+AlgCJv54WAYgOkI/5agFSQAYXqgQf7QEAIv/YJQAZYAML70A7BDAFSHEfX2G6SgGBD+Ui/nEB2' +
                'jhidkq7OT/fiBCJHE3iADkEP/pAI4AeABqm/5IjcPu4TSaUUz9nczkCl9BANQEgCMiX+jqAE5C/JN9y' +
                'Q+SgzpSrZiPfupMAc4PI11gGIIYBIaAiABrr5BYCchIR/0qEJIF6oAE4DAEX/wAgLABhfTgHYIYAqQ4' +
                'j6+wX8ulE0r5XvjAC4pIDsmdIZhuxfzi23It92QiRxN8wAFgIYBYaCP/0kEsAMqAAAABswQAMCP//+A' +
                'YAAABtRhcAAEAAAAAAbgACAFAAAABAAAP//gAAAG1j//3QIAAAAEBU/zhgGyAzJLN7Gv/+rbZf4i7wa' +
                'gBMWjJ+fZPQAlcaBIYSXFNai98AVFuMyAM7ls+R05kfinHqH3rvkgFYBaNAsA4AbtmGkoYNYcNNJAu7' +
                'wB8GJJhWLKzEvIcS3IN9KQuUGEMmBpySsn7iUN78eK+HAeSgP6f2vvCFuxMWASJDsjP74fAQAJiaV2K' +
                'fO3WXvvud8++vUJAHwBkVn4YaxJDV/mbZL+8qVnAK09y0JyM+wDkYhkthI5Q63huYAsTnKRsnPwEg1D' +
                'IcDtylAOwKoCNzb8SAqTQG/xae4QTn907hJOYWSmvsS8EYLcUBn84RfxwBuQhg11DRhyRo12GDGGuKZ' +
                '7Z8QgK7fLb/Af33N3yvuJvq4xIAfgFY0CwDgAtbDBoGBg1hw00kC7ywZhvAdl9w0pKEIG7MBklFMkZs' +
                'P5zKHe/pkAExRQSSjux9wE1KCaVyuvfbk+/EA1OGZlMGFFOOTk7/AdvrG6wR//ekBF8zgcughgUAdYo' +
                'C6Ff7Hpf9ztt34de1ADwA0GDRinGHhrjRzO7imvPAVzAFSc5SEZOf4BwNRsgbuLHqH3uGSAWgNxoQSA' +
                'G7KGkoYNYcNNJAu/RQwBgEKQr9g+/LwDICoAdBiSikjMN5fwdsRL8uJnwxa3KLKcenp/YDt+h7f7Nzg' +
                '1BfUcjIywOQAAAAQJT/LBCAJsHkezFmWkhAE2DyPZizLweSeJ99oAaHEwEcAPAA0jknifABocTAFWAB' +
                'pfYSddi46TrsXmIvz8NPDpogNPDr+V3QLMufdAsy/YsfekWSPPHwWSPfYSddi46TrsXia8gB0A44kia' +
                'ekA6AccSRNAAAAEDU/zUTCaUgrb9azOPtRNAYkIpnSzuYkgXrb6AAhASB5EvkQMJSlWP/v0UAfBpQaW' +
                'TCYjuWMZhBXcjXx5MAc4PI19oAKgQ/8AKAkf+AlgCJv54WAYgOkI/5agFSQAYXqgQf7QEAIv/YJQAZY' +
                'AML70A7BDAFSHEfX2G6SgGBD+Ui/nEB2jhidkq7OT/fiBCJHE3iADkEP/pAI4AeABqm/5IjcPu4TSaU' +
                'Uz9nczkCl9BANQEgCMiX+jqAE5C/JN9yQ+SgzpSrZiPfupMAc4PI11gGIIYBIaAiABrr5BYCchIR/0q' +
                'EJIF6oAE4DAEX/wAgLABhfTgHYIYAqQ4j6+wX8ulE0r5XvjAC4pIDsmdIZhuxfzi23It92QiRxN8wAF' +
                'gIYBYaCP/0kEsAMqAAAABswQAMCP//+AYAAABtRhcAAEAAAAAAbgACAHAAAABAAAP//gAAAG1j//3QI' +
                'AAAAEBU/ztsTEBiElm9jX/dW2y/xF1yagBMWjJ+fZPQAlcaBIYSXFNai98AVFuMyAM7ls+Ry8yPxTj1' +
                'D71/yQCsAtGgWAcAN2zDSUMGsOGmkgXfNBiSGS/8c/2v0IAyKJgFEkImoUXkO4kruR75coZn7AeSgP6' +
                'f2A7e2Qn+JiziUkOyMu+HwEACYmldinzt1l777nfPvr1CQB8AZFZ+GGsSQ1f5m2S/vKlZwCtPctCcjP' +
                'sA5GIZLYSOUOt4bmALE5ykbJz8BINQyHA7cBQDsCqAjc2/FgKk0Bv8WnuEE5/dO4STmFkpr7EvBGC3F' +
                'AZ/OEX8cAbkIYNdQ0YckaNdhgxhrime2fEICu3y2/wH99zd8r7ib6uMSAH4BWNAsA4ALWwwaBgYNYcN' +
                'NJAu8sGYbwHZfcNKShCBuzAZJRTJGbD+cyh3v6ZABMUUEko7sfcBNSgmlcrr325PvxANThmZTBhRTjk' +
                '5O/wHb6xusEf/3pARfM4HLoIYFAHWKAuhX+x6X/c7bd+HXtQA8ANBg0Ypxh4a40czu4przwFcwBUnOU' +
                'hGTn+AcDUbIG7ix6h97hkgFoDcaEEgBuyhpKGDWHDTSQLv0UMAYBCkK/YPvy8AyAqAHQYkopIzDeX8H' +
                'bES/LiZ8MWtyiynHp6f2A7foe3+zc4NQX1HIyMsDkAAAABAlP8sEIAmweR7MWZaSEATYPI9mLMvB5J4' +
                'n32gBocTARwA8ADSOSeJ8AGhxMAVYAGl9hJ12LjpOuxeYi/Pw08OmiA08Ov5XdAsy590CzL9ix96RZI' +
                '88fBZI99hJ12LjpOuxeJryAHQDjiSJp6QDoBxxJE0AAAAQNT/NRMJpSCtv1rM4+1E0BiQimdLO5iSBe' +
                'tvoACEBIHkS+RAwlKVY/+/RQB8GlBpZMJiO5YxmEFdyNfHkwBzg8jX2gAqBD/wAoCR/4CWAIm/nhYBi' +
                'A6Qj/lqAVJABheqBB/tAQAi/9glABlgAwvvQDsEMAVIcR9fYbpKAYEP5SL+cQHaOGJ2Srs5P9+IEIkc' +
                'TeIAOQQ/+kAjgB4AGqb/kiNw+7hNJpRTP2dzOQKX0EA1ASAIyJf6OoATkL8k33JD5KDOlKtmI9+6kwB' +
                'zg8jXWAYghgEhoCIAGuvkFgJyEhH/SoQkgXqgATgMARf/ACAsAGF9OAdghgCpDiPr7Bfy6UTSvle+MA' +
                'LikgOyZ0hmG7F/OLbci33ZCJHE3zAAWAhgFhoI//SQSwAyoA=',
        ),
});
