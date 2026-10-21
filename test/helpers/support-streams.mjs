/**
 * Small real streams of the codecs the support matrix copies and decodes, of those its browser
 * cases give the host's WebCodecs, and of the pictures only a host decodes, by ffmpeg 6.1.1 as
 * shipped by Ubuntu (libx264, libx265, libvpx, libaom, libjxl, libopus, libvorbis, its own
 * encoders). Each entry records the command that produced it (the file name last), its bytes
 * deflated and in base64; they load in Node and in the browser test page alike.
 */
const STREAMS = {
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.1" -c:a ac3 -b:a 64k
    // -f ac3 ac3.ac3 (1024 bytes)
    'ac3.ac3':
        'eNoBAAT/+wt3a/EIQC+EK0HHeq9eG+fvnz4y/sTBpX5397AqxfmH3U2H/DfhohA0+3e6jFMjcW0Gy8avPUQosjdl' +
        'x2s5pCWsewMUjVwEzq/LPMctMwp12iaTffQfyRjbfRMLMdtIks31h6flaGpOl4Wh7YCn+Ix2+ZR2u5xWO6BF/Kg1' +
        'fbAk/rQkvrgUf8AkPr0UKMk8fyI/hOnz59Dava7rU9hvnu9+lpUqy3W/ROYaF+NhVntcAdsaG9F0wO+pEBKsELNY' +
        'gEB2HB9bXN5wST15DdCVJAHRk9x2zSz2kyASi5CE1iAfdlf0WvkfmNE3+Vf5ZbEAkeE5TXGQxgzju6NMZrUgvm8L' +
        'dzD5CEAvhClCTRPH8kSFL586TQnz2G+zpUut9SpqaVKrXVUnaWE6fLqUJ7EMv7nQQX4PoAtxZqKwjmApw0koV2qV' +
        'cQRwnOBqWQPoX1dVkp1AOymEXY4LYt1YVMr81XHpxczjIGOsqsNrMJHaiXDFImkQDU2wTrH1qeaW8kz+Toa0DHo1' +
        'sQbYUgZq7YmAyJ9T4P3UARN+foZx9ISRhAtQrwKU0GHNAkiZxS1FumlflIrSIr6pANzFam6DqKntC1f56TbjYzc1' +
        'bOVtMVNg1Qb+rOJ2Q/TrQDjmjLyWNR18UMq3+5Jy4TnmwhFUCXl3WdYt6hqmXsV0QAAAAAAAAIjtC3fikAhAL4Qp' +
        'Qk0Tx/LFN+RfPn0NC9rW3z1/Se7EyV9SpkIb5+5hqK0N+pewzL+5kEPhNaESCQkjyHcaKz35M9eDYvW08vOZRVsj' +
        'hUxKkSS5NIBnkjYz89CdMvLvpfBMRZOrtTZWaRLNJJRlSUaWGRjkCtlAPQZvnpvUQp6Ay49+MqPzPe9gtK26ojsE' +
        'u9UhW5VnjyQBoAfUVwPOYowEHg1+BPdto3LwaQZLVqzvZ2WakgrJtNJNhJAMSDJ2LQF7RgZOir2fqu94ZrcR0pJi' +
        '6Gxo9yqKMokvScvIACrNcBbyhIwZIXWQH1VA575hVpMIbsi+1sncsJptz1LowADg3At3FWgIQC+EK0GJ/LkN++fV' +
        '3z4y/rrACIB/Dfx+FwSGkGrx4EwFgT/L9Ph/gVBoh/ePfuGWWXuMJLGF5a3SIPPAs9cIRtV1CA7qyC7q6HPrWio1' +
        'DpJcgvVk3ZNByd2HDfvn758+AwrK4v7Sduia/goJmFGvHz3TrEjxsQBfW0L3OFrqRYstD3y3nNMUbqI/OpHlCko1' +
        'vWBhcCHKz/9EswJaFb+xu0BKhADBXL8+0wHJHX82ChUffy5nFZmfKqYd166mxRYTzqLkHhHOnRQ/51fPnz58+fPn' +
        'z58+fPnz58+fPnz58+fPnz58+fPnz58+fPgAMkoABklAAMkoABkk1N69MfXo',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.1" -c:a eac3 -b:a 64k
    // -f eac3 eac3.eac3 (1024 bytes)
    'eac3.eac3':
        'eNrjLmeoN2o/wKDI+kDh8d7w9byfv5+fzzb15/17B1aLP5MvNZP/cL+tw+HSt/elEsucC3PZTh9bb+uisck89Xju' +
        'tEzObLkDR5XDGQ2v/Yr42K4346B/2Jm5ylU/fr+Z2Lv9osFm2S2dOvcjqurC2pa8rIiS+6D9U3D3Zulqx81bhP4G' +
        '6n/j2p+w/DuXY8PiHwKLVT7+6fgnvPz8fOesb7vX+ifuq977Kypkte61v8IzMuJ7WyPfFlgnO1fpzZD9qsQUOpHt' +
        'pKeAbDv7tevmc4T845x38nQwvDj5zjptWrXnBE7XLUYnNOXLwr9E/ZSfcdH8Z+ifnDkTlQ8VzXqs2CN5vNytx+hU' +
        'AgMI3FvIDfU/A9sVRbXOxz+VnKafn6vW8vON+c1LS6/9mmpqsjJ03arJWzbMtYv1Er7RyPrDrkH36KyuQ5YNy3lV' +
        'FsYpeyzY6yijvfHQihUcsyqCH1686aP0piBa7NWhZeHPVvf76dXlN9/beC1E6/SMY09lpks0K1y5zfJaPmpeZr7K' +
        '+Scvsh2Obyjbu5XtRuCHzQFZxcqTHx4sUco/f+Gc3YRJBo1Zog+CZvFYNuuqBhp3CR2VULPoOc0nF2JuGDV7wSut' +
        'aqer/6p8d9w4eykwK6d0y9GslIBHmw4da+3Slil2i/OW6tunkRr996RlwZzPHdNNLy3wXuS6ZqqPS0/H944GBgiY' +
        'XYbu/6TZn/Tn27W1vs3On7d/yfeklPUrgxWBicLgSljbX+8bifwt11o8VFT6Fe9krPn+5Hzs39mTn2fpVzlpfVRd' +
        'odVe9W0Tzye3Y3VVwsviYr/s4+zYVFp8Vnj+Xd7kKc2yzgaTPCP4Zk6zZcufN/uK07yG0/11Ros/275xbd7N1rux' +
        '0bJSQmFl7PT5vBPsFu2QKxZJUPiQ/UF9d6709MI0g+45m46tEzNtbErOcufVTBbimdvtEHexcfKi9emvdt+T/B3r' +
        'FakrP+voVs5rLBqr677PZAid9UD3KaeEkdNrBbtVjeerwnbFWE0I8/WMXGi1bHvcSp5pIP8rWsD8b9i6QOHIv5i2' +
        'v59fvZ/PoNRQz/unTpylbULWxwfeTAemf/orz/9FlO2I/Z7q7zwri34f+jO1R183byL7ZMZgXeer6x+rXGTY8l4g' +
        '+2+u0NO1olLtnnqOYmKH+PzeWOTft6/5+eHQpu3v33ieejHrPyvLGY3szY/vWp1y7+1g+prL9c4it1Tp6LT2fdHn' +
        'MrukQ5R+ZimntEw6FvmambuRL9z2u5PNA2+n7d/MtzDKsigUaJ/88XUZ8ySrfzkiWnb/Ys5pG9sFhsgpR/pIVV6J' +
        'aT5kebmj/tz6+XY1Pz8/P4+T+lDGngBEDAwHLwEAO3bs1g==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.03" -ac 2 -c:a dca
    // -strict -2 -f dts dts.dts (5652 bytes)
    'dts.dts':
        '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' +
        '0YfB2ekWU2XR6Ex//v8XOa7ALg==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.1" -ac 2 -c:a truehd
    // -strict -2 -f truehd truehd.thd (3566 bytes)
    'truehd.thd':
        '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',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.3" -c:a wmav1 -b:a 32k
    // -f asf wmav1.wma (3704 bytes)
    'wmav1.wma':
        'eNozUNtU2pd2XnDZTYZVDEnnco4xMoABKxAzMi28s7rHfeV5wb4nDAd4FIJTMxiwgwo+KKPB7uq9jXMZGWHcM2xM' +
        'IPrAMV0wX4YHIg4SbOCBYIZaBoatzPvj9UD2PIbYowfVL3jp8updIPFnEHE2sKjDkguX2B9fEpz+gWHBybgVASlQ' +
        '1YwMGgzhDL4M+gyuDHkMyQz5DCkMmUBWOkMwQypDCRBCeMUQtzD4MCQylDGkMZgxGDDoMRgCaRBpAIQMDBPZ72zf' +
        'jmRzDtQOh3mZP3yjzwuu+MvQEB/joh1w9vD+/sTzgt2bgOG35ZECLETEgJgD7CYQSACGiIM8A8MCfpCQAAMLWAYM' +
        'gQocgi62yRpeEFy8BOgfZo9vTlAzHNHEGcEhx8ZQzpALdrkhNCwTGM3QYnETD/Z4gsULI2MTMHBjZdkhvFZIhHGA' +
        '5MFRxLgogIFZ81RRz2LNP5/6T0OIA/XTmP58kH/6bL+9+c8wM+Y1Nawxcvm2fy4vXS1/yPTAI7XqB7eb3P3PKT3N' +
        'PbiZ5fbPPz9kE8q4N7z8/IMjiCHbr7yh24DZzp9RZQF/w/QD7AdcZjA/UAxh+CAwgcGqtn5ifffmB3Ocn+Z+aO7I' +
        '+b7N/mzCZMbn+wIj7u83zzsQ9v98t0b0qbD9/m/frz3/9v2OlY8XZk3dJTZpW+uS/c5PQMiVc0lApoiUK9tExyUB' +
        'QQIIGBy01mur1pUZxILpDX5AwMgED5AYcIDMBAbIGx8fH1+vrWJ6h7eX8D9Yc47rsmahbncckwoDf0OzAPMD+2UM' +
        'zw9WcCQx6H+IffBI5pr5h1jGmxE6WaErDQ0NDT74DWXAyAwPkDngAJkcwMB0xsdHiNHD0WOhycKv2iXR85/ahPZO' +
        'uS0fI6F2dVnxdXOhmw8U+xgqOPoa7JiPAGP9bwDzA60yoEAigx2TcAIf996o4jnO19ivmbfY1+V3a9TnL8ya/mKh' +
        'SYtIixCjgrCwsNAgDjNGFniA3IEFCMMETjASChAK0PTlqJt+pfByXu3Pj9fMAnNqC57G1Ns2vb4u+I9J0oG9oSOD' +
        '8YHNKYYf/KkMckyrgAKtOxgfKNow/Fe6411xftIG+7M7On+tqbNZ+HXf1FXySz9panBqcCoAw0UCmEgrBmOAsCLK' +
        'EF5QgMwGppD7z163f677zRjOPuuR//MY08NTHqzaIav7bH705/ssO9/n1867drzCmdEqaEf7v9pLXx5oXZYMl4y2' +
        'Dz38Y+/l1/O27nK7NuODgCeDDYsoAz8jWwPzAacHDB8EjRlq2H408Py0YXFx4Gfk2MC05Vj1P/1CaWApcn7fNuuf' +
        '75/vUfjN+MP9kGn/sd9nw9mYHpn9Yf/5cXf+tcAjXRVv/5S0rtNTPy26dftT/mnzFS79/ZVlV+salbmkS2OhaOZS' +
        'gy4BrqDJgRxCU5YJtHB6+SgyeXm2MKrMYDCZzMCpsoFtUgLDpQhmTx3GJRvAjAu8qg05L3jn8k5lO9e0ineq6M5w' +
        'cBnCMApGwSgYBaNgFIwCVAAA92tp6Q==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s16be -f
    // mov pcm-s16be.mov (1006 bytes)
    'pcm-s16be.mov':
        'eNqVUU1oE0EUntlN0vzs7hTMoULABOJNS9pAe6gHRQ9FC/5UKUgvayYxobuJZqcJLbRpKnjoUetFPBQshYJiD/6c' +
        'Si/24KHqXaGCHrwUZrNJkzbdrJO2Npsqgo+dfW++ee97874BAPgTZOLefRIMAsCBAw/c+RSOAwAHVSwTAJxj3l5x' +
        'Hb1FG5LTO+/8AYp1tB0tFSimIX2tIuwsNSxHzpMQB9A02pImfddcn+HsnqvKG4guUo9+vTxSWzUb/JT7kbCI+pEp' +
        'fRNAxxuuaMLqV+MlNSikhvGi+sUE3EzHa58lbSIT9QuL7sf8lGnVVssj+g3qoc8NVOX2nLDo+uS7Kk2gLVQQBzx3' +
        'HfmGtbNUEfU1GqKx0vR2b10CM87v3nnJgTbQO3HdG3UqAO4+qXwsDdDLNKrXK8puwCo4dM+GWETP0KZ0wVt23Yaw' +
        'Prf9tLROZ+kJ/WF5ZSfSmOZ33aago1FUlV75ljsuctzeg2raGKUfKK8Hy6B2xSxwljssDCMRWUgUbrpP88CcqQ2V' +
        'oR6iPNN1Ts1kckxXRc0lMWgz/if7+QEEza9lsD3r+P48+KdxrKBCsvIYi0fJ2H5P/i9sfjsG/79vOI6JxnwgrmjE' +
        'VuFv1UJVxSmZBUEVH5/9VJNuoWDtb84msZJtBmpSyWqZ8bQ9UxhmAB6U01iJsyTYpabSCYZ3amob6ZnfJJiRjGeV' +
        'oJ3Ed0km8hEHCOMDjgDOxhO2ywuHdc14RSN3FOaHNKJhW845ks9of0gEQefRWAB0xZLywRC4TcYujRB77cKhD7Ae' +
        'MRtuP/Ozs8nW4+7jDItlbPlhtkLjmDTFPrms5bNAvPV+SM4l+iLdPX3dPZHIL5OU61A=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s24be -f
    // mov pcm-s24be.mov (1220 bytes)
    'pcm-s24be.mov':
        'eNqVkktoE1EUhr9JmjbNY6ZgFgoFU6hufFBb0YUbRReixVcVQboZexNbmkk1M01RsGkruHDpYyMuCopQUHThYyW6' +
        '0IULH3sFBUXcCDNN2tS2aby3TetURPByH+ece85/zn/uBRJp5/zZc04yCQGWTsJDfSIF2ndLmI7UQ/1E2om/wniC' +
        '8QY9ROQ6oa8wypzBdAeTBVyB24L3nKkYP++yUKUuT2Oa+C6MYYwf6BeIHqH+PdoY8/WUgxQN3Du4jXhHKZ1k5hmV' +
        'BYIXCV8ldgdjJ0YF/TMxaHhMYJSKRvkjxfu4RVxN7cV7lD9QkaWP0PCIaBX9k4qSsRIhfE2hVaoKWeJ7x1Qu97bK' +
        'Ww4wH0Ibpf4d0cPo51WFRkFV23iGuiFVv2QxFVeMJC+3h8lhptuZ02GE0BfVAb1OdcN4qjoT6SCUkS1j9gZTb5nc' +
        'hXsAtwNvjqkMs81UC9R5NL4hPopxC+MT+h4iJepPoWnMXWH6JpOvcMdw1+BdpvSQn20sDBOcJVwh5mF0Y5TRHxCd' +
        'oGEvAUnhEuUsxW7c17hBvCQlmDlIpUCgSriVWBdGHKOq9thxwhsIQmWEmU5KGl6LipLNe2ENDOSlkLHyvYJVI/hd' +
        'bgnJS83fQ1vt9ae+m3+OgJybnJzZL+Vup38xZ/AvaAm/Tfv/vK0p4djybE5lbMcXkfgdq922RJ8phaQl/uS+XsGN' +
        'F6qLypZekckpwerN5OyBwazfM9YlDWK/mRWZlHTSDll92bS0N9nWKtDNyyBCggzmMkk/SHSf6ZgrGLSKJYxmkUul' +
        'fcXHanFK/mY7p+WvY8x2bOHzyfVl27ev6NqK1LRCa8kvWFvyQdg4ZOZTCj+ds8xafCSVFeaid7iGsban11yiLlY1' +
        'f63tLLZ6GXm8djbLynp8dv9dQt5dWP5nNbu09Qz4/FvlahkUjqpi3YQ9lCN+4mWnmU/vaNu6bcfWbW1tvwBzSPJY',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s24le -f
    // mov pcm-s24le.mov (1220 bytes)
    'pcm-s24le.mov':
        'eNqVkktoFFkUhr+qTiedflQJ9iJCwA5k3OiEPCQu3Ci6EA3qqIMg2ZS53SakqqNdlQ4K5iW4cOljIy4ERRAcdOGM' +
        'q2FmMS5c6MxewYEZJBuhKt1JxySd9t6kEytBBC917zn3v+f851VAOuddvnjJy2RAZ00SGxsSWdBmHGF58s5wlO44' +
        'L1P8ZvLaJGpwO87/UabAXKJnnolZhE+bzx8ByTkefaK2QrGBXDP7U4ybfDS5YnAywT+NTGs0LhOpYJZ46NPs81PA' +
        '2TK/L7BS5WqEmzEeJtlnUjX514AkvzYxpaNVeVfhlxIlH81X55MSbytQZVLneRO1BO8N5SV9JcOtmGKrVRWz5D8V' +
        'qFgPfBVXrxBdZkrj70ZOJLhsqAwnTJXthWbGGlT+sorUnKpI1jXgMz5L9zzGEpPwX1R1oMFQ3Xhhqs70xLGjaHBn' +
        'kTdz7J/lqE+Pz1KAPUfrIhM1ggZeNzOV4p7Je5ODBuU45xrRNG4scXeel7NM+2z3uR7wrEznJ8ZXWIxQjREk6Tep' +
        'mDw1eJzgUBO6zrVl8hX6S7zyifhkAihzbIGJKjWd9hink6RMaqY6zyT5IQYRJqv0LaCVaQuUF/qfzshIUY7ZdoqD' +
        'gk0rMiOPtKpLC8PaZqut9wN8c+ny2+0VrGGp93vDqzEjX2FLhzHt++O2Z4XnStmatV0v5JH+4qs9cMSQJZWMI7bW' +
        'vlPR3ZdzU+vHQWEXlOIM2gV3ZDQftkyeloA4YuWFnZVG2nFnKJ+T+DbX2US6Z51ESJLRgp0JkyQOW561wUG7WONo' +
        'FYVsLpR8su6n9A+ud96Wctr1XBGyKQzlu/du3LUNbdtGWWt2kfqWA2HXmFXMKv5cwbHq/vFsXlirlrE6R8vAoLVW' +
        'utjU/BbXW231OvP9umyVmQ2E8PBbWr5dWf/P6rjEBkZC9u1yt40KT41ox2N3rEDq57/6rGKut7Ojq7ejq7PzM9of' +
        '8lk=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s32be -f
    // mov pcm-s32be.mov (1380 bytes)
    'pcm-s32be.mov':
        'eNqVk0toE1EUhv/Jo6ZtkimYRYWAKVQ3aklbqAs3ii5Ei68qgnQz5iYmNJPozDShBa1WEHHpYyMuChWhoOjCx0p0' +
        'oQsXPvYKCoq4ESb2aWMa/8lN46SIYOBk5p577nf+8+cGQCRljZ0+Y8VigAfyiUAxI5JcX9aFZnEN/wjQ1geEXgLq' +
        'Y8ZrIOxn7jr3vrDgAlBWgYV+4McEYAtGF1B6BswHgZ93gJUq4CsArSlydpBxjvGdnHGg/RDQ8g5QJoFfLcCiF5gl' +
        'z77NaCXnMDB3HFh6ClRWAO9ZirwKBLmvbmdUyPnENaWse0Tl1FNRyPlAzj0yZhmKfM7eZf4991nrOc/6h+xPbeGP' +
        'kuPwHG7gmuxTqcq+Tv/SEanHnpb6Fj3USx8U9mt5S85BcsbkXOqEnLP1FOcuyvkdH+ZD0hfHHztBv+jDAr0thymI' +
        'evyfpa9hn/RZfSJ9b6O3/ixrOMfyDXLe8Cz59j4G90pl5ri/HAWq7O0rsTfPh6hNvcXgfOFd5MxR6wliyClfYe+b' +
        '5JBv03t7PTmXOOsDao1TM7V5l+kFfQmSpw4zFsm5z1ln6N1ueuh4cJFe5OgJ9+1XDP5+Jd4ktsLSfnpIPR7OH+gm' +
        'Z4gMeqBW5TN4lPlN7MPaCudfGuQ5ait1SQ5PPtfzed4cZPVCWqDp4/3Gr4jjieJOK81Va9c78c8PJ/JssQyNtx7D' +
        '1kitp/cvtIg7p/x/3+6ksEw+o8msablORP6cVaZ1kdH4EtPF2tk3OripiWptsS0tsobzoqezhpkfzbkrg0NMiL1a' +
        'TmSTLFIO6Jkc/4boMPUm6NZViCBk1MjG3JD2PZqlNRjoFpIRFUYy5RIfrJ9z3r+a1knnyk6alilcNUYm19/XWCuN' +
        't47GWLLOVw/+INhc1ApJh58ydK1+vi2ZE1qtOlBndCbSmhxdNJnfaVo1q1fJU/VnlMoSrrx7L8K98fqer55nLpF3' +
        '1fNCo2tUWI6KDTNm0UDo2ItBrZAaiPf0DvT0xuO/AX2S8fo=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s32le -f
    // mov pcm-s32le.mov (1380 bytes)
    'pcm-s32le.mov':
        'eNqVkUtoE1EUhv/Jo6ZtHgWzqBAwhehGLWkDddGNogvR4quKIN2MvYkJnUl0ZprQgk1bQcSlj424KFSEgqILHyvR' +
        'hV24qLpXqKCIG6GxrVVrGv/JTeOkiOCFM/fec879zjn/AAinrJFz561oFHBB7vAVMiLJ+2VdqBaqa8gLdLcAswHg' +
        'cQiYo3mDwHX6PjI2wZzQKpD4BhS/AmIB6KA9KwH+ZeDOD6CyBuQ9QKoZ6CVnjIwvtFFyjrYCb5qASQVo+gW4V8hb' +
        'BG6T0Uw7Rs6pJeDpd2CtDFxwA1d9jPuB3WSUae/JAe+PNrEfF6Aw7x0598hZJENZkPtd3t/SD8bHmfeQ+RXWnw9K' +
        'js2zudd8sk6lLOva9Y+XZD/TC7I/Fzle9jvBvl+z/yPkjATlXMWQnPMs5y145Py2DoFlqYutzyBtjHp1U7cg9Rtn' +
        'Wx+8UldPUOr8JCR1T9CnMcZSuPETeEVOL98eJCNBWyVToy/CWLEClFhzjrUn+PYWGfO0vWQukXOavSoEXWHNm6w9' +
        'S84kGZtpl8h5wFnj7HWMPf+kBmVqUaImA2Ss0O6TM8NZ91E7FzW8SA2y1GKAmrwkw02LkgNyDlG7IjWsMC9GTj85' +
        'ATIqIbmf4H0b/WCdceb1MV/hu46S5Lie67lcnnFNz6cFGpb7Mz9hWxLF6VYaszbe9+Cfi326dliGOsTzgDVUren+' +
        'Cy3s9Cn/XzeWFJbJPZLUTMvxIvznrTKti4zKQ1QXG2ffauOm7D/NtSstNMM+6GnNMHPDWWemv58OcUDNCi3JJOWw' +
        'nsmm6G8z9QboznWIIGTY0KJOSOt+1VLrDMSEZESEkUw5mvfX3tnnT6Z1RuM+aVqmcOQYmWyiu35X6qe2+lgyz1Mz' +
        '/hBsL6j5pM1PGbpae9+SzAq1mumrMdoH06ocXTSI325aVanXyVO1PcLOBh1+ZyzM2Ggt5qn56RvMOfJjtI5hYdm/' +
        'aMuMWTAQOPmiT82neuKdXT2dXfH4b0xH8fs=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_f32be -f
    // mov pcm-f32be.mov (1380 bytes)
    'pcm-f32be.mov':
        'eNqVkkFIFGEUx9+qBykTD3swENtAupSyFkTgPJigQ1CEEB2KDk5+u6w4s2sz40pd2jzlSU+eOix48mSHutQ83ENe' +
        'uiR06RC0h8gQioUQEcvt/82M66xE0LDj975v3vd/7/1/ElE67z+aeehnMkQdFK3UPTelctg/c5TlY088PEG8kiH+' +
        'NE68j/jXJnEd8apJbFRo7CmRDGZInm+SfOwj2auR/G6QfEG8ZpLcMCmgCnFvjXgZ9z+8IN6tEx9AZ6tK/Ao17hEZ' +
        'V4mCgwrJInTe4+4OdJozJNvQer1EUpigoFIh4zPqLqCfd1h/zhA3ofMDGjW85SoZVdRbx9151N7IkjSg12xE6wbO' +
        '5scpQK5R1fnoa71B/L0R6Wg9rbuQDesEFTOsG9bfrkf97MT9LdbRb40MExp3Mc9LaGwtRXPtNqI5l6HXWw/n1z7I' +
        'WjbyRfuzp/3SvkF30KSxCvoxJiJf62bk8/5M5PtKFhwqdAU8BDwEPATnAh6CPAEPwT0BjzfgweDB4MHgweDBqMeo' +
        'y+DB6MPQ/YCHgIegTwEPQd8CHgIeAh4BeBjgweDBmJfBgzE/gwfDD4YvBngE8EnAQ+CbwD+BjwIeAo8FPALwMMCD' +
        'wYPBg8GBwSNcwYPBw0BuUNX56As8BDy0Dv4Pa06pVEZgO+WCoran8xv+pClF+nf0pNqzju9N+ufTgd9537WmEd/3' +
        'p8OanX9RSyfPUv9fdyinfA/rQM72/MSN9NHd1IqjpiwEGUcdn/2Mlqs+aYab4YKyXR04Bdv1SrPFZGbPbRyo61ZR' +
        '2TkkpW45U8U8zvs8p030wqGIgsisa2eSIievWb7V0qAhFWkMKDeXTzTfE9/T8VfPf2Bjnfd8TyVy3Lx96WJrn2pF' +
        'fa2xoryu+AUQOjdnlXNaP+86Vnz/RK6orDC7O9bonyxY0eiqzfx+zw+tPlSuxusAOptMnCe/pfHtcfytKz7H2WQp' +
        'kT+E9+ys8nUXp1e9OZdO3Xl70yrnL2dHRi+PjGazfwBk6lvz',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_f32le -f
    // mov pcm-f32le.mov (1380 bytes)
    'pcm-f32le.mov':
        'eNqVkTFIG2EUx1/UQVorDhksSHsF6dIqsQUpeAcndChYilA6VDrk6pcQ8S5J785Iu/TM1E51cnIIODnZoS42R26o' +
        'i4uBLh0Eb5BaBOVAREo06f/Ld8aLlEI/8vJ937v3ft97/0dE8bT9Nv/GliSiDhI7dc/PsBTuHwym2cRXckghaUWh' +
        'yR2FkjWFqmc4+wqpqwo5skK0MEbSLZeqyy71/XDJ++1ScI7znkvqGmzCJYfK5PUif0mhz98V8k/BqStU2kf+OmwK' +
        'Ni6TUy9T9RNyt8E5cSnfAOvApcUNl5IZcJwyqbsySR/x/pZC+WNwGsg9gnngFeAvyeRVEFd0KbGJugIwGmJXcZ+E' +
        'n7wyEeIcxAcV2KHgcB7nJjgf76h4j7/L3/cPRD3VE1Gfjzo91OuoMvkvwfii0OK+6Cs4FX3m0a+Pvnn/XIfEmtCF' +
        '61OFThL08qGbCv3IGaOkLHRVfaFzviZ0T0B/B3MgeoR5IG8FfexAkxo4Zzj7YKxCHxmcha+YB/KXFcxDwTxQzznO' +
        'e+CuwSZ4PdCoF/lLLupEDafg1F3MA/nrsCnYOHqry5gHcrfBOUE90Cg4QJ8bmGUGHAca7ZYxD7y/BX2OwYFGdMQ1' +
        'Bq8AfwmzryCuiD42UVcARkPsKu6TRT47GfPAe4gPKrDDkNPhGblcAX3rRiHDqG11/sJfnGLEf5cr1h519a7SP1cH' +
        'fvdsU5vF+ZU923yz8y+0eNQX+/93B1PMtrAPpHTLjmTEL3NjKwab0XCQDHa199scV3rfaF6GMkw3+cHI6KaVm8tG' +
        'I3uew8GeaFmmpxAUe2bMZNPw91lGG/T+BYQBMmfqUhRy/bFmay0GDTLBGGBmKh0pvifM4+eflv1ax160bItFYsy0' +
        '/vBB6x5rnfpabYm4rtAwELo7rxVSnJ82DS3Mv5bKMq0Z2R0y+qczmmidtYnfb9lNqS/IpXAfQGXTEX/0Wxzf3oXf' +
        'ukI/fNO5SPwg7M4cs/mIbq5a8ybdePHtqVZIjyaGR0aHRxKJP1shW/Q=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_f64be -f
    // mov pcm-f64be.mov (2020 bytes)
    'pcm-f64be.mov':
        'eNqVlE9IFFEcx99qwWAGHvZgsdAGIkElCiERwfPQQSI6FN0kmHyzrDizazPjSl0KTxIdPAhFRRlSJla4prn+2fl5' +
        '8NAhokOHiE4dpFOH6BAh1sz+vrPOkwgalO97b37vN79/nxVCpHP+taGrfjYrRINgFcbIgLKE2Gs4yvQFHvnkOeuC' +
        'Yl29xUo29B7rWhPr4hHW6XHWoWxNaWqD9RXb02oDK52EBqxro6yLX1ln8qw3W9jf44+s829ZV0qswRbi+YR4frC+' +
        'nmSd7WEdQzyP3rOWf7Euf2ENKojnG2v1MuvSBdYXzazjiOc+xynLbazLvYingHjYv6yus1ZQ15cfWCcM9nfnJ+sc' +
        '36fKU8RzEPFs6/vKM9ifZb0LvxOxf85PLm3j+4EeTxxfHG+5XcuHxg093zj/ap9en2BFr195C/VFn8ZQp9nT6MdD' +
        '9Oe73q9gW+/n/Dv0+7PW//o8LG7q8xLPD53CfO3BvD3A/L3BPKI+07f1eV0z9Hmmgj7vCznwMMcKPgh8EPgg2BP4' +
        'IPgj8EH4HoEPAh8SfEjwIcGHBB8S+UnkK8GHRD1kXB/wQeCDUE8CH4R6E/gg8EHgg8CHBB8SfEj0V4IPif5L8CEx' +
        'HxLzIsEHxfMEPgjzRpg/wjwS+CDwQeCDwIcEHxJ8SPAhwYMEH/U9+JDgQ4IPmoj9g3/wQdVAiyf8XVx3isWoeLZT' +
        'yiuhPY1RUmmREtHfzpPSrXbve8Q/n7DhDUd91xwM133+YO2bjX/xlk6epf7/u22W8r1QM5bt+Ykb6Z27qSlHDZjh' +
        'Iuuo3bkfitxN3vhd2xzPK9uNFk7edr3icCFp2XwxPFC9ZkHZVmiUOu8MFCKKWjxHc3osdqJCJ8OunU062XfG9M26' +
        'D9Gm2EdGuVYuEXwz7kXrTc+/EtE36vmeSti4Obv7RH2fqq9a6mmxnYH/iMD2EbNkRf5zrmPifpNVUGbN2oCP1v68' +
        'yakrrfitnl8rdex5EpoJI+tPnCffpcN31/HOwHl41l9M2EcsHR5WfhTFgRlvxBX7L22cM0u57s6Oru6Ors7OP5TD' +
        'ZUk=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_f64le -f
    // mov pcm-f64le.mov (2020 bytes)
    'pcm-f64le.mov':
        'eNqVlEFIFFEYx9+uBYNt4GEPFkIbLCFUohASEYyHDiLRwegWwuSbZcWZWZsZV+pSeJLosIcgqagNKZVSNFNX3d3n' +
        'wUOHCA8eRDp5EE8ewoOIbM3s9591nkTQsLu/ee99883/ve//LWMsnnIfDTx0EwnGoozIlKE+rjN2WjG55rLw9fmD' +
        'WiX/Sny2QjQE8RVYXyQ2zxNz48TEAHFtTFD8HDG6QrwuiGVwuEjcnSemJ4kNT4mb7ynf9y/E7DLxqEzcgp596Mkv' +
        'EDs+Qc8Icf0d5TucJW4vEQtl4h709JSI3YvE2BT05KDzNeVLzhI7l4gW9BxCz2qJyArEjWmi8oJ48JLydc4QPxaI' +
        '56GnIuTxBNa7EM9GQeRbR/7KIrFckvUE+gK9l6A/2I+Sk/cb7P9+ST6f5bJ8fkc4z02cbwPO+ybO/y3q8aso16tS' +
        'luv5A/X9iXoH9Q/8sDMv+yXwzw3wFPz1Bn77Bv8x+PH5uOxXpSj72RKy31Pw/wz6gTEV/SHQHwLxAv0Bv4P10NkM' +
        '3blxgf4Q6A+8f05Ff6joD9QPHIbOXehOTwbno6I/BPpD4DxRF9RpC3r2oSe/INAf0DMi0B/wC3yxDZ8UUKc96OmB' +
        'r7rhs9gU9OQCPwn0B/wNn1jQcwg9q/AVg683pgX6Q6A/4NcZFf2hoh/gHyGPJ7DehXg2CiLfOvJX4OtyKaQnumpm' +
        'Mlm/imY2zaX/Q1a36/3EWYT5n+MrIkedHHewf15R73PZtbV+v8Pc/uo76/6SLR6ei/z/e5M6dx2PTbrhuKEn4sfP' +
        'RsZM3qf5TjD5yb1f8NPln/yuDq6muWH7N2basJ3MoBWOjN31JninZnFD94Iid8w+K+XbwjGlpFeCJNxLMmgbiXCS' +
        'M7c0V6vlYElOOZq4radC4mN4zr/fcdwHht8mjuvwUIydMtqv1caR2l1DbVsUp+Ab9f8Sh7Ss7udP2aaG5+t1i2u1' +
        'SP9q7E1rtHUuHX6j41aPOsicB5s8Zb2h+fBa3Ft7jDUF895cbyYUn/S+Fwe565fo3KQzZLOz99Zua9lUe2tLW3tL' +
        'W2vrH2H9ZUo=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s8 -f mov
    // pcm-s8.mov (846 bytes)
    'pcm-s8.mov':
        'eNqVkL1SwkAQx/cC8hmMRQqcYUacoVQHGysLCwsLO8fOJnJhwpgjmjtgtLH3KSi18yF8GEtAUFED7hE+Lug4401y' +
        'u/e73f/uLQCYVXF9eSWKRQANQgupVo3aaO8ZtQSsZHKGsZpZgc/XXqfTHQxH8bQk2QT5entB0n8PYikdiZ7UAkk6' +
        'L2+BlsyuGoaeigXv/a4kXyQhSS4dHw0HSHqvnygtCUp/DCbSH+NQOpMgYbH+cBRKZ5PavJgmyVwa+75jntfEfl3W' +
        'dChEVuwZNxMIyG+xSDRq+XwAfy4NEwbCty7QPxMXk5qxX9RMlZH/1y3ZVHC0BdvlQskwF7mEMVqz0Ckyuvz2DSnX' +
        'vh1PDtsOdX3pMMf1udeoq5H6CQJ6ZNWpa2MQybNavYp8jbOI6NZMhKJIw3eLqkj20BLWXANKNNQoUN+uKs3r0zzp' +
        'P3Jx7qI95oJTJWafey3xY0QEUvNnAeQrjhU+gkbGmOdiMrRZbntqC1ijonD1zsS7m6UcZBVPYSX8NxtUyGGvP/CW' +
        'D7nTp2OrWd0r7+zu7eyWy9/Uf6Bg',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_u8 -f mov
    // pcm-u8.mov (846 bytes)
    'pcm-u8.mov':
        'eNqVkL1OwzAQxx26VAIkhgxFqkSQOkJVlk4MDAwM3RAbi6lTpWrcD9tJSGkKbaEfaSGv0BE2HoKH4QWY4dyU1i0I' +
        'CSvxnX+++9/5EEJ6Sfj1hjAMhDZQbFHSKxMT7DMlWNw9hI9R9BQ+3N24rF5vOH77fiTJuN9peRyIuA56wwmQyaAb' +
        'SFLnXtAdjJ+iaDLsBdeiIUmr05fkcXTf9h0gzL0BaUlAuunMpJu3sXTY78TFhN+OpceD7qJYV5KFNPQd0lrNhX5t' +
        '6loErazEO2w60pD8lktbjVo/n6A/1wYkfAiGK+BfisqsZuIXNV1l2v/rZkwiONi0aXOhZOjLXI1SUsbgGJSsv31P' +
        'yk1vP2eHQ4vYTDrUshmvOVU1cuscADnDVWKbEKSlaLlaAr7D6YrowbcIARGH2YYqsnmKBV5ooAyJNdKEmSWl+a15' +
        'nvRfubiywRa44ESJOWbYM36MSEPJxbMQShUtHD+CrIwxxcVsaN+507lNQ42iwtU7He6aaznAijWFZeDfd4iQw959' +
        '4R5D2xdvBeyW8rnsUT57lMt9AQogov0=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v libx264 -preset
    // superfast -pix_fmt yuv420p -x264-params threads=1 -tag:v avc3 -f mp4 avc3.mp4 (1742 bytes)
    'avc3.mp4':
        'eNp9VV9oHEUYn8tFLaVKKImNGHWCEQP27nbvkmsSutCSFE+wGixWW0qX2Z3Zu+X2381Okrvog1gf8lIqqQYtqAhB' +
        'GpqHlkLsg6UtRB+MFZUiDa1KoBb/YCsK2lLq+c3exVyidrhv5ptvft//2TmEELZEJbBD30WoCckVKE1GTdUNelSE' +
        '0DqLM4ZQfMylRADm6N13VavTl3f8ePrqYu7Dqc0X8eKj166X09kenMCmzxlWgeUZVenDGZWp/VY/HOSSAEjtHN7x' +
        'ZKIHb989CEjKTDgY9IOKwyyB04qSSaSVdAaEBSGCgVRqbGwsOWpT5jvES/o8n5JekgXhOoDxA2H7XjiATWIQU1Mx' +
        'ZxbMlBmObxY1dUAZUDDxiFMJmaaUMwNA2GUatQkORwzgVByEldqsc6qpSQVUYMKuXWZUl/aAZzonXh7QWWwWuO8S' +
        'PVIVnDmOHQKir9xHTQEis+TCljJCx32PaWl1s6pii4RCD8KiHUhEzUAp0H3LCpkAuChwUAjh0PH9IinARl+RhY5t' +
        'shWBgj0euTBtlwgZhu0Jxh0CIJAbzggnFd303YBI2ybUR3Bie2ACgJxIjMWJy0Itgw09qABvUy0NPKEkkEkYumET' +
        '6YnanEVpjTE7XxAGcH7APD3vB3BaE8qciqwCtrV0r1Jnddf2tF4cmsxj5ojQehQcOZcF5SwsgDY3NZNb2DWgikwG' +
        'yi0tnUkquCRj15RkFthA2olWUtay/cCEggVaD7YDaAk0HzoGtgPjn10GGl6CzstOolfg7p5kE6+h7y58ffjV2Uuf' +
        '79zSdf/5iRN/pZ5af3zSeWL+XOcXBy8vZT8uP261Fy+l3/BnN7Y4bTPb+AM/nT2QWMi3J+/77cDVPVe6T54ez5/p' +
        'br4neK534+Ttt1KTpX03h+iZw+fx+IOn5l745NuHFxd+PfpV5lb8s093/dI6NzzzTmfXH3O75hdPHX8/d+3N6kvT' +
        'V76fvhl+s3DsQungpkGj7Zl7j81MLb19aPiD9x45sv9i+ta7z+71ft6COn7/85z85LYf6WyfqB6DFOIp1/dHQea4' +
        'owWKVo34DwjFXkcxJH8rI7YatXa/Dd1xNMFvD3SrCPw+UYx8xv9tDfyiO/v5T78tdUKoi1ERwtrBnFCsaNTtRrqx' +
        'L134WIHBLl2be3dk6Pn5aJMoUIcvn8gHoxG5Wz4gOeJRh0lM7GW4VhYwraNuZLQxzC5aO+ugcFcb0tgwwh1cD3Br' +
        'KAwH+I9CEdIGzCy8mZn/KYWMtQXlYM0tI9qeBnxWSWbUpKqksWMb8nFr0GivVmGWL/FgjKL11SW0KQ/r7OL+s0Oy' +
        'Jc1y6t6am3oxhpoL1w8t3L5xI/IUkDCoxyCpFT6yeoGHZmuE2kMRFX85Vmj6Osm3Qk6NckkdIDPXyJoazsZXX564' +
        'xG6o2TL9Bj0FyBihQjZ0r8uiVY7OxuZBwzkJAqexdAm7dkMemxG+NPgQ/A+R5SJDFS2oopqFKip/A3fcueU=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=64x64:rate=5:duration=0.4" -c:v libx265 -preset
    // ultrafast -pix_fmt yuv420p -x265-params log-level=error:pools=1:frame-threads=1 -tag:v hev1
    // -f mp4 hev1.mp4 (5461 bytes)
    'hev1.mp4':
        'eNp9Vwlc09jWLyCOoAIuoI5V4wIuEGjLjlNFkUEddMARVwTTJKWRtAlJWqgo4K6DOiqKiguoKA/HDVkUV3BBfaCD' +
        'yiCOCyqigDos4ogL8m7Sgsx833v5NbnnnnvvyVn+5+RUJBKJlZyeJlhKLRKZivgR3DI17SYViUTdlAyOg+GQGkM4' +
        'kcg8f5TJkR2by6puuMZW221612Cy3maoxdpYU9exvS2kaxqssj65xR/J/Z4bnDGwb2l69YuFVkMsg5y83VcX7oh/' +
        '0ENXeyVZmrXFv7ktNTJ2s4QOfrPPqmQZRmWeHdt8IipyvChodUJqgVfX5cU/tr2qQ2Psvd5IT+FMHtlsLm7MsCov' +
        'Wa6pc5CltZ11mdsl7frgKf2cofV/JKz1evud292UF1nyV1f9kvraYqWrt14r+dATZ+75yz5fjTSrF5f0ceqe3R0R' +
        'vxgR/4ieITpcJP987PnWuGfN67GhdoU/tnit+bY5aX3tq/1pVOO0cK+7Zq7ZA+bcWtsn0it51E/106PEjmFZ/vp3' +
        'erPygpGfqm0iueLscftsMf+Ixozw55Uf1pU9db/i41asLfkS8NH2+t4JtgsdDi2emu3iHKgP/O0b9uKBgf+2icus' +
        'foAHBJRN+yXVKahVN7zheupHv8Xhk13G2b3scf8kav3xV3J8waY/r+w5Z6oXnbhz2zSs/o5j7yURpx4e2RVf779o' +
        '/Y3AoAXpcXfTi3tfCDK92TP5YJcRcWsPBS8Z4BK/4eJpi/e6f1Um1H3IQBY++n73JeJNUXhA8pAJ2yaUrHwZeNs3' +
        'fkul7bnUU4ttI5CWez4/3dhm0+pPHE5d4V1Q/uR3F6echwcmut4+FrYrp5+3yupwTWjQYezsPdOAZX6pLrNDuvb8' +
        'NmLIzJXxJV0awpitlVeKXiQ/JHu27j/c3TJ6ttg2Ob0pMilwmI2F/sIYtYNlU3pVc9n20Rv2FsdKpthl1N7csG34' +
        'YTPbB6bmH3+pCIPzb+pT3q2+P82uzmkGPiPnxJjdA+8Uzw/4eRE7zPzqQHXLdjqxNnF884osWfxW8/wsB7Ffr7xQ' +
        '6ZrC10+vfhy1X2H/Y0vqIuyNXaTFSMeL720e/HzujcfO2/ED/M+sLaKd+/+Z11Vfm9Qz7ALpkHOyumLO0v7SGv8j' +
        'sMnKL7slG5U3c0ysVvWKagy69iI9HPXOlt4Wj7t7lCzTIGRozql5bZ82rsj2bP4jIeihM54b+nRzSnj/rrEJ1xaT' +
        'e/atstdMWPd+lU9uzhu3Lf1Sqxzm5p5YH3ivIDG5/nm34H6p73ulv3KwzqyW7RUPC++eOsVmpGmcZ8yklM1j45Q/' +
        'OCp39Jm/P8qt1jP+1YKJu5rft8EXMyfuqyUrV9c8urKvZJXXd+c+JZVXD0sr6bXdvCGq8E39nZU+zZIejv4qmrm1' +
        '0TZz3Xeytwe/j5l9/fSq2LwuPUOrNtxLvvPbl9K3eZOeuHxT79Yfmf1M6/+018Uzy54Vb8j2bTp+Kth87hSnmFGK' +
        '0WzZ8xUWFQtfitffrlR6vlhgf0msCZkWbnd5enDmpufYWOv0H3LCGrG1l69PSln74YH1kSRTj7TERyHFy3xl1rr4' +
        'X47vuX90i3jWrAnSExot2++cv09Y19UXPu8KfiUp7r27/nPhmNmVx7Mumr7r09/+wtKu5TeWDFJb+I35cAD9vWZL' +
        '7r23NTVv4r9cVd/ZiM6zHblv8oGY6WcrvoSevay9U5WvL7a+6zKpaLP+teUx/7kVmeJi6zKq5ULG06ri7ZLlly2K' +
        'wvJCRsVEKdd02aSr+bLxu9/XDrhZcsY9Y6jNlSev6kMbJmrGpSd/ijW5UnX/nc/CrOV9fKafPta72nv2iuQ/R7f4' +
        'L2+V+E8OGOk51z4k5/w33Yb33f3XktvE6C9LC9/3TgjtuWDkooq5y5xbrafaXm6s63F6WK2m17mUATbKA7O3Oa3W' +
        'upcpDhTVj/yQEfd4fm1huln6bwnhG31PjqkescDvxCDizNjdIXN2nPZutVjth/vWUUPCfPc9sndX1titmlkYejDp' +
        'xdbeTjdF3xZX0i8ctrsc3BRclD/u04cxkUPMAkrrOFV6o/qXT8e4nQHqRP8usb5Ljzo5dm+Zur//tJo6i/wDqinV' +
        'c6AlNuXx12edRAuVm8c5yY7vkC45Htvn2JajR7btS/Y+tN112uik42WNVGV93oweJ486pQbHFfbNWHM+b7X9eDO/' +
        'zRd/nbJva+htLMJnYAMo7o9MTUotYlYWVHw/9WGQZ544ki2ZurnWL2bW06eOA/dQA4Opq+Nix3NTI81IXc+smXQX' +
        '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' +
        'AH93AAY=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v libvpx -b:v 50k -f webm
    // vp8.webm (929 bytes)
    'vp8.webm':
        'eNqTcr2/eL5TWyOj03cg/tTI4vS5kcOpqaU8NSnXqb2Ryam1kUkiuCGdkQEEmAsFfWeX7PLd3R28ukXUc2Va8JrG' +
        'hRCeWMi6bCDvhu/uHiBPKORwevCaJkY5CFcmeDdQsok5+g3EHIZIBloBkKs2aV3f2Mzv5ODb0OuTWJZmZqBnaKZn' +
        'aGAQ7ojKd+nscKiEaAM5/+A6qOssrjcyFh/tSNwx63RU3NzpcxoZlLbOaS7NS+loZGhrDYsPC7BobmRUftzcwv36' +
        'EMODzg2NArsaBWY1MoG8/ae4eEHygYb0E7NcF7e7+jn7u7gGubSjWlxcfC35QHcywor0EwuRVU8Bqk4GqjY2BKo2' +
        'UsjJTCorqACr6XAJDXIM8fT3c2mfbGBgBUZ6JgZQwCDvvK3UcdvzRobFjl2NDAwNAdwMcxm1BBgEGBjcOVpbO1pb' +
        'OpiYmEqXMy5l/tP8yTuFvYL917oP/Az8r9gj+F/5f7lfIP/w/jnZN595fYX+OWQ3/jv4jLvj+o/3R/gX2D+qP2a/' +
        '6J9NfeT//6caf4W/rV+QmRC5wf3Cv/8/XoS//638325TXkj+GZ54Ifknud32/7qen80xX/43JS97f3X6f0PVfxPD' +
        '7a/7/NPadMlpN3PqNz9O9/e3/k0oyFzS7fvizhnHJvH/9v+U/17h6zfheavVbX96dkRl/f+jT2cESbQ31M78d7yj' +
        'wZfn54yTDE927nv9//91q80l5150fNvGrntY7f5vfn+9xbcTg1zV6+T+f7Lo1D6Z61n/QDpw+5z5h7z+3++41tek' +
        'mHb488T+/8uk/k8Xr9DpfuiavuQf/78ZIpk3r6eucTdq3fVqUf3He7rnPx5vmzj7QqeNvvH/e+Y/Ju6/9mvl8v+O' +
        'u/Mtrtr/1l2m4cVd1+mjYXAqL/5f7IYjrVwFj23NL/+/0SmQzRXyX08sI22XyLqJov9uuv8PXV8eu3HSRtUShsVL' +
        'GhlOMHxkZGAUEGCQvcFabb/EfJ4EK8NJVbneGh1/Pb+Oi9/4GECZZOLu/s2NDNu7gJnxYxPj/A+NzAAn3HZX',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v mpeg2video -f mpegts
    // mpeg2.ts (1692 bytes)
    'mpeg2.ts':
        'eNpzdxAUYHD6oMrAeJCB4T/jfwbGPw0iHkKMbG5uuQWp6ZzBqUVlmcmpBoblNc6n/g8u4O7AIMDAsIEX7HYGxg8M' +
        'WhtZNv0fGsA9AOh2pg1CYLc/ZPjAwAQi5nUrXxwCbndkMGAPYGCo5qkDhfsDBoaGA1yGDJypjIIM7DcSgUKbGRkE' +
        'hP//fyABZG8V6WJgZGABsnYwcDA4AGkGBv7/P0Ay/f8/OzYAGYzCPw8aMnA3mDCUsDL4MdZJnly4o6WNYc2GS5km' +
        'm7K8eNSEOVwUFy5cuHdKw6Fd0XVn969lUGYR0GbwYrjIckG4SfxPow/zloYGHibxn5MZ1jHaqbXlMfMxM3U6qB8I' +
        'yTJn3M6j2nM4IundCsZOA3dGBsFZgRwMC5hjIhg/cnAx8X8TZnZwvtitwXJwgbqDBFPjwhWvVBmn8nqz5d3Y8vza' +
        'B+4DCYyrHLiCGHoY3vA0xB5jSOCwP8GYGMElxiTUIKvAwslop2hxgKuBL4StQJEh4EKP1AWGFwKMJowGbA0BLDLt' +
        'BxZkiDK1KGhN4DrAz9k4p82ZsanQmOElg4jAP8YbfN+YrR9lJq4pNNj8voAxgClIjvEC8wPZyQwlEqwMumoNFoqP' +
        '29pKihJENZjjIiSBbjdayTBEEvh/xbomQd5Ie5GeKBmmKxXAvCo4hPOq4BDOq8ZxwFJynkkdrVIOchHwcaEgqBwA' +
        'Z/Lw/79BmXtrozw0lwvN4JX/Z5n84y1DlYsMu/Q65ooOtgPvKxhKHI9zRX6QCYhq7VdKq1+Q9v9zf87Gk4dNABQC' +
        '32o=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v mpeg4 -f mp4 mpeg4.mp4
    // (1234 bytes)
    'mpeg4.mp4':
        'eNpjYGCQSSupLMgszs9lYGBiANFAbJRbYGLIwMDAkVaUmsrAwBiYm5JYAqQ3MwiwA6ltgo1m3G0bpPgZLGpUGi+t' +
        'mmsjX+lgHhkWF7dm/xs1jxg7ObHVXvP/RLZ07f8q+e2dxvevp5r5Dj5ISGe7EJBUqCMTZ9Pkf+BDreOBUoN3LBJx' +
        's02cFhk7fnBs8nja88PcVEFaQEFah8Ur6uMF41ztTwkJPByFG/L42xs+2N+brs5hfuM0k1BB84NgjpOXt4YJMPpt' +
        'zd0nnrbiU9ktmYefH3kWTF5wSK6ZU+HoIg7FoAMO7I3/5okbsvs2XmOcasLh2yJh9zLB4IEMh+0HzSfsTAxNPNv4' +
        '3vc9ZJBj4tyQ6nykyWz50jP97ocfvn/wRaJgYqh8v0vag9+HnB0ePfz3oE/xpPeng78K/4tlOMmd2/TggwjDVRs9' +
        'hoOvEj+zHuiaItn4R1rTN2rpIasF/Nccbvz6u1CjXCTZ/KTUp7Bux+YvPUf56kFBF3ygl4GBOTY3P78MGMA5uWUZ' +
        'KQwogPkFUNkEBkYGEEIARlRV6HwHBryACYjaS4oSs4HsmJJssJ3MmKYB7WXAbw9WewWgmIFBJTWlpBhIy6TmFJcg' +
        'dEDNBetl/J+bkpkIZCjkpqD7XQNsUOgRMEc3IyWnCCZTlpmSiqwyDMjP90jMS8lJBalhXJWbmZcGZIiU5YINRXam' +
        'SgpETialKDUNyRs8pUU5ClAHZhWXJOUA2a+KS4pTkNTcAuaEMhxBAXKrAIMHkPaAqRD2SSxLNjPQMzbUMzQwUsgt' +
        'SE03QdEh8f8/kExILU4pBkd2Q0ODP9BgFiDtqCAIFuIFhqnkFlagiD7QxA0g123tFIZYz6jAcKS3g0GXoYVJJBnI' +
        '3YRiHxtQDyMTyF0FicUFUBeDsEhSSREkOqCmg1xSXAKOKpjPgPo4QGwRYAggi4OwDFAsGU2MCUmuCjWpMToBaXaI' +
        'Wcn5SPp0gDipNKUEFP1RualgGgQUkaMamDyKEgsKcpCDTTcTkp5UV5bkgwyUBZZHibAoAYZBGjAMDM2AYWAAAEqS' +
        'Bvc=',
    // ffmpeg -y -f lavfi -i "color=c=gray:size=720x480:rate=30000/1001:duration=0.034" -c:v dvvideo
    // -pix_fmt yuv411p -f avi dv.avi (245810 bytes)
    'dv.avi':
        'eNrt3Euvbdl10PFzqxzPhEeuCZBhAsTmOUwAc83DwzxNQvCkkuBA7NTgTQoXnjbY2NhJzZhXIEBmszoo8yvAt6gm' +
        'DRoW8gdwlx5PKUiI4lbVDVhyg2r8er5DZ2uttfc+/625dTQbSz+dn3rpE5/4oTdefPjhl1/64E+89KlPf+z7Hh4+' +
        '9+pXvvDKa5//3MceHh5e/sWHh3/7ysPb877veXh44Z3Th0fvPPPw9adPfPPRw7fNW61vvu/h4as/+5UvPH283Xrt' +
        '869+9dXXvvrqt77vP7348PDk5945f6v9xjcePbz5dH719a+/8M1HT3//sx96ev6ht6/f+bxHD+9/eLv1Hx9/22f/' +
        '2E9/8sff//Sz3/Ps+smTVz/z8Hyez/N5Ps/n+Tyf5/N8ns/zeT7P5/k8n++oee3LX/nyj37L9Q8+/L/7Ci88vPgt' +
        '9xjeOf7q9ddf+PbWW/ca3vP0tS+9+sUvPP353K98B3+vb93z+YGnx5c++YmffOlTn/j097713CuvffajTz78kY9+' +
        '+CNPnrz9bf3Ki8//Ap/P8/lO3SH+zb978eGLX3rt82/dlX3rbu8HxsPH/+fXvva1N9F8fDy8/p/fOX39vzw7/tdn' +
        'x//27Pjfnx3/x7vqPaK9l8fDz7z55htvvvLxf/+/3s16/n9vfnk8wr0XaO+18fCmnF8eD4//93u/9Zl3f/Xw/d9+' +
        '9svjEe69gHsv4t57cO+7cO+9uDdw77tx73tw79fg3q/FvV+He78e976X9l4bj/D+9xiv93249xtw7/tw7zfi3m/C' +
        'vd+Me9+Pe4F778e934J7P4B7vxX3fhvu/Xa8/72A978fxOv9AO59EPd+B+79Ttz7Xbj3u3Hv9+De78W9xL0P4d7v' +
        'w70fwr3fj3t/AO9/L+L97w/i9X4Y9/4Q7j3BvY/g3h/GvT+Ce38U9/4Y7n0U9wr3PoZ7fxz3/gTu/Um8/70H739/' +
        'Cq/3T+Pen8G9j+Pen8W9H8a9H8G9P4d7P4p7fx73PoF7E/f+Au69hHs/hve/78L734/j9f4E7v1F3Psk7v0k7v0l' +
        '3PvLuPdTuPcp3Ps07v007r2Me417fwX3/ire/96L97+/htf713Hvb+De38S9v4V7fxv3fgb3XsG9v4N7n8G9V3Hv' +
        '7+LeZ3Fv4d7n8P438P73ebzev4d7fx/3voB7X8S9f4B7X8K9L+PeP8S9r+DeV3HvZ3Hv53DvNdzbeP/7brz//Txe' +
        '79dw7x/h3j/GvX+Ce/8U9/4Z7v0C7v1z3PsXuPeLuPcvce9f4d6/xr1for0PBPbtgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Y' +
        'twf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Y' +
        'tyf27Yl9e2Lfnti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Y' +
        'txf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFvn9i3T+zb' +
        'J/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFvn9i3' +
        'T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFv' +
        'n9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLf' +
        'PrFvn9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+' +
        'fWLfPrFvn9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9' +
        '+8S+fWLfPrFvn9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27Y19' +
        'ez88fubRHz/z6I+fefTHzzz642ce/fG78u39iPZebuzbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zb' +
        'G/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr59Yd++sG9f2Lcv7NsX9u0L+/aFffvCvn1h376w' +
        'b1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aFffvCvn1h' +
        '376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aFffvC' +
        'vn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aF' +
        'ffvCvn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L' +
        '+/aFffvCvn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX' +
        '9u0L+/aFffvCvn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv' +
        '7NsX9u0L+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59Y9++sW/f' +
        '2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59Y9++' +
        'sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59' +
        'Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37' +
        'xr59Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2' +
        'jX37xr59Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/bt' +
        'G/v2jX37xr59Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2w/27Qf79oN9+8G+/WDffrBvP9i3H+zb' +
        'D/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDffrBvP9i3' +
        'H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDffrBv' +
        'P9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDf' +
        'frBvP9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+' +
        '/WDffrBvP9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9' +
        '+8G+/WDffrBvP9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf7' +
        '9oN9+8G+/WDffrBvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Yt1/s2y/2' +
        '7Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Yt1/s' +
        '2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Y' +
        't1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336x' +
        'b7/Yt1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i' +
        '336xb7/Yt1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvF' +
        'vv1i336xb7/Yt1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337tb79yZNXP/PGNx49fGBg5z4eXn/m' +
        '0l9/5tJff+bSX3/m0l9/5tJff1fOfTyivZcHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad27gM794Gd+8DOfWDnPrBz' +
        'H9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad27gM794Gd+8DOfWDn' +
        'PrBzH9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad27gM794Gd+8DO' +
        'fWDnPrBzH9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad27gM794Gd' +
        '+8DOfWDnPrBzH9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad27gM7' +
        '94Gd+8DOfWDnPrBzH9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eBnfvAzn1g5z6wcx/YuQ/s3Ad2' +
        '7gM794Gd+8DOfWDnPrBzH9i5D+zcB3buAzv3gZ37wM59YOc+sHMf2LkP7NwHdu4DO/eB/497YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg3x7Ytwf27YF9e2DfHti3B/btgX17YN8e2LcH9u2BfXtg' +
        '3x7Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti357Ytyf27Yl9e2Lfnti3J/btiX17Yt+e2Lcn9u2JfXti' +
        '357Ytyf27Yl9e2Lfnti3J/btiX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth' +
        '317Ytxf27YV9e2HfXti3F/bthX17Yd9e2LcX9u2FfXth317Yt0/s2yf27RP79ol9+8S+fWLfPrFvn9i3T+zbJ/bt' +
        'E/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFvn9i3T+zb' +
        'J/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFvn9i3' +
        'T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLfPrFv' +
        'n9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+fWLf' +
        'PrFvn9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9+8S+' +
        'fWLfPrFvn9i3T+zbJ/btE/v2iX37xL59Yt8+sW+f2LdP7Nsn9u0T+/aJffvEvn1i3z6xb5/Yt0/s2yf27RP79ol9' +
        '+8S+fWLf3ti398PjZx798TOP/viZR3/8zKM/fubRH78r396PaO/lxr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFv' +
        'b+zbG/v2xr69sW9v7Nsb+/bGvr2xb2/s2xv79sa+vbFvb+zbG/v2xr69sW9v7NsX9u0L+/aFffvCvn1h376wb1/Y' +
        'ty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aFffvCvn1h376w' +
        'b1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aFffvCvn1h' +
        '376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aFffvC' +
        'vn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L+/aF' +
        'ffvCvn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX9u0L' +
        '+/aFffvCvn1h376wb1/Yty/s2xf27Qv79oV9+8K+fWHfvrBvX9i3L+zbF/btC/v2hX37wr59Yd++sG9f2Lcv7NsX' +
        '9u0L+/aFffvCvn1h376wb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59Y9++sW/f2Ldv' +
        '7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59Y9++sW/f' +
        '2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59Y9++' +
        'sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37xr59' +
        'Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2jX37' +
        'xr59Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+fWPfvrFv39i3b+zbN/btG/v2' +
        'jX37xr59Y9++sW/f2Ldv7Ns39u0b+/aNffvGvn1j376xb9/Yt2/s2zf27Rv79o19+8a+/WDffrBvP9i3H+zbD/bt' +
        'B/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDffrBvP9i3H+zb' +
        'D/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDffrBvP9i3' +
        'H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDffrBv' +
        'P9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+/WDf' +
        'frBvP9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9+8G+' +
        '/WDffrBvP9i3H+zbD/btB/v2g337wb79YN9+sG8/2Lcf7NsP9u0H+/aDffvBvv1g336wbz/Ytx/s2w/27Qf79oN9' +
        '+8G+/WDffrBvP9i3H+zbD/btB/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Yt1/s2y/27Rf7' +
        '9ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Yt1/s2y/2' +
        '7Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Yt1/s' +
        '2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336xb7/Y' +
        't1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i336x' +
        'b7/Yt1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf7Nsv9u0X+/aLffvFvv1i' +
        '336xb7/Yt1/s2y/27Rf79ot9+8W+/WLffrFvv9i3X+zbL/btF/v2i337xb79Yt9+sW+/2Ldf69s//+rPf+SDDw8P' +
        'T568+pn3PT2+5+njjW88+r/X/+Hp+VvX/wdP8QUa',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 0
    // -pix_fmt yuv422p10le -f mov prores-apco.mov (951 bytes)
    'prores-apco.mov':
        'eNpjYGAQSSupLCgsUVBgYGBigNAMHOWZKalA+mZuSmIJkL6YmVyQxjCFgcEnsSyZQYBBoIGBiYnJgYGZhZ2Tm5eP' +
        '356dnZsHSNlDePb23EDaHkRDKHsoZc9rjwoo1e8AdJwpA6MBg7ZBLIMIA6f/4Umu82XTTk6yO7akjrczaVub474H' +
        '91wUF80xMfq28NS6YwEPpuoBPXooNz+/DKg3J7csI4UBBTC/ABInGBgZQAgBGFFVofMdGPACJiDSLSlKzAayY0qy' +
        'wXYyYzHtBIZOYuwVgGIGBpXUlJJiIC2TmlNcgqTjBEIv49LclMxEIEMhNwXd7xqguGeo/w/m6Gak5BSBGLkZOUVl' +
        'kAQBBzxhQIF8j8S8lJxUoCLGgNzMvDSguEhZLthQZGfqwAxKARpUWpSjgGwQt0tiSSLcHAaVFIg5MilFqWlIHuCB' +
        '6gOxnxSXJOUA6YbikuIUJDUFiQXJ+cjB5ObmGwAOexAGploGDyDTA6ZCHJSYzQz0jA31DA2MFAqK8otSi+Ozi+FO' +
        'k/gPCgiutMzUHLBxAgWJxQVQs0FYorikpBjJPkZQ4IHcDnRXMqo4HIsA5aqgchcRYijuVgFixdKUElAkSa4sLi9i' +
        '4A09AnRsGtCxhmZAxxoAABTMjwE=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 1
    // -pix_fmt yuv422p10le -f mov prores-apcs.mov (1003 bytes)
    'prores-apcs.mov':
        'eNpjYGAQSSupLCgsUVBgYGBigNAMHOWZKakMDIy8uSmJJUCaNTO5II1hCgODT2JZMoMAg0ADAxMTkwMDMwsrGzsn' +
        'Ny8/Kys7B5AShPD4BdnBtKAwiOITEBaHUrJgUVEZZW5eARClSal+B6BjMxkYDRjiDYwYTBmEKh+pm2jHTQ6ZsGll' +
        'JOdDDvtz4mt6pp09nSh/cUvTjrjNHztDs8otWhQ1lvO2vbyR3552YM/8hi1+EskT2fLDusJqOxOCVq7+XnDhxCYl' +
        'pylObj1SFhvWPdXedr5PDRg4h3Lz88uA9uXklmWkMKAA5hdA4gQDIwMIIQAjqip0vgMDXsAERLolRYnZQHZMSTbY' +
        'TmYspp3A0EmMvQJQzMCgkppSUgykZVJzikuQdJxA6GVcmpuSmQhkKOSmoPtdA5ReGOr/gzm6GSk5RSBGbkZOURk4' +
        'ESEATxhQIN8jMS8lJxWoiDEgNzMvDSguUpYLNhTZmTowg1KABpUW5SggG8TtkliSCDeHQSUFYo5MSlFqGpIHeKD6' +
        'QOwnxSVJOUC6obikOAVJTUFiQXIxcjC5ufkGgMMehIEpncEDyPSAqRAHZQAzAz1jQz1DAyOFgqL8otTi+OxiuNMk' +
        '/oMCgistMzUHbJxAQWJxAdRsEJYoLilBto8RFHggtwPdlYwqDsciQLkqqBQrQiw5H0m9ChArlqaUgCJJcmVxeRED' +
        'b+gRoGPTgI41NAM61gAAfW6X+w==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 2
    // -pix_fmt yuv422p10le -f mov prores-apcn.mov (1041 bytes)
    'prores-apcn.mov':
        'eNpjYGAQSSupLCgsUVBgYGBigNAMHOWZKakMDIzGuSmJJUBaOzO5II1hCgODT2JZMoMAg0ADAxMTkwMDMwsLKysb' +
        'OzsnkAZRnBAeJxecBlIcnFw8UIofJMrFzScIpUQp1e8AdGw/A6MBQ6uBPoM3g3T9o3QT8/xnUzzmCYan6C8xeN/Z' +
        '/dTj5JlztsrPdlqtUri0KGmn5zODqaqLbP78yr/YI6uzbPqMOAOTxXP3vc86t1LU8emZ57ea4ts5XjlEB0g+9HEM' +
        'S1+6kPXtVxd3ljVJJlmrTr/3UV0gmnBil1HwS9e5HKkTZb5v53ln9Or9K1+rW9909gGD8FBufn4Z0FU5uWUZKQwo' +
        'gPkFkDjBwMgAQgjAiKoKne/AgBcwAZFuSVFiNpAdU5INtpMZi2knMHQSY68AFDMwqKSmlBQDaZnUnOISJB0nEHoZ' +
        'l+amZCYCGQq5Keh+1wClKob6/2CObkZKThGIkZuRU1QGTmoIwBMGFMj3SMxLyUkFKmIMyM3MSwOKi5Tlgg1FdqYO' +
        'zKAUoEGlRTkKyAZxuySWJMLNYVBJgZgjk1KUmobkAR6oPhD7SXFJUg6QbiguKU5BUlOQWJCchxxMbm6+AeCwB2Fg' +
        'fmDwADI9YCrEQdnEzEDP2FDP0MBIoaAovyi1OD67GO40if+ggOBKy0zNARsnUJBYXAA1G4QliktKipHsYwQFHsjt' +
        'QHclo4rDsQhQrgoqpY0QS85HUq8CxIqlKSWgSJJcWVxexMAbegTo2DSgYw3NgI41AAAcdKs2',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 3
    // -pix_fmt yuv422p10le -f mov prores-apch.mov (1109 bytes)
    'prores-apch.mov':
        'eNpjYGAQSSupLCgsUVBgYGBigNAMHOWZKakMDIzluSmJJUA6PzO5II1hCgODT2JZMoMAg0ADAxMTkwMDMwt+wAql' +
        'WKEUG5RiB9Ns7OyU6ncAOvYyA6MBw0kDbYZiBk2lAI1q5+0ZMzUmxihy+jr/cWg2rBcXeGukqXPHp3fxxqykEteF' +
        'NyIDC/UDendMjEgXag3kWSb8cV/vyfPOksuWTHhbsXaK8qMvNQ/XiVQzZyw6n7465pfSaV9tVWHWJzHRaurCF5kv' +
        'V568qnh+VxenTe2KTXvOBMwIkX6Y45iWVOLWOvV2kUdrQFGY4RRH06xnb3wXWnx/0vOV6euGNxyr5x0UuHDKKvpl' +
        'S2tgz0rB53vX6Moemr76xB/Xu+KpQv0u+ztvvc99z1TNnrECGA2HcvPzy4A+y8kty0hhQAHML4DECQZGBhBCAEZU' +
        'Veh8Bwa8gAmIdEuKErOB7JiSbLCdzFhMO4Ghkxh7BaCYgUElNaWkGEjLpOYUlyDpOIHQy7g0NyUzEchQyE1B97sG' +
        'KGUy1P8Hc3QzUnKKQIzcjJyiMnByRQCeMKBAvkdiXkpOKlARY0BuZl4aUFykLBdsKLIzdWAGpQANKi3KUUA2iNsl' +
        'sSQRbg6DSgrEHJmUotQ0JA/wQPWB2E+KS5JygHRDcUlxCpKagsSC5AzkYHJz8w0Ahz0IA/MUgweQ6QFTIQ7KamYG' +
        'esaGeoYGRgoFRflFqcXx2cVwp0n8BwUEV1pmag7YOIGCxOICqNkgLFFcUlKMZB8jKPBAbge6KxlVHI5FgHJVUKl8' +
        'hFhyPpJ6FSBWLE0pAUWS5Mri8iIG3tAjQMemAR1raAZ0rAEArwHHfQ==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 4
    // -pix_fmt yuva444p10le -f mov prores-ap4h.mov (1820 bytes)
    'prores-ap4h.mov':
        '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',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -c:v prores_ks -profile:v 5
    // -pix_fmt yuva444p10le -f mov prores-ap4x.mov (1820 bytes)
    'prores-ap4x.mov':
        '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',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v wmv1 -b:v 50k -f avi
    // wmv1.avi (6152 bytes)
    'wmv1.avi':
        'eNoL8nRzY5BgYHAM81Tw8QwOsRBiYMhIKcpJLMvMsGBgYHDgZWbIAsqDgAAnAwMThMnACBEBQgYwRgcgsx4AJYpL' +
        'inKAGGxWWWZKcbhvmCGyOpA5rFA2yOxgoMB/IIDJg2wA6k/TALI1oHYJgPVJMIDNYsa02yvUz1sCqIgFyjcwSElm' +
        'GAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwYgCZQVFBS5IfND4A2JcgRGJjRDHNc4BGmtgASrMT8nNAaKMHyM4XEFj' +
        'PlJA2tPPzd8z2C2EDySWWJZmZqBnaKZnaGAADq0fzKMpcBSMgpFaQmQBS8vc/LJM0KgsaLSXtaiZ9w7zWd0dF9j5' +
        'GR9YaB2Z+KnkO1f70uYXcWv27I1W+PPjx06lNHvu4KVhK9VvtEZETyn+n/b3IDNjszorg11zk4BlVo1Qwoe9BVYr' +
        'ZETu6zey8V3mE+W44nTH53DC4xkCQRn23EUGbH/4wq/Mt1M34buVr53HYlDAw/7gR0VkgcJyPXb/B01znBLn9Qkv' +
        'F+xuPHCi8eCZvEN79HKt446dmlcQo9LcUaXSmXDAaO4LRSOujAMWjmyM3D9kgxlKN15Z8GBNI+sGpwwJNj0+C50J' +
        'Ik+ngCT7Pq3il4tyYLk9VbS7M/Og46J5VwWCuGLivz0RXhdY6FjdteyquBhX79WdrPNusjxdsIBBeHbWZDmuVhHf' +
        'vC6FzZNnLHrUGH90897M/1vO5rGKcQXq6YgHbVpza+IvRoGwy9tZHS7yn94QuX/+fN6rq3IPtEVPCtixRuv4Z6kb' +
        'a9YsmHN7il7/swngEW/QaLrrj8yUCkMFBsgYOKj+Ao2Jg0IdNiaewAgZdwcAkWHPNw==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v rawvideo -pix_fmt bgr24
    // -f avi raw.avi (7346 bytes)
    'raw.avi':
        'eNrtmc1LAlEUxY+NBYFZRJBISBBEtRhmoMKNUhBDU5Gg1l4aZATLsBhaBEWEUUSrWrZqV8uW7dvVH+AqCKJlSzdl' +
        '982zLEWIMAi8vzmD7+P47nDHN8iduGkYlwPA9LI5uGAmkuFewLby2ZSTscMAproUoBsuPZ1Am2zCI0fogHvWItZ6' +
        'oImNzXyWTnctJ2Nt1PrEOu2Vtrs2hSsTH/MiAn0/PULtkUqsF5r3ICANSn3suaXF+QAZvZW+plkrYBiGYRiGYRiG' +
        'YRimpXDW8+szX/qi/vBRx/DQUW1XxxvVOUStwUvGnLWaJdmlFs6rqPkE6dNcNGJmwkj6xVjKSU9qqj6p6prmZquk' +
        '8C+QYVr1CdHXAazmnIxblaVnwRt2GgifesUbqVwG6Xf+KEJ1wqciiJCiUZD+s78L4yRt95k0vvdI8iFI8iNGGjss' +
        'kmr8p/s3ZAZSQJz850dX0n+8fUdmhHIiW0JuZJlIETwir+RrguX1NMGvrqkn9/bBLTDx7QaOziZPr5vg/7vr14eW' +
        'L876C08YLvwon/oQifykRveL9wHvA94Hh8WMtaUPQr6tE/+03bd3SrXvU2T/HYFBAZE=',
    // ffmpeg -y -f lavfi -i "color=s=16x16,format=rgb24,geq=r='X*16':g='Y*16':b=128" -frames:v 1
    // -c:v mjpeg -q:v 1 -pix_fmt yuvj444p -f image2 gradient.jpg (296 bytes)
    'gradient.jpg':
        'eNr7f+P/AwYBLzdPNwZGJgYGRiBk+P+PQcAnsSzZzEDP2FDP0MCI4f9tBmcGDhYQYAUDNmTAzs7OwcEBJEFMIIuD' +
        'k5MTQnFxcfHwcHPz8fEJCor8P8IQzcAINB8ZsLMxggCyEBsrM7sAAxMzqkq2haxKRoIMTIysKOKsSmxGLIaBjv8P' +
        'MAhyMAgwCDAzCjEwCTEwCzH8v8XAAzSESZBZkMGewX5lyHMB1SurijuE0izuNO3sM1eWyv076YHW7NqUnS/Ng1ae' +
        'U/AGKQk5U7iTtVgmz7102f2bekwrt1/znjf//00A7E82vQ==',
    // ffmpeg -y -f lavfi -i "color=s=16x16,format=rgb24,geq=r='X*16':g='Y*16':b=128" -frames:v 1
    // -c:v libaom-av1 -still-picture 1 -pix_fmt yuv444p -crf 0 gradient.avif (607 bytes)
    'gradient.avif':
        'eNpjYGBQSCupLEgsy0xjAAIQnZuZZpibmZjm62joCBT6mZtaksgAAfoZKTlFUDZDQWZyCQMSCADyS4tSPRLzUnJS' +
        'war4CjJLcsFyjEAsl5mTnwziuID4jBBRRkUgtgOyNTIz89LgaqWAnFQmKC+xzMDQOT8nH2xmVmZBUQGQ9s4sSM4H' +
        '0iKZxQWpUBcIwHBBZkUmSICZg4MDSPEklhk6NyqA1Qgn5+cU5SXnVDAwgSEQiGcW5MJ8CHQYCyNTMwuQ5ZabkljC' +
        'xWrB8/82i9EWJqDB/6e09cyePP1rR03CH/+C+IP/l3P8jq7Mbp1wK9nsyYU7LNMMe7zneMlsZW75/3f1wU8rJ/1Z' +
        'Ga3S6hA7MS5J7c+uhMUPG9XuvLz7uH3uu/D6knuH/xS5XkgOFD7oPWfFbq93dyaezD7z0aj3eu/HJ9t5Lr7b+7jl' +
        'guTBX5pr89QC14iLpy148U3i5fenBX8b6l/YtUoqPVFnXaU1R42lyu0Ja055borS4TsrTr7+tszYzfahq9ezQ56i' +
        '76fkWOmWv+4s2fu69+eb5UrcCg8i1i16U5O7wO98SUKL1DmpszoHvtwOD1jM4zXX/u5y9T1NWgYZHr091guWVZjN' +
        'iHXuflTeeW/byunlr/6kRzqu2TvZv0/s9F3rt19OPVy6sLVNyZE1rODHmwUXFf/KT2rc4fv6o4Z+8zu5O48nahvm' +
        '+ITvVDwAAL562vY=',
    // ffmpeg -y -f lavfi -i "color=s=16x16,format=rgb24,geq=r='X*16':g='Y*16':b=128" -frames:v 1
    // -c:v libjxl -distance 0 gradient.jxl (96 bytes)
    'gradient.jxl':
        'eNoBYACf//8KQ0AkCAIBAFQBSyg1xj6sh1RQUFASjADSQoUxBu+hgfrixRgvxtwIAAQQAggAJF5DyYMB4JwfAODp' +
        'DwB8+gMAHPMD4D7mNdAOwSUNIEoq6F42kVgqIyrAcROC9SQ8Fj1kIh4=',
    // ffmpeg -y -f lavfi -i "color=s=16x16,format=rgb24,geq=r='X*16':g='Y*16':b=128,
    // scale=out_color_matrix=bt601:out_range=tv,format=yuv420p" -frames:v 1 -c:v libx265
    // -x265-params info=0:crf=2:log-level=error -colorspace smpte170m -color_primaries bt709
    // -color_trc iec61966-2-1 -color_range tv -f hevc gradient.hevc, then
    // node test/helpers/make-heif.mjs gradient.hevc gradient.heic 1 13 6 (419 bytes)
    'gradient.heic':
        'eNpjYGCQSCupLMhIzUxmAILczDRDCJvRITe1JJEBAhQzUnKKoGyGgszkEgY0wFeQWZILZjECsVxmTj7YOBcQnxEi' +
        'ypgApJ2BWDkzMy8NrlYUyEllgvIyypINQcwjmQVFBUB6WWZBcj6QLgdKODOCTZgA1in3geHP3x8/GBj4mRcANUo4' +
        'MPIw/v8PUsAMUsEMQnJTZ3AuBEpqOzEyosks6HCdFpa1Zz1jFpMUDwdICEyccFgEVM/mwniw+EIn0BaRzOKCVKgP' +
        'BaBYODk/pygvOacCqJKXgQ0kJZZZkAsLKaB3mRuZgLYweOemJILCyV6DcT3Lj8KWHTYsXz2uTf92+vUfvo/GVzh/' +
        'nxH5mbc/VyaFxWdzS5q6UvBr767nheU81x6vfW7V7db6xfz3gVZvDwMAdpxdEQ==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=64x48:rate=10:duration=0.5" -c:v libx264 -preset
    // superfast -pix_fmt yuv420p -x264-params threads=1 -f mp4 avc1.mp4 (2789 bytes)
    'avc1.mp4':
        'eNp9VglYFEcW7hEQzJoVCegEURtFwSjDXBDATBDkVJREBUXRoacPpmFmuuluUJRDUVYOFeWSkAByLEIUCQsjGkFB' +
        'ieINETUgLkZFo2K81nx4IFsNuKK7m/r6Vb16739H1auvqyAIggkuhiZZSgtBoyB+BCRFolGJlpZLIAgyIRgchyBj' +
        'Py2GcABTMdpoYODvXV73Gu50+NblzPkF7pj++6N1Uic5bA+jFIPDEsAyMonYGZZJcIkL4QIUviIAcFj0lZePvRx2' +
        'D5oPkBiOAsV8io7R4AQHS8Vimb1ULJUBoZrjaFcHh7Vr14qiSQynNIhORDFhDnwUkZrTagCGojmS0rGuMIqoEFQh' +
        'gRmcAD2GqzQUGqGQuIpdxTCiQzQxLK4Qr5O5AoK1uAIjEZiNUgFOAtNszFCvZDCFRCQGJqCDteQ6HFPy/gCPKxlE' +
        'FwbQTjCqZigtohw05RhcoyFZgHBe54yhHBChkVowxXAEW0/pcIVUMkcigQmE5ZQ0G0HSPGLIQSStpAiCxTkA59QM' +
        'MGCBUkNREYgaTJTvZKyGRPF3AjGsYwZDoKQW4fg0SB2HMxoEgIBcpYlikBglSmlphPeNgv3hGITUARcAyCA8hmAQ' +
        'Lc4qZLBKSccAnsQUUsAjGELzi1ApVSTCR8JIBh9c1lqcDFNzKsBRNK5ThlE00A4J+TVF4DHAt0LqKB5mlVpSp5CI' +
        'YRbFdTgaxSnkYngwOr+jDM6qgTmDKlCGgLUqsI04nylDKKQykRiO5JNXiEVOgKV5R4Mjsk7h5AIYlsNphRwmaVAT' +
        'UH1QMuCbVv1nJgMVjwSl50sJbYQggxY8eQvU3d7uta/Zhd46PnVBcSgHdRomrfBzsrgZekg4Y5UFJd2hdI1L21Hm' +
        'oK9eJcO9U+WLRh2xnTBp6vMrx9ICpT3SOgvnkEX5n/u5c9S0Ca/c4kt3NtfWZBsH4Zk3oKeFkTLfiJzcu1tbE8/f' +
        'fFO+vcrzq4p8a5s/Dq7Zm3tsW86J1/ssXRLY/mhdwHLtuIGeE/fyrp6zW+BmblvlfdM8YIY+fuIW3WNpwydBTfqA' +
        '4wd9i+NX/PVnY5+UC70Z5Xbfx+28RVz2Majpk3yXAstT8p0X5rRGvQpBVlcfJi69qQxX+S37ekqmpVexn/eLu18b' +
        'fbkrJ2/F9N6lVfVqH9ETgx2Ks7Y29Y8cq42WZsQ0ZMSWTHyc3d+n3OLYcGa5db/TPWrtht6A8YsmVl5OSTD5JKzD' +
        '1P+Po9fdi5tnC6J/WONMjsuyqiVqujKSd+ypgKo6skr0zo3CXxMnWp0PT2EnrS9+GZ28Mpa8ldB9sSDNzMPbOGmu' +
        '44JT1w6EFqSGJ/zU6LGHKPGPmbmqcn110ikHy9EKC+/eea9U5x3DG3JnT3bT1/osnnukCf42cc/22aeT9mZK9g/U' +
        'NGo2FJ3OIrREc6hyScvJpmLXU0UZV21nGVxa7r+GSNmQGRl9zi9Of7d5SQhcaDunZVy9iZekolN94Y5YmmuJZ/14' +
        'Ae1M0o8+ZL6nvCwnti3fLWPlrBudco/gFQas89IXHplZq0qPdBaNDnJ9mlYuPzDll4e7bjeX5S7p8jq5O9A+6mj+' +
        'tUk9t6dFtqetTg93vFFnWh0b0liUlvGz0RuqkEwvub9bfr+1UjB31JQINOqe1+adweTHiPGElQ+PeCyjV2961oLH' +
        'bOqblHdrX1BYk6h221P1kwXrV32x+2hzDZlw8rBNl5Vhd/3x8J7JF407XMiuxCfyjPn7TMt+f6HH2pPGR33pJ/pj' +
        '1wGqJTp2asv9+DM7Qs+1OV1b1ma/X6h8mNOfqL5xFbGS3equS5w19Sc8LrnqjfeWbRvHrIyb1+l35PPnG40Hvqji' +
        'vBxT48c69xgTx17NKKlNu1J9JuRN79LjeZ2P9YcUdCv1o13aRbd/TrIUfhsgjBVcP75A5jdmOdH1jXUhBpekS+4Y' +
        'GCQeLiFmxBbOCV78fLL26mu3aW2f+hib5DnWtY/5m9669dpNs3MvP4oTqA8G32iamhBJPKKOPQroKp1yaOzkO7vq' +
        'bV+bFc2E8qUW2URfW4Zwv+ftvvN1Vwvt9R9vh+335Z31ubTQ8HH2Xxh9JO2VeW2pdNaD5y89U+sOqdvMvHw3WcR/' +
        'Z/9sZnJgs2NZMjE+7QqRnpJd632gL1G8Ov8FuIh83fNshFV1jaeLN6cWlvVfb4zKP/t48ebXYxQLT1jsTnUInaoy' +
        'OaiqWL23/1mfpXBjIj19QHHycmfwwe9n2hXUGHb17lxo9Gn300WJwJede4GHR8AD66L6htBlW69n55zYK4yesi2r' +
        '/x+v76Xnyk1v+SOBiJjxCARYJ0EB4tndW+Fc1V7+rNS4d0P8af/PAlF1z/5uuPRBXsbuxQ0HKluEmy9+U/5ZVNND' +
        '+xeuL6V3ZrYCSzNBAerZ/eaS2Q+M/29XSk94LnQH/yROS1HRQKvRRqsx6L1m8BsECf4FCSD+e9cE76M+nM+D/rSN' +
        'Al8B+P1GAD6EixiMafDf3kBc6M/j/M+4fCcenNrgGMeC0QrXsNw7C96vybDtqAlacP0CBtZiH67dDpA5FNg8OLFX' +
        'YxrmrYZ/AoxEBvFPAl9Eh2lwHiNoAvcEwVtHawedjkzTBhvSWWHg8hmxjLFRjAYeTnATy6k0gG9gORYbgankX0H/' +
        'Zyv4hYshX/5YvkVY+AO8k1gkk4gkYimsIVX8c2WEhXBgAPQygJovwKCPBn6FhGFg3N/huUFgyteE7wTznkwLDhVA' +
        'hupH6Wf7+/p4Q1MaYenhJHgyB9fm8A5zpkMECVlucPffJmsEQYY8bw4WNVLOkzP6Dms0JDMZ1ptD78/f2g36sgK+' +
        '0A98DdtDdkC3fsRigXx0DBj9Ac0B5ApowlA+KDXCB392VFEYx5+KlVp8cOSb9cgTAE4Ng9C0ZuT+25NDx2xGBUfx' +
        'DieD5ynyNmlQCgKUQuIESiH+N2PLn1A=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=64x64:rate=10:duration=0.5" -c:v libx265 -preset
    // ultrafast -pix_fmt yuv420p -x265-params log-level=error:pools=1:frame-threads=1 -tag:v hvc1
    // -f mp4 hvc1.mp4 (6594 bytes)
    'hvc1.mp4':
        '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' +
        'L8Ma9L30/wBd7Aoj',
    // ffmpeg -y -f lavfi -i "testsrc2=size=64x48:rate=10:duration=0.5" -c:v libvpx-vp9 -b:v 50k
    // -deadline realtime -cpu-used 8 -f webm vp9.webm (2164 bytes)
    'vp9.webm':
        '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',
    // ffmpeg -y -f lavfi -i "testsrc2=size=64x48:rate=10:duration=0.5" -c:v libaom-av1 -b:v 50k
    // -cpu-used 8 -row-mt 0 -threads 1 -f mp4 av1.mp4 (1697 bytes)
    'av1.mp4':
        'eNpjYGBQSCupLMgszs9lYGBiANGJZQaGQNoot8DEkIGBgSOtKDWVgYHZLzclsYSLCyjCtP777HgDDqODLCIMCgsY' +
        'GBoYGhpuFz6+FR22ky/4kGD45J4oxSghf+W9xy2nFX0MdVBwaGvpfB7RJrRz4Vz1qS1Kh8tsy3ZY3GyfEmFaqch5' +
        '8+pZrU23V1icex1hJXy2JHXlPZe7YiVOfvsbTMv11f7KZsRdPnH63sfumvI3NtFpcacWGZw8onzcsNpVy9t6ST3r' +
        '8+j7i570vkibw87voOS2aK6MzUZF1VOKpZyXb7+QtZ/RtMB8iVZWrsihKxvt/Va6r+SdsE+z5NI/nW/PDUQKzI26' +
        '7nvbPv7z4vP/2NZDYh1J8r9OzlXR0Wt78HTfPrtf7/f8nrOoeCn3thlvLl/K+vwqWuC0IPvep7l/i+In/56nYNG6' +
        '/sYXm6AN2krZPRHrzF/wvjo0aa3e5eAeiQ0PRGfEx+8NyFsp8Yk3NnfmnBk1gm/V/FWqJGcvzo3SZr+769pnJ5mF' +
        '4YbnP++t+7vv4bXoP21ui0Wvd308yLjB/sCqkL2ScQXKWxsD1mWGBO2Scf9wsrN3A88ZT+vqb1pvcs2eBn1/vcEs' +
        '8kXyy6seZiXbBaOcp59PCHPjvzbvb62Pgha/7+MvTgnpRUqX6iTbr64+zsnelLp7d+qbDwq1AuWXzzcv0IuqyP67' +
        '0ibG5t99x/iZJzhUHHdqLVo+XdSyet5XLt7pS1b18GkUHz4fquO05J75vC1JByT3fFrbouB2UfTj7Z83LhfG+xnv' +
        'W+DzzVTps7f8lPnMVQlMbyr2THy8OftwJE+s5ueWjDUfr/qFFy/c13L96n8Rq7cqb6dct9kbpbag5hujd+G7NR1S' +
        'QoJXDi8p3X+twcjIiPGBAwODslsDAyODAxDetTgQOY9RUPbSmc2PXtpMlc31+yZm+3ElU9bpyvxlvRv9ZA4Y2Rgx' +
        'MTRB9bAeYHRgUJjvbTA90qnt42kHhsR7XFwvft9Y+b/+v4XD2rjf+949XDjxQ9qhiH9/pwtKZBwwcjViZmRxYFD2' +
        'dBBwYhFgLGBhuDM5+s6tgh9BgfXJolyL5Ls5k99KS27MErjRpy/3977f5BXqR7k/f1nUx7uKddY8lUkro5JaBYys' +
        'jVgesXUwKHuBjYkEGnNj+RQHt531L6IeRT38Fz1fgO3vnbyLrhv+dYY7n3F98sttdf/JHZpT/+/4IAHMTdq5+fll' +
        'wLyUk1uWkcKAAphfMDAwfgEGBwghACOqKnS+AwNewAREoSVFidlAdkxJNthOZkzTgPYy4LcHq70gwgDMVUlNKSkG' +
        '0jKpOcUlCB1Qc8F6Gc/mpmQmAhkKuSnoftcAYhGG0CNgjm5GSk4RTKYsMyUVWWUYkJ/vkZiXkpMKUsNYkZuZlwbS' +
        'XZYLNhTZmSopEDmZlKLUNCRv8JQW5ShAHWhRXJKUA2SvKS4pTkFSMwdUHOIICpDHDRg8gLQHTIWET2JZspmBnrGh' +
        'nqGBkUJOZlJifq5uYhnMCAaJ//9BJFDEuZGBhwG5QAWyuNIyU3PA1ggUJBYXQO0EYZGkkiJogB4OYGAwSQCZUlwC' +
        'DmyY21gZGFhAbBGgH5DFQVgGKJaMJsYKpTWAclVIvgKKMwHtYDABYjsgdgdiW4i5yflIZoCiPKk0pQQUmVG5qWAa' +
        'BBSRIw4Y2UWJBQU5yMGmmwlJHaorS/JBBsoCq5ZEWAADQzANGIKGZsAQNAAAqwj5QA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.2" -ac 2 -c:a libopus
    // -b:a 32k -f ogg opus.ogg (905 bytes)
    'opus.ogg':
        'eNrzT08PZmBigAK5P1q6IPrwhYVnGIX9C0qLPVITUxiZLBgbdoMV+IOUMyArZwTSRys3MzHagZSHJKYX8wJFfBLL' +
        '0swM9AzN9AwNDEBKZIE4NS85PyW1yBYomQyUNDYEShop5GQm5QN1gk1m2aGGMBnkqv+Vh+5xh/i7ujp7Ojt6GSnW' +
        'tP/ZsjW5uvnrBgbNVQZKd53KdPufnfxmyvZhl6H6D/Ee+T8T/Pc3FCx350z2fGk30dB6+grNieeuCdyd8vbQog99' +
        'agdndqwWnOfzvO9yxeQLn92KtqTxXahp/2+0X9TpWsD77dY5as08l582NNw/f5jR9PviuvA6URvHC/dLzDf9c5x9' +
        'Q6XS8tSnep1TVVuzdj93ubnKU3ZvV9qi2yq+iwx1bR89ttacq1LnWtPBlPibvSL1TTurqcb/54uE7jDHZedsS/fY' +
        'sDxF5MAuWS+f+y6lHyruGFUnLJq516Nz5kbftMf5v1L3OzEfjeK+y2Yl4c8zC25I0/VfX9siE3q4V/0Lk313j6tU' +
        'W610Seaqb94eBzOcnpRcN1CKaslOjzp/5sqhWKtlJYqms2Wbj3CuFFwg4KsPMaSsUkJs+jeNBvOkh9NfMkTkKjod' +
        'mF0w50wbu6vi8qaLBQabk/q+7NpS+TLWOtF0/sP7s8prOWz3fVX+ouGedgbmjiQz2c4+f8b4A/tUjml+v1K+29ZI' +
        'MHRetbOf684DoadNHmcKzZ9SO4fnOluwrcehVcICYZJRfk2aEd1mUxJ59ic8am5EuEWy7lvpkpoPrvb1Vu/ck4Ne' +
        'aBVM3rx30jHVaE2zS59TP37MvVw+VWnp54UXfBdUhfhefc8RxFNrrdlVzDMfboQ0u3lsjP+5lUdYStieKpXqc8es' +
        'nH1N77Zh5RaBncJTc8vvVnW5uD+rjKoO/xFofiFmw/tGXuPTL2CeAbtB9oLj4TN7ex5XbWHn8J3lZ35bcvGle72L' +
        'Ep+yeSpuaTwhfWcH/5WsmmczTa6a+J6KXOClceD3+iJLDgPtGRuf3WeY7wM0afY7M6BJAezL9+r8Fk6YVPPpSNnG' +
        'lccvLll25i+bp6gK/+wXu/mOLj/If8feOM/X0oeD8YbhyV0bNqroFV06+5qx++cjxtW7m8J/7d65e8srIY6fAP77' +
        'iNs=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.2" -ac 2 -c:a
    // libvorbis -q:a 0 -f ogg vorbis.ogg (4619 bytes)
    'vorbis.ogg':
        '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',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.1" -c:a pcm_mulaw -f
    // wav ulaw.wav (892 bytes)
    'ulaw.wav':
        'eNoL8nRzK2FmYAh3DHNNyy1REGJgYGBnYGRwkGcAY0YGDqBIWmJyCQuQVgCq9PEMDpECsj393Pw9g91C+IBsn8Sy' +
        'NDMDPUMzPUMDA4aUxJJEkMr/J3ZtXr9+085j772sjfX1jSxd0s/s2bJh/aYdh+772pga6BuaO0Rf2Lt1w/qN2/Zf' +
        'D7YzM9A3MLMLvr5/28b1G7buvRDtYG6ob2Bq43v/0I5N6zds2XMm3cXSSF/f2Nrr/bGdm9av37zrxH8PK7DRbvmn' +
        'doMtO/Lcx8YEaLSFU/y5PSCjtx+4HWALsszMPvzyvm0b1m/Ytu9yuL0ZyGjbgNsHtoMs23Mu3skCKGJi4/P8CNjo' +
        '3afy3cCWWXnUjfpj1B808AcAxT6ZQQ==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.1" -c:a pcm_alaw -f wav
    // alaw.wav (892 bytes)
    'alaw.wav':
        'eNoL8nRzK2FmYAh3DHNNyy1REGJgYGBjYGRwkGcAY0YGDqBIWmJyCQuQVgCq9PEMDpECsj393Pw9g91C+IBsn8Sy' +
        'NDMDPUMzPUMDA4aUxJJEkMqrDybOmzVr5oRHd9PE5KSkJAVyXJ9Mnz971szJ785WictIS0kIZZT+mzJn9qwZc19/' +
        'rBWVlZaSlhWt/fh60oxZs+dM+VeaISQhJS0jXnX23eSZs2bPn/7ENUdAUkpKTizt7qMJM2fNmjfxwdUEQbDRSbHP' +
        'poEte3M0RVweKCKc5/sLbPSkF6cqRUCWyWYXfpo6d/as2XOn/i3MlgUZLVJ56gXEsl++ecJAo+XFU46+ARs97Vls' +
        'EtgywYTQUX+M+oMG/gAAslN0sw==',
};

/** The bytes of the stream `name`. */
export async function supportStream(name) {
    const deflated = Uint8Array.from(atob(STREAMS[name]), char => char.charCodeAt(0));
    const inflated = new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/**
 * The pictures of the gradient files above by format, which only a host decodes: 16x16, red x * 16,
 * green y * 16, blue 128.
 */
export const GRADIENTS = Object.freeze({
    jpeg: 'gradient.jpg',
    avif: 'gradient.avif',
    jxl: 'gradient.jxl',
    heif: 'gradient.heic',
});

/** The gradient's RGBA pixels: { data, width, height }. */
export function gradientPicture() {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) data.set([x * 16, y * 16, 128, 255], (y * 16 + x) * 4);
    return { data, width: 16, height: 16 };
}
