/**
 * Small ffmpeg-made fixtures (ffmpeg 6.1.1, libx264/libopus/libmp3lame as shipped by Ubuntu) for
 * regressions found by the differential corpus. Each entry records the exact command that produced
 * it; every file is under 10 KB.
 */

const decode = text => Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'base64'));

const encoded = {
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" -c:a pcm_s16le
    // -metadata:s:a:0 "language=jpn" -metadata "title=Mac" -f mov mov-maclang.mov (1501 bytes)
    'mov-maclang.mov':
        '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' +
        'LjE2LjEwMA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s24le -f
    // mov mov-in24le.mov (1220 bytes)
    'mov-in24le.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAehtZGF0AAAAAGsFADIKAMUNALYPAM0PAAUOAJQKAOQ' +
        'FAIEAAA/7ADP2AH/yAGTwACHwAL/xAAz1AKb5AP/+AHYEAGYJADsNAH4PAO0PAHoOAFALANAGAIIBAAb8AA' +
        'P3AA/zAKTwAAnwAFHxAFf0AL34AP79AH0DAJIIAKQMADcPAP0PAOAOAAAMALUHAIECAAH9ANz3AK3zAPPwA' +
        'AHwAPPwAKzzANv3AAD9AIACALQHAP8LAN8OAP0PADcPAKQMAJMIAH0DAP/9AL34AFf0AFLxAAnwAKPwAA/z' +
        'AAL3AAX8AIEBAM8GAE8LAHkOAO0PAH8PADsNAGcJAHcEAP/+AKb5AA31AL/xACHwAGPwAH7yADL2AA77AIA' +
        'AAOMFAJQKAAQOAM0PALcPAMUNADMKAGwFAAEAAJX6AM71ADvyAErwADPwAPvxAGz1ABz6AH//APEEAM0JAI' +
        'ENAJwPAN8PAEEOAPQKAFoGAAEBAIr7AJr2AMXyAILwABPwAIbxALD0ADD5AH7+APoDAP0IAPEMAFwPAPcPA' +
        'K8OAKkLAEMHAAICAIP8AG73AFzzAMnwAAPwACDxAAD0AEv4AH/9AP8CACQIAFMMAA0PAP8PAA0PAFQMACUI' +
        'AAADAID9AEz4AAH0ACHxAAPwAAACwG1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAUAAEAAAEAAAA' +
        'AAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAIAAAIrdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAUAAAAAAAAAAAAAAABA' +
        'QAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxz' +
        'dAAAAAAAAAABAAAAFAAAAAAAAQAAAAABo21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAAACgf/8AAAA' +
        'AAC1oZGxyAAAAAG1obHJzb3VuAAAAAAAAAAAAAAAADFNvdW5kSGFuZGxlcgAAAU5taW5mAAAAEHNtaGQAAA' +
        'AAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAAAAAAAAAAAAAAC0RhdGFIYW5kbGVyAAAAJGRpbmYAAAAcZ' +
        'HJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA5nN0YmwAAACCc3RzZAAAAAAAAAABAAAAcmluMjQAAAAAAAAA' +
        'AQABAAAAAAAAAAEAEAAAAAAfQAAAAAAAAQAAAAMAAAADAAAAAgAAACZ3YXZlAAAADGZybWFpbjI0AAAACmV' +
        'uZGEAAQAAAAgAAAAAAAAAGGNoYW4AAAAAAGQAAQAAAAAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAKAAAAABAA' +
        'AAHHN0c2MAAAAAAAAAAQAAAAEAAACgAAAAAQAAABRzdHN6AAAAAAAAAAMAAACgAAAAFHN0Y28AAAAAAAAAA' +
        'QAAACQAAAAhdWR0YQAAABmpc3dyAA1VxExhdmY2MC4xNi4xMDA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_s24be -f
    // mov mov-in24be.mov (1220 bytes)
    'mov-in24be.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAehtZGF0AAAABWsACjIADcUAD7YAD80ADgUACpQABeQ' +
        'AAIEA+w8A9jMA8n8A8GQA8CEA8b8A9QwA+aYA/v8ABHYACWYADTsAD34AD+0ADnoAC1AABtAAAYIA/AYA9w' +
        'MA8w8A8KQA8AkA8VEA9FcA+L0A/f4AA30ACJIADKQADzcAD/0ADuAADAAAB7UAAoEA/QEA99wA860A8PMA8' +
        'AEA8PMA86wA99sA/QAAAoAAB7QAC/8ADt8AD/0ADzcADKQACJMAA30A/f8A+L0A9FcA8VIA8AkA8KMA8w8A' +
        '9wIA/AUAAYEABs8AC08ADnkAD+0AD38ADTsACWcABHcA/v8A+aYA9Q0A8b8A8CEA8GMA8n4A9jIA+w4AAIA' +
        'ABeMACpQADgQAD80AD7cADcUACjMABWwAAAEA+pUA9c4A8jsA8EoA8DMA8fsA9WwA+hwA/38ABPEACc0ADY' +
        'EAD5wAD98ADkEACvQABloAAQEA+4oA9poA8sUA8IIA8BMA8YYA9LAA+TAA/n4AA/oACP0ADPEAD1wAD/cAD' +
        'q8AC6kAB0MAAgIA/IMA924A81wA8MkA8AMA8SAA9AAA+EsA/X8AAv8ACCQADFMADw0AD/8ADw0ADFQACCUA' +
        'AwAA/YAA+EwA9AEA8SEA8AMAAAACwG1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAUAAEAAAEAAAA' +
        'AAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAIAAAIrdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAUAAAAAAAAAAAAAAABA' +
        'QAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxz' +
        'dAAAAAAAAAABAAAAFAAAAAAAAQAAAAABo21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAAACgf/8AAAA' +
        'AAC1oZGxyAAAAAG1obHJzb3VuAAAAAAAAAAAAAAAADFNvdW5kSGFuZGxlcgAAAU5taW5mAAAAEHNtaGQAAA' +
        'AAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAAAAAAAAAAAAAAC0RhdGFIYW5kbGVyAAAAJGRpbmYAAAAcZ' +
        'HJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA5nN0YmwAAACCc3RzZAAAAAAAAAABAAAAcmluMjQAAAAAAAAA' +
        'AQABAAAAAAAAAAEAEAAAAAAfQAAAAAAAAQAAAAMAAAADAAAAAgAAACZ3YXZlAAAADGZybWFpbjI0AAAACmV' +
        'uZGEAAAAAAAgAAAAAAAAAGGNoYW4AAAAAAGQAAQAAAAAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAKAAAAABAA' +
        'AAHHN0c2MAAAAAAAAAAQAAAAEAAACgAAAAAQAAABRzdHN6AAAAAAAAAAMAAACgAAAAFHN0Y28AAAAAAAAAA' +
        'QAAACQAAAAhdWR0YQAAABmpc3dyAA1VxExhdmY2MC4xNi4xMDA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -c:a pcm_f32le -f
    // mov mov-fl32le.mov (1380 bytes)
    'mov-fl32le.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAohtZGF0AAAAAABgLT0AIKM9AFDcPQBg+z0A0Pw9AFD' +
        'gPQBAqT0AgDw9AACBOwAgHr0A0Jy9ABDYvQDA+b0A8P29ABDkvQBAr70AQEu9AIAAvADADj0AYJY9ALDTPQ' +
        'Dg9z0A0P49AKDnPQAAtT0AAFo9AABBPACA/rwA0I+9ABDPvQDA9b0AcP+9APDqvQCQur0AYGi9AICAvABA3' +
        'zwAIIk9AEDKPQBw8z0A0P89AADuPQAAwD0AoHY9AECgPADAv7wAQIK9ADDFvQDQ8L0A8P+9ANDwvQBAxb0A' +
        'UIK9AADAvAAAoDwAgHY9APC/PQDw7T0A0P89AHDzPQBAyj0AMIk9AEDfPABAgLwAYGi9AJC6vQDg6r0AcP+' +
        '9AND1vQAQz70A4I+9AMD+vACAQDwA4Fk9APC0PQCQ5z0A0P49APD3PQCw0z0AcJY9AOAOPQCAALwAQEu9AD' +
        'CvvQAQ5L0A8P29AND5vQAg2L0A4Jy9AEAevQAAgDsAYDw9AECpPQBA4D0A0Pw9AHD7PQBQ3D0AMKM9AIAtP' +
        'QAAADgAYC29ACCjvQBQ3L0AYPu9AND8vQBQ4L0AQKm9AIA8vQAAgbsAIB49ANCcPQAQ2D0AwPk9APD9PQAQ' +
        '5D0AQK89AEBLPQCAADwAwA69AGCWvQCw070A4Pe9AND+vQCg570AALW9AABavQAAQbwAgP48ANCPPQAQzz0' +
        'AwPU9AHD/PQDw6j0AkLo9AGBoPQCAgDwAQN+8ACCJvQBAyr0AcPO9AND/vQAA7r0AAMC9AKB2vQBAoLwAwL' +
        '88AECCPQAwxT0A0PA9APD/PQDQ8D0AQMU9AFCCPQAAwDwAAKC8AIB2vQDwv70A8O29AND/vQAAAsBtb292A' +
        'AAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAFAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEA' +
        'AAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACK3RyYWsAAABcdGtoZAA' +
        'AAAMAAAAAAAAAAAAAAAEAAAAAAAAAFAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAA' +
        'AAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAABQAAAAAAAEAAAAAAaNtZ' +
        'GlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAAoH//AAAAAAAtaGRscgAAAABtaGxyc291bgAAAAAAAAAA' +
        'AAAAAAxTb3VuZEhhbmRsZXIAAAFObWluZgAAABBzbWhkAAAAAAAAAAAAAAAsaGRscgAAAABkaGxydXJsIAA' +
        'AAAAAAAAAAAAAAAtEYXRhSGFuZGxlcgAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAO' +
        'ZzdGJsAAAAgnN0c2QAAAAAAAAAAQAAAHJmbDMyAAAAAAAAAAEAAQAAAAAAAAABABAAAAAAH0AAAAAAAAEAA' +
        'AAEAAAABAAAAAIAAAAmd2F2ZQAAAAxmcm1hZmwzMgAAAAplbmRhAAEAAAAIAAAAAAAAABhjaGFuAAAAAABk' +
        'AAEAAAAAAAAAAAAAABhzdHRzAAAAAAAAAAEAAACgAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAoAAAAAE' +
        'AAAAUc3RzegAAAAAAAAAEAAAAoAAAABRzdGNvAAAAAAAAAAEAAAAkAAAAIXVkdGEAAAAZqXN3cgANVcRMYX' +
        'ZmNjAuMTYuMTAw',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=32000:duration=0.1" -c:a libmp3lame
    // -b:a 32k -f mp4 mp4-mp3.mp4 (1339 bytes)
    'mp4-mp3.mp4':
        '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',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=32000:duration=0.1" -c:a libmp3lame
    // -b:a 32k -f mov mov-mp3.mov (1286 bytes)
    'mov-mp3.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAkhtZGF0//sYxAAABcQlRvTwgCEVkO43HtACACXtbAA' +
        'c5pmmaZ1s8IvghAC2BDEPLmo37+PcEAQBAMVg+nlPT/7+jz/R7+j39ElIF24GAwHA4HAAAAABfhvSGHBIEg' +
        'k8dridjmS4nRaRx1RQmoK74lpJD2/HsYl0u/5kXiSMS6Xf/0kjJEFRF/hUFREFQVUvMMgCmAwB//sYxAODx' +
        '3wpFB3kgAD4hWGBr/CIOYIgK5gLAuGF6JUZIZ+Bpn9wHx8e+ZSZ4hjZieGLGG4YJoCwYAmYCgBa1XcVMAFA' +
        'b//9H9DeIDzFADPjzeJj70TBFgMwxS8rWNnsB7jBfBX46TVAqYyUSEALSWYS+ETn7Pf8i+3qv3/SroruRV7' +
        'u3Z/ujwAALIXQH5c5//sYxAQDhwQlFyz7ZEEDBaKCvJAAjiLZQwLpGDwBeZS7Up6oAMmEUVkbNWGPFZgIQi' +
        'auZ2ZVdNPX2d9f0f0//ff/Wn/0GAOAShkCACDA4BIAAHJgrhpmROeyaTv255xCcGOCN4YlQoRi6B7GEECcC' +
        'gPTAbATAwBbQnEEBVvf//6P/////9COCMDMOBAaTqVO//sYxAUAB4htQhm1gADSiVyDsMABuaxZmuCJm+AM' +
        'AkJdJ8raVa/3GgHwJxERO/j4OwxSh3+XpqHGzUf/sk+LHB/1Cdoz/puRCM6jWYvU0UtiXFYLHGUqlXTGFMk' +
        'VmDPCoCFSGJJNW80uXc0uXPfVlb8UFYCmAobibiCuhUxBTUUzLjEwMFVVVVVVVVVVVVVVAAACom1vb3YAAA' +
        'BsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAABkAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAA' +
        'AAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAINdHJhawAAAFx0a2hkAAAA' +
        'AwAAAAAAAAAAAAAAAQAAAAAAAABkAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAA' +
        'AAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAZAAABFEAAQAAAAABhW1kaW' +
        'EAAAAgbWRoZAAAAAAAAAAAAAAAAAAAfQAAABDRf/8AAAAAAC1oZGxyAAAAAG1obHJzb3VuAAAAAAAAAAAAA' +
        'AAADFNvdW5kSGFuZGxlcgAAATBtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAA' +
        'AAAAAAAAAAAAC0RhdGFIYW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAAyHN' +
        '0YmwAAABcc3RzZAAAAAAAAAABAAAATC5tcDMAAAAAAAAAAQABAAAAAAAAAAEAEP/+AAB9AAAAAAAEgAAAAA' +
        'AAAAAAAAAAAgAAABhjaGFuAAAAAAABAAAAAAAEAAAAAAAAACBzdHRzAAAAAAAAAAIAAAADAAAEgAAAAAEAA' +
        'ANRAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAEAAAAAQAAABRzdHN6AAAAAAAAAJAAAAAEAAAAFHN0Y28AAAAA' +
        'AAAAAQAAACQAAAAhdWR0YQAAABmpc3dyAA1VxExhdmY2MC4xNi4xMDA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 6 -c:a alac -f
    // ipod m4a-alac6.m4a (1005 bytes)
    'm4a-alac6.m4a':
        'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAABHm1kYXQAABAAAAFAAAALDADR/uoA1/9' +
        '4AE//6A/4Vq/8Jjv4u7mC/pMCgQJi87mENhmExYUyA30CHDAu0QaDjqIzBxrJWGPrKoclUdvGbKMEMRwB6w' +
        'hwsiRcEwh8cPY+RP0DQlDjMMPQJqnkH+UHrfI3udCh6uLqaGNLqFpOs4TsfQo7SFFpmMXlYkisWi5kjxM/d' +
        'SRRqUDYmf8FNqowUXJJ72S3UgIXkAIfai9nFiWA8B/o5P05Ig5JCnSAiAAEAAAAUAAAA8IAQAAAAAAAAAPC' +
        'AEAAAAAAAAA/4BPv+AT5EACAAAAKAAAAeEAIAAAAAAAAAHhACAAAAAAAAAf8An3/AJ8CABAAAAFAAAAPCAE' +
        'AAAAAAAAA/4BP8AAAAqttb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAFAABAAABAAAAAAAAAAAAAA' +
        'AAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AACAAAB1XRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAFAAAAAAAAAAAAAAAAQEAAAAAAQAA' +
        'AAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAA' +
        'AAQAAABQAAAAAAAEAAAAAAU1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAAoFXEAAAAAAAtaGRscg' +
        'AAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAD4bWluZgAAABBzbWhkAAAAAAAAAAAAA' +
        'AAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAC8c3RibAAAAFhzdHNkAAAAAAAAAAEAAABI' +
        'YWxhYwAAAAAAAAABAAAAAAAAAAAABgAQAAAAAB9AAAAAAAAkYWxhYwAAAAAAABAAABAoCg4GAAAAAMAEAAu' +
        '4AAAAH0AAAAAYc3R0cwAAAAAAAAABAAAAAQAAAKAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFH' +
        'N0c3oAAAAAAAABFgAAAAEAAAAUc3RjbwAAAAAAAAABAAAALAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkb' +
        'HIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZm' +
        'NjAuMTYuMTAw',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=32000:duration=0.1" -c:a libmp3lame
    // -b:a 32k -f matroska mkv-mp3-discard.mkv (1192 bytes)
    'mkv-mp3-discard.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAEdBFNm3TAv4RLtFv' +
        'STbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBVE27jFOrhBxTu2tTrIIEWOwBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hKvzqi4q17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJBiEk4VaJNcD7YY2hUK+2AVRImIQGDgAAAAAAAWVK5r3r+E0qtA/K4BAAAAAAA' +
        'AT9eBAXPFiHJZNR6olNifnIEAIrWcg3VuZIiBAIaJQV9NUEVHL0wzVqqEAg7nsoOBAiPjg4QCJVEA4ZGfgQ' +
        'G1iEDfQAAAAAAAYmSBEFXugQASVMNnQIa/hL8keqBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYwLjE2L' +
        'jEwMHNz2mPAi2PFiHJZNR6olNifZ8ilRaOHRU5DT0RFUkSHmExhdmM2MC4zMS4xMDIgbGlibXAzbGFtZWfI' +
        'oUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTM1MDAwMDAwAB9DtnVCcr+EWRviK+eBAKNAlIEAAID/+xjEAAA' +
        'FxCVG9PCAIRWQ7jce0AIAJe1sABzmmaZpnWzwi+CEALYEMQ8uajfv49wQBAEAxWD6eU9P/v6PP9Hv6Pf0SU' +
        'gXbgYDAcDgcAAAAAF+G9IYcEgSCTx2uJ2OZLidFpHHVFCagrviWkkPb8exiXS7/mReJIxLpd//SSMkQVEX+' +
        'FQVEQVBVS8wyAKYDAGjQJSBACSA//sYxAODx3wpFB3kgAD4hWGBr/CIOYIgK5gLAuGF6JUZIZ+Bpn9wHx8e' +
        '+ZSZ4hjZieGLGG4YJoCwYAmYCgBa1XcVMAFAb//9H9DeIDzFADPjzeJj70TBFgMwxS8rWNnsB7jBfBX46TV' +
        'AqYyUSEALSWYS+ETn7Pf8i+3qv3/SroruRV7u3Z/ujwAALIXQH5c5o0CUgQBIgP/7GMQEA4cEJRcs+2RBAw' +
        'WigryQAI4i2UMC6Rg8AXmUu1KeqADJhFFZGzVhjxWYCEImrmdmVXTT19nfX9H9P/33/1p/9BgDgEoZAgAgw' +
        'OASAAByYK4aZkTnsmk79uecQnBjgjeGJUKEYugexhBAnAoD0wGwEwMAW0JxBAVb3//+j//////QjgjAzDgQ' +
        'Gk6lTqBAoaFAlIEAbAD/+xjEBQAHiG1CGbWAANKJXIOwwAG5rFma4Imb4AwCQl0nytpVr/caAfAnERE7+Pg' +
        '7DFKHf5emocbNR/+yT4scH/UJ2jP+m5EIzqNZi9TRS2JcVgscZSqVdMYUyRWYM8KgIVIYkk1bzS5dzS5c99' +
        'WVvxQVgKYChuJuIK6FTEFNRTMuMTAwVVVVVVVVVVVVVVWbgRt1ooQAkHtOHFO7a5e/hMvq7+67j7OBALeK9' +
        '4EB8YIB4PCBCQ==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v mjpeg -pix_fmt yuvj420p
    // -q:v 31 -f matroska mkv-mjpeg.mkv (1167 bytes)
    'mkv-mjpeg.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAEWxFNm3TAv4RpoFx' +
        'cTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBVU27jFOrhBxTu2tTrIIELewBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hAHnPB0q17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJCstoJLUkjjQNYOI8B1iHzMRImIQHkAAAAAAAAWVK5r37+EiuMnxK4BAAAAAAA' +
        'AUNeBAXPFiChixlLCz8NLnIEAIrWcg3VuZIiBAIaHVl9NSlBFR4OBASPjg4QL68IA4JCwgRC6gRCagQJVsI' +
        'RVuYECVe6BAOwBAAAAAAAAAgAAElTDZ0CBv4Sksz8xc3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xN' +
        'i4xMDBzc9VjwItjxYgoYsZSws/DS2fIoEWjh0VOQ09ERVJEh5NMYXZjNjAuMzEuMTAyIG1qcGVnZ8ihRaOI' +
        'RFVSQVRJT05Eh5MwMDowMDowMC40MDAwMDAwMDAAH0O2dUJLv4TU6BnI54EAo0EegQAAgP/Y/+AAEEpGSUY' +
        'AAQIAAAEAAQAA//4AEExhdmM2MC4zMS4xMDIA/9sAQwAIPj5JPklVVVVVVVVkXWRoaGhkZGRkaGhocHBwg4' +
        'ODcHBwaGhwcHx8g4OPk4+Hh4OHk5Obm5u6urKy2dng/////8QAZAABAQEAAAAAAAAAAAAAAAAABQMHAQEBA' +
        'AAAAAAAAAAAAAAAAAAABhAAAgAGAQUBAAAAAAAAAAAAEQEAUSExAhKBYXEiQZFCEQABAwUBAAAAAAAAAAAA' +
        'AAACABEBgQPx0TFR/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Ay7ybCi2G+LpI+rTNoZx/a7U' +
        'mIRTWmorfXoSPnMJvFL79VAQ9rhf/2aNBHoEAyID/2P/gABBKRklGAAECAAABAAEAAP/+ABBMYXZjNjAuMz' +
        'EuMTAyAP/bAEMACD4+ST5JVVVVVVVVZF1kaGhoZGRkZGhoaHBwcIODg3BwcGhocHB8fIODj5OPh4eDh5OTm' +
        '5uburqystnZ4P/////EAGQAAQEBAAAAAAAAAAAAAAAAAAUDBwEBAQAAAAAAAAAAAAAAAAAAAAYQAAIABgEF' +
        'AQAAAAAAAAAAABEBAFEhMQISgWFxIkGRQhEAAQMFAQAAAAAAAAAAAAAAAgARAYED8dExUf/AABEIABAAEAM' +
        'BIgACEQADEQD/2gAMAwEAAhEDEQA/AMu8mwothvi6SPq0zaGcf2u1JiEU1pqK316Ej5zCbxS+/VQEPa4X/9' +
        'kcU7trqb+EazIozLuPs4EAt4r3gQHxggHc8IEJu5Czgci3i/eBAfGCAdzwggEq',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.06" -c:a libopus -b:a
    // 6k -f matroska mkv-opus8k.mkv (690 bytes)
    'mkv-opus8k.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAACfhFNm3TAv4QNHn0' +
        'dTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBZU27jFOrhBxTu2tTrIICYuwBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hIAc4oIq17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJDtrTQcGP4OS7yLVGqve+NFRImIQFEAAAAAAAAWVK5r77+Ei70eh64BAAAAAAA' +
        'AYNeBAXPFiBhu71W66yS9nIEAIrWcg3VuZIiBAIaGQV9PUFVTVqqDYy6gVruEBMS0AIOBAuGRn4EBtYhAv0' +
        'AAAAAAAGJkgRBV7oEAY6KTT3B1c0hlYWQBATgBQB8AAAAAABJUw2dAg7+EyEoGvHNzoGPAgGfImkWjh0VOQ' +
        '09ERVJEh41MYXZmNjAuMTYuMTAwc3PXY8CLY8WIGG7vVbrrJL1nyKJFo4dFTkNPREVSRIeVTGF2YzYwLjMx' +
        'LjEwMiBsaWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4wNjgwMDAwMDAAH0O2de+/hHrlSyzngQC' +
        'jkYEAAIAIg8ok48IgaDQeqk3oo5uBABWACKcaXYqYLl9aylEr1T75KdeosRClK4Cjk4EAKYAIoS8Q5F373A' +
        'ba+2KY0aygn6GWgQA9AAiEwO5ABxW/7FrDr3Ijr97/MHWihADN/mAcU7trl7+E+J0wDruPs4EAt4r3gQHxg' +
        'gHu8IEJ',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.2" -c:a aac -b:a 8k -f
    // matroska mkv-aac.mkv (1141 bytes)
    'mkv-aac.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAEQRFNm3TAv4RN9d4' +
        'oTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBUE27jFOrhBxTu2tTrIIEJewBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hEzcPNEq17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJCUWXraDd9jPAaG6qg6ErkiRImIQHSAAAAAAAAWVK5r2r+EfsOEnK4BAAAAAAA' +
        'AS9eBAXPFiPJeljFmQNebnIEAIrWcg3VuZIiBAIaFQV9BQUNWqoQHoSAAg4EC4ZGfgQG1iEC/QAAAAAAAYm' +
        'SBIFXugQBjooUViFblABJUw2dAf7+EGSKtCnNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMTYuMTAwc' +
        '3PTY8CLY8WI8l6WMWZA15tnyJ5Fo4dFTkNPREVSRIeRTGF2YzYwLjMxLjEwMiBhYWNnyKFFo4hEVVJBVElP' +
        'TkSHkzAwOjAwOjAwLjMyODAwMDAwMAAfQ7Z1Qkq/hIHKghDngQCjQPOBAACA3gIATGF2YzYwLjMxLjEwMgA' +
        'COKVS00bus/aPt8SVdy0SJEiRJINq2natp2radq4ztXGdq2menbFO2Kw7VtO1cZ2rjOVZTlW05VtNixOOxO' +
        'VZSECECECESUZKMqjKpTJWlNdcrq7tzA3YpQJQMDAwMDGzcsssssspuWWWWWWU3LLLLLLLLLLLLLLLLLLLL' +
        'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL' +
        'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLyjQOWBAICAAQCc2T0VRLoZRLsXZL59vn/+L/z' +
        '/XrjjWrkf9P0//D/z/HnjzepdZ/0/P/p/8/XXHF9VqT/0/P/p/9/rrXHGl0mXRijwMujEnHLoxR4aZmwxXN' +
        'NMuZczzTTJZo2WX5D9eC7BA4SjCdZzoqqMY1Bo6KI6DdA6hQboN1T0UVhStmyLe2bNhHfSLhG0S4vsnsI7N' +
        'myK/IkcFZcyznYjzznOdSlRqUqeeeeedU6p1TqnnnnUJ1KVPPPPsnUb6N9FFL86l60odjnxtdg3xO4fgpzq' +
        'h5uadU8/NPzfJU5EhB0fLYoco+GBAQCAARidtmvRSkyH4D8PV/t/M1q3u+9D+w/64PM+rB+8/64PuvxkP9F' +
        '89D873ofK+SH6XyfVehAPVep9F2oB23a8LggGzYGzZsA8PV6Ono6ejpAAD/rP+s/6z/rPuwAOHFO7a5e/hF' +
        'jiGim7j7OBALeK94EB8YIB1fCBCQ==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.1" -c:a aac -b:a 8k
    // -mpegts_m2ts_mode 1 -f mpegts m2ts-aac.m2ts (6144 bytes)
    'm2ts-aac.m2ts':
        'Dr9GIkdAERAAQvAlAAHBAAD/Af8AAfyAFEgSAQZGRm1wZWcJU2VydmljZTAxd3xDyv/////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////AywuSEdAABAAALANAAHBAAAAAeEA6Pleff//////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////N5kWbUdBABAAArAeAAHBAADxAPAMBQRIRE1WiAQP//z8BvEA8AAEj4dU/////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////LAX+k0dRADAHUAAAewx+AAAAAcABi4CABSEAB9hh//FsQBh//N4CAExhdmM2MC' +
        '4zMS4xMDIAAnBlIotges79fXGruS4kWiREiAEhISEhISEhISEhISE6JCdE65+U0ziUTMJmtCUv29XyiHGbj' +
        'Fsi2RTcYuMWyI8RcSqiyxTcYuMT8RRFxiREIiiJESIhFFFEiKKIoiREiIoiiiREIiiiREiKKKKKJERRFFEi' +
        'IRFFFFEiIoiiiREIiiiREiIoiiiiIHLmuUcRABGKKIookRIiKIookRCIookRIiKIookRCIookRCIorkRI4D' +
        '/8WxAGB/8ATwyi+ZhVVnj7fv1q5ckkkSJEiIDWbmgmdfach55oH3XGm+aDK7kaCuc+YZGmc3PNufac0N80G' +
        'V1xrNDzzbn2nIW5oMrrjTfNBl3PtOQ8827Lncab5oMrqGnIeebc/nc0N80GV1xpkPPNufach5+aDK6403zQ' +
        'Tbn2nIeeaDK6403zQZdz7TkPPNufdcab5oMFN/O30cRADKOAP//////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////////67kazQ88259pz' +
        'Q3zQZXXGm4eebc+05Dz80GV1xpvmgm3PtOQ880D7rnCUy3BUcf/xD//////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////////////////////////PbmfKkcf/xD///////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////////////////////////MiaHUEcf/xD////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////JpNvdkcf/xD/////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////////GwBXnEcf/xD//' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////////////////////////////////////////////////////D20/wk' +
        'cf/xD//////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/A9on6Ecf/xD///////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////OEcQDUcf/xD////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////LLP4M0cf/xD/////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////ISDgWUcf/xD//////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////FY3If0cf/xD///////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////CfqwpUcf/xD////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////PmeYykcf/xD/////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////MtSA8Ecf/xD//////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////////////////////////////////J0FpFkcf/xD///////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////////////////////////////////G65RPEcf/xD////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////EBs5Ykcf/xD/' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////////////////BIghi' +
        'Ecf/xD/////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//OPUJrUcf/xD//////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////LWHx00cf/xD///////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////Ic7Z+Ucf/xD////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////FjvCH0cf/xD/////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////CqiqRUcf/xD//////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////////////PxWSakcf/xD///////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////////////M4J6kEcf/xD////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////J+9itkcf/xD/////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.2" -c:a aac -b:a 8k -f
    // mpegts ts-aac.ts (1316 bytes)
    'ts-aac.ts':
        'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK///////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///0dQABAAArASAAHBAADhAPAAD+EA8AC2m8DZ/////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////R0EAMAdQAAB7DH4AAAABwAJKgIAFIQAH2GH/8WxAHt/83gIATGF2YzYwLjMxLjEwMgACOKVS00bus/' +
        'aPt8SVdy0SJEiRJINq2natp2radq4ztXGdq2menbFO2Kw7VtO1cZ2rjOVZTlW05VtNixOOxOVZSECECECES' +
        'UZKMqjKpTJWlNdcrq7tzA3YpQJQMDAwMDGzcsssssspuWWWWWWU3LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL' +
        'LLLLLLJHAQARyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' +
        'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy8//FsQB0f/AEAnNk9FUS6GUS7F2S+fb5//i/8/16441' +
        'q5H/T9P/w/8/x5483qXWf9Pz/6f/P11xxfVak/9Pz/6f/f661xxpdJl0Yo8DLoxJxy6MUeGmZsMVzTTLmXM' +
        '800yWaNlkcBABJfkP14LsEDhKMJ1nOiqoxjUGjoojoN0DqFBug3VPRRWFK2bIt7Zs2Ed9IuEbRLi+yewjs2' +
        'bIr8iRwVlzLOdiPPOc51KVGpSp555551TqnVOqeeedQnUpU888+ydRvo30UUvzqXrSh2OfG12DfE7h+CnOq' +
        'Hm5p1Tz80/N8lTkSEHR8tihz/8WxADJ/8ARidtmvRSkyH4D8PV/t/M1q3u+9D+w/64PM+rB+8/64PuvxkP9' +
        'F89D873ofKRwEAM4cA/////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////5IfpfJ9V6EA9V6n0XagHbdrwuCAbNgbNmwDw9Xo6ejp6OkAAP+s/' +
        '6z/rP+s+7AA4=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.6" -c:v mjpeg -pix_fmt yuvj420p
    // -q:v 31 -metadata "title=Motion" -f avi avi-mjpeg.avi (6696 bytes)
    'avi-mjpeg.avi':
        'UklGRiAaAABBVkkgTElTVDgSAABoZHJsYXZpaDgAAABADQMAqGEAAAAAAAAQCQAAAwAAAAAAAAABAAAAAAA' +
        'QABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAExJU1TgEAAAc3RybHN0cmg4AAAAdmlkc01KUEcAAAAAAAAAAA' +
        'AAAAABAAAABQAAAAAAAAADAAAAGgEAAP////8AAAAAAAAAABAAEABzdHJmKAAAACgAAAAQAAAAEAAAAAEAG' +
        'ABNSlBHAAMAAAAAAAAAAAAAAAAAAAAAAABKVU5LGBAAAAQAAAAAAAAAMDBkYwAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2cHJwRAAAAAAAAAAAAAAABQ' +
        'AAABAAAAAQAAAAAQABABAAAAAQAAAAAQAAABAAAAAQAAAAEAAAABAAAAAAAAAAAAAAAAAAAAAAAAAASlVOS' +
        'wQBAABvZG1sZG1saPgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAExJU1QqAAAASU5GT0lOQU0HAAAATW90aW9uAABJU0ZUDgAAAExhdmY2MC4xNi4x' +
        'MDAASlVOS/gDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExJU1RqAwAAbW92aTAwZGMaAQAA/9j/4AAQSkZJRgA' +
        'BAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAg+Pkk+SVVVVVVVVWRdZGhoaGRkZGRoaGhwcHCDg4' +
        'NwcHBoaHBwfHyDg4+Tj4eHg4eTk5ubm7q6srLZ2eD/////xABkAAEBAQAAAAAAAAAAAAAAAAAFAwcBAQEAA' +
        'AAAAAAAAAAAAAAAAAAGEAACAAYBBQEAAAAAAAAAAAARAQBRITECEoFhcSJBkUIRAAEDBQEAAAAAAAAAAAAA' +
        'AAIAEQGBA/HRMVH/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwDLvJsKLYb4ukj6tM2hnH9rtSY' +
        'hFNaait9ehI+cwm8Uvv1UBD2uF//ZMDBkYxoBAAD/2P/gABBKRklGAAECAAABAAEAAP/+ABBMYXZjNjAuMz' +
        'EuMTAyAP/bAEMACD4+ST5JVVVVVVVVZF1kaGhoZGRkZGhoaHBwcIODg3BwcGhocHB8fIODj5OPh4eDh5OTm' +
        '5uburqystnZ4P/////EAGQAAQEBAAAAAAAAAAAAAAAAAAUDBwEBAQAAAAAAAAAAAAAAAAAAAAYQAAIABgEF' +
        'AQAAAAAAAAAAABEBAFEhMQISgWFxIkGRQhEAAQMFAQAAAAAAAAAAAAAAAgARAYED8dExUf/AABEIABAAEAM' +
        'BIgACEQADEQD/2gAMAwEAAhEDEQA/AMu8mwothvi6SPq0zaGcf2u1JiEU1pqK316Ej5zCbxS+/VQEPa4X/9' +
        'kwMGRjGgEAAP/Y/+AAEEpGSUYAAQIAAAEAAQAA//4AEExhdmM2MC4zMS4xMDIA/9sAQwAIPj5JPklVVVVVV' +
        'VVkXWRoaGhkZGRkaGhocHBwg4ODcHBwaGhwcHx8g4OPk4+Hh4OHk5Obm5u6urKy2dng/////8QAZAABAQEA' +
        'AAAAAAAAAAAAAAAABQMHAQEBAAAAAAAAAAAAAAAAAAAABhAAAgAGAQUBAAAAAAAAAAAAEQEAUSExAhKBYXE' +
        'iQZFCEQABAwUBAAAAAAAAAAAAAAACABEBgQPx0TFR/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD' +
        '8Ay7ybCi2G+LpI+rTNoZx/a7UmIRTWmorfXoSPnMJvFL79VAQ9rhf/2WlkeDEwAAAAMDBkYxAAAAAEAAAAG' +
        'gEAADAwZGMQAAAAJgEAABoBAAAwMGRjEAAAAEgCAAAaAQAA',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=22050:duration=0.05" -c:a aac -b:a 16k
    // -metadata "title=Flash" -f flv flv-title.flv (599 bytes)
    'flv-title.flv':
        'RkxWAQQAAAAJAAAAABIAANAAAAAAAAAAAgAKb25NZXRhRGF0YQgAAAAJAAhkdXJhdGlvbgA/uJN0vGp++gA' +
        'NYXVkaW9kYXRhcmF0ZQBAL0AAAAAAAAAPYXVkaW9zYW1wbGVyYXRlAEDViIAAAAAAAA9hdWRpb3NhbXBsZX' +
        'NpemUAQDAAAAAAAAAABnN0ZXJlbwEAAAxhdWRpb2NvZGVjaWQAQCQAAAAAAAAABXRpdGxlAgAFRmxhc2gAB' +
        '2VuY29kZXICAA1MYXZmNjAuMTYuMTAwAAhmaWxlc2l6ZQBAgrgAAAAAAAAACQAAANsIAAAHAAAAAAAAAK8A' +
        'E4hW5QAAAAASCAAAlQAAAAAAAACvAd4CAExhdmM2MC4zMS4xMDIAAliiVFIi/td1nPv+u/xKePjealTVJCw' +
        'xWJxWJxWJ491U0ZVMa1Xa1ZbFibNxnj8NvulVGrClClTtirMlWZJ9bKVRlUZXGSgYG/o39GBgYGBgYGBgYG' +
        'BjZsGBkSIGBgYGBkSKWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXgAAAKAIAACMAAAuAAAAAK8BA' +
        'UCS2Lq2muvA6f3/+frjWr13/b+S7vXj+38gA7Chhh+XyGUtJZ1NitjAjb2Qm9LZsyE+qyhX6QlmkVbbXjRO' +
        'huqCZZgmWYJlmCUptUywk4blXgRuAJ5fUdvdMgBFh4AYOAViesyTBH4B+c4O/XUAW1tjCiAP3/gZwdT58rP' +
        'A6vjaMTjkHD5G/KwHAAAAlwgAAAcAAFwAAAAArwEBGIG0cAAAABI=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.06" -ac 6 -c:a libopus
    // -b:a 12k -metadata "title=Surround" -f opus ogg-opus6.opus (337 bytes)
    'ogg-opus6.opus':
        'T2dnUwACAAAAAAAAAAA3K3bnAAAAAJxwuYsBG09wdXNIZWFkAQY4AUAfAAAAAAEEAgAEAQIDBU9nZ1MAAAA' +
        'AAAAAAAAANyt25wEAAAAeIkz/AVBPcHVzVGFncw0AAABMYXZmNjAuMTYuMTAwAgAAAB0AAABlbmNvZGVyPU' +
        'xhdmM2MC4zMS4xMDIgbGlib3B1cw4AAAB0aXRsZT1TdXJyb3VuZE9nZ1MABHgMAAAAAAAANyt25wIAAACK7' +
        '7aMBCImIiUIBgvx+RaF4AgGC/H5FoXgCAmEwTULn4wutpIIC/H5FoXgCAUKeLMOxggFCnizDsYIELL9nYqY' +
        'Ll9aylBYvR8OJnQICnizDsYIBQp4sw7GCAUKeLMOxggMqyfi+zKhIHKcRSuICAp4sw7GCAUKeLMOxggFCni' +
        'zDsYID4WCacAC3Th7ct8slJ2fDAgKeLMOxg==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.3" -c:a libopus -b:a 6k
    // -page_duration 20000 -metadata "title=Pages" -f opus ogg-opus.opus (862 bytes)
    'ogg-opus.opus':
        'T2dnUwACAAAAAAAAAADkOL8lAAAAAFukuoUBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAOQ' +
        '4vyUBAAAAyDpNzQFNT3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAIAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMz' +
        'EuMTAyIGxpYm9wdXMLAAAAdGl0bGU9UGFnZXNPZ2dTAADAAwAAAAAAAOQ4vyUCAAAAZacahwENCIPKJOPCI' +
        'Gg0HqpN6E9nZ1MAAIAHAAAAAAAA5Di/JQMAAADBjMFXARcIpxpdipguX1rKUSvVPvkp16ixEKUrgE9nZ1MA' +
        'AEALAAAAAAAA5Di/JQQAAABgYRTKAQ8IoS8Q5F373Aba+2KY0axPZ2dTAAAADwAAAAAAAOQ4vyUFAAAA169' +
        'cYgETCKE40Hcyqla5wUCB5jRvNh4d0k9nZ1MAAMASAAAAAAAA5Di/JQYAAAA6zh+cAREIoTjQdzKqXlKRxc' +
        'cuaQsDwE9nZ1MAAIAWAAAAAAAA5Di/JQcAAAD7yfxDAREIoUgDRtVSc9qElo38Ji570E9nZ1MAAEAaAAAAA' +
        'AAA5Di/JQgAAABHUT0FARMIoTjO/AZGOE9NevIPiMdJqGUcT2dnUwAAAB4AAAAAAADkOL8lCQAAAMRNrsUB' +
        'DwihONB3MqpeTa4bXgbEyE9nZ1MAAMAhAAAAAAAA5Di/JQoAAADfDMsZARAIoTjQdzKqVpnvjR0zRhuUT2d' +
        'nUwAAgCUAAAAAAADkOL8lCwAAACKHBvEBEAihONB3MqpeUUPvO1zcrntPZ2dTAABAKQAAAAAAAOQ4vyUMAA' +
        'AAv3nGLQEQCKE40HcvR3logzf5qcO9rE9nZ1MAAAAtAAAAAAAA5Di/JQ0AAAAszi90ARAIoTjQdzKqVkYFM' +
        'E8Z9/qsT2dnUwAAwDAAAAAAAADkOL8lDgAAAKl+mEkBDgihLxDkXfvcBs8CCDLUT2dnUwAAgDQAAAAAAADk' +
        'OL8lDwAAAMLMl1MBDwihTMA963GxDtVYVAGmkU9nZ1MAAEA4AAAAAAAA5Di/JRAAAADdZ5w3AREIoTjQdzK' +
        'qXo/UQlEV4op2GE9nZ1MABHg5AAAAAAAA5Di/JREAAABbt2DbAQ4Ig/ikhaHLxuEjjTW3gA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" -c:a pcm_s16le
    // -metadata "title=Wave" -f wav wav-info.wav (892 bytes)
    'wav-info.wav':
        'UklGRnQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAATElTVCgAAABJTkZPSU5BTQUAAABXYXZlAAB' +
        'JU0ZUDgAAAExhdmY2MC4xNi4xMDAAZGF0YSADAAAAAGsFMgrFDbYPzQ8FDpQK5AWBAA/7M/Z/8mTwIfC/8Q' +
        'z1pvn//nYEZgk7DX4P7Q96DlAL0AaCAQb8A/cP86TwCfBR8Vf0vfj+/X0DkgikDDcP/Q/gDgAMtQeBAgH93' +
        'Pet8/PwAfDz8Kzz2/cA/YACtAf/C98O/Q83D6QMkwh9A//9vfhX9FLxCfCj8A/zAvcF/IEBzwZPC3kO7Q9/' +
        'DzsNZwl3BP/+pvkN9b/xIfBj8H7yMvYO+4AA4wWUCgQOzQ+3D8UNMwpsBQEAlfrO9TvySvAz8PvxbPUc+n/' +
        '/8QTNCYENnA/fD0EO9ApaBgEBivua9sXygvAT8IbxsPQw+X7++gP9CPEMXA/3D68OqQtDBwICg/xu91zzyf' +
        'AD8CDxAPRL+H/9/wIkCFMMDQ//Dw0PVAwlCAADgP1M+AH0IfED8MnwXPNt94P8AQJDB6kLrg73D10P8Qz+C' +
        'PsDf/4x+bH0h/ET8IHwxfKZ9on7AQFaBvMKQQ7fD50Pgg3OCfIEgP8d+mz1/PEz8EnwO/LN9ZT6//9rBTIK' +
        'xQ22D80PBQ6UCuQFgQAP+zP2f/Jk8CHwv/EM9ab5//52BGYJOw1+D+0Peg5QC9AGggEG/AP3D/Ok8AnwUfF' +
        'X9L34/v19A5IIpAw3D/0P4A4ADLUHgQIB/dz3rfPz8AHw8/Cs89v3AP2AArQH/wvfDv0PNw+kDJMIfQP//b' +
        '34V/RS8Qnwo/AP8wL3BfyBAc8GTwt5Du0Pfw87DWcJdwT//qb5DfW/8SHwY/B+8jL2DvuAAOMFlAoEDs0Pt' +
        'w/FDTMKbAUBAJX6zvU78krwM/D78Wz1HPp///EEzQmBDZwP3w9BDvQKWgYBAYr7mvbF8oLwE/CG8bD0MPl+' +
        '/voD/QjxDFwP9w+vDqkLQwcCAoP8bvdc88nwA/Ag8QD0S/h//f8CJAhTDA0P/w8ND1QMJQgAA4D9TPgB9CH' +
        'xA/DJ8FzzbfeD/AECQwepC64O9w9dD/EM/gj7A3/+Mfmx9IfxE/CB8MXymfaJ+wEBWgbzCkEO3w+dD4INzg' +
        'nyBID/Hfps9fzxM/BJ8DvyzfWU+g==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.3" -c:a flac
    // -frame_size 256 -metadata "title=Lossless" -f flac flac-blocks.flac (9801 bytes)
    'flac-blocks.flac':
        'ZkxhQwAAACIBAAEAAABqAAChAfQA8AAACWC4f3Njyt/ZSSO27oWgnjnyBAAAQA0AAABMYXZmNjAuMTYuMTA' +
        'wAgAAAA4AAAB0aXRsZT1Mb3NzbGVzcxUAAABlbmNvZGVyPUxhdmY2MC4xNi4xMDCBACAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        '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' +
        'QUwqLJeLPNJTKCChgw4QzLaSeJNLSlijhQIhJ',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 6 -c:a
    // pcm_s16be -metadata "title=Six" -f aiff aiff-chan.aiff (2006 bytes)
    'aiff-chan.aiff':
        'Rk9STQAAB85BSUZGQ0hBTgAAAAwAeQAGAAAAAAAAAABOQU1FAAAABFNpeABDT01NAAAAEgAGAAAAoAAQQAv' +
        '6AAAAAAAAAFNTTkQAAAeIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABWsAAAAAAAAAAAAACjIAAAAAAAAAAA' +
        'AADcUAAAAAAAAAAAAAD7YAAAAAAAAAAAAAD80AAAAAAAAAAAAADgUAAAAAAAAAAAAACpQAAAAAAAAAAAAAB' +
        'eQAAAAAAAAAAAAAAIEAAAAAAAAAAAAA+w8AAAAAAAAAAAAA9jMAAAAAAAAAAAAA8n8AAAAAAAAAAAAA8GQA' +
        'AAAAAAAAAAAA8CEAAAAAAAAAAAAA8b8AAAAAAAAAAAAA9QwAAAAAAAAAAAAA+aYAAAAAAAAAAAAA/v8AAAA' +
        'AAAAAAAAABHYAAAAAAAAAAAAACWYAAAAAAAAAAAAADTsAAAAAAAAAAAAAD34AAAAAAAAAAAAAD+0AAAAAAA' +
        'AAAAAADnoAAAAAAAAAAAAAC1AAAAAAAAAAAAAABtAAAAAAAAAAAAAAAYIAAAAAAAAAAAAA/AYAAAAAAAAAA' +
        'AAA9wMAAAAAAAAAAAAA8w8AAAAAAAAAAAAA8KQAAAAAAAAAAAAA8AkAAAAAAAAAAAAA8VEAAAAAAAAAAAAA' +
        '9FcAAAAAAAAAAAAA+L0AAAAAAAAAAAAA/f4AAAAAAAAAAAAAA30AAAAAAAAAAAAACJIAAAAAAAAAAAAADKQ' +
        'AAAAAAAAAAAAADzcAAAAAAAAAAAAAD/0AAAAAAAAAAAAADuAAAAAAAAAAAAAADAAAAAAAAAAAAAAAB7UAAA' +
        'AAAAAAAAAAAoEAAAAAAAAAAAAA/QEAAAAAAAAAAAAA99wAAAAAAAAAAAAA860AAAAAAAAAAAAA8PMAAAAAA' +
        'AAAAAAA8AEAAAAAAAAAAAAA8PMAAAAAAAAAAAAA86wAAAAAAAAAAAAA99sAAAAAAAAAAAAA/QAAAAAAAAAA' +
        'AAAAAoAAAAAAAAAAAAAAB7QAAAAAAAAAAAAAC/8AAAAAAAAAAAAADt8AAAAAAAAAAAAAD/0AAAAAAAAAAAA' +
        'ADzcAAAAAAAAAAAAADKQAAAAAAAAAAAAACJMAAAAAAAAAAAAAA30AAAAAAAAAAAAA/f8AAAAAAAAAAAAA+L' +
        '0AAAAAAAAAAAAA9FcAAAAAAAAAAAAA8VIAAAAAAAAAAAAA8AkAAAAAAAAAAAAA8KMAAAAAAAAAAAAA8w8AA' +
        'AAAAAAAAAAA9wIAAAAAAAAAAAAA/AUAAAAAAAAAAAAAAYEAAAAAAAAAAAAABs8AAAAAAAAAAAAAC08AAAAA' +
        'AAAAAAAADnkAAAAAAAAAAAAAD+0AAAAAAAAAAAAAD38AAAAAAAAAAAAADTsAAAAAAAAAAAAACWcAAAAAAAA' +
        'AAAAABHcAAAAAAAAAAAAA/v8AAAAAAAAAAAAA+aYAAAAAAAAAAAAA9Q0AAAAAAAAAAAAA8b8AAAAAAAAAAA' +
        'AA8CEAAAAAAAAAAAAA8GMAAAAAAAAAAAAA8n4AAAAAAAAAAAAA9jIAAAAAAAAAAAAA+w4AAAAAAAAAAAAAA' +
        'IAAAAAAAAAAAAAABeMAAAAAAAAAAAAACpQAAAAAAAAAAAAADgQAAAAAAAAAAAAAD80AAAAAAAAAAAAAD7cA' +
        'AAAAAAAAAAAADcUAAAAAAAAAAAAACjMAAAAAAAAAAAAABWwAAAAAAAAAAAAAAAEAAAAAAAAAAAAA+pUAAAA' +
        'AAAAAAAAA9c4AAAAAAAAAAAAA8jsAAAAAAAAAAAAA8EoAAAAAAAAAAAAA8DMAAAAAAAAAAAAA8fsAAAAAAA' +
        'AAAAAA9WwAAAAAAAAAAAAA+hwAAAAAAAAAAAAA/38AAAAAAAAAAAAABPEAAAAAAAAAAAAACc0AAAAAAAAAA' +
        'AAADYEAAAAAAAAAAAAAD5wAAAAAAAAAAAAAD98AAAAAAAAAAAAADkEAAAAAAAAAAAAACvQAAAAAAAAAAAAA' +
        'BloAAAAAAAAAAAAAAQEAAAAAAAAAAAAA+4oAAAAAAAAAAAAA9poAAAAAAAAAAAAA8sUAAAAAAAAAAAAA8II' +
        'AAAAAAAAAAAAA8BMAAAAAAAAAAAAA8YYAAAAAAAAAAAAA9LAAAAAAAAAAAAAA+TAAAAAAAAAAAAAA/n4AAA' +
        'AAAAAAAAAAA/oAAAAAAAAAAAAACP0AAAAAAAAAAAAADPEAAAAAAAAAAAAAD1wAAAAAAAAAAAAAD/cAAAAAA' +
        'AAAAAAADq8AAAAAAAAAAAAAC6kAAAAAAAAAAAAAB0MAAAAAAAAAAAAAAgIAAAAAAAAAAAAA/IMAAAAAAAAA' +
        'AAAA924AAAAAAAAAAAAA81wAAAAAAAAAAAAA8MkAAAAAAAAAAAAA8AMAAAAAAAAAAAAA8SAAAAAAAAAAAAA' +
        'A9AAAAAAAAAAAAAAA+EsAAAAAAAAAAAAA/X8AAAAAAAAAAAAAAv8AAAAAAAAAAAAACCQAAAAAAAAAAAAADF' +
        'MAAAAAAAAAAAAADw0AAAAAAAAAAAAAD/8AAAAAAAAAAAAADw0AAAAAAAAAAAAADFQAAAAAAAAAAAAACCUAA' +
        'AAAAAAAAAAAAwAAAAAAAAAAAAAA/YAAAAAAAAAAAAAA+EwAAAAAAAAAAAAA9AEAAAAAAAAAAAAA8SEAAAAA' +
        'AAAAAAAA8AMAAAAAAAA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 6 -c:a
    // pcm_s16le -metadata "title=Core" -f caf caf-6ch.caf (2061 bytes)
    'caf-6ch.caf':
        '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' +
        'AAABPwAAAAAAAAAAAAAIbxAAAAAAAAAAAAALD0AAAAAAAAAAAAADD5AAAAAAAAAAAAAH7+AAAAAAAAAAAAA' +
        'PoDAAAAAAAAAAAAAP0IAAAAAAAAAAAAAPEMAAAAAAAAAAAAAFwPAAAAAAAAAAAAAPcPAAAAAAAAAAAAAK8O' +
        'AAAAAAAAAAAAAKkLAAAAAAAAAAAAAEMHAAAAAAAAAAAAAAICAAAAAAAAAAAAAIP8AAAAAAAAAAAAAG73AAA' +
        'AAAAAAAAAAFzzAAAAAAAAAAAAAMnwAAAAAAAAAAAAAAPwAAAAAAAAAAAAACDxAAAAAAAAAAAAAAD0AAAAAA' +
        'AAAAAAAEv4AAAAAAAAAAAAAH/9AAAAAAAAAAAAAP8CAAAAAAAAAAAAACQIAAAAAAAAAAAAAFMMAAAAAAAAA' +
        'AAAAA0PAAAAAAAAAAAAAP8PAAAAAAAAAAAAAA0PAAAAAAAAAAAAAFQMAAAAAAAAAAAAACUIAAAAAAAAAAAA' +
        'AAADAAAAAAAAAAAAAID9AAAAAAAAAAAAAEz4AAAAAAAAAAAAAAH0AAAAAAAAAAAAACHxAAAAAAAAAAAAAAP' +
        'wAAAAAAAA',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 6 -c:a
    // pcm_s16be -f au au-6ch.au (1952 bytes)
    'au-6ch.au':
        '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' +
        'AAA8SEAAAAAAAAAAAAA8AMAAAAAAAA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.15" -c:a libmp3lame
    // -b:a 8k -id3v2_version 3 -write_id3v1 1 -metadata "title=Tagged" -f mp3 mp3-id3.mp3 (767
    // bytes)
    'mp3-id3.mp3':
        'SUQzAwAAAAAANVRJVDIAAAAIAAAAVGFnZ2VkAFRTU0UAAAAPAAAATGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAA' +
        'A/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAABQAAAkAAgICAgICAgICAgICAgICAgICAgKCgoKCgoKCgoKCgoK' +
        'CgoKCgoKCgwMDAwMDAwMDAwMDAwMDAwMDAwMDg4ODg4ODg4ODg4ODg4ODg4ODg4P///////////////////' +
        '///////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQEUAAAAAAAAAJApGH35QAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAK8AbVuUEAAv9HcNtgBg+D4PvUCAIHIPg+fxO' +
        'D4PoggcRB8H34IOu/wxwG/SGOXfznT7ulJoc4WcQ3/GVEJRyhC3+D/+MYxA8QmUKQAZRQAG8H6ge5ABlxEn' +
        'APiYDmR1gd6mHvgGgCQCorCKC6//IR6KpEPh8ab//5CgNCUJA1/4lOg0oA/6JFzcZv/+MYxAcOGS6MoZU4A' +
        'PzInCgLkimAZNRgjyJaBhZSi5yIA2wAwQ2hWP/xsAwsDgqT//88nJoAHf+NA8d/+U01LADm/4A85/6q/+MY' +
        'xAkO4JK5ucYQAb+jiVa5tVX8zM+SIKASJEiaFHYinAoK6ECuhDfhBTwUK8FFdBQXgUK4FHcCjvBf8F/wVUx' +
        'BTUUzLjEw/+MYxAgAAANIAAAAADBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
        'VVVVVVVVVVVVVVVVVVVVVVVEFHVGFnZ2VkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAP8=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.15" -c:a libmp3lame
    // -b:a 8k -id3v2_version 0 -write_id3v1 1 -metadata "title=Legacy" -f mp3 mp3-id3v1.mp3 (576
    // bytes)
    'mp3-id3v1.mp3':
        '/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAABQAAAkAAgICAgICAgICAgICAgICAgICAgKCgoKCgoKCgoKCgoKC' +
        'goKCgoKCgwMDAwMDAwMDAwMDAwMDAwMDAwMDg4ODg4ODg4ODg4ODg4ODg4ODg4P////////////////////' +
        '//////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQEUAAAAAAAAAJApGH35QAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAK8AbVuUEAAv9HcNtgBg+D4PvUCAIHIPg+fxOD' +
        '4PoggcRB8H34IOu/wxwG/SGOXfznT7ulJoc4WcQ3/GVEJRyhC3+D/+MYxA8QmUKQAZRQAG8H6ge5ABlxEnA' +
        'PiYDmR1gd6mHvgGgCQCorCKC6//IR6KpEPh8ab//5CgNCUJA1/4lOg0oA/6JFzcZv/+MYxAcOGS6MoZU4AP' +
        'zInCgLkimAZNRgjyJaBhZSi5yIA2wAwQ2hWP/xsAwsDgqT//88nJoAHf+NA8d/+U01LADm/4A85/6q/+MYx' +
        'AkO4JK5ucYQAb+jiVa5tVX8zM+SIKASJEiaFHYinAoK6ECuhDfhBTwUK8FFdBQXgUK4FHcCjvBf8F/wVUxB' +
        'TUUzLjEw/+MYxAgAAANIAAAAADBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
        'VVVVVVVVVVVVVVVVVVVVV',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.1" -c:a libmp3lame -b:a
    // 8k -f matroska mkv-mp3-8k.mkv (899 bytes)
    'mkv-mp3-8k.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAADTxFNm3TAv4Rcmnp' +
        'HTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBVE27jFOrhBxTu2tTrIIDM+wBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hJc5rSwq17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJD1mAYM+B1Y7hMQ2iWBkreVRImIQG3AAAAAAAAWVK5r3r+Ei6Er0K4BAAAAAAA' +
        'AT9eBAXPFiOu1MMoDva0UnIEAIrWcg3VuZIiBAIaJQV9NUEVHL0wzVqqECDueyIOBAiPjg4QESqIA4ZGfgQ' +
        'G1iEC/QAAAAAAAYmSBEFXugQASVMNnQIa/hJ+7Dk5zc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYwLjE2L' +
        'jEwMHNz2mPAi2PFiOu1MMoDva0UZ8ilRaOHRU5DT0RFUkSHmExhdmM2MC4zMS4xMDIgbGlibXAzbGFtZWfI' +
        'oUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMjM4MDAwMDAwAB9DtnVBTb+EOMGj/OeBAKPMgQAAgP/jGMQACvA' +
        'G1blBAAL/R3DbYAYPg+D71AgCByD4Pn8Tg+D6IIHEQfB9+CDrv8McBv0hjl3850+7pSaHOFnEN/xlRCUcoQ' +
        't/g6PMgQBIgP/jGMQPEJlCkAGUUABvB+oHuQAZcRJwD4mA5kdYHeph74BoAkAqKwiguv/yEeiqRD4fGm//+' +
        'QoDQlCQNf+JToNK5Xt8lMtmpaPMgQCQgP/jGMQHDnkKoAGZQAA///T29xuWx59Yr//8+/5w9MEX0IAzIJBw' +
        'Ov/2DgyEoBITg6LWT//CVCejWSxVn/OlZ1dMQU1FMy4xMKDYocyBANgA/+MYxAgAAANIAcAAADBVVVVVVVV' +
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVm4EWdaKEAvkIOB' +
        'xTu2uXv4TL6u/uu4+zgQC3iveBAfGCAeDwgQk=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.4" -c:v libx264 -preset ultrafast -pix_fmt
    // yuv420p -x264-params "threads=1" -c:a aac -b:a 8k -f mpegts ts-av.ts (3196 bytes)
    'ts-av.ts':
        'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK///////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///0dQABAAArAXAAHBAADhAPAAG+EA8AAP4QHwAC9EuZv//////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////R0EAMAdQAACRjH4AAAAB4AAAgIAFIQAJMmEAAAABCfAAAAABZ0LACtp7ARAAAAMAEAAAAwCg8SJqAA' +
        'AAAWjOD8gAAAEGBf//T9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtI' +
        'EguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVv' +
        'bGFuLm9HAQARcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGF' +
        'uYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbW' +
        'VfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExI' +
        'GZhc3RfcEcBABJza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFk' +
        'cz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF' +
        '0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X2' +
        '1pbj01IHNjRwEAE2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgc' +
        'WNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACAAAABZYiE' +
        'OgxgAOGJbjLZgEDtVZXuAS/+AFabBmMbahAQIZEBAjAAcjLwpqiDMJQEov/w6CMgO0AbCgYubatDMmCnKJO' +
        '0lYWg//YIJRxHAQA0EAD///////////////////+eYVj+Fq9/hwEBGKcL44Opyx3q8OAgIwCoDQVi+toKlb' +
        '/vqIgbIFCkF0RH1epwlwoviHSXq9IAAXUMQQrCQFo375bANBXNRbwdLH/fBgAQABAaQwwABABAgBkADdjKN' +
        'EqUXwxxUjQEzFooFcT7BkjbiAHZTf3WgAoLHHQKtWnu4AMwCuaEmWaEcg1wk8QnSyNH9oTuRNYUCEXQ5/9g' +
        'A5SYtHwXCND/9EdAABEAALANAAHBAAAAAfAAKrEEsv/////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////R1AAEQACsBcAAcEAAOEA8AAb4QDwAA/hAfAAL0S5m///////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////9HQQA1mhAAALS0fgD//////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////8AAAHgAACAgAUhAAm/AQA' +
        'AAAEJ8AAAAAFBmiCJQEdBATABQAAAAcACv4CABSEAB9hh//FsQB7f/N4CAExhdmM2MC4zMS4xMDIAAjilUt' +
        'NG7rP2j7fElXctEiRIkSSDatp2radq2nauM7Vxnatpnp2xTtisO1bTtXGdq4zlWU5VtOVbTYsTjsTlWUhAh' +
        'AhAhElGSjKoyqUyVpTXXK6u7cwN2KUCUDAwMDAxs3LLLLLLKblllllllNyyyyyyyyyyyyyyyyyyyyyyyyyy' +
        'yyyyyyyyyyyyyyyyyyyyRwEBEcsssssssssssssssssssssssssssssssssssssssssssssssssssssssss' +
        'sssssssssssssssssssssssssssssssssssssssssssssvP/xbEAdH/wBAJzZPRVEuhlEuxdkvn2+f/4v/P' +
        '9euONauR/0/T/8P/P8eePN6l1n/T8/+n/z9dccX1WpP/T8/+n/3+utccaXSZdGKPAy6MSccujFHhpmbDFc0' +
        '0y5lzPNNMlmjZZfkP14LsFHAQESA4SjCdZzoqqMY1Bo6KI6DdA6hQboN1T0UVhStmyLe2bNhHfSLhG0S4vs' +
        'nsI7NmyK/IkcFZcyznYjzznOdSlRqUqeeeeedU6p1TqnnnnUJ1KVPPPPsnUb6N9FFL86l60odjnxtdg3xO4' +
        'fgpzqh5uadU8/NPzfJU5EhB0fLYoc//FsQBs//AD8nbYJeCrJeiaJeiX7fn/8P/P8eddXxJNf+nv//F/5/r' +
        '1x1rUtP+35/+n/n+vXHni7YkcBATMYAP//////////////////////////////GXRgjzl30c8hmkzVMztmz' +
        'Kc77TSyIoYYubjFzDiIi+Q+UXGLmVxIkfL5fL5fLjsPFPVxREW+p6NWJp0roUKrC9Tunwbi3rKyfx4okIRI' +
        'tayIoooooooooiiKKKKKIssUURIiiiiiifiIEIiQVR1HqiqiiCIQqejVa4ErHpMnJJIld5FFdFdEXIRF+7o' +
        'ov3+4otKYsUaQJIUOPBLK3qA4R0EBNAFAAAABwAC9gIAFIQAJ5mH/8WxAFT/8AQqdpLwXZH4vwH4evz/6f/' +
        'P11x1fEjf/9Pn9v19uNa1d61459/6+fri9XJIHnudLzyUpvYy5jLnnnnnng8x5jzHnnnngxjzzyXnnnsc05' +
        '69bWJzSSsVnYskSciMptIavXENjsX9HznjaGh/g/x/g/x/g/x/g/x/gf4/x/gP8f4/x/gH+P8f4iW1hkMb4' +
        '+PH4+Pj4+Pj4+Pj4+Pj4+Pj4+PhHAQE1qgD////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////4P/xbEABn/wBGIG0cA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.05" -c:a aac -b:a 32k
    // -f 3gp 3gp-esds.3gp (1140 bytes)
    '3gp-esds.3gp':
        'AAAAHGZ0eXAzZ3A0AAACADNncDRpc29taXNvMgAAAAhmcmVlAAABp21kYXTeAgBMYXZjNjAuMzEuMTAyAAJ' +
        'gpVSQ2nIy88ennjVecuWq6yRHlJIvzCQbdwPwXqvYu+4bLalpH+PS83ver8ngbUxVY2zWmvPrJSaaqmK5iq' +
        'MmlLJSyWmlJoyUKUZKMlEmtDaG0MDGzYMDIkQMbNmzaJEilNmzcUUUUUUUUUUUUUUUSIooooookREREhEUU' +
        'RFFEiKKIoooouABOJTayV2UU6sp1ZLpz/Ptxps8av/61+/XGuNXr/+14/nzxrjV6//i9/588a61qw3+tjR9' +
        'FBgLoEywhZ+p1m8pjbnAZzgMDO4TMDAzuEhIMDO4SEgwMDO7hISsGBgZ3cJCTkJsJd/hCrDdT5y5XpSt6UJ' +
        'vZm5QkqSzBpQkJJXgaUJCSV5wY3KEhJUlm4MDGwkJKscvENRRRQaiiijXuM3QbgFClaYKYXZHqyV2B2fr1x' +
        'rhev/T7fvrjjian9f288cRx3LEncIe6l76lLZUcBnOAzhIMSdwkJBgZ3CQnAPUuCJAGGLI/4qMZUMg0oNJm' +
        '0m3SU1CmqgheH3X9z75Hcu4uAEYgbRwAAACqW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAyAAEA' +
        'AAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAIAAAI1dHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAyAAAAAAAAAA' +
        'AAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAA' +
        'AAcZWxzdAAAAAAAAAABAAAAMgAABAAAAQAAAAABrW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAArEQAAAyd' +
        'VcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAVhtaW5mAAAAEHN' +
        'taGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAanN0c2' +
        'QAAAAAAAAAAQAAAFptcDRhAAAAAAAAAAEAAAAAAAAAAAABABAAAAAArEQAAAAAADZlc2RzAAAAAAOAgIAlA' +
        'AEABICAgBdAFQAAAAAAsR4AALEeBYCAgAUSCFblAAaAgIABAgAAACBzdHRzAAAAAAAAAAIAAAADAAAEAAAA' +
        'AAEAAACdAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAEAAAAAQAAACRzdHN6AAAAAAAAAAAAAAAEAAAAmQAAAKE' +
        'AAABgAAAABQAAABRzdGNvAAAAAAAAAAEAAAAsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncA' +
        'AAAAByb2xsAAAAAQAAAAQAAAAB',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 6 -c:a alac -f
    // mov mov-alac6.mov (1044 bytes)
    'mov-alac6.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAR5tZGF0AAAQAAABQAAACwwA0f7qANf/eABP/+gP+Fa' +
        'v/CY7+Lu5gv6TAoECYvO5hDYZhMWFMgN9AhwwLtEGg46iMwcayVhj6yqHJVHbxmyjBDEcAesIcLIkXBMIfH' +
        'D2PkT9A0JQ4zDD0Cap5B/lB63yN7nQoeri6mhjS6haTrOE7H0KO0hRaZjF5WJIrFouZI8TP3UkUalA2Jn/B' +
        'TaqMFFySe9kt1ICF5ACH2ovZxYlgPAf6OT9OSIOSQp0gIgABAAAAFAAAAPCAEAAAAAAAAADwgBAAAAAAAAA' +
        'P+AT7/gE+RAAgAAACgAAAHhACAAAAAAAAAB4QAgAAAAAAAAH/AJ9/wCfAgAQAAABQAAADwgBAAAAAAAAAP+' +
        'AT/AAAALabW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAABQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAA' +
        'AAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkV0c' +
        'mFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAABQAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAA' +
        'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAUAAA' +
        'AAAABAAAAAAG9bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAAKB//wAAAAAALWhkbHIAAAAAbWhscn' +
        'NvdW4AAAAAAAAAAAAAAAAMU291bmRIYW5kbGVyAAABaG1pbmYAAAAQc21oZAAAAAAAAAAAAAAALGhkbHIAA' +
        'AAAZGhscnVybCAAAAAAAAAAAAAAAAALRGF0YUhhbmRsZXIAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAM' +
        'dXJsIAAAAAEAAAEAc3RibAAAAJxzdHNkAAAAAAAAAAEAAACMYWxhYwAAAAAAAAABAAEAAAAAAAAABgAQ//4' +
        'AAB9AAAAAABAAAAAAAAAAAAAAAAACAAAAQHdhdmUAAAAMZnJtYWFsYWMAAAAkYWxhYwAAAAAAABAAABAoCg' +
        '4GAAAAAMAEAAu4AAAAH0AAAAAIAAAAAAAAABhjaGFuAAAAAAABAAAAAAA/AAAAAAAAABhzdHRzAAAAAAAAA' +
        'AEAAAABAAAAoAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAEWAAAAAQAAABRz' +
        'dGNvAAAAAAAAAAEAAAAkAAAAIXVkdGEAAAAZqXN3cgANVcRMYXZmNjAuMTYuMTAw',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=10:duration=0.5" -c:v libx264 -preset
    // superfast -pix_fmt yuv420p -bf 2 -x264-params "threads=1" -f flv flv-bframes.flv (1311 bytes)
    'flv-bframes.flv':
        'RkxWAQEAAAAJAAAAABIAALgAAAAAAAAAAgAKb25NZXRhRGF0YQgAAAAIAAhkdXJhdGlvbgA/5mZmZmZmZgA' +
        'Fd2lkdGgAQDAAAAAAAAAABmhlaWdodABAMAAAAAAAAAANdmlkZW9kYXRhcmF0ZQAAAAAAAAAAAAAJZnJhbW' +
        'VyYXRlAEAkAAAAAAAAAAx2aWRlb2NvZGVjaWQAQBwAAAAAAAAAB2VuY29kZXICAA1MYXZmNjAuMTYuMTAwA' +
        'AhmaWxlc2l6ZQBAlHwAAAAAAAAACQAAAMMJAAAvAAAAAAAAABcAAAAAAWQACv/hABdnZAAKrNlewEQAAAMA' +
        'BAAAAwBQPEiWWAEABGjvj8v9+PgAAAAAOgkAA2kAAAAAAAAAFwEAAMgAAAKpBgX//6XcRem95tlIt5Ys2CD' +
        'ZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ2' +
        '9weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uc' +
        'zogY2FiYWM9MSByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MyBtZT1kaWEgc3VibWU9MSBw' +
        'c3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWx' +
        'saXM9MCA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZn' +
        'NldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpb' +
        'WF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVz' +
        'PTIgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0' +
        'wIHdlaWdodHA9MSBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD' +
        '0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwP' +
        'TQgaXBfcmF0aW89MS40MCBwYl9yYXRpbz0xLjMwIGFxPTE6MS4wMACAAAAAs2WIhADf1NaTgqzbzk03JBbN' +
        'iLH+L0kKsJJsK8TBIdCN3OE2xXgnZhhr2zKUb6wSEGwVqUByGerAgy3LZxguDvKD5lnkKLO9eme/KAQHcFI' +
        '1EpL9mC+ScVz5RGS/k80gehu4tlfG3h7Zy/Co0jP7A8zKU+0UtlCpnSEk9rZTxNm4sKFI7pX/e6Tk5aT5c9' +
        '3Lq9RxjRdDYhVODaupluGZj1Cmnx+aXtgy+55PWm7rNwAc8/fBAAADdAkAABEAAGQAAAAAJwEAAZAAAAAIQ' +
        'ZojGIz/t4AAAAAcCQAAEQAAyAAAAAAnAQAAZAAAAAhBnkFCEP/pgQAAABwJAAARAAEsAAAAACcBAABkAAAA' +
        'CAGeYkQl/+uAAAAAHAkAABIAAZAAAAAAJwEAAMgAAAAJQZpkNExEf6uBAAAAHQkAAAUAAZAAAAAAFwIAAAA' +
        'AAAAQ',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=10:duration=0.5" -c:v libx264 -preset
    // superfast -pix_fmt yuv420p -bf 2 -x264-params "threads=1" -f matroska mkv-bframes.mkv (1568
    // bytes)
    'mkv-bframes.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAF7BFNm3TAv4SIq4e' +
        '8TbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBhE27jFOrhBxTu2tTrIIF0OwBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hLIKzpQq17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJA3PUDVJ68E/zy5/j0h28x4RImIQH9AAAAAAAAWVK5rQI2/hOeATLKuAQAAAAA' +
        'AAH7XgQFzxYjoOq6cQws/VZyBACK1nIN1bmSIgQCGj1ZfTVBFRzQvSVNPL0FWQ4OBASPjg4QF9eEA4ImwgR' +
        'C6gRCagQJV7oEA7AEAAAAAAAACAABjoqoBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAFA8SJZYAQAEaO+Py' +
        '/34+AASVMNnQIO/hDqAo/hzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYwLjE2LjEwMHNz12PAi2PFiOg6' +
        'rpxDCz9VZ8iiRaOHRU5DT0RFUkSHlUxhdmM2MC4zMS4xMDIgbGlieDI2NGfIoUWjiERVUkFUSU9ORIeTMDA' +
        '6MDA6MDAuNTAwMDAwMDAwAB9DtnVDvb+Ex6iSWOeBAKNDaIEAAIAAAAKpBgX//6XcRem95tlIt5Ys2CDZI+' +
        '7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29we' +
        'WxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczog' +
        'Y2FiYWM9MSByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MyBtZT1kaWEgc3VibWU9MSBwc3k' +
        '9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaX' +
        'M9MCA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNld' +
        'D0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0' +
        'ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTI' +
        'gYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIH' +
        'dlaWdodHA9MSBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wI' +
        'HJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQg' +
        'aXBfcmF0aW89MS40MCBwYl9yYXRpbz0xLjMwIGFxPTE6MS4wMACAAAAAs2WIhADf1NaTgqzbzk03JBbNiLH' +
        '+L0kKsJJsK8TBIdCN3OE2xXgnZhhr2zKUb6wSEGwVqUByGerAgy3LZxguDvKD5lnkKLO9eme/KAQHcFI1Ep' +
        'L9mC+ScVz5RGS/k80gehu4tlfG3h7Zy/Co0jP7A8zKU+0UtlCpnSEk9rZTxNm4sKFI7pX/e6Tk5aT5c93Lq' +
        '9RxjRdDYhVODaupluGZj1Cmnx+aXtgy+55PWm7rNwAc8/fBo5CBASwAAAAACEGaIxiM/7eAo5CBAGQAAAAA' +
        'CEGeQUIQ/+mBo5CBAMgAAAAACAGeYkQl/+uAo5GBAZAAAAAACUGaZDRMRH+rgRxTu2uXv4T+CVqNu4+zgQC' +
        '3iveBAfGCAg3wgQk=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" -c:a aac -b:a 8k
    // -write_id3v2 1 -metadata "title=Stream" -f adts adts-id3.aac (516 bytes)
    'adts-id3.aac':
        'SUQzBAAAAAAANVRJVDIAAAAIAAADU3RyZWFtAFRTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAA' +
        'A//FsQB+f/N4CAExhdmM2MC4zMS4xMDIAAjRlWtjFQMn7TffskhuRIkiJEiDsTiOFdC9H/z7ezj4FyZrLYu' +
        '7ui+Ts88ZeQdEcBxLpnnPovYVk7m6M2tt3TXfPbe5e1v5Hp4RJXl7bSVzPjGP1Wbr7hMhR7X3EPk8Kjyce8' +
        'dztfc5bWHX6eeqbdstmqv00yUW0O0t9TVz20DfUboVBMJ1M6VHmiqqmKKoTFVVMUVQmJFQKKpBEioESETFF' +
        'UCJCCKJCCJCAUSEEUSARIQCiQgiQgFEhBFEgESEAokAiQgXRSIIokC4pEFdFIi4pEC6KRBXSIFxSIK7ukF1' +
        '0iBdw//FsQBk//AE2MojMKhsEsiqdZUKlyS0kiRIiID+ZPuPhvPoP8D3LI277i2OLFXhILYmikWM7GwHq2t' +
        'cDtq0Zs2KRFwkE2Zv30P/Cfcvht3Qf4HuWRt33Hwb3hfzJ9x8Nu6D/A9yyZnfc/wb3hfzJ9x8Gd0P/A9yyN' +
        'u6D/BveF/Mn3HwbPC/mT7lkbd0H+B7k/mT7j4NnhfzJ9yyNu6D/A9yfzO+4+DZ4X8yfcZDO6D/A9yyNu+5/' +
        'g2eF/Mn3HwZ3Qf4HuWRt3QOA',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=10:duration=1" -c:v libx264 -preset superfast
    // -pix_fmt yuv420p -bf 2 -x264-params "threads=1" -bsf:v filter_units=remove_types=6 -f mp4
    // mp4-bframes.mp4 (1388 bytes)
    'mp4-bframes.mp4':
        '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' +
        'ABAAAAAExhdmY2MC4xNi4xMDA=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=10:duration=2" -c:v libx264 -preset superfast
    // -pix_fmt yuv420p -bf 2 -x264-params "threads=1" -f mp4 bf.mp4 && ffmpeg -y -i bf.mp4 -c copy
    // -bsf:v filter_units=remove_types=6 -frames:v 1 -f mp4 mp4-bframe-cut.mp4 (1042 bytes)
    'mp4-bframe-cut.mp4':
        'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAL9tZGF0AAAAs2WIhADf1NaTgqz' +
        'bzk03JBbNiLH+L0kKsJJsK8TBIdCN3OE2xXgnZhhr2zKUb6wSEGwVqUByGerAgy3LZxguDvKD5lnkKLO9em' +
        'e/KAQHcFI1EpL9mC+ScVz5RGS/k80gehu4tlfG3h7Zy/Co0jP7A8zKU+0UtlCpnSEk9rZTxNm4sKFI7pX/e' +
        '6Tk5aT5c93Lq9RxjRdDYhVODaupluGZj1Cmnx+aXtgy+55PWm7rNwAc8/fBAAADK21vb3YAAABsbXZoZAAA' +
        'AAAAAAAAAAAAAAAAA+gAAABkAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAA' +
        'AAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAJVdHJhawAAAFx0a2hkAAAAAwAAAAAAAA' +
        'AAAAAAAQAAAAAAAABkAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQ' +
        'AAAAAAQAAAAEAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAZAAACAAAAQAAAAABzW1kaWEAAAAgbWRo' +
        'ZAAAAAAAAAAAAAAAAAAAKAAAAAQAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9' +
        'IYW5kbGVyAAAAAXhtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAA' +
        'AMdXJsIAAAAAEAAAE4c3RibAAAALxzdHNkAAAAAAAAAAEAAACsYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAA' +
        'AAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjAuMzEuMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADJh' +
        'dmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwBQPEiWWAEABGjvj8v9+PgAAAAAEHBhc3AAAAABAAAAAQA' +
        'AABRidHJ0AAAAAAAAOTAAADkwAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAQAAAAAGGN0dHMAAAAAAAAAAQAAAA' +
        'EAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAALcAAAABAAAAFHN0Y28AA' +
        'AAAAAAAAQAAADAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAA' +
        'AAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.02" -ac 2 -c:a
    // pcm_s16be -f mov mov-twos-stereo.mov (1326 bytes)
    'mov-twos-stereo.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAohtZGF0AAAAAAPVA9UHNgc2Cb0JvQscCxwLLAssCeo' +
        'J6gd7B3sEKgQqAFsAW/yC/IL5EvkS9nT2dPT29Pb0x/TH9ez17PhB+EH7gvuC/0r/SgMnAycGpQalCVsJWw' +
        'r0CvQLQwtDCjwKPAgACAAE0QTRAREBEf0w/TD5pfml9tn22fUk9ST0tvS29Z71nvfB98H63vre/pX+lQJ3A' +
        'ncGDwYPCPAI8ArCCsILTgtOCoUKhQh8CHwFcwVzAcUBxf3i/eL6Pvo+90n3SfVc9Vz0sPSw9Vz1XPdI90j6' +
        'Pvo+/eH94QHFAcUFcgVyCHsIewqECoQLTgtOCsIKwgjwCPAGEAYQAncCd/6V/pX63vre98H3wfWf9Z/0tvS' +
        '29SP1I/bZ9tn5pPmk/S/9LwEQARAE0ATQB/8H/wo8CjwLQwtDCvUK9QlbCVsGpgamAygDKP9K/0r7gvuC+E' +
        'L4QvXs9ez0x/TH9Pb09vZz9nP5EfkR/IH8gQBbAFsEKgQqB3sHewnpCekLLAssCx0LHQm9Cb0HNgc2A9UD1' +
        'QABAAH8K/wr+Mr4yvZD9kP05PTk9NT01PYW9hb4hfiF+9b71v+l/6UDfgN+Bu4G7gmMCYwLCgsKCzkLOQoU' +
        'ChQHvwe/BH4EfgC2ALb82fzZ+Vv5W/al9qX1DPUM9L30vfXE9cT4APgA+y/7L/7v/u8C0ALQBlsGWwknCSc' +
        'K3ArcC0oLSgpiCmIIPwg/BSIFIgFrAWv9if2J+fH58fcQ9xD1PvU+9LL0svV79Xv3hPeE+o36jf47/jsCHg' +
        'IeBcIFwgi3CLcKpAqkC1ALUAqkCqQIuAi4BcIFwgIfAh/+O/47+o76jveF94X1fPV89LL0sgAAAoptb292A' +
        'AAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAFAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEA' +
        'AAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB9XRyYWsAAABcdGtoZAA' +
        'AAAMAAAAAAAAAAAAAAAEAAAAAAAAAFAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAA' +
        'AAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAABQAAAAAAAEAAAAAAW1tZ' +
        'GlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAAoH//AAAAAAAtaGRscgAAAABtaGxyc291bgAAAAAAAAAA' +
        'AAAAAAxTb3VuZEhhbmRsZXIAAAEYbWluZgAAABBzbWhkAAAAAAAAAAAAAAAsaGRscgAAAABkaGxydXJsIAA' +
        'AAAAAAAAAAAAAAAtEYXRhSGFuZGxlcgAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAL' +
        'BzdGJsAAAATHN0c2QAAAAAAAAAAQAAADx0d29zAAAAAAAAAAEAAAAAAAAAAAACABAAAAAAH0AAAAAAABhja' +
        'GFuAAAAAABlAAIAAAAAAAAAAAAAABhzdHRzAAAAAAAAAAEAAACgAAAAAQAAABxzdHNjAAAAAAAAAAEAAAAB' +
        'AAAAoAAAAAEAAAAUc3RzegAAAAAAAAAEAAAAoAAAABRzdGNvAAAAAAAAAAEAAAAkAAAAIXVkdGEAAAAZqXN' +
        '3cgANVcRMYXZmNjAuMTYuMTAw',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -f lavfi -i
    // "sine=frequency=440:sample_rate=11025:duration=0.4" -c:v flv1 -q:v 31 -c:a libmp3lame -b:a 8k
    // -f flv flv-sorenson-mp3.flv (1094 bytes)
    'flv-sorenson-mp3.flv':
        'RkxWAQUAAAAJAAAAABIAASUAAAAAAAAAAgAKb25NZXRhRGF0YQgAAAANAAhkdXJhdGlvbgA/4AAAAAAAAAA' +
        'Fd2lkdGgAQDAAAAAAAAAABmhlaWdodABAMAAAAAAAAAANdmlkZW9kYXRhcmF0ZQBAaGoAAAAAAAAJZnJhbW' +
        'VyYXRlAEAUAAAAAAAAAAx2aWRlb2NvZGVjaWQAQAAAAAAAAAAADWF1ZGlvZGF0YXJhdGUAQB9AAAAAAAAAD' +
        '2F1ZGlvc2FtcGxlcmF0ZQBAxYiAAAAAAAAPYXVkaW9zYW1wbGVzaXplAEAwAAAAAAAAAAZzdGVyZW8BAAAM' +
        'YXVkaW9jb2RlY2lkAEAAAAAAAAAAAAdlbmNvZGVyAgANTGF2ZjYwLjE2LjEwMAAIZmlsZXNpemUAQJEYAAA' +
        'AAAAAAAkAAAEwCAAANQAAAAAAAAAm/+MQxAAIeAbdv0EIAv/yHBgAPwAMHwfB+UBAEHHIIAg54nD4f/Lh//' +
        '////+n3dIiH3iKIQAAAEAIAAA2AAA0AAAAACb/4xLEBQloqqgBisgA8RIEvwEDqg416Qpu5b7GRQxaVRqVY' +
        '/////+NXQNfEp1V//yHEGIkLAAAAEEJAAAzAABkAAAAABIAAIQACAgfnnPMOn3x5YWMtrYbU/gpKBXqx9iE' +
        'VSw0pTqM1CQf8LvcDociaclaAkIYDwAAAD4IAAA1AABoAAAAACb/4xDEBwpgglAB1ngAkMug3sBgJB4BiXG' +
        '4Bi9l4BqOGuBiwCeF9ACQFASqsDVHU7X/3YtzAAAAQAgAADUAAJ0AAAAAJv/jEMQECGCCJAAGfmixFngqGB' +
        'MjATU4wyroCSMARAES7iw7lvxFyAAGUZX/zwtzsdZgIwQAAABACAAANQAA0QAAAAAm/+MQxAkJ+IIkAAZ+a' +
        'MDAwFtL2Mv+AjjAFwBEu4qdy34i5AAFKM///////9z/zwt2ZKzARgAAAEAIAAA2AAEFAAAAACb/4xLECAnw' +
        'giQABn5oCYVxgMqSUZpUBEGANgB5chU7lvxFyAAOUZ///////7rMA1diDAwYAQAAAEEJAAAJAAEsAAAAACI' +
        'AAIQYCAg/oAAAABQIAAA1AAE5AAAAACb/4xDECAhAgjQAAHxkhgb0vHDYCABgD1iOXG5ZTodHz///////7/' +
        '/9ZfL5KDbEJADAYBhoAAAAQAgAADUAAW0AAAAAJv/jEMQOCICCaAFVYAAQBhnJAdoAYGBgwAMHBBg4AQHxr' +
        'wi0MaDQdI5AH41OwHhPkVA6jDgAAABACAAANQABogAAAAAm/+MQxBMNKM6oKYeYAAD5AO3w38V4MVD34nQn' +
        'DQ3UXi8j/5dLoNHsoGAfHgr8EE2kSJE1sQAAAEAIAAA2AAHWAAAAACb/4xLEBQiAfigByUgAQodVQs5/4rI' +
        'kWxjQqBJgLAkTAUNAzwVgrLHiz5JMQU1FMy4xMDBVVQAAAEE=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.52" -c:a pcm_u8 -f mov
    // mov-u8-mono.mov (4846 bytes)
    'mov-u8-mono.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAEEhtZGF0gIWKjY+PjoqFgHt2cnBwcXV5foSJjY+Pjou' +
        'GgXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcH' +
        'J2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj' +
        '4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3Zy' +
        'cHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYa' +
        'Ljo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgn' +
        'x3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1e' +
        'n+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+M' +
        'iIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHB' +
        'xdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo' +
        '+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13c' +
        '3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB6dXJwcHF1en+E' +
        'iY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN' +
        '+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdH' +
        'h9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+Pj' +
        'YqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFw' +
        'cHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2' +
        'Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eX' +
        'VxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9g' +
        'oiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqF' +
        'gHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN' +
        '3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj4' +
        '6Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxc' +
        'HBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeL' +
        'jo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt' +
        '2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4' +
        'GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh' +
        '4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBx' +
        'dXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+' +
        'PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3' +
        'BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFi' +
        'o6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9' +
        'eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl' +
        '+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjY' +
        'mEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3Bwc' +
        'XR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2P' +
        'j46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHR' +
        'xcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4' +
        'iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf' +
        '3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3' +
        'fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46' +
        'KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcH' +
        'BydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj' +
        '4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1' +
        'cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIK' +
        'Hi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46Lho' +
        'F8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHByd' +
        'nuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+P' +
        'jIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnB' +
        'wcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi4' +
        '6Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d' +
        '3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/' +
        'hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIi' +
        'DfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcX' +
        'R5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj' +
        '42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3Nw' +
        'cHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hIm' +
        'Nj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfn' +
        'l0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4f' +
        'YOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42K' +
        'hYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHB' +
        'zd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4' +
        '+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1c' +
        'XBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKI' +
        'jI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB' +
        '7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3' +
        'yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi' +
        '4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXAAAAKKbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAggA' +
        'AQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAgAAAfV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAggAAAAAAA' +
        'AAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0c' +
        'wAAABxlbHN0AAAAAAAAAAEAAAIIAAAAAAABAAAAAAFtbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAA' +
        'EEB//wAAAAAALWhkbHIAAAAAbWhscnNvdW4AAAAAAAAAAAAAAAAMU291bmRIYW5kbGVyAAABGG1pbmYAAAA' +
        'Qc21oZAAAAAAAAAAAAAAALGhkbHIAAAAAZGhscnVybCAAAAAAAAAAAAAAAAALRGF0YUhhbmRsZXIAAAAkZG' +
        'luZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACwc3RibAAAAExzdHNkAAAAAAAAAAEAAAA8cmF3I' +
        'AAAAAAAAAABAAAAAAAAAAAAAQAIAAAAAB9AAAAAAAAYY2hhbgAAAAAAZAABAAAAAAAAAAAAAAAYc3R0cwAA' +
        'AAAAAAABAAAQQAAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAEEAAAAABAAAAFHN0c3oAAAAAAAAAAQAAEEA' +
        'AAAAUc3RjbwAAAAAAAAABAAAAJAAAACF1ZHRhAAAAGalzd3IADVXETGF2ZjYwLjE2LjEwMA==',
    // for o in 100 5; do ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.6" -f lavfi
    // -i "sine=frequency=440:sample_rate=8000:duration=0.6" -c:v libx264 -preset ultrafast -g 5
    // -x264-params "threads=1" -c:a aac -b:a 8k -output_ts_offset $o -f mpegts seg$o.ts; done; cat
    // seg100.ts seg5.ts > ts-splice.ts (7896 bytes)
    'ts-splice.ts':
        'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK///////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///0dQABAAArAXAAHBAADhAPAAG+EA8AAP4QHwAC9EuZv//////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////R0EAMAdQAEUlLH4AAAAB4AAAgIAFIQItgOEAAAABCfAAAAABZ0LACtp7ARAAAAMAEAAAAwCg8SJqAA' +
        'AAAWjOD8gAAAEGBf//TdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtI' +
        'EguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVv' +
        'bGFuLm9HAQARcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGF' +
        'uYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbW' +
        'VfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExI' +
        'GZhc3RfcEcBABJza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFk' +
        'cz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF' +
        '0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD01IGtleWludF9taW' +
        '49MSBzY2VuRwEAE2VjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb' +
        '21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAAWWIhDoM' +
        'YADhiW4y2YBA7VWV7gEv/gBWmwZjG2oQECGRAQIwAHIy8KaogzCUBKL/8OgjIDtAGwoGLm2rQzJgpyiTtJW' +
        'FoP/2CCUcnmFHAQA0EgD//////////////////////1j+Fq9/hwEBGKcL44Opyx3q8OAgIwCoDQVi+toKlb' +
        '/vqIgbIFCkF0RH1epwlwoviHSXq9IAAXUMQQrCQFo375bANBXNRbwdLH/fBgAQABAaQwwABABAgBkADdjKN' +
        'EqUXwxxUjQEzFooFcT7BkjbiAHZTf3WgAoLHHQKtWnu4AMwCuaEmWaEcg1wk8QnSyNH9oTuRNYUCEXQ5/9g' +
        'A5SYtHwXCND/9EdAABEAALANAAHBAAAAAfAAKrEEsv/////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////R1AAEQACsBcAAcEAAOEA8AAb4QDwAA/hAfAAL0S5m///////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////9HQQA1mhAARUhUfgD//////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////8AAAHgAACAgAUhAi8NgQA' +
        'AAAEJ8AAAAAFBmiCJQEdBATABQAAAAcACaICABSECLSbh//FsQB7f/N4CAExhdmM2MC4zMS4xMDIAAjilUt' +
        'NG7rP2j7fElXctEiRIkSSDatp2radq2nauM7Vxnatpnp2xTtisO1bTtXGdq4zlWU5VtOVbTYsTjsTlWUhAh' +
        'AhAhElGSjKoyqUyVpTXXK6u7cwN2KUCUDAwMDAxs3LLLLLLKblllllllNyyyyyyyyyyyyyyyyyyyyyyyyyy' +
        'yyyyyyyyyyyyyyyyyyyyRwEBEcsssssssssssssssssssssssssssssssssssssssssssssssssssssssss' +
        'sssssssssssssssssssssssssssssssssssssssssssssvP/xbEAdH/wBAJzZPRVEuhlEuxdkvn2+f/4v/P' +
        '9euONauR/0/T/8P/P8eePN6l1n/T8/+n/z9dccX1WpP/T8/+n/3+utccaXSZdGKPAy6MSccujFHhpmbDFc0' +
        '0y5lzPNNMlmjZZfkP14LsFHAQESA4SjCdZzoqqMY1Bo6KI6DdA6hQboN1T0UVhStmyLe2bNhHfSLhG0S4vs' +
        'nsI7NmyK/IkcFZcyznYjzznOdSlRqUqeeeeedU6p1TqnnnnUJ1KVPPPPsnUb6N9FFL86l60odjnxtdg3xO4' +
        'fgpzqh5uadU8/NPzfJU5EhB0fLYoc//FsQBBf/AES8ori5mVnPPf5/6f/brXHF6ly5darS974qooD3IP/AG' +
        'fQD/GYD30A/wA6E+4Ie/vohEcBATNvAP///////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////D4Ad9wH/gwd9yD/w2E+5A/w2B7kD5swHvoA+MwT76DCS/h4j+McQU/j4Tv4jyfY/h4kf4+E' +
        'sGMASDECARCIABMKhYNsQCUwHR0AAEgAAsA0AAcEAAAAB8AAqsQSy//////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////9HUAASAAKwFwABwQAA4QDwABvhAPAAD+EB8AAvRLmb///////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////0dBADabEABFa3x+AP//////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////8AAAHgAA' +
        'CAgAUhAi+aIQAAAAEJ8AAAAAFBmkGlR0EBNAFAAAABwAHTgIAFIQIvNOH/8WxADX/8AQIyh+Z/p/T9c+2u/' +
        '0//5f/8b1rfXd/X254+v2/n+31HhGdeKBX/u/eopv3t+8kpvU3lKaFN+/fvvv3337997BUM4S379++gIBcN' +
        'QWCoWCgARCAXCYAqEgAiEABMJhQAUACADv/xbEAWf/wBNDKL5gqqzv/x/78Xd3JJJEkSIhAUeCTXdhyj8JD' +
        'Xdhyj8JDXdmAj2hseCTbew5R3yGuqwKNHAQEVvkNdVgUd8hrqsMY75K7qsMY75K7qsEx7ZK7qsEx3yHuqwT' +
        'HtkPdv8Ex7ZD3b8Em2yHu34JNt7D3b/BJtvYct/gk11mBb/BJtvYfGPwSa7sOUfhIa7swKPwkNdVgUd8hrq' +
        'sCjvkF1WAjvkF1WGMd6K7qsEmvk4P/xbEAVv/wBQDKL5lFVVc/n8dXdy5JJIkSIhBnOaF9JN5zm0PpJvOc0' +
        'OR0szr/O7oBoQ6Ted80LiQ20+IXEhtp80EcBATZMAP/////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////7jobafELjobafTDmdmbafghzO' +
        'zN6H0w5nTttPphzOnb0PphzOnNofSWbOc2h9MObOc2jIks2c5ociSzZzm0ZEk3nOaHIkm2jmhyOk3nfNC46' +
        'TbT5oXHSbafELiQ20cQuJmbafTC46dtp9MPR0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2' +
        'aWNlMDF3fEPK///////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL//////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////0dQABAAArAXAAHBAADhAPAAG+EA8AAP4QHwAC9EuZv///' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////////R0EAMAdQAAPp9H4AAAAB4AAAgIAFIQAjlAEAAAABCfA' +
        'AAAABZ0LACtp7ARAAAAMAEAAAAwCg8SJqAAAAAWjOD8gAAAEGBf//TdxF6b3m2Ui3lizYINkj7u94MjY0IC' +
        '0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyM' +
        'DAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9HAQARcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2Fi' +
        'YWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9' +
        'yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OG' +
        'RjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcEcBABJza2lwPTEgY2hyb21hX3FwX29mZnNldD0wI' +
        'HRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0x' +
        'IGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2V' +
        'pZ2h0cD0wIGtleWludD01IGtleWludF9taW49MSBzY2VuRwEAE2VjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcm' +
        'M9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpc' +
        'F9yYXRpbz0xLjQwIGFxPTAAgAAAAWWIhDoMYADhiW4y2YBA7VWV7gEv/gBWmwZjG2oQECGRAQIwAHIy8Kao' +
        'gzCUBKL/8OgjIDtAGwoGLm2rQzJgpyiTtJWFoP/2CCUcnmFHAQA0EgD//////////////////////1j+Fq9' +
        '/hwEBGKcL44Opyx3q8OAgIwCoDQVi+toKlb/vqIgbIFCkF0RH1epwlwoviHSXq9IAAXUMQQrCQFo375bANB' +
        'XNRbwdLH/fBgAQABAaQwwABABAgBkADdjKNEqUXwxxUjQEzFooFcT7BkjbiAHZTf3WgAoLHHQKtWnu4AMwC' +
        'uaEmWaEcg1wk8QnSyNH9oTuRNYUCEXQ5/9gA5SYtHwXCND/9EdAABEAALANAAHBAAAAAfAAKrEEsv//////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////R1AAEQACsBcAAcEAAOEA8AAb4QDwAA/hA' +
        'fAAL0S5m///////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////9HQQA1mhAABA0cfgD///////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////8AAAHgAACAgAUhACUgoQAAAAEJ8AAAAAFBmiCJQEdBATABQAAAAcACaICABSEAIzoB//F' +
        'sQB7f/N4CAExhdmM2MC4zMS4xMDIAAjilUtNG7rP2j7fElXctEiRIkSSDatp2radq2nauM7Vxnatpnp2xTt' +
        'isO1bTtXGdq4zlWU5VtOVbTYsTjsTlWUhAhAhAhElGSjKoyqUyVpTXXK6u7cwN2KUCUDAwMDAxs3LLLLLLK' +
        'blllllllNyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyRwEBEcssssssssssssssssssssss' +
        'ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssvP/' +
        'xbEAdH/wBAJzZPRVEuhlEuxdkvn2+f/4v/P9euONauR/0/T/8P/P8eePN6l1n/T8/+n/z9dccX1WpP/T8/+' +
        'n/3+utccaXSZdGKPAy6MSccujFHhpmbDFc00y5lzPNNMlmjZZfkP14LsFHAQESA4SjCdZzoqqMY1Bo6KI6D' +
        'dA6hQboN1T0UVhStmyLe2bNhHfSLhG0S4vsnsI7NmyK/IkcFZcyznYjzznOdSlRqUqeeeeedU6p1TqnnnnU' +
        'J1KVPPPPsnUb6N9FFL86l60odjnxtdg3xO4fgpzqh5uadU8/NPzfJU5EhB0fLYoc//FsQBBf/AES8ori5mV' +
        'nPPf5/6f/brXHF6ly5darS974qooD3IP/AGfQD/GYD30A/wA6E+4Ie/vohEcBATNvAP////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////D4Ad9wH/gwd9yD/w2E+5A/w2B7kD5swHvoA+' +
        'MwT76DCS/h4j+McQU/j4Tv4jyfY/h4kf4+EsGMASDECARCIABMKhYNsQCUwHR0AAEgAAsA0AAcEAAAAB8AA' +
        'qsQSy//////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////////////////////////////////////////////////////9HUAASAAKwFwABwQAA4QDw' +
        'ABvhAPAAD+EB8AAvRLmb///////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////0dBADabEAAEMER+AP///' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////8AAAHgAACAgAUhACWtQQAAAAEJ8AAAAAFBmkGlR0EBNAFAAAABwAHTgI' +
        'AFIQAlSAH/8WxADX/8AQIyh+Z/p/T9c+2u/0//5f/8b1rfXd/X254+v2/n+31HhGdeKBX/u/eopv3t+8kpv' +
        'U3lKaFN+/fvvv3337997BUM4S379++gIBcNQWCoWCgARCAXCYAqEgAiEABMJhQAUACADv/xbEAWf/wBNDKL' +
        '5gqqzv/x/78Xd3JJJEkSIhAUeCTXdhyj8JDXdhyj8JDXdmAj2hseCTbew5R3yGuqwKNHAQEVvkNdVgUd8hr' +
        'qsMY75K7qsMY75K7qsEx7ZK7qsEx3yHuqwTHtkPdv8Ex7ZD3b8Em2yHu34JNt7D3b/BJtvYct/gk11mBb/B' +
        'JtvYfGPwSa7sOUfhIa7swKPwkNdVgUd8hrqsCjvkF1WAjvkF1WGMd6K7qsEmvk4P/xbEAVv/wBQDKL5lFVV' +
        'c/n8dXdy5JJIkSIhBnOaF9JN5zm0PpJvOc0OR0szr/O7oBoQ6Ted80LiQ20+IXEhtp80EcBATZMAP//////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////7jobafELjobafTDmdmbafghzOzN6H0w5nTttPphzOnb0PphzOnNofSWbOc2h9MObOc2jIks2c' +
        '5ociSzZzm0ZEk3nOaHIkm2jmhyOk3nfNC46TbT5oXHSbafELiQ20cQuJmbafTC46dtp9MP',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.6" -c:a aac -b:a 8k
    // -output_ts_offset 95443.4 -f mpegts ts-wrap.ts (2256 bytes)
    'ts-wrap.ts':
        'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK///////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///0dQABAAArASAAHBAADhAPAAD+EA8AC2m8DZ/////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////R0EAMAdQAAAstH4AAAABwAJogIAFIQAFnwH/8WxAHt/83gIATGF2YzYwLjMxLjEwMgACOKVS00bus/' +
        'aPt8SVdy0SJEiRJINq2natp2radq4ztXGdq2menbFO2Kw7VtO1cZ2rjOVZTlW05VtNixOOxOVZSECECECES' +
        'UZKMqjKpTJWlNdcrq7tzA3YpQJQMDAwMDGzcsssssspuWWWWWWU3LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL' +
        'LLLLLLJHAQARyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' +
        'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy8//FsQB0f/AEAnNk9FUS6GUS7F2S+fb5//i/8/16441' +
        'q5H/T9P/w/8/x5483qXWf9Pz/6f/P11xxfVak/9Pz/6f/f661xxpdJl0Yo8DLoxJxy6MUeGmZsMVzTTLmXM' +
        '800yWaNlkcBABJfkP14LsEDhKMJ1nOiqoxjUGjoojoN0DqFBug3VPRRWFK2bIt7Zs2Ed9IuEbRLi+yewjs2' +
        'bIr8iRwVlzLOdiPPOc51KVGpSp555551TqnVOqeeedQnUpU888+ydRvo30UUvzqXrSh2OfG12DfE7h+CnOq' +
        'Hm5p1Tz80/N8lTkSEHR8tihz/8WxAEF/8ARLyiuLmZWc89/n/p/9utccXqXLl1qtL3viqigPcg/8AZ9AP8Z' +
        'gPfQD/ADoTRwEAM2kA/////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////////////uCHv76IQP' +
        'gB33Af+DB33IP/DYT7kD/DYHuQPmzAe+gD4zBPvoMJL+HiP4xxBT+PhO/iPJ9j+HiR/j4SwYwBIMQIBEIgA' +
        'EwqFg2xAJTAdHQAARAACwDQABwQAAAAHwACqxBLL///////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////////////0dQABEAArASAAHBAADhAPAAD+EA8AC2m8DZ///////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////R0EANAdQAABwNH4AAAABwAHTgIAFIQAHrQH/8WxADX/8AQIyh+Z/p/T9c+2u/0//5f/8' +
        'b1rfXd/X254+v2/n+31HhGdeKBX/u/eopv3t+8kpvU3lKaFN+/fvvv3337997BUM4S379++gIBcNQWCoWCg' +
        'ARCAXCYAqEgAiEABMJhQAUACADv/xbEAWf/wBNDKL5gqqzv/x/78Xd3JJJEkSIhAUeCTXdhyj8JDXdhyj8J' +
        'DXdmAj2hseCTbew5RHAQAVd8hrqsCjvkNdVgUd8hrqsMY75K7qsMY75K7qsEx7ZK7qsEx3yHuqwTHtkPdv8' +
        'Ex7ZD3b8Em2yHu34JNt7D3b/BJtvYct/gk11mBb/BJtvYfGPwSa7sOUfhIa7swKPwkNdVgUd8hrqsCjvkF1' +
        'WAjvkF1WGMd6K7qsEmvk4P/xbEAVv/wBQDKL5lFVVc/n8dXdy5JJIkSIhBnOaF9JN5zm0PpJvOc0OR0szr/' +
        'O7oBoQ6Ted80LiQ20+EcBADZGAP////////////////////////////////////////////////////////' +
        '///////////////////////////////////4XEhtp80LjobafELjobafTDmdmbafghzOzN6H0w5nTttPphz' +
        'Onb0PphzOnNofSWbOc2h9MObOc2jIks2c5ociSzZzm0ZEk3nOaHIkm2jmhyOk3nfNC46TbT5oXHSbafELiQ' +
        '20cQuJmbafTC46dtp9MP',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.4" -map 0:v -map 1:a -map 1:a -c:v cinepak
    // -c:a:0 libopus -b:a:0 8k -c:a:1 pcm_s16le -f matroska mkv-cinepak-opus-pcm.mkv (8345 bytes)
    'mkv-cinepak-opus-pcm.mkv':
        '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' +
        '3wgSQ=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -c:v libx264 -preset
    // ultrafast -x264-params threads=1 -aspect 16:9 -f matroska mkv-h264-aspect.mkv (1496 bytes)
    'mkv-h264-aspect.mkv':
        'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAFpBFNm3TAv4RiyIQ' +
        'tTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBjk27jFOrhBxTu2tTrIIFiOwBAA' +
        'AAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hId+eL0q17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdB' +
        'jUxhdmY2MC4xNi4xMDBzpJDufd6FY5uJVCro1lh49y1MRImIQHkAAAAAAAAWVK5rQJe/hFLZ5QCuAQAAAAA' +
        'AAIjXgQFzxYiI1ZTMO8kIGpyBACK1nIN1bmSIgQCGj1ZfTVBFRzQvSVNPL0FWQ4OBASPjg4QL68IA4JWwgR' +
        'C6gRCagQJUsIEQVLqBCVSygQNV7oEA7AEAAAAAAAACAABjoqgBQsAK/+EAGWdCwArae/8AEAAJEAAAAwAQA' +
        'AADAKDxImoBAARozg/IElTDZ0CDv4Qfhe2Nc3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBz' +
        'c9djwItjxYiI1ZTMO8kIGmfIokWjh0VOQ09ERVJEh5VMYXZjNjAuMzEuMTAyIGxpYngyNjRnyKFFo4hEVVJ' +
        'BVElPTkSHkzAwOjAwOjAwLjQwMDAwMDAwMAAfQ7Z1Q2u/hN9x6QzngQCjQ1CBAACAAAACUwYF//9P3EXpve' +
        'bZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb' +
        '2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAt' +
        'IG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU' +
        '9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIH' +
        'RyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX' +
        '29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBk' +
        'ZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJ' +
        'hbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj01IHNjZW5lY3V0PTAgaW50cmFfcmVmcm' +
        'VzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzd' +
        'GVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAADxZYiEOgxgAOGJbjLZgEDtVZXuAS/+AFabBmMbahAQIZEB' +
        'AjAAcjLwpqiDMJQEov/w6CMgO0AbCgYubatDMmCnKJO0lYWg//YIJRyeYVj+Fq9/hwEBGKcL44Opyx3q8OA' +
        'gIwCoDQVi+toKlb/vqIgbIFCkF0RH1epwlwoviHSXq9IAAXUMQQrCQFo375bANBXNRbwdLH/fBgAQABAaQw' +
        'wABABAgBkADdjKNEqUXwxxUjQEzFooFcT7BkjbiAHZTf3WgAoLHHQKtWnu4AMwCuaEmWaEcg1wk8QnSyNH9' +
        'oTuRNYUCEXQ5/9gA5SYtHwXCND/9KONgQDIAAAAAAVBmiCJQBxTu2uXv4QFvv6yu4+zgQC3iveBAfGCAhfw' +
        'gQk=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4,format=yuva420p" -c:v libvpx
    // -auto-alt-ref 0 -f webm webm-vp8-alpha.webm (995 bytes)
    'webm-vp8-alpha.webm':
        'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAOzEU2bdLpNu4tTq4QVSal' +
        'mU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEiTbuMU6uEHFO7a1OsggOd7AEAAAAAAABZAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2' +
        'LjEwMESJiEB5AAAAAAAAFlSua8WuAQAAAAAAADzXgQFzxYjNTxNDj4OXtZyBACK1nIN1bmSIgQCGhVZfVlA' +
        '4g4EBI+ODhAvrwgDgjbCBELqBEJqBAlPAgQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMT' +
        'YuMTAwc3PWY8CLY8WIzU8TQ4+Dl7VnyKFFo4dFTkNPREVSRIeUTGF2YzYwLjMxLjEwMiBsaWJ2cHhnyKFFo' +
        '4hEVVJBVElPTkSHkzAwOjAwOjAwLjQwMDAwMDAwMAAfQ7Z1QfTngQCgQbahQYqBAAAAUAsAnQEqEAAQAABH' +
        'CIWFiIWEiAICAnWnAaUD/IPyS2QHeAf6rvAPAA/qB1gP6k/033Af4d/OHezzDU0S/kBrgf7B5guI1/jvxA+' +
        'gP+J/xj+i/jx/Wf//yoH6V+1/oGlgWbBH0P7/+OhX7/sj/z6yblRvzAxfEh/kbYs//ornzWw3p/1kbmu/e2' +
        'f/MSX+kVc/10z+KrLSQrsDZfZOCUfv2v6QcGmki03o3MxBghf/P/4j/dQOjzQM7SqLP8ubWHl//8XlmFIYh' +
        '4B9mf7HiIBNDPmYyQDkub7r///XOrN0zuiI9rYHLcMm3/sPTy6j22FSRSd+Hv/yOIkryW1Jf+AbUbecn8JK' +
        '/9+I1o6CIWbD85GP/6Ya/5cXeCyL4UVnpP4P/pgUadnXZaxHMoW66qJ/8d4tz/HHhpGb0Ik8LzP/3jf4kb/' +
        'W+qmn/0G7bzjVP/stpihKC36JTCgwym5f/l2wxIUKcOM9N9P/2IkQawpU/y4WaGa6FK6RFf7ZR/9Vr3ddsZ' +
        'KxJXQAdaGmpqTugQGlnxACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDWAA/v+6gwCgtqGVgQDIALEBAAUQrAAYA' +
        'BhYL/QAJAAAdaGYppbugQGlkbEBAAUQrAAYABhYL/QACAAA+4L/OBxTu2uRu4+zgQC3iveBAfGCAaPwgQM=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.4" -c:v mjpeg -c:a pcm_u8
    // -reserve_index_space 1 -f avi avi-mjpeg-u8.avi (6614 bytes)
    'avi-mjpeg-u8.avi':
        'UklGRs4ZAABBVkkgTElTVLwEAABoZHJsYXZpaDgAAABADQMA6IAAAAAAAAAQCQAAAgAAAAAAAAACAAAAAAA' +
        'QABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAExJU1TgAQAAc3RybHN0cmg4AAAAdmlkc01KUEcAAAAAAAAAAA' +
        'AAAAABAAAABQAAAAAAAAACAAAA3wEAAP////8AAAAAAAAAABAAEABzdHJmKAAAACgAAAAQAAAAEAAAAAEAG' +
        'ABNSlBHAAMAAAAAAAAAAAAAAAAAAAAAAABKVU5LGAEAAAQAAAAAAAAAMDBkYwAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAB2cHJwRAAAAAAAAAAAAAAABQAAABAAAAAQAAAAAQABABAAAAAQAAAAAQAAABAAAAAQAAAAEAAAABAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAATElTVHwBAABzdHJsc3RyaDgAAABhdWRzAQAAAAAAAAAAAAAAAAAAAAEAAABAHw' +
        'AAAAAAAIAMAAAABAAA/////wEAAAAAAAAAAAAAAHN0cmYQAAAAAQABAEAfAABAHwAAAQAIAEpVTksYAQAAB' +
        'AAAAAAAAAAwMXdiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEpVTksEAQAAb2RtbGRtbGj4AAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABMSVNUGgAAAElORk9J' +
        'U0ZUDgAAAExhdmY2MC4xNi4xMDAASlVOS/gDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExJU1R0EAAAbW92aTA' +
        'wZGPfAQAA/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQ' +
        'YGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABqAAEBAQAAA' +
        'AAAAAAAAAAAAAAFAwcBAQEAAAAAAAAAAAAAAAAAAAAGEAABAwQCAgMBAAAAAAAAAAADBAECERIFEwYUIQAW' +
        'FSIkEQADAQABBAIDAQAAAAAAAAAEAQMCBSEAExEHBjIxIxT/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAI' +
        'RAxEAPwDLjT5EtzSlFjHuYInUTu6wxACMMZlMY6i0Yhxr5mUkY1do1q7N7biPzvjudkBF/MpdJBftb68yV0' +
        'bhK7K2VE2I3T2zeO5i673srf49Z40UBFHLce4+0oU/SHEhabjItEjltUiFNvN+ry0YVK7VeEXo/qOOVY+HD' +
        'Y8Y6WrJtdkvjjqCOqGinlpLoo3PS7sdL9anfuWftxV9cr8sfZjSTswRMhiCB8sb/XaqhArDtonf94ZYwzfi' +
        'acZy9/lbH67oOd+vDMvlBblVIUYcwO11WarasNsFY8V1nREOrwtU0569eDeevf8A/9kAMDF3YgAEAACAhYq' +
        'Nj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfX' +
        'h0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5f' +
        'oOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42J' +
        'hH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHB' +
        'zd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4' +
        '+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0c' +
        'XBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOI' +
        'jI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB' +
        '6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3' +
        'yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi' +
        '4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBw' +
        'cnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+' +
        'Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dn' +
        'JwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBh' +
        'ouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eC' +
        'fHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV' +
        '6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PMDF3YgAEAACOi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3' +
        'd9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+Pj' +
        'oqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFw' +
        'cHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIy' +
        'Pj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAen' +
        'VycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8g' +
        'oeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouG' +
        'gXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ' +
        '2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4' +
        '+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3Zyc' +
        'HBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaL' +
        'jo+PjYmEfnl1cXBwcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx' +
        '3c3BwcXR4fYKIjI+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en' +
        '+Fio2Pj46KhYB7dnJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+Mi' +
        'IN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBx' +
        'dHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+' +
        'PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13MD' +
        'BkY98BAAD/2P/gABBKRklGAAECAAABAAEAAP/+ABBMYXZjNjAuMzEuMTAyAP/bAEMACAQEBAQEBQUFBQUFB' +
        'gYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAGoAAQEBAAAA' +
        'AAAAAAAAAAAAAAUDBwEBAQAAAAAAAAAAAAAAAAAAAAYQAAEDBAICAwEAAAAAAAAAAAMEAQIREgUTBhQhABY' +
        'VIiQRAAMBAAEEAgMBAAAAAAAAAAQBAwIFIQATEQcGMjEjFP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAh' +
        'EDEQA/AMuNPkS3NKUWMe5gidRO7rDEAIwxmUxjqLRiHGvmZSRjV2jWrs3tuI/O+O52QEX8yl0kF+1vrzJXR' +
        'uErsrZUTYjdPbN47mLrveyt/j1njRQEUctx7j7ShT9IcSFpuMi0SOW1SIU2836vLRhUrtV4Rej+o45Vj4cN' +
        'jxjpasm12S+OOoI6oaKeWkuijc9Lux0v1qd+5Z+3FX1yvyx9mNJOzBEyGIIHyxv9dqqECsO2id/3hljDN+J' +
        'pxnL3+Vsfrug5368My+UFuVUhRhzA7XVZqtqw2wVjxXWdEQ6vC1TTnr14N569/wD/2QAwMXdiAAQAAHNwcH' +
        'Bzd32Ch4uOj4+MiIN9eHRxcHBzd3yBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj' +
        '4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0' +
        'cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYO' +
        'IjI+PjoyHgn13c3BwcHN3fYKHi46Pj4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhY' +
        'B6dXJwcHF1en+EiY2Pj46KhoF7dnJwcHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd' +
        '3yCh4uOj4+MiIN+eXRxcHBydnuBhoqOj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+O' +
        'i4aBfHdzcHBxdHh9g4iMj4+OjIeCfXdzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3d8gYaLjo+PjYmEfnl1cXB' +
        'wcnZ7gIWKjo+PjYqFgHp1cnBwcXV6f4SJjY+PjoqGgXt2cnBwcXR5foOIjI+PjouHgnx3c3BwcXR4fYKIjI' +
        '+Pj4yIg314dHFwcHN3fIKHi46Pj4yIg355dHFwcHJ2e4GGio6Pj42JhH96dXFwcHJ1en+Fio2Pj46KhYB7d' +
        'nJwcHF1eX6EiY2Pj46LhoF8d3NwcHF0eH2DiIyPj46Mh4J9d3NwcHBzd32Ch4uOj4+MiIN9eHRxcHBzd3yB' +
        'houOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAenVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4e' +
        'CfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcn' +
        'V6f4WKjY+PjoqFgHt2cnBwcXV5foSJjY+PjouGgXx3c3BwcXR4fYOIjI+PjoyHgn13c3BwcHN3fYKHi46Pj' +
        '4yIg314dHFwcHN3fIGGi46Pj42JhH55dXFwcHJ2e4CFio6Pj42KhYB6dXJwcHF1en+EiY2Pj46KhoF7dnJw' +
        'cHF0eX6DiIyPj46Lh4J8d3NwcHF0eH2CiIyPj4+MiIN9eHRxcHBzd3yCh4uOj4+MiIN+eXRxcHBydnuBhoq' +
        'Oj4+NiYR/enVxcHBydXp/hYqNj4+OioWAe3ZycHBxdXl+hImNj4+Oi4aBfHdzcHBxdHh9g4iMj4+OjIeCfX' +
        'dzcHBwc3d9goeLjo+PjIiDfXh0cXBwc3cwMXdigAAAAHyBhouOj4+NiYR+eXVxcHBydnuAhYqOj4+NioWAe' +
        'nVycHBxdXp/hImNj4+OioaBe3ZycHBxdHl+g4iMj4+Oi4eCfHdzcHBxdHh9goiMj4+PjIiDfXh0cXBwc3d8' +
        'goeLjo+PjIiDfnl0cXBwcnZ7gYaKjo+PjYmEf3p1cXBwcnV6aWR4MWAAAAAwMGRjEAAAAAQAAADfAQAAMDF' +
        '3YhAAAADsAQAAAAQAADAxd2IQAAAA9AUAAAAEAAAwMGRjEAAAAPwJAADfAQAAMDF3YhAAAADkCwAAAAQAAD' +
        'Axd2IQAAAA7A8AAIAAAAA=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.4" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.4" -map 0:v -map 1:a -c:v libx264 -preset
    // ultrafast -x264-params threads=1 -c:a mp2 -b:a 32k -program program_num=1:st=0 -program
    // program_num=2:st=1 -f mpegts ts-two-programs.ts (4888 bytes)
    'ts-two-programs.ts':
        'R0AREABC8D4AAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDEAAvyAFEgSAQZGRm1wZWcJU2Vydml' +
        'jZTAyCumBR/////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/9HQAAQAACwEQABwQAAAAHwAAAC8AEggnpN////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W/////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '/////R1ABEAACsBIAAsEAAOEB8AAE4QHwAEsx+L3///////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////9HQQAwB1AAAIBVfgAAAAHgAACAgAUhAAfthQAAAAEJ8AAAAAFnQsAK2nsBEAAAAwAQAAADAKDxImo' +
        'AAAABaM4PyAAAAQYF//9P3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC' +
        '0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZ' +
        'W9sYW4ub0cBABFyZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAg' +
        'YW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCB' +
        'tZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMT' +
        'EgZmFzdF9wRwEAEnNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlY' +
        'WRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21w' +
        'YXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnR' +
        'fbWluPTUgc2NHAQATZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMC' +
        'BxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAFli' +
        'IQ6DGAA4YluMtmAQO1Vle4BL/4AVpsGYxtqEBAhkQECMAByMvCmqIMwlASi//DoIyA7QBsKBi5tq0MyYKco' +
        'k7SVhaD/9gglHEcBADQQAP///////////////////55hWP4Wr3+HAQEYpwvjg6nLHerw4CAjAKgNBWL62gq' +
        'Vv++oiBsgUKQXREfV6nCXCi+IdJer0gABdQxBCsJAWjfvlsA0Fc1FvB0sf98GABAAEBpDDAAEAECAGQAN2M' +
        'o0SpRfDHFSNATMWigVxPsGSNuIAdlN/daACgscdAq1ae7gAzAK5oSZZoRyDXCTxCdLI0f2hO5E1hQIRdDn/' +
        '2ADlJi0fBcI0P/0R0AAEQAAsBEAAcEAAAAB8AAAAvABIIJ6Tf//////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////9HUAARAAKwEgABwQAA4QDwABvhAPAAFb1NVv///////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////0dQAREAArASAALBAADhAfAABOEB8ABLMfi9//////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////R0EANZoQAACjfX4A///////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////AAAB4AAAgIAFIQAJe' +
        'iUAAAABCfAAAAABQZogiUBHQQEwB1AAAHsMfgAAAAHABaiAgAUhAAfYYf/1SMR1VE2kn36AAAAFh///+nbk' +
        'Ykqvfs5fs3m/k9rFnBnHpDnHnHpDpJfFg+++7u7utj5bFsfPny2LY+WxbFsbA7G7u7wjb5bFsfPny2LY+Wx' +
        'bFjahxU6RG8pQlj62aE5FJMwXJ9mKthDBBvZTqtj5bF1fPny6rY+WxbF1bV2w5AJugjygy8Q1XrcOOZSIFk' +
        'Jioo0LXe4tb6a1XSuUrjz4jUcBARHIVcb8tNsdswgrW+hlJUkQ8uzogVaXQwLMuLmAEtLY+hcXJiqE7E4pG' +
        '2BsotAAlpXbsmembxvKrppEM0gbDahENDBkdSqQqz1btdnz9u6MVOHGIQZtGFkCBpGOY9X5WW6t9EUDH28B' +
        'IrNHooxvbbuHleRvHzg26FhI4YWFCND/9UjEdVRNpt/+gAAAFVVVVVYmK7bZ56657Z56Z33kkk45GJwWfiw' +
        'cj68Nkk8HjeliElrokQIBZ70/RwEBEne7ZSPTFSOGJyP5zi0RByaat9uQh6v3ScZxGRXQzEYKmW2iHuOQWk' +
        'wElg1k34GBoObKsYPVZLUAALRQw4JVbrLxFlVZqbJB125I2wwViDxPLJ7qlSL+srboP03PafprPxwXQMCxi' +
        'B6iApD5u4PG83Za2UKkxcrIVot6MTUONzbaMPZbaPi1IGxYQU9x0PL+6hJPY7mKpIp7S9A66Du0vKIwOZRX' +
        'ZJJEIBN7GBxPgJuE/bVxYZGSBClHAQETUHiEmm19uQCsWKm7QVcN7oxYYC7Iyf8FTkNk0EliBL+OKBbkHXd' +
        'dyigwegVyAP/1SMR1VE2m3/6AAAAVVVVVViYrttnnrrntnnpnfesUMAItaDFxLiiHvq47pu0gDii6Wmhzy6' +
        '7tlUKcmnC8OZgcod2RSZKFURaSYhSiQoO7BdUTGS8tdiukaSSjQLmjzEwOIzSESzCjD0s20ixfRlcY/kGio' +
        'oTvZbmQa2bIhSyoWs6vGiSXLWN1yUcBARQklyATciz86FcfrFI21c8rkUB0ttCBJi13uF9hmtVkqsonEM+I' +
        'e5CsDfZNU7tmEFDhkMpKkYItXQdEAlaXQwLILFGAEtG5VhcAZhFuLGU4ju2w2lFoYc9K7dkz0zeN3Va1AbV' +
        'mkDLDahEHFkmdSqQqz1btJnyzK/FkVNi4xqjNlA8wQNIxzHq/Kg3KBG5+gYtm8GQrNAD/9UjEdVRRpt9+gA' +
        'AAFVFVVVYmK7bZ7Z56657Z56Z33pqKRwEBFUb227h5b2YWfIOWEaWEjhhYkIgSSTjkYnBZ+7scj68Nkk8Hj' +
        'EsQktdEiBALPen7vzJKR6YqRwxOTNzi0RByaat9uQh6v7uHGcRkV0MxGGMttEPccgtJgJLBrLowDA0HNlWM' +
        'Ht0tQAAtFDDglVusvE5XVZqbJB125IaGCsQeJ5ZPdUqRf1pGHQfpue0/TWecF0DAsYgeogKQ+bum0bzdlrZ' +
        'QqTIFkK0W9GJqHG5ttGHe9bR8WpA2LCBHAQEWzcdDy/uoST2O5iqSKbtL0DroO7S8vYHMorskkiEAm9jA4v' +
        'MBNwn7auLDIWBClQeISabX25AKxZu27QVcN7oxYgXZGT/gAP/1SMR1VFGm336AAAAVUVVVViYrtttntnrrn' +
        'tnnpnfeqchsmgksQKegcUC3IOu67mYMHoFcrFDACLWgxczlKIe+rjum7SBxRdLTQ55dd2yqFOXkYXhzMDlD' +
        'uyZZKFURaSYhSiQoO7CKZExkvLXYrpJElEcBATcJAP//////////aBc0eYmBxGaQiWntGHpZtpFi+hnGP5B' +
        'oqKE72W5kGt2biFLKhazq8blLlrG65JJLkAm5Fn7vCuP1ikbauebRQHS20IEmLXe4X2HJtVkqsonEM+I3IV' +
        'gb7JqndswgocM6eSVIwRaug6IFWl0MCyCxRgBLRuVYzgBmEW4sZTikbYbSi0MOelduyZ6ZXlu6rWoDas0gb' +
        'DahEHFkmdSqQqz1GKSZ8syvxZFThxjVGbIAR0AAEgAAsBEAAcEAAAAB8AAAAvABIIJ6Tf//////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////9HUAASAAKwEgABwQAA4QDwABvhAPAAFb1NVv///////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////0dQARIAArASAALBAADhAfAABOEB8ABLMfi9//////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '////////////////////////////////////////R0EBOAdQAAC6VH4AAAABwAEogIAFIQAJ1YH/9UjEdVN' +
        'NpJ98gAAABQCAIg4xJmKbzL7XO52OZw7Xwa5ya4x7ZR5zaZR7S54xYXy3xIHmCBrFix6vyoGWCWfoGDQqMg' +
        'DSaikb2U4kyvJC1JwcjSwkc5rEagSSTjkZIHT8WDkFiuEng8MdiEgNEiBALPWALe7ZSPE6mGJyZRiWh5z77' +
        '99twjbfLa4z64gb6Iw49LGec8+/JgRs23y2AY+rvYNHAQE5OQD/////////////////////////////////' +
        '/////////////////////////////////////////6D26boSB088+CVN223y2IK5Uvm+XhI6KDn9Oxjd1yp' +
        'NbWFDscBgasrOCpRVB+MLdyiBG7aGN7WD4Ylb2sXw8rZwaKm6zuItm5K0KRAjQVnUt4yC4M2PPPu7u7tt8t' +
        'i1vnz5bFrfLYtj5r777u7u7bfLYtj58+WxbHy2LY+aAA==',
    // ffmpeg -y -f lavfi -i "testsrc2=size=32x32:rate=24:duration=0.25" -f lavfi -i
    // "sine=frequency=440:sample_rate=32000:duration=0.25" -c:v mpeg1video -g 3 -bf 0 -c:a mp2 -b:a
    // 32k -f mpeg ps-mpeg1.mpg (6144 bytes)
    'ps-mpeg1.mpg':
        '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' +
        'HIuq6GOc9lqMl2g6RSzSwaUMpzIZjI5MrKlbNY5yzHYeooXs4cMEMyNh4XS6yJGuQpbXQbYhMrGQtETZpvk' +
        'AP/9GMRTaLIJJqqqoxDXLLXTDbXXoeGWbU4c+kMyrS0fR5cPHRYlw74VkRwt6QvMQ5hhnodEESE81nkeq10' +
        'RlSCXPnO2ogbaPsKVHuQU5LKL03o8EUkTpjojM2F1ttSCN0WxC0gYWJ0K5P4PXPjaKW7haCCZDV8+geqM3q' +
        'zH61UoMSog73F0Ldx4UpQzKDbEAP/9GMRTaLIJJqqqoxDXLLXTDbXXSIiTCj98/DaR2pH2+4T0iOyoxtOD0' +
        'cCNUoVEKqNvDC2iStaBsMMYSzrE60xkzjzm0wzxDwsmq4PnPoaEySj1CQrCW06DaqEci6roY5z2WoyXaDpF' +
        'LNLBpQynMhmMjkysqVs1jnLMdh6ihezhwwQzI2HhdLrIka5CltdAAP/9GMRTaKQJJoqqoxDjXjLLXTDbXVt' +
        'iEyqRC11JNN89DwyxInDxCzMq0tH0eArx12g4d8KyI4YGIXsqJhhnodEESE83dK9VrojKkEufOiMyBto+wp' +
        'Ue5BV49Rem9HgikidMuozNhdbbUgQVFt1yQMLE6FcqMHr7OKKW7haCCFrV90y9UZvVmP0gpQkziDvcAP/9G' +
        'MRTaKQJJoqqoxDXjDHLXTDbXUXQt3HhCmJ7QbY6RESYUfvvBmkdqR9vuE9ImE2Y2nB6OBGqUqus6NvDC2iS' +
        '3aBt1IwlnWJ1pglmnuoDDPEPCyazqmd4FQmSUeoSGVS27EGqhHIuq6jdM/V0ZLtB0illkg0xIHMhmMjkytq' +
        'VvEVOWY7D1FAn2GupDDjYAAAAAb4D/w////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////////////wAAAeAAZzEABQ9ZEQ' +
        'AD8g0gFwcsWdj1c91JTAb4s5zBxzKOW0QA5txxH52X15XgAAABAhKIvPD6AB9VAueFz2QYAAABAACX//iAA' +
        'AABARKHA/gMADmF1AoMIDAG4MgDECIhBgY/+AAAAQISecAAAAG+B40P////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '///////////////////////////////////////////////////////////////////////////////////' +
        '//////////////////////////////////////////////////////////',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=32000:duration=0.1" -c:a mp2 -b:a 32k
    // -f mov mov-mp2.mov (1142 bytes)
    'mov-mp2.mov':
        'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAbhtZGF0//0YxFNoNAkmj//MQat2byf1j0lwk2n1l1e' +
        '962LY+Wx81rWve9bFsfLY+a1rXO4vtpNWP5lhJQuFk5dny2Pmta2j1CQuByM0zGxjkXVdRvPZboyXaDpFLL' +
        'ZBoZA5kMxkcmVsSzWKnLMdh6ig2ToYDGZGw8LpdZUjkOVtdBtiEyrZCIkk03z0PDLJKdPoszKt//0YxFNos' +
        'gkmqqqjENcstdMNtdS0fR5cPHRYlw74VkRwt6QvMQ5hhnodEESE81nkeq10RlSCXPnO2ogbaPsKVHuQU5LK' +
        'L03o8EUkTpjojM2F1ttSCN0WxC0gYWJ0K5P4PXPjaKW7haCCZDV8+geqM3qzH61UoMSog73F0Ldx4UpQzKD' +
        'bHSIiTCj98/DaR2gA//0YxFNoMgkmgEVMP21azyb21f0kxwm2k1o1lkfb7A9mjNRjacHo4EfJRPiqNvDC2k' +
        'i3iCc2MJZ1ida4yM8+tMM8Q8LAquD59DQmSUeokVYSzoNqoRyLqyhjnstRku0HSJOaWDQynMhmMjkitj5bG' +
        'ta1uw9RRbHy2Na1rR4XIy2Plsa1rWuuUSQ61hjBRM2AAAACom1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAA' +
        'A+gAAABVAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAINdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAA' +
        'BVAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAA' +
        'AAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAVAAAAeEAAQAAAAABhW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAA' +
        'AAAAfQAAAAyAf/8AAAAAAC1oZGxyAAAAAG1obHJzb3VuAAAAAAAAAAAAAAAADFNvdW5kSGFuZGxlcgAAATB' +
        'taW5mAAAAEHNtaGQAAAAAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAAAAAAAAAAAAAAC0RhdGFIYW5kbG' +
        'VyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAAyHN0YmwAAABcc3RzZAAAAAAAAAABA' +
        'AAATC5tcDIAAAAAAAAAAQABAAAAAAAAAAEAEP/+AAB9AAAAAAAEgAAAAAAAAAAAAAAAAgAAABhjaGFuAAAA' +
        'AAABAAAAAAAEAAAAAAAAACBzdHRzAAAAAAAAAAIAAAACAAAEgAAAAAEAAAOAAAAAHHN0c2MAAAAAAAAAAQA' +
        'AAAEAAAADAAAAAQAAABRzdHN6AAAAAAAAAJAAAAADAAAAFHN0Y28AAAAAAAAAAQAAACQAAAAhdWR0YQAAAB' +
        'mpc3dyAA1VxExhdmY2MC4xNi4xMDA=',
    // ffmpeg -y -f lavfi -i "testsrc2=size=16x16:rate=5:duration=0.2" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.2" -c:v libtheora -q:v 1 -c:a libopus -b:a 8k
    // -f ogg ogg-theora-opus.ogg (3848 bytes)
    'ogg-theora-opus.ogg':
        'T2dnUwACAAAAAAAAAADxITXuAAAAAOxwv2oBKoB0aGVvcmEDAgEAAQABAAAQAAAQAAAAAAAFAAAAAQAAAQA' +
        'AAQAAAAAYwE9nZ1MAAgAAAAAAAAAALUOAAgAAAACh2/2dARNPcHVzSGVhZAEBOAFAHwAAAAAAT2dnUwAAAA' +
        'AAAAAAAADxITXuAQAAAJDYncYOP////////////////5CBdGhlb3JhDQAAAExhdmY2MC4xNi4xMDABAAAAH' +
        'wAAAGVuY29kZXI9TGF2YzYwLjMxLjEwMiBsaWJ0aGVvcmGCdGhlb3Jhvs0o97nNaxi1qUlKEHOc5jGMUpSk' +
        'IQgxjGIQhCEIQAAAAAAAAAAAABFtrlNnksj8VhL8eDlbbOYq9WirVCgTKSRaEP55OZuNZlMJeLJVKZOJJII' +
        'ZCHw8HY4Go0GAvFYqFAkEYiEIfDwcDIYCwUCIOBUW2uU2eSyPxWEvx4OVts5ir1aKtUKBMpJFoQ/nk5m41m' +
        'Uwl4slUpk4kkghkIfDwdjgajQYC8VioUCQRiIQh8PBwMhgLBQIg4FAsPDw8PDw8PDw8PDw8PDw8PDw8PDw8' +
        'PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDwwMDxIUFBUNDQ4REhUVFA4ODx' +
        'IUFRUVDhARExQVFRUQERQVFRUVFRITFBUVFRUVFBUVFRUVFRUVFRUVFRUVFRAMCxAUGRscDQ0OEhUcHBsOD' +
        'RAUGRwcHA4QExYbHR0cERMZHBweHh0UGBscHR4eHRscHR0eHh4eHR0dHR4eHh0QCwoQGCgzPQwMDhMaOjw3' +
        'Dg0QGCg5RTgOERYdM1dQPhIWJTpEbWdNGCM3QFFocVwxQE5XZ3l4ZUhcX2JwZGdjExMTExMTExMTExMTExM' +
        'TExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExISFRkaGhoaEhQWGh' +
        'oaGhoVFhkaGhoaGhkaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoREhYfJCQkJBIUG' +
        'CIkJCQkFhghJCQkJCQfIiQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkERIYL2NjY2MS' +
        'FRpCY2NjYxgaOGNjY2NjL0JjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYxUVFRUVFRU' +
        'VFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUSEhIVFx' +
        'gZGxISFRcYGRscEhUXGBkbHB0VFxgZGxwdHRcYGRscHR0dGBkbHB0dHR4ZGxwdHR0eHhscHR0dHh4eERERF' +
        'BcaHCARERQXGhwgIhEUFxocICIlFBcaHCAiJSUXGhwgIiUlJRocICIlJSUpHCAiJSUlKSogIiUlJSkqKhAQ' +
        'EBQYHCAoEBAUGBwgKDAQFBgcICgwQBQYHCAoMEBAGBwgKDBAQEAcICgwQEBAYCAoMEBAQGCAKDBAQEBggIA' +
        'HxeXHR9XtzsPy+usBpmJ3yFG8HVE3tyzEW6jjfAfuUSRL3BsZL61VI0zK7F2IQJyMHtHUyXzmG1qw2MqlK8' +
        '+3cPyTuIaZldi7EEL5FHhqtQbGS8fnLuYldHtHknCfdVSEGK5qn3VUiuxoIzlNKD2jzruSHAytZjb5w/ivC' +
        '8EvO3/Ccdph7R51JExgLq1mZTUGu+GS0hR/aBehTxscy7I0DuUHtHnXKbbXewVwUqjAi+JP+LRaxyD7hEO5' +
        'tf7iFpGwzFlaA3TkrkUPdvOpL1VJUI8zhOlazYLjeKEV2BpIHJ4oe7dd//ZMby2CkHs8C06zuOLFZjD4DKj' +
        'kaNRNLJtf/UpbnZHFh8HycE0sm0eC3gM+roFlYEWmPJlf/UpbkJrR687AbURf8D2Pl9CbmE7PpbYK1wJpZN' +
        'dMUB5k7vVUiAJNfr3L1OJpdqDc6zYRLUNwsrDT/FHkd+cKqSlAXRnWTEo1+FlYvJyaXaR524cxCHce5sH+l' +
        'tRSgIrnDF61lFlY8kX9t3ITbUfZiMw6E/+mS2GopQI4RZWbrz7UnmftqERLmw6Fpk904LmPiRz3UVUiysXy' +
        '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',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.2" -c:a libopus -b:a 8k
    // -f ogg ogg-opus.ogg (369 bytes)
    'ogg-opus.ogg':
        'T2dnUwACAAAAAAAAAAAaJ2ziAAAAAC9VKKEBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAABo' +
        'nbOIBAAAAHYBCgwE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMz' +
        'EuMTAyIGxpYm9wdXNPZ2dTAAS4JgAAAAAAABonbOICAAAAudcplwsVFBEQEBMQFBIRDgiDPqTjwiBr0RUm9' +
        'QqrkyAo+K1i6AijQOgDPDSiM0lpV16KMoPfiMO1CJ1V8ORd+9wGuKAJfIlS1TgInV+wdzKqVrnBQ8EZiGDi' +
        'CJ1fsHcyql5SjzOmT149lgidc6A96uabsRzVXYt8c5IohIAInV+u/AZGOE9NauGxXWz1CJ0ClwbZ29Tdrud' +
        'jsJ5lG+0OWxAInJAr405aeBDzFizvvqZAFaAInJAr405aeuQVRz4GTIY5wAiDPqSACbityQdzQutA',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=32000:duration=0.3" -c:a mp2 -b:a 32k
    // -reserve_index_space 1 -f avi avi-mp2.avi (3358 bytes)
    'avi-mp2.avi':
        'UklGRhYNAABBVkkgTElTVOwCAABoZHJsYXZpaDgAAAAAAAAAoA8AAAAAAAAQCQAAAAAAAAAAAAABAAAAAAA' +
        'QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExJU1SUAQAAc3RybHN0cmg4AAAAYXVkcwEAAAAAAAAAAAAAAA' +
        'AAAAAJAAAA+gAAAAAAAAAJAAAAkAAAAP////8AAAAAAAAAAAAAAABzdHJmKAAAAFAAAQAAfQAAoA8AAJAAA' +
        'AAWAAIAAH0AAAgAAAABABAAAAAAAAAAAABKVU5LGAEAAAQAAAAAAAAAMDB3YgAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AABKVU5LBAEAAG9kbWxkbWxo+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAATElTVBoAAABJTkZPSVNGVA4AAABMYXZmNjAuMTYuMTAwAEpVTkv4AwA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        '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',
    // ffmpeg -y -f lavfi -i "testsrc=size=16x16:rate=25:duration=0.2" -f lavfi -i
    // "sine=frequency=440:sample_rate=8000:duration=0.2" -c:v libx264 -preset ultrafast -c:a aac
    // -b:a 12k -
    'mp4-aac-primed.mp4':
        'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABwRtZGF03gIATGF2YzYwLjMxLjE' +
        'wMgACOKVaqKyEc6yc9sz8/fymSiSRzESJIgtq2batm2rZ/PfZfz33389997q7V7q7V7q7V/JfkfyX2X899l' +
        'zFo3R2jdHbFi0Fi0Vi0VnqYZ6mGmsJi08zFTtlYjMVs4tmnt7y2OtSZXDvfGtvuP8uY5dI1roPGt52rWcVc' +
        'bFYa1O1qw1qNrUbHPscpVKVSlUZXdujt0asdWMk0k0k0k0k0k0k0jSNIzs7PM8zs7STSTSTPM7STSTSTSNI' +
        '0k0k0k0k0k29b1vUsssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss' +
        'ssssssssssssssssssssssssssssssssssssssssssssssssssssvAAACVAYF//9Q3EXpvebZSLeWLNgg2S' +
        'Pu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvc' +
        'HlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6' +
        'IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSB' +
        'wc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MC' +
        'A4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD02I' +
        'HRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0x' +
        'IGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2V' +
        'pZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz' +
        '1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX' +
        '3JhdGlvPTEuNDAgYXE9MACAAAABbmWIhDoIQAOgACDOHKBdWweWvepWLG/AAWbNVv5kBMNAW/ctBUK4+Lg0' +
        'UaW4BEBBXq5yoREbb9XYgAgCMURCOHL08eZS3a0AigpTnwg1yng4Vf8WAIAjHDCKK5qDTD3C/KeIAAEBcAA' +
        'QBwfcHAEARgAVjsAWqqAocJ39NAjKQ08Yh9g4AgCMCACAIwB2XAfiICDRK/tucgA3rkAIC+v+AAtoAEtAEA' +
        'CZBGFJG0j/fgAXpfuChZ+OIU6GKb1YCh+xINgSDYm4BJEAwVX7SC2EZ7SXBsFwbA8GwPBsAYNCOJsAhccH2' +
        '9QY0SPBsDwbDMADaBQjuwMh/jIAjeAATAAMAAlhlIIOi6SSGCOEACxFLmyIRwP4qr9oIhMkflUD2Xz4QBAI' +
        'wIAgEYoiINh9NUx27SiEQgDhJu0lgIBGCwEAjA4CARgcBAIwBUCLhCFioAWIZHi8nqEFQOAgEYHAQCMTQDR' +
        'NJi0/aBWcBe9A4hPXoAD6nNmpcCrMVGNstiguzGLh+3P/x/7cdX1q7k8/2/T/4/9v1OL1LrX9fz/+H/v+pd' +
        '9VqX/X9P+n/P8l8aXSZdGKPAy6MSccujFHhNqQUlL6cRoooNRRRRRRRuojZZfkZy5wcfNFw9oFzG6hO4GwO' +
        'gOhD38PHv368i3BPBbxLdirY0ZozVk0wZMGZzLPLLXtmzsvfZsi3tmzYR30i4RtEuL7J7COzZsivyMo89bh' +
        '6e859ut9nL9bvcXst/Vv65Uck5Dktx1n32ejn59dy2nWc8888886p5551CdSlTzzz7J1G+jfRRS/OpetKHY' +
        '58bXYN8T7j+qk3S5XjvIiuUkRfKeefmn5vkqciQg6PlsUOAAAAAVBmiAklAAAAAVBmkBiUAAAABBBmmBC8T' +
        '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',
    // ffmpeg -y -f lavfi -i "testsrc=size=16x16:rate=25:duration=0.2" -f lavfi -i
    // "sine=frequency=440:sample_rate=48000:duration=0.2" -c:v libvpx-vp9 -b:v 20k -c:a libopus
    // -b:a 8k -
    'webm-vp9-opus.webm':
        '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' +
        '/CBIA==',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.4" -c:a wmav2 -b:a 32k
    // -metadata:s:a:0 language=jpn -packet_size 1000 -f asf -
    'wma-jpn.wma':
        'MCaydY5mzxGm2QCqAGLObGcCAAAAAAAABQAAAAECodyrjEepzxGO5ADADCBTZWgAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAFEOAAAAAAAAAIA+1d6xnQEDAAAAAAAAAMAOFgIAAAAAAAk9AAAAAAAcDAAAAAAAAAIAAADoAw' +
        'AA6AMAAAB9AAC1A79fLqnPEY7jAMAMIFNlpwAAAAAAAAAR0tOruqnPEY7mAMAMIFNlBgB5AAAAqUZDfODv/' +
        'EuyKTk+3kFchSEAAAAAAAAAAQAGagBhAAAAy6XmFHLGMkODmalpUgZbWlgAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAB9AACIEwAAAAAAAAB9AACIEwAAAAAAAAAAAAACAAAAAQAAAAAAAAAAAAAAAAAAAECk0NIH49IRl/A' +
        'AoMleqFBkAAAAAAAAAAEAKABXAE0ALwBFAG4AYwBvAGQAaQBuAGcAUwBlAHQAdABpAG4AZwBzAAAAAAAcAE' +
        'wAYQB2AGYANgAwAC4AMQA2AC4AMQAwADAAAACRB9y3t6nPEY7mAMAMIFNlcgAAAAAAAABAnmn4TVvPEaj9A' +
        'IBfXEQrUM3Dv49hzxGLsgCqALTiIAAAAAAAAAAAHAAAAAgAAAABAAAAAABhAQEAQB8AAKAPAAAAARAACgAA' +
        'AAAAAQAAAAAAAQABAAEBAABAUtGGHTHQEaOkAKDJA0j2ZAAAAAAAAABBUtGGHTHQEaOkAKDJA0j2AQAAAAI' +
        'AFwBXAGkAbgBkAG8AdwBzACAATQBlAGQAaQBhACAAQQB1AGQAaQBvACAAVgA4AAAAAAACAGEBNiaydY5mzx' +
        'Gm2QCqAGLObOoLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAQGCAAAJXagAAAAAgACDAQEAAAAAC' +
        'AABAAAcDAAAAAG6/0AABlOUZRlOU5R+WU/nlH5ZT+eUfllOA/ywF+eA/y81+fm8BVjYDrhwFXB5vPesZ0tW' +
        'P4RrgcRM98+XBI6fnEXK24NmCbfz+fA/xdbDU6fP4CUwBrTneArUAM+TwGUAD4DfwB8BSgA+AlYAPASSADp' +
        '9f5F/i7PgnEPlbfCDp+z3tj6xsEmA898org/fm7dgK3/nxZQt5Stfp/b31uf299xU8dHFSt0LSVtC0l+h8l' +
        '+h8l+h8mkUGkUGkUGkUGkUFIQUhBSEFIQUhBSEFIRVqValWpViYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiY' +
        'mJiYmJiYmJiYmJiYmJiYmHgAQIAAAAACAABAABcDAAAAAHE/0AAB6vE1Fj4UME3wH4DywBfZ8roCxiYeE5O' +
        'Tk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5' +
        'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk' +
        '5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OAQMAAAAACAABAACcDAAAAAG9/0AA' +
        'As1MEhBSh9T+/1/PZ8H4DzAB8B/wA+AqoAP5+2P4rdS/QgpAJiXgTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5' +
        'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk' +
        '5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5O' +
        'Tk5OAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAggAACV2owAAAAIAAgwEEA' +
        'AAAAAgAAQAA3AwAAAABvf9AAALNTAJQKUvqMpt9aYyrjwHqAD4D4QA8BVoAOIa2P47dQ/SgJIBiXk5OTk5O' +
        'Tk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5' +
        'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk' +
        '5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTgEFAAAAAAgAAQAAHA0AAAABxP9AAAerTFVYeFjBNnEXwHlABbs+Q8aw' +
        'mJeATk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5' +
        'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk' +
        '5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTgEGAAAAAAgAAQAAXA0AAAAB' +
        'v/9AAAZXgEhCaaOK3+EfxG8BqIAeA+sAPAT4ALp+rg41uihKQCQHgE5OTk5OTk5OTk5OTk5OTk5OTk5OTk5' +
        'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk' +
        '5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5O' +
        'Tk5OTk5OTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIIAABFdyQKAAQAAA' +
        'ACBAQcAAAAACAABAACcDQAAAAG+/0AABbqKbfb6aLdbqKbf+6aP1+n1P7/b+j9ZQ+pyn81uj8sBcT/AdY9v' +
        'orGdLfpbdLuIvm1p0/fi7BJgP+TfPW1pz3S/gPWADwGWgD4ClQBwF569bDV4Q/NxDuIeseh0tgk/VP54Dt6' +
        'P1lC0njt78LXE+L9bpD5aoNL+lYPkLGlNShFWlNRCKqU1ECUmECUmECSYAkmAJJgCSYAkmAJJYGlgaWBpYG' +
        'lgaWBpZt5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OT' +
        'k5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    // ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.6" -c:a libvorbis -q:a
    // 0 -page_duration 100000 -metadata:s:a:0 language=eng -f ogg -
    'ogg-vorbis-pages.ogg':
        'T2dnUwACAAAAAAAAAACkKH7fAAAAAJBiifQBHgF2b3JiaXMAAAAAAUAfAAAAAAAAsDYAAAAAAACZAU9nZ1M' +
        'AAAAAAAAAAAAApCh+3wEAAAB6iOUvC1D///////////+1A3ZvcmJpcw0AAABMYXZmNjAuMTYuMTAwAgAAAA' +
        'wAAABsYW5ndWFnZT1lbmcfAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYnZvcmJpcwEFdm9yYmlzEkJDV' +
        'gEAAAEADFIUISUZU0pjCJVSUikFHWNQW0cdY9Q5RiFkEFOISRmle08qlVhKyBFSWClFHVNMU0mVUpYpRR1j' +
        'FFNIIVPWMWWhcxRLhkkJJWxNrnQWS+iZY5YxRh1jzlpKnWPWMUUdY1JSSaFzGDpmJWQUOkbF6GJ8MDqVokI' +
        'ovsfeUukthYpbir3XGlPrLYQYS2nBCGFz7bXV3EpqxRhjjDHGxeJTKILQkFUAAAEAAEAEAUJDVgEACgAAwl' +
        'AMRVGA0JBVAEAGAIAAFEVxFMdxHEeSJMsCQkNWAQBAAAACAAAojuEokiNJkmRZlmVZlqZ5lqi5qi/7ri7rr' +
        'u3qug6EhqwEAMgAABiGIYfeScyQU5BJJilVzDkIofUOOeUUZNJSxphijFHOkFMMMQUxhtAphRDUTjmlDCII' +
        'Q0idZM4gSz3o4GLnOBAasiIAiAIAAIxBjCHGkHMMSgYhco5JyCBEzjkpnZRMSiittJZJCS2V1iLnnJROSia' +
        'ltBZSy6SU1kIrBQAABDgAAARYCIWGrAgAogAAEIOQUkgpxJRiTjGHlFKOKceQUsw5xZhyjDHoIFTMMcgchE' +
        'gpxRhzTjnmIGQMKuYchAwyAQAAAQ4AAAEWQqEhKwKAOAEAgyRpmqVpomhpmih6pqiqoiiqquV5pumZpqp6o' +
        'qmqpqq6rqmqrmx5nml6pqiqnimqqqmqrmuqquuKqmrLpqvatumqtuzKsm67sqzbnqrKtqm6sm6qrm27smzr' +
        'rizbuuR5quqZput6pum6quvasuq6su2ZpuuKqivbpuvKsuvKtq3Ksq5rpum6oqvarqm6su3Krm27sqz7puv' +
        'qturKuq7Ksu7btq77sq0Lu+i6tq7Krq6rsqzrsi3rtmzbQsnzVNUzTdf1TNN1Vde1bdV1bVszTdc1XVeWRd' +
        'V1ZdWVdV11ZVv3TNN1TVeVZdNVZVmVZd12ZVeXRde1bVWWfV11ZV+Xbd33ZVnXfdN1dVuVZdtXZVn3ZV33h' +
        'Vm3fd1TVVs3XVfXTdfVfVvXfWG2bd8XXVfXVdnWhVWWdd/WfWWYdZ0wuq6uq7bs66os676u68Yw67owrLpt' +
        '/K6tC8Or68ax676u3L6Patu+8Oq2Mby6bhy7sBu/7fvGsamqbZuuq+umK+u6bOu+b+u6cYyuq+uqLPu66sq' +
        '+b+u68Ou+Lwyj6+q6Ksu6sNqyr8u6Lgy7rhvDatvC7tq6cMyyLgy37yvHrwtD1baF4dV1o6vbxm8Lw9I3dr' +
        '4AAIABBwCAABPKQKEhKwKAOAEABiEIFWMQKsYghBBSCiGkVDEGIWMOSsYclBBKSSGU0irGIGSOScgckxBKa' +
        'KmU0EoopaVQSkuhlNZSai2m1FoMobQUSmmtlNJaaim21FJsFWMQMuekZI5JKKW0VkppKXNMSsagpA5CKqWk' +
        '0kpJrWXOScmgo9I5SKmk0lJJqbVQSmuhlNZKSrGl0kptrcUaSmktpNJaSam11FJtrbVaI8YgZIxByZyTUkp' +
        'JqZTSWuaclA46KpmDkkopqZWSUqyYk9JBKCWDjEpJpbWSSiuhlNZKSrGFUlprrdWYUks1lJJaSanFUEprrb' +
        'UaUys1hVBSC6W0FkpprbVWa2ottlBCa6GkFksqMbUWY22txRhKaa2kElspqcUWW42ttVhTSzWWkmJsrdXYS' +
        'i051lprSi3W0lKMrbWYW0y5xVhrDSW0FkpprZTSWkqtxdZaraGU1koqsZWSWmyt1dhajDWU0mIpKbWQSmyt' +
        'tVhbbDWmlmJssdVYUosxxlhzS7XVlFqLrbVYSys1xhhrbjXlUgAAwIADAECACWWg0JCVAEAUAABgDGOMQWg' +
        'Ucsw5KY1SzjknJXMOQggpZc5BCCGlzjkIpbTUOQehlJRCKSmlFFsoJaXWWiwAAKDAAQAgwAZNicUBCg1ZCQ' +
        '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',
};

/** Fresh copies so tests may damage the bytes freely. */
export const differentialFixtures = Object.fromEntries(
    Object.entries(encoded).map(([name, text]) => [name, () => decode(text)]),
);
