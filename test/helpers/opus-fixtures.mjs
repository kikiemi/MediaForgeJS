// Opus fixtures produced by ffmpeg 6.1.1 (libopus 1.4) from the deterministic signal codecSignal()
// written as a 16-bit WAV at inputRate:
//   ffmpeg -i signal.wav <arguments> <name>.<container>
//   (copyOf: ffmpeg -i <copyOf> -c:a copy <name>.<container>)
// Each entry carries referenceFrames frames of ffmpeg's float decode with the named decoder (ffmpeg
// -c:a <decoder> -i <name> -f f32le -c:a pcm_f32le; 'libopus' is libopus 1.4, 'opus' ffmpeg's own
// decoder) from presentation frame referenceStart, and `frames`, the frame count of that decode.

function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** Interleaved float32 little-endian samples. */
function base64Float32(text) {
    const bytes = base64Bytes(text);
    return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

/**
 * Tones per channel (220 Hz times channel rank plus a harmonic) with a decaying noise click every
 * quarter second.
 */
export function codecSignal(rate, channels, frames) {
    let state = 0x4d463430;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32 - 0.5;
    };
    const planes = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
        const t = i / rate;
        const burst = (i % Math.round(rate / 4)) / rate;
        const click = burst < 0.004 ? Math.exp(-burst * 1500) * random() : 0;
        for (let c = 0; c < channels; c++) {
            const f = 220 * (c + 1) + 55 * c;
            planes[c][i] =
                0.35 * Math.sin(2 * Math.PI * f * t) +
                0.12 * Math.sin(2 * Math.PI * 3.1 * f * t) +
                0.5 * click;
        }
    }
    return planes;
}

export const OPUS_FIXTURES = Object.freeze([
    {
        name: 'silk-nb-voip-20ms',
        container: 'opus',
        arguments: '-c:a libopus -application voip -b:a 10k -frame_duration 20 -cutoff 4000',
        decoder: 'libopus',
        inputRate: 8000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AIBkPgC4cj4AyH8+AOSFPgBciz4ATJA+ALSUPgCYmD4A+Js+AMyePgAgoT4A5KI+ABykPgDIpD4' +
                    'A6KQ+AICkPgCcoz4ASKI+AJSgPgCMnj4ATJw+ANyZPgBMlz4AqJQ+APSRPgA4jz4AdIw+ALCJPg' +
                    'Dwhj4AQIQ+AKSBPgBgfj4A0Hk+AMh1PgBAcj4AUG8+AABtPgBAaz4AGGo+AIBpPgBoaT4A6Gk+A' +
                    'PhqPgCwbD4AEG8+AChyPgDwdT4AcHo+AJB/PgCcgj4ApIU+AMyIPgAMjD4AUI8+AJiSPgDclT4A' +
                    'GJk+AFicPgCQnz4AwKI+ANilPgDQqD4AjKs+AASuPgAgsD4AzLE+AACzPgC4sz4A8LM+AKizPgD' +
                    'osj4AqLE+APSvPgDArT4ABKs+AMCnPgDkoz4AaJ8+AEyaPgCMlD4AKI4+ADSHPgB4fz4AiG8+AN' +
                    'BePgBYTT4AMDs+AIAoPgBAFT4AgAE+AJDaPQAwsT0AIIc9ACA5PQCAxjwAAFY7AMCPvABAHL0AA' +
                    'G+9ANCfvQAAx70A8Oy9ALgIvgBAGr4ACCu+APg6vgAgSr4ASFi+AHBlvgCAcb4AaHy+AAyDvgBM' +
                    'h74A7Iq+AACOvgCMkL4AnJK+ADiUvgBslb4AOJa+AJyWvgCYlr4AJJa+AEiVvgAAlL4AWJK+AGC' +
                    'QvgAojr4AyIu+AFiJvgDshr4AjIS+AESCvgAYgL4ACHy+ABB4vgA4dL4AgHC+APBsvgCgab4AqG' +
                    'a+AEBkvgB4Yr4AiGG+AHhhvgBYYr4AIGS+AMBmvgAYar4AGG6+AJByvgBgd74AiHy+APiAvgDQg' +
                    '74A0Ia+AACKvgBgjb4A8JC+ALiUvgCsmL4AvJy+ANygvgD8pL4A/Ki+ANSsvgBosL4AsLO+AJy2' +
                    'vgAoub4ASLu+AAS9vgBUvr4APL++ALy/vgDMv74AbL++AJC+vgA4vb4ATLu+ANS4vgDAtb4ADLK' +
                    '+ALitvgDEqL4ANKO+ABCdvgBglr4ALI++AICHvgDIfr4AwG2+AAhcvgCoSb4AsDa+ADgjvgBAD7' +
                    '4A0PW9AJDMvQDQor0AoHG9AKAdvQDAk7wAABI7AMC1PABAKz0AwHk9APCiPQDQxz0AQOs9AJAGP' +
                    'gC4Fj4AACY+AFA0PgC4QT4AGE4+AGBZPgCgYz4AwGw+AMB0PgCoez4AtIA+AAiDPgDQhD4AFIY+' +
                    'ANiGPgAshz4AGIc+AKiGPgDshT4A7IQ+ALiDPgBYgj4A0IA+AFh+PgDYej4AMHc+AGhzPgCQbz4' +
                    'AuGs+AABoPgCAZD4AUGE+AJhePgBgXD4AwFo+AMhZPgB4WT4A2Fk+ANhaPgB4XD4AqF4+AGhhPg' +
                    'C4ZD4AmGg+AAhtPgAQcj4AsHc+APh9PgBwgj4ALIY+ACiKPgBcjj4AuJI+ACiXPgCkmz4AFKA+A' +
                    'HikPgDAqD4A5Kw+AOCwPgC0tD4AWLg+AMi7PgAAvz4A9ME+AJTEPgDYxj4AqMg+APzJPgDEyj4A' +
                    '8Mo+AITKPgB4yT4AzMc+AIzFPgC4wj4AUL8+AGS7PgDstj4A6LE+AFysPgBApj4AlJ8+AFyYPgC' +
                    'UkD4ATIg+ABh/PgDAbD4AsFk+ABBGPgAAMj4AmB0+AAgJPgCg6D0AEL89AKCVPQCAWD0AQAY9AA' +
                    'BUPAAA2LsAwNK8AIA1vQAgf70A8KK9AIDEvQBw5L0AQAG+AFgPvgCYHL4A6Ci+AFA0vgDYPr4Aa' +
                    'Ei+APBQvgCAWL4A6F6+AChkvgBYaL4AcGu+AIhtvgDQbr4AYG++AFhvvgDYbr4A+G2+ALhsvgAg' +
                    'a74AMGm+AOBmvgAwZL4AMGG+APBdvgCQWr4AOFe+ABhUvgBQUb4AAE++AEhNvgAgTL4AiEu+AIB' +
                    'LvgD4S74A4Ey+ADhOvgAIUL4AaFK+AFhVvgDwWL4ASF2+AGhivgBIaL4A4G6+ACh2vgDwfb4AGI' +
                    'O+AFyHvgDAi74AOJC+ALyUvgBMmb4A4J2+AHyivgAcp74AtKu+AECwvgC4tL4ABLm+ACC9vgD4w' +
                    'L4AfMS+AKjHvgBsyr4AxMy+AKzOvgAc0L4ADNG+AHzRvgBk0b4AuNC+AHzPvgCkzb4AKMu+ABDI' +
                    'vgBYxL4AAMC+ABy7vgCwtb4AxK++AGipvgCgor4AcJu+AOCTvgDsi74AlIO+ANB1vgC4Y74ACFG' +
                    '+ANA9vgAoKr4AOBa+ACgCvgAA3L0A4LO9ACCMvQCgSb0AAPi8AABAvAAA1jsAQMc8AGAqPQDgbj' +
                    '0AMJg9ADC3PQBw1D0AkO89ADgEPgCgDz4A4Bk+ABAjPgBIKz4AmDI+APg4PgCQPj4AUEM+AFBHP' +
                    'gCQSj4ACE0+ALhOPgC4Tz4AAFA+AKhPPgC4Tj4AUE0+AIhLPgB4ST4AQEc+AOhEPgCYQj4AUEA+' +
                    'ADA+PgA4PD4AeDo+AAA5PgDgNz4AMDc+APg2PgBANz4AMDg+AMA5PgAIPD4AED8+ANhCPgBgRz4' +
                    'AoEw+AJhSPgAwWT4AWGA+ABBoPgBAcD4A4Hg+APiAPgCwhT4AnIo+ALiPPgAAlT4AcJo+APyfPg' +
                    'CcpT4APKs+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAACvIHXrAAAAAGD+fIQBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAK8gdesBAAAAKkOV+gE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAAK8gdesCAAAAIbQ6Eh8WJSIjK' +
                    'B8hHCMiIh0ZIhwdGyAdHSAbHiIkER8lIyETCITku13CMORBy4LFlnCRYz6fOHB70Ai0rxXHPeYu' +
                    '57CQQ+9Cy0Hv6Sma4bVB6T/OXBJH2VT8zH/yGNAIpTHRRqDG9Y3gLYWb1TbKj0m6smSAVPXZdtO' +
                    'cgPGLyHeYCKZfWTsRIKetcvDI1dxAf6NMwtDIRH4189U6fWptEJMvzJYIpjKHNvh5+Cxx5Z3x3w' +
                    'jDd06zjP5dYthzUGl97V+93Kcg1XsYkIKACKZ5GmaK/C5X9Rq0WYsXs9P0k/dDZVLo7HMWygubK' +
                    'AimWIBOWQS5+QT72sk4JIWF74LzelKw2y2fVzFYyssIlAimX1k7ESFqgpYBbVhowBfuLthx9TwQ' +
                    'NmBS0OAIp5B7Q9xIFPMyHzvZfQIqbuKCcpFr5D1l355gwDISYkaqFAinzOR0FsonF44HIhFSqi3' +
                    'IaZVX13ga7JQOd9b9GusqYYAIp8zkdAWyGtz/d3jTHfEsgYetx+yGx8X06lA5coaDU5xKCKbSZd' +
                    'yyHDjmHWvRvih4DR1jcigrqJ0s9OeoMYsIqe4pwZmGJy8xR6OOTKAnB74d4UCJl4nACLdkwca4q' +
                    '7yPhkvUzq7moj80/XioyWnouwzMR6qfVync/ginZgfByaOt6EPE9gdsS0r0Kn8SWiqYUG2qa4AI' +
                    'p6/wrGRIWq3n0BwDJlWAUD3a7+ZXyiGMc2/i4AioHVyxelv/qK32uruu7xe1B466aSFZysAX6Ai' +
                    'pCFmQQ3Sx6foPWHq4/jRkBab436OdgvqK/OuthsPOCKkGOIgcSFqt67bF/i1xFQ1asouGfaHi4P' +
                    'MTPBkIqBdQVWq5uvzvc0iXv5epVHa/JW7i9I6nGOWweAinzOR0BbEenFeN0PhC2rZ09GTGTW5C9' +
                    '+4KfxtNtB88CKmItT2UR2KKzq1gL5wjA7VbcYV47mt2NBnACKmo1Pz+xxW8+iCaUFLbQLCDhMoQ' +
                    'd3qi2A9FNaNACKoQ4xHwI+9dY42OItdBZshbfP8b7isuRRBYEUNV116A0AiqCwePnoQs5tOkYHM' +
                    'TWojkyhUBj+PiUhBTCL3A9ddCTvxgsAi4LjDqilD3zgN9x+uNVViBCK+dK/r+EHTgeQ1T5jpSSn' +
                    'gCSwg9ndFU1NMtPxwc7AirveBy+/Yh7vCTNlb2WLMrtgW6QmOHTosHabUFDKMBhCB28VAIq90yi' +
                    'Y0nCBX0jThAJ0ibjTm7TVowmcNgmz3RVaI8qk3B8Aitj4gaWO0KiE86UDu4BmIKHROcF/5Ixfyb' +
                    'fTUA/iGCxgiFBneQk8DYUHSkG5fztIbuAbA=',
            ),
    },
    {
        name: 'silk-mb-voip-40ms',
        container: 'opus',
        arguments: '-c:a libopus -application voip -b:a 14k -frame_duration 40 -cutoff 6000',
        decoder: 'libopus',
        inputRate: 12000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AKSMPgCskD4AHJQ+AACXPgBYmT4AMJs+AJCcPgCEnT4AEJ4+ADCePgDknT4AMJ0+ABCcPgCQmj4' +
                    'AvJg+AJyWPgBIlD4AzJE+ADiPPgCYjD4A8Ik+AEyHPgC4hD4APII+ANh/PgCIez4AsHc+AEB0Pg' +
                    'BIcT4AyG4+AMBsPgAoaz4AGGo+AKBpPgDIaT4AqGo+AFBsPgCwbj4A0HE+AJB1PgDgeT4AmH4+A' +
                    'NyBPgCchD4AjIc+AKyKPgAAjj4AgJE+ACSVPgDgmD4AoJw+AFSgPgDgoz4AOKc+AEyqPgAcrT4A' +
                    'qK8+APixPgAItD4A2LU+AFi3PgB8uD4AJLk+AEi5PgDQuD4AuLc+AAC2PgCwsz4AzLA+AGStPgB' +
                    '8qT4AEKU+ACCgPgCsmj4AsJQ+ACSOPgAUhz4ACH8+AAhvPgA4Xj4AqEw+AGA6PgB4Jz4A6BM+AK' +
                    'D/PQBw1j0AkKw9ABCCPQAALz0AgLM8AACwOgCAm7wAAB+9AGBuvQCwnb0AMMO9AJDnvQCABb4Ak' +
                    'Ba+AAAnvgCANr4ACEW+AFhSvgCAXr4AeGm+AGBzvgBQfL4ALIK+ALiFvgDMiL4AWIu+AFCNvgC8' +
                    'jr4ArI++ADSQvgBkkL4AQJC+ANSPvgAMj74A5I2+AGCMvgCIir4AdIi+ADyGvgD4g74AuIG+AAB' +
                    '/vgCger4AYHa+AEByvgBgbr4A0Gq+AMBnvgA4Zb4AQGO+ANBhvgDoYL4AeGC+AJhgvgBYYb4AyG' +
                    'K+AABlvgAIaL4AwGu+ACBwvgAIdb4AWHq+AAyAvgAcg74AZIa+AOiJvgCojb4AnJG+ALyVvgD4m' +
                    'b4APJ6+AHSivgCMpr4AeKq+ADCuvgCssb4A8LS+APS3vgCsur4AFL2+ACS/vgDIwL4A/MG+ALjC' +
                    'vgD4wr4AtMK+APTBvgCowL4AzL6+AGC8vgBYub4AtLW+AHixvgCsrL4AVKe+AHihvgAcm74APJS' +
                    '+AOSMvgAQhb4AkHm+ADhovgAgVr4AYEO+AAgwvgAoHL4A4Ae+AJDmvQDwvL0AQJO9AGBTvQAAAb' +
                    '0AgD68AIABPADA3jwAoDw9ADCEPQDQqD0AIMw9AMDtPQDYBj4AyBU+ANAjPgDYMD4ACD0+AFBIP' +
                    'gC4Uj4AMFw+ALBkPgAYbD4AaHI+AKh3PgD4ez4AcH8+AAyBPgAEgj4AnII+ANCCPgCogj4AIII+' +
                    'AESBPgAggD4AkH0+AJh6PgBodz4AIHQ+AMhwPgBwbT4AOGo+ADBnPgBoZD4A+GE+APBfPgBQXj4' +
                    'AEF0+ADhcPgDIWz4AyFs+AFhcPgCIXT4AaF8+ABBiPgCAZT4AyGk+ANhuPgCgdD4A+Ho+AOCAPg' +
                    'BwhD4AIIg+APCLPgDgjz4A9JM+ADSYPgCcnD4AJKE+ALClPgAwqj4AkK4+ALSyPgCYtj4AOLo+A' +
                    'Jy9PgDAwD4AqMM+ADzGPgB8yD4ATMo+AKTLPgBwzD4AsMw+AFjMPgBoyz4A5Mk+AMjHPgAYxT4A' +
                    '2ME+AAS+PgCouT4AwLQ+AFCvPgBYqT4A2KI+ANybPgBclD4AcIw+ABSEPgC4dj4AmGQ+AOBRPgC' +
                    'oPj4ACCs+ABgXPgAAAz4AgN09AAC1PQBgjD0AAEg9AEDvPACAITwAgBW8AMDhvADgOb0AoH+9AC' +
                    'ChvQDQwL0AAN+9AKD7vQBYC74AABi+ANAjvgCYLr4AYDi+ABBBvgCgSL4AEE++AHBUvgDIWL4AM' +
                    'Fy+AMBevgCwYL4A+GG+AMBivgDoYr4AgGK+AGhhvgCwX74AWF2+AIBavgBYV74AGFS+AOBQvgDI' +
                    'Tb4A6Eq+AFBIvgAIRr4AIES+AKhCvgCwQb4AQEG+AEBBvgCoQb4AeEK+AMBDvgCQRb4ACEi+ADh' +
                    'LvgBAT74AIFS+AMBZvgAYYL4ACGe+AIhuvgCYdr4AKH++ABSEvgDIiL4AnI2+AIySvgCMl74AnJ' +
                    'y+ALChvgDMpr4A3Ku+ANiwvgCktb4ANLq+AHS+vgBkwr4ABMa+AFTJvgBMzL4A7M6+ACDRvgDc0' +
                    'r4AFNS+AMTUvgDc1L4AbNS+AHDTvgDk0b4AwM++AATNvgCoyb4ArMW+ABzBvgAAvL4AWLa+ACyw' +
                    'vgCIqb4AZKK+AMiavgC4kr4AQIq+AGSBvgBocL4AeF2+ABBKvgBANr4AOCK+ABAOvgDg870A0Mu' +
                    '9AHCkvQAge70AIC+9AMDIvAAA2bsAgDI8AADlPABgNj0AQHc9AICaPQBgtz0AMNI9ANDqPQDAAD' +
                    '4AEAs+AIAUPgAQHT4AyCQ+AJgrPgCIMT4AeDY+AHA6PgBwPT4AmD8+AABBPgDQQT4AGEI+AOhBP' +
                    'gBIQT4AQEA+AMA+PgDgPD4AsDo+AEg4PgDoNT4AoDM+AKAxPgDoLz4AiC4+AHgtPgDALD4AcCw+' +
                    'ALAsPgCALT4A+C4+ACgxPgAIND4AkDc+ALg7PgCAQD4A8EU+AAhMPgDgUj4AgFo+APBiPgAQbD4' +
                    'AyHU+APh/PgBAhT4AoIo+ABSQPgCclT4AMJs+ANSgPgB8pj4AIKw+AKyxPgAMtz4ANLw+ABjBPg' +
                    'CwxT4AAMo+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAADsr4tVAAAAAK52FNIBE09wdXNIZWFkAQE4AeAuAAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAOyvi1UBAAAA0dNrsAE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAAOyvi1UCAAAAQof0+BBHS0ZLQ' +
                    'kpdTUZJP0NeWlooMMJgmmIzJfJfLVaTilzRuok2GgfjCUNFnYrZ88V5sTNoWnHchf0zEnKEUAvQ' +
                    '/WMZqBxq9ubVFtRkaIHaP8/qjdr3OI1sLw8w0JbplC7tSRkk69ss8zqpi3E5PJyW7zJkLGZifXn' +
                    'OwoOcdRQl9LVCkuPRaViNz8WBZE+NjyhFl7TSv80FohG42KCg/kEYDHqHqHgw0JbpkowOeQigdk' +
                    'kECNcxfDgwxpfARXnuehX3R52NrFYA7OWMtrKL0Qbgb89FGpA6tA2rnGcpPUPYfH44Uj05LJv7L' +
                    '3BAMNCVSu5KnaZ+SzV22mu/ubdC4lrxCslh7Ri79fhNKQUe/flG0V/c6H949aUSMqH4FGwygWQN' +
                    'PA62/TJfLnShvmrs3C87Y5aUuqgOMNCW6ZIRTurQ2ln96mvKct0kJZEchJKzcvFrTNRMKQAMMB/' +
                    'M+KZE+4rpWH8b1XpHXyWBqGRM0MCL8MFlNx7iIU6AMNCW6ZIRUVO9YAmtHQwpNxtIbuETXPalXt' +
                    '2FMQChB4pDXP2qUIz3Gm8rv9tgAUY74YnXlxJDZokybgPF1nvrR8T/yzbX0JoOwFYw0Wq/EGotb' +
                    'tbFrxYIQEfuN19Zl5CMCjzoJnH2qtoX6wLBrr46/nwa62xT5E1ejcPM5QpCeFnWk8G45Lxj4sXV' +
                    'CHT4ckLL6l88NLCu4L5VAKE0LJFKR4BT+d2nyEAw0TsZkhFOJ6pWsVpwPAtJxrRgeyb6UDvFNsC' +
                    'weuBZvxfzbLWR/Wmr9d6jG3YjayS8C9M0y9IO4yELpqfqY4j2ElcpMIbWXw8GQrA3vjDQlumULu' +
                    'L3khxZXHLcxyvzHQj6clGp/60Ly4uyxxPEp/ozZWshdgcSQ42J2NztWjSFm+uoM45apuG4sZ1QA' +
                    'nywk5nHgDAw0RDBKiCpHV+lZWzMydMAeEBMTjMsCXK+b7LY1jPRNZnsXOKxs5Y9jBgk/nwJfixh' +
                    'BkY8pKu99IAVg6OHx8AkbdLRuE0CQYTwMNDS4lyORA0mVa9QgvXkR0VfpC+PC2NA14pJ6gtBh3f' +
                    'tcKE6Ccoh9f5ZePwo9I8uPKEXADIrDrFtbtL2IJGYMNEQwSogqRwniouKc2/ceLE7hlKoaqP07T' +
                    'KSCiSVNebPO7pFnExRqMzvVYCZmiiRQjHqhyOkggguA1SkLPBn5dbZqDDR6Tpc801fBJRXRevL8' +
                    'Md81LiIQuRARbrL3/RQy8qv4TCezZTjqfy/o+vEX9kN7JyUT7ff3JKip2vhcw3+ZAMJKtDmAFPY' +
                    'hxUswhMZNCkuysXYLq94vl7lLP3t0qEw1vIvoKaEewXyMGaiUk9nRzUuaG+DNsSRa/KMWYgzerZ' +
                    'JV3NSqrei+B6vBlHCfdlZvHY82dp9CSyVVwrUtGd7nRVqZNcmaNHLOJ9Z6eONsQCkm8pdSJgChE' +
                    'gw0iRmudWtzT9rS6gFOUUJ0xHwD010GqJXcvCq+PleogCIk5CGHp8q1JoGL64YPmC1aYpo+Jfka' +
                    'VO28w/M/yqOjgS2SSrLu9vuA+9UHn1kKZ9RdN1iswmASFgwn6Lh4BFGV2ct76+JglT7nJYArIW7' +
                    'TTaPKNi2XLdwBXi3yH155dY8',
            ),
    },
    {
        name: 'silk-wb-voip-60ms-stereo',
        container: 'opus',
        arguments: '-c:a libopus -application voip -b:a 20k -frame_duration 60 -cutoff 8000',
        decoder: 'libopus',
        inputRate: 16000,
        sampleRate: 48000,
        channels: 2,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 240,
        reference: () =>
            base64Float32(
                'AHCiPQBAlj0AgH89AEBjPQAgPD0AIB09AED5PABAuTwAwIQ8AIALPAAAajsAAIC7AADtuwAAcLw' +
                    'AQIO8AMDAvABAubwAQPa8AADdvADgCr0AAO+8AOAPvQDA8LwAYAu9AADkvADA/7wAQMu8AADfvA' +
                    'AAqbwAQLa8AECAvACAhrwAACi8AIAivAAAnbsAAEy7AACwOQAAXjsAAJs7AIASPACABTwAgFU8A' +
                    'IAoPAAAfTwAADQ8AECEPAAAJzwAAHo8AAADPAAAUjwAAJE7AAASPAAAkLkAAGw7AADAuwAAQrsA' +
                    'gES8AIAovAAAlrwAwJK8AIDHvABAz7wAAPO8ACADvQBgCr0AwBm9AKAUvQCgKb0AwBa9AOAwvQC' +
                    'AD70A4C29AAD8vACgH70AAMO8AGAGvQCAZrwAAMW8AAC8ugAAT7wAAGY8AADgOgAABD0AwJw8AA' +
                    'BZPQCAIj0AgJs9AOCAPQAwzj0AcLQ9ALgBPgAw6j0AEB0+AGgQPgCYOD4AuCs+AMhTPgC4Rj4AI' +
                    'G4+ABBhPgCQgz4AMHo+ACCPPgC0iD4AlJk+ABCTPgC8oj4A8Js+AHSqPgBIoz4ArLA+ABypPgBg' +
                    'tT4AaK0+AIy4PgAosD4AULo+AFyxPgDEuj4ADLE+ABC6PgBwrz4AZLg+AOisPgAAtj4AzKk+ABC' +
                    'zPgBopj4AxK8+AOCiPgBMrD4AOJ8+AMioPgB4mz4AWKU+AMCXPgAooj4ARJQ+AESfPgA8kT4AxJ' +
                    'w+AMCOPgC0mj4A5Iw+ABSZPgCciz4A1Jc+ANSKPgDglj4AgIo+AAiWPgB8ij4AJJU+AIiKPgAIl' +
                    'D4AaIo+AHiSPgDYiT4ANJA+AJiIPgAQjT4AeIY+ANSIPgBAgz4AYIM+AHh9PgAweT4AeHE+ALho' +
                    'PgBQYj4AUFU+AChQPgAYPz4AODs+ACAmPgCYIz4AkAo+AFAJPgCA2T0AwNg9AACaPQAgmj0AQC8' +
                    '9AOAvPQCAGzwAACE8AIDFvAAAv7wAwGu9AEBlvQDguL0A0LO9AHD5vQDg8r0AUBu+AKgXvgDIN7' +
                    '4A6DO+AKhRvgBYTb4AsGi+AIBjvgCYfL4AEHa+AKCGvgCQgr4AXI2+AIyIvgCAkr4AGI2+ACSWv' +
                    'gA8kL4AXJi+AOCRvgBQmb4ADJK+ACSZvgDokL4AGJi+AMyOvgBolr4AKIy+AFCUvgBQib4AFJK+' +
                    'AHyGvgDkj74AzIO+APiNvgBkgb4AbIy+ANh+vgBoi74AQHy+APCKvgBIe74AEIu+APh7vgDEi74' +
                    'AEH6+AOyMvgCYgL4AdI6+AISCvgA8kL4AtIS+ABySvgAIh74A6JO+AFiJvgB8lb4AfIu+AKyWvg' +
                    'BEjb4ARJe+AIyOvgAgl74AJI++AASWvgDgjr4A0JO+AHCNvgBokL4AmIq+ALSLvgA0hr4AwIW+A' +
                    'FiAvgAofb4AaHK+AJhsvgAIYr4AEFq+ANBPvgDoRb4A4Du+AHgwvgBYJr4ASBq+AKgPvgDQA74A' +
                    '8PC9AEDbvQBgw70AgLC9AACYvQBwiL0AAGC9AKBHvQCAF70AgAa9AECuvAAAnrwAgAC8AAAHvAA' +
                    'ASjsAAMA4AIA4PAAAujsAgIY8AAALPAAAmDwAgA08AECSPAAAzzsAAG48AAD0OgAAEjwAAI+7AA' +
                    'C0OgAARLwAAPi7AACnvADAjrwAgO+8AMDhvADAG70AIBm9AKA9vQAgPr0AAFy9AKBevQCgdb0Aw' +
                    'Hm9AKCEvQCAh70AMIu9ANCOvQAwjr0AgJK9AICNvQDwkb0AMIm9APCMvQCAgb0AwIO9AKBtvQAA' +
                    'br0AoFO9AMBPvQBgNr0AoC69AIAXvQBgDL0AgPC8AADUvABAtbwAwJC8AIB/vAAAJLwAACe8AAB' +
                    'euwAAzLsAANQ6AACFuwAAkzsAAIC7AACjOwAAv7sAAEo7AAAhvAAAiLoAgIG8AADuuwDAwbwAAH' +
                    '28AMAHvQAAz7wAQDS9AGAVvQAgZb0AoEe9AFCMvQAgfb0AsKa9AFCavQDQwL0AcLa9ALDZvQDA0' +
                    'b0AcPC9AMDqvQAIAr4A0P+9AAAKvgAQCL4A2A++AMgNvgBoE74ASBG+AJgUvgCIEr4AaBO+AIAR' +
                    'vgDoD74A6A2+ACAKvgCwB74AUAK+AGD+vQCg8b0A4Om9AMDbvQDg0r0A0MO9AAC6vQCgqr0AoJ+' +
                    '9ABCRvQAwhL0AAHC9AMBRvQCgQL0AgB69AOAVvQDA4rwAwOG8AACYvAAApbwAgDm8AABuvAAAxL' +
                    'sAADG8AAAeuwAAE7wAAFC6AIATvAAApLoAgDC8AABuuwAAZ7wAAP67AECZvACAWbwAAMe8AECjv' +
                    'ABA+bwAQOC8AGAWvQBAEL0AgC69AIAvvQAAQ70AwEq9ACBSvQAgX70AQFq9AMBqvQAgWr0AgG29' +
                    'AABRvQAAZ70AAD69ACBXvQAgIb0AQD29AID0vACAGL0AAJO8AMDRvAAAfLsAgDu8AIBIPAAAnzs' +
                    'AQPU8AAC6PABgSD0AICs9AMCMPQCAfD0AQLY9AACoPQDA3z0A4NE9ACgEPgAQ+z0AiBc+AEARPg' +
                    'CgKT4AcCM+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAABrMMwPAAAAAD94G0ABE09wdXNIZWFkAQI4AYA+AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAGswzA8BAAAAYrTkYwE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAAGswzA8CAAAAI0neLguo3uTPt' +
                    '9PVw5OxOFzgfm80HlXDBTd87jPZZsLqCK/SGKIR0wDxGJ8LjAZF9B428IqzczpkWv9L1bl4liZL' +
                    'UX1sJ0moLYrXY0fhlErwVzF0sxRzv4rDyPxGVPKkFxX5pjeXOavctdpRNaeU26bHAi2Nv2x6n0B' +
                    'plew1z/ob1yt1gPlE+0jEpu0wtfhLeQ0JjH6lX0UgxaSLwQ+MkZQJ4wpOr18+sjIqjSn2V9zlef' +
                    'uFydLrQFzgRc6h6msbUuhJy5FMAdlvqYfp+ncfIX9YiWkEgccFUEGDFUb45raB3A+JMO5+v+rav' +
                    '6eQhZO0dejbdPRulkvhPBObJjiTiyym1K3Fwff6ES+YKerLKFK66rGnbjgZGqJlOEm4ieuJ5ram' +
                    'cUc2ebucZ47BhE0eVeZlYCGJZ7DcSYW+dAR0Rwl8rRPuYDVQ7TBfA1d6e3oXAKiLRFJjU72hSLI' +
                    'kDEGcAmLO5FmdqfKIurVvy8T/zHLRpuJIN4F/mApAwkXx1no2jmt5NQ8CW9tqV7g+/U5/D1ThXY' +
                    'RTwFzgRek1hCMaV652TZR8yVBIlCp73qfMcV9WIR5THaQWKZaituOLyJ/pNqF/kV5KXwJgLO7zg' +
                    'Qa0/YvhtvkqA1FH2iCHuOm9wp8XFcKGASniNir+Ljvr9wcjKsjkwcwE0fHSe9m9SEWrHEKfIO+W' +
                    '+kkWGC3JcaTk8D2rBKQgbO3icAqDJZ6xw97ePYm9mGbyhnLgfzQM/Yrtc2G/1oByY8ZTaQQGnye' +
                    'nGC+h+yADeChd0/7Hjtsw0Cz++JYo0+sXZ+ejvFVhbsReviqAnlpN79ZIryWl05WXblmRggZj3J' +
                    'MAdrlHGFzgR67MrCaTS5DPCMMkMk1OTL+3kpOxifiAchOTTgNsmj70oll5iD4zGu6naD+N7dUFv' +
                    'YJrpZKRiYLj47gxDKPl3k8c3JMBjcUqNfyRWpDWZQ3aBqNqrHBUNJJVNgAnJF4C2/IjEX3OvjMe' +
                    'y9YgV2REDIqQOnGsr0XAHW9gqKVm/HcfccFFBoigp5kGyyLqZCpyn+KgQ1chg40zLq4l5qE/nkp' +
                    'G16CEzCGBn7qF2vzJr6HwZaysvMyP8u/fQAUL74TSyRCOzOC97xqAakXiBFzgfucBk9DV6q8mQj' +
                    'RCW21UXLnkQdfrwKP6tb11rp2Sh8cPAIGBt7Vk4gf1rwnuPYKq7fWYxLHOw7KjPzMPMCsoM71RM' +
                    'J0oGFNQn5UBiP08R0Iio6r/g8ddApyqFYkA1jXvOwMd059FkDICD6IXazvpIk3YM3uQUGxGVmmc' +
                    'IpApm/yIWXDG8ju34qr9vfH1ae4SwKSj+IoUWtAD+DtofBIpxLe4zl3+N0W8WsMn9Nfvjb2z6d7' +
                    '0wFzgRjm55o+rZrH/oJ9+LDll9gKQW2atLKJkfe9kDTxKAB1fDjF2zgW3Mnzqmoe52ujeYLZjUV' +
                    'yRo5bdpc6OBM92MpPqB34YSVwHo32z/w5XjHnqO6mV6qNIjxRWzQN6gN9clFyDZU3lLcJqaVZm7' +
                    'JACriBpq9fbWtS6gLVPYJR2mkx1xLLD35unHxQ2QpJYx1pRBkv8NJGdf4+yw/fhdM9KvWJjYFwG' +
                    '5TeP8RGvNBC7pby3rij0ctYtIvznGxrAsh9NSobEDwXkWa88ysO5BMj0Xfxc4EfjWg5Qg5OXanV' +
                    '3y+L9EZ0feZTVE2VdgJNd2yYrdRNqYkrJLcEYqcOIXjVZpdPYO/B2CuwPfbQj5/mcMIC9Zeu1kN' +
                    'RyvUB66T0u8EKqdENN7/ljRFUAa4KzaGNc2/B7e4erQp23aOFVp+SxKyCWeS4/l6CQUOU1KsIL6' +
                    'KK1NyDySjzsDt2WjpWll5WE3P0tTZvslTGKFffunk10KikMbQeePJ4WKJzGVRgDjQXwkWtCsIFE' +
                    'gN4ObfUmkKhYOWrZAsGQwdQ3GkVhq+ob4fNQWrXxT4Bc4EZvwy2vdIln87/qUAI33mSeTcx8vOL' +
                    '/72o0lIQeCLXUD4FWbXuxfZzYD/OXyN3l0BCSgcTxNFmUZ6bhnZSDG7WWWHbxb49OY05XXixQqP' +
                    'BCtSbvgUAtUVSIzXur12YWR957Ib69V++9L3eRryTa2c+rHrsZv6qpr/i42uTGSaBfT0epqwybi' +
                    'TlkSEkbvD1Il+kWv2BcVxu3vwzlN1L6xUi08KlVUm2kgrtET5KJy/I9E/ZCHSRd4AD6RNmTKnnV' +
                    'Rlhc4EZv8NfqoIceKv/YktDJjfRPGVGMlwMyFZAJrFAuzqOxUGs4CoU9MK3JkIGNU2g3fwJHyxT' +
                    'sOaQ0WIkOukGTrqCv4toyhD6Lq8d+w6/EQs5uJKfPI0J4pJGT0aj22ld0kCiSfZsT9eIbPgADoO' +
                    'pKnnoFCg1B2m1WG32qAcT7YBm7fgfDoW5+wq1ewrksRhhuAoBc4EaLfjmGGx3osDJA5nPFUhzl7' +
                    'MY6niy44aVEBiWnhnXJIRE/s7UUkXqFJurBGBM08t1SfEyDOfWA5EKAMYrFk9cONXK4xT/hLPvK' +
                    'CrFBjDvbjD2/qCQif5NPWC1IeL06yRIgOwwiA0gRemhslU10/fz51UGvQGHAyHIY1KvcZjdxSmL' +
                    'jaWEmBmfVA15RDDB+aHudSNMXuxSj/dtm7lvE4ngU1Sv5XiYiVpe0Tplg34BcADlJkbd/7xs3OW' +
                    'GoKGDSA1r+c8DTt35KQr95+ZIcJRVMwYP6jpPhuxkY0Mnw3M9Av0Pt5xZpQA==',
            ),
    },
    {
        name: 'hybrid-swb-voip-20ms',
        container: 'opus',
        arguments: '-c:a libopus -application voip -b:a 28k -frame_duration 20 -cutoff 12000',
        decoder: 'libopus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AGCNPgCkkT4AYJU+AJSYPgBAmz4AZJ0+AAifPgAooD4AzKA+AOigPgCIoD4AvJ8+AIiePgD8nD4' +
                    'AJJs+AASZPgC0lj4ARJQ+ANCRPgBYjz4A6Iw+AGiKPgDIhz4ADIU+AEyCPgBQfz4AoHo+AKB2Pg' +
                    'BAcz4AaHA+AOhtPgDAaz4AGGo+ADBpPgAwaT4ACGo+AJBrPgCYbT4AGHA+ABhzPgDgdj4AmHs+A' +
                    'JSAPgCsgz4A6IY+AByKPgBMjT4AjJA+AOSTPgBklz4AAJs+AKSePgBIoj4A4KU+AFCpPgCIrD4A' +
                    'aK8+ANyxPgD0sz4AvLU+ADi3PgBYuD4AFLk+AEi5PgD0uD4AHLg+AMy2PgAAtT4AtLI+AMivPgA' +
                    '8rD4ADKg+ADijPgC8nT4ArJc+AAyRPgD0iT4AgII+AGh1PgAgZT4ACFQ+ABBCPgBgLz4AMBw+AJ' +
                    'AIPgAQ6T0AMMA9AJCWPQDAWD0AoAQ9AIBFPAAAArwAwOK8AKBBvQCAiL0AcK+9AEDVvQCw+b0AS' +
                    'A6+APgevgDgLr4A8D2+ABhMvgAwWb4AQGW+ADhwvgAger4AdIG+AEiFvgCQiL4AWIu+AKSNvgB8' +
                    'j74A1JC+ALCRvgAQkr4ABJK+AJSRvgDQkL4AxI++AHiOvgDojL4AMIu+AFSJvgBoh74AdIW+AHC' +
                    'DvgBcgb4AgH6+AEh6vgBAdr4AoHK+AHBvvgC4bL4AYGq+AFhovgCgZr4AiGW+AEBlvgDwZb4AoG' +
                    'e+ABhqvgAQbb4AYHC+APhzvgAAeL4AwHy+ACyBvgBchL4A3Ie+AHyLvgAkj74AzJK+AHiWvgBIm' +
                    'r4ATJ6+AHyivgDIpr4ABKu+AAivvgDEsr4AMLa+AEy5vgAgvL4AqL6+ANDAvgCQwr4A1MO+AJzE' +
                    'vgDsxL4A0MS+AEDEvgA4w74AoMG+AGi/vgCIvL4ABLm+ANi0vgAMsL4AqKq+AKSkvgAAnr4AzJa' +
                    '+AByPvgAIh74AYH2+ABhsvgAgWr4AcEe+APgzvgDgH74AWAu+ACDtvQBQw70AcJm9ACBfvQBgC7' +
                    '0AgGG8AADKOwAA0zwAADg9AHCCPQDgpz0AEMw9ALDuPQDQBz4AYBc+AAgmPgDAMz4AeEA+ABBMP' +
                    'gCYVj4AEGA+AIBoPgDwbz4AaHY+ANh7PgAggD4A2IE+ABCDPgDMgz4AGIQ+APyDPgB8gz4AuII+' +
                    'AMCBPgCcgD4AqH4+AMB7PgB4eD4A6HQ+ABhxPgBIbT4AoGk+ADhmPgD4Yj4A8F8+ABhdPgB4Wj4' +
                    'AWFg+AOBWPgAoVj4AKFY+AMBWPgDQVz4AYFk+AIhbPgB4Xj4AUGI+APhmPgA4bD4A8HE+ACh4Pg' +
                    'AYfz4AcIM+ALCHPgAgjD4AlJA+APyUPgBkmT4A9J0+ALSiPgCApz4AMKw+AJiwPgC8tD4AsLg+A' +
                    'Iy8PgA4wD4AjMM+AFzGPgCkyD4AiMo+ABjMPgBczT4ANM4+AHTOPgAIzj4A9Mw+AEjLPgAEyT4A' +
                    'LMY+AKjCPgCEvj4A1Lk+AKC0PgDsrj4AuKg+APShPgCsmj4A6JI+ALiKPgAYgj4AMHI+AHBfPgA' +
                    'YTD4AcDg+AJAkPgCAED4AYPg9AFDPPQDwpT0AAHo9AIApPQCAtDwAAEY7AECBvAAgDL0AIFW9AD' +
                    'CNvQDgrb0AkMy9AODpvQAAA74AYBC+AOAcvgBYKL4AoDK+ANg7vgAIRL4AUEu+AKhRvgAQV74Ae' +
                    'Fu+APBevgBoYb4AGGO+AABkvgBIZL4AAGS+ADhjvgAQYr4AmGC+AMBevgB4XL4AyFm+ANBWvgC4' +
                    'U74AyFC+ADBOvgAATL4AOEq+ALBIvgBwR74AeEa+AMhFvgCARb4AwEW+AKBGvgBASL4AwEq+ABB' +
                    'OvgAIUr4AkFa+ALBbvgB4Yb4AGGi+AKBvvgDgd74AUIC+AMSEvgBQib4ABI6+AOiSvgAImL4AUJ' +
                    '2+AJSivgDEp74A2Ky+ANSxvgDAtr4AkLu+ACjAvgBwxL4AWMi+ANDLvgDczr4AkNG+ANzTvgC81' +
                    'b4AJNe+AAjYvgBc2L4AHNi+AEDXvgC81b4AkNO+ALzQvgBQzb4AXMm+ANjEvgDAv74ABLq+AKiz' +
                    'vgC8rL4AaKW+AMSdvgDUlb4AjI2+ANyEvgCQd74A0GS+AJhRvgAQPr4AUCq+AEgWvgAIAr4AoNu' +
                    '9AHCzvQCwi70AQEm9AED4vACAQbwAAM07AMDCPACgJj0A4Gg9AOCTPQDAsT0AwM09ANDnPQDw/z' +
                    '0A+Ao+APgUPgAAHj4ACCY+ABgtPgAwMz4ASDg+AHA8PgCoPz4ACEI+AJBDPgBgRD4AoEQ+AHhEP' +
                    'gAIRD4ASEM+AChCPgCQQD4AeD4+AAA8PgBgOT4A8DY+AOA0PgBAMz4AADI+AAAxPgA4MD4AqC8+' +
                    'AHAvPgCwLz4AkDA+ACAyPgCAND4AwDc+AMg7PgCAQD4AyEU+AIhLPgDIUT4AsFg+AHBgPgAIaT4' +
                    'AcHI+AGB8PgBUgz4AmIg+AASOPgCokz4AeJk+AGSfPgBIpT4A/Ko+AHSwPgDAtT4A9Lo+ABTAPg' +
                    'AAxT4AoMk+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAADV6yiwAAAAAL5fjvkBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAANXrKLABAAAAPkNC1wE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAANXrKLACAAAAWO7TwR9TU1haU' +
                    '0lQVVQ8PklJQkRHSWVdT1BQT1FQjlJST1J+aIR6bkW0WhKxcHWUDDGiSeuFJwEmmJggKTHsgb2D' +
                    'q96KKgQu0yzncl7EkEaxJUE73Tcws8DAkPPYuJ+8SODeTgIA0R+ZbyDaWBFpvPTg+XNUBt5oqMw' +
                    'WtKELLhQbhfv3yQ5ny6VA6ZVCdBMpy6aA61F1ivurnygzPlEqK+gWSayIQr3YHn4bYQQdrKweX8' +
                    '9VHHBYWrq1o0QIP9B5W/1Gpcrly+R+vWiesVlxIqLPGQzmy2m5b6S9Qkt6M0CEVd/q/G7QshPsr' +
                    '5grYJS/LlrdQ7MQsWh5nk9s8UgElm5rIyRsQnkOaUOjHHQZWGAcQP/JsIxsyefvrfEdfQFNpUNo' +
                    'nrFZeN9S2Xtss6pSpM3EAak6/2JiFeX+4p4r9a4TqfshReozDW3KiqjMh4WCQBtFlJPqEClyB4F' +
                    '0uzuoad14mEk3hi4sV9QOeWTOj1cdOQJ/k4pVSFUEyIVon/m5eN9S2X/DZoHzpLYw6/E40JHeAV' +
                    'lqjgkpg77EPmnRM/mgHve6wUM5bVhQr3y5Y3u1TZgDS5bpBFhvcxZXVnuPGM1agj5bwHjz4C4Pe' +
                    'Ib6w2if+ZqLE41Dh5s9V+Oxji5r8WwtdubhdkPtXBjTgJxoEXx3NqNT+pBi+Hp2NH4a33q0J69N' +
                    'GWJausv8+UotDiSoU9KPac7QhnVon/m5eN9+BnwWUQLB1MqQ10ogVMYBUg1p8UxJTePLbEZ1ddk' +
                    'eG47VMqYZbVoNNNH4rL9npyWe3tQs7X4+Izw53p8SPwalgd+f2ShzoO0hO2if+bl431LTYAcYi2' +
                    '3Jbx2QqcKQ4TBBnaqMhKTd74YRTSjlsoWnvvi13ytpXHfBHxW2KIMeEMx+4bzjAfmAy7ZGLJYMf' +
                    'foaWdDmwSd4bKeuFk+Cy0Non/m5eN9VK9mMTvHOIYvIIHRlN1/HeonZ9uR7dsEX5TKsF/QKS5C+' +
                    '7sXRtbeNsQczDmU0oUOFrWvKiLRS95p9NbQ9NnN6CHor1iSnhkDnBF9JU35Ink0kslalXZZnwt9' +
                    'rgjCpWAhiuDDeTvQTJ1VW2rZTk2mZhwc0fvyWBYH8yc9dq3Tdqu3WegrJUFMX/DxInWjaiOCyes' +
                    'hrF6q9paz3jd+CNgzcAG557CsRemeDhd/xBuutQY2V7lTiWu7kTpy02hrlQhatuGACfjoYcEick' +
                    '4cDBmUrPkO3rIeU4qxjwSxQDxzHiV1V8ergIH281tuyQWI0Jt5daMyqMlKAb6a/tyhxaF4lKbrm' +
                    '6xFXUb1xFV8ga5FwFEBInbNU9VEf4P0emyT3imTpzXs83IL14YtTtiLkhcxSd+QgdZ0hdcrY6mH' +
                    'THGoQO5RgU1Sbj4UNyzQMOuvgvRZka8ZBULPYowIkSK3kA5VaDfoVOeiOAM+rVOZLQecq8T5iMj' +
                    'AH2dPKltNjodo7bqnlTkaQggQmrn9PHDVTSwh4O6EQIdWmhp3xsWWASJ1o+WX5lgwJttIXorT93' +
                    'B6H1en3hbpnbAGGNUzSeCiK8WO5ogZ0zqU2ANiCbutaRcUQxLFedi9Zu7TWL8ibu/nZisxInJOH' +
                    'A3OW0JJyEx2l4Bv8W9ZikqZ/55v7bLEs8GtqkAv5DjTHLZiVWTFBDK4OeLto8ZuvO+P85Q6dN9X' +
                    'oiSF+y1jxO0Xhy0ick4cDc5bx427dzA1fk7Fc5MZQrWZ7BTX3GJm7PU5sY05ZyKUF/MGyrlrHIW' +
                    'H2jPHrVCTr52/8hnLzKYr0e2CYH8u7aWSlHkBInJORdWOeLmuk4zAlEh9mMktGMfO/sdRsSnSW3' +
                    'bfDR4KDB1JNemL8GSWKayR66J3PJr5p7ds2GNZwal2jm0w5HdwAf1wGGL4sOrqOhc+j/zMa1OC1' +
                    'tUE267rB98NpAL068nrHvNjIyyjufBFYMBySDJP9/1vasnMr3Lq2FjUuyoOdCjOkxyHaVpAAddW' +
                    'BitIyM8Piv8JP6OOskUhK1qi+K+k0H28eIv77KZjLDnIy0sEMur/LxQI6brEij0nLN6CjVdjBGd' +
                    'YMAZoivYUHUbwvfaxm5cT+XwjC8FTSPpxtHD4GdH/CJEUnHC2QYY9lEtb464TO58H+sDqFP+11F' +
                    'fAIKqqnuMc/6uWpxyxhg0S3F1XYwUYisGcike5dlepLbihPWJFRgl89o6wJa/csL18wge7jQ/N2' +
                    'jyrgx52uphrYavoPgXvgiRj6M8k4Z1hV51Dg6S3yWFk8uBSM2ExJm3CzVNjEfTdzicEQH1lELap' +
                    '1rKEL8t2xAjVUJ88vbFK95ONgiV4sRAMVh3/pQDxcUozKQOV294sOheVbjInf25KvOe6xTFAYOR' +
                    'g5r/rVj/ogATdU2MR9Nlx7FYWdE/P1Q9AcxI/lbvPamLoV0AunV/n6MlTGBydehClxOunZ8GBte' +
                    'sOKLJKfgHHbDguBVDOc0lq0MgMaVbf5K8Ou7GUmQQDTVdjEnNhDR81Dwb3ACY0RtPQ73+RT398R' +
                    'T0UxNXXSzVBkJzoO2kZtW4x+F2o/eg3Lt102PsQ0Cc0BpnjT5TWZfV6SZx0gXVn9sczKQc03C3m' +
                    'LVdjBRiHTOHPyQN7c94Quyzkgx8o4UvZBAwdXoAahtz3QvjVbU7OUexpIUrAjWBxmj2YBG2p3rx' +
                    'gBTJCb7retlaX2vOZYsoGVqcYzYzXbuRdU2Mpq4io/S6cxowKNe4elOrgWklo0eQRVfKA66CDqt' +
                    'pLgogA1ibtr+vIA4GsRxctMiCuWMHvDdBOc3He9kQxjpolTx79TAXKTMeJgV3dg6XLwrGg8f3af' +
                    'BwevlUrei+yumYfDYmVzIi4DbS907xSKCpM1ruCwAKzSvDgr3OHGtz8j6AWyIL8V5HI9ztqV1tj' +
                    'ATsPGOz6N1xgQpjdfRu8Dvg5rJM5/SXnPTYiYU30jQKzhY/+LRhm9inOQbV/duO6dWWTPSoVLwy' +
                    'ZzM8mUzvu9E6JudS5YrGKnuucnBpmHz1TYxG0rtNJ31K4YAbs2hn7ykZkc7O+O3/MutXkmLMVR5' +
                    'qqu4eyf0nusC5Kcn+tlf7TWp8kLKn69+wpNoOk0xhGtSkUprk9i8fmvDrWwIuIWyEtV2MSc/yae' +
                    'UeVwbl+miLYo34KpC1MSNEMUffe+YJNXlmvStndY4CUIkimD8dMTLlWDfxz4Ye9vwTITQZAw4T0' +
                    'eTj6h0wjllHL2HMeCjGnLVNjBRz+VSjruym1L6NmmX3x4yo1BYSR2J9y5nqYuFtPXLV+srqhcww' +
                    'Xvq3Meg7WAWXuSu8QIpVOdUq3UanHq+Xq/yc61kAT4PLanHPB7SeoYt1XYfUD3g+c6uyCn9pjJa' +
                    'i40Rh9/lm+pXgqUJgYfSkeNcN1BjnD1QSqx40/UPLDGROWSFSGQIgmTTjs6xpt68hdHs7WLXIxQ' +
                    '4cjwO/8uI6pYXJ5T5NGLyAS3nUZyUD3d4iC6vuJrnHF4D2jjf4k/i4EIly75gGhbiIINKWmK0TA' +
                    '=',
            ),
    },
    {
        name: 'celt-fb-audio-20ms-stereo',
        container: 'opus',
        arguments: '-c:a libopus -application audio -b:a 64k -frame_duration 20',
        decoder: 'opus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 2,
        seconds: 0.5,
        frames: 24000,
        referenceStart: 4800,
        referenceFrames: 240,
        reference: () =>
            base64Float32(
                'o2TxPRPIAz2IggU+uH9pvKlWET5IOXq9pSccPjy3270r+SU+6WYbvrXDLj6QMka+G4I2PqxZbb7' +
                    'tQz0+7wKIvmsHQz5Pz5a+Kc1HPrTZor7doks+M/2rvj2VTj7VMrK+W6tQPt2Rtb5X8VE+fUW2vk' +
                    '98Uj6Th7S+OU9SPle0sL7jglE+UDCrvkYxUD5JaqS+xWBOPmXenL4BK0w+o/6Uvq6fST4ZRo2+0' +
                    'NhGPmgihr4o7EM+5eh/vgvoQD5kH3a+3uo9PgpUb768/To+C+Jrvr06OD7l2mu++rU1Pkkkb75d' +
                    'eDM+/oZ1vuChMT5cgn6+8zowPsbBhL47Ty8+tOWKvjDwLj5mPpG+licvPk1bl74tAjA+FcScvui' +
                    'GMT5xAqG+V74zPqGko76uqTY+SUmkvrNROj5SmKK+oLQ+PpxRnr4mzUM+QU2XvmejST7PcY2+fi' +
                    'ZQPlzMgL5wUVc+sfdivs4kXz7MbT++QJBnPhqoF748iHA+ftXYvWH+eT4wanq9ePKBPiaMc7wzF' +
                    'Ic+R3kCPZ5ejD4Nsp8928eRPmXY+j37QJc+Rk8oPvLEnD54oE8+MEmiPo6Rcj59wac+ckOIPmMh' +
                    'rT6YipQ+/l2yPkH+nT5gb7c++JmkPgVHvD6ZbKg+TN3APl2oqT6oJsU+yJCoPkcVyT59d6U+yaP' +
                    'MPv3FoD4Pyc8+EuyaPsJ60j7NXpQ+ILDUPnuVjT50ZdY+VAmHPqWR1z6NIoE+zi3YPs13eD6sOt' +
                    'g+Z1FxPuqu1z7oPG0++4fWPh+GbD5nxdQ+Cj1vPqdn0j5OPHU+kXLPPuZDfj5V3ss+IeiEPqGvx' +
                    'z6rpIs+ne7CPib4kj5xmr0+CWyaPjC6tz7dj6E+71OxPivtpz5fbao+OQqtPs0Ooz5UdrA+cECb' +
                    'Pj3OsT6MC5M+QcCwPhh5ij7xCq0+N5OBPneCpj6SzHA+UxedPhv7XT5705A+Y8RKPr/WgT4EQjc' +
                    '+w7lgPpqMIz5HcDk+CLwPPo2cDj7izfc9vEvCPdNH0D1NMEg96B+pPSULGzvvcII9prAyvSTWOD' +
                    '1aYLS9LDHdPNobBb6/YBk815AsvkYc/bv0wk++9zDGvLkZbr4KsCO9NJaDvs0mYb3vYI2+XbCNv' +
                    'XxplL50Fam9wsCYvim3wr1WmJq+pnbaveAymr7wS/C9Q+iXvrwdAr7qHZS+hRsLvtw9j74IJhO+' +
                    'lMOJvno4Gr78I4S+xlUgvjijfb7QiCW+zm10vkbWKb6HVW2+3Ustvnj0aL4B8C++z7Rnvo/PMb6' +
                    'b1Wm+aPkyvvRfb76qfzO+Ci94vlJzM75Z+YG+fN0yvtoTib4d1zG+qRiRvjdwML5Fnpm+9sEuvt' +
                    'E1or7U4iy+7GuqvpTYKr75v7G+NcYovtDDt77TvCa+bAW8vuXEJL7oGr6+kv8ivv+5vb6+fiG+N' +
                    'qK6vg5MIL4CprS+wnwfvvq4q771Jh++WOmfvqBPH771VJG+VgUgvoA5gL4nWCG+ENpZvoVLI76r' +
                    'oy++fu8lvs/DAr7xRCm+ymKovT1ULb5zBBS9biUyvj+9GjxwqDe+TmlbPS7nPb7RCcM99eNEvnj' +
                    'HCD4mkEy+vOsrPjrmVL6ZVUo+299dvsqaYz5AdGe+iYN3Ps+Qcb7TCYM+Ji18viG5hz5NnYO+tv' +
                    '2JPp1Qib7OH4o+cyqPvmxyiD76H5W+hVyFPlUmm77oTYE+CzOhvm92eT4zPKe+PTBwPsY1rb76q' +
                    'mc+oRKzvia6YD71zLi+4gJcPuJUvr4zHVo+pp3DvkZvWz40oci+eyNgPvhPzb7rTGg+YKHRviq8' +
                    'cz7ni9W+ZwyBPkMF2b6pcIk+wwbcvnqwkj49g96+f2qcPsl14L7EKqY+EdvhvtZ3rz6kquK+fdy' +
                    '3Ptjg4r6l3b4+83jivtcJxD63b+G+vf7GPi7F375Qasc+bXfdvjgRxT7Kh9q+IMm/PkD41r4Cgb' +
                    'c+lcfSvpxKrD6f/c2+xEeePg+gyL5sso0+g63CvtfGdT4ZMry+9nZMPmg2tb4MaCA+mb+tvtZO5' +
                    'T3C2qW+Q2aIPbuLnb6lK7E8qtyUvhmts7zM3Yu+tFiBvT6Xgr5sKs+9KSlyvq12Cr7cxl6+n8Io' +
                    'vpEgS76EE0K+CEs3vpsxVr7WYCO+Lx5lvrx+D76mDm++wWz3vRdedL60P9C975l1vvCoqb2AbnO' +
                    '+ctyDvRSnbr7b/D29eiBovh2s7LyjvmC+3d5EvFx2Wb6Jhok7+RlTvl5ioTwea06+VeYMPfIlTL' +
                    '6HwkU9LsxMvtAlez2qt1C+H2SWPbcgWL5gUK090wRjvtVawj2CMXG+YnHVPUgngb75luY9XuSKv' +
                    'l3O9T2ddpW+uYkBPsx6oL7MRAc+cHarvv4WDD789LW+RAgQPkl8v765MRM+g4vHvi6OFT5xu82+' +
                    'OS8XPhij0b5YKhg+F+3SvsOIGD53Y9G+W2QYPt7azL6Pyxc+OkfFvs7RFj61s7q+EYoVPjBGrb4' +
                    'uBxQ+5D2dvrdhEj4z7Iq+O6gQPpZ3bb6k8g4+jkRCvvFVDT59QxW+J+ULPgwFz73vsAo+0GFovZ' +
                    'zOCT55EWG8',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAABl8uhbAAAAAPZdbf0BE09wdXNIZWFkAQI4AYC7AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAGXy6FsBAAAAwX8RxQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAT4XgAAAAAAAGXy6FsCAAAASRz2ZjH/RP8Q/' +
                    '0f/Cv8M/wv/Cf8L/w3/E/8T/wT/Rv9L/fv+/wb/Df8E/wf/Cv8E/wX/B/87/H+Gj/tTM2U2hCtH' +
                    'uO8Rg0xVGq+GSJVthxSr0sVVazLsyyiS9VpKAV2GsQKoW6dV95AvMMCzjYi3ylEBoQX0Uf+2zHC' +
                    '2h2uubyUm+ukIlxiF5nxN7JFNpazex+/Ix2RuhrFBWeYiqukck+qlMseXhS0UO07/51Fe0MlkLH' +
                    'j0cAFzKJ6dlRGDcuYMYMyw5am2hBb4S2kPyMKF0qWVVgNtRjkJfu1ca5fFjFieJauEbgpBQvovI' +
                    '/sEG3ex3D+qXnYvzga/krpwyKO8LYJhjjf9NvLR1KGNYf7z/y+SZ8iIXCHUjrJR+Lzv01FHqG96' +
                    'Lx6yrepU0vWGuSoNX7uHCja2+liaw5dcKdbckh7IS/7s0SE7VyF5Vw8iG2ksjQybcmS5BnqD8bc' +
                    'LNG3ujK1E1iHc8fetSVaqRrYKSJH/jGsi54tnNif8atCVi5ACxy1ADhhLdPUXmJ6eGKtzNi2zio' +
                    'gRRq77UTtpfzv3pWy/miPb3uGnL1WrNjI6lHiVEDuly6QBvlOs2tFyrWu0BDlCN2xv6n85c7vO/' +
                    'pj9f5T2UeO+GEJw/1towd3+msb1r6NdN+WW5XapVE2IBMX8jMQ0Lr6OU7lUZ5Hcl53zEuwxHV8A' +
                    '1NX4W3oubW0IvuTVsnPbyJrFS/erZG1+uwQO5BI8/XUpPWeyIAk9HQPSx5fbQ5dNDlpWNIVR0VD' +
                    '7fx+fCPF8eGYFo50W71KGuQ56u0c74tx+Zwwjh+cUiJmjwguO1IhJSLmAGwHlGrF/T3xs0ZI0dZ' +
                    'f57NkTs12tRBSg0qv8RcXvmEFT/MNUaZ99ZEzu4Y7q79zULhywmzKiF656uDmbnJXfuoncJkNzd' +
                    'uuY71/G26nmfgwhtSNH33y3DhbSJqDUME925N9iCi95YPLKTL0e2/5Fhu9HqIoLm1kO7/Sd7wRx' +
                    'BYNj1y0Nwxsl/7+LQQOkXJ8nyaCuRa7TiSG21PqSSlpxnBxtxeq/uNEQtZ7jbJGiEGqoOr/c1Ey' +
                    'OljDB8gCCClWZ0HFNwGYiiFWtjCsyeyN9Ax48NBEnxaLjU2fWSRIvzL48ejFj1p1Xf9zMp7Ok4A' +
                    'g1K3GIDgmaU+YhN4beKRB0nQygxJSwHCcqAAxRGZm3juVCGvaRkiTA+sgkzrzxpseMf+usEPNd0' +
                    'wFdZtE8jzTOBjzqV7U/SV2dtdT0bwP3PkDkPRdYa81HdKyoqGSwJZy/SD0t81rF4ixDgouDSUQ1' +
                    'fwwTDEvRilz8w8GnpxjYVyZbA3tD/4oYCPpXVFxABiyR2P910W7bkxm574WYMlseWpMvJuTvArj' +
                    '+obOxmsMuOG2rjmojJsvkIYnObyZ/T6fzU3+J0v76pCq85d7HLD9XStLM32o3fQma4JUROuJFkh' +
                    'zfi+v8/Bu24PS8ArMzUIQNys89tTQ4uUiRAE8986ATS0fAtwxXYgHry46x2kjAKm37mFIb2qRSN' +
                    'h+9X14ZVfoboiPvrFp0OlqhOZs6bp5DgTncrqxweoqyZXgIp7gQSsIR80EKqNLLPjBGIx2X0I5Q' +
                    'GHPebsIrwq4q/pq7Q8NzGf6KfoHU/KE8hEXYV30m5RQVpCtTyqbQSET7vST0VZJc/MA0RM9P3rE' +
                    'efhl6PPiyV0B/aqmoz1qWqxy2Li1tDFhlF59yA5ymzUicJhXK1nwV5g0I/6KYM7JmYWoy5R6Uaw' +
                    'N3QaB2YOdDCM9K1JR0qcEb470xtzX2KH7e1PrhGpjyM60rEuojzGWUFaJ2XSjksdAIAsPdLnuju' +
                    '8xV6kvWe+w6g+gj+C1n2DVekbgaUlSFYyGM1wim6aP8/KcmhxLDkzl4g/tFTvaORo9Ct1yfJl3c' +
                    'cdTCGxSLsLCLYDDrjilSI/BbnyXvx+q2D5Sngn/NcKB8BrCDot6bW1lcSNLfow9PcEz/M9VfQ7w' +
                    '62zg4RBwTdOXisEFJKTidq6A/0SNYMDtarML5k1ElF15c/MA0C5xI7kzdQTogruz/QE13TEO79y' +
                    'lCX+xQLkS326LA11fcgFkTBSqwmV61m9O18HqxSwwboiwgj6+Lxo2BTZZ3KH0X3uvz3ADd7J7CB' +
                    'ACXPVniop4sHvBTCP4AsFGNigTpO+eG2UAanY6B7xMI2gG1VOO0iJOg/Oex2KkFexxhI0LDXO4a' +
                    '24c85w+6q3j7fpNmwTVpaN1Xfnxsk3lMGwCpx1rX2OWK1u14hL0khsLV+avZZb1XIDbquaBoe+9' +
                    'lgz7+V6RTpbcVCLVIIfzIWXaZuA4lihaOdV4UM8x4unS9yZXPdw0KmU+cKqppfu1OMvjzeqrQqU' +
                    'vbWJ/knjLkt8cgJyvtxahU3lz8w11dxQ+FGl4jXMUGEXuvEE1feSnrdt6z8HV+BbJSYxcirEsOZ' +
                    'Ts3eebnDLNkEtMWMsNYK5h/+1pBSIUohm0hGUqTds1mwgugaVX3Mwb5sgw6fb2p9ITYV2ZTNlOP' +
                    '1Aady7LFGgZPCu7YL7YMmxjOKBbBCngnIyVNXUyAvGQtXJw5SG1C5LybpAWlvWFiDAnBl5W0lJm' +
                    'xfxqRXUe6AJ/NZ1o8srD6NQzlZ2MIaK6bVw37zhGfUh5bLaijlbNc6/pxugr4l0BoIqjExQ4Xri' +
                    'wFRN7w845YqMpTM5gdBY5WDr4r3Y15zR6JUDPD3tJO1u9yAVZf5yda6YnqxmPngmRCkdl11Z1mv' +
                    'lz8w11cXOblZhx4hevZx+G2nB2AX4mqPmbmjakCkPXvdZFPR1rmgZtiAEkvQWh531EGMvRpfOn7' +
                    'Iy4lsstmw7OCqDxAyeGMempuIiPUCkS366MtaN9FHYosMEmBX7BYWmSdXrxXRM7USLaXhLWWVRt' +
                    '7f9fJy++pQJxHKkI6jLwNvaQWBJsctG0CQk+m54+fL3fXPL9JLLV8a9oNFPyiZHjXOxEJ/b3ggf' +
                    'LpPydlNcjpV3mJlzWvyU2oTzA18HsA0ZF2nQT0jNSKeYZFzdge0xxXnNB/VTYwW6/E9GW16+btg' +
                    'mjSdXjL3xwQS8ARjUbeL6u0b+sHzF8OJ3bFJn+biMurO/2hFUoFClVaXPzDwUFfoa1J3bxdU1N/' +
                    'c5yLCvwxZCWIQtMwrOo3o+xDcWwv6l6TEq9M6QogPfQruaPfuGWuJeIVq6EN5INizNiWQNZH7Am' +
                    'AdDhzjonAI0Lehh5KmrelrENj9owI1Q3Nm1CIJCYvs/DvKJiEnV5XXGQ66dyv9N8uecE3doU0Xw' +
                    'lMbtrRCaxZW0guHfV3EGTVJJiorxjxVRt7puMmtuX5CHaggqOI+1MYtvWTBIZZWU6JdN081jOmN' +
                    'VBPiiVZ7gRACMw0je/m2JuAvkMUsPenFsE4+7QspQP9Y51hAp8Z6n31Yk1hrWwXvKwY5AypGXvl' +
                    'JV38JNcN5z/+Y0dtpqSoP8pe9rbP2Hrx1I4XklzcwDQLcjXAOqQE5mdtcY4amsOVgdoFIf4yucd' +
                    'duQWo40XyIIoMAQWwcPHhvlc1xqpkNwRH/6JGP1yWHSLDsTVfEzSIjguFhiR9HIfwsBMlDZZXwa' +
                    '8379QxoBesotq9244be7OI3dxcgof1fJTKJKdkK1H5oPcHlMPS9eJVQZHBPA3y2+VB38k+lyPn3' +
                    'v46NlKo31kQhRxNrcuOpofEGryLAKBybuYR8rKZWYxhjIJ2Ztq7mJizDz1+VqEQQWvux5xcTdNF' +
                    'DVwFdJPtFbiH+wjUNGfvh/XfR5wANld6iP8S7H/X0n/pjVQiQL4IltYAuCZWvHGgULxCabjFlFN' +
                    '324L9U539HwyLqYaR5JuOZxQpK15c3MA0RNA4I6moH6W2Coej5fIWs+ZzKPdX9X+avhfGtsZjOM' +
                    'p4xjeMEKuDBVn9sC8d4rhlXQcOf7n9bkUUKU2wow/K7kaguc8sd3LehjEUeiSBqLijxzHYiabQV' +
                    'RhEuO1Y+8DqtN+CSvH7CCg2AfCrzLp7bVYzRirMdrDeN/n7dQ1WDABuUF2t2dmXzDOjUK89IKyM' +
                    'Qt2Ml0x/d5jVDOBoltpwSNN5+pMNfoAqe9tw93x7WUCojqWWT79Z873iRfZ5zmTKNQn4AvSHYZ4' +
                    '1AAJSlyW4SmgqRu/nUR35qmKNnYsnWP4r0BLqu70X8eILKqLgrqrcKtKci9Eq4PDdIPQPcIPThl' +
                    'o/BypfvAAq/pRbaWneXNzDXV3GQOy7mm0nHmf7v5b6md54Ng2dWe/ML1yXTConId4oUQPmk2rV2' +
                    'EsnxYv9Ex7FFgtLpRV+ORMPSmbJ5iDzkqbZgK0vd2BfDNm4bAVWcL9VlWCIMtAYxGWE2Dt4vYX7' +
                    'PJqctdQwBBfqquXoAGx14cTtYtFKjFPZ0wC/SqC2tmbOyaI3lljqCoyj2GTdY/Ux97jfRDCIbWJ' +
                    'Apbtsau70VrUnjvIadOH16f4Ns0A8sC1s0wUCMAH88F+5S141Hqa3xwJaSblZ+yiMbSMya++Iya' +
                    '6uJFkqd/fx72zVcAal3oBi/ZVyxA9muuiFBx+Q9D9pF660PaW0fsCMon3n1qtmvlz8yqIODRLjR' +
                    'JDuaxjXpPZ367b1d8p8pvuiVbiz2QHW8wX71Nkz4T6iYFrgWX5NKfF+u0DIz4uBwJq+HsQVwSxb' +
                    'yz5Ac9GsEAK0IqmtrS/60gZhdQmgVe/lBxBItFDijOfuRii+5F2Afpl4vbLOJNH47yjj6N0nZiB' +
                    'iOh3jCbNFfjhVx8gjjPiyfjTr0EtyrFHTkklV2rHAEPQJNQ4tm9qEUM1WNouioAkzI4iwD/oWY4' +
                    'Bbl/OuP+G/qc6z1Cd6UXycjnUsgM25JlC3gwDrphmbxA2bN8Mytaka2C89XOBM89lIgsgzQuN+8' +
                    'qNltQBM2LbLf4jgGpiVppQnfe2PGX0m8U+/ueXfCTDH/apjVmHhMyoqr5/ILM0T7rv7tq7Ede/k' +
                    '2sGJqmoJFz1j4HbQBYVQL5Y3apsD9sD8AMqZGErIga6tlLDc/Mo4sx6n2/nWqZ5OYvDJkEPRe0i' +
                    'W7yG33XRXRXRXRN5WhAk6daq0WvEKax9ZEERuHhynKY5L8+ru4vdR/8DRmCQZhirPZOkpwRV9Bb' +
                    's3kmJmotJzIpnDhe8MeLt/JgbRUDpxj6AOUXGBXq+X/N+NSov0OXoB/VQKvDYgs97eUuoMFo5ny' +
                    'JeLrHMlflg7KTL0WvJHa2+Pv49Vfm03ZcccfJ7/auVJV1UyghM8+GgtjxM87yXSdz7MojlIA4Yz' +
                    '8eiK/50WGRoEeTIy6gkJTgl6jhRGiHvWz5Zb8at5MawPiu4oGaJWcyhD+nvBIMh8SRu7MRHQAPI' +
                    'kvhQCkPjU60d1Ql64vvEMlUEVis9u84t/BqS08Oy1MNCwYi8nBX636s/a5qI8LefaHivtCTqEMB' +
                    'zIWPIokTKmiPyZG5NiUghZzrc7BVHpFIiCWhK9/Mi1MBY35IRbxwEWrBr3qEW6jOppoYfAS1muK' +
                    'Y9cD9YDP//R1juaJKG/Iq/KWuhtTCEW9qFq5b3OVfvi/DBcnjJm7ivgC+x9/1z4gTE4e+kQSfbQ' +
                    'Qv4fP4r/Qinp1mXRDeaQJAvHAyl88Ayd9inZqYCJrytjpb/vADn5ZC9a3LcsVMLjQpk6FbMo5qm' +
                    '6uVaphOtyIH9NR2U+YGCwMnK74JQxSQ8R5gcdhzWcijrWO1Y//+pv1xA7UW3N/eQBy4311oPUMI' +
                    'Pc4rWAJyBZHr6dO9hL0Gx380hbrZQRvvsUHB4dgHOG6Sgerjnzg+4PsU2fqM8wu5VilN4vIUYmX' +
                    'PzANETPUx+0cKAWJBWfVgRxq8FP8vIBRsVsjMshPCt919OGzsOhuzFkZgqgO5WFAc6xHkHkxges' +
                    'CHlsaRsO5tnCB7eWf73er/9vz1cA0qzk9Eumyh7A8VJ6V1BhdA6obU0np7EHa6DJt42aJ4Nb5OJ' +
                    'B+jG4RIRi7nP/uHlFIM8DyNucqGRuRy7mZ7nBlTuvrS2a+ZMYx1/UoEJ9kL0iPrS+WXQ4nkuRTF' +
                    'LvlwcSHAkKpoVPiQrJOu8D2r83OX21cmJtIMdVg33nLjb8RpWoJ/oIxiOxqmTKntD5SplPnKs+7' +
                    'Uwa+PN6qtCqJrpF2dMgCstQpVr9INZVRJpc/MNdXcUcmr5tp03a7zXmqPwQSA8Fxvme++gpKQRt' +
                    'C4upnm9ddTwU6bkzFJPjWpCLl/Rc+tR3ASdYTMZqNfqTI0WKiJL5/W/NHEjAao602D3TSIo3D6n' +
                    'wSU/SJYznJN0x1ptU8VOKBXjjcthcymMCa8w2o0ylHqRTrsNoOOOhFQ7Nyb2unrDO90Ct8zwgBm' +
                    'xY5BOrrhosIInGorVqXph/dWMPsPqQKcA2WrCpAwh1dXdijjuH9faG9ZZRYLUUN2nrWc3A6L2Af' +
                    'RVfAdjKDIBmL/fGC+oaS9QYe0e/g3vb/tL20sfFbVYPnBdZf5TWuoD9w82iv04xn6IebWxbvlz8' +
                    'w11cBGKHtu9FH0T7qWxgS7T+fcQq6ImImm5Ojmb1iiwjL5pDCvYqBqA4340Yy4c3rM3B6QkAcYE' +
                    'c6W5kR/EH4C+1/R10suDkaI6c5wfkd3ZzXxgK73tuK3o9keoQFdsq6FAHfYr1vJrSUhbPKs37gM' +
                    'nedRVQCRfWGkLkPFyNLC0PB6+Br+iERt7q37wIjY2YMc9VFJe5EAfLi9BuOr3QDA9xaGTRSP551' +
                    'vtXally/brPTb6Ii+h2DtAvEXqoC4vWwosOaD0GdWry9Qk9at4dZokRe6CeNxs7GdGlE2ssSpgg' +
                    'l4AldAH+lR0prm49O3zTO8vlqJ2PFAPbbss+UZBGJQ1VWlz8w8GnpxjcxFigSbkDHlPwIlidHx9' +
                    '67bSAiAkmWZHMsDDYTZkUxcOId+YafDwtKWTbP+XBj5g8B+7UjGU3T+Aq8D8w7EET1rUqegZqiY' +
                    'PRbiMwVWrkZbHoZHBKO+4ijGnzgVMyMga480eJRUSoPguuGHY1vVxxdqQHqXFT0FmXmCUsZzLzp' +
                    'U6DFnYQs1nRLaOcaHWwW8pigQRvn0xH0UoaMslLDGXCnHmzpD59Lt2dBSxTr4NZ3akvbGff3zfR' +
                    'xcP8eXfLqgCHFDcpV2R/ABgF5pFVDR2Cdlq3uswBNtxIisGdC21le73M9++wwVGfkZaP6oonT2Z' +
                    'ZfU4tilFbwr3s0muZv2L/xVKoT45c/MA0C3HFXehTM+Z3ZbMR1vlbmIwSTRgxrKrZkqiuZKUrrs' +
                    'qj0K3DGHZsTs9Nv9k4Jf5AQ5tsAWKHk/z6Tle1rNSDOIlTEocv9G1PTRKI1UbciHxE8LaifpxzW' +
                    'akbFAnpr1u4rH1wG2uAETeoQTtlnfPnZURaxbhrluBaYc+WBfcfasqQNzNntjpYgbxh7soKIu81' +
                    'gV7FVJuCUw76SoWvyPZrQ+pKZ2jtQ+6A9JYVGWrl06MMAvVwo+ovHid7vAzeWWn58z3n1sG7Nnt' +
                    'XvkaME8PaPpT/3aMW64qJX8iE2CakwQGiODA4ey8sZT8OqnVYk1cZIwgTCbGP2Xv0JJm1EEVaXP' +
                    'zANAucNxfkRfYNW0m+vMBPMfTSYb/7ZjZlRWVLycZHMjSffqZggoqSGXwiv6IIj6I3R0700ZagW' +
                    'ePC0sECzmce8aCXF9hJMVCWjmHTn3gt29iqf5E+FtG85whkq+StFR6w53xBAAP4Qq7L0jA9hzRJ' +
                    'YqJVSFmnOCLG60y2mXHPI+A+GUeqXjEPmDszuY9IFOp4e+ZmKpdmmneRsTDLRnPt9CyNWkCKYzQ' +
                    'W7Gxn64wLSg3ZOBjt8clNfygxURHjyk24NALt2dGtGwvzrp70V5dlcEgts2vQEvkkSqHVs3o+Aa' +
                    'MB8lz4LUUR0IEGYvuxQOX7tM+t4tDf5pA9v0AqYKvt1ZJk3lz8w16FWiPfdgBwCQBNXbvPIy7av' +
                    'QHdwTXbXbYQ5oLFLAlvx4d+WtzRqz9lQgRAEQVNefhx+uCKUhPSULLv+jLaL4v5HejiT2BZirR2' +
                    'I7mTj0HflOGzbU7Rsl6HF8eJgwZeMNr4Lc18+dzrBW/f2WfsyoMIeZjUtb3DYMVUOgMemOl/ojw' +
                    'yI4KAXFHmUib2f5EwRTCtMlyKnUpVOWUITtCeooYD1I8vzsvS+lMArN9OTXGDrRI6HM2atGSMHP' +
                    'GxoSLwpnsK5S3brPpCR80OrI9cvncHHsWmPZbDJdRSvYPSc0jEW3hCL9FphG1P1hdS/J7aXnRLA' +
                    'NOL24tOGJg3ZZqsXHkmeXW8Zr5c/MNdXARi2WWpUZkKQJwkOUpuXtNvTQI1I3ZPPkQ27YuDZFZo' +
                    '9dk4jwyROW9AZL/9o3sZUa2yGL9fT5T4cFradx2S3n/VqTKCVcvmoSJKEYTOg0APIKmJFQpF218' +
                    'BhJZBJ20qB4ujEz8GzYBIwcFe4fAJnv0ZRAltNtDSUw8+7xw0onzPgBKGwr/zGZ3aHE/sgAks4U' +
                    'RE6gBm6/7scNkLkxQ2NS/s9JiB1CAW1C5qvLwW9aC1Ql5PoUqL1CXI8tGec/VdwvOwLk2iU34sD' +
                    'vjwtyueS4g1AS+FFDBT0RMkYTXFHH8Gq8JGssnvhVjF/zTO02sPp5eXAaycYDlIiUYFGFU6XPzD' +
                    'wUFgaod+Cd94beBHJgK+YjcH22aiLQrX0U0e4DCS6HKrIrHn4Z1TSJGKV/+UiPi9HqRlf3CNUXs' +
                    '8jj2mEraycRGJhwL0Yt6fwdRGg8TvMUuDYEtUc6txOzYW5fY2ayR2IXRKVQ1bkn/jx0tKzHuvLc' +
                    'YMiwv7MQnNs8NwvC4WF4nRMMzzSd5ZkJb7zlMoaNsSgflMXv+0bc0aWxg93Esp45V0zMtW0SFi1' +
                    'YEUz5dID8QIaFqxtqlMvtydQTD9dKcv+3K1B/7Ty7nJkqNmuLzu3tP0B2d/zqFHUtSyK/ncIqqR' +
                    'BEItLp1hTQw+W/y9qIii/SFZZzuexZdYph/88aSfF45c/MA0RM8QT2mmv/wxGYwRRDsr5uq+2Na' +
                    'arCNfJat5hugKvSoEJs0AXM11dC37hoTCijNRpc3YN3/6Z2b8/rGkU3IXqPvspiRyTmMOFV/zEr' +
                    'YAbD0N6x0NzhGkjJ3q4leHVOV+vU4Bn8TuVrqOR620jm4BCA4fU7HLBsciB0SS5l8YuvsYnxxk7' +
                    'lHl5I1qMCp7TNEZoBBe8LTC9nR3Y2bh1Ld0QTeWvCYuHHFrvbPRKwESJpVruohCa50fKA6L9Nd2' +
                    'wwgVvZCq9aCCwPkrzLo9q1NvKIlsT1ikQlTP/05u3CsXW2cHJscd0suBCy0KeqhCp1WLNFpQ8Jl' +
                    'nqnF1mNJphmSU0SteXPx9Vfuf4YtbL5lHfHdqWZ6vEnbAW4OJQvbB53MZmgbL3EZ/9RgLBjYC9l' +
                    'gx25JYiKf2ceNqr9lfA+avS0yud+a6vssF6ublLqOYMsyFA/43vKSb/FxCvpYswqqYdP2j8eogw' +
                    '/Qj27RYC6tR2lx3xbPldLnhe5/3KXldW7zGwu+C5eM9xCyiOaxAyYx39pa5Mgbtk5SaAAAAAAAA' +
                    'AAAAAAAAAAAAB3YQdWW9kiLoSg85danbqIiz1ERZj5HdwWy5ybUMhlIwVykYKXKNMe/rXrm+ubI' +
                    'cJb1zP/SWt8sM1xSzJxuK+/0BqoPJ+SmITF9a94Guzocinv0h1fcG0ci+0T79leKk6Euh1hRVqM' +
                    '2RWGxEN4pN+6LkrGNDkNvR3CVVg9TARBuYhnOjwgMZdy923p6mfOEPj2sUcQ7x',
            ),
    },
    {
        name: 'celt-fb-lowdelay-2.5ms',
        container: 'opus',
        arguments: '-c:a libopus -application lowdelay -b:a 48k -frame_duration 2.5',
        decoder: 'opus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.4,
        frames: 19200,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'xpTiPSJD/j0mEQw+LA4YPj8cIz6wLC0+0Ek2PgtyPj6vokU+qu5LPsdIUT6Uv1U+4mdZPrJAXD6' +
                    'aXV4+ksRfPvGCYD6utGA+s2ZgPrenXz7ViV4+AB1dPhN2Wz7ZrVk+VtRXPkf5VT5ELlQ+x4RSPn' +
                    'cTUT6U6U8+ohNPPgSdTj4Rk04+3wZPPuIDUD5hkFE+ea1TPt9mVj59w1k+gL5dPg1eYj4hoGc+Y' +
                    'H9tPgr8cz7jDHs+q1OBPnpihT7NrYk+ZC6OPkHekj51tpc+G62cPq64oT4306Y+qvKrPnIKsT5V' +
                    'E7Y+VwC7PunHvz73YcQ+xr/IPpDZzD5Fo9A+FhTUPrMk1z4byNk+r/rbPjaw3T5q4N4+pYzfPuu' +
                    'p3z6DMd8+6SHePhh43D5xMto+EE/XPvHO0z56tc8+XQDLPi2yxT5p2L8+knC5Pjl/sj5BFKs+SS' +
                    '+jPvjcmj4qKJI+IxeJPoR2fz7QNmw+hYlYPgaHRD7AQzA+PuIbPilzBz6RKeY9k8O9PYDWlT1iM' +
                    'l09jGsQPR56izzy4Cq6KBORvABnC71wK0u9b9ODvdJLoL1o77q9RKvTvdN+6r3bZP+91CYJvpCf' +
                    'Eb7XIhm+27Efvr1TJb7tFCq+ivstvqkSMb4+aDO+dQY1vkkINr5Xgza+lXs2vuIFNr7OOTW+Kyk' +
                    '0vlTsMr4jlzG+xz0wvirxLr5Mwi2+psYsvnwQLL4+tCu+uMArvlVELL7QSS2+aNsuvs8IMb4A1D' +
                    'O+RUs3vll0O75PQ0C+98VFvtL9S76w4lK+WHNavoalYr6Ecmu+kdF0vuq3fr6MiYS+O+uJvsp7j' +
                    '75oLZW+cvqavuvboL5CxKa+0qmsvh+Csr75Q7i+/OS9vilaw74jlsi+z4/NvvJC0r45n9a+k5ra' +
                    'vhIx3r67VOG+5f/jvmgv5r4E1+e+gvHovsp86b4zcum+8NDoviKV574suuW+4UTjvpoz4L4mhNy' +
                    '+ID3YvrFi077G9M2+RvnHvu95wb5berq+GgOzvlccq77rzaK+0yWaviMpkb5m4oe+GLx8vh9Pab' +
                    '7InlW+7LJBvhOnLb7Fmhm+OpoFvgSP473Mary9v+WVvWpbYL214Ra9xZifvGNzMrvWIls8jkLrP' +
                    'BdMMT3tlWk9izmPPcfQpz3meL49iErTPQkp5j0vIPc9WCQDPnHACT7/dQ8+81EUPoRSGD4CiBs+' +
                    'hP0dPnjKHz7c9CA+P4chPtWrIT5DYSE+XrUgPkzUHz5svR4+J4IdPntLHD5LIxs+BRkaPsRGGT4' +
                    'esxg+dnMYPi2kGD6IRxk+mnAaPnYuHD6RgR4+In4hPrknJT56fyk+apAuPn1YND7J2jo+BhNCPm' +
                    'v7ST50mFI+w9tbPiq0ZT4LIXA+qRV7Ppc+gz6IJok+4jqPPgpylT57wZs+Ix+iPquBqD6O264+h' +
                    'SO1PiJQuz5WVME+1SPHPv2zzD4O/NE+dO3WPqOA2z4Krd8+fWPjPlyg5j7PWuk+HYzrPrMt7T67' +
                    'M+4+mp/uPiRt7j7emu0+8ybsPjwK6j5US+c+u+jjPhTl3z4JSNs+0xDWPkVH0D5J8Mk+SBTDPmi' +
                    '/uz7P97M+BserPog2oz7aUpo+KimRPv3Ehz44YHw+UuxoPtFQVT4wpUE+Uf8tPg12Gj4QJgc+t1' +
                    'LoPbMVwz0vzp49VUp3PXFvMz05y+Q8ZTRRPFfv0bq5BHi8cOXjvGQqIr2ypE69p1p3vaIejr0/p' +
                    'J69d0atvQgRur0HDsW9mVjOvR/51b3+A9y9qpngvbHR472d4OW9H+Pmvbns5r3lLua9jtrkvRIX' +
                    '4703AOG9qsXevVWV3L1HlNq9Ju/YvRTF172bR9e9Q5rXvYLV2L29Jtu94J/evUxZ470nZum97Nj' +
                    'wvbTj+b1xOgK+SjoIvtgKD74irxa+VhIfvnI0KL52GTK+R688vqroR755xlO+hTZgvmYebb49eH' +
                    'q+2xqEvsIbi76yNpK+J2WZvjSZoL7Mxae+iOCuviXetb7Usry+iVHDvuGtyb63vs++63jVvkPQ2' +
                    'r6qu9++wzHkvo4r6L4yoOu+k4XuvtjX8L4tkPK+pKrzvrsl9L71+vO+iirzvqay8b4zk+++PNLs' +
                    'vv1u6b5+bOW+r8/gvnKe274c39W+A5bPvunPyL7kksG+Eue5vvzZsb7scKm+u7ygvvzHl77ll46' +
                    '+DECFvjGUd76EfWS+wllRvsE+Pr4rRiu+04UYvsMRBr5WA+i93tfEvXPEor3x6YG9N8tEvfKqCL' +
                    '1vd5+8JLvQuzDmwDt8dI08smbjPEfpGD2kbjw9zjlcPTVAeD21WIg9RMuSPaGCmz3dl6I9wi2oP' +
                    'chbrD1nMa89kdiwPVtwsT36GrE9hQWwPbxcrj14S6w90POpPQCEpz2KJKU95gajPXhOoT1NF6A9' +
                    'm52fPW75nz2CTqE9RMujPY56pz1Tfaw93eiyPfjLuj1DP8Q9KVLPPaMH3D23Weo9Vlb6Pab7BT4' +
                    'umA8+i/sZPooZJT7D7TA+rWY9Pvp1Sj7sElg+pyhmPqmjdD4IuIE+2UCJPiDekD73gJg+XyOgPh' +
                    'u3pz61MK8+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAADQ/7dZAAAAAD0rnM4BE09wdXNIZWFkAQF4AIC7AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAND/t1kBAAAAEjghhAE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAR4SwAAAAAAAND/t1kCAAAACSLRsaEWGBYQD' +
                    'g4QEA8PEA8QDg8PEA4PDg8PEBAQEBERERAREBAREA8QEBAQERAPEBEPDxAQEBAQDw8QEREQEBER' +
                    'EBAQDxEREREQEBIRDw8QEBAQEA8QEA8PDw8PDxAPDw8QEQ8ODxARFhcRFxEREBAPEBEQDw4QDw8' +
                    'PDw8QEBEQDg4PERAQERASEBEODxAREBAPDxAQEBEQEBEREQ8REBAPEBASGeB74/OiyZU0pVgACh' +
                    'emauEmVGTmx8ngik/ybJBP9hY9CafNJyWr2O5a5EqipLDgiljHMQ4zkXKJrn+DVu833Ia1SdQw4' +
                    'Io0VXiTWl/9hiia6n0wsOCBZ1oeY88Bi0LuCOWw4IFzHx7mIpD7xRpDUDDghnnFlnR12AZQyBlA' +
                    'clSw4MfDNVO0F2ye4zwCi04fVuDAc018XolETzRJcicvVODILGzZl0UIKhdmHd4TVeDEpooPR1+' +
                    'KDIMGf0qFL1TgxJzA3O8+JR0KwtkHK1TgxQJsYKeHBdgaiK5rYftU4MCs6rHJfJv9L2Z3Z1TgwX' +
                    'oWSc1YijG6xNa2h1TgweukWAdByvQJAZiVR1TgwUIZevI8abKvWm6/6AtV4MOYzD/NyghBLrSjR' +
                    '1Tgxf9K7Y3IxjeZ99hgt1TgxuMlYA3wjb71iLFzVeDEgmYoOEhM/9Khpdx3VODEdy9LFBhAz5Sg' +
                    '7CJLVODEc4t7I1UzgeYyZ4L3Y1TgwbfNRq0REHERjWB+W99U4MGQfjYCXd9oub5XBGb7VODBOwp' +
                    '0Qi+1mJH7uuNN61TgwXzZp8084P9SzgngFKjXVeDDijbD6cyxKEZWRrA2q49U4MZtcOodv2vzLt' +
                    'ZXFoFeh1Xgxu563MqboWqh2kzrxCdV4MRwX78XSssrLknus5xB21TgxIlkIf+CREmYPRxyaiNU4' +
                    'MBndu3cc7FJX317TyZvVODAx5czY6IoEvqzXx4J3IdU4MGXQDoXVn5aqFJltK7PVeDBM+eWv8s3' +
                    'pU0i0FjbVODBkMH3IqyoagkxYf3Zx1Tgw4wGI7z3t4579qgjFQ9U4MZ4+fjN48Er4bgPzGSDVOD' +
                    'G/9/1RvsLGgXys/LGo1TgxGPU8RICh3WKN2YPf3vvVODEuh7Rx2IP92Gt1mqe01XgxQJ0g2dnvD' +
                    '4rx+h8Y1TgwdOIyuoTPtygxl2NnQ9U4MIEV+2IcwCCnZ+/cKIuy1TgwTXm+JZP1C1H6QxrO1Tgw' +
                    'Yqk4dhBV2fbEcW6l1Xgw5kvBVTfOYT/D/QfWk9V4MiYoDAxwszrmdfGsRCHVeDIvQAFkaNF1/Sx' +
                    'nlx/I1XgxKyN3SYghO00I7uDwGtU4MSvIT5FlXAx4WeK7JrDVODAEjwEr/vFh4zV+J1fVODA/TI' +
                    'INumz24DcArxvVODAI/PMyw6EknWfI5tAv1TgwUJPvfrzV8elVJUNACt7VODBg7Amv1YS/1a+lc' +
                    't3J5dU4MNc4UAa8Q0MBaCkOcQPVODGakHMh6Tim21wkLS8h1Xgxu7MfBkNDi7cQ4hbgQhnVODEd' +
                    'zKbE+gJahXrVKh916tV4MRak2nH6uwQhlSHih5XVODBGzra1FuvbEhSBIPlf1Tgwd4Z3Sor3Iiy' +
                    'JSQ9h29U4MFiuoJzA47xsjBRyR9U4MFYOWhxcEfgNKL7VRrFK1TgwUTzJDAfmZRZlyNc5LGXVeD' +
                    'DoONoAget5MVpwKqfV09V4Mj5wFgytkGZupOvYEo2l1TgyLckTYVo3cKL9sKw759U4MReu2gCp7' +
                    '5N/1slVserVODEkKHeuqT0gP/XMochPb1TVODEfOCS6FXsnc8a9JfYicNU4MHaoqtlsHcBJPCi/' +
                    'q9V4MFQEUwV4ipY2iMfTn9U4MGZMhLpt5Xa9uVmQjv7VODBcdVWW9U7GZTBNpnah1Tgw34JrYi/' +
                    'zXny43eXmY9V4Mfl686POg1oz8hTukfHVKDG4VgcteQWoA3saghzP1SgxKpFJuMavVzVP686e1W' +
                    'gxI0k5bl+pdkaKDPB9MdUoMTrzm9DfJ3X4xrjScgzVKDB0WJsgTjm7kzAuykfVKDBNZbSDyEBKd' +
                    'Lucj+bVKDCG/Z4wgXch2Ux1uuLVaDBkJiUtN9WYP2IBSHnVKDDaJD4xbkTHYCH3YLPVaDI+AUxT' +
                    'azyxutD1FfvVKDIvgotsr6PvK9amGHWx1SgxJ8nIM5tz7N7LQsAG1SgxFupN3NqyeW5pdgeV1Sg' +
                    'wHLQ5mBjI+Hr+ep7b1SgwbE/pvQg2vj/9Hicqi9UoMFy/AUk0gbj0PiVr+fXL1SgwYFfsC3scwP' +
                    'dkIgMK1SgwSZ9Y2b94etzYyknVKDDnxmgc+xCKCnKLdkPVaDH6yxYYIWcqY/GJtV6h1SgxvpU6p' +
                    'QFrLwWnFvACHf/VaDKB6rD+wSy18Ta52RqGy/N/+mANVWgxuiiPAVz/Eq2QAes2ojvmzftbVGFW' +
                    'KDFvBbJOyQK+TQ2Jk0buTLW4Mo2ONDRA93XV85ataMKMRIGjNEqy1TgyjWuizyfyQx4JJODByM3' +
                    'VODKK/ORIEGMs+VHA9CaT+NU4MGdOnnaK6ErYOLTgK8XVODDqqxZ3snSUqaAeB3HT1TgxggoWV4' +
                    'jL1NAmJeW81TgxusErLoYlaTX0d4adCdU4MSmfREWQo3F3wu3EMkbq1TgxHzY/VJU/7I8f5JV22' +
                    'tU4MSU95xusnX2zNqmhQNU4MGx4R4BPwn64jQc71TgwZNDIvZAxskzjq0u4D9V4MFx1uU53W7ji' +
                    'P3Byl9U4MFaE7BoEUcP32yDjWNU4MEyHSuNzmhH/42BbANU4MZkJ6DoXq26whkn1aNV4MbjLhQh' +
                    'uEAq8jdahXNV4MSMRqhmNJvBaZaIOHULVODEZac+lCpGfq+xOVvni1TgwIUKZJGaXOKV1Mm/FJt' +
                    'HVODEy+9vQPB1kBpTcGxHI1TgwYqj7jp4QPbz6KbHVeDBXYFBHOGVuKfX0J9U4MFqUuvDsaGak4' +
                    'qxESdV4MOKJpXIpBMNeJHjIK6ri1TgxmyVc+w4eH8/rxQPOkdU4MbZ+oGjVubbBHGFac3nVeDEi' +
                    'I/28QQmAnel/+kIiJ9U4MSZa+3AdkpNm2A47WsTVeDEz4cKOBkbVYCNGnxlLChzVODBsPxrcBGl' +
                    'wHwjUNB531Tgwg+8++xADPJkGR7CXdGPVODBJYL0gL8moqYDkitU4MGNfpjtV+UcGAsNapdV4MO' +
                    'W++9c0mNM5pV9QKFvVeDIn6bcYSwdGujfNU+e5stV4Mgt8h1/5Yiayj0u5Qy/VeDEmORLxehb85' +
                    'ogHfx8m1TgxJ4QATTtIJ9FT42b41XgxOHtc6Jq9EFyUNHeE1TgwNcVRPVg2YKKiFNYgt9U4MFV3' +
                    'ixdGKxJ6blZ5bsLVODCDAIflNHqMNwiQv+jy1TgwZB9eggFxXowZRLBhE6HVODDagtPMt1OSBQ4' +
                    'SrjVz1Tgxn57Vc7nSYkj9JMFrodU4McGD3xCBq5wKyfMVxtz01TgxGeB/+1MmOLvd8YuqISvVOD' +
                    'ElOqRoWASMXq+gOOryJNV4MTRLPwizBQ9eDBTwbNU4MHcokNvhVuuxb3XCwTMH1XgwgXqAlW308' +
                    '2Niom4ygtU4MFaFVgAlUwkh7RhE5jrVODBTph5++JuXfFrDSwXVeDDa5Ni0rlT+N8264Cpz1Xgy' +
                    'Pd8gjmkL89djq210dtU4Mi4WukAV9nOG4i6fmDwCJtU4PTk3Gox0owu8NEFI1yebzw0ftTwPBvp' +
                    '/w==',
            ),
    },
    {
        name: 'celt-fb-audio-10ms-stereo',
        container: 'opus',
        arguments: '-c:a libopus -application audio -b:a 64k -frame_duration 10',
        decoder: 'opus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 2,
        seconds: 0.4,
        frames: 19200,
        referenceStart: 4800,
        referenceFrames: 240,
        reference: () =>
            base64Float32(
                'z0YNPo/KDD0xrBo+1CRCvIsQJz4Ll2+9NXQyPkL81b0z0zw+mVsYvgYtRj4r+kK+ZH1OPmz1ab5' +
                    'Nx1U+5EKGviESXD6wBJW+2V9hPl0Job4Yt2U+GDGqvjglaT6Pc7C+QrVrPsPks742b20+SrO0vp' +
                    '5kbj62HrO+UKRuPix8r744Qm4+uC+qvixObT6qrKO+PddrPhFtnL78/Gk+N+KUvivIZz4jho2+E' +
                    'UxlPjjGhr6TpmI+wv6AvsLiXz6gCnm+bxtdPsEhc76XY1o+7IlwvsvJVz4gYHG+02JVPrmLdb7Y' +
                    'QlM+A8R8vgJ+UT7AR4O+gxxQPgQrib6wL08+jKmPvvzETj7cVpa+ludOPtO+nL4xo08+lWeivuv' +
                    '5UD5f3Ka+WPdSPtWpqb5zn1U++Wyqvnv3WD5t0ai+fv5cPkSXpL5JsWE+vpOdvkgXZz5FrpO+kB' +
                    '5tPqP2hr7mw3M+dRxvvkMLez7EUku+OnCBPno8I76pm4U+MkbvvcYBij784pK9H5yOPhdczbybY' +
                    'pM+mNa0PJlLmD5JkIw9a02dPoCS6D0iX6I+XJsfPth4pz5WV0c+aYysPsGsaj7rkLE+MIGEPr58' +
                    'tj7Z9ZA+tkK7PvSRmj672b8+/VChPqA2xD4cR6U+y1DIPjalpj7QGsw+8KylPqGJzz7ps6I+tZf' +
                    'SPrUjnj6dOtU+wmuYPsBq1z6gBZI+Sx7ZPippiz41Tto+fQuFPmL22j7YtH4+PhHbPvZodT48mN' +
                    'o+D8xuPm+F2T4FTWs+0NzXPsc8az6HmNU+e6BuPk230j63VHU+LEHPPl8cfz5QLcs+Y7SFPmqAx' +
                    'j5Uzow+VUPBPhh+lD7vc7s+XUucPn8atT59waM+ez6uPoFoqj5Z5aY+bsevPkUWnz5obLM+rdqW' +
                    'PsfytD64PI4+3wa0PnlFhT7hZ7A+ygF4PjDuqT4i72Q+34WgPrlsUT7BOJQ+AZc9Pl8shT44fyk' +
                    '+VzNnPlA+FT5TqT8+w+wAPmeIFD5gRtk9uXrNPYn5sD1XPl097x2JPSL46TuzxEM9mqcgvSPm7T' +
                    'zOEKy9GE4wPCBNAb7NbeS7NBIpvjMtxbwdj0y+gMQlvRQqa76j2WW96zuCvmBNkb3IHoy+mOetv' +
                    'fU4k75UpMi9nZ+XvnZ74b2Eg5m+Elj4vQUnmb4Zlga+8d+WvlH9D75EFpO+lF8Yvo85jr5UvR++' +
                    '+r+IvgQZJr70IIO+mnYrvu+ee74T3i++smxyvuZVM77bYWu+hOQ1vikQZ74Tnje+h+xlvjiQOL6' +
                    '7M2i+V8E4vj/obb7dTDi+B/N2voRCN77AgIG+Wq81virIiL4tqjO+yP2QvtBDMb5Iupm+zJsuvu' +
                    'aRor6ywCu+FAmrvl/AKL4QorK+N7slvvbquL7fviK+jG29vsngH76Ew7++uzodvluav75M2xq+6' +
                    'K68vlHUGL5H17a+CjwXvtQErr62Hha+Jj6ivoGFFb4QpJO+JYgVvtB5gr7yJha+FRlevvBsF76r' +
                    'hDO+qXEZvvwxBr6zKRy+mSeuvf2gH773Kh29dd8jvrtvADwt2Ci+snhXPYWPLr44a8I9WQY1vtI' +
                    'hCT6UODy+ZdksPsYRRL4Sy0s+dItMvsGFZT4lplW+X8R5Pj5KX745R4Q+6mxpvjQGiT73/nO+iE' +
                    'yLPlDtfr4VYIs+XRWFviKXiT77z4q+yVuGPnqakL5jIYI+hW6Wvqyzej6YQpy+/PdwPoQBor55D' +
                    '2g+Mamnvp+6YD5kMq2+jKRbPmaCsr7vfVk+tZe3vi2aWj5vaLy+ijVfPnPlwL7OZmc+LAvFvvf0' +
                    'cj6qyci+ZsqAPmkbzL6TWok+u/nOvgbRkj6rVtG+pc2cPnAz07671KY+lYnUvoBrsD4cTdW+7Bq' +
                    '5Pkp+1b5jYsA+sBzVvlLLxT7HH9S+dfXIPrWG0r7Yick+UVLQvulFxz78gc2+oQLCPqUbyr4Vrb' +
                    'k+LBzGvuhWrj4tiMG+JiOgPhtqvL5nSI8+IL+2vkJKeD7Lj7C+DkNOPt/oqb4DZCE+jM+ivgN55' +
                    'T1USpu+6MqGPe9hk757uqM8cCOLvuIcyLy2mIK+AROIvRiSc77gWte9y4FhvjIxD74uHk++igUu' +
                    'vvp5PL4Wvke+R6gpvs8hXL6/wxa+8jRrvvTiA74HKnW+uEHivalmer70GL29Im17vr98mL3S73i' +
                    '+gmlpvazNc76hgyO959Vsvicmv7w69mS+GsTwu+8oXb4iSwM8DkFWvtPKuTwHDlG+gu0VPVhBTr' +
                    '6r1Es9wWNOvoBYfj2n31G+4K+WPYDlWL6HeKw9Gm5jvkR1wD3AT3G+bpXSPfYZgb6r7uI98cGKv' +
                    'r9/8T3fR5W+ij/+Pa1HoL4bpwQ+oEirvrpbCT6H0rW+YkYNPu1pv76XdRA+MJLHvuTrEj6A3M2+' +
                    'krcUPrDh0b5T8BU+eUnTvm+gFj5A2dG+XNIWPv1szb4MpBY+/u3FvisnFj5oZru+FWUVPogArr5' +
                    'idxQ+p/edvoFvEz7HoIu+smISPnXBbr5LYxE+A1xDvo9+ED5wHRa+/88PPj0g0L2FZA8+gjZpvR' +
                    'ZODz5Q5V28',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAABe0Z3+AAAAAMhMwC4BE09wdXNIZWFkAQI4AYC7AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAF7Rnf4BAAAAD/1vGQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAQ4TAAAAAAAAF7Rnf4CAAAA223TiCmbWlZ+g' +
                    'IGEg4GEgIKCgoWCgISBjo+Li4aFnm+IbnZ+eXh+doKAfYN8nfR/gIDSHC8GVNKFhpB6e2KMjPOD' +
                    '0RB9/02YtI/LGFVBCNY/cuElvrDqO5/+XDtz9f68jK8LqEipG4mDMkkPlN2qJ2OsyTOmX3/jP5g' +
                    '67rXIhyXm2PEtXZNyrNK57+qXkz4zv4JqKLDS59rICeIyzCkTGqv6TtWuvupN2UkIbt8X8Cc7qQ' +
                    'Jf5pN9JYNgmnrVzSStkXxqUf0jKtQt9Mi4PG4HspMsD42K4w1Hdfx3chR57JjAgbvkbNEbXPZzV' +
                    'JYtlyldGFaeMh8hMVdSQeCJ5JlzcTrPgPNd0sP1NGPE0VZ5U/vp9OrVwMkc/FmAvOE2tVZhe/K+' +
                    '9LJN2oAP9oTAmHUbtb5mtJeydd5e4kj9V8FlMR9w/uJ4qOrzSh3R8P9E5bF0MGnEVImEBbaqBaz' +
                    '77Owa5OBW55FIeU3t/nzPqOixz5tx/HRv865yGt/0rRWtvseXKst68Id3p6RdkLJUsCzstdp3Xw' +
                    'YGPSwZs2QMttmd71xxeqOSRzNRzekFgjcfmGm43hgEFv0Bqh/AIkzQj1piF9AjEplqXUGHdvlsB' +
                    'Tbo6YXSPn5M2MrKXKam201ypYBeL75CPYDAzIjefkE8EUZpOsHJk3UiruL0smUdNYMU6uP2a/oU' +
                    'vk9faRCz0cUHsPI+hEqzn6otPfLcofDr8wEpQQaiyMIM/G/oE222c5h+3tOgg5850r6ljt9G+iV' +
                    'q72EGFPdh3cY7UxTSqrH/Iue8E+Jb3x/P5oonXaR2YfXEcpDCCw31rSGY/wJ95MXKtw5fqWdAKL' +
                    'd04vSvfYCnPyBb4HdIAXzmRuRDIYNuJ9wChB17DevEw9Mb3juy9uDZbcdFTHNJstq3jZBw0sNd+' +
                    '3CXEEMg/Tk0T/p0iypzIA3I1gGOKHnLMnF59YC8jG0yfgFhi1pVPuoYUukU1EHI5+7+n7Ujhgxy' +
                    '3plrma8urjyOxLvfY/K2DwpK4vSvf3hKJdD0V/VlA4EK9BDur+Wq5jYLFOYc2/rOabEaTJPKbbZ' +
                    'gcPaRuBL+zjvpoRY9w9wE/bN3i5hlGg+aTY/Mt3dNkFUN2/fzauRBI5eylcwxA4zrQxfwfiD/E6' +
                    'gYHqv7uzt9Lp53Rk6q0AIiHalLdnkt8krwXNMEDQRuWovgjpyQ4vSxWocZjCCOmE4su/RxdYZvG' +
                    'zJGVTOTJTbU9b4FlkWD4aoeXVbLAYWvDxqGEGaZvlg+Ijb1E+pDQakXoKk5MxRK8swKHxcSz6wC' +
                    'CO1iv4vj4F1GZDmM98A+MvvaiJZZzUwV47/HIk97hk9+0HJkDbiDzp+bMbvwiZ6snbhVCWYTfLz' +
                    'i9K0VjFPMmAQcKW2Nahogii13Z3QPjxZnkwKi/jJ7SlOYVZZmXpSK1EeoMzcEVQcd3h2+cNcAIR' +
                    'z8mw7Uve68XlmfuZbqYy46aF+mK5uDnM2EontVvn/7UlK1shVpPZkbDUy9i/e/K7kwdtHcrdnrb' +
                    'ohoYouKlaKUfK3hX+tJi1ri9LJV5X/wCUut1sPThImKBnRIVDogFXvLAf1cB7bt3cpjseCJTsKb' +
                    'wMuxe8v+n0UnW6JNCY+9cVHYf8phAlJ3bIPBJErSpO48YvEvMrRxbDZ5uqyBsRTaLAKFcf1dW0Q' +
                    '6mh46cj+GPjzX3VeaOjeYbkZxvroCMvPZN00AJbtW2hN3l1Ti9K8CiAElXARriccfqDWu1vRgcu' +
                    'eGMSlQkgrHwTs0cv9WBBAVqlIHZgIka60GPeHmRVbQhxkfLy5X6ebffqn2TM5iD2rKrZntZ7MQD' +
                    'ff2Jx7cb0Ocd4/nfECgYqG3ALWmyiX8ulPVFxzDGgbYb/Xvrqciy6exzQtnFy4CQthGSuL0rwEK' +
                    'frIR1fYtrvy6egG5R1cjLuv1XCCXS8Rea8MpP93l7rwVpjZ7VEjM+CHwUouC7blqYoNXF9Qr9v+' +
                    'Q8fvP+r7lDvwCIkfYOshH0BdhdOhzB1Y2Wm5MJ8dg5FEs0rINri4H99ZApk2K/zJ2FD3WOr8ioO' +
                    'OC/oyqd+gC+xN3jsDi9LFkK1I/aOeFW4lg9Tg79MSXHrzqGw5t25+p0mqRdz2CxkGM8WP5VG1Am' +
                    'eH1J0yKRKXy7jGu16PuZ9HNJr4hzt2Yr3HhwQRXRwbrxSEWko25vFUVrWWyn6oI5myGc3zYp0e9' +
                    '/vfvjVGwaXwdR9id+IKZLuLWdEZyv9cOSGQu1MC84vStFKm9FGHMyj88IiOc/45XUWkwSHpd8BL' +
                    'UHCgHV9k0FxvOtYTVSU42PB9EdT292OGRIcAnRXpcOQrwaMNm+Foe2lXN6DxeKRpgl1pnN/mbxe' +
                    'lIVtnzu6o4hvdPPJaEcT2WgzjuVEjjYouId8K8Yg3gjbNDwPOw5tTOG6G64VvWnOL0slOvDtWJD' +
                    'uDWp972c/ToalOnQAM6GiegzJ2K3Orbilfurqb0ueVB0dPYqCPWz/U0WgaPdcld1kokB+wR3NT+' +
                    '3ckaw5ipq/Ndnd7Z2y+odQ34KDihfETu4SGCLiFCk0O70GRu1iXDIcUHz9RJGVAQ0VnG0uz2l2H' +
                    'Sfvax1KK3MwAkZwTi9K99ghmdyASC8EoT/e6PcE8LNzEetR8iPBASTq2l0yDEPq/KJBtYBPCzM7' +
                    '1cme9smNU8mrte4EKyzmvVniBH5Y5KNLkUC8S8atnV8ONERaQLcm4VCbQVKUF+Fd5AOAMZmYu8S' +
                    '2aKqK6+tRnk9FOy/f0uPu8jWNoHXKk/DdKsC8pK4vSvfX76TkUhkeex3gZU1pAMkoTqQ41ASE/7' +
                    '/FmbOyIiu3wSgR/gpjDdN5fAOiZ/KlXDFQDsbIjrclbG89e7hNHIPvVMwgl/vE9+GyLAyIKaXDp' +
                    'kdk377Q1JrsNJKG+tn1r45kqldoVPWQwcMkD06avxZm8jF0ATbS4zgjAJ6wDi9LFdrhge6FI6Jy' +
                    'aQ+W9Sc+XgL2irhXnKhk1jzvG8x/resdPYvr+gfObXTb5R4zMwHIHmPCsTRl/EEIIwpqIjgoI6e' +
                    '/o9oF2Cu9xeaYhz/CkSZ27GyVhBCtmVGS+vSeF7PdrNqTIbtT7v1fnNHBNmQewCWmZTskhKnHTI' +
                    'm9yNlEBd8Tzi9K0VjJRiohI4wOxEMVTUlVbPnLjed9lWE4O3y3UkaLRFzO9FSrw/BCNTtbMtOzI' +
                    'oxvMAS04kXtgOR/9p2h/p2hl6luf04vHQiXbG2Ih4yFKEqbxx6agGXHngwHssUZ0zIqfe4zyZ0w' +
                    'dFjnzahwC63KIINDUPHxDvWg10d9tdi9zitLJVnCb7RHkuKJJICI6Y8swhga609oPWH6pAvpWGI' +
                    'IQNfplnHK6M32tBePGj7AY6tfYoN+a6ucortt8HTaLxEjRHEGi2RTdUAJz+mJQonJb99K2Z4smc' +
                    'O1BHA/XU2hDlsmmwoZ1mMJJ4b0NbVuU6icSvXo9ZYlZvY9xLmvdPAVSn8bzfg3OZcNLbfF1I4rS' +
                    'vAQJZtJdeuoEJwxwP+3Gh6cXkNsbfdWUNvK24tT4+K2g2So4kSyuTlJoyXyVi9Fy3r+7lwaIBgd' +
                    'sEjhgstyJJyHY6Sjk5F+W/vBQrE+JJX7XxZ63UkjLBdZco0MoB4aav0LUdLmyVO/Zt4YoJwALJt' +
                    '9E/b28X0qwiH0bMqIYJu3s1LRWAF7pj83TxYzbitK7+ugYpvgDz0b6hCP4CDueD5vMzoD5mX1Ot' +
                    'F26nrD/0eSlR2FE7lDq+X/gjm6N4nhSHtKn1avytG14lHSQm1p1+pjdFnMGFBnPuSgLYEv61dlL' +
                    '7RvWsDU1NwEwACrH6sunP8G4CyDiS1jKF/Um3MiuKNFmm59mkPWPctVvtpMSyutGKeqzbXFsA4r' +
                    'SxZC35PcQor3A7KJu3d7KJaRPXVK39zrbU4UNOzMF8K66NkjMY+EWSeLA7brmk7u77ftGvAYsRk' +
                    'fjzrAUJHrYQuLMllsHo68EpdHQzP4cOC0XjUZDnlpFJpUo69mMNYM3NfYOcdowJHOp+vVdCGHgP' +
                    'JmEFNkXElmtg/1nLcKQXSwGxexI7NSIE+uK0rRSp6M6vBZelvWCK+H4H8OPrST2l+oaiu7dkL5I' +
                    'KrVLMSjh90bVxiyQWqPrW9gFYRahJy1Pzg4KCBahMvFTsHG205KSPkZZ6o/eO+NT6pMoWlEQCgJ' +
                    'TbXdzIDefWCq9trn3q+JmXo8b5oulUWgXJnOplpaxZ5DxDp0YalR/xbewR31x64rSyU1UEeJKKe' +
                    '9r1HsoKU86fLc9j+uVQbQ3aTqIYsERCT9Cey8w27pGcNBIhIJRQmdpB1vUsHvfc7NBlz8T3Ttxj' +
                    '5D21Cx+0wwAe+SkpXExVchu8AARlHWjBt5cDZyAl64YsM2UwXjSN8aUQSlHH4DkKzFrcVod6v/S' +
                    'dR4qn9Ws0gj2cBuL0f6padnCPxi/CPjvhGROlBwdPltEs0lzsYn5qmdhqhXYSCrtTSOxIqWJWf1' +
                    'YaqorCWIabPEmP7GHnu3F4+STj3RYVi3l1mD8uieKMqpPH6S4ZI3a6d6UW+7BLEIoUthgNUR/Tc' +
                    'gnEGNmaxgttsaMYaRUPf/hdriKj7/yMiP7CCn2pr3OCQZb/RyXp8eq5fd4O82tUPUPAJRBRdG5c' +
                    'AvTzHwHvqZT6CdLFjpbFJieK4VHwPzPlxZ1jMjpaVLcAKy5fvbZdJ7wL21K6zsuxSQWnR8AIDGq' +
                    'pxwfh45Y9EFSM+tnRt8008j1NRNorJKTmfp1HUkYE/0flvVKRLTW4Fgri78L5TYpXeMZXt6ErbP' +
                    'THqFijUv1aZDOQQDNxlSePqG6EeJhP0x+3WWvA0d475JhrIJjVdLWcOcNGcbyirwHc/PNiUG104' +
                    '+TPtoeD3rjvPzAqyZS2tzjIAzoOK4JPR+kp/r5VEQLsJJATTOot//a3yPwe/mc6mJWJKY2/rb8c' +
                    '1Of24N8UAxkQNhsWOatcif7BxvUrbr30wG/iclOMywrHSABm+BExGtNZiIC8fWAL/A4QXXDxzxM' +
                    'RZbOVZQUTYgb2xhBe+NA4nhzKN6wkZe7/TQgqR7QTwuOWe6e2L8Bw2wBXk1sIuqei9Ju//Jv5so' +
                    '0Kyrn0wtVD4eEALaBCgMGU89DqXPTEEt1bo0/9vf1Y5JWOYVRa/2/8TnBqJsoRjzBXdQ88/lax3' +
                    'Pg7w3Pt9ZNlyVjTSkpo/HzwUmh0CNhOlP06+q+n6dzG4gRh3YLxjuoUYWm6q8Ux/0LcQuQFAAVP' +
                    'HFwaqaE5Ji5ls5/GTMryXeJKPLT8e0AGWlz0xBaChtfHbse8wRVefWGLyUxAgIaWa2NUFDOmJvo' +
                    'qTtnz3o0TO4wvbW3jf4NrEkARcWaKKU4nxWmKZTt4DricvlI6cAN5UurpAekTqKuj708/jcjUXH' +
                    'gCZyf9nT4QpS3T+66GPaZEeUDbrOdN53XQcWYDdD+IV2wmJS6n9lz0wG/ZXDFmw9WrvuL+tbgLJ' +
                    'w9xWml8gJSMvwQcT5dW6zkh5ObnHsImlsI4FYYstoxfKTxEpRcy7zQZ9pi53rTY0pA+JygmOLds' +
                    'LdOszzAynirrgfT5k/4brlbjkB2WHH0c8zwkNBHs/ehcq4VsLA6313/jtwm/WOZc9MbEcjZqHk+' +
                    'qkBd31nmTHVsh4/JPZZS1v5tHGm/x1FC28rb2Dh1KUZxjtmiD95s0U/MBnEGyoHMA29pli3Ev3t' +
                    'pUD4LnmPdsxHsPNYesTPaJu/FbbbSRUgq0JdZJ2SanvI020bwTs7M75Cr8vYKwmJWVZOC6RvJc9' +
                    'MJmynvbb0bjYmmvWqhlrqjS3DXstyAYFvGWUJ6L4fHXcVj+UJfW/U1yoh+UIk07ZKa/JzflLFn+' +
                    'g6fOpLT0MqfjdlxWA4UGLhgeBPuo5+/wBxV9Mor2EBMmmPvUfybe79L0LP9jNfuHLRTfb3aXK4Y' +
                    'P3JTl1UWRvrtmbrpc9Ma4F1jKTvR4aJ1lwIFpfhlOiA9Q3PMOzurePy6V737n/qXMoBn//7LAXn' +
                    'sVlQtweDk0FJ4mWMHdyhqlKqU/nnlnRD24z2WecPRdxWhctVp8MnvfBQVb5u4movdRRVqvR1kDN' +
                    'kfXHf1g19KwBRbPNdb0t0SuXPTEFo7/FFvT7+WiJgV327SyPAVvHlXZ6EqTYMA1ELpQ9N9hbA4h' +
                    'nHj4OlyHyRGr3Uru6FoJb7lwpBhyPtqz51ZlhrOzj5WMaf8U7V65jH7mXx7lba/VANQzBZURIIp' +
                    'jQPVMwZ5WVsqTeGTvtzl44/z3Rb74/hTvt3yt20itKzcfalz0wGxMBVA0K1bBcVDp5TLqFj+QXs' +
                    '7c5FyKZNkgjch3kEKVusroRL6/Swxis++mCJNh3X3xiWbstWxWru0Qh6yac/v8ux4wb2jv8zCDg' +
                    'GjkrfxHVt/a+9cn2y+2rxm4SS7OJv96eCl8a3EQoVRfGUuVD6pdB+ognEYOwqhlC/AGXPTG8JMs' +
                    'HSXSo7dlg4BEWvqqEuzekD+2Hrh9THA7L8INJTx+gB/Mz8LF+OxOaJO2mIK/0+pPMTXZIdBeE53' +
                    'QRAHAIo8DAJekESm/4LHeelJB8beov9FYP5FPZgDXdDulQ3fdxS2j+F+S2lZyOCkT5Qr/JnsVt3' +
                    'neOZlOpnJc9MJmynchYhqkxpU49qSB/VScQSyZbgwlNlEshom6oP6/te50prpeomZgpOpxsdaCp' +
                    'wIrcfbyDf0zakEzJ0qLtsSl55NBr/Z9jTfVdynqXSmfGu2MgmEfw5RS3ojDCNNx1Jt9mWKVDQuV' +
                    'pkFLdlIsztZQkn8kInYDpn70uuZ5bOx7Nlz0xwcRPBS/8iA/WAwN0LbAFPqCcEDc8MdZzvyBaIK' +
                    'DdUzqUgSENmDN4f3MJu+u4i5Vkyug7a4ii7ih5BG9iHuJNzFpoKS1qIiDNtTmwmF0O7B8f43YvA' +
                    'szakmIZl82fjPuSvgGjpG7Y0a21cNfRHYb0DrQ7tZa5dbWqQ5c9H+E9/CF0RGs1/YQx4EoSHsVt' +
                    'R/TdXeqV5tSoeraD36GfA+AOCtg1Jcp7xAt9NU+2C8O2X0jUP268tA8ioXgIorzUZ8CON9hOvzR' +
                    'UBzi/AUJdDnKpm5IlFcQATZGRG38kR54Y08YcR9G5JKCfPsBh8ML5Yv7vRlkdtZ6jCzkIcvwk4V' +
                    'saZ9UwejdZ8vmfDW0IjVEQ9aTACSRX06uuw==',
            ),
    },
    {
        name: 'celt-fb-audio-40ms-cbr',
        container: 'opus',
        arguments: '-c:a libopus -application audio -b:a 40k -frame_duration 40 -vbr off',
        decoder: 'opus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                '6PHwPQmrBT7T4RE+RxcdPr1KJz5tfDA+Ya04Pl/WPz5IBEY+aDlLPgR8Tz4h4FI+V2JVPgARVz7' +
                    'zAFg+8D5YPmreVz4Z7FY+zH5VPt2mUz4JdVE+xQRPPm5nTD5hs0k+3/lGPmpORD5SyUE+AH0/Pp' +
                    'N7PT5UzTs+hos6PtLHOT7AhDk+d9o5PoPMOj5XXzw+oKI+PrCVQT4HQUU+u59JPlmzTj47g1Q+5' +
                    '/daPpsSYj4C1mk+KCpyPsIFez62LYI+/Q6HPnkgjD4kWJE+nq2WPqwRnD6ZfaE+SOumPgZIrD6P' +
                    'jLE+EK+2Pt2huz4gXMA+rNDEPuX4yD54yMw+NzPQPjo00z4rv9U+Ks/XPo1e2T7zYto+ANfaPiS' +
                    '22j4u/9k+263YPlDB1j5COdQ+sxLRPtdRzT5398g+QAbEPkmEvj45drg+s+KxPlvQqj72RqM+lE' +
                    'ybPtfskj4yMoo+ViSBPlejbz50hVw+3AZJPgBENT4qUSE+UEYNPmdv8j3kgso9/fOiPUfodz1fZ' +
                    'ys94T/BPA+yvzvDeTm8UxbkvBHIMr3waHC9XlOVvWrCsL1hTsq9KOfhvQSx972GwQW+Za0Ovl2f' +
                    'Fr5klx2+BaAjvrG3KL557Cy+tkMwvv/GMr69jjS+oJ81vh8JNr6Y4TW+IDc1vrQbNL77oTK+nN8' +
                    'wvnbsLr7K2Cy+ALkqvk2lKL7upya+99gkvsdRI760HSK+E1AhvhT1IL7aHiG+bdkhvgErI76CJi' +
                    'W+V84nvsIoK77cOy++Cwg0vveROb5h1D++MMxGvnJxTr4dxFa+LLpfvjU/ab6lUHO+gdl9vuxmh' +
                    'L7zEIq+h92PvgPFlb4Mupu+LLWhvpmpp75Bi62+yFezvu/6uL52aL6+QprDvqSCyL7bGM2+hFDR' +
                    'vhch1b6JgNi+TGbbvivO3b4wqt++Dvbgvhuy4b7l1OG+N1vhvq5D4L71it6+9zLcvsM52b6EodW' +
                    '+T3DRvqujzL7MRMe+NVvBvs3lur7G8LO+3IWsvlWupL47cZy+xtWTvn7sir60vIG+Yqdwvhh/Xb' +
                    '64Dkq+vXY2vuvNIr6tKA++Nz/3vVSW0L19iqq99jyFvZK3Qb0fSfa8oe9bvOYrKDuaFpI8O2cEP' +
                    'RVwPD2u9nA9vvGQPb5/pz0SLbw9sPzOPf/N3z3TwO49idf7PSuIAz4rRQg+FyYMPt46Dz4GihE+' +
                    'rCQTPpEYFD67bRQ+sUwUPku9Ez5WxxI+xYcRPtUOED4Udg4+Bc8MPukuCz7npwk+N0sIPj40Bz6' +
                    'mbQY+fQoGPvkcBj5FrgY+hM4HPkaLCT657gs+4/4OPh3FEj4GRBc+UH8cPqB6Ij53Lyk+/6EwPk' +
                    'TNOD7SpUE+4yNLPhk+VT68618+ZBprPgK/dj6bZIE+V5GHPvHdjT4/P5Q+FK2aPr8coT6ygac+p' +
                    's+tPq/8sz4IAbo+Ucq/PtZQxT5ijso+1nHPPor20z7PEdg+cLbbPrvf3j67hOE+9qDjPjws5T7Y' +
                    'H+Y+rH7mPj5A5j5ZX+U+seDjPiXC4T5CBd8+OavbPuq01z4AKdM+FgnOPhleyD7EL8I+an+7PjF' +
                    'atD51yaw+TtSkPsiFnD406JM+qweLPujtgT6KUXE+BIVePpOLSz4khjg+9oMlPhydEj5N3P89zh' +
                    'HbPaAFtz2X3ZM9uINjPaS1IT1aIcU8WwgZPJqLl7sewZG8//32vDSJKr3C61W97519veHRkL3IA' +
                    'qG9xUyvvb/Qu70EnMa9GajPve4a171uA929WnvhvXKk5L2Plua97nLnvXhe573qgOa9IP3kvSgC' +
                    '472LreC9BSbevZig272wPNm9vCrXvZWJ1b1WftS9sS/Uva+11L1RS9a9Y/zYvYvP3L098uG9DHH' +
                    'ovTxc8L3AxPm9qVgCvsyUCL7Qkg++LlIXvojTH75uCim+B/QyvkaQPb68x0i+xIxUvmPRYL6wiW' +
                    '2+sa16vqMMhL6y4Yq+SMyRvhe6mL5nrJ++KpKmvsxZrb7q/rO+13S6vpawwL42o8a+WkXMvlCO0' +
                    'b5lbta+BeDavrnY3r41UOK+KELlviml574xc+m+tqfqvug+6770Nuu+iY3qvupA6b44U+e+28Pk' +
                    'viiU4b52yt2+62jZvnp11L5X9c6+cvDIvvdvwr6Sd7u+Hha0vsZUrL5POaS+h9Kbvo8rk76OUIq' +
                    '+uUuBvnZScL6a6F2+h3NLvm8SOb58zSa+/MEUvrIOA74hd+O9CL/BvaEcob2/roG97DBHvUfqDb' +
                    '0aYq+8wgETvAJZLTuoSFw83zm/PMCJBD2B+iU9/NRDPb0jXj0z3nQ9TDCEPaFYjD2I7ZI9vyqYP' +
                    'Z0HnD0Bsp49hVWgPWf4oD2w0KA9HgWgPS+9nj1dDJ09qi+bPWVdmT2WmJc9ViKWPRMUlT0/kJQ9' +
                    '29WUPVPwlT2WAJg9DSSbPXp+nz3GI6U9DyKsPVGbtD1tjL49bAXKPcIN1z2gpOU9ctP1PX7EAz6' +
                    'cYA0+p7YXPr3CIj7GeS4+gcQ6PrufRz6U/FQ+BsdiPk/wcD5nYX8++QSHPm5pjj4l0pU+UDedPj' +
                    'yKpD5rvas+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAADhIiwyAAAAAP1JVYkBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAOEiLDIBAAAAqX5bqQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAAOEiLDICAAAAyh881RDIyMjIy' +
                    'MjIyMjIyMjIyMjI+0IBf4yusU1GWB4wsrNQJBFhslShyQzO9nC5xrlBaZYa/RxPQ8B8MsYKMtC+' +
                    'LCi3ADvEtXLWg/w7Q12n/jG5ZP82g4SaBWId2Lc4+6GRLETUJNwe4InVuH3vQQDbYeSs7J4SLeP' +
                    'I5jwy6T2GXtvbgpEAe6yPtdsvDQlRKLeJqVyO4ixrANQpNq7W6Z8GPm+kMAuZwhcsjP07Plnt+u' +
                    'zJAzT1BwveM3ySlU5D6Fkb+YU4ArqaHuem/JK2fngOSaPvv1QA8wXjVAD7QgHBAaJee0OiaiBo4' +
                    'etlWuJ3uqzdfuT6UXyYjUbsw5DAk6GtbndbCEN9NIOrWcbICsEGb6Xu6ygh7j9v3JhwIYGf+akF' +
                    'WGq37kgCnSPck2vXvU0tGeqXvlhQATrOFJMb+JufVcFGIWlESz4W8shbDV3fmK1ORK8cm2peM2d' +
                    'Hid6lfWRkV6c4jxz7OkQvBd6a9xf8oUP+peuYfuZFS4wEPGfiM1mClJrUqNcSOD5dR1mMZhOp10' +
                    'qlyCPRMwzJiWhxBsSsIH9UAPtCAcFHP5VKdOvhPIC95zDFmAfurTGbm1VqyMcawEzi4z2jyph9y' +
                    'q6icyHnhqaloAr566WgHvM6fWUSkAvYCNAFhwjnfIAdIa+y0Q4hQOOMrZUWfX4kB3pt1c1tQo75' +
                    'vS/UkI9VxGz0rus6L5e4Id0gtJmPCl47xyDgG7rIf3Yq9ppiLYhcmtY61kSnq1eBjccnZLYV8nJ' +
                    'mH5ct8eraQPsWeKmTDhK5OO2CIDtUn/zAtjxuxTmAJy58ULDGqyHrkS6AB97Qq1UA+0IBxG0jtm' +
                    'OgQjDQre/URSqva1lmNd/oN9TCz8P2UVNVuY+Emv4awD7RWkAtnNji9w6oCh3LGBr/p7lqMds10' +
                    'fsq6H0rWe8v8w/MlI8FeH2rHw+zrpyAoIjBtT3XBFu07b2kV1XEnP8bCLXXwGUEHaPw+JVfC9fx' +
                    'xYwnTlwljIYS+Mq/Cj8BrHBsTAr0D/4CP6R+bIGKVKT/VcVoYc6b3PmR0yK8IVXYi23ErKl4bqJ' +
                    'PKMfzLd7Yu0M6casaW8kviIVrOPivVADbQgHBRz+VSQQoM3VBWdARr/Oa9TnRLjJZOThimA6GSL' +
                    'TXHSBkMjELctYAh9wJsz8luJxqWDFV6665hXYZ9mb3QrjiAhGb10Tpen00VcRa93Yy+9pRPG/b9' +
                    'n9deManyJnb5uCfVcFGIrHFg38kYpyrplEeyvmDANEEizWKoaZEsUGII5gtFGo5ZzIM5uNePyZp' +
                    'WpAMI7pzwqmSl2p+hiNg0/0gQ7+8ynkD5CBNqk/DndljcTjhw/+IXuL9h/bD9x6e7yP38K9VANt' +
                    'CAcRs/79tcyxhTkaVhKNsm18qzVnWoSRVan+iegFE4MRz14OfTJ2PR5YVxBgKq5ydzdBXeBIyAk' +
                    'bbsolcNUWpBHcBq4lIOyguIS9egflRqb0FudwkVz8c2t0Cq4kN94i/gKtVxHCEpe/p9KLdQIU4D' +
                    'VPlazBbhvR4Mq4vqqT2B3VSDLV/0JxUUatervOH5lbWG6ps/eT2AGppA0vIQlHiufa8mva+a2cZ' +
                    'g6ohgOolrMdW09hhZSdM1ZrCpIt5o7CM9P/AV1UA+0IByqF7uDfI4b1m6eDmZJerKpjaZWe1dbF' +
                    'R7rLr/bht6B/2D6oqNdr0Qt4OjJvW7bsyykZX828af3PxdJ0Jk+Pz/HXBOhI1kloUFixVar0jFa' +
                    'uMLRsFpUZQpAWEWs0wQ+cZxdbJ7/MBmdpsuGD4IF7zIEAFMembQBHXYiFTFjlcOp5kxYPeVP6pf' +
                    '6WgxukxLRyaBdd2jrPWRtX8IxhyQnKccZR2icVPg70EBALYUYPJTxLK3gMpIqMHcr6Qs77sQERX' +
                    'xgHfVAD7QgHIj/+AvdVp128SFG2dg5YA/HZ5L1gbaw2v/wiclGCuawqaVahU7qe8gvQhgny1qm5' +
                    'FA4zPLYvelpCnFKk0Q6B54v8IjXy57oTEKNsGuouLl95CNM+ZYly3CGu4Zq+HPe4DVcRs/3EBTT' +
                    'TkbCyk/k9BCfCPqwxdXF34bCDTBEZQ7/QPbVB0ckYxY7c5t/cQVLMC4ngKn3FKQjW9mmU9/lxeV' +
                    '/fnOgKaOyGfN951/Uk7njvg4zT2EDo7vzgdJyBOrqi+EWtVAPtCAcRtI7WgqxrdkQQr5SXSTkE4' +
                    'vgYf4ohXnDsOEL/FzhyW3IsYxhhX5AR4Y6Prkd2/R7J5Ueg3P/b9YDEDpRIdXOWTX0xq3oWKIa+' +
                    '8is7HGJY1YrCPzfy12at81J64ksi8vHdUxJ0BVqo8HQ5sv0BOpZosTsb3Ku4OwvsO+zeoGK2mVn' +
                    'DvZCNkiV8RFq4XMwWSVcbV1egl9S8z6cjeEZM9z+7TKM/47fanyO611kgZQZLrPE1bcDjfrYMFX' +
                    'wd7n0unCbnwq1UA+0IBwUc/KSn51ps8rMR/htovqfw1BPx0uQVI6Equwhb3pYugydxAUB3gmA2g' +
                    'eT1MpXdoaD+HZjI4MzEowhuWq+J7lDM90LlXcDWkdxa+jHv+Lc5N64es1ckyipBag6Rd1BVwn1X' +
                    'BRiHU/6nUyUHdcPzGBHFOax2UWTfYuB6OWOb9Dr+QsJZzOghxeHPC8Yrr73+SOqd4Id1uXHvmlD' +
                    '1MdVkJ1nk+/kG8V+qoOn4gaizq0Q9XKVLRFafE/ZeMM5cVh4Ddr3CrVQD7QgHEbSu4YxGWpUl1d' +
                    'p20dplcsvC1mk/IN6Xsw++O+aJb0sKQ0idUZnzmf5epuVbG9M2MJaKH/uGt/DJdYX9tG45KDSWl' +
                    '+vLHr42imOhJ9eHuTklvR7rCE+PIubumlIdHnSzPVMR9NC09bbLHWcNtwVqD5ZDZutxCCOJFldO' +
                    '27Woz+/GsCeyJaVr8W6EStERngk5+tD0DAr4AjW5QQto32GK6jRNiJ+UplILNlD//fryWe4sVPx' +
                    'SyW7u7s2p7ibstOKFDGNNVAPtCAcSdAUg20CPRa3nMXT6s/Y//ENENdhPxIYeOlbjWOrEcQFl/h' +
                    'Tpq6HX61gpWTvyAixiJdV06/PqmGJw8MF7W8VQDCK+JtQdtboUUDe9zVmQWnHYbbPNDBV8Eu+Go' +
                    '4ZA7WI9VwUYiqrV5J9OMO7V12Q0yn3L9/ZQIk3e9tOmjTymV962T7jLHcisPlInO+miFqfZCbxo' +
                    'XX0a0jD4FmOf1GDYIKu9Wwk9k0OQM5Bky8ZKlqqSIlDQQnapi/5aGVA5jSvbgX1UA+0IBwUYiBl' +
                    'iMp0o9fMBzTUYb+zUxiFujbCt5xwoqrPUipSVJFE2d1hQr3vObXz9JrEfHjcbzWpl4956e/Ng0O' +
                    '1O6Ve97qnrVxKd2tnCCedF+3qD+DYnyOuVdxjBLTMG+bZc461TKauIePVDdi7ZBm1YlFOYaRhYv' +
                    'yupQLC315yWNtWyO5AWLStU9P71H7i99IfBMFJAHa3AHs3Ef5sTj84gXWS2Fu2wHmN5xRkMKtiK' +
                    'uvWdzdiuB67ePhCDqQQRn4+ojc8zB1gD7QgHATsPGRJMKerDUffJWMfxewP+WUo9dW8OGMTpFGG' +
                    'FDRfeB2x+1a6x2EfimZRv2PXH5LplK5dJ/ck0ZARAbpQFRqaf7YrdSBki+BeRIwpfs90XLgfxUl' +
                    '1kXTDurhbUnSpevVMSdBmzqlx6Eagr7zB2bsLd+AuW9Ff6EjKd/0OFvT7npL42HFatMfrGzto6F' +
                    'PNS7IOILHgH8PBeG37kjLANwU/81IKsNXZxwcinN4FE2vXhxbkVntAvt2FABOpwsT2hU+IdVAPt' +
                    'CAcFGIWlESz4W8shbDV3fr+fxSp0T3ykK8n3sU9OpdL4I2H2SK0RDgw/9sIteZQof9S9cxr74wV' +
                    'JjTxn3QUZDgRMSqtuPUUIfGuNUDGIABogcJ3CJXGtllLvQK4cQdhNYQH9UwUc/lUp06+E8gL3nM' +
                    'MWYCQVY9ZubVWrIxxrATOLjPaPKmH3KrqJzIeeGpqWgCvnrpSAe8zp9ZRKQC9gI0AWHCOd8gB0h' +
                    'r7LRDiFA44ytlRZ9fiQHem3V4wzijvm9L9SQj1UA+0IBf3wkayvm/z4vioUiX6m2gHNJjfsswFO' +
                    'ZMAyl+TMg/HBYP+RUG3lPdz3bw9AeztY0xAxhWWSotvwghK/ndarT83u+jLOf8Qb018woksJ2lW' +
                    'b3XguX07uaWTRTw/Mje4NUE6OKapKUpcBwmPaLxVTOX/6XdJW1RS5eW4px4TmBMgjAD2VEG0UNT' +
                    'ck3vD+07JA39T9fqJfUMPadYapRDJd5qSKIR953phv+CdP1I72kN9oCPwVVBI2wQCvzUFjIAAAS' +
                    'htB1YgA=',
            ),
    },
    {
        name: 'silk-wb-fec-packet-loss',
        container: 'opus',
        arguments:
            '-c:a libopus -application voip -b:a 20k -frame_duration 20 -cutoff 8000 ' +
            '-packet_loss 25 -fec on',
        decoder: 'libopus',
        inputRate: 16000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'ACSAPgAMhT4AjIk+ALSNPgBwkT4AtJQ+AGyXPgCImT4ADJs+AAycPgCYnD4AxJw+AJycPgAonD4' +
                    'AYJs+ADiaPgC0mD4A2JY+ALSUPgBckj4A6I8+AGSNPgDkij4AcIg+ABCGPgDQgz4AvIE+AJh/Pg' +
                    'AIfD4AuHg+AKB1PgDAcj4ASHA+AGBuPgBAbT4AAG0+AKBtPgAAbz4A6HA+ADhzPgDYdT4A2Hg+A' +
                    'Fh8PgA0gD4AiII+AByFPgDkhz4AxIo+ALSNPgC0kD4A0JM+ABiXPgCEmj4ABJ4+AHyhPgDMpD4A' +
                    'zKc+AHCqPgCwrD4AlK4+ACSwPgBksT4AULI+AOiyPgAcsz4A6LI+AECyPgAgsT4AfK8+AEitPgB' +
                    '4qj4ACKc+APSiPgBMnj4AKJk+AJyTPgCsjT4AVIc+AJCAPgCAcj4AyGI+AOhRPgAQQD4AcC0+AF' +
                    'AaPgDoBj4A0OY9AIC/PQAQmD0AQGA9AKAPPQCAdzwAAKC7AIDLvAAgNr0AYIK9AHCovQBQzb0A0' +
                    'PC9AKAJvgAoGr4AGCq+ADg5vgCAR74AyFS+ABBhvgBAbL4AWHa+AFB/vgCUg74A9Ia+ANCJvgAo' +
                    'jL4AEI6+AIyPvgCkkL4AVJG+AJyRvgBwkb4A2JC+ANiPvgCEjr4A8Iy+ADSLvgBcib4AZIe+AFC' +
                    'FvgAcg74A0IC+APh8vgCAeL4AWHS+ALhwvgCobb4AEGu+ANhovgDoZr4AGGW+AJBjvgCAYr4AKG' +
                    'K+AMBivgBwZL4AIGe+AKBqvgCgbr4A6HK+AGh3vgAofL4ArIC+AJyDvgDshr4AmIq+AHyOvgB8k' +
                    'r4AeJa+AGSavgBInr4ALKK+ACCmvgAUqr4A9K2+AJixvgDgtL4AuLe+ADC6vgBIvL4AFL6+AJC/' +
                    'vgC4wL4AYMG+AHjBvgDkwL4AuL++APy9vgDEu74AHLm+APi1vgBEsr4A6K2+ANyovgAso74A7Jy' +
                    '+ADiWvgAgj74ArIe+AJh/vgDgbr4AOF2+AKBKvgBoN74AwCO+APAPvgDw970AwM+9ABCnvQDAe7' +
                    '0AICi9AMCnvAAAwDgAwKY8AMAkPQBgcz0AwJ89AGDEPQCg5z0AsAQ+AMgUPgDwIz4AMDI+AHA/P' +
                    'gC4Sz4AAFc+AEhhPgCIaj4AuHI+AMh5PgCofz4AMII+AASEPgBghT4AYIY+AAiHPgBshz4AgIc+' +
                    'AESHPgCohj4AoIU+AECEPgCUgj4AuIA+AIB9PgCYeT4AwHU+ABByPgBwbj4A8Go+AJBnPgBYZD4' +
                    'AcGE+AOhePgDgXD4AYFs+AIhaPgBoWj4AEFs+AIBcPgC4Xj4AiGE+AMhkPgBQaD4AIGw+AEBwPg' +
                    'DgdD4AMHo+ACiAPgCogz4AgIc+AJiLPgDEjz4A7JM+AAiYPgAQnD4AFKA+ABykPgAwqD4ARKw+A' +
                    'FCwPgAwtD4A2Lc+ACy7PgAkvj4AsMA+AMjCPgBoxD4AlMU+AEzGPgCMxj4AWMY+ALDFPgCExD4A' +
                    'xMI+AGjAPgBovT4AxLk+AJS1PgDgsD4AtKs+ABimPgAEoD4AdJk+AFSSPgCoij4AfII+AMhzPgA' +
                    'AYj4AyE8+AEg9PgCQKj4AiBc+AEAEPgBg4T0A8Lk9AECSPQBgVT0AAAc9AABoPAAAjLsAQLa8AO' +
                    'AivQBgaL0A0JW9ACC2vQAQ1b0AYPK9AAAHvgDYE74AwB++AKgqvgCINL4AYD2+AEBFvgAYTL4AC' +
                    'FK+ABBXvgBIW74AqF6+AFBhvgAgY74AMGS+AHhkvgAQZL4ACGO+AHhhvgB4X74AIF2+AIBavgCo' +
                    'V74AsFS+AKBRvgCQTr4AoEu+APBIvgCgRr4AuES+AEhDvgBYQr4A+EG+AChCvgD4Qr4AeES+ALB' +
                    'GvgCYSb4AIE2+ADBRvgDAVb4A0Fq+AGhgvgCwZr4AwG2+ALB1vgBgfr4A3IO+ALyIvgCwjb4AoJ' +
                    'K+AICXvgBYnL4AKKG+AAymvgAIq74AILC+ADy1vgBIur4AFL++AITDvgB8x74A9Mq+AOjNvgBk0' +
                    'L4AcNK+ABDUvgA81b4A9NW+ACDWvgC81b4AvNS+ACTTvgDs0L4AGM6+AKzKvgCsxr4AFMK+AOy8' +
                    'vgA0t74A9LC+ADSqvgD4or4ASJu+ADCTvgC8ir4A9IG+AMhxvgAoX74AGEy+AKA4vgDoJL4A6BC' +
                    '+AID5vQDg0L0AUKi9AOB/vQBgML0AgMS8AACxuwCATzwAAPY8AGA/PQBQgD0AYJ89ANC8PQCQ2D' +
                    '0AcPI9AEgFPgBQED4AYBo+AFgjPgBQKz4AMDI+ABg4PgAQPT4AOEE+AJBEPgBARz4AQEk+AKhKP' +
                    'gBoSz4AgEs+AOhKPgC4ST4ACEg+APBFPgCQQz4AIEE+ALg+PgB4PD4AcDo+ALA4PgBQNz4AWDY+' +
                    'AMg1PgCoNT4A+DU+AKg2PgDINz4AYDk+AJA7PgCAPj4ASEI+APhGPgCATD4AyFI+AJBZPgDAYD4' +
                    'ASGg+AChwPgCAeD4AwIA+AJyFPgDUij4AVJA+AACWPgCkmz4ALKE+AICmPgCoqz4AqLA+AJS1Pg' +
                    'B0uj4AUL8+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAAC9kzSkAAAAAAz8dEwBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAAL2TNKQBAAAAeCIS0wE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAAL2TNKQCAAAAEdoUFR8qOExBN' +
                    'jk4OjkwMjYySEk0NjEyNzgzNDg9Pjk3PzorKIRWXoXNwK85p7aH6cBKKgZcUPbbQvzAagMd47IC' +
                    '1M66bA87bJ9c8fUxKMVOe0RmS0WwQjuse8/izwDpSgdAhmSX345XWyEweiPH/3mjkpsEAf73xfQ' +
                    '/VvoyZlNuWuVaSeAo75dKTXnK8ZPOalkJNDJTTrlJytmsxq5pkIJuWP2KK50ExWLWsA+KAbnhPU' +
                    'BfkBej2P8HwtjcEj2hbfFzp/+OU/A1Q3j2rvJ+tmQUKOaSN4bWR/GwGZCLkwgTCGIy/fzwfIX6a' +
                    '4GVyUsSSzGsb8tpX9JcKpN07pRf1Nbvs0+HM56BPv1Gykv4kK5T4iEo6yZCOd3BnByoWtcX+2Ag' +
                    'lD414mKJOCo8hsezdSo4XMkzbrmEAIyoiJoUDz6Wz69qNiiN4UAo6yH0YVdZ7KCSMHjzM6OXmuw' +
                    'yOYuh/+ArpW1LAco4Z4aCYyv7xlfB2U5BOTqoFvfIL8K6Sc1qD/wo6rUcRfG9tBDz71BnU3DpUa' +
                    'Zl8pNM7jIgn7t23j1+g3D1ANGEi9rejMCTD9LzkTWs6tnKjsLIJCjpbzRe85sWOi7UIaJMzF9sg' +
                    'Hj6OtQ5j8RV4lZ/xG4zhQ1F3jv4r3nFzw/DDiU+7dcv/gITKgdQiego6XOCKn+OYX5yYpI+OU4j' +
                    'MV7Bu2BFt3/3gY16+3iOHo0OBCUj6Kci7mJWtUiI+FL19o02NNPOlSAo6XN+UJSxNjWGc7XvFlN' +
                    'VwoGHmfvdEg0MTbnm0WwEDS/cv0JysYjoSvw6cLLDR6go6XN+SvqvI//yio6QvgWLLTqPiBqrU9' +
                    'LQI3wdSSnBRDpaR0VbxL/X8rokYBoqu2IAQijpbzRe85sWpcdtMxzq3ber8wM21KmQQVm667bMY' +
                    'VmCYjOmd0kW2f1IFadvgtgncv3RnRI12CjpbzRe841RNCaKJjbEP7NqyGK2aAw3ykSxEN2c2xei' +
                    'WBuk1ik/rHTwuyzw3imSRbKIKOuip4iw0P4aTxHoqqJD67qDHFrRSrxIyUgIxZEUzFdsz6YizXp' +
                    'FL3lyhcgl/Efkv1rZDM+fy3wfg4JDe2K6jxhWPPj/NuXpKPkzQcNqdXGZWKPFrn/9TwPonMRHCW' +
                    'eJOBXDaCSGUAo6aKS4sIDaFjRMI0cxea35GTS+RK6Fh3AFgDyXn7yNGrf4vwDaJtXM2ijySn1LZ' +
                    'Pec+UmdzKIUt1WxuaN/+ASRgY/g/X7PAD+0tYDILPlgpV2H+GxtRw8xg3W8pKko7NI/L//9G921' +
                    'm2DtaGoO0GrtKVzDT/jKLls8GrXXg1g6Gyzj0CZj+3t3XqpBK3/ubBHIwiAo7W9/9EgB5q5boPS' +
                    'qzkYnTjh3EVG2FM/GIBz2E4XOEdv2F3wWGT09hL4xyMlgTBrgKOxo3h7m/lqXki2zz4AlQ3hJU4' +
                    'yt46kmqsFvZThslF94/t9kuT1En7sT81RJ1eFB2NAo6yZCJf6TOTLMJLGOxwJeQs6oswljbEwys' +
                    '+NInk0Gu2BGjxeXVopOq1qUGPINrY0Hfue73PwcKOlvNGFXWeG0St6jLsrMZrNWgXLJeoeyoICw' +
                    'R0bq8LNoBt32xUHrc3Y9GDY3hgPkqfO/g60ltqAo6yH0XvONUTFmBzfyjcpzXKRB/5tN07Evy9Z' +
                    'e3oFFsUs/IGJNlF2n5MqkluxrEWtyakgo6yH0YVdj05X9OEgUN2N7FfAapyAOlOqlxFrJyf/PgP' +
                    'INM/FH4kmuSxmD3bMNIBGkze0wKOsmQiX/BeSVC0DQTIM1NPt1nKZifyVAE5VNzKF0WcLvWPUj7' +
                    'nk5851kpj0l9SYuzwpXvWVRojAo6yZCeNIpTvpECKZJY810KlrATEH51RBmccyWOaH76OYpUfmS' +
                    'gxj7MB/RitPA4Ur0pb4d9ozemh9G/HOEKO0dvxtL0XKKjXtOxo5OiM56qh3B7hKT0nhfppEu8BM' +
                    '30jsHtxKVgzmWx7kTPiH1q0IazeYpfV70AbLGudAo/Ip1oyyO/qDvCvup7LhO2B8D4ZKXMt61Xo' +
                    'QNX0KyDVRKmIYdPHppFHXY1EExeaGQI7cezrkg/GAo+hrtwzR3XNCbrHAPP3QI2ubIZEsQhg11V' +
                    '1D7quqABMkPUsQGK95Hvnx+s6azLcC3FeRoVdGzKPNksW5UEXZulWYVwfE3LgI0vW894mSsTmX0' +
                    'it4VS4cwKmLun/MiOfu0PMvAuVnx4FA/bRR730lPENC/R1WcKPRa9nr9LyUaGlPxtjIpCWIu8em' +
                    'xeC/04ZB0FrpvbXzBv2p6DQVCXdYvXkTAipYDZ1aX0tu3iCOwwCh0N7okjkSnqxI83dV83DSh9t' +
                    'K19M1PaKsCU1KwzNSkWf6GFdJfO7ONWvA=',
            ),
    },
    {
        name: 'silk-wb-dtx',
        container: 'opus',
        arguments:
            '-c:a libopus -application voip -b:a 16k -frame_duration 20 -cutoff 8000 -dtx on',
        decoder: 'libopus',
        inputRate: 16000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AHCLPgAYkD4AHJQ+AICXPgBkmj4A1Jw+AMyePgBIoD4AQKE+ALShPgCsoT4AOKE+AGCgPgAonz4' +
                    'AkJ0+AKSbPgBwmT4ACJc+AHiUPgDIkT4ABI8+ADCMPgBciT4ApIY+ACCEPgDcgT4AsH8+AAB8Pg' +
                    'CIeD4AQHU+AFByPgDwbz4AWG4+AKBtPgCYbT4AGG4+AOhuPgAQcD4AuHE+ABB0PgBAdz4AYHs+A' +
                    'CCAPgDcgj4A0IU+AOSIPgAUjD4AYI8+AMSSPgBIlj4A3Jk+AGidPgDUoD4AEKQ+ABynPgAUqj4A' +
                    'BK0+AOCvPgCAsj4AsLQ+AEC2PgAwtz4AmLc+AJy3PgBMtz4ArLY+AKS1PgActD4A/LE+ADCvPgC' +
                    'sqz4AfKc+AKyiPgBMnT4AgJc+AEyRPgCsij4AnIM+ADh4PgBgaD4AyFc+AFhGPgAIND4AyCA+AK' +
                    'gMPgDg7z0AQMY9AMCcPQDgZj0AABQ9AMCBPAAAkLsAwMe8AGA0vQDwgb0AYKm9AIDQvQCw9r0AY' +
                    'A2+AAAevgBILb4AiDu+AChJvgBgVr4A6GK+AGhuvgCgeL4AuIC+AHyEvgCwh74AcIq+ALSMvgCI' +
                    'jr4A8I++AOCQvgBckb4AYJG+AOiQvgAMkL4A6I6+AIiNvgD0i74AJIq+ABSIvgDEhb4AWIO+AOi' +
                    'AvgAQfb4AoHi+AIh0vgDQcL4AgG2+AJBqvgDgZ74AYGW+ABBjvgAwYb4AAGC+ALBfvgBIYL4AqG' +
                    'G+AKBjvgAgZr4ASGm+ADBtvgDocb4AYHe+AFh9vgDQgb4AHIW+AJyIvgBgjL4AaJC+AJSUvgDEm' +
                    'L4A3Jy+ANygvgDopL4ADKm+ADitvgAssb4AuLS+AMS3vgBwur4A7Ly+AFC/vgB8wb4ASMO+AITE' +
                    'vgAwxb4AaMW+ADjFvgCExL4AIMO+AOTAvgDcvb4AOLq+ACC2vgCcsb4AlKy+APCmvgC0oL4ABJq' +
                    '+APSSvgCAi74AkIO+ACB2vgAQZL4AQFG+APg9vgBIKr4AIBa+AHABvgDQ2L0AwK69ABCFvQBAN7' +
                    '0AwMi8AACJuwCAgzwAoBI9AGBgPQBAlT0A8Lg9ALDbPQCg/T0AGA8+AHAePgCwLD4A4Dk+ADhGP' +
                    'gDIUT4AWFw+ALBlPgCobT4ASHQ+AOB5PgC4fj4AhIE+AFCDPgC0hD4AjIU+AOCFPgDIhT4AYIU+' +
                    'ALyEPgDYgz4AqII+ACCBPgCofj4AwHo+AMB2PgDAcj4A0G4+AOhqPgAgZz4AqGM+AKhgPgAYXj4' +
                    'A+Fs+ADBaPgDQWD4ACFg+ABhYPgAgWT4AEFs+AJhdPgCAYD4AwGM+AHhnPgAAbD4AcHE+ALh3Pg' +
                    'B4fj4AtII+ADiGPgDciT4A1I0+ADiSPgDolj4AsJs+AFygPgDQpD4AIKk+AGitPgDAsT4AHLY+A' +
                    'Ei6PgAQvj4AVME+ABjEPgB0xj4AgMg+AETKPgCwyz4AoMw+APjMPgCszD4AxMs+AETKPgAwyD4A' +
                    'fMU+ACTCPgAkvj4AmLk+AJS0PgAsrz4AbKk+ADijPgBwnD4AFJU+ACCNPgCshD4AqHc+AFBlPgB' +
                    'QUj4AyD4+ANAqPgCYFj4AcAI+AMDcPQBwtD0A0Is9AIBFPQDA5jwAAAw8AAAqvABA6rwAQD29AP' +
                    'CBvQCApL0A0MW9ADDlvQA4Ab4AsA6+ABgbvgCAJr4A8DC+AGg6vgAAQ74AsEq+AHhRvgBgV74AU' +
                    'Fy+AFhgvgBwY74AyGW+AGBnvgBIaL4AeGi+ANhnvgCQZr4AyGS+AJhivgAYYL4ASF2+ABhavgC4' +
                    'Vr4AUFO+ABhQvgA4Tb4AwEq+AJhIvgDIRr4ASEW+ABBEvgBQQ74AOEO+AOBDvgBwRb4A2Ee+APh' +
                    'KvgCQTr4AmFK+ACBXvgBQXL4AeGK+ALBpvgDAcb4AYHq+AKCBvgAkhr4A0Iq+AMCPvgDwlL4AUJ' +
                    'q+ALCfvgDopL4A5Km+AKyuvgBos74AJLi+ANy8vgB0wb4AvMW+AIzJvgDYzL4ArM++ABzSvgAw1' +
                    'L4A4NW+AAzXvgCg174AhNe+ALTWvgBA1b4ARNO+AMjQvgDQzb4AWMq+ADzGvgBswb4A7Lu+AMy1' +
                    'vgAgr74ADKi+AJCgvgCkmL4AWJC+AKiHvgBQfb4A2Gq+APBXvgB4RL4AaDC+ANAbvgDwBr4AkOS' +
                    '9ABC8vQCAlL0AIFu9AKANvQCAgbwAACg7AAClPACgFj0A4FY9ACCKPQDgpz0AsMQ9AADgPQAw+T' +
                    '0A4Ac+APgRPgA4Gz4A2CM+AOArPgAAMz4A4Dg+AEg9PgBoQD4AuEI+AKBEPgBIRj4AiEc+ACBIP' +
                    'gDwRz4AAEc+AJBFPgDIQz4AyEE+AIA/PgD4PD4ASDo+AJA3PgAANT4A6DI+AGAxPgBwMD4AADA+' +
                    'AOAvPgD4Lz4AQDA+APAwPgBoMj4AADU+ANA4PgCgPT4AIEM+AOhIPgDYTj4AEFU+APBbPgCwYz4' +
                    'AYGw+AOB1PgDofz4AHIU+AFyKPgC4jz4ANJU+AMyaPgBwoD4ACKY+AICrPgDQsD4AALY+AAy7Pg' +
                    'D8vz4AuMQ+',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAAARy3ZpAAAAADpGM3sBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAA' +
                    'AAAAAABHLdmkBAAAAHP+pAwE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2' +
                    'Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAS4cQAAAAAAABHLdmkCAAAAqoep3h8iOTg3N' +
                    'DY0MTU2NDIqRDcvLDExMC02MS45HSszNjQYSITkdMW0WbMpgok9ITehC6a/2yqp7VBNwBUW1a+5' +
                    'qg8awEivlsl6onN6Xn9LLfkODLCKTluNAPHyT0rXudj00jauc2hdc505Ei4Fut1LI0/FS8qyCnX' +
                    'HxZqT8Eiiinl4334bNr+9D8lnsuer6mKjLqYlT41CcNIRTmF1TlbN5dYJHmTiTCvdzs5CUco17Z' +
                    'yD/nrcSKKKeXjfUtl5uXMgRLEFuy8TFGajAKQssv7rTg1NE8tftnbYgA/ixSA9jx2+baxyoRI3i' +
                    'm9DgEiiinl431LZhC4npenJeJhbPW7mGF87CrZCukZFQvWcCmnEOfjCqgV75WOnrxL76uYX4NhI' +
                    'oop5eN9+BnfnNhESQNZo2XlkI0jMu2GDIiNCD5iueiLEsomMZKSKQTja7Df2yKYwQa1zFc5Ioop' +
                    'lvgf9Ef/dmCbur3zRbv12GWZXZRkHWAcWPgin1W03m7Swyf1/+m8SJf0wo942id1gSKKKZb4Grg' +
                    'fUJ1Thkbl4Zuuu5Rp+CGzEoG3eqtiSLrJrnNuh9BncYzFPGn40rXKogEiiinl431Ur4tFkiEtft' +
                    'fmwsZcPxjXbmwTbMx4M+XPJOoIkdUYqPccZN9m6ET7hT5sMdWSgSKKKeXjff4u/MQ1r4wOcy2Fs' +
                    'I2fawHeSp91TdompfDvqx6pOeQz7avqIehi6xgDFcgQHqE0kSKKKZdite9VvB3zRENeZdGmX/4E' +
                    'AE3hn75ejs+3ti+1MfSkgv/+kR8d8ZrL/kaAA8bGuXEiiimWtX0p7NRi/WaDcRIS0yrdGGRrRQi' +
                    'E+fWmSSYQu0beRDAzrK3N0nz6VtnnrtQqwSKRFktHfpJXV4vz2fap265kxqNvs9/bo/95Wrw6qK' +
                    'QMyQu37pryqAwKcSLZ9gUlxs2hHmWnMkxqqfw3XYH8tQpVNxfhMNlyWOD0fZ5W8yp4EJ25DHf7H' +
                    '9eUSswF5fYwp6p07akbiCpHGC3lq7mBIo9LFrV82yCn2IKE9666ieRzYGSJfPsnNvsVBlqsBKJp' +
                    'zXgM2cepScp2n/r/vLJc4IyBEs7KsSKPSxa1elS3Kr4p773BFTAoUsaXW9+NqcrHfw249uPAhhS' +
                    'CD7voiEd5MbphwWZhIo9LFrV6d+/OpR4SlUH6tuIl7UnjuruTx/aB4/RgtTod2VH/K33SmVsIfB' +
                    'Eij0tl431UXhsrFZ7htTRtRwD//qNU4bYZFrXNDBmn0pYc7LNTIBTgWq5Yi/Pz/y+VIo9LZeN9+' +
                    'GztOTPUN3c2eTJV1A7DtwqEIF/T0cTPfsRSKt5upDwUvk3RtGuE/AAFASKPSxb4GrhEaIoikLAc' +
                    '5ksgj5MVPCPxOA3gvmxsiEQ9jN/U6a36kKXvcm5eWz/OUSKPSxa1elSWlz3Pza6uTWUSBpEvJWo' +
                    'rspRY2NhuK88l9jDx3k624ZRdmN2cgSKPSrd0C7bhXWTksnDLOkNqqcmq792EglUKoypJkHUDsH' +
                    '4mWF5f5a6jAWuOOVJ44ktXzm0+ASKPSxfa0NZBX9HrQRC2e0oSQZ6Btt9fF/M87VbxouhJLoiZl' +
                    '9drwVzeiGOHZghZz4Eij0sWtXpXC+CltGCLfpg9qgOVwCHfkyQy3Tc45Tb8zsxqh9xmhIKy1zc+' +
                    'NshlIpsqf8zeBeuzrkYMn7NlxlrDchkdYfQBIrhHQPYADjRzI5DVv6szAQQUBeeFwmpUeouzNPQ' +
                    '1ze4BIv9K9IuOhc4LuePU4UsIVFbkKX9ETgypI25TugEiy/G8PmPIiMl3NnVbxDbqmdbn7g8RCm' +
                    'WpuWNP2KzMLNdrufWQ+d/4M2BhIqFV6bMje1/nrshz6yeNXqCJyk+u+OYPwhw5m+xbtEjsSTarE' +
                    'RMa48gIKvgZx4hfCHkpIpuNL8Wd1b3Iq6+OIWhylV7lxOHjV7+namY1mdvPPneM+AM96mow1ZVA' +
                    '9E63+X5nTpWoudkBIqISBAdCoyaQiAxj6Yt6OtbkLnnmStDnTFHjXNxWWF247fdBu15cDoObQRo' +
                    'QR0Lnvs7NASAZt92CiBfRmNOLgls60Hnv6LdOEvcGA',
            ),
    },
    {
        name: 'surround-5.1-family1',
        container: 'opus',
        arguments: '-c:a libopus -application audio -b:a 256k -frame_duration 20 -mapping_family 1',
        decoder: 'opus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 6,
        seconds: 0.4,
        frames: 19200,
        referenceStart: 4800,
        referenceFrames: 120,
        reference: () =>
            base64Float32(
                'tarxPXnrFT0fT+m9IobEuUHh6j24sSE9jb4FPquvIby5L629oem/uWBENj63dOW9UrARPhaaaL3' +
                    'WBTS9z/26uRGAUz4mXXq+VaocPr8b072Q0eU77cW1ucrxUz4JwKi+VKImPpJDF76+9Ic9a0Wwuf' +
                    '2HRT57Qba+s5MvPoJCQr7tZwY+8H+quUIQOT6Cb6q+5n83PgSjab4k20o+UHmkuXEfPT4DMJK+l' +
                    'm8+PopKhr7AqYY+jjWeueWZWT7r83m+uGNEPs08lb5R8qQ+0LiXuR6ghj5otGy+u2BJPptuob6P' +
                    'fL4+YAeRuQTspj4LGYG+mHBNPo68qr7L0NE+pSWKufZzxT6pF5a+XZlQPhghsb5L990+IRiDuRo' +
                    'g2T7UX6e+8elSPvqrtL63g+I+3cZ3uVWK2j6p/qW+Lm9UPk6Jtb6Qp98+eBhpuZ0txj5pbIi+oj' +
                    'NVPkn8s744I9Y+kS5auT9xnT5nxR2+xkdVPgZYsL7UM8c+zBJLuc+zTD55C/G7x7xUPmoCq74cd' +
                    '7Q+5s47uaheqD0YGxA+A6hTPsVopL6GvZ8+q2wsuZEY1rzDeIM+qxZSPpEFnb7q5Io++fUcucTj' +
                    '373YeKM+GBtQPhZUlb5uQm8+r3QNuTHrIr7IB6c+CtBNPm/Fjb64uk4+XuX7uEfdNL5OCZc+cEB' +
                    'LPtDNhr62JjY+pPPcuJLZL77VLoI+QIZIPpHLgL4zXiY+yie+uFaVI75cTW0+1b1FPiUXeL47Kh' +
                    '8+QJWfuAV/IL68RHg+B+1CPoOlcb4rNx8+Tk+BuHbUMr43npA+3SdAPraFbr65RyQ+79FGuATcX' +
                    'r6WJak+1Yg9PuLPbr4Kais+5+kLuDqzj75kaLY+uyc7PsVscr66QzE+eBakt/iLs75iNqs+zxE5' +
                    'PrgVeb6TgTI+5c3Ktu/z0b5iGYI+Kko3Pis1gb4MESw+oz7wNuIg4r5FHAA+4e81Pvndhr4ckxs' +
                    '+2++nN8jt3b5X5dC8zhU1Pigjjb6pIv89YVYIOL+bw75MKye+p7g0PiWlk76GHK89hAQ7OFF8lr' +
                    '5ijoS+SPA0PtHnmb6fVRE9MeVrOKoJPL7MRJm+csk1PtJxn768lsG8aW6NOB/Mj72hVJW+IT83P' +
                    'hTTo77yjLa9peijOJMZ5DxqqYS+lV05PmaVpr4RVCG+9VS5ONu0xz0Vm2y+zS48PsFVp77ZZWa+' +
                    'rqfNOFprCT6Pr2u+J7g/PqPApb6BPZO+0dXgOAY3Ej5Ploa+CflDPjSSob4M7q6+CtXyOEwECz7' +
                    '8DqK+OuhIPkKjmr4fw8S+3s0BOcQ9BD5Qlbq+JItOPifbkL6/pdO+iZAJOSoYDT6UB8G+SN5UPu' +
                    'Y/hL7wC9u+hq4QOTbHLj4yEqu+YNFbPqT0ab4jD9u+RyQXOdigaT6agG++KmZjPnh8Rr7RTdS+v' +
                    'O4cOdpZmj5LBsG9CpVrPjG1Hr7h7ce+TAsiOUwKwD7crlo97Up0Prfa5r3Kf7e+3ncmOSid3D6M' +
                    '5TM+z3t9Pk0Zi73gx6S+1DIqOV/+5z5Vun8+N42DPu7MsLy1oZG+BDstOVii3T670Io+EY2IPnA' +
                    'IzzzXiX++t48vOUfKvT6BY4I+/bKNPtKWkj2kTGG+nzAxOUmBjT46wmg+/PWSPvQo7j0qn0q+3B' +
                    '0yOX+xKj5kcl0+90yYPq08Ij5tdTy+81cyORLheD3qQHM+DqqdPjDOST7myja+098xOe7fyry85' +
                    '5M+/QejPqoNbT77bTi+07YwOdcTpL3fWrM+DV2oPi+whT6OKz++t94uOa901r2z5sg+0pitPnIl' +
                    'kj5xOEi+tFksOe6a2r3eusY+arKyPv/Jmz5tPlC+bSopOVv7zb2lJqY+UaC3PreWoj771VO+91M' +
                    'lOV5f0b3wJFU+o1e8Pqifpj7e5E++0tkgOTm+/r1xPII9RczAPvEPqD6W4UG+6L8bObGyML4gzp' +
                    'q9VfTEPosqpz6RLSi+hwoWOYv2eL48uDe+vsbIPoJIpD64KwK+WL4PORX0pb5S7m2+4TXMPkzJn' +
                    'z5U4aC9XeAIOUPxy76wNHS+uDzPPk8gmj7/lqW86XUBOZBQ5b5FAGC+xNTRPkjFkz6Eozk9Mgnz' +
                    'OI0r674uRE6+aPDTPi0pjT4M1Oo9pyTiOHa52r7m+Va+BIvVPsvFhj73ZTw+ikrQOPcmtr7EUYG' +
                    '+4p/WPvoHgT6EWH8+tYe9OPUHhL5SKKO+CSfXPl2VeD5TPJ0+gumpON0xG7496sO+gBvXPsm4cT' +
                    '4hTLU+yH2VOFfyYr3kGNS+h3jWPonmbT4qscY+0lKAONfxhjxJM8i+FD7VPmZpbT72y9A+te5UO' +
                    'BZ2bT0gjp2+P2vTPhhbcD5Tk9M+A/UnOIjNkz2FdTe+lfvQPoKUdj57js8+F6/zN964jz33oA+9' +
                    'b/HNPsXOfz6KzcU+8muVN6o+ij0TeLo9wk3KPhHJhT6UyLc+NoTVNp9Poj1EejI+rw/GPhicjD5' +
                    '/Nqc+ksCwtiqh7D2GR1Q+5T3BPpoElD6i65U+aAWPt7t3Nj7JEU8+Dt27PgOUmz4No4U+Btzytx' +
                    '4VhT6u8Dw+u++1Pm7Roj6lpm8+hrgruJAvsT57Jzo+l3uvPnFEqT6sJFs+x0BeuNk51j474lg+r' +
                    'IioPqJ3rj5T5k4+t3KIuLKY6z6pfIw+qx+hPi7+sT4eAUs+tsKhuN266z7WvbM+mUaZPjpxsz4E' +
                    'aE4+BAC7uJS01T6ICtM+uweRPu58sj7hClc+chrUuCV/rT7Dnts+WW2IPsDgrj5wLWI+CwLtuCb' +
                    'GdT74JMU+iP9+PjlwqD5Ohmw+h9MCuXfoDj5XWJE+yZdsPkcdnz72rXI+//wOuU9YYD2fUxc+8L' +
                    'dZPrzukj7Nf3E+0PUauWAnTbtiox88jHZGPsEGhD4YT2Y+f7YmuW8WAr16mMq9C+4yPvU/ZT5/U' +
                    'E8+wDcyuShdGr0ABiS+kDUfPgYSPj6cwCs+fnI9uWBZDL3utjO+nWMLPj1PEz6xBvg9319IuaCS' +
                    'Gb0FJCi+fxjvPWC6yz2TNYM9UflSuUbSeb0NIh6+2Z3HPWYfWz00gXq6lzhduXv25L1R2S6+4YS' +
                    'gPYsB5Dv2tJC9xxdnuaqIQL6QvGS+AtFzPZ5NIL2gsBC+WJFwuQjUjr5wPZu+WAkoPS5zq71f91' +
                    'W+G6B5uX5MvL42G8W+yBG8POPSAL4YKoq+oB+BudA1375y29+++WCwO3R+KL4OQqS+JTWFuVfL7' +
                    '774rt6+JEQ+vBrzS76IAbi+iQ6JuQIW6r5/XL2+sgvlvPiXar62rsS+36mMudULz74QL4K+0pgy' +
                    'vbcAgr4YI8q+YAWQuXhLpL7q6u69l5Fvveb4i742zci+ah+TuTUsZb4LQBU8Zp6UvQQwk74Po8G' +
                    '+gPaVuXDxBr6drsU9gLavvb67l76qAba+UYmYuTQUdr0UXAs+KfnIvenHmb4InKe+t9aauTGKh7' +
                    'wtcQ0+tVrgvT+Ymb4mOZi+wN2cuRUMgDnjcgI+qtX1vVuDl77wjIm+r52euamo9jj1IAc+1q4Ev' +
                    'gnrk74ZPHq+AhagufCL87pI3S4+k3kNvn0/j75OFmi+b0ahuamKIzzf6Xo+gkwVvuP2ib5n9F2+' +
                    '7S6iuVOjQD20l6w+ESccvk2GhL6vCVy+q8+iudoD5z12etU+VAwivsy8fr6yaWG+DymjuSZSTj7' +
                    'Fhug+MAYnvhzSdb61NGy+tzujufA0mT6xNNw+qR0rvkQFb75wu3m+bgijuaaAxj6E+LA+HFcuvq' +
                    'zjar6lY4O+LpCiuUPX5T7XjmI+VMIwvoDdab5b9Ye+GNShubyw8D45m7Y9l2wyvvMtbL5v8oi+c' +
                    '9WguW/45D45TJq8',
            ),
        bytes: () =>
            base64Bytes(
                'T2dnUwACAAAAAAAAAABEbwC/AAAAAEd6pk4BG09wdXNIZWFkAQY4AYC7AAAAAAEEAgAEAQIDBU9' +
                    'nZ1MAAAAAAAAAAAAARG8AvwEAAACYEtiEAT5PcHVzVGFncw0AAABMYXZmNjAuMTYuMTAwAQAAAB' +
                    '0AAABlbmNvZGVyPUxhdmM2MC4zMS4xMDIgbGlib3B1c09nZ1MABDhMAAAAAAAARG8AvwIAAACMU' +
                    'ElLWP///77///9F////+////57///+1////yv///8n////G////zf///9D////j////2f//////' +
                    'C/////9k////sv///8P////U////yv///9D////J/////+X8/Th/ho/7UzNlNoQrR7jvEYNMVRq' +
                    'vhkiVbYcUq9cFUB5WHLALslmZQuE2PF/JeKu9hkzBZpB2dYtAds1WQM0HsxiNnx3amUcRDu+C6w' +
                    '2EaT/z1o6gtuGMwpUU+czfUZDWwJSQLPKj3k3MuMoJFuG5kRF2RNwJF4xGiJPzCjvYYzLgItWwP' +
                    'JbGTq5siDrCOcI/39cMDpXKuUa7QuQb2OBd30Z1WLjsJ722VuAZ3Emosd4Q7ZV4bDnwchFrmAHt' +
                    'RfPyfF64NFw/SYEB/4bayn4/e6u/ADdtN+LndC6WLGGBC3McAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHEajmykkP0rMpx' +
                    'Mm2TL3i6LEQsYsTxLVyI3BS7Spd9F5HXsEGzvY7h/VLx7F+cXmD++SunYyKO6FsEwxxv9pt5TBr' +
                    'VH3eDD3/vM49/OkbLzhCak7//hpmlgKKBqJ0Z81J3yN0sbW6yZ5teZwwXAsi64NKcBnEx3nrYsQ' +
                    'yV6UaA+JwXyG9uqK0qCzlYuNdqyGeT2+ZKrm21XZTTUPHl8nPGJ6oy45vnFoepJVtka2CkiZW24' +
                    'wrYi55Xa43Gf80X4DwuhhldO5DYWy+ln7I/JXP/sVMyndpCpgnKH2Pe6ZV63ttOCZ1vZ7Wrx+OP' +
                    'QpqyKSsXmHL+lL8MboNmVez/gCy44QQRpdO0GaThm5XH5ZL3QlS6lAbc0srcXz6kw0ITPwJ/JPd' +
                    'Pe4wwaJ4lq5AZOylusFoqJk47RRY7gXiYddHL20Ye9DpFYtKwBw7hgpGxVNQ2DoYw9HcJxQ6dhM' +
                    'Mg6iJpdxtVUwfzIYsOnL2bRyU+MsQ6IPv0aJHdR/TYH9yCt8WTBtuX4wndtMZ5cqGo0t+PSf4VZ' +
                    'nJMmfPgEtxmkw6tcLZJFJ8COZfncMtA3hSrtC8lnocVOcVrX3a4DnwXGjgOuzz2b+i6lJkLjs7I' +
                    'deDfyHDQY1AN4IswGDUmvXiFtqgkna0GdQL+VlxJy2Ifml/51uVQiWFYN3s30rccd6AAAAAAvCq' +
                    'IfpWanEyLZMvZdFiP+qjLxLVzpQRdrqYfo714M77Wz1ijdYLVEe2aQaFd1hqiyTh2AjXwij4Ted' +
                    'gAPCsb+0nag8Pdkp+wIK8uzFGj4lvuhzqEUIoMfQU7ucyMTVfRLK4YuOulUZGPvyomYRnc36JqQ' +
                    'blsrqZtZWWrM6FfU6OcWdmJr2VghZy1o/k/pwsL5wAC+O/Jlq0JWLkALHLUAOGEt09ReYnp4YsR' +
                    'oZkhhFEGJjKH4JbOEq8gv3/GOwZymYoJuH94L9T13R3zHR8Ke1m6DMn12WctV0FW9GAd6EwkLyV' +
                    'uibrxvhUegcjhxBMKsvVvciQmL0KzfWOXYMbXsbyETZ7hX22k5wsVGI5tcT4NMbctj2vOawc+VY' +
                    'OPFeDxuuTw4p7WEEQ5p/Jxd5AJP8/kHejeTDgmfqfr+k+pCw0/kt1oYSm4e0BSDI3rPll3H/1zq' +
                    'YHGaWltBl3WFnqnqnquayfc1k+xPk9i0PXeWViLYTpQkoSZVKll+XmIuCH/dMRN0I4BhyZ72Bg9' +
                    'X31JY3+IYh2KzP25nDvZyaPuQ0DcdTVqoUCtd811UGbJrThVSNAmU3eEOLVwkTBr8BB69zQaBM1' +
                    'zkeqji8AiQvmpbAc04u5mRH9yPePi+EVqh2uF1Pkg81svHnhhcrQkBOJvN7y0zgPMzZ6RAkUGr9' +
                    'UCMnLDZUUMGKm6WQp6Q/AtaJutrz+vEAurTnDqYh0YrJstXR/+ZLPP2vA5wkDGnQkAksii7xQBO' +
                    'KM7zwnyiplvJMvLmluZ0v0U/uqKhaz4b2QnENV8GOpD9Hzr//a3IDrF7UDG8JjFgqS7mFFVXjVo' +
                    'nKlZbIy92udlhRahM2+SFpXBFuvJnklBNzK0ieXXp8KP4pnbwNFYPFSj9XUUhJz55WGFSfBL4B/' +
                    'YpfL8L5yvjepp5c5iq/K0Um22+3qZCl8T3IkuOS8chzjPEqzpeT1T8blOBqrkJod0DCBI27eAXr' +
                    'oukcKuCmcY5BBvZQ6P/+De+5OUVcVp+2426EbjktjL29BVuxxIizbzhxpKEUpnDk9/WXn6LGPZa' +
                    '77lC7M3HHbJrp22HD9hQZ7X9OCUi2i72N5MSMamZL+I+eMpwq6PtuUgGoudhgnfr7yqtWtJc9DJ' +
                    '4T+P+P9lSAN9yK2zX9j1Mozaqv129QkCODZavnYmWX5OLWOrBW1VsAM4j1WDK92SrIkvr+PHi/I' +
                    'Q9QlWGC8FMpFQRZ/keJFtzR+26s0A8l4JfxmOoZmhrGtw6aLdkSNgkYgFNLpFfUfkekTRTP2T02' +
                    'ZYZvS2lBnpicznkGo/gH4dGES1gYAACO/P8Nw1Rpn31kTO7hjurv3NU3MBXj4BeuyhVPloe5w6R' +
                    'DCC2emcL4EGxXNzzs2IRCQs3YbyoqiHYpMUpFHGBo2wsAY7Yhp0Ko8reuCQwvVAjoqYHwMQsk0t' +
                    'GKaL78UVg3KmBtgEFGVNTsRPBEinPgS9XPvNLhhSCfECRtVH1LJWgQ6ancQKb0IG9FWQJtFbbAq' +
                    'E/bY3RHiDl1JXghAE5inftHTsJw2jt4SG0JVK3xfnR2/bXFbHlTXEdYuF7MT/rJdl5rYxIkXwKF' +
                    'kTiJDwQdJ1ZLWnAxuE5WTzFEZmbeO5UIa9pVJEuB8qNm540yU60o71g8xcr2w21UgHZMTTOYAN1' +
                    'iuGCRuIieypqP/R/fHPkAgQCSihgTuXZXkLvIe7Y0t8zrHmixDgouDOUQdX8MGYMTNjgmXPz+P/' +
                    'GqYzXSO7vggRJbvryKdrwwVasdAzhe/HTyjt4h9ejfhPo/o/o/4PhfwfC/Xd5ufRf6R9FMvFyEP' +
                    '789mr8nOcNAnkHZLqDnrsjz80cCVDM/qD8W79zBxMXCLUydwmGF/XJ66pTME5GrTqG/Ev00kZLo' +
                    'hRwvtHfe+UHabH2vZ41CJ1Lylzu+UJLVGSmDxPImJ/QqZ0JUAqIXOL6m5Zktx7g8izCuHd/muhK' +
                    'rW2P1F823wJ+hKplsZqy8Jh2mAqyNvUflZTxoX7eom201wY9lOjPN9Trr3nf/M4oawpFCe2zuwk' +
                    'nNb6N0WhwbjUOL5Tm2qwP6XIvQEH05girSF76m++CO9RMb9mTWHNXZvCCPC7pcsrKGGlUVY+zqv' +
                    '4CFAoR66YA8clVUvLMF81CGxHAgfhDljZNIWdA91bm/VGW+5Iy6SeiMkZJFcLPkj8LxASQA9JHJ' +
                    'TcQ4qH7WT6LNHNH2OY+yCMFuKXld/rAYMYdM7M65tDvZ7fgk3PNRJkOXTdXe90fOGZZw0Kb67Bh' +
                    'OO9bVt8u/yAPrzRuQmfBUUN+R5agM+6L2HAOvkjYh3/g7XEUbreYezcFyGhKJZLXCJaI2QMfPWP' +
                    '2nglR+IUSx8lF3M5B+YDkR5oJJHvUkNm/cV+ETNNzD8m7UBGxd5POObhCZWAC0215pfblhEB39+' +
                    'LCa9N6B4MykcXj443XRC5QhkN80Hg9p9p9gdJD+cww15M66zKuX3HwVu+6XNibiLKtzXNdFJo8s' +
                    'HayhLsEfzR2s7gH76I+Ycki05qLOxRF16+RVJ8/u8ftJd78ugzT61WupobSfSFX5CCfUHimDBAy' +
                    'ctwpIPHmtLzZT4u9Ba83AhgFyko+KC7HVwcahqsTxdEfjCu7THwpRP0KE1OowSB+a9uc2le1w7V' +
                    '/iPol3Z+HAnpicHXrwuKjGJthT0QWbOh4AK478xcPBp6cY2FcmWwN7Q/+KU2k0+C294oXem/L/u' +
                    'b4uk87AZ8nJnfBtoJZfNaw0strSD6norQ8MLNEw/OcmyWFtJNG9eirqBlhgxba/8ObSVtTvqZ0e' +
                    'pP/36H4SJ/qVCB6J2dOKtoqKTEHRprUmQ6B6tqKjVigs8s5T2YKR08bVyTTPG0Bc7VBEphR1CJK' +
                    'f2mC4UVOCMRjsvoRygJa4aqhb3wni15QYMTrwbmB2EU/QOp7ITxZ1vobQWBtD2ktBAE+70k9Frm' +
                    'Jc/P4/8kWfZ3ntds1EdXy1ukva6MKh0peWlw25PPJ4dJ4XgJb9YtuFuFuHqkG/VIN8O2H5v/0U9' +
                    '8uwrdUGtdONOK+C7eFMBczFzIN1goTPsV3hSGSVnsT9+wwSqvjKogvXSNbTvlbJVGBzcXqu8wO4' +
                    'ehs8CH2WDxvyq4S7PNsMZ6LJsGyBJNrORjjqJEOBCls/axrxoEGsVumNEl1xUQETdP+UNjOyqGh' +
                    '4zuW6GFKd2B8Sh2AQuTKsSv/LzIbRB1AhMtGFGGkAgiDsbc85B9oFZ0HH96JjNiw4+pRYQdlPgG' +
                    '39gkGDbT8/qx/X4NMXhe+TA6Pmk0p9y0ZudQhd8fptdYn4hEyh3lHJKE2hYrVTQ1UVWgvBOodDw' +
                    'NTpnUi+PHyJOnycaJaToWKorF9PEU6lpobg2zB7xBtwIfhctfnPa6nNdUcKspQ1QDN3GfkBxExR' +
                    'dvWzrL2CZ+DXqahcFxAmX02BaKLj6fE4ZWGOx3Cj2kjjmhoyV7VhxczIhM0cJTkVJMl6r0It7mE' +
                    'PPUjUxhlQuWf2m2hzJ5mjJw2cJSHS8PGrDfX8C5mxX3h7uW2hONaWziSfMkHVRh9SimptDtmgdh' +
                    'PGIK/h0tlIe8i9v8Bni04Hw9OZ6nODzyCdcqFeAcaRkylZhs8HZGE/mnPE893rOkV8FsoE0vUEP' +
                    '9gMvf34wZxMwOev5FA0BvTuYzeJz51SoLfpipipiGhLEe6vKRY0tYRkKyyKB41JI+S5kTtHnpij' +
                    '32HwKIl8iY9X3gg4pm+gNgNhzY1ZLi0hRNY1mzPI6fulbxIqxTql5GSW3uBlvlKND8SdaV6dUF0' +
                    '32zKrIMreTNeRTMKgPNxVqX5TCBWCd0hRZNnkLhYWcG2JjnI8AZEbjhbop686r/U7kRX4tcMwqt' +
                    'Ltb8L+JWSRRrFQwYKEiiMh+njlWom28unSfUxTcZ6YnB2MLOkQSHBfehAOPS0xLgAZjvzewDREz' +
                    '0/esR5+GUJ97XSnU8fERg7WjY9XFXJiwJFvIJkzUE/ZfVsekpKvE/FNKYq1goWl+kC3hiJeopSW' +
                    'iBGrYtH4v8haDPi9iCzyw06vhQfZJKPGQe/sfPTwHYmlPHqJhcluaYFjLlgDimSjRVoMZ1Kn9lS' +
                    '+iRJUoK8+hmwHnlD2Ab+y/wxF2FhFsBRk7YpUiPwW58g78ey9x9kvWg75rFMPnal4V+dB/QMGS6' +
                    'D2rkhbg8COt67KbbYSJR5gLnBwJK0nfj1qPylUKrUu96AzRI1gwO1qswnmTUSTWTpc/P0/8kXKi' +
                    'UFqCEg5noFELiZ/mxIs+rjyh3aX1Ua/YFGBPgHv3v3v3wP/Pgf+fAw130L/+3Qv10DIzJuZI5dR' +
                    'us3pVOMZm7/08yG2ujg3QSHHVNiU+FvdwgDTXgWrE+HTPP/WAJslRaLjsd6NBLQKrHDYUOxVxFs' +
                    'Rey9lutJphpajBODiB4hM3lpdWKhtezeKDzMAF6HQLfQBZkQtTjmJ445MwYV4YXsQJ6n7EhfxK+' +
                    'Ztw5BdKpYlMm4BfR3IwFhCyWraAARUnfWPKkFv4L9m0DDDO9dA1RXp1Zf+VY9+YsF91FxueIWoJ' +
                    'nnB09HfzMo6WlGwChY2Yzp9244DyulnIc9u1m6ZyDHwJRlZStIVZ1BSYiV9vl9HjrUajuNwI9kn' +
                    '12xnOMMg2SExstt7NSSkRt4RgIVjVSjYwNnS55avZ1Ao4AiqnA2a5mcndTYB40y2ndM71XlvVFO' +
                    'ByUIhhDr0xcIuvXCkJIiJ9V5UxYI2MH+wiVLcRSznF8Tk+PlaSwbPB1wRnd5zlcuD55uNaF60lm' +
                    'AmvuMNrJK8Hwf++d/9dpQQ9TxYiqcZqIT7xIshbItJBBmmza+4+JRhIgTLbXpUadimKdmpDJ4nn' +
                    'Ywlz4pl7SEv3GWETGCfZ9A12YRqfbro98EldR0d7fH5bp5d/fnlFIqId8d7QTSDHYrd/fjAmvTo' +
                    'GHHamlcyQPkcIi5J89PY0D0D0DN1lwZi731mpiuicJyIf8DmJXxXbjfeFpGxQDMpiD0MFEWoLBD' +
                    'eQcNDV0d3LcoSaEGQF8OrNtrnBiUAzC/yC69BpySGPCmT4TiJHb7Ww2Ew8IT5BV/ViNzA7jeyA7' +
                    'tb1CWjRk8cWJiNyhHLYOpPCI3YrhvPrB/QimU+11WD7Ovm3GK35IcRW5HXlPBGTtCvY+S3bO+TP' +
                    '9nl9+EDEJdNFoHh7VZbda3SRw2emJw1YF2XNxsanvcuNUzLsSv/MY7888A0C5xI7kzdQTogrwFS' +
                    'vvMBDJUcx6BsHznz/EKfbpiBauAROlMquF3rZz/4QNqhM1EIR5avbe3RCPIjHPKfPTwavZdvEuT' +
                    '4rPzFkhYScf4yf/BLvZUoXcgPlIGNfCjqSNHWMTeUmk3NXlZK4LZwvjs4N0/i8wkjvZw0BPbDJM' +
                    'vEdwr69mgDFrzrFyxS2S2pF7q6RoBSlQIx9EpFeuUnWcauck4QnJ/vZ5bpxJwNCm/X7U9tVL7Lu' +
                    '4ydWJ+CNtMTymC+UXdZ07aUiLtfa762Uox8NxieVk0vP788L23+/vAmnaUP5J4y5sfHMEnK+3Ft' +
                    'Fac6XPz9P/JBUm8La4tg2GG2/WAZQmKmARtrn6MWEkvSCMe86nSVfiauauavEyr2JlXrepWdTm8' +
                    'DibxSTkbvmX6D5/XGKCnUN4R/BSXb1H+YybCj0YvSoMDKn8O7XKlmg8/vuBuyulNEBaxX61adBX' +
                    'SHmzEw8PCOvoEd6EchAV8hSqY1wBwilXLxYe+eRer3OYm1qU/olcxTn6tYQjoYC1+iFDeyKmN0n' +
                    'yqhgiIiopqtPC3K3NKykdvJMqQB+rf1tMDMO80+brO7q1ZZDY5J77UOLvih/Qrew37Id3dILyQV' +
                    'fdNDforuOC7l3aPkCmeyRrszjw6UUZhfVlekXsSyPx22XjB0EGnZsnmbAVvgYmX8QS5Qv/1E/e1' +
                    'd2kvGWEsvhTSeSUZGCCrqY6pLjqOrJ2DbvhCwDI9UPKFaG+XwyRCER+hmNlVPS9RTsVQVSXFjCR' +
                    'EuigxIVpMHkZqIZv+6FUo7YKvDGkNz1G0Qw78tOiJT9Ajne5mQgASNIqLO+uAZfbe+DD0UQtnC0' +
                    'qBTnDr1aabvb5fqjR2omRFT5dLQ0lzq5jnJk+lEAOGbwkOcfH8kex0tnq6VKMe2si1CKT+pjAmy' +
                    'Fz4R+eNGrLnf9u4p91pxESU3RzIKa8WDv5/YuZpFnqhSBD5Pwij5IVYNmQ6uHPndb8qY8QdkbSd' +
                    'Y3AWg/f34wZr0+JgclhW8OGtXbtEZ9iHgiHYfUhHhHfGsD4j4m3+U+c6c/IGPkftYmJ4e4AaQbM' +
                    're7PQ4pYkrMCchZaO+z/IPlzlrHuN2yKitUAz4KwcZ9qYqZwuK+x0vd4zLly5Rjr8qFfSxxbzmc' +
                    'nuB0QCK1qf92Lv0jvvcb7Vi7c1b5dWUAS+nNMnQiR9G4UU1HZAhYX8UZb1LvY0Mlci42+TR3ZAJ' +
                    'NYxBgYyGSx0D7f/uAbE0xv1H4EjSWpGrTDVYXSPN5Z6YnO1jRGvIbPxN1AQP9EOQdiqO/PLDXV3' +
                    'FD4UaXiNcxQaM6A/lc3vI7OW93PejPEvHhd5bC2eBMmwsmXqmkad9N5OfvIZES07sFKbt22cLJD' +
                    'nvVy5F4Xtia0MKPaeCfDcy/cgIrvMDlkdH/U70m8Dl1r9Tb1joOKXyrUd5bY6wET9Yz85XFGIj6' +
                    'r97tfPT9ZcNleqrmp7NivIy/2CAeWVgbtI3fzgw5agzbMRDchWl84/lVgSYvSDWWPgJhgT/yODo' +
                    'GbyAUp2AwpXagQ0DBiTyzjz3VZhmYpnKA17NAP6aoPLn2LNRtjYMzxCTReWwcs1XIhZxveaSerG' +
                    'X+eCZEKR2XXlrtjK6XPz+P/JFtOQn5GTWyvDwy1a3EMy4TSpL+nVi0aEKunSx0w8zwZ4GuGuGuT' +
                    'JnImTORE2nT3Lvas5TjXfrpM7I2ceh5RM5sqYP47T7JqJVJe3TzbkZ58qmaie/xJAa12EfHKs3N' +
                    'BXCwM+HXKH4G8+7Vl1BNtFTW29nf8cDnFFh3Aprx2U26dbSFXYKtV9c8nxh71vG56DF926UpaQU' +
                    'aw46PZovelNnLaqpVjUWPjDzX9+wGvlX9fFfMeiv1d89pU4azGQqYIkoz6bdjerpcoiuvsScovO' +
                    'SMkUVtz8AbmRS8VpV5U71DPvLuAMmknlpS53uVKtsDckPwbmpouOppAx1Wc5nTOoGD9PYZnPMKX' +
                    'Zj+iEhjILXXOU42VrCbuZB2G9eSEoIZDei7JzWBlkFqDGb3mRriZTCX8vN1MGcplDbH61UZJvLT' +
                    'Sba52O+xWovDbE6LG68gwylcFrEtXFbAzCr92I52F1kzc2G/CwhfVcEmEOWbv6b7TqvSkbDw94P' +
                    'SiniwWaYn9jlo9qynanzQkr+xRFDTAXBknXnMjiy6E1xMpr71cWJtaJ9CLiTRj99SSajM5rDrVS' +
                    '4CzwvgOCJpt3yoFv5WsHaMBXsvZpc6+4o5A1YPW4TvGP7v6mNlDc5aVqijpl1JV/S+rdHbbnHCK' +
                    'XeyY8ciXVYDhMVfq3ih/39+MCa9RUHqZxf8nAvryIil/JgRusXXQXQXPPH0s1zCWjiCGLqcR4/9' +
                    'gc0VAz8QyiCPMqbL2DiQMXkd3alBl7SxRMKVY2KZ8DUMn5B0MHe7ZqwA3CeK5p18dzA/DGfaDlW' +
                    'NNyl5vEpjI8sSXAKF2lEQWpOgo1aXOSlAl1pdxmwbyVxdbAh89HgcbLIDm/thbfvVmWIrbYlLYb' +
                    'sjK/XZu5ZTHcar7yiLPEL/6lim+LteMbhUbyEmGjWgTN1sFPPnSM6Wp6YnB2QEnpZBmB7fOjELg' +
                    'YS7nyO/PDDXVxc5uVmHHiF69Eqxg8ryGvHjQJB6lamaHiTPMXBn0RZWOUtcdiA5VdnRwBVhFpxE' +
                    'xR9pUo8wfdUGwClnNPBogAVUyNdM88PPBp8ZbC3nAGUtg/RJB4m4Vl4nb40gcloaBxBCOOJkNNA' +
                    'ven31rbHUi40aHamDgcj6bbwL+8VFyn95ArBarvE/r41utmQPbJ3MqmUwN6LOVNQWQ6mDu4PTc4' +
                    'TEMIUZAwJODpXzX+DIlIX92fJ1nNbme5CyZbTV83fEyNyeW/y5nTPefzadiHQCG+ym3j1pM4zb6' +
                    'bv2TfUVZ+bmMurO/7IoVSgUFVVNlz8/z7yRZ+Cc7g1JvJ07qcUa+d1R92WwCHHpc6eLpTuMMyTY' +
                    'Z4Z4Z55dAzy6BlueIe2P3CbXvrBSiK5ykf7VU1FsCkTGNKrgI7WnQmM/rl54COSFd3BLGAGE9ap' +
                    'aaqUZRFSpcOcEGkARaud/4RUz61cAGLm4Dxj23qMv7PCwA46Sn8ayfDHkc53QHggV/QpjdZkInq' +
                    'RGt6YFDh67CQT4Pg+DsShulbw17IYqziCrDl3GwU0zOprwM+F5yBSf7BiOYLF9aDHFnGHamwDWd' +
                    'goDf4mDm6inFEssC/9UOLX/35o4KhfL9t5iRhk+18Fxwu8lZBOiF77xJ9YEojXe0i4B13Zaupyr' +
                    'hmeVqYGPtzHwguxrvQ8yG4V3cIEB2bSidQVd9Sgg5O4HYy6uJYRqq20Wx6xCazZTKHfvOxLIU9O' +
                    'wbeJ2OrWSdjXyeF/ORBUwSpaof268Cna8CpHZRtsEAu50+apVXOewUAqJaojb273RP9IStLwzjF' +
                    'GoSTiuM2xLRnu37+2RlLewhHZCS1LSsN2r5HeZSTGaSnoYvZpow1u0d3plvfXjxY4nf4JInFtc2' +
                    'zsRHqhI/y/GimidA7Q9SqaWb5r3T1bW2udZnNk7k5PMQFN+DsnMSLtbz40B6KrpFp6LrGI+Qdk4' +
                    'QffXMfWeXJ8E1CQ0gzaKdjOzlZ9/fjCmvTeu4G3QxvWsLntyz4dp1B47wFLDQDQCj5CU1vOt9s0' +
                    '9i9TL2Dxqp16xLBEZAlnsSvfE26rH5PAaEnKlguoo2kmLH7BrswZYiwNcakzKXzKRL2WA8LKNUv' +
                    'QFx2JR8r6kT0Jmr8dS9BqXLcm4MbA1hvwMR1qXLxrjM5/YdAETfWICyVTNk3rya0hz6kKtjEvRa' +
                    'FyoDoa28MvgZRpPf8x2ZE7orvwYxYz2A6kTInYUnPNe3UU+tfOdPRFbmbMG2QHmp6YnB2PeEJZB' +
                    'mCfr6bvHVHizD6O/PPDwUFfoa1J3kUIZ0l/8aDuB+IZMYWYwG0StBEgUa2pm/dz3CTrqWQYlOFu' +
                    'v5mhHV9vPhg1OMaa6BnfebTEmF7/ex68pYiaSziWhxxPb/XizqYvNN/KyiLKiOQUhOXGQnTBHIe' +
                    'bXnbRN+Ne/TrPzpXLM2RBoXWA4IwksDHOz9DNtSaHDBJyxOz/qwdCR8qKj2pjFt6yYJDLa9lnMM' +
                    'X8gEXjeE37KG2zzFtoRVtqD/vM17/18DdBkz/N6TaAhqxfdO7LneQg+1Latpran8J6RFk3rXUUj' +
                    'IvCTGUh17RlW0kse4f6lJD76r72ls/aPrx1KdE+Ylz8/z/yRcqU9LLRR90SEid71ZaXHb2y5qA8' +
                    'K9KRXSWhlZgIwfcs2TaTaTaZbz8y3n5h+9o5if29mHd/gQ0so2jLz8OtQUpMoGczewzhOd0OA5z' +
                    'QSlhy6hCQc56ld60wSad+vD7h2fZw3Dbd1n2ksSi6bEkyiaEPZQM0zlVhKzLXgOdsajkEL6cEQ5' +
                    '3lqQGbhXHjWxYeYfXIlTM+B6rzAdryic3SX+ohL6AdjPaBN5PwIsiNl9FMCyDYd/MY4/1Wo3TLf' +
                    'HdbdcW6hVo9M2DiZhRCd9MN0A2Mx9VveNWSUcMhxpxhq9ENGSxy5hrM9ZWMoKuLiioL04/siY7G' +
                    'bKtKrO7j3ZZ+85s+d6qXFrqx25dhoF5OaKYNYBtzmTbxtFRWwzk4Q2vci+yjmXjMwwrNFvjynyz' +
                    '6l8JFwz8P92nV3Com+ahUvZ1U33i5swtHGk98vYI39OSFkijsDRVh4k3Ec4EM9+3Qk4oAqBk93S' +
                    'I1r00c/6jXbsP+IE1TElnRHCOJkw0J9P3cZgQVYuB7Hw1jAt1QubAtAaTf0K5w0N129zRkTSF+a' +
                    'P6r/97/zXg1vKHRtOTviSfPpbnbh9Si9v95FmgdjeeM6/h0tnGS2q9v8BnMY8OgPU/pzRwCvQdd' +
                    'o5EcBxpGAZ+GGzzgn8wWjAAujTss1WaufmhMVxTP4jfw3f34wpxMwOev5TnRp9kZAXEwOsh47FS' +
                    'vvvvvvFLBP/XIoY9Sef4QVx7y8Vmn3h4u6RE5M2DJvssd1YMAVK8s1MU51tuTKPHcS3hEoWUh/T' +
                    'NIClKyrONiUMBRfqEjM8DCSTPUKTFWU/kPV1uHJR8uotzZRzBFwaxkW/t5rBbKOBHt1V1EsLPdz' +
                    'oU9C18qD0arNsQdAzZ0D8VLa6LofBV/6NK/S2e4bva34dKNvErJIoP/UMGChJh86CtmWRx//XYs' +
                    'zn0sEt+emJwdj3hCWQZgmszrCqUrIswZjvz4wDQLcjXAOqQE5mh+bXQAAiw/gOlLPlf/rfrqxaV' +
                    'FnT9+Ek1ZxZAacBaIQVFmcxRpMK5wofMyJqZJc+osJB7wB9VE0SH0Yc4a44E7qdKrVjR7fuRTtp' +
                    'Zkb5s24Y2J48H4ZCmxy0sD5+AzIfBigxfLw0QQDt+pnUpZZIFPqyr68LDEZqUHf26aC+2spRgAp' +
                    'MUkdbfhIRy+ap7bw1THE8EbVGgWvux/wqK0UIJNNXeh294Pj01yuQQxzg0rxh7r12MImwsNjdqY' +
                    'F7v77RqoRDYeRKMm4yjOBWvBFsuNCoITMWUU6hNVNFO9YP4fNLqsGkeSbrmcUKStOlz8/T/yRcq' +
                    'JQWoISDmegUQuaYmmGmDxitn7gwVLcDcZsctblWqrGrGrGrj/FXH+KtrWSAVf+oCrkt3kchROso' +
                    'UpI1G9R/9ZamDbSThkZ5c9lBcSFfh2z/ePhgtD+DNlgaMJkHOGJ4yBwe0XHxjdMC0s7D7yyNGpB' +
                    'W3mE4CC9j3ztP7rrdSGMBnhpKaOHDweb2h1J8Hpx8oPdHWxe4TFa4sHQckno9nFyYFx6qlfGv94' +
                    '6Y/UsMaIkrb70J9cw6WorldeEMu6/y5a9dLAe61px/U1vrpcYaZEfsVICCxvA2lw6S2N2MiOuij' +
                    '3YZB3sDR/+QgDMZ2q5EFXyiOEFa2spfkyYVJ6MkgLhmuh7WG/7ry1T9KjleMpzgDEpQzeN2kw9w' +
                    '/W9q8c+FaRKuKtFC6YdlPLsxTc7c1WI3GBzOuXUjFtXMs2NBD9o2Zhbhm8ULB50BQ30/M/pHLlA' +
                    'lUPT85UUs3eQuVGZXC62pwqZCVOyrG5sY3Jw8VeHIr6bnlFcQOKkmNYGfQss2BERvlwxUwUiB9j' +
                    'v5f24heGyrSxD6ixyCja7Wt2ZLKcVpmsSZUIdeZEOI8gzTZv8YfEownZ4gfr0qNMFyjOzVbxXAT' +
                    'sYS53gD7vCX7jLZFZjfQn2AMKgan24ubvBJXX5HXblmB4uAy8+d0UyoiHx3tBNIL9it39+MKa9O' +
                    'gYc9od8Dpm4jGEq/qHQqTWFc9s9s81NEPd5UMsW9FcYOoo4LG2lCuOoEnMKdmvz3qtnARhDtHPL' +
                    'ikXpebnh1oWiTgfVu7djUWF7M2PuraSCZvcwrkOIMb5pg1xDQ/TEBtmmBimb5Pv5eTgqxpDJ+bv' +
                    '6yd+SzIdmM1jbIlD4pW7zr/OPwjTGpGH7tuAtTbl/ygnD7VjJPvYso1LnlGoixUSbbubNKPkt2z' +
                    'vkz/Z5ebytEbGZpVbRJq0m3Wt0kdQnpic1t7nLV239JCv6glBVNV2H478/QPANETQOCOpqB+ltg' +
                    'qEqnraVn/0RcQsSP1k1k7m9ddMNOSEgYUeA5TzcR8on6DFExL54Xdbqoha7KASZCdIGTQakQP07' +
                    '3c4HTik+S7rb2jMaTI0UPCOo0Q9KaAz/KQJVJn9LV0Eaga/Bizujpkp8G/vZgbbk29XIe8RTMTI' +
                    'gjDG7v9knTM23Cmgg5TOTkNxqCWSjD9pCfkXW3gph+/9yNIhxwoJybfntl/rI+wAcdhhy3mPc2w' +
                    'THiOOTTRK0GWtVmt0GFk6NlvdEnyWRFmgqRtL2g0781TFiSW8UThmayvoLfx4gsqouFAXbGbGMw' +
                    '/w7w5NxorgT1INOGqPZFmpfvAAmu6qFtphLXZc/Pw/8kFSbwtri2DYYb2UpE9g3Ki26EPIJLjhy' +
                    'mqZGjVESQLHMHMHMI+8aR940i0MROvP6na8Pvfp+Qtq51AltRYU5Oesj1abf0OXLPLW7KErTja2' +
                    'amoAlZuf3JEq1G99pRkdmql+J1TsISE2slbBMO5F04ex0mQPZAYlqiQLV3A3ApfbfJitExE7q7L' +
                    'Bd+0HQ3M/c67s7vZkjGgXyqO22lWQLLSXsGA9KsRw0ogNqsdEPyLg9xoQusxawXSzXiRjEf/TnM' +
                    'TrGEgWClQMkcb18bsFyflCxOu7mCe6VSsbf85G2deoE4tWolwY4YKDt5VVsNxOLVhNTuoXHZYrO' +
                    'romvCforB8XFhVTI+6+xHORkI9l/Eo9ecMMfPg6FzTbLwbWP4OeCrW3f++Pg//v4tiOVaDpRr+l' +
                    'BJfQii+0bQ0n6s2ObDcuBieNPuiDCx+xh/+E/NYzV2bA4gxY7uYUFBTz3xWvr5yMo7z+Us3eWc8' +
                    '2eF83gt1ySZO2bnS5uTLtpe22+Y2AwedFi9dKf/bevJeBiTsn8lhxAqXzfvy1pthkcg3W23XQYK' +
                    'k/cpKnUx16Xk9XU5RjylvKoRSf3aV06QufCOeq8dZc7/zEI4+tPtuC5KOXjDpyZV/ORGVHTIr6x' +
                    'ztKD8I62Kut6nxwnux7XYPaWPEHZG0nWNwFgO39+MOa9PiYIlf3OiT/o7lO3d5zM/DncjDqUoUo' +
                    'Sa3DpX/0TN4dFgvguDSmrD7y7uc/gtdcjIgfSfZoq3FoIinw0KYXGJn5o5np6qi4bAVZghQZ9Ti' +
                    'uTXQr6q35HZMHgGeXUr9+H20btIP6kLPVtu8yv7TVxRZafjD5dL7fXiSw1/Y2XwKmEBpURLK0+C' +
                    'fHFGHyzJRsNxUVcrOtC3ZPeLp30Ue4ETGwS5ARm4yGSx78bf/uAbE0xv24UWtuYGsB6vNgXSPOc' +
                    'J6YnTvYpAdaAU3PrFqDVffJbOxKjvz+AcNdXcZA7LuabSce6CQthylMG+VDjV7kBkDwJZ0TgtmW' +
                    '3iyB92JjEEJuGqXDfExDzXUjubyEnu7RrOSRebVAL9HNpQXgEV884Pa8u7YB1fOtieVeHL/GvL0' +
                    'ncEF0OGuRVJw94LOLL7V7RndanZi6Q0tKiaeiUabixX963Mi5v5tsJdoBE1TdzGoUeVtxjZmgo/' +
                    '7bvWdcSjv0idIxgSPmCCzQJEx28p9en+DbNAPLArkFg7wN5RgV5x50WnbCqT91T4YLp/RkOWkbS' +
                    'Mya+9Qb+LSbJpKK/XQ7fpNuF61xY6C3Vsj2JufZD4Ym/8m5JH09SXutHabNh+wIYoV+eP1qtmp2' +
                    'XPz9P/GqZFS2i/c120+VKA/mvMkP51XFb4LWnHG8UzF4yoPYicHsHsHsavZ41ezxTLTJUD/G1P/' +
                    '/NbZijOVjlBT2lRIFPdyIYBTCJ8Dhx3kzmfUHl7WZ+pRrJoP6v5BBT/f4fwj+XK69j7c1eWTLg0' +
                    '5p07mhATVB77ym6BRBBHg/HjVt8bc8vTBuqd5GGxEImjwPqE0Q90uOeFL+NdPhCCzUF77aspIfZ' +
                    'X1TBFy+dbN4pgfO12GIR9VT+roWwN2yLpfKCw1ibCgq6j8Z8UR+RlWthMDys9L0GjEqbjGrZ2qG' +
                    'S/sFhbI0ude2WBiPil30yUIZ7RqyBhsn+XfumfsNt9LoQp1GjQ6p7fHFVUjnibNDxwkIC/2Hqb3' +
                    'mRaPZDFLBv2S1ZDSTqrvrjqOf8mgb3zmBUzF86MPzlZnzIhKlIHV8uZbQP9P5Pc0ka82fYS/rcD' +
                    'MxN9IDz7k5NGLHQ4xqySqvX3NZEqmZdNJG8kFj3C+JZGAtUE7sKX8XlwhHTQmX9TlzeGME3NWKA' +
                    'zZPWR+7tabElvYT217MZaNSdGxdpHvu2sdHCqzbRrgNiR3eWg0+4GP5RhzxIPv7ro1H/jrjXpPI' +
                    'LgU6mrIA9hLA5hpqNuzfiRAjVpydve1VT95dwDZ6KOhcNmd+ZFXB50jLwikfEol1LQHRGFX6t6W' +
                    'Pjf34wJr1FQep87gGIw8dnd3DrhJLQiYGP4j4jzy7nwIUB88ppGjE8eRAX+z6B4R77bSsMJOHJy' +
                    'ryBxNuZ7xirhQSPmDCk9FpjOxKRLfwR/3UgWlaC3WkLATtZ/TJXjU5ru9JfQjkd2rteyc9Z+b6/' +
                    '0vqE98D9vy5tWN+PFiIbiS6V80ddbzgqvgr+TN4NDXnIl9wi2fJzfXf0UCDsEuDLS84bMaSk3SB' +
                    'Y6yw7o5d7m14xODS/JKZWwpXMhcyka+dIzlWnpialY+u0TjxqywQrtNEGaruQo78/DnKb/oxKPU' +
                    'WYyIa16PBCuysGlJ3iBiAHcWwI7DEWiR2J7eHVruZpxtj6ZPVF8B9HYL985+1LliRQzEqLJ+fS3' +
                    'nPiN+kIBIDe0dxA8C4sntKrosuLfVXRCxOD1O1SWNqkKRH+rN7BqDkb1ofr+tY1qDrVnYgVrsQy' +
                    'Xi+7RIiTo3KE5QdYQC7PTHyAWNNiVpIIXKmJAIypfdPT2Spfrd4hhdxmCcyHySZhYYmP1C0Nfzv' +
                    'DSiLI6lkgMlvBHvpCfkVSZEHlm37ImeKYhvWNdBhZFiGgJt3PJjuDM7QOuo4TyYHcIqCk1PmY4c' +
                    '6yMdyogAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAOg4xlTIKXoIxEOiMN67ZTRLjmCL33JbM7QsxwC3L9OuP+A39TjrPUJ3pRdy' +
                    'cjmi/UjQGbcEmULbBgHXTDM1JjiXjJvAOdonvWC8ko5/XJWmxZb8PtzAbOQApKwHoxfMfSrB+tk' +
                    'ZRaAILGuJtyC6lhIGrxm3m0iR42l6fDpcxNwIa/30/GXewKIr1Vpv9KllQaLlWU4vqzpgzYHjTV' +
                    '3h+Ytq2ORrdZT0D32PocIqA8cxRNSsNz8/zn06khsyUVOyDf0ziSRAQOr0xNCkP9C+3EX4Wojtf' +
                    'jIjgukPhLbKsL4ffCC0z8ND4mnFy3U4XQEoecxAeERMbGqEF3seyAoktg98yZAOraX5gdI6QpAZ' +
                    '49tDZnllvOtaEE8KxCcWyEINxObW1GmVtuN8GouyJnDL3B4doMMNZe+8fkrQO0N4upXNxsy96C2' +
                    'vtrlDNvR5ozKCR2n0OlngWZArfyGv4c/XXQdjWb3xR48DJYWSbfxh6tDcfk710ij9zgAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAR8iv2+DtLkbxSCDn1rE9VJ56SKAHFblN7g6AtiRAdse1+' +
                    'HJiYewlMOgDtp+hkz8BzJ/ggr0Wy2TMVF+xU0WOwyTEXE+4D9nsbaZXmV6Efb1oh4IpaXnh7cZM' +
                    'QgIAkAOwrNAAEggNDItUvZk1SEVk+y0XB7+QQ1COZRvKbq6YsPSbHHUX1/fwiwFB7j2VKU7sqdD' +
                    '10gEuvL8d2texh4W8QJBMg2r46hRL+kbp5HuLM+jXRO/XzEP5BpbuvnGarC9tGc3QQpuL/TJyFE' +
                    'Uq3f34/wqfWPngxJOG52INh1MiW2jlxp/4Rlp6tHDjwgPviDG4GAqdXmTioWYUPKB3XzgMS/Rfe' +
                    'LrYSySDSU7D+GWkdoid9p6EQyBKUZnea/qSGeBELaugU5oFVmkWSo0jbdmNchIMUlHM33Y1mixZ' +
                    'ftbS0jdayiW6LgBs6wOLU51e291JXf5sYP7tXCOhtsqxrMg1DZwAAAAAAAAAAAAAAAAAAAAA3sb' +
                    '1pcjeKQQfE7NLVSeekigBxW5T3B0BbEiCZ0MmkgDVh7CUw6APafoZM/AcU4VglhK+XZMcsM0WOw' +
                    'yIvNQ4jWv7WZVS3gtz1LFiF5M2BHX7gZIggQAFcdwOseUPBRE+cDYludbeCXYD60OWb2dUBBSJT' +
                    'JDAdDqyP8D0EOy6UhoyCdLqnQWemJXVN8j9sBffPoOrVUBfi//tjvz9Oso4sx6n2/nWqZ5OYvDJ' +
                    'kEPRf/G3d5Db7rorororom8rbw+QHaYVtxz73MqHcy6Y+NUHdPrNsnXc//VbSRYPrYA4o+iAyrj' +
                    'eQyJ14t9quy/rzruwDPXt2fYHgoINv2dlq8SOX4ay1dKO6feTwcD5jSWzPWO/j95eZ8lffJoYqs' +
                    'inFKMRcOJOIiggG5v3N3iB1MVBt9Rn2ZZAfUiLRM9DWq6eWTE/qx2XT9MN2GDXKW7R3CRsNI1HI' +
                    'U4Xs1kc5FSRu/qAJi9hOU0oayzFcX3JYiQ/PD5WnpUjIbklTWFTXFwFGveu8kASj2BV0eFMGUZ/' +
                    'nmMS1plfnBdhYEtYqvanZvE67B9u+eeHJy0Ksvsz9iSbH7nR71jp5gEyBSXOZcGADEmxIA4Yq6z' +
                    'mVlIMsSV/EVIr/nRYZGX8esUFffuphhHkyHlmE0r/iIvUcKI0Q9OwmFygUVI9bPll341byY1grh' +
                    'sAfFe4oGYx9yqGGTtErPMoQYeuRH1eXGWeIUu+LPWHcMfdG4cc7xs/WQlUuy4BkFKDfIBxtIzYU' +
                    'IghF0JwW75ZBo486hlQ5FhoUcQMvHRpvKf/c1M81dZZm3kWDCsTlZ18+Gpm+kAx1nTpHSdWb8mR' +
                    'uTYlICFi06rA9kSsfrRpCMCTQMa9/P4x8CdRaEgcFTVIwiUKf0F9P0zn4yz80cjTuNNoGzBpOxF' +
                    'xF4Ix5wRjPmpTYt+l8l3Dzcp27x6uqjJYQqecapVugeTlXric9CI0zMuMHvEM4yC8dzZwfsj+M7' +
                    'cPvVOaRyXy4cylezI/j6T0hQGsOJsb94hvho+c27C8fHAJO/S3DwdqN9XDayGLxIGtFetNrOvsS' +
                    'I7AtqbRAs+h4bHMPwEotonZQz0HKD59pfmpuElBhshIWoMlguf0D6ocyXwsG5cSfrNsHvkSV4Y+' +
                    '2BzfqemJfxcT/BI8w23GkHI64U1Y3staeEL3cqRvrE6Q6PgOcpmH8Dq4XnApnzyAEuJHX9ch+jH' +
                    'UqlZQOCvdRIlu7355QGyoMXxgsq4ZN2wAJvcAu1d8YU6B25ur293Mp1pZkPXP9D276QTjPRv+L/' +
                    'cTilSHG85RtXhNod+x5kNANSFHC+ZNrM9UTDY56JvpuMwrnIhzIIWOwWROmXlD4enUYfwb4Phkc' +
                    '/gkOI123vHU3h5L/jVJpOjsWSqEP96pboX8t4q7PWFKcf0xLxR6ehZMsTV+6aJDiy0PIGdBD1pT' +
                    'ufN77pLd2jsbLA0YVjQVJVktH6q+BJv9+J6eb/rS43qnSKzFN3g/dAxcRjh/qzYirNalqlpeqNq' +
                    'uG0EfBNhq+fa1+Pytoy4fAsLkxm0WduJAlMYVwL/ngcn8g/4M0SkNYI12nDONiC7wZPMk68MGMd' +
                    'VRYirMz+ROZJk/CUq1eZXxmmYlwO4rkLMsVwmtEH33MVCxOH1QbvB6W0v3zdoNKTPECcPURFeDn' +
                    'T9f45/NHFaPU/l+xv6w3Zic1t7VzIJU0E8S9Y3nNxDMQq7818i1MBY35IRbxwEWrBr3qEW6jOrO' +
                    'cz1duj33O91Z1aqaKkqbb+zpnguGua0ZyFZVX9FOkKIvpJKzGPyzie/96tFTWO0LnhXGjTN8icv' +
                    'Cxpb6g49SCzkS9LZgZkZDRO9rnMuerEph2vYMNU3s08EvwhHLfoFG7XqmOIWftkwgjR/B9CVn9W' +
                    '3BMUugDp4dl8tL+H5sVaRH+8uN9daD1DCD3OKT86pa32yPuR+MKALl+hA++0hbrZQRvvd+Dg8oY' +
                    'G0QLPnxUcLqy36U0+ozzC7ktilN4vIUNM5c/PxB8+NnYiUHPrw56U9A+Rea1RkOM4M/ZSlG9zPd' +
                    'H3f7Zkotzmh1nHL1nSn6n6n6/XRF+uiLu1mBPh9zR64s3WU3R0QMICLTWCBPrnOhNYDsm1q/TNx' +
                    '2ARIE4Rfq3HpAEPy0D0/+JpOOzXjbBpRxFen659Jb9fY8SPoePfD+4z8OgIrGdI+KlRo+pNUpeP' +
                    'jiAP19RDSXSz7lJckG3F7YtVeZnJBnbcG/w++ALEVdrDGsaC3Uj+p+UcVnBz95jCyXWNfkRb7fC' +
                    'Hv23z9feCgearOAgofUcWNvUbwYyLNdmCdTo3tYfUcIDrMilcst76v39puQb9+Z9XMAwoYowOfp' +
                    'o5OThaVBooWJjIWf1xyF4zeSZ9P93UgrhRzXr8KHmJvr+OT3sUcyTK75jC5IraNKSIk9o3bf0Cm' +
                    '9a2GMUlM7u8Un4gDlVrYNRurP+zRBSa+PD49g3mFg4Qm63t0W7wz1nkPuJcB2Zq1F8MFXdScLFh' +
                    'FNfGVCsSidFnO9x46hbtxVGefU/XAMxtv/OOT5TmYBCe4ehSjm5bCwuCPGC5xJg2DqfFySqv7GA' +
                    '6DCDNsSqbahWKsiTaQtMHSQS3p3uH0cQBG6/D4g9SD33Zb1dLM4494RA6tlOX6DKd1r/DFTpGT8' +
                    'ICjolrQPan3gO9v3YlpCAeAdd1DBV/amHem2pBOdeeGDu/34vpr1VsPnCDz+bjl4rF1isZz2/eD' +
                    '/E18V8UVHk045/4IQEAOsC7D6M/Cv7OUYQ2Fm7dvtgSDFTBTgfVjsm7vn3PlriAb2VaI9fjahOB' +
                    'zd8NRyShEcq5sDhs0oP36wJY4YK3AatvcjhUWIk/jupri1Ny14cuPUTSYM4bYLTn9D2G0WJsDaV' +
                    'cRpxuQxS79YqMnt92UrOj77e4CyYGd1rqHujVDTxU49tJSDfmuIEfT+P1gbsi76tfuJENReIKfY' +
                    'vZ6YnNbfHrCCVNAvgfDQZ1sAzGyu/OvANETPUx+0cKAWJBWfVgYP3ntiY7OGHQtAtObFm17hwNQ' +
                    'kg6KY7OoJzgf5QDkVPHXUtbs5H3z36epb50xyjgMz79iGcagboYmqVCxXvwTgvLiG8iLiFWkAEe' +
                    'JY/ubftWdOdy6q552gM8xlbp31OJXzzGF3MXFA68yrOwpNSklyfVua/qUFn2QvSI+tKs9jSMFYC' +
                    'ZA+B4PitYMKHCL8C64whjryisjadbP/djyZh88mE5Qc5Gb7v614A+oVAjb7us6d9zE4ra9d9UYh' +
                    '8oNxiyR78AHC9t7h/ayh2kdnTIArLUKKmX9INZKkonJc/P4/8kFSbHftKJc0Ir5q0l+tfkMA9GH' +
                    'wBsnyFHOfWqyAaFnZXUpIpIpIuL15cXryyb31xUf4bFP4LQ2m7Dy/spoUr0TpTMmD9VL8ABaG80' +
                    'LmeOiq+6mTSxbkkXw+nvC7groIpAUAlvmQ0m8uaqNsrsnOEXKr8x85AkSkkZ3NG0dzEri3wF52q' +
                    'chuk5pk3H1oyOAgzDTZRsVNwrNsh+OoLQEaNTrTKORfApm8nR1lhGTUYcw5PVwdycgx9qLWjIYV' +
                    '5qq/Y24gVopYOMbYnlcY3F8FCHncEvFc3FBrUASqUBp0A/iqOwmnyfmh3Qk+DwUzhBYv6Rs5zxD' +
                    'hPdQzh7CDcUX5tmV1pr5436lAYQjrIUQmFPPEcRED41uwVeXdGLFlt4YnPboIu67E1IWkQ9BJTy' +
                    '1E6LE7SNxWKHEmTFMevWA0r6FnOqLdDiT45BbTx66MRHybKFcU8RF7pfZq6o2xDIL92UWTpPaR4' +
                    'gvbVSdP2icnsqR3aHpFDGwlg9hbN+Ovi2ronwS3CT6IQKlvsi25q7fkZvU8Md762AStcOYJgAAh' +
                    'JfsJEHOuVSUL1pj2OCl6vYZVH2PH1uVi1pL6Z6AJrIPUyfd+6SvWkfkc5nCdHfq8FBLDaPR6IkA' +
                    '99HwlRXMttDSBQ+t0a18ONA7cPH4wdE5NBAj4i+gNpCqE2/34wZr0+Dh4w6HjyHWFb/0cZ0+M62' +
                    'tNototooNKvz9JQTX1QxtrfMBrUnQ13Xx5MybaxCMzJPUWVOa3kAYjPyy2bmpqk+snP1M+EbJ2g' +
                    '5vHtTmj5/sSzH+5qkqNvGx3qefDMv6Mm/9bCG6sJGLopfb3BjagssXZunO9JQvBrb19nCJI7kIs' +
                    'pYGAWUxSOSRcYyCxwUgnEFlu8RfZP/A4rrlAJMrENekGDJY8ZDipb/9wDYmmN+8nL2VUmv4jgYF' +
                    '5HanIup6YnTkaHQsUu7BRDuC9WEIh/36u/P4Aw11dxRyavm2nTdrvNea4SKMYVlN824WUjhm6Sz' +
                    'XUcMeJG17dHuaHP2SShejuO455p0wJtt8lyuezE6V797DKgq/hzFmhkXQQ6shzha7IOYdXZQkAo' +
                    '/K3KuUZtaUoWEtRymcdmJpL2RBWhyw943OiqWz8sbc4NHrajWbaUk+gZrnDCHMfgS77zPGPeL0/' +
                    'rPZl9UtcNFhBE41Cl6tXcJl3Wh0yiAK8K8vS4+LLSMnovqeqBkpjzXeGttZSA7ihtq7tdIP0+ED' +
                    'MGO0jEOqPqFLscM2fwWzH1UnaTxv+F7e17MdsFLgotkLyIWcb/moPdw+N0K/TjDm7iHW1uJjKcl' +
                    'z8/T/xocbHvQkdXhD0XZkAS5NZaQut5IubpLKgQPS4pdSUfKPg5g5g5pVvHSreOgGLgfAfmq7+c' +
                    '+bhXZjapav2Z1cFXw807KpHNso2vvf045bDInmvDQhY6UVv0KvEs8w1Ktj2l9L3f5XlRQUrDKLh' +
                    'juTpVxjzL9aUtZsk0OVXZFHiT1avjWDLtruPtGpvcRE1Q/ZzlyJo6rHTxSbr/M1sLIf9ZAl1AeF' +
                    'EdhtN/IjBSyjl3dPvYhAULHPN976yrd5lZsH5ziwOHIKzaIKz2wprqJ0ZG2gbliUYrMY1idPGR1' +
                    '193kna7JtIht4XZ+2eXe31hef3k6/V1A6SD77lp7ZSxDjvLPCZSSmoyQUd9nJkVRxldrGqh8Jtf' +
                    'tuW7nbDi7tQAjsgpjPoILBoLzaqaMcSENv+iKANx5d8pHugcJ+HYlMp0NHLinHrzIHYV9gt56CB' +
                    'euSO6n68OSMMEpvzJGodzaqTm/kCzA25CvupW7mbPHf571a91v3gCGYnFcZro7cHnFtqMx7wXaz' +
                    'YX8zlOjSmINce1kly5C/MavsfjXTvvZvOAe42MZxAo9FlhFHe3VrvxL0MST0AX3VVy4bs/r9pPB' +
                    'DrcHaN/qG+BhjWC+aGcHZCDshjzLnnlziG6vX3Boutcqyz4ZHUHw1zp2v1x6L2RsP5R3VeqTPn1' +
                    'Bv9+L+a9RUHqZxf8SQF89zVTC/p5oluzCzCn87Din29nGexrMfJCRm/0YQClUsAM22a2NBlhvxD' +
                    'G85jin5Cj+U1PY2LJEgs4sqc5PK19l9sXLzVYSY0i2/Oap0sNtAf1njQv9mpZKev5DivBuyqRDC' +
                    'eIIBzUYI0yKjw3gFv/P+p/qh4KYLPok+5ZokQniNXyqWIIVFHxp7poyfa/oephcMbwMXNd+PEY4' +
                    'bUOqqOeP2cYnBpfkm8vGyglr3pk7edIznSnpicHZASelkGYJDqKMVRShLMPq789MNdXARih6sat' +
                    'MeCbZgiFga7m+zoeBdQ9Q9+R95Xhkh2ygPgngWjQNtfxLEtpD4q0+fz8VtW9pNHnIGOEyc6Tx20' +
                    '7YLHV/eM47smqog9ukwBewJ7g1/ONiiQF/qPibaZpxBQatwNt+lgz/DJs5F2GML4KGQltd6wT3M' +
                    'jAFw3T5LninQQ+f/3mYUYlyd2PkIJi8LToBge4tDJoq5pPXZqekHt66C0UWxIq/BR2dHj6OjzFR' +
                    'R+EKj04zLLqFsSHNjvbD7L2037mcqvAV9Qw8bnLPednd6AQqxWji4R47qfvpu/aA+6ln8UQBtuy' +
                    'z7UZBKJQaUtNlz8/D/yRZ+Cc7g1JvDa9kZGfKg0fxRzRiQRYHuNdJDQai8AXf0P0P0QjOiBGdEB' +
                    'SPlk037mDS4skeregn9tYpnZBDsIe1nsOO6XInddHHiSbA23m6m5vzlKV/lxx6K682fG1gOPK3t' +
                    'ca7CMJVtR9gnN35xzkG5adAFMbNP/vJyzx/sC5woau1LqrZ0uNqAji/kCmnRxeQ/mSRDci5wtkB' +
                    '/dRxAITpIlmaRjjWfYKAhQ9UBCxBv2UWNqdu7AznYIHWRNHz0tdDhp5jjXr3cWaLArGa+SRnaWd' +
                    'kFTLI9fjxt4/5aL40fqS+kOijV96ooHWwhrMJVOV3yPb564YsV/C+Vzn3CYzAKEeyWS2tihIV1M' +
                    'S+FEAKniiTsxar5neoBI3X3HEIzmJA/GwPUEN0j/cqxyX9IhoctIdJcxyD2inK2LGTsuerNYD61' +
                    'PhJHNIdoNkhq1CwVs6cN67NGpBfKb+nHu5cSmQS3kt4Z9WA8JOuPM7Qjc8quK+cbME44cUiOEf9' +
                    'El7ORwEZwJ2BzWId1+RT3LzXUoM9FrnzRyI8igxxZ9EDFTCGM1EIsA4CXa9B2YRqhaW+UazqlFP' +
                    'j5C3MrbWWRwXjJg6/hSGgbzq3Tut26Qn3MCZAIu0necFangH2GHhQM61ffYm70CjVE+mGiONbxH' +
                    'N3n5fPnpP193e/34wZr03mzdg8eBZKQP1+aVruPuIgKIXtXtXsK7r9M6HQ+Wg19EVJZvQ7JDn27' +
                    'fghTU9kVe05RbNUBP2GGQpIKZS9NUHrcSA39Jn/xkqpePXv2WFCSfOfQxSuDgp1TEsy3mezmX/m' +
                    'UsL7zUunKe/4wxnnky8tY+0axlsVP4zrTPeh/gAG+ClhsuX0JldT0UrtTDZRcixL1LieI5Mnw/9' +
                    'eW3Q8yWlbSmPfWrFi77VkTsKTnmvbjZDEZWNnsnSXDUG2QHI56YnB2QEnpZBmCTfubvv7Ib/+yu' +
                    '/P0Aw8GnpxjcxFigSbkDHlPwbPYzK3+ixIhc5I5Lhlu1+gCFtQq+O0cY+DN1gnv1ttCfwXBoXZV' +
                    '1JWGpYTrE1LH56e8kOdUj6H9qbs+tpjNC8qCmpEPcSx5F48E1C73PuxFBxzp8TI3XjIDzrOv5BQ' +
                    'rxdZTwtEXX4r9X/bdJMiQ1bw/yMX93Lw9qlNDDr4dVOBa1ESyNYQ4JFBk1LDGXCnHm86Q+fS7dn' +
                    '/aJ7CTMNgdsIr4nqvkdaZQ1CEU7m6iFFDeO4G0fwgeSU2qDWIw8OpFaj08Iobi+TTbaedRucx3W' +
                    'tGH+l+H7Vij+6NOnmUWwry7fSa5nf2L/xVLVEem+XPz+PvJFn2d57XbM40YdCrz2n+MHPQOaBWm' +
                    'fQDqytWRtdmn+n+n+1nktrPJbN+O9SDfriQWRJOjx3zNvbJAZ6/375taRcfoDRlA1XDr8hJuhYJ' +
                    'yGCJLAQcK5tu6/Mq9JOu4WUlwF2ZXAxf9R1Y18rmrcYGz7MWVESA1zlzDNWRvVJeuCDuE5sw59c' +
                    'piV2eMXp9EZrYaOYAQbKu+lXWp1ejYhy8c24E1l4r8le8Ey4WfMlNQSSXowDMDrzozKK2pFbTws' +
                    'iNLYstmTZYTnyD7uJkNwAF1iMQkA7nKkvEheyWyWuiCQQ3DUeE++MLY7KiCIkhW9zePLkqj8yjB' +
                    'dU0BWyKFvRMQGvwzbV12mGsgA63N1JDXmAqayLRMK7IsHHS6YtDZ6QY1hURhn/Mrp4FjvzaMD0a' +
                    'EZUGWTv0+vRChpdInFfP78PuI5HvMWeBDQCN2ATF74yBKQQRfi73NwuzwUFVcu/vuKnjP9mzv75' +
                    'KFEWWHCts6hIYFaxRipKFF9NwaiuIcvPOvUCA6r0I12oJ2LEaVRInlN0b8R7mWJeaO81HR0yzCY' +
                    'SQu44E6UtI6YAzMWLBOFt+8Ktoq5eHrQ1fgMPHeCKstnN7N3h7FDBjTlv8QCDoMR44ysiMPJOJS' +
                    'JTQX147xydt+25DzZSjlR03Y1lsoWc6YX7xoU2/34v5xMwOevzbpODWzLBT9ISgQBRncfcfccMj' +
                    'ZDeJbUbJMMeg93jhlRS+Sudy98TVmPwrt2PWE/cuNELkUgDQkpP4CeqF3IhFPXwEiF2aYTfb3HI' +
                    'Z3aN1PMdM+ZHpILEX/iz+oHWCQC2d5OHb4W15ZDOSpCtTWNwtnizVxFmUh4O9bfIkskiwK4svDs' +
                    '3zVDYVjEL66bBb70+9VnGAIT/k6xHT02F9k53iVkkUaxUMGChIfg9BtZbsVcc1kp0n0sUpuemJw' +
                    'dkBJ6WQZgk2mrCxfDS//Xrvz1wDQLccVd6FMz5ndlsxS844Hglc8iWValayHmYt8KzHGXsmbwwp' +
                    'K3qtEcEdsLPEGicPpGlaJAfR6lAtJ1uU7nzeu2N8NjR64hft+eEvnkZHvJ18gZQgkUkXJSORQbh' +
                    '1+293BQcCpCdttQ6592hf6faWZYTdTlxoaCs4islSh5Qe+e0Tv8myeu+zmmHfSVCbbHs1ofUlM7' +
                    'R7vnUQuwWYHG0xnp4X0EB0yJyor34/9pG09WKqqL7s2oTMOp1JHpmqi0GdD8GOatldsn8Z7cgiP' +
                    '0tosaPRRXpQtni3b1n84eeNLQl12ZTEEwlYY/Zfe0GSZtQhStNlz8/D/yRdbWNWjOihY1TbZwoT' +
                    '1EMQut5HZMcqE2+8GGnLUqxVU1U1U1cfwq4/hVoaoIKv/SAq5jyZCVeaKd1GoI7A18GZu6EL+Tf' +
                    'pbsXPC7LY1htYu9Th2l1igUDzNN+f+rT0wEGvoJaG2NQaXjYVedRvjYc9ukL8hAx1vIEkJFd66P' +
                    'EzENybFIIdP+X5bMjVAxgmqVuwO03UdasIRReWd1v9MFIUddfztOxlbsI/Pklzi5u7TvGJdnENV' +
                    'KWx9yvJqQv8e7Jrs98nP0VH1vQORJ1s8yA9stEj1JeDcuJZ4dx0TR1/ZYuByaSbRDzRp5UK+C9Q' +
                    'v8QxWxs3GuCEIQItIC2rLy+IqU1GJKXXE2LGOkKFBvMeF9Qjr75/rBZMr/Xz7XFQzVReDOKpcaw' +
                    'v72+lCuGlbd/YjpkszHWyn6Pdgwg+sBEzblda2xUhHkJnLAkC9IfjBmPCmUD2XdGp3ZbnJMUN8s' +
                    'cfh811p+nrjgQ8HzdOjp3iglT1seMnjFSkr71v2cIVFZEXwy9hWf2cIUjREZQZtW97kgia0Cuwu' +
                    'LiQv29G1rWWGnpve1d0w1Dh8T/wiCnAyUULZRoGfEQaQmt+/Q0Wq84gt4gdl+S/2ODGN4eMmf1W' +
                    'EFIMnf9ECp/d1BNLT96Uhr9kY4CjXHCjn/9/XxVw0p0DG6suKJ2/34v5r05xB/KUGht+3Wy/19S' +
                    'vXh2G+WOWOMqLSu34eIjUrv5Dm8YRYWF9W98eCLGUlURBhN32Uq1SSEpg6jknCGudBcY0n8jrZm' +
                    'cYDqJtbs+0Oou/5XD5Gf/3cUaVFo2d9XAVoNgEXiWLNsH5m4oijyOLDFea7d5/BfmcJoxcCEFwB' +
                    'ZDwK/mC/duQTtXdhPKdBbD1eojfR3LwFBP8g+DnpP9lGVTvCVY+S3bO+TP9nl5uF8J6945DqRsU' +
                    'icda3SRs+emJzW3zARXbf0jYglOzSEzf/2rvz/NX1WAAvc88LPKqbM8eROtDitFQFn/GKuJArFZ' +
                    'XAEz2TjTMv6dmYPAbsUb0pgPCLZOWLnp0sQbf14KgZNQhHkz7O+Wcu4SCx5IlP3vK9TGedi1/AJ' +
                    'mP8cCWT2B/NikPtoc0X7YB7usJDeWvcxxBbwu8ibLhVArKwh+zOZkj+ENnslUu11x+P4MIY9OzF' +
                    '9r/hanimq971lCesDdhjg24vXXb/Z6O1aflou+344Gvg8sfPThFo3fHf254ymbyEOkAihHom1zk' +
                    'WyzN1HXitRKB1qASPls3tnRoCEluqH4gGHnqfeMxBurUWYx8LrmOejfGTzn4pswg4gAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/YNayaoKgvDHN8wGTf+/edk/vOyFk' +
                    'i4oRaCwvqSopm5I0zckCwQaVYkbou1nbfysdcKpKSbOe0BNJ4QE2RgrGhxIt16Qufb54iGdXZ1Y' +
                    'C44LG1b4cwouras8bzX+LFrTDg53nEEdEc1R0o3DJtpk+taVB0Jzl6LPUggTrogWCPMKc6nEujs' +
                    'ipxbPf0CEb1TAYvAFCfU45oUrRohexOsX9rfmpr1Nkrij9Z9u6b9x9w7Q6EX2x/Pw2fWKQW2Git' +
                    'knapNNMFgMKjtrjvCMqn5+Uq5lR4AMTC18sI8AzrFUuw93VuwDR066NU1gYrtw3Twzkp7gKifl0' +
                    'cZfNw0l/xc0DfUANDe8nw6w9EVX2a3pfx5A+0rG5mNz8LOPqMebD5T5NCigaSeKLFfREw1SJDG2' +
                    'dd61aYJk2WfR3dbtunKxWmQfJQvm/lBs2R5qPB/4XZuW12HsmygR9TaICzATKMG17VnKyIgMLnJ' +
                    'vm7NKAkB8DoJ5QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEhEzDGI4KgwzHN9xDPp1/vOyf3nZCy' +
                    'RF0arhYlNmAKiIs9REWZTGp07c+VlGKQ2QGxTGp0Caa02QGw2QGxwz7qKO64frnbrQx+tfrnQn6' +
                    'kPu9Nz47yl9/bz8jO4ltAC2ErJioHFAHdutCbLtVf1Nvbvk1LpPnWCbvKzic2zHFwDhhhE0xI5c' +
                    '36+BfKCxFdRuLODayt2rgfUAPt2GHnwWAcAOxCaPzlo0zkAoSImuJroSI/r79+/f2C/ixk8eIfy' +
                    'hwnqQFDmYczqwkF+P4In8LsBysgRI75d2Nl4KC6AJXjlCO0/m0KMfL0wxG+839J6o7616zNJjro' +
                    'm6N2+qXYI+6ZAnQSBdNCqDLPiNEe5/tNj8a8HSQzem0xI8ilC4FvFzMM0+75CzHLbtgxJVscQqX' +
                    'rkp5bBxMUCgF153tAFTMCC4mBA0+ura7w1oosBxwwDv7ItNLmgAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAtzBIKgwjHN9pXObX/edk/vOyDPfswizTTth41REWaoiLPOzi7PUhQLZc4H6HnKRgqxZp4BU' +
                    'kx7M3CFXIAzXkzypQrOWFffKp39BvMff18cTjg+yMV+OMyG6IF4RHWi3h0xFcoVKfxODe9qRPW9' +
                    'VjXdPsTU+8ytmNd1z0mHiwHQXZib086ezgo7DBwMBxNyK8rMXU4=',
            ),
    },
    {
        name: 'hybrid-swb-voip-20ms-webm',
        container: 'webm',
        copyOf: 'hybrid-swb-voip-20ms.opus',
        decoder: 'libopus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 28800,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AGCNPgCkkT4AYJU+AJSYPgBAmz4AZJ0+AAifPgAooD4AzKA+AOigPgCIoD4AvJ8+AIiePgD8nD4' +
                    'AJJs+AASZPgC0lj4ARJQ+ANCRPgBYjz4A6Iw+AGiKPgDIhz4ADIU+AEyCPgBQfz4AoHo+AKB2Pg' +
                    'BAcz4AaHA+AOhtPgDAaz4AGGo+ADBpPgAwaT4ACGo+AJBrPgCYbT4AGHA+ABhzPgDgdj4AmHs+A' +
                    'JSAPgCsgz4A6IY+AByKPgBMjT4AjJA+AOSTPgBklz4AAJs+AKSePgBIoj4A4KU+AFCpPgCIrD4A' +
                    'aK8+ANyxPgD0sz4AvLU+ADi3PgBYuD4AFLk+AEi5PgD0uD4AHLg+AMy2PgAAtT4AtLI+AMivPgA' +
                    '8rD4ADKg+ADijPgC8nT4ArJc+AAyRPgD0iT4AgII+AGh1PgAgZT4ACFQ+ABBCPgBgLz4AMBw+AJ' +
                    'AIPgAQ6T0AMMA9AJCWPQDAWD0AoAQ9AIBFPAAAArwAwOK8AKBBvQCAiL0AcK+9AEDVvQCw+b0AS' +
                    'A6+APgevgDgLr4A8D2+ABhMvgAwWb4AQGW+ADhwvgAger4AdIG+AEiFvgCQiL4AWIu+AKSNvgB8' +
                    'j74A1JC+ALCRvgAQkr4ABJK+AJSRvgDQkL4AxI++AHiOvgDojL4AMIu+AFSJvgBoh74AdIW+AHC' +
                    'DvgBcgb4AgH6+AEh6vgBAdr4AoHK+AHBvvgC4bL4AYGq+AFhovgCgZr4AiGW+AEBlvgDwZb4AoG' +
                    'e+ABhqvgAQbb4AYHC+APhzvgAAeL4AwHy+ACyBvgBchL4A3Ie+AHyLvgAkj74AzJK+AHiWvgBIm' +
                    'r4ATJ6+AHyivgDIpr4ABKu+AAivvgDEsr4AMLa+AEy5vgAgvL4AqL6+ANDAvgCQwr4A1MO+AJzE' +
                    'vgDsxL4A0MS+AEDEvgA4w74AoMG+AGi/vgCIvL4ABLm+ANi0vgAMsL4AqKq+AKSkvgAAnr4AzJa' +
                    '+AByPvgAIh74AYH2+ABhsvgAgWr4AcEe+APgzvgDgH74AWAu+ACDtvQBQw70AcJm9ACBfvQBgC7' +
                    '0AgGG8AADKOwAA0zwAADg9AHCCPQDgpz0AEMw9ALDuPQDQBz4AYBc+AAgmPgDAMz4AeEA+ABBMP' +
                    'gCYVj4AEGA+AIBoPgDwbz4AaHY+ANh7PgAggD4A2IE+ABCDPgDMgz4AGIQ+APyDPgB8gz4AuII+' +
                    'AMCBPgCcgD4AqH4+AMB7PgB4eD4A6HQ+ABhxPgBIbT4AoGk+ADhmPgD4Yj4A8F8+ABhdPgB4Wj4' +
                    'AWFg+AOBWPgAoVj4AKFY+AMBWPgDQVz4AYFk+AIhbPgB4Xj4AUGI+APhmPgA4bD4A8HE+ACh4Pg' +
                    'AYfz4AcIM+ALCHPgAgjD4AlJA+APyUPgBkmT4A9J0+ALSiPgCApz4AMKw+AJiwPgC8tD4AsLg+A' +
                    'Iy8PgA4wD4AjMM+AFzGPgCkyD4AiMo+ABjMPgBczT4ANM4+AHTOPgAIzj4A9Mw+AEjLPgAEyT4A' +
                    'LMY+AKjCPgCEvj4A1Lk+AKC0PgDsrj4AuKg+APShPgCsmj4A6JI+ALiKPgAYgj4AMHI+AHBfPgA' +
                    'YTD4AcDg+AJAkPgCAED4AYPg9AFDPPQDwpT0AAHo9AIApPQCAtDwAAEY7AECBvAAgDL0AIFW9AD' +
                    'CNvQDgrb0AkMy9AODpvQAAA74AYBC+AOAcvgBYKL4AoDK+ANg7vgAIRL4AUEu+AKhRvgAQV74Ae' +
                    'Fu+APBevgBoYb4AGGO+AABkvgBIZL4AAGS+ADhjvgAQYr4AmGC+AMBevgB4XL4AyFm+ANBWvgC4' +
                    'U74AyFC+ADBOvgAATL4AOEq+ALBIvgBwR74AeEa+AMhFvgCARb4AwEW+AKBGvgBASL4AwEq+ABB' +
                    'OvgAIUr4AkFa+ALBbvgB4Yb4AGGi+AKBvvgDgd74AUIC+AMSEvgBQib4ABI6+AOiSvgAImL4AUJ' +
                    '2+AJSivgDEp74A2Ky+ANSxvgDAtr4AkLu+ACjAvgBwxL4AWMi+ANDLvgDczr4AkNG+ANzTvgC81' +
                    'b4AJNe+AAjYvgBc2L4AHNi+AEDXvgC81b4AkNO+ALzQvgBQzb4AXMm+ANjEvgDAv74ABLq+AKiz' +
                    'vgC8rL4AaKW+AMSdvgDUlb4AjI2+ANyEvgCQd74A0GS+AJhRvgAQPr4AUCq+AEgWvgAIAr4AoNu' +
                    '9AHCzvQCwi70AQEm9AED4vACAQbwAAM07AMDCPACgJj0A4Gg9AOCTPQDAsT0AwM09ANDnPQDw/z' +
                    '0A+Ao+APgUPgAAHj4ACCY+ABgtPgAwMz4ASDg+AHA8PgCoPz4ACEI+AJBDPgBgRD4AoEQ+AHhEP' +
                    'gAIRD4ASEM+AChCPgCQQD4AeD4+AAA8PgBgOT4A8DY+AOA0PgBAMz4AADI+AAAxPgA4MD4AqC8+' +
                    'AHAvPgCwLz4AkDA+ACAyPgCAND4AwDc+AMg7PgCAQD4AyEU+AIhLPgDIUT4AsFg+AHBgPgAIaT4' +
                    'AcHI+AGB8PgBUgz4AmIg+AASOPgCokz4AeJk+AGSfPgBIpT4A/Ko+AHSwPgDAtT4A9Lo+ABTAPg' +
                    'AAxT4AoMk+',
            ),
        bytes: () =>
            base64Bytes(
                'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAyqEU2bdLpNu4t' +
                    'Tq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggFCTbuMU6uEHFO7a1OsggyU7A' +
                    'EAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1M' +
                    'YXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECDAAAAAAAAFlSua+WuAQAAAAAAAFzXgQF' +
                    'zxYjJXUDfTqS8r5yBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQO' +
                    'dwAAAAAABiZIEgY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2f9c3OgY8CAZ8iaRaOHRU5DT0RFU' +
                    'kSHjUxhdmY2MC4xNi4xMDBzc9djwItjxYjJXUDfTqS8r2fIokWjh0VOQ09ERVJEh5VMYXZjNjAu' +
                    'MzEuMTAyIGxpYm9wdXNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjYwODAwMDAwMAAfQ7Z1Ssr' +
                    'ngQCj14EAAIBohHpuRbRaErFwdZQMMaJJ64UnASaYmCApMeyBvYOr3ooqBC7TLOdyXsSQRrElQT' +
                    'vdNzCzwMCQ89i4n7xI4N5OAgDRH5lvINpYEWm89OD5c1QG3qPXgQAVgGiozBa0oQsuFBuF+/fJD' +
                    'mfLpUDplUJ0EynLpoDrUXWK+6ufKDM+USor6BZJrIhCvdgefhthBB2srB5fz1UccFhaurWjRAg/' +
                    '0Hlb/UalyuXL5H69o9yBACmAaJ6xWXEios8ZDObLablvpL1CS3ozQIRV3+r8btCyE+yvmCtglL8' +
                    'uWt1DsxCxaHmeT2zxSASWbmsjJGxCeQ5pQ6McdBlYYBxA/8mwjGzJ5++t8R19AU2lQ6PegQA9gG' +
                    'iesVl431LZe2yzqlKkzcQBqTr/YmIV5f7iniv1rhOp+yFF6jMNbcqKqMyHhYJAG0WUk+oQKXIHg' +
                    'XS7O6hp3XiYSTeGLixX1A55ZM6PVx05An+TilVIVQTIhaPXgQBRgGif+bl431LZf8NmgfOktjDr' +
                    '8TjQkd4BWWqOCSmDvsQ+adEz+aAe97rBQzltWFCvfLlje7VNmANLlukEWG9zFldWe48YzVqCPlv' +
                    'AePPgLg94hvrDo82BAGWAaJ/5mosTjUOHmz1X47GOLmvxbC125uF2Q+1cGNOAnGgRfHc2o1P6kG' +
                    'L4enY0fhrferQnr00ZYlq6y/z5Si0OJKhT0o9pztCGdaPUgQB5gGif+bl4334GfBZRAsHUypDXS' +
                    'iBUxgFSDWnxTElN48tsRnV12R4bjtUyphltWg000fisv2enJZ7e1Cztfj4jPDnenxI/BqWB35/Z' +
                    'KHOg7SE7o9mBAI2AaJ/5uXjfUtNgBxiLbclvHZCpwpDhMEGdqoyEpN3vhhFNKOWyhae++LXfK2l' +
                    'cd8EfFbYogx4QzH7hvOMB+YDLtkYslgx9+hpZ0ObBJ3hsp64WT4LLQ6PYgQChgGif+bl431Ur2Y' +
                    'xO8c4hi8ggdGU3X8d6idn25Ht2wRflMqwX9ApLkL7uxdG1t42xBzMOZTShQ4Wta8qItFL3mn01t' +
                    'D02c3oIeivWJKeGQOcEX0lTfqPAgQC1gEieTSSyVqVdlmfC32uCMKlYCGK4MN5O9BMnVVbatlOT' +
                    'aZmHBzR+/JYFgfzJz12rdN2q7dZ6CslQUxf8PKPCgQDJgEidaNqI4LJ6yGsXqr2lrPeN34I2DNw' +
                    'AbnnsKxF6Z4OF3/EG661BjZXuVOJa7uROnLTaGuVCFq24YAJ+Ohhwo82BAN2ASJyThwMGZSs+Q7' +
                    'esh5TirGPBLFAPHMeJXVXx6uAgfbzW27JBYjQm3l1ozKoyUoBvpr+3KHFoXiUpuubrEVdRvXEVX' +
                    'yBrkXAUQKPNgQDxgEids1T1UR/g/R6bJPeKZOnNezzcgvXhi1O2IuSFzFJ35CB1nSF1ytjqYdMc' +
                    'ahA7lGBTVJuPhQ3LNAw66+C9FmRrxkFQs9ijAiSjxoEBBYBIreQDlVoN+hU56I4Az6tU5ktB5yr' +
                    'xPmIyMAfZ08qW02Oh2jtuqeVORpCCBCauf08cNVNLCHg7oRAh1aaGnfGxZYCjyIEBGYBInWj5Zf' +
                    'mWDAm20heitP3cHofV6feFumdsAYY1TNJ4KIrxY7miBnTOpTYA2IJu61pFxRDEsV52L1m7tNYvy' +
                    'Ju7+dmKzKPLgQEtgEick4cDc5bQknITHaXgG/xb1mKSpn/nm/tssSzwa2qQC/kONMctmJVZMUEM' +
                    'rg54u2jxm6874/zlDp031eiJIX7LWPE7ReHLo82BAUGASJyThwNzlvHjbt3MDV+TsVzkxlCtZns' +
                    'FNfcYmbs9TmxjTlnIpQX8wbKuWschYfaM8etUJOvnb/yGcvMpivR7YJgfy7tpZKUeQKPpgQFVgE' +
                    'ick5F1Y54ua6TjMCUSH2YyS0Yx87+x1GxKdJbdt8NHgoMHUk16YvwZJYprJHronc8mvmnt2zYY1' +
                    'nBqXaObTDkd3AB/XAYYviw6uo6Fz6P/MxrU4LW1QTbrusH3w2kAvTryese8o+GBAWmA2MjLKO58' +
                    'EVgwHJIMk/3/W9qycyvcurYWNS7Kg50KM6THIdpWkAB11YGK0jIzw+K/wk/o46yRSErWqL4r6TQ' +
                    'fbx4i/vspmMsOcjLSwQy6v8vFAjpusSKPScs3oKNVo9OBAX2A2MEZ1gwBmiK9hQdRvC99rGblxP' +
                    '5fCMLwVNI+nG0cPgZ0f8IkRSccLZBhj2US1vjrhM7nwf6wOoU/7XUV8Agqqqe4xz/q5anHLGGDR' +
                    'LcXVaPUgQGRgNjBRiKwZyKR7l2V6ktuKE9YkVGCXz2jrAlr9ywvXzCB7uND83aPKuDHna6mGthq' +
                    '+g+Be+CJGPozyThnWFXnUODpLfJYWTy4FIzYTEmbcLNUo9SBAaWA2MR9N3OJwRAfWUQtqnWsoQv' +
                    'y3bECNVQnzy9sUr3k42CJXixEAxWHf+lAPFxSjMpA5Xb3iw6F5VuMid/bkq857rFMUBg5GDmv+t' +
                    'WP+iABN1Sj04EBuYDYxH02XHsVhZ0T8/VD0BzEj+Vu89qYuhXQC6dX+foyVMYHJ16EKXE66dnwY' +
                    'G16w4oskp+AcdsOC4FUM5zSWrQyAxpVt/krw67sZSZBANNVo9WBAc2A2MSc2ENHzUPBvcAJjRG0' +
                    '9Dvf5FPf3xFPRTE1ddLNUGQnOg7aRm1bjH4Xaj96Dcu3XTY+xDQJzQGmeNPlNZl9XpJnHSBdWf2' +
                    'xzMpBzTcLeYtVo9SBAeGA2MFGIdM4c/JA3tz3hC7LOSDHyjhS9kEDB1egBqG3PdC+NVtTs5R7Gk' +
                    'hSsCNYHGaPZgEbanevGAFMkJvut62Vpfa85liygZWpxjNjNdu5F1SjQJKBAfWA2Mpq4io/S6cxo' +
                    'wKNe4elOrgWklo0eQRVfKA66CDqtpLgogA1ibtr+vIA4GsRxctMiCuWMHvDdBOc3He9kQxjpolT' +
                    'x79TAXKTMeJgV3dg6XLwrGg8f3afBwevlUrei+yumYfDYmVzIi4DbS907xSKCpM1ruCwAKzSvDg' +
                    'r3OHGtz8j6AWyIL8V5HI9ztqV1qPWgQIJgNjATsPGOz6N1xgQpjdfRu8Dvg5rJM5/SXnPTYiYU3' +
                    '0jQKzhY/+LRhm9inOQbV/duO6dWWTPSoVLwyZzM8mUzvu9E6JudS5YrGKnuucnBpmHz1Sj1oECH' +
                    'YDYxG0rtNJ31K4YAbs2hn7ykZkc7O+O3/MutXkmLMVR5qqu4eyf0nusC5Kcn+tlf7TWp8kLKn69' +
                    '+wpNoOk0xhGtSkUprk9i8fmvDrWwIuIWyEtVo9OBAjGA2MSc/yaeUeVwbl+miLYo34KpC1MSNEM' +
                    'Uffe+YJNXlmvStndY4CUIkimD8dMTLlWDfxz4Ye9vwTITQZAw4T0eTj6h0wjllHL2HMeCjGnLVK' +
                    'PWgQJFgNjBRz+VSjruym1L6NmmX3x4yo1BYSR2J9y5nqYuFtPXLV+srqhcwwXvq3Meg7WAWXuSu' +
                    '8QIpVOdUq3UanHq+Xq/yc61kAT4PLanHPB7SeoYt1WgQIyhQIKBAlkA2H1A94PnOrsgp/aYyWou' +
                    'NEYff5ZvqV4KlCYGH0pHjXDdQY5w9UEqseNP1DywxkTlkhUhkCIJk047OsabevIXR7O1i1yMUOH' +
                    'I8Dv/LiOqWFyeU+TRi8gEt51GclA93eIgur7ia5xxeA9o43+JP4uBCJcu+YBoW4iCDSlpitEwda' +
                    'KEAM3+YBxTu2uRu4+zgQC3iveBAfGCAcTwgQM=',
            ),
    },
    {
        name: 'hybrid-swb-voip-20ms-mp4',
        container: 'mp4',
        copyOf: 'hybrid-swb-voip-20ms.opus',
        decoder: 'libopus',
        inputRate: 48000,
        sampleRate: 48000,
        channels: 1,
        seconds: 0.6,
        frames: 29448,
        referenceStart: 4800,
        referenceFrames: 480,
        reference: () =>
            base64Float32(
                'AGCNPgCkkT4AYJU+AJSYPgBAmz4AZJ0+AAifPgAooD4AzKA+AOigPgCIoD4AvJ8+AIiePgD8nD4' +
                    'AJJs+AASZPgC0lj4ARJQ+ANCRPgBYjz4A6Iw+AGiKPgDIhz4ADIU+AEyCPgBQfz4AoHo+AKB2Pg' +
                    'BAcz4AaHA+AOhtPgDAaz4AGGo+ADBpPgAwaT4ACGo+AJBrPgCYbT4AGHA+ABhzPgDgdj4AmHs+A' +
                    'JSAPgCsgz4A6IY+AByKPgBMjT4AjJA+AOSTPgBklz4AAJs+AKSePgBIoj4A4KU+AFCpPgCIrD4A' +
                    'aK8+ANyxPgD0sz4AvLU+ADi3PgBYuD4AFLk+AEi5PgD0uD4AHLg+AMy2PgAAtT4AtLI+AMivPgA' +
                    '8rD4ADKg+ADijPgC8nT4ArJc+AAyRPgD0iT4AgII+AGh1PgAgZT4ACFQ+ABBCPgBgLz4AMBw+AJ' +
                    'AIPgAQ6T0AMMA9AJCWPQDAWD0AoAQ9AIBFPAAAArwAwOK8AKBBvQCAiL0AcK+9AEDVvQCw+b0AS' +
                    'A6+APgevgDgLr4A8D2+ABhMvgAwWb4AQGW+ADhwvgAger4AdIG+AEiFvgCQiL4AWIu+AKSNvgB8' +
                    'j74A1JC+ALCRvgAQkr4ABJK+AJSRvgDQkL4AxI++AHiOvgDojL4AMIu+AFSJvgBoh74AdIW+AHC' +
                    'DvgBcgb4AgH6+AEh6vgBAdr4AoHK+AHBvvgC4bL4AYGq+AFhovgCgZr4AiGW+AEBlvgDwZb4AoG' +
                    'e+ABhqvgAQbb4AYHC+APhzvgAAeL4AwHy+ACyBvgBchL4A3Ie+AHyLvgAkj74AzJK+AHiWvgBIm' +
                    'r4ATJ6+AHyivgDIpr4ABKu+AAivvgDEsr4AMLa+AEy5vgAgvL4AqL6+ANDAvgCQwr4A1MO+AJzE' +
                    'vgDsxL4A0MS+AEDEvgA4w74AoMG+AGi/vgCIvL4ABLm+ANi0vgAMsL4AqKq+AKSkvgAAnr4AzJa' +
                    '+AByPvgAIh74AYH2+ABhsvgAgWr4AcEe+APgzvgDgH74AWAu+ACDtvQBQw70AcJm9ACBfvQBgC7' +
                    '0AgGG8AADKOwAA0zwAADg9AHCCPQDgpz0AEMw9ALDuPQDQBz4AYBc+AAgmPgDAMz4AeEA+ABBMP' +
                    'gCYVj4AEGA+AIBoPgDwbz4AaHY+ANh7PgAggD4A2IE+ABCDPgDMgz4AGIQ+APyDPgB8gz4AuII+' +
                    'AMCBPgCcgD4AqH4+AMB7PgB4eD4A6HQ+ABhxPgBIbT4AoGk+ADhmPgD4Yj4A8F8+ABhdPgB4Wj4' +
                    'AWFg+AOBWPgAoVj4AKFY+AMBWPgDQVz4AYFk+AIhbPgB4Xj4AUGI+APhmPgA4bD4A8HE+ACh4Pg' +
                    'AYfz4AcIM+ALCHPgAgjD4AlJA+APyUPgBkmT4A9J0+ALSiPgCApz4AMKw+AJiwPgC8tD4AsLg+A' +
                    'Iy8PgA4wD4AjMM+AFzGPgCkyD4AiMo+ABjMPgBczT4ANM4+AHTOPgAIzj4A9Mw+AEjLPgAEyT4A' +
                    'LMY+AKjCPgCEvj4A1Lk+AKC0PgDsrj4AuKg+APShPgCsmj4A6JI+ALiKPgAYgj4AMHI+AHBfPgA' +
                    'YTD4AcDg+AJAkPgCAED4AYPg9AFDPPQDwpT0AAHo9AIApPQCAtDwAAEY7AECBvAAgDL0AIFW9AD' +
                    'CNvQDgrb0AkMy9AODpvQAAA74AYBC+AOAcvgBYKL4AoDK+ANg7vgAIRL4AUEu+AKhRvgAQV74Ae' +
                    'Fu+APBevgBoYb4AGGO+AABkvgBIZL4AAGS+ADhjvgAQYr4AmGC+AMBevgB4XL4AyFm+ANBWvgC4' +
                    'U74AyFC+ADBOvgAATL4AOEq+ALBIvgBwR74AeEa+AMhFvgCARb4AwEW+AKBGvgBASL4AwEq+ABB' +
                    'OvgAIUr4AkFa+ALBbvgB4Yb4AGGi+AKBvvgDgd74AUIC+AMSEvgBQib4ABI6+AOiSvgAImL4AUJ' +
                    '2+AJSivgDEp74A2Ky+ANSxvgDAtr4AkLu+ACjAvgBwxL4AWMi+ANDLvgDczr4AkNG+ANzTvgC81' +
                    'b4AJNe+AAjYvgBc2L4AHNi+AEDXvgC81b4AkNO+ALzQvgBQzb4AXMm+ANjEvgDAv74ABLq+AKiz' +
                    'vgC8rL4AaKW+AMSdvgDUlb4AjI2+ANyEvgCQd74A0GS+AJhRvgAQPr4AUCq+AEgWvgAIAr4AoNu' +
                    '9AHCzvQCwi70AQEm9AED4vACAQbwAAM07AMDCPACgJj0A4Gg9AOCTPQDAsT0AwM09ANDnPQDw/z' +
                    '0A+Ao+APgUPgAAHj4ACCY+ABgtPgAwMz4ASDg+AHA8PgCoPz4ACEI+AJBDPgBgRD4AoEQ+AHhEP' +
                    'gAIRD4ASEM+AChCPgCQQD4AeD4+AAA8PgBgOT4A8DY+AOA0PgBAMz4AADI+AAAxPgA4MD4AqC8+' +
                    'AHAvPgCwLz4AkDA+ACAyPgCAND4AwDc+AMg7PgCAQD4AyEU+AIhLPgDIUT4AsFg+AHBgPgAIaT4' +
                    'AcHI+AGB8PgBUgz4AmIg+AASOPgCokz4AeJk+AGSfPgBIpT4A/Ko+AHSwPgDAtT4A9Lo+ABTAPg' +
                    'AAxT4AoMk+',
            ),
        bytes: () =>
            base64Bytes(
                'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAKCW1kYXRohHpuRbRaErFwdZQ' +
                    'MMaJJ64UnASaYmCApMeyBvYOr3ooqBC7TLOdyXsSQRrElQTvdNzCzwMCQ89i4n7xI4N5OAgDRH5' +
                    'lvINpYEWm89OD5c1QG3miozBa0oQsuFBuF+/fJDmfLpUDplUJ0EynLpoDrUXWK+6ufKDM+USor6' +
                    'BZJrIhCvdgefhthBB2srB5fz1UccFhaurWjRAg/0Hlb/UalyuXL5H69aJ6xWXEios8ZDObLablv' +
                    'pL1CS3ozQIRV3+r8btCyE+yvmCtglL8uWt1DsxCxaHmeT2zxSASWbmsjJGxCeQ5pQ6McdBlYYBx' +
                    'A/8mwjGzJ5++t8R19AU2lQ2iesVl431LZe2yzqlKkzcQBqTr/YmIV5f7iniv1rhOp+yFF6jMNbc' +
                    'qKqMyHhYJAG0WUk+oQKXIHgXS7O6hp3XiYSTeGLixX1A55ZM6PVx05An+TilVIVQTIhWif+bl43' +
                    '1LZf8NmgfOktjDr8TjQkd4BWWqOCSmDvsQ+adEz+aAe97rBQzltWFCvfLlje7VNmANLlukEWG9z' +
                    'FldWe48YzVqCPlvAePPgLg94hvrDaJ/5mosTjUOHmz1X47GOLmvxbC125uF2Q+1cGNOAnGgRfHc' +
                    '2o1P6kGL4enY0fhrferQnr00ZYlq6y/z5Si0OJKhT0o9pztCGdWif+bl4334GfBZRAsHUypDXSi' +
                    'BUxgFSDWnxTElN48tsRnV12R4bjtUyphltWg000fisv2enJZ7e1Cztfj4jPDnenxI/BqWB35/ZK' +
                    'HOg7SE7aJ/5uXjfUtNgBxiLbclvHZCpwpDhMEGdqoyEpN3vhhFNKOWyhae++LXfK2lcd8EfFbYo' +
                    'gx4QzH7hvOMB+YDLtkYslgx9+hpZ0ObBJ3hsp64WT4LLQ2if+bl431Ur2YxO8c4hi8ggdGU3X8d' +
                    '6idn25Ht2wRflMqwX9ApLkL7uxdG1t42xBzMOZTShQ4Wta8qItFL3mn01tD02c3oIeivWJKeGQO' +
                    'cEX0lTfkieTSSyVqVdlmfC32uCMKlYCGK4MN5O9BMnVVbatlOTaZmHBzR+/JYFgfzJz12rdN2q7' +
                    'dZ6CslQUxf8PEidaNqI4LJ6yGsXqr2lrPeN34I2DNwAbnnsKxF6Z4OF3/EG661BjZXuVOJa7uRO' +
                    'nLTaGuVCFq24YAJ+OhhwSJyThwMGZSs+Q7esh5TirGPBLFAPHMeJXVXx6uAgfbzW27JBYjQm3l1' +
                    'ozKoyUoBvpr+3KHFoXiUpuubrEVdRvXEVXyBrkXAUQEids1T1UR/g/R6bJPeKZOnNezzcgvXhi1' +
                    'O2IuSFzFJ35CB1nSF1ytjqYdMcahA7lGBTVJuPhQ3LNAw66+C9FmRrxkFQs9ijAiRIreQDlVoN+' +
                    'hU56I4Az6tU5ktB5yrxPmIyMAfZ08qW02Oh2jtuqeVORpCCBCauf08cNVNLCHg7oRAh1aaGnfGx' +
                    'ZYBInWj5ZfmWDAm20heitP3cHofV6feFumdsAYY1TNJ4KIrxY7miBnTOpTYA2IJu61pFxRDEsV5' +
                    '2L1m7tNYvyJu7+dmKzEick4cDc5bQknITHaXgG/xb1mKSpn/nm/tssSzwa2qQC/kONMctmJVZMU' +
                    'EMrg54u2jxm6874/zlDp031eiJIX7LWPE7ReHLSJyThwNzlvHjbt3MDV+TsVzkxlCtZnsFNfcYm' +
                    'bs9TmxjTlnIpQX8wbKuWschYfaM8etUJOvnb/yGcvMpivR7YJgfy7tpZKUeQEick5F1Y54ua6Tj' +
                    'MCUSH2YyS0Yx87+x1GxKdJbdt8NHgoMHUk16YvwZJYprJHronc8mvmnt2zYY1nBqXaObTDkd3AB' +
                    '/XAYYviw6uo6Fz6P/MxrU4LW1QTbrusH3w2kAvTryese82MjLKO58EVgwHJIMk/3/W9qycyvcur' +
                    'YWNS7Kg50KM6THIdpWkAB11YGK0jIzw+K/wk/o46yRSErWqL4r6TQfbx4i/vspmMsOcjLSwQy6v' +
                    '8vFAjpusSKPScs3oKNV2MEZ1gwBmiK9hQdRvC99rGblxP5fCMLwVNI+nG0cPgZ0f8IkRSccLZBh' +
                    'j2US1vjrhM7nwf6wOoU/7XUV8Agqqqe4xz/q5anHLGGDRLcXVdjBRiKwZyKR7l2V6ktuKE9YkVG' +
                    'CXz2jrAlr9ywvXzCB7uND83aPKuDHna6mGthq+g+Be+CJGPozyThnWFXnUODpLfJYWTy4FIzYTE' +
                    'mbcLNU2MR9N3OJwRAfWUQtqnWsoQvy3bECNVQnzy9sUr3k42CJXixEAxWHf+lAPFxSjMpA5Xb3i' +
                    'w6F5VuMid/bkq857rFMUBg5GDmv+tWP+iABN1TYxH02XHsVhZ0T8/VD0BzEj+Vu89qYuhXQC6dX' +
                    '+foyVMYHJ16EKXE66dnwYG16w4oskp+AcdsOC4FUM5zSWrQyAxpVt/krw67sZSZBANNV2MSc2EN' +
                    'HzUPBvcAJjRG09Dvf5FPf3xFPRTE1ddLNUGQnOg7aRm1bjH4Xaj96Dcu3XTY+xDQJzQGmeNPlNZ' +
                    'l9XpJnHSBdWf2xzMpBzTcLeYtV2MFGIdM4c/JA3tz3hC7LOSDHyjhS9kEDB1egBqG3PdC+NVtTs' +
                    '5R7GkhSsCNYHGaPZgEbanevGAFMkJvut62Vpfa85liygZWpxjNjNdu5F1TYymriKj9LpzGjAo17' +
                    'h6U6uBaSWjR5BFV8oDroIOq2kuCiADWJu2v68gDgaxHFy0yIK5Ywe8N0E5zcd72RDGOmiVPHv1M' +
                    'BcpMx4mBXd2DpcvCsaDx/dp8HB6+VSt6L7K6Zh8NiZXMiLgNtL3TvFIoKkzWu4LAArNK8OCvc4c' +
                    'a3PyPoBbIgvxXkcj3O2pXW2MBOw8Y7Po3XGBCmN19G7wO+Dmskzn9Jec9NiJhTfSNArOFj/4tGG' +
                    'b2Kc5BtX9247p1ZZM9KhUvDJnMzyZTO+70Tom51LlisYqe65ycGmYfPVNjEbSu00nfUrhgBuzaG' +
                    'fvKRmRzs747f8y61eSYsxVHmqq7h7J/Se6wLkpyf62V/tNanyQsqfr37Ck2g6TTGEa1KRSmuT2L' +
                    'x+a8OtbAi4hbIS1XYxJz/Jp5R5XBuX6aItijfgqkLUxI0QxR9975gk1eWa9K2d1jgJQiSKYPx0x' +
                    'MuVYN/HPhh72/BMhNBkDDhPR5OPqHTCOWUcvYcx4KMactU2MFHP5VKOu7KbUvo2aZffHjKjUFhJ' +
                    'HYn3Lmepi4W09ctX6yuqFzDBe+rcx6DtYBZe5K7xAilU51SrdRqcer5er/JzrWQBPg8tqcc8HtJ' +
                    '6hi3Vdh9QPeD5zq7IKf2mMlqLjRGH3+Wb6leCpQmBh9KR41w3UGOcPVBKrHjT9Q8sMZE5ZIVIZA' +
                    'iCZNOOzrGm3ryF0eztYtcjFDhyPA7/y4jqlhcnlPk0YvIBLedRnJQPd3iILq+4muccXgPaON/iT' +
                    '+LgQiXLvmAaFuIgg0paYrRMAAAA3Btb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAACWAABA' +
                    'AABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAA' +
                    'AAAAAAAAAAAAAAAAAAAAAAAAAAACAAACmnRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAA' +
                    'AAAACWAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAA' +
                    'AAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAlgAAAE4AAEAAAAAAhJtZGlhAAAAI' +
                    'G1kaGQAAAAAAAAAAAAAAAAAALuAAABxuFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAA' +
                    'AAAAAFNvdW5kSGFuZGxlcgAAAAG9bWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmV' +
                    'mAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAGBc3RibAAAAFtzdHNkAAAAAAAAAAEAAABLT3B1cwAAAA' +
                    'AAAAABAAAAAAAAAAAAAQAQAAAAALuAAAAAAAATZE9wcwABATgAALuAAAAAAAAAFGJ0cnQAAAAAA' +
                    'ACD9AAAg/QAAAAgc3R0cwAAAAAAAAACAAAAHgAAA8AAAAABAAABOAAAABxzdHNjAAAAAAAAAAEA' +
                    'AAABAAAAHwAAAAEAAACQc3RzegAAAAAAAAAAAAAAHwAAAFMAAABTAAAAWAAAAFoAAABTAAAASQA' +
                    'AAFAAAABVAAAAVAAAADwAAAA+AAAASQAAAEkAAABCAAAARAAAAEcAAABJAAAAZQAAAF0AAABPAA' +
                    'AAUAAAAFAAAABPAAAAUQAAAFAAAACOAAAAUgAAAFIAAABPAAAAUgAAAH4AAAAUc3RjbwAAAAAAA' +
                    'AABAAAALAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf/8AAAAJHNiZ3AAAAAAcm9sbAAAAAIAAAAE' +
                    'AAAAAAAAABsAAAABAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGw' +
                    'AAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDA=',
            ),
    },
]);
