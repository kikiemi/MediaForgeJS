// H.264 fixtures produced by ffmpeg 6.1.1 with libx264 using the command above each entry (output
// to <name>); `md5` lists ffmpeg's own decode of every frame in presentation order (ffmpeg -threads
// 1 -i <name> -f framemd5 -), hashed over the visible Y, U and V planes packed without padding.

import { createHash } from 'node:crypto';

function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 6
//    -c:v libx264 -profile:v baseline -preset medium -g 6 -crf 26
//    -x264-params ref=3:slices=2:scenecut=0 -color_primaries bt709 -color_trc bt709
//    -colorspace bt709 -f h264 baseline.h264
export const BASELINE_FIXTURE = Object.freeze({
    name: 'baseline.h264',
    codec: 'avc1.42C00A',
    width: 64,
    height: 48,
    displayWidth: 64,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    /** Presentation index of each coded picture in decode order. */
    order: [0, 1, 2, 3, 4, 5],
    md5: [
        '4886fa817f89c3f51c61f2c091dbd849',
        '296e4b7eeb3b3977fe09b7ee5ac8af46',
        '4eca46929bd77a4eb5d659c2af61fb6b',
        '1c2ba0e5ed52b7cb0610704e5c1cb2a0',
        'b842cf8da7c0c1a7f8c96914d0903c67',
        '1217b8c5ab131066dbfd4ca11dc4e001',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdCwArZBHsBagICAoAAAAMAgAAAGQeJEyQAAAABaMuMsgAAAQYF//9x3EXpvebZSLeWLNgg2SP' +
                'u73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIE' +
                'NvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wd' +
                'GlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXgg' +
                'c3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9' +
                'tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPT' +
                'EgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfd' +
                'GhyZWFkcz0wIHNsaWNlcz0yIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBh' +
                'dD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9NiBrZXlpbnR' +
                'fbWluPTEgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYgcmM9Y3JmIG1idH' +
                'JlZT0xIGNyZj0yNi4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpb' +
                'z0xLjQwIGFxPTE6MS4wMACAAAABZYiEHfEIioAwIQ/DgABPtiPRACCLkU4fbv9g0gmQFRVrf1v9S3JO' +
                'NlfZOs46aR30HtOixV5tFIt+XU9EppMVp6B0lMH389si07YW7b4EAEMQ0DgCgEAGcpHBEPG7HYyjj8c' +
                '/+cKXIoaKg8d0BXllnBbjJKFGb8pfK2ev/9KIqAj7XYU+CUmqpsVv//7/wAl6XHlfaKSTY9TzbdqPQP' +
                'KPPcPTzazkHVE3y+0qTSC09ta0HU3Esj9UwNTCUGaXGtzxbhvMDD6Lf/OI7ON84pzdkePjx8caPDNhx' +
                '/84MWy249+Ym4ioF9h4gAA7mEzJMt7e//+AoicinD7d/oNCZkBUFJlvct/gWdWLLztd3WbHk5vq9Q9J' +
                'Uwf/98oc07YLf++VqxZefavCrppqnpHpIdev706VpvQdQUABcAEDTbJQ64YbUxUeyQIfuICuYko2p2V' +
                'pqQUv//cl45UxQ6Ho90lBWZ40VR5ve/+fiOIq7tRyL8EsyqlBruSceXvbuMin9H0Dm6TjxX2DXK3eqz' +
                'nWkd87XJpoOpxpxZH4656FdGeo2Cli9POKVMPnZ7ZFrthbtvgFhHCAI7DYdXwsLK94pU7Om3ocqf/uK' +
                'FxCg0VauWo0MiRn5UDZx5U61Xk69/cYFYy2DanAA+EPsFnz/EQAogEeVDcLNAmG4OaHLAlcUoJXPh/+' +
                'Csb+7GGHkgYAHH2h7oWZ3PKzuYuQeCzgACAWmAZBAAQQEKv5rvAsRALGMP/0Gvlq/3+JOIAAUAH8+si' +
                'Nrnh42ucAAAFlEiIQd/H/hxsGkAaDFdyplF8GCCZc+EhYDhAlAYMCfpSRK2eeWAAQmfIkQ2H0IlKMdi' +
                'oDLAEARj//6DWb4IBMqr3CUIUICFPDMUYqllFXO+f0kzXEIR5ZAghbnwD/+GjigAEcHVmKcDxjMgOAA' +
                'IDqAACC0EHB9DiELLAeN4j61vhYdoBrzRJg/tSwgVj//8aab4FEyNeA+8JIQoQABEDAoMzydh0y2FXP' +
                'uLekQ13MQRklkAEOIucAAAABQZo4O+InhL2CECEU53rOVKO9PFfxu6DKACEle7PDBbjwy7VI5554OxM' +
                'gBlrTox5e7ftqt9uJ3+nmHwtDffs8eNrzz1GlD6hbOcbZfeGf+PuP74b1+ItIbukup5/8L4AlbWuntR' +
                'xv/kXaapbrghTg0GnAEiYUlL4EtWLWXb9adc4//X4BqNdNW66+yZNB+fx2MGoU19kMaE+75eSejR/+y' +
                'nc8qnc/OcRs7N3JW7mr/K+qhc1VSqpVUqqCTiAAJvsJXJRK455AIhNwzw4IhNyAAAABQRJo4O8vjPlh' +
                'mT85CYh+4et/DgEi3Ms8LhoDlEAIn9KzXGeQIIW5N+7eQT7k+cpYEqD+CF5rIcFdcyRpufzeANu1dLR' +
                '+lfTHzI0zB5kaYDRwuAMaDErkPMVyE9YArb8MSIkkIFVwgAQwm5AAAAABQZpUBD8ICDxew1bAC791/P' +
                '8XSkNcyPgskfBZAoukO06GinoDHitCbfnigi4ywDK2pUvfNU+Hs6K3BXA7QLPzwcWiCxZ342p76PDfx' +
                'XF0jRg3CdsshoFn+F8zMENdakWvVSLXWAYGcDh3GLhXY4rZHdwCH5hubJPnjAFst9o3qq6rot2xAqBZ' +
                'N48x4z6P1j2SI111yuubWJWIAAABQRJpUDvwgIDXP4OKYVXMaADZZY0ffa7A5fLDtSxCWnPP+eA6h1U' +
                'sGKpl1H/+coeUBZBfLH5reB75f+GjR2mwvoHnx6zANbOIh/7QBh/XV50puZXFe1W1d5AAAAABQZpgIf' +
                'QIAgeAHhPVVf5Qf+vr2uERIXzbARlN0ej0TomcCZmwAN7fCJvPWhmfmter0AEGrZu6bI2fN80MP/sNB' +
                'WOpjz+IrB++D94hepy+YbcD/otfrX9lj0dUSopof/7BWWh/HKNXLVXLBt3LK3cuaGH/2GhD8VETt8jv' +
                'pCSDlrg464QAAAFBEmmB30CAILrr2n69k9UsIi/ISGBU8AAAAAFBmoAl9AgCCy6+va4REhfAI9fbQgj' +
                'Jmiu0JN6ZI4f/3W7csAGT39X7/6fnX8IhGSAAAAFBEmoAl9AgCAY4K+WGJOWweZHLA8xLLCKQB8Gzll' +
                'Zy6IArOI1iobunOzWGODxkeWB4yPLYEu1vs7EEhhh0hyw8xS/+sMdwV8tjFOWDEp0CWirDzKWUVLwFn' +
                'qwABepvlrtcIiQxweYllgeYllsJfbyW3LFEQSHdoE1PuTmiEhywDKbpmKBAAAAAAUGaoCn0CAIK3X17' +
                'XCIsL4ArTat+W4ObqKavc+T4YMUF+lz1G33YWi2e+d879eAAAAFBEmqAt6UEAQCAg8q+OS3GvpfP1w9' +
                'nppr6Xz8v5TQ09KXzyoP7k2Y1PrjQe+XA',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 9
//    -c:v libx264 -profile:v main -preset medium -g 9 -crf 26 -bf 3
//    -x264-params b-pyramid=normal:b-adapt=0:scenecut=0:weightp=2:ref=3 -f h264 main.h264
export const MAIN_FIXTURE = Object.freeze({
    name: 'main.h264',
    codec: 'avc1.4D400A',
    width: 64,
    height: 48,
    displayWidth: 64,
    /** Presentation index of each coded picture in decode order. */
    order: [0, 4, 2, 1, 3, 8, 6, 5, 7],
    md5: [
        '193835d6dfb5de48e66ada573ac9c24b',
        '556c5fe71afe51fa844e07624cf7ad65',
        '2c9ba6cbf93b11d2c81ecedd56156966',
        'ee770badece94c231002c36e8193808d',
        '4d5e1420f1a7f2504b9b6e9a619b9a9c',
        'a7b453d6bfba9164e4ea0e84adb9ff17',
        '401c40a0b2e06684bc82d28bc0f99dcf',
        '0dbbb1e997f02ab6de28756bb7b670a0',
        '1194c3dd280ca79cd270329a051e0de0',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdNQArsoj2AiAAAAwAIAAADAZB4kSywAAAAAWjr7LIAAAEGBf//pdxF6b3m2Ui3lizYINkj7u9' +
                '4MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3' +
                'B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb' +
                '25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1' +
                'Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWF' +
                'fbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIG' +
                'Nocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3Roc' +
                'mVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJh' +
                'aW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTAgYl9iaWFzPTAgZGlyZWN' +
                '0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD05IGtleWludF9taW49MSBzY2' +
                'VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9OSByYz1jcmYgbWJ0cmVlPTEgY3JmP' +
                'TI2LjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9' +
                'MToxLjAwAIAAAAFliIQAZ299mgElPxR6d3pmY+8dOCMX+vqxuSSDLM7rMBxauxSN1tcI2UcUd4R+Q/s' +
                'EN7wmIxhsGosY03gEMlWRCPcTfQ2Z5nRQXpsfpefKVUXKVXZ1JVbwBtHqeIyoy+oFvXhB0ns0w/h2M3' +
                'FHnay+Ui/dpk2qxus+YQN7HeGIPuTnVzEQnSYDxe/uJoY4XiPtV14THkU2lWbs3kgVwDm8gkotvbZHO' +
                'Hi6TLI224ChhTCZbs4v6sLUHjkorSIR+uN5eumh5GugYdRnJxnTVDI1CJsakaNsetijkFfsWCfXbI5d' +
                'x+PPNv8svmdfHWSFNhXZWUkop3OhW6DIqZPB7+qyTzV1/+Xw3dvzsq0EPbhvFLJnUbxrjg8ntot/sHr' +
                'yumZJYNKKGMBoo784KCOeihwPc8IkN+3UFC0sC+MBhP3jpTS/xbvfc2jPvtvQPWi3kRqvaSQuPxbskp' +
                'CzBNB7xm5cDrCSUtsOe7wDvytLP4GNQjDAHbCGaeYxQSXHhYWiNT9RlwbE41oDC9x7GfqATKBV2eMCV' +
                'xYGOXqMcc/7hbSjLXme65h/v/N+o85ghr17nTS4RNTo21oPNEUJ7LGYzOtv9E8mieUCpkNyGqdrEH2I' +
                'KUPnifpbbj+G30oQhHgBM3gPTcdGRKOxvnGBRG3mqwjS5tx5VpavAsdCdvtrvlkJ9y1omb6l4rdzmi1' +
                '2dmJI/afP4weTypB7BFNDBnzfX/tcHTsnw9GMKNt5mr0JyYhsuEUvqCB6SbjfOmHzGxx85KZnJrq9G/' +
                'aIJRgYTwFu/xolDxFMq39U8gzBi4R9Oqsx5mKuzoQkeRUCvYlnYrq6cr+2UR0Flbq/OILJabBbGnb6D' +
                'IrCb/QOBVWhKGYKuJJrlD8fjKyWyeMLbm6jitIGDSY8cOgzvQebVMNED3vnaE2IteZEyWwTxxlHSgJH' +
                'ELVjW/HENqnDC7wOo5Mv7/x4L9mpocLLi6+wLjw8A1zFgLn/4TfBAAAAAUGaJGxHf9zMI6WqH4fmibr' +
                'Zry3TWg20zNKJd5XSWgYjM98JgYm1rcp+oVUVJBK8Vr/k+lBGkKpYoy+/G/KHAcJ3n+GgjtmXHtrAsf' +
                'Jb7MXjslU9pwNRDrj3whEBf0fJcJ78RWueeD7HcydjUZvnPW3piRxWSr4HtuuE2PYVvSBA+Fds/h1gx' +
                'qT/ZDyO70MyGmTg371ScmMQU7jWDgImMllmfF9v0uyOrH6Wyblma8I36rQS6lW0TP1vl50jjCYz0eGa' +
                'B+lS5APnDf0YCpNA+U7v2u+1NzPXHQVYf81QtWBIhpmFmQ2CYERQWs/gFxrHlbk+H15zUHKLJ1dz4Mv' +
                'tEKpajQt1Wa+bkfdnqgHOZHYp6Hi4KzhZ2snIhPols48HmjJMD9v3vV0YGcWmIzYY7WKU3+7+JBZqDX' +
                'C5g94D3Um0CsemCV2bqdpn3mKc8jUFSNiu3lwBDiKMk6K0B7sYczwOZ8a1YH6KaCMZh1frB68IVYoNN' +
                '5Mjt5Jt4NvCta9p2/BzgqSNAgrLgOP8S0Cq/uAae80VgfNdfSl483qYG8qi7POev5aj7N7cVNSqoCf6' +
                'xe0EA2u8DZLrUyN6R/qFi+tlgV6pOnLiwgfhgf4gmU7A+3tvaa4YrNyapo8ZHhOMP1rrkGAcLEC1Ua/' +
                'Yt7Gr4syikCKZxvJvQQQiQAAAAAFBnkJ4hL/7DtEE2AObBlrbqPZIZdLHb5gggLWFuzVXutkh6KJmFC' +
                'eZFF58ZFtSjY5/+7A/+Iiq85E1qA4x52dSyUU9ba0GfGpue4Cgju+Dgd9ZT98f7nseCLrUMKdcG2UFi' +
                'nv7pQtfAPv8TOVt3eEtC1Bhzirz2sOP10b+2M55BgVedHWfIXMZwev08wz1aXYOwxj6wX603Oogavps' +
                '6RmOhLJnvDWQEApoRUDpiK4KEMODuD7aFYpr36PVVjHsJycPJhu/uHCbnsI0pFaU4szESp4BVP6fCeD' +
                'kgOuQU/Z7piE7YZZBI+MAAAABAZ5hdELf/DRUkrbMcRhIlBi7QXnKldp0oLFekZWhJo88CcJNUA/Pml' +
                'yn/dJKlpIwXeVPPueRy2KPc7G4OzQcO6G+lvuV8h9H8ogWz8B5+sOzQbZwHUH0f/ApDVX5ydoAHqqd2' +
                'fG1ktEYDr6D2VlPZB3l23ap4E3gKpR3rBYxWk5ujSParXVC2ZA/oGeGX+v/HxPXPvLwvAAAAAEBnmNq' +
                'Qt/7MdvZhmIQxU7P++4XJsWh4h+x5DKS0hSv7s9hD4MuJ5sk3+OrbPltMPMsgPPHY65QUyCGtB9F+q/' +
                'hIVsU7O00QwEUWTh3v/2yXroDqqG9CjUCdU6ur1/LygHMRJ1deWtmQq7Ac////R+3wMf+mvKgB9elGP' +
                '0AAAABQZpoSahBaJlMCFP/78iBEgQnwN6G4abdlDaC7j///sh2yxQ/vxWBPr6Z//xSa5V/mZiX6BU2s' +
                'NkTRTdqLbXYWmXs/sEiHCKFGrit91sTJl+hZCn8/RfOKzj9TBtQ00bX/bw4BzlLZj1+3odvlfZteJoi' +
                'QZXxomVOHZrP/wcCdgczoq3m8HZZixerUu2xkLTMp5piacIRJSyKgdUSn3CS0wprIg6TJOG7cefykpL' +
                'p6lJAqjKt5x3vXwpUMpso3TYfN3cJ0HdgnpYRZF0BdGol3GwuxoXmMwdSGSsQWi9+bmTC6ozPAAAAAU' +
                'GehkURLCH//bcqtOhyEp000XnaPhPzRMw4Wziex59OTJzvfPpFzUX4X/XdshE7mzyk1qISwThPmxjGt' +
                'euIP+2GXogtIZVYHCN1AAAAAQGepXRCn/ulV4K0UyaKhjFnMfl5rRpUxzJxmzXSpv56+kAwMwDkPx5c' +
                '9WCOZH9YYVLzLX5aKDu7/v28Y0zd6XBmrZrct/fXDKrC4yKuh4aWskJC5mplapHb5sFkDMK000O1M2/' +
                '3D+LVgjkX//ETty8A3z3YiI+xQFcfur6NUiEdXx98LS/sKdUlFWy7d+tinJMiRFdWPnm8/3Co7QAAAA' +
                'EBnqdqQp/612EXl82/4/HH0ZOOqSioT3wnm3yfOT7ns+4mlWJp2OWi3vm2nM19NaQgg46ObH24TYFn5' +
                'u8AYJJEdF6DhsIyGclFvUTiclUMdoGK2hHWXP+pxjUnPtjQsTX5qu5IVovoHITQ+tm4pPpXKaSh17FJ' +
                'XXZpP/g4z2fkooPA',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 6
//    -c:v libx264 -profile:v high -preset medium -g 6 -crf 24 -bf 2
//    -x264-params 8x8dct=1:cqm=jvt:direct=temporal:weightb=1:b-adapt=0:scenecut=0
//    -f h264 high.h264
export const HIGH_FIXTURE = Object.freeze({
    name: 'high.h264',
    codec: 'avc1.64000A',
    width: 64,
    height: 48,
    displayWidth: 64,
    /** Presentation index of each coded picture in decode order. */
    order: [0, 3, 1, 2, 5, 4],
    md5: [
        '8bc2f23966e1a8a13d678914715827da',
        '76e198a022383955790a1b348d86c9db',
        'd3aebb9c51c3e5b8705411f4f7a0e4cd',
        'b74210a9ad7d42534bd9847fa099e880',
        'c05935b602edcca9c1975bc27c832320',
        'fc50125d7d0c7fc0d974a3a1d3bb74b6',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdkAAqs2UR7ARAAAAMAEAAAAwMg8SJZYAAAAAFo6+LLMALAAAABBgX//6XcRem95tlIt5Ys2CD' +
                'ZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC' +
                '0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb' +
                '3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhl' +
                'eCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2h' +
                'yb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0xIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraX' +
                'A9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZ' +
                'F90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29u' +
                'c3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTIgYl9weXJhbWlkPTIgYl9hZGFwdD0wIGJfYmlhcz0wIGR' +
                'pcmVjdD0yIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9NiBrZXlpbnRfbWluPT' +
                'Egc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYgcmM9Y3JmIG1idHJlZT0xI' +
                'GNyZj0yNC4wIHFjb21wPTAuNjAgcXBtaW49MyBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQw' +
                'IGFxPTE6MS4wMACAAAABZYiEAHfT1matg0dKkJ4cCxPpRE3dQqlQgpjKektP5ShEDCzwWeVDCKTGvuB' +
                'jalHI/IiNdgieth7RTHKt5S6ghWu2A2NZI146ZjIVD3WAYxKqxVqE9v0TuoMQ9BLOEQ3VrDlwjf+gY7' +
                '0yhraGi6YEez6/nKTSX/DPci6trYTBekJHKTqHReYuY6FB8QF+1eRkKqyadxYfzyYop1jY2kjenuPhJ' +
                'kzPFaWxgmMF9xLfVf0AtXjgmIWMlw128To+zSKEuM7UyRvpwRjnaFXBJJhKJNFXMUfiGuRxz/ZgWKEu' +
                'raJAffpysxaqBBEOYQ9+jTMxt+eYrGN6Wv+lxgydQNSjFPyh9WEZgJlKV9Wucus4z7T+ZlEt/DDDsNo' +
                'aPGy//XCm1bhonACc6uRTfHI6ec/wNaHlTyFAQSiiV+DROcrVvokQynk62qHbaU2C0/bQdDER5JHZCQ' +
                'c74Fz2TiPZXMErzbYRXAbdZcl3p2IvN00wWIA8U8JogmJ1iVRRcAwj/Xp3Wp6LBSsJwLpan48LuJz99' +
                'o6MaQtoZOIHNdKemMfcTSk5TiCsRmrhdxejDXTRXDpaxZFa0yX3WGem4czArlh/RnbPEI00/T5vG4VM' +
                'x3/+YX2n+aZydZviTdGcfgCNpiteEa9yh6kY74ROAy1VKNYIw2qI/Rm+zaudLgbsrGl4J0KKxtTohby' +
                'wSmE+WvUX0XkNt+ro8BZMV0rVUmy77hB86AbnzIWuV20v+dowgB05P2YiNtqmhhdzq5ciyqUUZyNGWE' +
                'H08KCESR+EqcJq8zSLcgVnRXrEVSHMvpb+fqSdqT0pNKJrO5fr2VITaEvIqiWBH7uc9m1QdZ/h2f2p+' +
                'F/KlRe9XYA1cWE1BRM9Lm44ba0CJpxPLrnYoRzfP+9JU2459lzBDk46SVyJJA1ou9SlFLsc5XyUUnme' +
                'ueHeROAU8ZvFXBSOgy6j8QAAAAFBmiNsQh/aHgpL0qKMO2+BMt52WM5trUlFlFYdpISZdrRqmDrJav5' +
                '4p94c2uak+F5NftTqFENDz6mD2Gk6PBewFiBz9dXRBEY6nWCS4JjvJW9Na6IRQUd05pjAPriBGr40hj' +
                '71xZNlitUBDPI/1vnaRfgnpYqWA220c8PFb94FX1bg2Orbt82vGQ0F749FB7HUwllIGldHdUwesrO6V' +
                'BOaTOg7LlOEuzcjxXZjIIGADxUlG94cM5gLJCJdQlJ5ysREjyWN2Lkf37NiqpY/wx2zRCCYJgDsi7Fj' +
                'GyeQoFDKareTttFVH9G04gKNSfrdpJeRjtv8jfIjt80as2u/RktIRyiW8D+the9CBGhLScK+qHcc14B' +
                'Tc2LKKLJ5hoE7+CM3F6x+jE1sbcurpJc+6KhpCNuWrTxXzxx0obmiyd++B9jsXugbAt9KVGY2BAAKY/' +
                'Hezi16uzVEY3JhOYcuPogEN8AAAAABQZ5BOIS/+tjwGH+JvyQSz2G5c/A5nKAbToPd/jvF/sVouZ8fU' +
                'A6zUykit7KlzWThko0A0KXzjE5JkdlOByPYadYpC9k8cD//4WDhTFmHv1g5sjlLUYj1zoQheKpNooBe' +
                'W4A2PdStXSzzpLGg95Ij/wYtW9obVlHv6BkULcWZMt6jB78nziPnFMf6BeREg4K2W06qQuBX80L8zz0' +
                'ibb/WR7RrhhFuQmz6vsBeCSUlk4hivAVaFDcAAAABAZ5iakLf+ncVBgQxZwOTjjGy2aTjHSGVQfVHsg' +
                'ieC8jLvuf779OVNMwqsx1HaEi2TL87E59Kdw52HUb61hT+C9QGXjYRrSpFQLG/njsCmv+yF9ewp7Jt6' +
                's+X73iNImqDxHG6LclbjBsWT4tvszxgRF1OHxlP2c+jy9/ZhXKH8r5o0WLXca17bf4oooxHnH3wY2Co' +
                'FiRjBawAAAABQZplSahBaJlMFPCn6rNrWJWH49mG6yX+cwsSE/7bNQ0rwVWMKusmCQhJffmUT1R0XsP' +
                's8YG8buno5W+NwY74W39Lmr0V6hadelb945OgMr6xaATm5f1zxXJAU7cU7BA5Uuqd+T///XuXQkQpJ4' +
                'SAuGvJiP6hE5AP6Fh+wqvvbddWq8Ut9YSsF1ro9U2mhNWiXPX3r9zUQfv/7rUrA3AR2+sqDYR6efcxu' +
                '8apsb+QmUbXu+0n6gbXz6K1BDO/OKf/AAAAAQGehCpCn/nb1QjhJgoHA/wtIUBa4Jmf/kwHcAyVKTig' +
                'AaFvuhmClfDKNs7+lbda5LbH4VrgaWLViwOZmHg3imZexIW4lkeSrnn0PVAeH9y56kB5aV0a6A8gDTc' +
                'ELwM+uL7TktBzSoOQ1uZUO0PswoI8iiU2MT87AZOWonK6eP+3r5sN7ikkXmPyCRczwQ==',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x64:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 4
//    -c:v libx264 -profile:v high -preset medium -g 4 -crf 26 -bf 1 -flags +ildct
//    -x264-params interlaced=1:bff=1:b-adapt=0:scenecut=0 -f h264 interlaced.h264
export const INTERLACED_FIXTURE = Object.freeze({
    name: 'interlaced.h264',
    codec: 'avc1.640015',
    width: 64,
    height: 64,
    displayWidth: 64,
    interlaced: 'bottom-field-first',
    /** Presentation index of each coded picture in decode order. */
    order: [0, 2, 1, 3],
    md5: [
        '75b3a4d49d817865c106f760406ea31e',
        '81c9d7256e6338f905c26816f99a511f',
        '4c41c772e8f980ba9c3e555dacdbb87b',
        'a795ec7007750369c6df222bf3df8f43',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdkABWs5BE2AiAAAAMAIAAABkPihSJAAAAAAWj7rLIsAAABBgX//6fcRem95tlIt5Ys2CDZI+7' +
                'veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ2' +
                '9weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0a' +
                'W9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBz' +
                'dWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21' +
                'hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MS' +
                'BjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90a' +
                'HJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9YmZmIGJsdXJheV9jb21wYXQ9MCBjb25z' +
                'dHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MSBiX3B5cmFtaWQ9MCBiX2FkYXB0PTAgYl9iaWFzPTAgZGl' +
                'yZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD00IGtleWludF9taW49MS' +
                'BzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NCByYz1jcmYgbWJ0cmVlPTEgY' +
                '3JmPTI2LjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAg' +
                'YXE9MToxLjAwAIAAAAEGAQFCgAAAAWWIgiwd/88ae1mMC7eOOsfQN511zhshV8+tW8fq4n5fGaNDN7w' +
                'gAh+6p7SkX45ExA7HQ7mYTwg1xXjIDoOy7C1vsSEjvp0dI0nxke7n67FZ7RasE/ovTrLKRtkJxIWb/+' +
                'bu4vcdZA+/jndDt7J+sCstZIA2iUogRv/mKbsbJFbtonUVwI5UEex+59i8g6UEL7Oplw2SydyqHFNKx' +
                'LqbGYlavoXd95j942uEzmqe/ylHJ7qgGpsypqH4et8R4KF3wJJy6jGIF/3McTHqZCY0RJ7WV/hg91Wt' +
                '23hw9E7BQx78agvexw1ETzhU37CJskK85qcFYBmK9MDEcSN/tEHozhx9Zzak43SJ3Rm0XxJJUa+u9rV' +
                'GZkscAOg0cDQu7jdDB0gdhc9jfxgXV9IF+4sVOUegln/h6vzs3j1gGdeujFtZinozWfXjmwx99WY+XR' +
                'Brnj7z2BQSnl4VWE9lXRYiD4qOMnhIJKRCjAn+O0H9iDR+G6HMhT3iwJLoi/lpj5NnW78WaPmF+8UzA' +
                'wnseMyeNt3OrWQjnqRna65/hVFay7Vg5nQjhBuInre6cI4JzSKFMPZCDFRrkmR+Cz+Jt24+YIG1X728' +
                'UighekP7+ZzK2VyWqJ9aKeEKfDksfVDjSBPbKWezbA8WpSSL2jVe73noTCmyIOIYqoiPuVGfix61Z+T' +
                'A1RK+3/QGimV55UH9UrTubt9r+pVIZ7TeLOZHTjei81XoU9ucCED9vO41jx66kPYvH8vvJa2vK7v37B' +
                'huqFxeQGpbtA+Gbx2HMOFWeVYi7DbZLYFl6h9iU4TPw3IJPf/l4zmO1P/H+9LuLOlWaHP868OPZG9mR' +
                '8hKT7vUJHYA2W0Okeqno7xl8/6zV7xY3PKq9lS/VO5yA/P3AOq+OePWT81796f9XLi5f0yN6IqG+W82' +
                'CPrXPqTUo1cnQu4hG9YQUhQ98sMMfr/HxdBckKE7Tg4yP1VV8GkA90Kv/vaV8Li7puZxk0LiG+zL4nh' +
                'KO/kTD04ahhtWm1gXNkn+HyJ8Pc2HhbLtaG47z7L3h9xeOC+UhD/OD2qlPR63jFkRShKrSRv/K3dyR+' +
                'xGE+zSpxkJQSralR2hwHesqrzxi9dLo3haN5rL5RLOi8WZHc31sXWV4kOqQbhDKbqlOiuLyVPd+k9sM' +
                'zJ7G7uXCW85vKdHbjHb+2Uk1OKNicklbuoZIWgFD7EqYo+hcT8AAAABBgEBQoAAAAFBmiV5CX/fGoYh' +
                'NEe1h2f/77cMHTdn/sHYM5FDu2Lnybyif6RlvhO+EObMDCQ6WzUm2DsHtPR943Iifc/S+/m2/Le5yvg' +
                'SC7uUpTswriwV5ypBnySebCyfyB947y7L4jf81kNT8POhh/A73idE/0V2iSeJF7ix2rrAJIYiRcxEBB' +
                '+T8IuaXUvMtxt6na0DiWbqlHoOl9OhjESKjdo3cY19Ab5jBWEnOs4Fd+hIaI2V9w5Y8F9RzmgTOLlqM' +
                '57VKrsyrkZRohWNANEONJXxYcUqSSUavHTOKShfL6Ml1dUY6p90gmDdv5jGD5XTpq0tIf1jhVVPhkE5' +
                '6dfXk+Nxgir0MEnCOJ5G4/26hewTV4dOI1x4OBAlJ22BKla7RB//Y2zeA1Jz6ZtXkqdcVM8oCcqLPi1' +
                'D2Q3+/35UH8Qk9prhCcYSJeIWh9vrcaY+sPDn8tdDUioYuY1FRPK2EntlytSxdWTUc6nmw56rbDtysB' +
                'WXrjmUmMsD25bDR45Z1OezK5emecmDyanbvxjiTnfmeyyv5cxKfiehn5IWhSlyY8IVx4AAAAABBgEBQ' +
                'oAAAAEBnkN+Qp/5pkIyrHBOnoAvx8Vq2MbnKjmMvTW4kzgWiYFl0zC7s0ID8WrmKLIMb77fZ+LpIb2U' +
                '1qC2vn2/ecPbS1HNFo7RLn+dCeKAj94f8JgM8RPytb5F7vyyQ7dva8mcMudIDcHO5P48BGWYTzreZhO' +
                'wd+2/R4Pdk6eYzXdRJuoaz+6sjoDC5skdClm/WnP15W4SPH5AMW+L72cjYQwIKAl0ot4lFTCaIJ/kHG' +
                'CY650lc5JOyBkJlp6H252yKUwarDDH9slMnLeTyCZDACefAKHypRdEZ4GtsRMNRg1XjtBjAeuLB6z6p' +
                'YsSyMD4HGNODvlf/tCv4H8TWbM4duX1rp8uzwd01UR1KW4ULsUpC0uSQc64Z9xcEDiVZP5ozb1PmKLF' +
                'nUWAmtPL8W5ah5pafJc+hopDGX7k6xLjjExfWqwxWOMuVtH84oP0F140dcpKoWVHgQAAAAEGAQFCgAA' +
                'AAUGaR3RCn939defjZe+T9fDIdL5yHfpMj4QtRGno7igxFLw9aHZg+9ffnlxwuza4t8lLUg8/clfjqP' +
                'oCJQKbAU69ljRw62/2UGnw1oFWGOj2R9nzSku63aZ5zf4q11/f5GN//uOvgJ5lX4ze2TnosEUt/82+u' +
                '03E7LM6noXihojStUmfVE0Tu+qVeXShdrqEy+L5nvg/tiBn+5zAXItH00k2VHCCC16QNOlfXs7pFPHX' +
                'SJ2tetTmSv6G3rh6nonxRSoXflE0Gg4RYa1OZCWmXDl/IxfPM1OmF0fGmIn7/Pd3Q1cQCytjYZbqBYi' +
                'uKApH3o1U0tYJ/6Lxm83gwwqdqNcrYDbPmaGqqauGMjFYPfmfEs3Nv2siFo5hZollzzFcnBVQ6VnI13' +
                'SO5/WKWU25G10GqKKIbu05MTk/Y96F0xDsNMlWs84YbWz0tr7MiYlW1jjAm/qkDQHzzDG+oh3XFRX6y' +
                'RyU5FPS5N02JcEi8V5CqBAJVNNmQA==',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=70x46:rate=25 -vf setsar=16/11 -frames:v 3 -c:v libx264
// -profile:v high -preset
//    medium -g 3 -crf 26 -bf 0 -x264-params scenecut=0 -f h264 cropped.h264
export const CROPPED_FIXTURE = Object.freeze({
    name: 'cropped.h264',
    codec: 'avc1.64000A',
    width: 70,
    height: 46,
    displayWidth: 102,
    /** Presentation index of each coded picture in decode order. */
    order: [0, 1, 2],
    md5: [
        '55ed90c466b6118001001ff8145c1086',
        'fb922ae825d8543d520207d1241492fd',
        '491994f862f9a0c936c83952d1feaaa0',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdkAAqssgr81YIIAAADAAgAAAMBkHiRMkAAAAABaOvMsiwAAAEGBf//aNxF6b3m2Ui3lizYINk' +
                'j7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLS' +
                'BDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvc' +
                'HRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4' +
                'IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJ' +
                'vbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD' +
                '0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX' +
                '3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25z' +
                'dHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTIga2V5aW50PTMga2V5aW50X21pbj0xIHN' +
                'jZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zIHJjPWNyZiBtYnRyZWU9MSBjcm' +
                'Y9MjYuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhc' +
                'T0xOjEuMDAAgAAAAWWIhAh/2lu6eqLoEpktQ+ogzLo0p2lITMcjcsz3yuxSsBkBBut6rVwIBDK1qL66' +
                'FRqdg6BSzE2ewo5JY45F4fh7moTS8Q9L4NR69PB2IpEsxxNslG5p+ow9hn9mt//5D7q91DmgIkTEI47' +
                'yfPv/7SLRiF4TBOpLOjGZiuSe3FRJX3tm5EU16RIzf1JkDSwQrboBcqyqG0sQ7OF06xerVXULFnvyMM' +
                'UmN/wfv+ooho2pkYNH3cDMTvJHTjeQwnaqQM8hjWbKZJ3RUHY5X05cLTFa9SuPPlDzyn6oYi5XyDezp' +
                'G/GMaxwl/mOZGrXE3OOVTpTuRLYajdg5xCkptfMOnykFY78HoBpHiqBLqcl4H7BbQUaUUse/iZBc1Kj' +
                'MiLIqjo0+CkMAbAHw+kt4OjLLbvA+A7L1mx6L0kuLOWKAFPBwNP4hdJ6IpPUszG/lvK3Mk5hBCYeIdc' +
                'WWtfmVtTh9fb75QUD1k+sSn4JZ/9oXk0tm+h0AAAzF9KU5qvchTj3dBr2/bUdgbflKbjAvO1vQ2QRsD' +
                'Xn657n3ao80ewnX84e6wBJ+oJ+92VKi7qPfRKB0Na8nqO03C3yb7XKAYq/U7gb/cqPj8E9ywTGtGpxd' +
                'bQqIplq0QeXgmbiZ7N+F0Qt2a9jhCY1bvze8uTzzCBPil2RHyWc9jGtu8tniIgHDe9IwrgLoLySm1Q2' +
                'm1R/5/oS9ktX870dqFcEwHbgZP/dycvblzHd0VWt3OFd+wIC4z6j+AcxBV01j0BrV6X9BWXA5SKHuk6' +
                'sjXfDlNPDvjAw16rf9+aL7MyVqLEw4cFuXDxYhn9ELM0ohhC0RUI7VWOr+nqMmz/KQklGLgqSRgZzhp' +
                '9Ecp+jEp5Z9TVVJwD36V0tul9t+p6sYS7uanJaCWa5TJ4Yrnc2a9XNtnRz8n7+mnS4Xz68W2SKksSUb' +
                'v7sFgDiS2OV8l5ZYKxCWsdWOayngQAAAAFBmjsQlzMOHxYAAAABQZpPCGTKYQt/ROkuuCs=',
        ),
});

// The first six field pictures (three frames) of slice2_field_aurora4.264 from the FFmpeg FATE
// samples: field pictures of two slices each with disable_deblocking_filter_idc 2, 8x8 transform
// and QP 50. `md5` lists the frames of the JM 19.0 reference decoder (ldecod -i <name> -o out.yuv),
// which ffmpeg 6.1.1 does not reproduce.
export const FIELD_SLICES_FIXTURE = Object.freeze({
    name: 'field-slices.h264',
    codec: 'avc1.640015',
    width: 352,
    height: 288,
    md5: [
        'df7117ca66d983f4f799ead14cd3998b',
        '9211717100244de61c07ec4ceb9eb7c1',
        'fda8015dad9f1d1d63cbedb308b86691',
    ],
    bytes: () =>
        base64Bytes(
            'AAAAAWdkABWsLKJBYSX/gEAAOogAAB9IAAOphHixZRMAAAABaOpUGXLAAAAAAWhakAZcsAAAAAEGBW3' +
                'cRem95tlIt5Ys2CDZI+7vVmlzaW9udWxhci0yNjQtY29yZSBWMi4yLjAuMC0xNi1nY2RkNDE0YiAtIG' +
                '9wdGlvbnM6IHB0PTYsMCBjcmY9NTEuMCBnPTYwMCw1OCBiZj0xNSw1MCBtZT0xLDgAgAAAAAFliIBQA' +
                'b98jInKzPLZdw7hc//mQxe1IrU4EfA8l2SYv+b63HpT0JCgDrdiqG9Gx0lGvyR/p/LJWADjFHsgTgcI' +
                'HzcV0yQyVObLffLd/BI0RzD3OWVQQf6CJyKkEESoRj8AZDiYTma/c5+4HlgFAtZY1VoExr+KREVSDn8' +
                '2F5rKMoNLOyfe1d+khgPb5r7VpG0wyduSxgOS57MHdsI97NdUAahMBw17OEkFSbavBLQ4JQxuevT0xo' +
                'wTZIqmhFLwft6jh+PocCx3lyZUdBNTuFgWs4H2e3GPoxSvG+0dbyi4H9hI4hYrNu0KO0UxezFoRBhzk' +
                '5LGEQ3D69uU2tbewoqIFVm4BNQZlF59Tw0EQ2gGcS6poANE684EFfH/zgondlwn/isoV8F2WBdl63Qr' +
                'u2WzTzAyfQh0AAAAAWUCyIgFABv/fXm5HWTc1WLwVMWOPokGsu6ocWCw7yw42YFovlQgOxeInncY56N' +
                '64ugj4RPqOB20I9TUtbg+z9dh3Zp7TgXXwKaoEhv/12JMCxGVDeRiOe1e9lIHxwBhlhuJTDjQxP8VCW' +
                'nOcRF+H1wATZh8BC7li2F1j9bEkNG7x/MAivEhejpLQRUSCgZrowy6ozQWfYG5/vrlwRZBlRkIaxWPk' +
                'kKHNd63YgOupz1AwqBAlKuUcDlvXW0ZEz/kk4nmw0Ge2jezraBoJo1/dHdSA/jaYC/LUDrYFKuEQ+k6' +
                'rIfnmU6AqW7q+BmypVGzRwh6BjyKGYCHT9zWR6iD/cDAAAAAAUGZAGA/I3/0P8OKQ1psqB7017g+d7s' +
                'ugkT5UPaoAAAAAUECyZAGA/I3/+e/zEYIQAAvieFc7EfEv2OV68AAAAABQZkAxAN/7Rzba5ncm2uC6t' +
                'apyJFyhPSVI4AjXGlhY7wew/p+ggra5Dl5EXBqDgp8tAUONztLAzHszUcrLxuCYnyU7YtsDKE1pRHGR' +
                'Jq6odSGsUNLKwAAAAFBAsmQDEA3//Q+MEXizOggUfyYzXBi053qJJVO2hgPWLBhL8aGurotXbVmmiYE' +
                '2Ze/IhkESfzC6amVIqHuzu31aNiam6W+cQr8uAu6TR5JUGIuKCTMyuPwZ82U4+bZgRcpVAAt7fpKw1o' +
                'AAAABQZkA5Delojf/62bn+PEiTDmjHl3gJsMnQAKlsLGawNyeIqW6I2QvRB1pVC+IAAAAAUECyZAOQ3' +
                'paI3/52q9A5SJ63YqKFwFa4dQkdc0ynzGFplA0fb/0Vs1+o9GcbHomhHWIMcCB4ZVMAHYE5xXhXRAAA' +
                'AABQZ0BQhDf9e/Vpsx38eiqjRE4EswFnoDvTMBT2FZovKjrgUAAAAABQQLJ0BQhDf/3ZRZDrmrZC2OO' +
                'Zzy86YEGW350ReZKOGTExc3pQDkzUo2naguRxvSw96Oniedq+45SCzkvWjHHEmNG75vu2+UNYYIh//k' +
                '4OXXCkGC9vWUqCRLvdIXXxoAAAAABQZ0BYjZEyG/oeQZePlzMWTVZS1fvkq8gVEwQ6sdhOu+qJRaeAA' +
                'AAAUECydAWI2RMhv/2le5K7LTI70sfDx6vx7Ql7LIH',
        ),
});

/** NAL unit payloads of an Annex B byte stream. */
export function nalUnits(bytes) {
    const units = [];
    let start = -1;
    for (let index = 0; index + 2 < bytes.length; index++) {
        if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 1) continue;
        if (start >= 0) {
            let end = index;
            while (end > start && bytes[end - 1] === 0) end--;
            units.push(bytes.subarray(start, end));
        }
        start = index + 3;
        index += 2;
    }
    if (start >= 0) units.push(bytes.subarray(start));
    return units;
}

const isSlice = unit => (unit[0] & 31) === 1 || (unit[0] & 31) === 5;

/**
 * NAL units grouped per coded picture: a slice with first_mb_in_slice 0 or a non-slice unit after a
 * slice starts one.
 */
export function pictures(bytes) {
    const groups = [];
    let current = [];
    let sawSlice = false;
    for (const unit of nalUnits(bytes)) {
        const starts = isSlice(unit) ? sawSlice && (unit[1] & 0x80) !== 0 : sawSlice;
        if (starts) {
            groups.push(current);
            current = [];
            sawSlice = false;
        }
        current.push(unit);
        sawSlice ||= isSlice(unit);
    }
    groups.push(current);
    return groups;
}

export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export const annexB = units => concat(...units.flatMap(unit => [Uint8Array.of(0, 0, 0, 1), unit]));
export const lengthPrefixed = units =>
    concat(
        ...units.flatMap(unit => [
            Uint8Array.of(
                unit.length >>> 24,
                (unit.length >> 16) & 255,
                (unit.length >> 8) & 255,
                unit.length & 255,
            ),
            unit,
        ]),
    );

/** avcC (ISO/IEC 14496-15 5.3.3.1) with four-byte lengths for the parameter sets of `units`. */
export function avcC(units) {
    const sps = units.filter(unit => (unit[0] & 31) === 7);
    const pps = units.filter(unit => (unit[0] & 31) === 8);
    const sized = unit => [Uint8Array.of(unit.length >> 8, unit.length & 255), unit];
    return concat(
        Uint8Array.of(1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length),
        ...sps.flatMap(sized),
        Uint8Array.of(pps.length),
        ...pps.flatMap(sized),
    );
}

/** Annex B packets with in-band parameter sets, one coded picture each. */
export const annexBPackets = fixture => pictures(fixture.bytes()).map(annexB);

/** Length-prefixed packets without parameter sets, and the avcC that carries them. */
export function avccPackets(fixture) {
    const groups = pictures(fixture.bytes());
    const isParameterSet = unit => (unit[0] & 31) === 7 || (unit[0] & 31) === 8;
    return {
        description: avcC(groups.flat()),
        packets: groups.map(group => lengthPrefixed(group.filter(unit => !isParameterSet(unit)))),
    };
}

/**
 * MD5 of the visible Y, U and V planes packed without padding, as ffmpeg's framemd5 hashes a
 * decoded frame.
 */
export function frameMd5(frame) {
    const hash = createHash('md5');
    const { x, y, width, height } = frame.visibleRect;
    const planes = [
        [frame.layout[0], x, y, width, height],
        [frame.layout[1], x >> 1, y >> 1, (width + 1) >> 1, (height + 1) >> 1],
        [frame.layout[2], x >> 1, y >> 1, (width + 1) >> 1, (height + 1) >> 1],
    ];
    for (const [plane, left, top, planeWidth, planeHeight] of planes) {
        for (let row = 0; row < planeHeight; row++) {
            const start = plane.offset + (top + row) * plane.stride + left;
            hash.update(frame.data.subarray(start, start + planeWidth));
        }
    }
    return hash.digest('hex');
}
