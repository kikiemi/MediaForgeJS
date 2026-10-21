// MPEG-4 Part 2 and H.263 fixtures produced by ffmpeg 6.1.1 with the commands above each entry;
// `md5` lists ffmpeg's own decode of every frame in presentation order (ffmpeg -threads 1 -cpuflags
// 0 -i <file> -f framemd5 -), hashed over the visible Y, U and V planes packed without padding.

function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 6 -c:v mpeg4
// -q:v 5 -g 6 -flags +mv4+aic
//     -mbd rd -ps 60 -f m4v sp.m4v
export const SIMPLE_FIXTURE = Object.freeze({
    name: 'sp.m4v',
    codec: 'mp4v.20.1',
    width: 64,
    height: 48,
    md5: [
        '8cd4f6738088d7bbfc6e6290321363fd',
        '97dda8182b5259ddee01d08205fefb5a',
        'd0b2e02cc6d242bc9fc3919063a235d2',
        '654fc8e082aaebd47cb49b35094f9629',
        'e8af26f051f97147cbecb1ad50e56ca0',
        'f4d055d3f3fbdb3c381961dfc6ef86a5',
    ],
    bytes: () =>
        base64Bytes(
            'AAABsAEAAAG1iRMAAAEAAAABIADEjYgAzQIEBhRDAAABskxhdmM2MC4zMS4xMDIAAAGzABAHAAABthB' +
                'gr4RoPONJGUsAz1rQLf1qf1rc9/1/5T/PXcpStLLY840OoXq2mf71myTmexlNI2qV+BgKqtU5RBa2Ie' +
                'Qq3HjBOlEKZoIrGCOqBWF7X2vqgcXpG0zZaNv5sUKOyyapBkDfNMDObvwYDYjooDwv++XA4FN1pqA8L' +
                '/5p+CUXUQPpGweE/74IuOEAPNMgeErw4lnNxhpv4GC1kC4d/aD6tT7Za0tZ//fjcjD4e1geRkva9i/l' +
                'vsjqYWNNt0CkZxKmHOYob/u5JNsiM48AAIlPhdAOBCTUepufEEft5fc99T7+bn5/2z+Fn+zZTfEM48Y' +
                'jxU02xNbinduat3cm3Nmbl3Jq12UMYcaZOEOapVsqkg+0cJmg+BT75sf1L+qYCsycwq3tkLLKWNB68o' +
                '3ohTFDLSpWmg4VtCACJv/l1TbFEBWy9wrq0qm2qPgJBYbTj/2b6RKz+ouI0LSHAVnyvuIWoj6YNH7IK' +
                'tXGWf9tt39/ijEDIif4XtAYUaIiv68UBe8AAJFNguwbokCAH5aHgfgicUKxBBFUqANAaUAbD/oMgHBa' +
                'oD3hYdV/4ShJzP5BzPfZaoMja1pvLJ/3/Us/785Cr+S85UVh8M5YyDgOgwIofg4fA4FUDgOjjBABTgw' +
                'gA3ARRwiD4FWsOQcCqUlQgnhemwt+Aal+pHqRWwmVCC1igGLdLh9VQ/A17LBv/uZWqOLt4x+qOuO+Cg' +
                'EJiFvmmOjhpsGRNFX228a0fAyL0D9rNv71tpvmFaT07rgzbL/p/a0z7N9fqLmrzc8HuJ+KdAxu5JCrc' +
                '7zjO04/AACZT4TxIA80O8TAbD1PpZeev99P7n57cv89dUKZSiclnY8beH2AYZRs1BgGVQGWGfAwFWF8' +
                'Az7YLtx5ipwDswsVsJi8fYOE7QGoXa38eAibFGSq8qnCveyUttpY2Hp0yDgPqByDFo4BlAOSAaA02Dw' +
                'f/GH4Gw/AsWcLBx0tUcB4WAP4DHyQgD4FNWKomY1+SCJ/vJ9b/0jfm/T7JaqnP5/clnNIxgR0oMOBGY' +
                'YHjHRBa80q96/L1OSFm3fAq59hTnriXe4WNSYNiJ8AAKFNgvB0DgUzQEwcHZmGREGYTMdA4FM0BMHB2' +
                'ZbIiDMJhKgyPQ10Jw3BCRCQDw8Aj4Hy4BFlNNjagvzLbG1BfsW8RBEXh3A0DF4AALFM4KtZkRBmEzbI' +
                'iDMJg2wjZWBbRkDlLmU02NqC/MtsbUF+xTxEKhCBhtoMGtBygWMAAMFNARC4vVNKvZv+bFPYo0ObUDl' +
                'B+EESmCwcq+dU8AwzUSg16k42HIIIPCQCIPEf+4PmQBIQMD5ptXO35Xdq1hq0FoDUDCMPWx6CCEIQm5' +
                '6Kr5X5T6WN8VCUr/i93c71qdDw3w8/AADJTsFgGoHC9O0xuwPkrHF82LhkpgTDEvVNhp8wDCL03w00w' +
                'GcEAEIu+Xf9aBvfNIl1MBYBIF7GA4FGPB+01atkv+eqT65SorcWB4n/3MMAANFNAK4c+Ni55wfj1IwW' +
                'Dn/OqeFX6iUGspOcHQIIPCQCIPEf+4PmQBIGCmBQj/7OZfJl+iI2HFB8b/3OA7oKYSE6vy++HHFKIrV' +
                'tYg5UVJ0AANlOwSwOiQnT+Y3YOFbXBtsBYKYEwwL03w01wcC9V8NNMBmBhEtmJP+tLJuol1MBYBIFKT' +
                '1BgDADwPJUvt5G/4qn0/hJVRR2iIOcTfX5EIKZu8InAAABtlDwUhYKCzV//zjWz8VA8P/7xV/9nAZjn' +
                'qOqI3b5pxeIysS41LFar9YwuH++VXsEf/oo2t2Z4Mwv+VyKx8X+oHYoL/YBmD0eAX2WDtlHDsa+spqq' +
                '1eWhCivKIw70FEum0HwoAd8AAJFBcrFxsDo8UwGZ8PPqwQ4CoU+irgH/b8Gb0dPmCNcYUgySgaHgFVH' +
                '7QUlwRMOhV/+v/f98uqgv9Z9V+qMiuAatHoHOAXHS5wGQAhgyabpeCo50DrXOk3hLVAfLlZdPqKrLvF' +
                '0+3gNpd0S4Oy4DgkX47myVQOxLEowJQNboIA/hfAPqvAgAGjqtZ4FDQbGi+SiTtUDoReCUJZl/AAChQ' +
                'XKoEZE4S1YGwhpfg8X/7uC/4vA18CgZyN1KUOH8rCUoeFX8rA18ClGHlYGvgUowLx8DCOPgYCvgfL/+' +
                'wDAYIIPBwE4IIPDwEIBoPFwBIMAWAADBQXLk5U0KXBDVQEPwBqutwfAf4v8A8SFTLAKOjIL4lAg/A8A' +
                'YJZfBHVBAEtX1odeVjgnVF3VauLD+QGBVF1F7AADRQXKnDlxcrt0fAXV4DxUAWX0XBVwOfLwUSqarLw' +
                'Oei//8k7xsnCGCADwf/WAcDw//iJQPF//IZCSEKaJIQE5eXA8X/7ngDAeA/wQYdA8BAcgGj/wjg8DAa' +
                'gw/EvojKVQPA/88nJnAUU3utnUAAAG2UWBSFwxKflxfd/71rfR3xbqsGbLQfGgEVJcrL5NA6o3JYpz9' +
                'BgJfBRLiNAeG/8XBWwcGM8B4ffHqhV5PG8EVRQODutSAdqyovNDq4OkjSAFOOgZBALgFPwAAkUFwxfB' +
                'lN+0roMBGtURpR2PwOtqYDDqrlw+BjNilUz+NNc3GwUw66OqB2AqVZgKuXj4GEcuBkvm/WiLEzxLCEo' +
                'BtHymSgo1QjgVicMlcCHPWKxHqqghwdtjwd+lHasDu4p5FajQYDhcDNhl8SAhKQgj7+AbEsulo8HalW' +
                'rilWDNKqPLLcojKQeE/8S8GaDN/AAChThovAQ+FXVj4GEcfA8P/7qgYYqx8DCOPgeH/91QMMYrEb4FP' +
                'lTxJAOB4P/tCADw//iJQPF//IZMAAMFBcMQHhLHw/8PS4Dw/VURvqvqfVuXP+V5ezCOqKJV/B/P36w/' +
                'HV8iVAeb2XukgX1N31knvUDPlOxcR7/zWgxhdG0VErwAA0UFwxRRQZdWwDLA+bADypqo53MRCPPjILX' +
                '8u4rVfoifn+prq16sMS4v+Pi71okj+Kh9OK/l//Kvd53/M208Py6q5VQKAuUj+WX1k+rVqVQ71Rt8xt' +
                'A4oJH8AAAG2UfBSFwxe8XKI2vW2rtBgVJfo9AqJYMBIxpemLBHYBgMcHjYPCQB4PEf+5oL4HFIiqALq' +
                'WirdaBmh+k8D4f/2O02omyvMBgKlwEwY0wAAkUFwxAcTtgqdHmgTCHoGeD/+AwKoMuh82WD5IBqNATe' +
                'FX9//h9FZeruKlRd9X+gW921e8AwfLhJLgUIkCWJWqAUI+Ly5TilQPVSjc1gDGwXj8SqB5TFOKghgeH' +
                'wl9UjwfAoRKEu4CjL+0D07ol4CoA0Gfv0eqODsfKVaq4oA+rpcr8DAYLhGU5igStWLwNhkAAChThr77' +
                '78AAMFBcMQ9Hw8V1UrUz6rZ+Kf8sHVZJ5sH+F7GcUAcl83OKlEF4X1AHGmwL0D5YXqYLyEL/x7QLAwE' +
                'C4GFlloh+98Hfj0AANlBaDFY8SRKCEJIBtpcJBdS/+KbFXLhYy8uHpcEIDv/qBEg9v1cZERWp80SPwA' +
                'AAbZSYFIXDEO9YTNLApQNeQAcB4eANDIDjOpxHRDwDdAroHvg8P/50Hw4AcL4HcERvgjNAqQNfEZbVY' +
                'PDwCI/NjpP1KDFgj+bb1R4Hh//Xxp/AACRQXDEO2cBVIh61gKnAbAYCQPiQBY6D8FVqkCQMI4MBMHxP' +
                '/sKuOhLL8HwQh4DaP1fh8PgP//4fD0v+PJ8vHkqseRuyTREjalwHRJLsH4QKXA2j7/i8fA2xX8fD0u+' +
                'p9C8eX31Fat9/Y33ACAUdHd9imQdb7ikRC+6XdjKhQDxEAj4RgCwOY33e3ojLlwM2W6DxH/mrbAKfwA' +
                'AoU4a++rvewAAwUFQMQl+CAEP9HQkCX9IPldFwB4PAwDoNQeFgFwDweJgDx+DCxUDAfH0BhFCEv0FA1' +
                'hKPVfhI+DAeV/8XD+ZKXD9QDbqvsgHQbu3YoRYYQAAyUFQMQN8HgYCkGEsHhYCEG+DxMAuJIPmwA6ul' +
                'xf6331Sv3/XP+vrLLG5YxXAegPA/86kGUAwHQPAbBgPCIpEYegyhJVCkC+Gd43xKK0AANFBUDErhcX/' +
                'EYuV/SerxJBgPBBB4WAREkHiYAtWLFYMCEJfmxKCGnUgoRfQQlagGUqFYIXgO0vA6Cgni4R7QZhRMo9' +
                '0dNgEvwAA2UFEGIKwDQeBgHwb4PCwDYBoPEwCIlgwsH4KAf9gIRfvqo+Bz46/G/XnLGXKQYdDtWByLj' +
                '9G0DHx5QeB/5aoCEDAo6q7YAZ3+L/BlHcI3wAAAbZS8FIXDFzwf9AqykA6rAkaxX9nSxjkUbf+AqCiL' +
                'ugy9BjoXwOKr0daxs4Bcegw6LwZFsEkC0Eo2O/p8ZygQHgKPwMjwEJODAEvAACRQXDEOvJgLKd7jQ9U' +
                'wS/CMDJv9b6B13anTqGwJZ8Sq2DJ/cAg8Kv74liQEL1EsA9SDKFQGx4I47s97LB8JeAd/NBRKwJG1Zd' +
                '8eK1KjxeBZWpHn+MjxWXfTzFcQHJS7zUsTKcBi1SXF6fFMH7DXAYAgDt0DsqdQDFGf8jwEJnl7QZ7AA' +
                'ChThr7778AAMFBUDElWuEOd3GO0shW8GHXmfD5HR8LQOAwigc29UjoD+1vYBtT0dsk4Fj8o2tQTScdg' +
                'ygDnlPpegwHN/5YGETfKS1okC1/AADRQVAxLatT2d3GO0shW/RL/RFH/ExeWnB2PQYdVTZyYr0D3E6s' +
                'FEtiI8FXN4NQUreMgbuIACR2DDznrfKcB4OAP34EQUGzSN8=',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 5 -c:v mpeg4
// -q:v 8 -g 5 -flags +mv4
//     -data_partitioning 1 -ps 60 -f m4v partitioned.m4v
export const PARTITIONED_FIXTURE = Object.freeze({
    name: 'partitioned.m4v',
    codec: 'mp4v.20.1',
    width: 64,
    height: 48,
    md5: [
        'f1043bea016b88016db84fada24db2cb',
        '1f896c88f7f7a56162ac7fc981a06cea',
        '62cb48644e3fed2768ed9ecbbe7a520b',
        '3a1bdb299fb8cae9b3479fce3426eafb',
        '601fa8e7ff4de82fc4f5d0c53b1a5501',
    ],
    bytes: () =>
        base64Bytes(
            'AAABsAEAAAG1iRMAAAEAAAABIADEjYgAzQIEBhRRAAABskxhdmM2MC4zMS4xMDIAAAGzABAHAAABthB' +
                'hDC2YNHBIO9YALgGsYz7KGqBFt3bvJmZi+0kyCtnwkN+z+zsn60DAVnxz2QsHAFy0NlHeLojrfYDKGe' +
                'jj3gU/qzzsY1nCxrdhotQ0PA5sP2fBVgpy0FYDIgbqiFg5BEEAcqAICCIoMi6sFo6HXkmFX+aoK9yFh' +
                'brV3Ji0pXo3G+1cOqRpk9LUjOemfknNEXwgtFf1JVeSWqRtKh1zAACKDFRrIAuGsL9jkqDSOs0dtYUF' +
                'dYALbolCMra3jSnOqLC1Xlm5UVimblhqntA4B707qbi8kAynttqKSRvtpI5qdBlLd6y1/GPKcnA/rTS' +
                'hkskN1aKCro2pxmcBVfnWPZn8U7AZEWtTGi2U1Vr1bo3fmtyqIrZ4Cv0CCnhT0qGwyIFav7fP/K95zu' +
                '3qwg7ilfpVwPQ74S8ASH5cWDlSsWiAi+WiD3g4HHByWgqFCnhXzh3cSF8mwrUX+AVy5s4pzcqjcpJs6' +
                'hIVHwZSDdHIMsDDYGUqIWCCCmD4QSxEWB+IoMNurFp5qKdEtnep2G/NeLcnARaqVXyscZOI9WigqtW9' +
                'pzRCH3opzPdUZodYtu7MqoOsAzkqm93NWXYyHdZ1vLn8lxTzlX7MK42jpVbORazqL706QdRoDPltuZx' +
                'S33d6tMmVTaSQKAbgQFBaWLKSwbp1Jb3hYWKS1SGyjvFyJLOAxY3nVTXvN+U7AYOhyxmMDmXqKrVSt1' +
                'bdO80FOCKWgYAsCnURQOQNCAWqA4HKEC3VgtYHiq+QRb+opO7m3IwtlD3ZFI33V1mqRlxeyXeLEweZW' +
                'V89VHFPs6rvP4VTnL3Miy7MIn8AAKIMKstigatZZsXCZipRsGg9rLNigrrABZTlTAyLBmDlL/kCYGRY' +
                'Mwcpf8god0peIwPCQCYMGmA+XAF6RaRGGRuMgl+QfIIRth1RkFOkWkTh8Bagr6GRhwAAwgwtUeGARgz' +
                'M2aHA4CMExhaXBVjADzDNmzY4HARBLrABQZBmGWsayXV10FN0VKx6k8oUt870RPkhowJIMIgO+DBN5V' +
                'm/XUr9NEoqBRJ9TiSPh9syNWN53OloGEjdi9tgiToCGwhjrPW1WssDIGTYPjwA4OBBEIHhf/EHioAtW' +
                'D5sASPwYOvgSBwdmGBGVbg3bRm8JAYVCH6JleZnbKxNKw1/EHCYtwnVq2PKFO871BpIacJIMIgO+DBM' +
                '0Iau/kUNIUGmgfH/+x3RALm28R4WI0S/8hITtjsuz1tbWWAp82DjAMCKJQMBEHioAlkHzYAcfgwdfAk' +
                'Dg7MMJf7iLEZKSCsG8xgljptlns2F/2gMLTkYVaIs1crpCwAAAbZQ8IIUoXC4X+ADxrbVkuAyWetAg1' +
                'UjcNfEal8X31SeV8l6zZwXgtp/vvy95+YuO1CfmHSrVFSAotyiMDJAwXRqNAzFF+PQKbFHFM6I5hMhA' +
                'pWlCXqYiy2WXwjy75rljTfEPCcCCkC3R2BYGIYr8p9/24p9Pa3gH/dV5VHC63rU51WAUXBDoMBxWpHf' +
                'oJQl8Y4PQUWDvpexxnhcAW8AAKIBSi1wq/AB/XDSv7Y/Rg+X/9z4GqkfPtVI+faqR/1QjqgKwYiQDUH' +
                'g4BcIYPDwColg7wBbAADCAUoXHhf4AP6iwf+HYNv63FSlCJZdAYXlwk0eCQP1bMHxfU3IGc93/4srkB' +
                'Veov99tUn+DFH6LuX46838dRLeOH4kA8H/5iUDw//uXA77i8ugKMfJ1fgYYiQDCSCiBh8JKuNg8DAQg' +
                'Hl+VrYDKZE+Axx/AAABtlFgghQxBcLhf4AP67fUR5F1+AREcH0YAvVX/t9xpkd0CVHSAHx//fB56qc9' +
                'E7KIRugRAp81xZpppAvwCCUMqCHayCrXaZVjtvYBygWVGW/LxobgY41gjgVerVAb93B3GLWUx8vH2Af' +
                'VbPfHfhHSkFBDzsbgHWwMdjN6uzgMx4R3VUPlJeq42X+233dv50RpzEWgwi/EZ78AAKIDFGrhf4AP61' +
                'hHAYXin/hHVAV8Mf+EdUBXwxWqSjAvEoGEcSgYCqoHfDJ/AADCAUMQsLhf4AP9Dz6pX5SqHivzF9djL' +
                'MfVA81TtoKnmIFBJrTUiebqdu2DIdAXoKpODEk6ulzCk/9UI8o65ZR2IJ31qr3tH6vFQi39np1Pwyr9' +
                'fjoD0BRzss3/9iZoFUefAAABtlHwghQxBcLhf4AN9KDiGTxSVgyX7aVWDEA7D4HjoAfmAwEgfI/+x1r' +
                'OJ9aHIEFaIGN9B63/98jNC/gMH7RaXpQN0GKHA9JADg7wt2+9qtXyeVW0CkLRp5WqHpcrLmh6q/7VlP' +
                'lAXl4+A5UxfipX1pUB9UrAz8DAKkCQjPEVjvtvuYpo8/AUyppIqAmI7n8AAKIIa7i/gA/qePSgMQAAw' +
                'gFDELC4X+AD/W+Ufy7LK1tFoi58qHXAJHsZwtHYO+fu1MBDws6H0oxCpWqLi8Sd8XeU1sGOKlPhKA7b' +
                'gFR3EH9cAAABtlJgghQxBcLhf4ANdqDgnSFBaI0KAZI4dB+WCPUojUGAqDGB2mLAVYjVpGDw8AWAXwH' +
                'Y3CqAyVwOCfofFqQRQZoGRA+JADg5hsHApwJgxmYr/ni7APq7FSpTbPKVdzVaiWqIziQl6X+xWJWAfV' +
                'WK1SnVCn3ZP99VDHOskgHRHxFxlj4jNJsB4iALjQZ8yxkGDoRweV/+fgxhAACiAw13H/AB/Ume+ucAA' +
                'MIBQxBcLhf4AKIgi8EIf1ouV0GRBmJYMoCGDwsAeJYMBBWLPAoVQKcfA+VADy/A9aPv2eL2lCvAPjto' +
                'RwO73iI8EMGBQAGg8LAKhDB4mANLwYWfvvzl9ZZyyzseoBgUYMBoDqgRwbE7SkEJHmkoW/Hn6179SR5' +
                'eCgH4MBgvBkHxZQUBfwDg/B8r/5+PP4CHnx57qkdgezzYFs4O2Gz/bAShJBh4EEHhYBESQeJgC1YsVj' +
                'xWCm/zlHV5VqSgpO/4DJUYMTjwHgv++qC4G7ZAeEgD22GwQmCN',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=70x46:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 7
//     -c:v mpeg4 -q:v 5 -g 7 -bf 2 -flags +qpel+mv4 -mbd rd -mpeg_quant 1 -aspect 16:9
//     -intra_matrix 8,20,22,24,26,28,30,32,20,22,24,26,28,30,32,34,22,24,26,28,30,32,34,36,\
//     24,26,28,30,32,34,36,38,26,28,30,32,34,36,38,40,28,30,32,34,36,38,40,42,\
//     30,32,34,36,38,40,42,44,32,34,36,38,40,42,44,46 -f m4v asp.m4v
export const ADVANCED_FIXTURE = Object.freeze({
    name: 'asp.m4v',
    codec: 'mp4v.20.245',
    width: 70,
    height: 46,
    md5: [
        '5b1a4f64828d62a7afdfcb977826e9b3',
        '365476a4625906820783c350275d9b5b',
        'e23f9273b3fea7123361a84701a5d98d',
        '161e84cffcd4143a3454bafb22f11ff4',
        'c197f46c2ab7c5da437e0c73fc1c4f31',
        'db8ce23762d386ef8cf2e8ac2f1ac0a2',
        '208b61d517a4007a70b779edf92d99c9',
    ],
    bytes: () =>
        base64Bytes(
            'AAABsPEAAAG1qRMAAAEAAAABIAjU/56FCADNAjQF1GECgoLCwsMDAwMDQ0NDQ0ODg4ODg4PDw8PDw8P' +
                'EBAQEBAQEBAREREREREREhISEhISExMTExMUFBQUFRUVFhYXMDwAAAbJMYXZjNjAuMzEuMTAyAAABsw' +
                'AQBwAAAbYQYK2EaRJ5V5tlZTqiDe3du2TMzO22mpOkJxO0EJn2N7O5P1rnWZo57JfFi31IbKO8XIhgz' +
                'NwGHDKkce8Cn9rPOxrWcuNbsNKUNKjdh8Z7nwYtBVjkFYDIgVaiKK3EwgFqhEoHKEC3VgtEBCELw+8H' +
                'jdmlhXuQsLd9dyYtKV6vo3tXG1Iw+Li+xtIr81mfkijYN/RtqKdU9y8ktlRSodc2s0IwhM4p812S3KV' +
                'syzYjll2WWGq4bNgogDGp36bktkgGU9ttRSSfttJI4gkxTRLb3qtr/mvKcnA/rTVxssksR1acW6NnlE' +
                '8UUefzrDXs/inZ0QC1qZ5TKaq16t1G8KPfZz9yJ2ZFkX9AgpUI+96VDYZdOBGXj9llr2tldinim2rDm' +
                'eUyW2KLIpG6JDw62JwPKggCV5W2qwcT/2mtnWd2/l2Z6et36lelUzvFyILzGpleXWr2TblG+XNy8ubm' +
                '83LDVkpCNFWfg7BVjnjEBWUfqIoxvU1an7iJQOUIFurBaOB9hbQhs/UpWG2mPFvs5U9YVXzI4yWI97I' +
                'oqi1bNOAxBBEZI2y2nbkbb3Gtv/5P3vfNDi3cX3MK1/y8nCyQ6Nqi/9sznIp2GlpLS1HSq1ZFYuN6RN' +
                'jVlIJSrJv85LsyLt23aimZLbbTUjxsyPAOf6zfd7+NDdXNLYVFhZ1SpDZR3i5EYL8UUSG8UpmPeb8p2' +
                'dD6tsTzBbLaivJVK0q206b2fBlIKcc9YBkQKdRFA5D4cFqhEoHKEOurKT2mEJJcU8kpZ+rZJ25+yNLZ' +
                'SvZJq22rrepGMDpPo8T3U3p7dkau+iiz2qNu2y5SyWTsvIsvrmZtAeA8zFPmOyW5Q9VyyxHLLsspJXJ' +
                'A4EIRgeFgDweK/+WQfN/+xaOpayXtqS3ND7I3zkb1ryj9kNKUMKjVp4VDKtU179ySWcyoot3JbKtF8t' +
                '5VoiRQiBPVCWXttTarZl7sAvvLJtksK6tsnYvUaOkbAACpTYLwfAw28BMHKXwygE7HwMNvATByl7ZQC' +
                'cSoF9DWhOG4HEQ+Bg0wHy4AljWOti/iEF9KIgzCZlFw6AqBIJxex0BUCQTsGEegwd/AkDlDj8Imc4a+' +
                'N6C+b+N6C+uEZokAyPQV1DMxHbbKCN8AANFNAREydjzGZu8s6gpuipRKI4+aUFrfO94VfqLhowNhyEE' +
                'GEQHfBgmCBpJ77c7dXtq3DVpMDUDJi/6UIY8Hn5kauN53JS3nk37F7bBEnTjIbBwHRKBgIg4PGwYJBs' +
                'DwP+KB4Hhf+8HioAtWD5sASOg6BEkA8m+p7ra3EVwlBbAXoIKTxcBosu0tHPVPKiLEXJCdmEQBwQx4P' +
                'Q/A0yWlhYpDz+cUlvBvkNUiEI5w2LnguwYAwHhP+UHiIBEHzP/UF4BwAysetiUAePy5iZfNCBy/lula' +
                'pr97ZciPTREGTGTfS1D0M3tA3BhyXAxsHZ8GCQYqwDxI83uar5ZwCjZqAwqDSGYSwYC7YEgcoMMmHbf' +
                '9ss8i6tKbgrDAGHX6IYksqlfMzC77crS17G2MEVTOc2kDIqDgQxGB4X/zB4qAJZB82AHYOBDEYHhf/M' +
                'HioAlkHzYAc6xEEX5rBeEoFaDgDEgEWRjgPmwA7wAAAbZR8FIGwlpxDA1JB+wIBb5T4s+IPbOKWqVZz' +
                'Z2Lr+vRucryX458wrajWs5d9z5bLcndylWc3JyocqAyMS8Qvj+djAKrhazpb+NjlWyoUyKN3mRRCtZG' +
                't4jSaSbqVpkPqmnq23+X8/fsq8mbzm3mTnerdRTHBL5pN5iSWKefU8q0q5YoD3Ua3V/gwmHB82ltvJV' +
                'A59xZHKojakPJxRi8DoCZEBtZkvYmMtqbcY2+3kvVM5FC/ENk6iFanhJhc3ml/hxL7dxRo57ZF/IpzV' +
                '4Gy4JLL1TKtpW1++l3Q8ud4ollxT0Rbzl4sTHtEb492ZngRALt1Ts+pZ/JbCq3mFQ3JVhYVMTVqxu8z' +
                'mzb1eYoRwXiJRMyf6ef0snagijktU3vUfOTnCuDMiA2JPD38VtKkqqMar9daUNjmW5O/9pVijcnKhyo' +
                'N6Rqqx2mzydlTbir9a/zL0tzkUTsnb2ydGxKeOKh9/R+wrA1S7GqrZ/Nbxutq0+TPqFG7zMUd7edRT0' +
                'XfI9TJy9UlVfrWXfgYuKeFmXN8W9EW85ti0RyUiBiLEggtTsks8OVGrZ1uzeLt9DzlW/eWjJzN6yOKj' +
                'pXVHYvQ8W6tnCvsG0DF4GxgnEmqlAKdgQFPrvlHxz2zin1Ks5s7Dfr0bnH5Lo580rajWt5b7ny2W4vu' +
                'UqnLkXQ5UDz5eJHy/nGAUwF2dU/jZarbUKZFG7zIohWsjWFiLSTdTtMiBVU9W29l/P37LMmbzm3knO9' +
                'W6gxwhWi4cS9xSobUyb1RslHCgDO9U3ikOwYTCw+bL+ZOUsU4WXg3y/AzdKllE6oX8DCcDaOiSqHSRV' +
                'WS239/MnpLVtvavZOTsQ9XREZkHgf8MeAxpOCN4Hzf/mB+IzYlpEg432Vqtrf7JZtNyVeKEXF+o1jo1' +
                'B4GA9HoMbTAj/B82AJFsHgkb3WW/z9/+7JVg7vBEqDhCDAqVpYqVT2S5FTHAYYYSk7AACpTgHJ3ffAy' +
                'gvB8DDbwEwcpeWY+Bht4CYOUvYp8O9DWhSDEXAwFlQMGjQOUOcAANFOAgFh+A598DIEtgejj08Wd51d' +
                'TxHekyQMOQYkB2gwRH2EdY9b3iMloSgaeCOP/ZmY3yZJJFHkUWgJTwAAAbaQ4KkDuDYdALCxGEwWA4N' +
                'yYHthXoOPA5AKiAFsD+wsBwWpwiBwUA4y2NgXwPzFITjKGgRw0GIP5AwGlBvFwMXf+qEqDy0DeD8vVz' +
                '+dVWWl/+Z/ZhODQe/X+h+LQZV+35cq//1VKaX/UfEeS/5q3GGGqdB8CArCArB4CBD+Af+iSDAhgeU8H' +
                'kEpSBoDl6CHG8Pg8BA/g8B/mgxeqVAwlhDnwhQvBhGqn/+9Eous3VW8NAAAVK8H8GwDggiIjFwPgQFY' +
                'BwQRERi4HwICsHgP8kAwHg4A9UBMHfeDwEFODwH9+Dwf+qAeDxEAaDxcAeDOfwAAaKMEw4e5ubmGMC8' +
                'DEHgP70HgP8cGoQADQYeAygvHo8BDUjpX7FIHsEf0Wf/9U/0nEoSBK8JBdB8qtUKp/Nze3WJCdwAAAb' +
                'aRYKiHsC4dVRKCEpBRUA4SfSqIJYkYrEr7FUK870da0tTIBwMCgAMB4WAVEgHiYAtUxwGJggAGA0LwY' +
                'uCF4AwvVj4vVj6/lViQrA+Pvz5f9XP+VpKtrFcrVqx9bioRo1a2o2gXEeoQfGgCZ5UXo62BWyAWoHIy' +
                '1AZO4P7AM+DKgbyvKrAMCB9KJBdW1jgN4HgYCUGHwPCwDoIAPEwCI+4Mng4g6GjK3UKR46tXQMsAZ4B' +
                'BKGQd3FHlogDwlVfHypWBsuVfAl6lAwBcjv1axCxWt6rA63sA5Wh14yOqyVMsgY4sI4FXhzYkfAOCF9' +
                'sIQlWJy5VgwAMB4GAfBoDwsAuEBYGA0XAw4CkG6Pky4ElgZsDYKsHxoA0FEXsFQir0dUDiCA+N/7n8E' +
                'QUDF4MXAwlDr8Ho8kUYXT3FW7WtmEoPAf34PAwE/gYDNAgKwYvAOBh/YXiTAPSwDmdy4dB4D/FB4H/b' +
                'oMBiARosAOgkCTJz/x2CjYbLwUdYX/wkBvaJQ9Esde4EEIPmmPBDL/QYPwAAVK9IL38AAGijXYUU8XB' +
                'CCCJQQR9BLErFZd/VFBR+aqi8uVtysDysSFf1Q/m/mc/nGQZjExOQ7VxX4FMqQqwfN/+9TcDU+EMC4d' +
                'VPfBT/QKgfNgB1KAJwhv2UDNLBZVVUTsitnf60DIr5wT3T3wCAYICsHgP8kGEgfK1Y+LxJA6q/ffBRC' +
                'S37laVYwYAPB4GAjANL8V+lnvyf9J8fMtCPvxq/AAABtlNgUgbE4KdkEQFP1WIIMj72gicEEQBAUd4N' +
                'l0RaIoCxE2ORzA6EAsJS0t6MFHBmfEwMWMDbvxALS0DXYIHTXFClQpKyxSWdIG214cxngelhZ3tG3e8' +
                '4iRkh8ItZz9nJwboEXecydtWnFucRrR1xN9r292VZqLWr3Le/vJi+9nZVKJfXgbDGCK2BoEXrI5Av1c' +
                'DXByOBwo7xEuiUoQtFwMpVg3AZT1KH4MN+90FUoA2BoDRZ1QNivnC0RS0+KwbjSLujhSWiB2DjpRzqj' +
                'pWo6o6QCMGD5UNlLYfDkcgidwPlKPnFCksUh6OFJYpEThw4ej1rw4760Pb8pyc6xSuB5ero8WDp4Zwf' +
                'NhzA6UATBjY2G4O0GFYGwtNiCIMDoPiwNxyOVIIxYoGfRUG2l7NHwKvqcQQZH3tBTcD8Pg+UdUDYr5w' +
                'tEUBbbVNCDFagDJYOFPaHSlTzneI1+8PiX4kMTLFPxALS0DXYIHTXFClQpKyxSWKQSg4HyXzUnctXaq' +
                '0k7MU99eXFt7O2qUS+PjLG/VyTeW7yXtWuqObEa+EnCSuA2qCnbBEBT9ViCDI+rgicEEQBAUd4iXRKR' +
                'FC0TJ0/0iYestcLcjEls7xTVHeG53s6t1HHmAZQ0Nu/EAtLQ+7Bx01znVHSssUqOkBRprzIIrTeTfbP' +
                'SylFF6GWLyruC2J/f/0sWy3bKHF+0BhHpVOXiKLjZ2JaT7Hk0ur1nM7A5xIX9bq2Fe9nUdWX14FeCwL' +
                'wWBYFwWEgeWAGiXfF4BqhUDDr/gg/vwPqy6F2CSXX9o6vWs99YGOBCEoSvj7FIQQgiXJ5R7w/L5fea2' +
                'qPe9Kr/kUl/9V3IdL6JKvk9NmZqvv72tqQP1MI7/q1UU3bmjznmgNeWUQZPwAAqU4CL774vPsAANFBU' +
                'AQCAHgP6MHgYD0AwFOJIEVQPmwBIPAfxIBwPAQJoN4Sx6pLwgjrGlZczoPjQBYMq+DAgqvQegwHSwHz' +
                'f/sEASgYSVQQS/wlQFCB3QN4o5v+jurEwVMHgP3EHgYFsGLgYDIBoMhHwPmwBoQQQvEoPAwEoPBf5YI' +
                'YHgeEgEx5oMpBgLqbFGAfBgMdaMaCiIQqYMEEA4Gg+EseqarHWNWM6DEgPAf2YkA8BAZhALy+KqrEvL' +
                'rVVLaD4sAODKy8GAMLy5sGwdTealB8WAHEkGBQfBh58G+BxQXFxeJYMnwSt3ONjrgMdCpg8B/Hg8DAk' +
                'g0BlwggRLgfNgCweA/zRLBh8JRcCCEMSJ8vUD4EJRbfaB0uU3R0LqJfgZQXUf3M8BhsXCQDeANgMAaJ' +
                'MAMVAfU/9VYMB0DXElVjADYVRBZBjfwR6ErEFkGN/BHoSioGHDAc/GMBgkYMOGA5+MYDBIIgwfqg4bG' +
                'GAwSgYIOBSD8CKoEf4PmwA78AAAG2kmCkg9gWDCsHvP/84Di0lHYfFojeBigGSOA4nTiOiUCPQK6PKD' +
                'AVoMaBzZEDgRGTQ7xjUS4iiN9oCYMkDMDictBVCPCqAyVwN7BxCDiAHEIHRFwFUiUtYBfAQgZED4kAO' +
                'Og/LCgDaMyDuwkBwTA4iBR7zCxsFSBqNpYDw8AXDYKJlTrdbBizFLDYGgYCdNA/oYGEkGgNBKAP9+qw' +
                'D/BAhdkVqx+oUX6vR4qVS/8Iiq/vx6mirgBIPAf3oPAwGINAeF/0wgAwKoHzf/H4lAGgGgGKy8EISAa' +
                'AHiUJeX5cCDPwDxeq56l1Ve/Ms+r1T5TK19QDHAQQeB/0Qag8LAXg8BAbgwKsHzYA8ISvwINtA8EEuV' +
                'KmJ8uH1rG9oIBfe0FTURof++JWQelyu1nL8oEvwwcAAFSgQQN/8FIkBikM/QAAaKN+EMSVUVKEYuBhJ' +
                'H4kfEvFCgdL6zhIDfB4GAfH66pDRYJSoSfDydYAwgMAxcDSqwDggKhIAPuCSqHoH1IN3/Vf7AOjvR1Y' +
                'zSZIGQXCExSnSAi/AAABtpLgpIawLh+2t2bzc5FK8l3Em0huKObuSTWbxu5zUmJo4DiqNJmO0CudSDv' +
                '6I1FQ/Vqy5UI+KJkYiyjbfCM2BxUBM2IYDALYHPM4jaRjqomyCqfsaiWYwdxGIxCIbx15MjKdUsJqL+' +
                '1GyHgxFN4tHXmEifE5R35BVKtkr4i6h54hD+xLCECB8GVl/gDlQk0ICsfxXglxV4vUXyr/wNf5dzrXF' +
                'jYMAaDwMDKDCSDwv9+DxUBSJQPm/+dheEMSgOgHD8GwSZKB4vqqD9QpmUDn+XjS1ynQeC/4weA/tweF' +
                '/xweKgJQQAYWAHKwDldoMOhLHw+8BgDxdtT2gwHld1L+1O8S4P4ClLlaugV/wHiv/WFTnwAAVKRAx7D' +
                'XAABoo35eJfC/8SFTgYIdBAA/R6Pc1hQiJwYA/wMJSn+AhgxYDCsSh6JUnf+42OvowYwAcEIeKh8JRc' +
                'r/AUPlSpV/ltBDkko7zLVIi6nPhDAuH54Sh2Ps1oG5FH8RxVzk4fZNhLYOIwYdj+gwGWmfwHzf/sDv1' +
                'XPKcAtcKYSBHYLvf1ncTkwMOlSodqgPX4iDz1n9TW+9g1CGejxUuqQfBhYDAoxJWEkGQqgfN/93',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=64x32:rate=25 -vf scroll=h=0.03:v=0.02,setfield=bff -frames:v 5
// -c:v mpeg4 -q:v 6 -g 5
//     -bf 1 -flags +ildct+ilme -top 0 -alternate_scan 1 -f m4v interlaced.m4v
export const INTERLACED_FIXTURE = Object.freeze({
    name: 'interlaced.m4v',
    codec: 'mp4v.20.245',
    width: 64,
    height: 32,
    md5: [
        '0cbea7bc9bdf0a1fa75f8a18d0dcc2dd',
        'b3fa0215f854a5222de8235dbddff096',
        'b647110924723ff33ee51cfad391cfb5',
        '5a33de2eb70561e7db5768fabdca1745',
        'dcd0efedd211a05c5b97775f319a41f7',
    ],
    bytes: () =>
        base64Bytes(
            'AAABsPEAAAG1qRMAAAEAAAABIAjUjQgAzQIEBBwQPwAAAbJMYXZjNjAuMzEuMTAyAAABswAQBwAAAbY' +
                'QYTNgoApueTNqw776h1u+n99ue3L/FP5l2UpQrx5poD0TstN7epeSczI2qAywz4GEVjeyjn2wkRbjzs' +
                '3WYBsQOCKBtoITQ41NkD1SW/HafGlSitaHsb6gWefxtvQYciWHUB4X/lTAwdAY9AYCKvg+TAY1N8HhP' +
                '/M3jhAQmmxCHniyc5ca9/4eKWw7G++EC+m/UtIy3/dRkYfF9aLo2n9mL+G7Y+kUNf/QKRuK1RbM5/bs' +
                'km2QjbGQgAcVUvVc0cpf5c5mqc2XPqcs3CzezZTfDR06CiBQF32pfwPx+zZUNyW5szYpyVbrisBWaIO' +
                'p7FpM+wIbfvAiqAMKOh8qY8rpVsvrsvewiLQGXyt4qsXt3WhK97wGuAZUgXZVeYhVtmqZEcIwn+rS+m' +
                '5Inb2mkaHyHAMfK1kPiUwEyVsEVmNt/7bbu3YoxA2Im8T+DzmoGdXnBa2CqXjr4GGRszEGArUwGVSvw' +
                'MBVUvgK1rYhNbj1MHikd5s+BlRfLZ7fFm+/P5+f83Ofm5SiI5x4YcbZB4L/fEcOoDwv++kBgLAYagPC' +
                '/+acHgoBkuBWfSNg8J/4xDjiWAy39V/L9zsyebTBBZaYBuqOsFnQ+SJGEu99/K1f5eqYRA2gHCV77U3' +
                'Bw15ryEPPqA7X99J7//b5ktVXuZ/NsnNIh5Pvvs+83YV72zNu4phUN8ZUFsvlDc5dnJ3rmx0eCE0P8Y' +
                'D8rV6WXmXdybZ9RuKcy6oUylCy3T4yEgEJgPGw7H+mg9YD1pvAYRWl4Hvtgu2PUzg9wQfJNnbb/VQQm' +
                'mmgU1zrKkGRq03k2FW7PqcwbwjMZ9sHgv+kejaA8L/0qgYbB5kBg5ZBxcqDzVXwYCpuOExGSAarV5Mn' +
                'tkgif7yatv1Tef9PtqWFtm3JZykYoO1YMoHTTRc10c+zzHvXU6nJCze4CLPtKcy4rvcUekhEAADDGwS' +
                'AcCqA0DgIA4OS0GCWALg6AmsHAqgNA4CAODktBglYFwdATRJGOQcN1IOG4Jobg8HAU8B42AZD4HDYHA' +
                'EMowHagB4Lkww7UAPBcsWGx4IgYO1IDlAOoSs4RqgXB0BNbAuDoCaDYNj4wDIxwDhuDp0JGUYDtQA8F' +
                'yYYdqAHguWKAkCoPBwDogA4bjkB6gGCRwAAAbZRcJiFNbi+Px8JBeCGPC9X68BCH5cCCAZglj4Sv5/I' +
                'X+LleDy+0vjcAy4G4EKeBDVD8G7JPj4IY+Ev0BD8JAkl3wPlxeP56/31gIZeqvawXgFCV6wGz4lKwZT' +
                'lgNwD4PAf54kiWJYkD8SFagvg6gMPVSoEKqgOrNKFZ8fAwGghA0BA/S8eK+iQrEsS9VlwliUXl4kF8H' +
                '5d6F4QR4CgBC+Oor5B0PAYMwDRLEoHgf+cIOCKAerVq6PAbs9MnsnhIH4H1I7xVgiMNHhLBh7oHhIB4' +
                'WAPL7R0DK7Ns8q9baJI+glCWCFVQKMde64KYF4EBUrCCOwbQgfUKVarec+0rLvxnFX1VePwQS/wIAQB' +
                '/RKgBsqv0gQB+pA95X6KYPR8X+79SXKuCWXUdqpMMCWBz4Qi4u+XgGfVNhCEtQDDwSIPQPj3VQH2x7v' +
                '1XQfCgBxKlVhAEov0fgG++2JRd+/UqgUFVUvUlygIIIMEqD6KFKqKwPgZMCV4SvfViQDaPMHncrawHf' +
                'USqCj98DkBRsGB8XAdHwlg2TB3wd1GBwG7FYHv+qmgclgBIU1ChhhKx+JABwKIS4PwD/CWAdnxKVj4f' +
                'hAwIPlStVg8H5f2gooXf+P1X1Xley+1yvwQi6D5SPFQNqofeA+p8EP8A/cVqrAh/V1UPfqIr0de/rbZ' +
                '8SoCiAMBvD60EGiQJPqXiQJYliTfjwIYQwgqwDFZcPx96iWCDAQAbPqp8ELytUo8CiHgkn7+BC/6YEP' +
                'ysSleF4Qwhg8DAUj6QfwIasIZcP/gyigfH0VeEtUq0eAoYq9AOYAWJYQVf/gaBDEsG+DKwg/aBRqmPK' +
                '1eD5WJar3xKL1dVNe4p5+TAC5bni+5APCUJCr2/LlHxFVqvAo/RWoL/en2/sAxoKIBpfaJI+8XqAhaP' +
                '/fH3lI8v5o7ncVe3uRPDgOIRL/VQkeH+F4QgPfVF4MpgHh6BrLGfKRH1I0bHXxLH48y1T+5dHv8oMkt' +
                'Eql4+V/0SlYKKgcl8B2gxwA5UPAageL1f54eeA6DJbaCnBgUCsS/f96wSfAd9RKo7A5DrwAAwwKgDVR' +
                'eXF4Kj7hKAPCAEO6DwcAeP1VJaDNCX5WPh+BhWXfVAWsLC0+rlA8P5C4vW+qlL1Xx76iPKBr8UVig+J' +
                '/9hUHAOBvg0BBvuwA4IY+/x4kAGgHBBLh/fD4vEgSy76hWXT/L2JqSAeVqhLHxcXj8u/698rVl2dir8' +
                'BgKVXJWG56uY3xZbrcBkei0Khyypnj4SxKH4MmV+ePhJEgS94CEX+eqV++rLqPVXrO+/y8paKAoj82p' +
                'B42ALBQg+bADiQAaAcEG+7BIEsu/x4QghhCEmF6uFysSi9Vc+q0uhf+wCV9rT6JY+H6r1/+FyvzV/6K' +
                'GqBOqsozCAPh+XAwQQeBgHS8FGq+CnLh2rA5+AY+DKgZTR1YtQgGnAAABtpDhMSCGC//1rQKRtZvhfL' +
                '9U3d8o9jlbH5iMEOqKzdz31RfZ9qZ+jqaaEMYc7f3/1Sq//o9Ebyuz1/Io3Ypqi13BHoKiqbdavaBge' +
                'UHeBiIQx/h9PKBEVTOVvymAdmF6nn+do6zNuhlyVX3GdmDtQI1A5WO8nW+HQrjBGFYK0UqhKzij0VDy' +
                'RnvB37Pt8VCOX6JAs+JKnxcqEr3qrA/nlRcXcknveVXS6TR2XiN6g29qmkoAAGGAhgrGCELB+I49B43' +
                '/z0cgfFgIY4I48BhyoBhaxo50QhYCCNkQg+FoQzhzDn8fK4O43E53xeqqsuqr87zn658AAAG2UmCYhT' +
                'AXIGgk/LpR+EIfj4eqC4D8BQ/94fxWq+o8PfCV+cxQO1H1fgMuBlFoQBLvG8A76+HysflygR4PPq/dW' +
                'Tk4MEAA4EISC4SR/AgX/lZf5X8fD5QJAQB9Vdiu+HoH9Lwh/z1y1Ur9a3HD8S1QPAwDZdYXpR74fiWE' +
                'ISvl2Ntj9XOZ3DFBDquj6Xqm8Uqokg7UKlKnoH50da4GojAw83iidA8rwFTeD0f5S7gIV4JfleYD4X/' +
                '2FMCIlaByKB/o6V+8pV+HSufUZYymXY1wkgHqgPiUEBUDUSKDAaBlI+VD/wl4CAEGK8BCL8ViV9WqHn' +
                'p/w/A8PxL94FLI8u/fBBBBokl4FwQi4fq1Ssflyuf6q3/lQ+UF35R3B0v6BmDAhftLwhF4+Bi6A8H/5' +
                'qhLH4lAw8BlSofeBBpeDwcAf/4lXw/CGAeEH/4PVX6JX1SntkNKlRcChv1PR74RR9ihgRghqhLBmqXW' +
                'CX8FEcLv3ypriiiJ0C4jiV9UI8VwEKDvCMK4CUcgrheRqFhH0biWBgR2wPsqgfH/+dQYDx8AWukHgGQ' +
                'YiCqYlCTgkhAVVTWcLvj0vLhKL1MHXwQ/RWBwd5Yi0MgDBKVgwKEfqqXXy1LlZcEIIYQ/F49EbQPFw+' +
                'bv43m3uBmJfS6Ahf6PQZYe/L73QUqqFxdC5QDAdtU2D8v1vACC7iv6loeRme94sV3/1NoMOsHgHPYuA' +
                'S8AAMMCoAsSUHdG8eHMO++vLZef9nLsvLM7w9335fdl5eqO5+IuxmURLDIkM+CKWZZXMfaEQvLlZRYO' +
                'YlMBUNNRCHIMN3Bsd/4CStU9LywGHPvwrzjwsGFJeXfy+/z6q7N9ZZcSyXYgUx6qiPfTZZP+svKUzsL' +
                'LHgAAAbaR4TEg/gNTEIJAgBQDhOhBX6L6jBzQUgrDClMDhSF4PIxYDgRycJQcMAVx6I22Rb99Z62RuN' +
                '4UEQ+VUFCXiQPvZWP6JZePvRgRQPq/e4hJB+Xgw6g8oMWUS4XF8EQDSgFCP+8BkwM4uVAd+DDb1/6st' +
                'qR54HApwzcAAGGENYifl98ClgfZRrZYngOG8eCMA0HC8bAIEMOHPdXdy91GxSgUkdY1SlM7CkXZgLV/',
        ),
});

// ffmpeg -f lavfi -i mandelbrot=size=64x48:rate=25 -vf "zoompan=z='1+0.03*on':d=1:s=64x48"
// -frames:v 6 -c:v libxvid -q:v 4
//     -g 6 -gmc 1 -flags +qpel -bf 1 xvid.avi
// ffmpeg -i xvid.avi -c copy -f m4v xvid.m4v
export const XVID_PACKED_FIXTURE = Object.freeze({
    name: 'xvid.m4v',
    codec: 'mp4v.20.245',
    width: 64,
    height: 48,
    packetSizes: [1128, 590, 6, 764, 6],
    md5: [
        'ad39e9dba12e1e5cb583312068f3eef2',
        'd2202b71da345101e2bd0042bfb364e5',
        'f6bda0d4e2e3c6035300e6685f05fa29',
        'f73384d006779808b67b309ec71a99b6',
        'd18d2bc3c152498e9d60e3c93395fc97',
    ],
    bytes: () =>
        base64Bytes(
            'AAABsPUAAAG1CQAAAQAAAAEgCMp4CA0IAM4YECAwsHjgAAABskRpdlg1MDNiMTM5M3AAAAGyWHZpRDA' +
                'wNjkAAAG2EGCPnNBjpqgJM0BJygx0MPgZcHasHwv/V8yCSuRr+p0uXbGG3j21TTg4kZmK9nq9uiukU3' +
                'G8RyuEKQeFw+79K20p9FIfFuCDq3chZ3vdW4b64qy1qtvWB7P+jJaBr7LTWMFpbf+iRL4twvSNqtyKm' +
                'RBXrDeCBOdeJMBAHrLH1Y2URTM1a2Bh2lWBzpRa4KoCAVSNp1CX42YnNUIAZcr61LvPd4VbZPqFOH29' +
                'gtKeFoYx2JTY+1eLIHmmjIz7+5qj8ubEcqzwxuMlzNYZnNc8L06q1vP2OsiI1qdUw32zq3OS43iC81f' +
                'zM5eAULG8Uzuw+Mls73KM5vu7AxcckL/eV421aU++10y2F8SghTlVpSpj0U71ZEujeR8JY6VVrPKvVn' +
                '8qhiK5rc/l5vm8USKrF1k+tfvFvXuBaLWcBu+z+Ngi+a7+pr1qwPA7aEBtju5zeQtzQM7RyVRyYQh0A' +
                'Ym98SR2yOEqicaDpe1rsz25ms81tqVXzzWdtZHCj4MeBWEIShG81/fs59Rl/5sQI2IOlXRutjCoGQzo' +
                '5XUlXlFMgo5WBGbSMZ77SRn44o99jTOy3LfN6ts9n7hY1SvPWaIK/DDYgA4Iw8/NSiPGC8fl/Nvt8Wq' +
                'mmFq0wWUtabvFG39mX1z2FmMta2LQqpWlTKrcZk33831DRv2+/yoFPt3OxfmvhovzS5ofwqHPs//P6H' +
                'rDeyX7DdBjftpZ/q4WgzADQYvHcmKk1yMSld4HtKN6tBMEzAQmR/ue9ZxctUre7V9siIrq/IbJkA+Ac' +
                'z8StViRb9nPdK/rtlpYW2fWttDtdfQ1e2DKA6PvJoO02VqteTxKqLGhALGi8tUJtzii1VirMjMb+H+c' +
                '/pZQEBshGZxP8vA5rLc439kc7VgM4DB01+FdtBgLVrtnu61qyF7BLByAN8IAQVflu5qjeckU5VGollr' +
                'Ll4hcDCEP2+aEYcgyMFV4c03st6Moiwkjm0mzB7YeL/MFviwplo/p2lz7YZB8Jf0m9gwIBEmEcfN0PU' +
                'irtii6WYp4GqMlFJymA1TaYBlYTl4+BkTe5O94QB+PgOpy4DGqG2gIN5PwGF8e+P0qttj2tDgct/+zo' +
                '4HlqjVXm+3JBBwcZFf1S+QQb31m5cLXnQQvKgOJ/s/VspapwuzMha1Nm6poMv2e+IDWwc+3Wr2t7hYq' +
                'ZhkVCHQZQq1TRlkR2FBOUg+EFjAU1+jK9///I1zvoCsY/v/8i3US0knMxwLQNUwNxgfS+yeaqJluVQp' +
                '4Hw5vEaxXcnc/zlvK8FxsdK2gRI0qm3/bqpNz2a0ztia3V0K0aaQKez0KnN4ejgdDyF2KBzblbUb7YH' +
                'jWYsWZ6TL8c/mKFIe9/d/br9i7x9/+s716LRgb+22P0/07fbv706eOy8GLU6nMUeyKMiOm7toc/23+k' +
                'te/AAABttFhFZWSSFYXXDhQglHPtmNV4IqSXYpxLz7XxFgz/PDZOFf1HvAbbY9O/QaN1nDRK9nLK4JF' +
                'kDhRxv/VbYHP8vvW6qzftCKnd+6DAlKi8dgcgi4XK1a8oHR5WwPt3zMlqgddjudktb7reSMejKujBTQ' +
                'PetxpRtoF6o0CkEWpHBRkYKVJA1FPy79H378uHX/2bjOZkxrNHagRpVOSH/3yvwG+fHambd9+XL4vgK' +
                'RX2DrlzL+Hwgj4uLtnx/aPIBjt+mm121tdMTq/SW5a3Z1BQoChhYeCLLjegwEuF3i6ek5FQ8Vf7Z+gh' +
                '/6I59WBy+kn0/VHrd9md/B2Bgeb+5R1XPtEaaIACh4DNf0FPyIgHLKFEGauUko85m/xAnYimtgZN0+M' +
                'GzAUbD5B4CizAU2CNgHlGYBkdD6dEeKvQFJHWcUAXuJbO0slvBUX8/M/JYS/HhfFc+XF1+rwv8Pi/4M' +
                '0JU+PoPlLcm+lA5FPbOsvTh81BAT4Yt3mNayn6BAJAoxh22meIKDuP+rNq+eakIzobFBi7zG05VEW06' +
                '8AAAG2kOCEpTUZiImdyvatwsZall6xetEQgguFT4IhhYOTXBiP4aClXXUzOENLUjZVd6WAxhqlLTDW0' +
                'paxZpw23SiC9jEuKU7CJYnHl/ejvq2lqVIlP/U1gVCAg48rbqemxhB4kCKn0QiHu9BxtWbEKIYSGTVb' +
                '9uNKdSNFhF0nGc5QRWJFSyidDEdxeJNSO+CI0n6762DuJ7liMDBMMIcW8Sos1hTlAmoHUuf2tqHalPs' +
                'AAAG20U8AAAG2UnBChBQS57owpANhTjl1J2yTvsbmiPkaIuNpgG3OKd4vJrQI0OhRUGWp+dJTniuG4m' +
                'ZK4SBQiBG6D1VPqP/k5f43+yAY9O2rQy6EYUwT2Q+rtLvbqtOQVTEQOTC3fjyAfv56zYxn5ZN8ozn91' +
                'RZnx2I/wyyVpRdTsTo7qZYhScbzNXagFaTBTQ1N5jUXmrr+Cm+oHv++qtUzZo9tln299dl5z8+PVSvg' +
                '6U+jx2p2yVjdVYktoKflb7ZpN+S/Ne3/oOx1jGqcsZn08JvCXB+PqB1V1V8RowooiDknCmHDxWr/347' +
                'ojq6oA2r1r3uZN/qtXYqUvL/ZWqp43s/qOIxUPwQmx3EvroMIR4fl2zZW0Jaz2/6ycEge+v1UksxKyS' +
                'eHwklwB4B3i/3b4f57mYvETVJQoZZTrnOCkZkG+B2Zqe83IxIpp943BGrJF/iuVSk73Y3g1CmgtUPP7' +
                'P1Wq//vtnC73rJqpQlLpffvZv5bZh7GtCd/i+KwQi/yoGbsnvfrRdiv2VYRVae8hr6iASAzojCPxdZC' +
                'eqgedojaOvxhN8GKEZIFMOFzOZxG0hYOl4+aqfVG2/uJ/3baStsf4pt3zYjgcHfKo56yNNMuVtREeVf' +
                'HZePax7G5c7qGjDJZEfEjcL01rQBDAAABtpHghKgjEFDUcHBQiv9rojNbVF/73rc1WolyXM0Z4WBYJA' +
                'FA4gsFayuVvUOMggXxToQ053CQqKCpPURpPjMyrXa1/tlLUyg1cSIeYWW1NGm6Y3IWbbLk0tAm1GjZ7' +
                'aSA5ZllMaX1MH6cXpAVSZhEscYKM1hq97rYw/B3ctl1RPZMnL7/lHedZbZWPDuCUFGGoGIOTykHE0pr' +
                '4iNZ0OT2Wgo51GuykwZqxBaFMYODAwfB0IBMIKN3Scbx9OnHP+NtTeDTrlGfa6os4hKyh2ZfyJmoI4i' +
                '2jz2dYLX4o7l1qqGfNeRy8SEIN4aQAZxb+AT9qfNWb48dSZMakEfZ1nhiv/8O+Fjv5k1rWozgFwLkTw' +
                'AAAbZSTw==',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=128x96:rate=25 -vf scroll=h=0.03:v=0.02 -frames:v 3 -c:v h263
// -q:v 14 -g 3 -f h263
//     h263.h263
export const SHORT_HEADER_FIXTURE = Object.freeze({
    name: 'h263.h263',
    codec: 's263',
    width: 128,
    height: 96,
    md5: [
        'db525dee86b45ddb8d072f937986f31d',
        'f14867022c7f5bddd6f1a8e2df2453de',
        '560c3c54f383e0f499554606a9164e8c',
    ],
    bytes: () =>
        base64Bytes(
            'AACAAgQOHnIKKKp/7Nxnt3kkjdIj7RIzU6gRdUgYUCPqY8n/BhAf4jSAhyqwMVXM9ajRE7P0EMEPR0I' +
                'wIecUgeHinFlLIjEreJQkeLvN9ztnNvtmJa23b01WcVz2qvMNyXNkugPedqBKL/XOxqiPOytVlydRKC' +
                'F5vyZtW2tJuvWvdBQ/A36z02ApVHs/g24s9X+DCA3wNe9PzaCkU+z2jfi71zLLin6FNuJWGhZEj5XR8' +
                'qsVDrujrkbnlOTjU1sWvVQPBAzcZUNq9UgYUCPqY8u0IQQC8FJubBHVzKzLNlGrR0EMEPR0IwIecUge' +
                'HinFlLIjEqzOgh/A36z02ApVHs/iNbiz1TsBS/Q0CCUMIIGB+S9XMu5uNsTo9bvLU1gON/PaqAYAd5s' +
                'uTCOXg5v83gwISCBmjxlQI4/3Vs3dTHlz4MIC0RvSWbQUin2e0bkLd0D4H9HQjAfzikeKNxZSBIlTZf' +
                'gwv4rAjUCUMJa/TRgqEdIGLyP1VK5vl8ZlljFl7KRkf6qVTfr4zbbWJJ20iPRK58SR/bqrFQKPOfA8q' +
                'xX+RbVuLHz0S+/Egfy4qxWCjzngPqsVfsW1fi56TBgQguHuKPYBSNjxSPBGb0dNaBYxDj2qNZKFOKUj' +
                'LaMy8x/8fVVrClQIuqdEZQI6lNmsmkXAhYpTqAUuqQMKBH1NmmWfoIYIejoRgQ84pA8PFOLKWRGJWTo' +
                'KEEPQOAaBQ5xSB4eKcWHrIGiV6BgQofRZpS1GwYUEEYRy0HGA6FWO+30oidkaAy2IxYDjfz0v/h8B7/' +
                '1THBF5dyyytEMUEMREYuVWBJ/qmUEKRW0pqrn7EaImighiIjF1OP/RUJckAxC2FBqXBABg/ESMknC9o' +
                'GHAwcD7nVVVVVUwg2LS4DURjErriwuA1EYxIHJmkdIXAaVAU8MHR287JKaNDzWfgVXYfmamZoYtjcxH' +
                'B4+MjR1UnnAeOciwsWyvHD8wedzzx/7ja/nm0iNaRt43TSKJYjj7+qJB7KrbUVX7PWo0RPEl3blTlW4' +
                'jNQ31agsRHXoCv8Vj7+JEamcsbdFBDERGLlZgSf6plBCkVtKaq5+xGiJooIYiIxdRiXMEmSAYhVbiI1' +
                'IgHdBgPASAKF4MWBj8YzqqqqqqYQaGqpX6ektDEsA+qXLHqKiyDx2pAhq5JM9yYyLWxn8fl0m2llFiQ' +
                'DA/AlApwVXxYwj8GDBPoit0iqqh96xkInQGAEYDA/IlfVq+WD++HQFFVZ0ncJAMD8CUCnBVfFiorANE' +
                'j2AowVSsHNApGyCGIiMXIvhIVWiKWCxQEsfRUPv/l/swGL/pCZovAwPiEAGF/AVSsHNAlaAghCrReCq' +
                'Vg5oFpaR58GADVVnP/lRWIOFbv/xfgj9iCocpU96XAgiUCnBVfFhtB+XAZLKLD2iQPv/U33an+kJ04G' +
                'BB75odlgvvQYH21aJRStgwQLQMxLhXgseQz4ZE1vlxibhkdhnkgwPur1rxaLXwvh558P/yqrJVit0UE' +
                'MREYuU3t/1XvtuwIX3/5aMqYuEvwlAHlwlq5VCpTM833yuM2M/J3NVVQNCFLeXItmi+g+q+qEeZpFSE' +
                'pqJAMB5hACHwuL4PQU3x0ra3JKI+ZVI8UyLnpqKioqK14NWEfgwYJ9EVukWEfgwYJ9EVukUQuaIW8GA' +
                'GAYMJVgw/z8GLAwcAEbyNkEMREYukbIIYiIxcWqhHgVHwB4MGDqwJAxf6GU9LS0tIQkplJSUlPg3POR' +
                '+DBgn0RW5ZBDrPSwXKReJY6/FCxXNYYZw+6KUwzz1Q+/nYnbiYlnAD1Qlwv33AUXR35f7FvTbDWwCWd' +
                'qghLV/8oyri7H9DuGPlSsA8v8PooU/3Ldk56/7kqxM5YVeKgQ7J2bV9wXMKpX5WI13COLEomxAhgwAa' +
                'EEIXS8uo8BT+HapvNtgjbsUD1RasfmoqKiorXg9hH4MGCfRFbogMmEfgwYJ9EVuiAyVvgwYN9LCsMoc' +
                'GADwYMPEsGH+SgHABnxAZ2QQxERi6IDOyCGIiMXH4BwjKgJg5n8rUGDDQdX7npaWlpCElMpKSkp8G57' +
                'QX5maBhtnMZvaI6kLodsNQHKSsSlCr+Xi2L/KosNXceJwev/sFQ/VZyst4KncSRJLlSuDvLk7lvFN60' +
                'hSQ23aooIYiIxc1RQQxERi7BVCO6rBgBIGD8xKBiPwGLBQC51VVVVVMITUVFRUVrwasI/BgwT6IrdIs' +
                'I/BgwT6IrdIohc0Qt4MAMAwYSrBh/n4MWBg4AI3kbIIYiIxdI2QQxERi4tVCPAqPgDwYMHVgSBi/0Mp' +
                '6WlpaQhJTKSkpKfBuanI/BgwT6Irc1HI/BgwT6Irc1bBc0Q2gMB5gwf3AYcDgMX/Bm3aooIYiIxc1RQ' +
                'QxERi7BVCO6rBgBIGD8xKBiPwGLBQC51VVVVVMIAAAgAYGDgKcto7L+AcH2AfVwGDBC4c/TKj4FRHH0' +
                'k/RL90fSAxf9bGfe9a7wGgYH1VDsel/x6XAwoKr1hXWpi38hHgHBKoQgYT87+DwGDCPj26PL9odJ8hK' +
                'rV/HtTKQYoD/1S22DogdHcv22QIy4oSA6P8FMLj0fM6PlaQd0bwi9rCj/G7IVNCMIqiU8Xga9Jhd8Dg' +
                '8n/fmpcb60wRKhGoMJ+W6rsnhGBgvuKOgURY2dUJ0w3C9WP7fz0W0ongMt9WSuCmFxC6RwEKc0D0pfo' +
                '8n8U/LCunZ6Z6RaOH+78fXC4dST//2RWXAe6OmQUbQ60lnGIuNlzYKL2RSmYBif1ZpGleFPVKcUjr98' +
                'q4rucLk1SM4aLx8rUVT60Ru/9WKVr8Pj6gwnwBsdq1f/egjF4IbQ9YA4Be8bcCFMmAWzi5qK4qUdkbB' +
                'VaVg6IF6KSwtQNA6P8B41y9h4volqopHVsVcV/9Io9UO1Q39RPqDJP4DkHxdZaOsUyDqDzzNY0RCdO+' +
                'q/AQ/YX79WX/VDzR5+CXFA7Y1UypzG4fhy6KgUoFmRE7tbbnOdAo+I/fiInQsMNIAKuCmEFuQEKbB6P' +
                'wYME9RHqdNNEZTR2wfbcPfTRKVz4KUfUv3qtUCgujodamVQdkX1ff/sZto1A6IyQd6x3+stiNzqR97N' +
                '6zzEQyC/jQTq4DBgheDD/cBzPsKoSYBoIAMH9ogYz+DIA8EAGD+kQMZ/Bl/3lNxGBAdi4AwGA8rgQFY' +
                'FR8WiWqc4Im4IDcBxuEXwphLDKT8qseMtpvQC9JYZwDbVrIjfzncaM0RKBQXydAihcFcIJjggHr/v/1' +
                'f9qF+CME//AwYIrBh/yA5n2FXAPBABg/pEDGfwZAGggAwf0iBjP4Mi8fAbAiDFgTwQAYDwBgwpWBUSg' +
                'Yv5BwAQeyiOlgsC7IKVf8mcEQuXZVOC8rxYrFvR3ElFwUkqF+jptnkJZ+D2ZUSarxOTKv86wp9MAr+e' +
                '4V93SRXLGVQE9pU0DlgQVBIfDy+a/fgw/7T/hqhGF4CaF9CVCyUaBQo5LrFIQWnDmfUKlHbqv3ecA3u' +
                'gRESUiCiMJAPAMBg/tEDGfwZXGeC8IIBwG6BQpcPx9AUfkYOWBAwAiDAeCuUGADhLvmAQksoMD8+bl7' +
                'GmYdhf2wn+X2KW4BofAxYIGQ/jMApQcwCF6ovaBiP0fAxf4GQm0yeyDUFcdCpHOpuVRUsbZIxl+wiBR' +
                'ZNUxkddBTpMZ6dC9vsVc/VM5jbd3cxhgRa4KbG9Wq+PLszSJfC25Be8Ic+s+D8SpYoH6qfjDViKxKxe' +
                'GYX5lA+DEAYZKZQYH5aoMGDiUDlgQV+vfjQ0VQFIBSg5gEL1Re0DEfo+Bi/wMmvRxqQcLkgV0Kjcroe' +
                'tJ8fpWkFghBaXNsUR2cY/2thaP1YMICfBh/0uKgcD8CqYWXj4uA/+9ojFLgggHAboFClysfTS/yMqeC' +
                'ADAeCtWXAgCX9V++oKJoGH+wCo+asvbBiAMuBiwQMh84IsSfBzAIXNUXtAxH6PgYv8DKP5Cn4MX/PH6' +
                'sGEBPgw/6XFQOB+BVkEEA4DdAoUuCCAcBugUKXF4+siuW3J3tIgYAPBgO0GDDRLBiAQGL+wCgAAIAKB' +
                'g4HQLBgW4rCkwfH/BnAEcigqGfQVoM4AvBMQ8XiZPB8P8EQUpTQXBV5VIiAp4pt1Qq8z+polncIvfn+' +
                'DwdKPyt2JZxdJTQM6AgPG8FwV/W7JVMigDrUVqfMAUxfeuU236ldQCqmFu94sdWTngfn/fCqC4cGA8h' +
                'LVjwGADVS//qlXltpcySAwHkJKoegwAcqX9/yvy2wuZJB+XWSftTAq4r9BiAYX9BBAMBhwUEEsVFz3m' +
                '87w7mHCnpmonu8iSNjLmfL/N+9ZPfAzzbnaI1Z3ukhcrlVySVkdp1TPtYP36u/V25J65noImeUNsoHa' +
                'Ud4nSLJyYbhc+FXBgO34MGGeRA5YIDAdtBgwzyIHLBFYMICfBiAQYgHfBg/IAwGHBQYDzBiwUAp5D5B' +
                'UFqGvGRksFPbKNpjSxoKSG/xgZ9i+5b6pUJXhEqpdK0BzqkDmS2gXOYnv6gGwU3lBnAGi0KnB2voFTe' +
                'LEEwMRi0XLfFsLHjaMpv0WInYn4xK2xbdZW9FCnQcYCCiwYDyL1d8AcqAkDlgiTouBBEsGDBx8BIHLA' +
                'h/4GDBB/sBTAxf88GADgg7AYDyBgBAdtgwPtuViiR5YqMPhfimZrCR/h77FLGLUWPvhWhy5Rt4r/BF4' +
                '0td4vkTfzHWSM3DV4zTwWEUDkEk/+xRJd0bSMIxkNKOFGLbdRhmtrdWaZyKO4vapUEIUu/6lWvcTvVs' +
                'aMlfzUbLW5e4222lZMPhX/mHlyighZnVC7i5RQUChkDy8AwRt4rfCrKAUvb29EbM6ON6oYJ0uQPxa8F' +
                'uO6Bo/8KQZ//qcnfCrMIKsuVQSi7OXgOWBAgj8GDBy4CQOWBD9VgHh/oKgYgwAcEO0GB8wYAPm0GE9k' +
                'YKIMgqQ9UfWo0qj4GKNOxd3x5+N+/MTPCpDqwPF4KZWBB6sDxeCmVgQfFPgMwa+HqoDPkLgqQ6sEIfg' +
                'woIrAg8fgoBLBhQUvBiQP4s9VaoDPkLmTQkhy8FAJYMKCl4MSB/FnKTYB0DQ7wDHRgLh1Y8VgpvgQeF' +
                'Sfx58DH0D6o+BijSqPrUaVR8DFGj4VcEEfgwYOXASBywIGA8x/KDAg5dwDAOWBj9UBovBiAMreDABwk' +
                'y0GA8wYAQyWgwfq0DDggZAA==',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=96x64:rate=25 -frames:v 4 -vf setsar=16/11 -c:v h263p
//     -flags +aic+loop+mv4 -aiv 1 -umv 1 -structured_slices 1 -ps 100 -q:v 8 -f h263 plus.h263
// (H.263+: custom format and pixel aspect, advanced INTRA coding, deblocking, slices, alternative
// inter VLC, modified quantisation, unlimited and four vectors)
export const H263_PLUS_FIXTURE = Object.freeze({
    name: 'plus.h263',
    codec: 's263',
    width: 96,
    height: 64,
    md5: [
        '5ecef57a0fdaffb3ec9dee8c029029cb',
        'ee54728f67ae6fb03c2530e79dcbce30',
        'f3e67279339a1e5ebbbe9ab5dc2a5ec7',
        '9b667f7a28ddb9554be5b57287c9f8f6',
    ],
    bytes: () =>
        base64Bytes(
            'AACAAhzs5wASBeEEgRCBbBgNyAoMazraeqBHt3bvpmZi+0cZCVgeiB5SIykoBhPxSUqigeAbUgYUf8u' +
                'aEJv8BgQxn5RnAYH4yt+/GNbihjdhcpT0qEWw+HlmgwPuDA/BSBIFEDA+6iKB6CgA8UqBEHqcFF9YJx' +
                'uIAaMIuemrqCvchQprF3JFvldHY72rjqq3gpv8bxi6g5fziuTVBTmW9X8tE60iy5kAAMFFbBU8EANmZ' +
                '/nP+vqVtyyxNZdllHD70QA2Yn+seXmQrbtu1VJJtto4jmkE+DA+3b9vm5zP5AYP7HjFxkokL6tPLfHT' +
                'wPrUQOz7THMZxTs+CEPWpjBTKXVaqVvjt4K0rU+A+yAbQUilQP/lQ6Er5xuBulHilTvwYf90GF/ChT7' +
                '/lCgDoKMS/BSAAADCRWy0GBEAVyhSB5ZSUAbSqSlUUFBSUqQMe+nNbgIgI3Z/EX17KBNHLLFcsrP5Rw' +
                '+qNBgfgFCpBggUFEDA+/ooHoIQ8KfApB6I4KL6wTpWJ8GB9u37fO5zFOQGD+h4xcZKJC+rTy3x08GA4' +
                '71mQGD+G1UBhPzVdoGkxXFauUDDhCzu2+vIrsEqS2Mq6VWrLSxdbtNAAADDRWwYDRZrTUU9W/ZkHdu7' +
                'qrMzP7tpdktI2AQywoHqlYpA8q6Ugf/4eDzw9KQYYDUKfFfvHQ4RxRQ4Zz6JpjjfCns+DAhFQoJxAPc' +
                'tqrfTVJVKt3ToIyjoMD6AwPqPQYIGBgwYGB9FEKAPgwISCEB8oVFAIYjgwYN9YpPIGA6G25+84Ou6Ci' +
                'xfc7ciADWgT2RStu6us1sOpNR9l8OcglXJR6rhVP+VSAw37DQAAMRFbBgN/iAbMz/M/63KuzLNiubls' +
                '3KOK4pQDZif7nv2ZF2bbtVTMlu7RxHJEl90bo91Sx5oGC+vLdBCYsb2SJviIVCIfxHv+iAjmqGPIQYL' +
                '69+cqNjzW7lTf8OyoRa7AYENaHqhRijwKSKwPFI8HQ7+Bwdf+Ad8KA+qJiMFI8atXWKMHRSoKQLCOr8' +
                'OfHQAAMVFbD0GBCw+UFJQspKB2jUlP/FBQpKVIGFH/LmgYILD5QUlCykoHaNSU/8UFCkpUgYUf8uaQe' +
                '0GB9wYH4KQJAogYH3URQPQUAHilQIg9TgovrBPz2gwPuDA/BSBIFEDA+6iKB6CgA8UqBEHqcFF9YJy0' +
                'GBDEAMUBlIFQYUHA0BsGK/QcYGZBge4QRF6CjKAN6BoGF+AYP7BRAxQGDjfIAAAxkVsGA10QMGC4JYM' +
                'X/PusE1RAwYLglgxf88JUtvt0f0YgrklsQIAYcFYBiwJzMi8eIXMnwYDinDzZkxwBZ1EzH9m5VT22c3' +
                'VR8tmnwm6YDozzrm0WmMjm319nb48Glu5ihXFS6s8AADLRWwcDb53uMT+3y8kV221VJJ+2jiOZAUIQ3' +
                'zcZSM/KMwEPKytYxrPFHLYXKS8qL66MZO75N7QhZbInHdiiLVWqppHqPFH+WW/k8P9ku+qhbJVNVRYd' +
                'w2AAADMRWwYDbabYxjJdXXTUvpI2ChaEUIWiwHADQTA7A9lLwdgBBgDDA5b5mZMY9kmRbU08Di/rYbA' +
                'wPiIAML9gxQGyDmgYMF4iADC/YMUBsg5oGDADzCcVB0ymFbJQwDA/AKD3QLlMBSFKooEo2DAW48aBgf' +
                'YGBCfMgw/6U4DCgg9HQHhKNgAAM5FbDcGB6Q6BhfgGKBUIOaCAwXSHQML8AxQKhBzQQHANwcAbBgNIG' +
                'BEUAitiTgOaBolL2wYDeAkrFo6icZA4GwYBgFsGB7kYiMCRoOb+hz4cvbYhag79R3/lZVoEXcqVBBHC' +
                'FosBwCENP00IYMD7NlzAkaDm/wMAUAwPd2xfmfL5/wkfWANeAAA0UVsGA2gYH2RApQYoC6DmgWgwPwg' +
                'BSgxQFosBgCjgb4pk3FEEX//CVDDTSFhv4836j31rFfy+QmGxZ29snfSjgGP/3gphB4CvEKKUYhFHJJ' +
                'azMrLWKdURS20zrGW6souzV4sVw+AAADSRWEDgdAOB1A4CA2DADjCcVD1MKwcASMDcGBCAYL4BQqQKe' +
                'BhgMoV/Es0DATAMCFAwXsDA+5SDEAagGGBB4O1IlmmUHAJQcAQBwOAHAMmUHAqwcDWBwIAAgOB2MoOA' +
                'Qg4AgDgdQOAgAAA10VhA4AqDgCwOBgAAACABhzs5wSSBeEEgRCBFW1nTmBkFFglmx2lQjMXtpycKeOo' +
                'Ao6FP50JTgX77yncjUt/tUT083f25PYu9aVj4jJ0i51nGAPtN8UzwEu1BsKkca1Tv/d4tiv31y6hMB4' +
                'GDDRA4tLypfsK6gjLZTzOrq/Lr+qi5+J3tLgpfezGpR8rVqQI+UNKALqQcICq45BRbv/q9jfOKPAW0p' +
                'VqQMFAJIAAAMZEHW2R4axWNPnIFLnmMtjzDcYsUNqFyqKfDuwRgMl3jqZLGmzfwM2WNfvSkyAAAMxEH' +
                '/XgU/KS0uHqYGE/B42DDfgHtaIR8B+AYBhPsEIRwYb6BQa0Qi8dOF47pIFD7nJ9imuk/aCbVKbC1KsL' +
                'wplM8f1T5uAKAADSRAMIHA6AcDqBwEACmUlZeXAhAXBhPwetAw34B/GyAfAoALgwn2CG0DDfQKHG0R+' +
                'BhA4GoDgIAL/AAACAChzs5wQSBeEEgRCBCtyRoV3BxndFJ5tChZRs7u7vgO3MKbsxToGvXC4HPAuc5n' +
                'OSSYqz9KMlpUrolhWNNOSglIQxHGbO4X/X+KIyruKvelVq/83nvb+pxu5PAMCOmSkzFZA8hRflXKciP' +
                'NUag/g65e8ZY+2qA1dWAlYdugwf0lWq6HuzoML9RaD2XygDAHIo/lNca4Ck1gFPgMp/awAR1voKXM7y' +
                'DzWwZACUMqTgAADGRAKLOc05rZDPUFFAYcDgwbPYfCk6cMXNJRyN0keYHKuJzYFdkUWbc7xlaS/tAl7' +
                'XpGUe5rHGtKGW/yMgpFEK6OdBSRV9WSzALa2mTrVps1QJ51sR+rNzt3G2ToAAAMxEwp4UHWf2Ep0LX/' +
                '/vqqo/Mf+fvmjNNjK6UUdfg40IRXFYMSBkAXeYfafM7w6eLvW3+fgR59mWy5rPv5UwjzejMAAA0kQDC' +
                'BwOgHA6gcBAH5yBhA4GoDgIAL+BTyxb6ZbG8moUubFOVtn+VeUCf14P58UgAACADhzs5wSSBeEEgRCB' +
                'ETFqJctGLYLDeoQFDCxSMASBeCQFPMnwKXN66DBA1DYN86otrHKxlW7VCm6PFIB/i4KdY439Uw0p/Ja' +
                'BJsw1gcaVi8C0ytdvM0RcUAX2KeL8JkoMD8MYHyJjlyM6xJ7dlA9wplhSDDfucHXKt+lfiNlkEIDkQV' +
                'bGOTqtZny/7V9+tf7arLvR2f1f/LAOsyURZy+KRwpVYvU65rbMW93KBxq2J5rM+UDm4I62Jir58AAAx' +
                'kQU7ofeNmThsKE7D3D80gFw77x56FLs8zPbe3ZM95Qr2q5n7LzJ4d/XsHRJLgq/2jlgcMDUAADMRIFG' +
                'Ja0Y+YdHw9gMCDghgdBgwRSI/ltBxQUSgPwGBCQYH5BR6CEB/B6qAxoOKDNMnRzzqUgmk7ws9U/zN55' +
                'M7cJoduRioQSAoTLkoXuHa1a5UzI7RZToAADSRAMIHA6AcDqBwEACm0M1leXgkAhUFACEpgGlAjIgcX' +
                '9SAe0FACgKZ4oHnygceBxf2BhA4GoDgIAL+PKSwJQ=',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=128x96:rate=25 -frames:v 6 -c:v h263p -obmc 1 -flags +mv4
//     -structured_slices 1 -ps 70 -q:v 14 -f h263 obmc.h263
// (H.263+ advanced prediction: overlapped motion compensation with four vectors, in slices that
// start mid-row)
export const H263_OBMC_FIXTURE = Object.freeze({
    name: 'obmc.h263',
    codec: 's263',
    width: 128,
    height: 96,
    md5: [
        'db525dee86b45ddb8d072f937986f31d',
        '5f0481f85b0d535f34c9c9933c58e8a9',
        '3fefe91e9b2bee2beef0bcffb7782f82',
        'b408f1a14796c9dc0dfe854d1332b8d4',
        '5a7b4b33aac2a57e4b30153558ecdcf1',
        '9e78bd06c31be909a62720a1c58b92c1',
    ],
    bytes: () =>
        base64Bytes(
            'AACAAhyZIQASQDkC85BRRVP/ZuM9u8kkbpEfaJGanUCLqkDCgR9THk/4MID/EaQEOVWBiq5nrUaInZ+' +
                'ghgh6OhGBDzikDw8U4spZEYlbxKEjxd5vuds5t9sxLW27emqziue1V5huS5sl0B4AAMF1edqBKL/XOx' +
                'qiPOytVlydRKCF5vyZtW2tJuvWvdBQ/A36z02ApVHs/g24s9X+DCA3wNe9PzaCkU+z2jfi71zLLin6F' +
                'NuJWGhZEj5XR8qsVDrujrkbnlOTjU1sWgAAwnV6qB4IGbjKhtXqkDCgR9THl2hCCAXgpNzYI6uZWZZs' +
                'o1aOghgh6OhGBDzikDw8U4spZEYlWZ0EP4G/WemwFKo9n8RrcWeqdgKX6GgQShhBAwPyXq5l3NxtidH' +
                'rd5amsBxv4AAAw3V7VQDADvNlyYRy8HN/m8GBCQQM0eMqBHH+6tm7qY8ufBhAWiN6SzaCkU+z2jchbu' +
                'gfA/o6EYD+cUjxRuLKQJEqbL8GF/FYEagShhLX6aMFQjpAxAAAxHV5H6qlc3y+Myyxiy9lIyP9VKpv1' +
                '8ZttrEk7aRHolc+JI/t1VioFHnPgeVYr/Itq3Fj56JffiQP5cVYrBR5zwH1WKv2Lavxc9JgwIQXD3FH' +
                'sApGx4pHgjN6OmtAsYhx7VGslCnFKRltGZAAAMV1eY/+Pqq1hSoEXVOiMoEdSmzWTSLgQsUp1AKXVIG' +
                'FAj6mzTLP0EMEPR0IwIecUgeHinFlLIjErJ0FCCHoHANAoc4pA8PFOLD1kDRK9AwIUPos0pajYMKCCM' +
                'I5aDjAdCrHfb6UROyNAZbEYsBxv4AAAMZ1el/8PgPf+qY4IvLuWWVohighiIjFyqwJP9UyghSK2lNVc' +
                '/YjRE0UEMREYupx/6KhLkgGIWwoNS4IAMH4iRkk4XtAw4GDgfYAAMd1nVVVVVUwgAAAyHVsWlwGojGJ' +
                'XXFhcBqIxiQOTNI6QuA0qAp4YOjt52SU0aHms/Aquw/M1MzQxbG5iODx8ZGjqpPOA8c5FhYtleOH5g8' +
                '7ngAAzXV4/9xtfzzaRGtI28bppFEsRx9/VEg9lVtqKr9nrUaIniS7typyrcRmob6tQWIjr0BX+Kx9/E' +
                'iNTOWNuighiIjFyswJP9UyghSK2lNVc/YjRE0UEMREYuoxLmCTJAMQqtxEakQDugwHgJAFC8GLAx+MQ' +
                'AAAz3WdVVVVVTCAAADQdWhqqV+npLQxLAPqlyx6iosg8dqQIauSTPcmMi1sZ/H5dJtpZRYkAwPwJQKc' +
                'FV8WMI/BgwT6IrdIqqofesZCJ0BgBGAwPyJX1avlg/vh0BRVWdJwAADSdXCQDA/AlApwVXxYqKwDRI9' +
                'gKMFUrBzQKRsghiIjFyL4SFVoilgsUBLH0VD7/5f7MBi/6QmaLwMD4hABhfwFUrBzQJWgIIQq0XgqlY' +
                'OaBaWkefBgA1VZz/5UViDhW7/8X4I/YgqHKVPAAADUdXpcCCJQKcFV8WG0H5cBksosPaJA+/9Tfdqf6' +
                'QnTgYEHvmh2WC+9BgfbVolFK2DBAtAzEuFeCx5DPhkTW+XGJuGR2GeSDA+6vWvFotfC+HgAANZ1efD/' +
                '8qqyVYrdFBDERGLlN7f9V77bsCF9/+WjKmLhL8JQB5cJauVQqUzPN98rjNjPydzVVUDQhS3lyLZovoP' +
                'qvqhHmaRUhKaiQDAeYQAh8Li+D0FN8dK2tySiPmVSPFMi54AAANh1moqKiorXg1YR+DBgn0RW6RYR+D' +
                'Bgn0RW6RRC5ohbwYAYBgwlWDD/PwYsDBwARvI2QQxERi6RsghiIjFxaqEeBUfAHgwYOrAkDF/oZAAA2' +
                '3WelpaWkISUykpKSnwbnnI/BgwT6Ircsgh1npYLlIvEsdfihYrmsMM4fdFKYZ56offzsTtxMSzgB6oS' +
                '4X77gKLo78v9i3psAADedWGtgEs7VBCWr/5RlXF2P6HcMfKlYB5f4fRQp/uW7Jz1/3JViZywq8VAh2T' +
                's2r7guYVSvysRruEcWJRNiBDBgA0IIQul5dR4Cn8O1TebbBG3YoHqi1Y+AADgdZqKioqK14PYR+DBgn' +
                '0RW6IDJhH4MGCfRFbogMlb4MGDfSwrDKHBgA8GDDxLBh/koBwAZ8QGdkEMREYuiAzsghiIjFx+AcIyo' +
                'CYOZ/K1Bgw0HV+wAADjdZ6WlpaQhJTKSkpKfBue0F+ZmgYbZzGb2iOpC6HbDUBykrEpQq/l4ti/yqLD' +
                'V3HicHr/7BUP1WcrLeCp3EkSS5Urg7y5O5bxTetIUkNgAADmdW7VFBDERGLmqKCGIiMXYKoR3VYMAJA' +
                'wfmJQMR+AxYKAXOqqqqqphAAAAOh1moqKiorXg1YR+DBgn0RW6RYR+DBgn0RW6RRC5ohbwYAYBgwlWD' +
                'D/PwYsDBwARvI2QQxERi6RsghiIjFxaqEeBUfAHgwYOrAkDF/oZAAA63WelpaWkISUykpKSnwbmpyPw' +
                'YME+iK3NRyPwYME+iK3NWwXNENoDAeYMH9wGHA4DF/wZt2qKCGIiMXNUUEMREYuwVQjuqwYASBg/MSg' +
                'Yj8BiwUAsAAA73WdVVVVVTCAAACABhyZIQSSQDkD8KfZN1JtYyRm3mQjKK0nYP/ipT5X7Zg6+PK0XxV' +
                'VNZjSxYcHgMGEiR5q+BDo8BTD1Wp9Pp8SVrXAx39iIeWqUMwp04NtQfwpSpsOgAAAxnTAAADIdLCnMv' +
                '4eDgquaULGR++oUDvEZQSgJCuI0qSoidXyiUJGAYuxZrJSAb0rPCEMIAAA0HTayECrgp4ea6HqI9k8z' +
                'cHaehw9pmVEDOf7gKUF+w8PNcdKiQKrxgBkFv+H6hIcT2JcpQfeH+FSP22sJEQjtRgOD86sM+CyrTma' +
                'SAAA3nR4cXvAAADgdIVemKY9W/AVBjAMAv1bLgK0GLBACwr9MUx6NqwKgxgEAV7zY/Bh/2AxYGDgAmF' +
                'Ks80xzeLKfziagqq28xSwQJjZEN2upRjQMbeN50DOscEc0AAA5nS8OAAA6HT/AACAChyZIQQSQDkCFv' +
                'PfL1asvV3tzf5N3NDOST04tCEcd1cyD9gPCny/ai7Ub1fnWma0NRw2mJJVeKy5vewD85VXBG2z/gOpN' +
                'BxQLQYP8H6cf0dgp4BlYaIBEBjP4EwblGhwQgAAxnTAAADIdGtw8VzqFsPc+HXDRKF5rUZrWdqB0Hv/' +
                'Ky73qoqu4pY9I2KsFonXo4Tyk2qFKueYL1fa3drespRoMIAAANB04UL/Paaiu3CKZdYYD+Cr++ToYVA' +
                '5/8BU3Ctqh3Mgjp+OIix9xGQiskyZqKFotG7cOOBEGg9hfZWuxedJPhR3hxtbYz8GLAkX2H9BOuBjVH' +
                '6nHPAjAADedB364gChhV9xtZ3nJQWgAADgdIF8I4RjKEHMAh9ANqwKgxgGDgAwFwPwaEwjjdSA5v8XV' +
                'sGJBAcv9wpUmxFmftu91pM0tq/M4bHIJAF7ugSSNFuk9jbZWUuL2r66DI/1TcQ6cAAA5nS4oAAA6HT/' +
                'AACADhyZIQSSQDkCL+gzYCwTKdJ6RYFVTfYuVgcBgQkIKnNHgHJRHZA1oi4Qgx4EW1tFDohlRoCjJO3' +
                'iJgKmcTiKcL4X+gBxd6cv/CLRGkUAq1oub/QPDoeMKopZqlKyj0kk1aiPSzmpKQ3i8aiGiIlMgAAAxn' +
                'TAAADIdGdx0Cx8F4JnDh2Imdj4eNBYDXuOhVC4cPsxm2JGU22KEJAsCWTjhfeUgdUsq/4n8xRCOdMwA' +
                'ADQdOBVBKEw4cHDxT4n01inck3bkRpRb8DieJels8DmAQFKF1IOhzYTnTGz4X38C0cqf8pw5sWLRMBR' +
                'vocOdOMmjihT+5cQ5Gl3gAAA13R4J+8YFS5xQptMBFKmTGhoWDL/okBif30K3vIc9AJGDQakgAAA4HS' +
                'F3VAwn4DEAYvgiwCYOYBBVWvr1QKWAw4HSsApVQYP8gFFZWAVhSpdA3J9TOdEVdbFmR0zACUYR8LIUw' +
                'NOE2YG65ovigdbi7Ozojw4AADmdI9BwSAAAOh0/wAAgBIcmSEEEkA5Ai/QSPCn3GaxgKvnkuklssbid' +
                'E+DzVZd+iMqUtZu/9yJk6Y10f3QPr0eAw4I5DBB4WdRkJbqFYFhgAAAyHRbh51cULh9Nw6GYsLDAtOP' +
                'gFaQ2jGHVfVVWo6Ovd/M2VL2ciAnpxwVxGyyfHgMGCj4GHA2gMDtqhYnWh9khgAA0HTAvgZ+NZbFWXN' +
                'Harmrq4GQFUB18LHFIXtEVxYs7UA4P3i1iOYhwrPMDr3zPjY1XLG9KxYcNgXPpwE+VNHsUiLlrGGgAA' +
                'DXdPl7D+FEg3K7Ck824210GjARiC0r8Fz0a7WlxkBdQ4eeGapQoa2AW3nALXngYgDUMHwAAOB01snhm' +
                'UlJSU+DcBTYgw7x1G1sYudYTc2o+06fxnpZ0rxYRDHj1BiP1lvGCYGJ/FDWDrdb2UtIILYoLh/WPb1M' +
                '2O5m9qm0C9oKlS3TwAAA6HT/AACAFhyZIQSSQDkCFTPUzRDBfOCx3AZ4BIzuGsCri7pGaxJbRpAQ/qi' +
                '8uLvc+PxFY9OX9qJqNabQa2NxuRA0f+yaCmP3Z9N9RV5+NxfSSS60kRu2eBgvuqmFauXlu3/B7QMwFS' +
                'IxB7MV/+2p8Pk0Hs9n1EYg3OtFgMgBC8blmXoOYBAAAMZ0wAAAyHQKFuc97AsPwMiAgHB4/aNc/5XQK' +
                'uvKbNnmftZLdQH4p97/h2PLVMn0TSmjqC8Q2iIQhiu0wN5YMR79SrV1uKc98FP6M84mOAAAz3SAAADQ' +
                'dMK32w02YzBFEZnDwFL8PDxSGU3wJgv9avwqWbHJ5WOq1vytAoYZw+BZLjG4OF+muVMEd4nCICk85h2' +
                'HQ/DwcCuXREwXgAAA1nQLGGRx32YcKysJQo0n+34GOY2pT+TFLHybtWF3A/crzkYRwlHobDVOjuH4Sg' +
                '1YDonAAADgdI3Cr3+gMZ/fBi/54VQvSasO99suArQYsDDP32x8BUGMAwC8KNro69QM5pXNZ2sKd4OvX' +
                'DUu55NgsGuxnhaD0/46HduwFWvcYD4agAAA5nR4cfjIAADodP8=',
        ),
});

// ffmpeg -f lavfi -i testsrc2=size=128x96:rate=30000/1001 -frames:v 3 -c:v h263p -g 1000 -q:v 14
//     -threads 1 -flags +mv4+aic+loop -umv 1 -aiv 1 -obmc 1 -f h263
// with the temporal references rewritten to 0, 3 and 6 and two hand-made B pictures (Annex O: every
// macroblock type, random vectors and escape-coded coefficients) after each P picture. ffmpeg also
// shows the two B pictures before the first P picture's repeat; the decoder drops them (that P
// picture was already shown), so `md5` is ffmpeg's decode without those three frames.
export const H263_B_FIXTURE = Object.freeze({
    name: 'bframes.h263',
    codec: 's263',
    width: 128,
    height: 96,
    md5: [
        '7cda5f294d7d2dd93b90ef42c712a058',
        'a8d83cbda1a01c787dde6c2f60bb6c98',
        '27855148ebe524e42a060cbb9fa5d3b6',
        '6ffac550de2ec065dad6e703e1e52395',
        '431747ca2c041672204eac6895749454',
    ],
    bytes: () =>
        base64Bytes(
            'AACAAhyVxwAS42CKBKcm6nvk69+tJIroon0XvjlQI/1IiKB38cHkGgwgPo6kA/L0RL2ey0SxKJyxcD4' +
                'H/lQ6A/5ZSPChT4uUpx0SoUCLGMVr+XsW/c/PD+q1dq5oOluzP8xMrkvvyX4Oz/t1QgZy+XiqjuLyqq' +
                'ncgqBJivBwr6rLpP/fzFwQ9A3lmT8APUZ7fAxwCsXPmgwgNoGsybP0A5Tns+DHf6xe9H6y+U6JI4/4f' +
                'plQsDVrta5ZwqX+VLRXMU+iyqfVi1vB4We/5OoV9+pERQO/jg9lSFjIB3/fg77PVPLPyjVpcD4H/lQ6' +
                'A/5ZSPChT4uUpx0S9i4H9A3lmT8APUZ7fCWXLFz+rwA/RJoBg/DDQULPZ6/9/ytNFylXVrRxYC5bYog' +
                'DbFbA4HbIOb/QGBCRC98oTqB23/5d7//jg9ugwgLR1kln6Acpz2fBjv8V8XHo9+VDoe+WUlCj/i5SBQ' +
                'l7LoML+dANokD8MEV0cRMEAdj4MWwVuXnZ/C/yeWWJrKvKKVN5yf0v8nttqaSL2ijqBbUbdv+e4BPy2' +
                'jznu7IXfLli4+whX1E3L7nugT8tg957m2F3y9YvPAwA0DAhDBT5RngLRWUKSgdK/lSr4GCJspqj6cCC' +
                'nykfJ1YlkbbG61efTKVAj/U/HSgdqRx76c0g8k8pHKgA/6kRFA7+OPfIw2XA+B/5UOgP+WUjwoU+LlK' +
                'cdErC4IYH/gcA0CH5ZSPChT4uKU4GiUtBgQpqFypSqisGFBB0Owhg4wGWdK17kojLyKhFVjoIQLlvNx' +
                'oebvEywjrX/rLKqFYfJRGEsXVMj36mUD0nVSm8W2wSxKJkiURhLFwdN5OIZIIkCHAIGmRCBg/FF6SLM' +
                'qgYcDCMlBMEwOBntjdgDUEsYltcPANQSxiQxPRT1gDXALYMG9eJ+01D0PpeLw+0AnhK8IgEtsngle8s' +
                'UnkZQ5sHA9AlyV9Poj2nmy3XduzFY+EsukVvtNJEI7a36iQpl6rUXuey0SxKJx4vfUchA/4SzW71QEI' +
                'Sjre92da3w+EtTFrFbhASiMJYuQJke/Uygek6qU3i22CWJRMiSiMJYuYQzyOSCJAgW+Eo1BsuHaICzI' +
                'MWBtjElEwRA4HS3zncmSWhiBPheEJ4JwRNlDg+iXsknsWnk4tb5rbEn7QhUWIAYH4QApQYoC0WFjYKL' +
                'RKCC4HAEUfGssTg7ACCKHkBQoN71axu4VAW5U/ydvgMD8IAUoMUBaLEXRBRZ4CYMUBdBzQIF8HyURhL' +
                'Fw3xFy0RwhCwQ0LU41uy7+eBi/6QmbSAwPiWAwv4DFAXQc0CYghpKqZBigLoOaBA4AqDgCIh6GnLFt2' +
                'USrBIWCC4QsZ8O14JFEn1CA9vkLUAKUGKAtFnm2BFCFRYCrqJrdU3F6OdHxOgBQXFRWEIXgwA8DA+3y' +
                '6D8KxDBggWiLB/4IPhY3s0x23C8YhNwyGwMD79+qwIYtYZh5ut7LyyUuCC4QEojCWLkT1PM1W5iM3dl' +
                'oyEJhDiAbsIeyqOKZ7Fa+diexPpO1BEzUktWvoXe+L+bzeDue+KEJKG6INSxKswzCkFJpV1V/0lHfvV' +
                'SUKZC88xicF83jYKLRKCC4BGNgotEoILgEI2FQrBUgqAYMJ6DD/OgxYGJmdpKIwli5pKIwli4t4O4AU' +
                'IY3BgwfoFAYv9MMoRCYHA8wcASZgcDlCMHA6AcAyIW8bBRaJQQXFgH6nXCELixlCVbFBcEGfTJk/j5Y' +
                'pHAzb41vl4OVcHBKGw34hjP8WAkuV4X6mtXNtwJ3ORIe7ij1Lxcoh0QmudG7ONRQp3/rfyLZdX9KXEz' +
                'YRg4HoiiWyLz9L/+FzPO50dX/hSHKAmBgBpKGhakXZYpQClwr4r9+2Dr/4oKVFpcfjbxsFFolBBcwYx' +
                'sFFolBBcgMc0GDBtH8CCYDkOAYMPQgw/yBAJG6ZQJRGEsXBOgSiMJYuo2HXAKg5n83QYMNB1ftlCITA' +
                'mg4AWyg4HQDgdAOAUgJbEJn3vfERWn95PV6O1IXIlYMt/g7IDzqBRzfVYu8X6ECFw14UDkHr/w943zy' +
                '1Tq/Bk2jRsc7Cv19F/WrKauqEkfQ22J0CURhLFxlhKIwli7ODtzQfAwfmgBiPwGLBSEmBMBfBEDgYcb' +
                'eNgotEoILgTsbBRaJQQXAISsKhWDAcgKgGDCegw/zoMWBiZoc0lEYSxcwlEYSxcj4O4AUGo3BgwfoFA' +
                'Yv9MMoRBEEYOAHsoOBzg4HQDgFISt1sFFolBBcEWNgotEoILgEcYVCsFQGoMH9wGHA4DF/xlnaSiMJY' +
                'uYSiMJYub4O3aHwMH5oAYj8BiwUhZRMEQRg4HIAAAgA4clccEkuC/AyCkxaArLkRiofnRebF/ITAXxy' +
                'Ui7DI6bGgeMnGcsUdy0dlHhyUL6v64DpAQ/9/wKAea0JdRp1OUuTcWJ40CkWENpgXW9WZKylshApFyL' +
                'sa+j6Bmj2dWQHNbCceAb8kKHx/jRAPEzCnnTjGdAr57tnLH/fUKB3iNdMSnjoVaSr5SBXwGBBxKwDF2' +
                'LNZHroRfgMH+eSA5gEBhA4AYDgBwOBrj8HC/gp5wD3YjKHBTzmuCpmnjpaoeizqZBcHIuAtfLfXNKJP' +
                'Dpdk+3ovBwv6jpjSEKeO3nwqZ0kM5c/LSwiHBYsVjK76tYyWVY2BhA4HmDgeQOAUj8EIRqlKHD9SagY' +
                'QOBzg4BSAkKv3DrMKhABXH+JjOqeY0WaVacH/FNyc0aBSvOWPnjeyxilGttmgxhX30x74iAVBjAIM1U' +
                'EbwMP+UGLBHhV30x5UIoFQYwCDL0BhPwGH/YDFgQOACAYQOALg4GuAgDKDgdAOB0A4BSAkLjIIzHN4t' +
                'v4gq4iVt5irhtFyIFriVlOlGN/ZvtqfB2BnWOGx6geA3EZU8DCBwAwHADgcDXDGPwQhGqUocP1JoCDf' +
                'H6kXD8DwG4jKnwAAAgAYclccMFEVlDK6FXgcABBgwEHBAQYD6BwP+nTiS+F0aLlK4f4HABQYH+Bwf0G' +
                'ADAcAFBguwHC+hHvNiqxV4iuFgBLeQGAAgcMDBgQMHGBQYUDBwgwGBAgcACWvBhPoHCAgcMMAo4nj4b' +
                'BWKgMAAg436DB/oOEAg4HYWBZAYT+Bwf5CNZD8/iPHULCNgGGDAcAMBw+wHDAgYYMBwgETxdR3n6F9i' +
                '/wOJ2A4f+Dgf4OECg430TVirxN0bgCjXCY4GGAQcQBGxjFUAOL/gwgKDjfoH5g436l/wjXjvP0Pi7wY' +
                'QDBwgMHC/gcX+BwgUGD7AcADBhPoHCBYxTGrPQGDAgcQFBhf4HA/38HG/wiiAwgGDhfQOACg4AEfDcV' +
                'wHC/gcIBBwOwBwxwYX9BxAMGF/wcH+Q/x8fIDgAIMMCg4v+Di/4OGBL3LxdYGB/gcEBBgwEHD/wcEFj' +
                'cQxXRvgOL2Aw38Di/oOF2A4HYBswcYMVODigoOH/gAAgAoclccMFETBNvhVYGEwXQ/j3Zu4DDAIOIGA' +
                '4H0Dhf4MJ9A4ICLGd5jXQwOEAgwH+DhgIMEBg4P+DiAIOKCn0bz9gYMBBwQEGF/QcP/Bw/4Q6sCj2Qu' +
                '4XhHrPQ8V2dYMJ/A4P8DABgOGCgOjIBgwEHEAgcMDPydjvAwAEDigQOCCgwn+Dh/wm1xvxNVi7gCqIB' +
                'wP8HDAwYP/BxgFD+FfIGDBxuwGABQcYBfoGEDAcPsBwAEi4eAGIXjqYhfYus3H7A8h/gwP+Djf4OH/g' +
                'w3+DgfQMIBA4P6Lit4u9g4IGDC/wOKAg4P8hfC6wni0nFgwP8DifoOF/AwAYDh/4KyiqxdxsQHC7DMf' +
                'm/AwwGDjf4oI7xdyfcBxP8GGAgcEDgQgOABiZdC/iNecT+Kos5VY6A4gKDigIMAAg4H6j2b1C7FckfY' +
                'r8T2L/CzH8fo3R6wOKCg4oEI9Q/FdkfDOh8BwwIGAAQcP6BgwIHBAYnrBNWK/AwQCDiBgMB2A4nYDi/' +
                '4s3g4AKDi/wAAAgBoclccEEuBVzw1Vq1f1f724O+aBdoB0k9JORrzCY2OOrn8B+QGPzsL6UPTTGSy97' +
                'DZd+Aoy6rD3Wo2RlPejzeqAP1rIVAYHUWnt321MMuCNgios3kiFIbRsI+CcKuyiFRer8PFEZA96q036' +
                'baYNE9rcOGTjo73OAp8W07TITGwrrFM2RdrltQOg9/5WXe9cquiOx70EcbOOHRP9LOJz+qFKueYV/6v' +
                'db1kjC3j8wBSl0sqWc3h7rDFbZxjivb4rBBgsu+k7PosKqDm/wFYtJBaWmuOnPdvp+Z2H//ixWUHhYj' +
                'IYXNgYzNzp4DzY7/JOjuylUUvHtSMQMIHA8wcDyBwCnwvcYpz2/0RuLlSKk80E7j1efW0FaTIUscGI+' +
                'WgNUAvDGBT3hN4aAKRNAbSgw/0DGBAJgFN8zfJ5UNoih5craAmPgYv7cBhA4AuDga4CIVgUAnM/dT6U' +
                'LJeYcHIJHG+gqoG+k/96IZS4vavrrBTU3EOnLywYx+egQb4/P4AAAIASHJXHDBRE4Q6okV0EzqjWEPs' +
                'V7Mz/5usDDdgOIAwBUG1Y+gOL2A4H8WB+YMEAg4IEJvmq0RvxWOqHQirh9mCBggwHG+gYUBBxQFH43G' +
                'YHE/iazUTQqsfYflXfH8BwAEHDAgcEBBwPoBw2AYb6BwQUGA/wcUBFxCuF2b8+BwP4GFAQcIMBhQUHC' +
                '/0K7PkBViOqPUA7DBw/oHEAgcABBwPoZTBX4qsDjfRPUKrAoYOqFmrHeBwv4fse1w+oDCdgOABg4YLA' +
                's0xCvH8a4+XOXn7A4v8DAAYOH2A4YYDhf5NULihldADCgoOL/A4f6DCf4OD/CNUKsX8O8hQ6yN+L8Hh' +
                'IgwICDigIMCBg4YCDhgaYAi62vh+a8XQGF7AcADBxgMHCAwYMBBxAMHF/tC/HdBDqhfnjdBDofUa8X0' +
                'gAAIAWHJXHDBREyes6F8BxgEHDDAcYCBhQwHGAwYIFBxQIRsVChdYm8X0n6b4UBxQEHADB5Uj/NeBhg' +
                'UHB+gcUFBgf0HF/wLgHGAgYMFBwP0GB7AcP/EOrHWL4VULPofCA4H+DCgQOEAgwX6DjAoDo1Qcb/Bgv' +
                '0HD/gPGDhf5meP0Bw/8AWkHFDAcEBFEesX+P8gYb/BwQMHCAQYQMBxAEHIkVWL/H0KoDhgYOAGAwIED' +
                'igIMAAg4oZGikldmgOKAgwoKDi/oML/g4HYDgAOhdwq8KGdYuuHcLgMF9A4X+DAfQOL2Aw30DigKFdC' +
                '8IVwsHyFfiyFVQ/kQ/I6F8MM7sdYGGBQcL9Bwf8HAAiPjdEeN+F95dZ7Awn0Dg/4MGAg4f0NSNgw3YD' +
                'h/oON9AwHYDgf5azYOMAgwwKDi9gsEV8K+N+OoDBgIOF+gwP6DggQOH2KGf4rgMMAg4oCDBfwON/gwA' +
                'YDhARxTvNgcEBBhP8HCAgYMBBwv0GAAgcQBRrxWHkQc3AcbsBgQwHA/QYQCBwwECnBxgIHFAkLuH8Q4' +
                'X+AFC8eliF4r2',
        ),
});
