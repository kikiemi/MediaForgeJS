// Normative SBR tables of ISO/IEC 14496-3 (Huffman codes of 4.A.6.1, start offsets of 4.6.18.3.2,
// QMF window of 4.A.6.2, noise table of 4.A.6.3). The window and the noise table are kept as
// base64 of the float64 values of the standard's decimals, about half their size as decimals.

/**
 * Codeword lengths and codes of the ten SBR Huffman tables, and the offset subtracted from each
 * decoded index.
 */
interface SbrHuffmanTable {
    readonly bits: Uint8Array;
    readonly codes: Uint32Array;
    readonly lav: number;
}

const T_HUFFMAN_ENV_1_5DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
        19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 17, 18, 16, 17, 18, 17, 16, 16, 16, 16, 15, 14,
        14, 13, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 14,
        15, 16, 17, 16, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
        19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
        19, 19,
    ]),
    codes: Uint32Array.from([
        262102, 262103, 262104, 262105, 262106, 262107, 524216, 524217, 524218, 524219, 524220,
        524221, 524222, 524223, 524224, 524225, 524226, 524227, 524228, 524229, 524230, 524231,
        524232, 524233, 524234, 524235, 524236, 524237, 524238, 524239, 524240, 524241, 524242,
        524243, 131046, 262100, 65520, 131049, 262101, 131047, 65521, 65516, 65517, 65518, 32756,
        16377, 16375, 8186, 8185, 4091, 2044, 1020, 509, 253, 125, 61, 29, 13, 5, 1, 0, 4, 12, 28,
        60, 124, 252, 508, 1021, 4090, 8184, 16374, 16376, 32757, 65519, 131048, 65522, 524244,
        524245, 524246, 524247, 524248, 524249, 524250, 524251, 524252, 524253, 524254, 524255,
        524256, 524257, 524258, 524259, 524260, 524261, 524262, 524263, 524264, 524265, 524266,
        524267, 524268, 524269, 524270, 524271, 524272, 524273, 524274, 524275, 524276, 524277,
        524278, 524279, 524280, 524281, 524282, 524283, 524284, 524285, 524286, 524287,
    ]),
    lav: 60,
};

const F_HUFFMAN_ENV_1_5DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        19, 19, 20, 20, 20, 20, 20, 20, 20, 19, 20, 20, 20, 20, 19, 20, 19, 19, 20, 18, 20, 20, 20,
        19, 20, 20, 20, 19, 20, 19, 18, 19, 18, 18, 17, 18, 17, 17, 17, 16, 16, 16, 15, 15, 14, 13,
        13, 12, 12, 11, 10, 9, 9, 8, 7, 6, 5, 4, 3, 2, 2, 3, 4, 5, 6, 8, 8, 9, 10, 11, 11, 11, 12,
        12, 13, 13, 14, 14, 16, 16, 17, 17, 18, 18, 18, 18, 18, 18, 18, 20, 19, 20, 20, 20, 20, 20,
        20, 19, 20, 20, 20, 20, 19, 20, 18, 20, 20, 19, 19, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
        20, 20,
    ]),
    codes: Uint32Array.from([
        524263, 524264, 1048530, 1048531, 1048532, 1048533, 1048534, 1048535, 1048536, 524250,
        1048537, 1048538, 1048539, 1048540, 524251, 1048541, 524252, 524253, 1048542, 262116,
        1048543, 1048544, 1048545, 524254, 1048546, 1048547, 1048548, 524255, 1048549, 524256,
        262120, 524257, 262112, 262121, 131055, 262117, 131052, 131053, 131054, 65524, 65523, 65520,
        32759, 32758, 16378, 8186, 8185, 4090, 4088, 2041, 1019, 508, 506, 251, 124, 60, 28, 12, 5,
        1, 0, 4, 13, 29, 61, 250, 252, 507, 1018, 2040, 2042, 2043, 4089, 4091, 8184, 8187, 16376,
        16377, 65521, 65522, 131050, 131051, 262113, 262114, 262122, 262115, 262118, 262119, 262123,
        1048550, 524258, 1048551, 1048552, 1048553, 1048554, 1048555, 1048556, 524259, 1048557,
        1048558, 1048559, 1048560, 524260, 1048561, 262124, 1048562, 1048563, 524261, 524262,
        1048564, 1048565, 1048566, 1048567, 1048568, 1048569, 1048570, 1048571, 1048572, 1048573,
        1048574, 1048575,
    ]),
    lav: 60,
};

const T_HUFFMAN_ENV_BAL_1_5DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 12, 11, 9, 7, 5, 3,
        1, 2, 4, 6, 8, 11, 12, 15, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 17, 17, 17, 17, 17,
        17,
    ]),
    codes: Uint32Array.from([
        65508, 65509, 65510, 65511, 65512, 65513, 65514, 65515, 65516, 65517, 65518, 65519, 65520,
        65521, 65522, 65523, 65524, 65506, 4092, 2044, 510, 126, 30, 6, 0, 2, 14, 62, 254, 2045,
        4093, 32752, 65507, 65525, 65526, 65527, 65528, 65529, 65530, 131062, 131063, 131064,
        131065, 131066, 131067, 131068, 131069, 131070, 131071,
    ]),
    lav: 24,
};

const F_HUFFMAN_ENV_BAL_1_5DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 16, 17, 14, 11, 11, 8, 7, 4, 2,
        1, 3, 5, 6, 9, 11, 12, 15, 16, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19,
        19,
    ]),
    codes: Uint32Array.from([
        262114, 262115, 262116, 262117, 262118, 262119, 262120, 262121, 262122, 262123, 262124,
        262125, 262126, 262127, 262128, 65527, 131056, 16380, 2046, 2044, 254, 126, 14, 2, 0, 6, 30,
        62, 510, 2045, 4094, 32762, 65526, 262129, 262130, 262131, 262132, 262133, 262134, 262135,
        262136, 262137, 262138, 262139, 262140, 262141, 262142, 524286, 524287,
    ]),
    lav: 24,
};

const T_HUFFMAN_ENV_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 17, 16, 16, 16, 14, 14,
        14, 13, 12, 11, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13, 14, 14, 15, 16, 17, 18, 19, 19, 19, 19,
        19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
    ]),
    codes: Uint32Array.from([
        262125, 262126, 524254, 524255, 524256, 524257, 524258, 524259, 524260, 524261, 524262,
        524263, 524264, 524265, 524266, 524267, 524268, 131060, 65527, 65529, 65528, 16379, 16378,
        16376, 8186, 4092, 2044, 254, 62, 14, 2, 0, 6, 30, 126, 510, 2045, 8187, 16377, 16380,
        32762, 65526, 131061, 262124, 524269, 524270, 524271, 524272, 524273, 524274, 524275,
        524276, 524277, 524278, 524279, 524280, 524281, 524282, 524283, 524284, 524285, 524286,
        524287,
    ]),
    lav: 31,
};

const F_HUFFMAN_ENV_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        20, 20, 20, 20, 20, 20, 20, 18, 19, 19, 19, 19, 18, 18, 20, 19, 17, 18, 17, 16, 16, 15, 14,
        12, 11, 10, 9, 8, 6, 4, 2, 1, 3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18,
        18, 18, 20, 19, 19, 19, 20, 19, 19, 20, 20, 20, 20, 20, 20,
    ]),
    codes: Uint32Array.from([
        1048560, 1048561, 1048562, 1048563, 1048564, 1048565, 1048566, 262131, 524277, 524270,
        524271, 524278, 262132, 262130, 1048567, 524272, 131061, 262128, 131060, 65527, 65526,
        32760, 16379, 4093, 2045, 1021, 509, 253, 62, 14, 2, 0, 6, 30, 252, 508, 1020, 2044, 4092,
        8188, 16378, 32761, 32762, 65528, 65529, 131062, 131063, 262133, 262134, 262129, 1048568,
        524273, 524274, 524275, 1048569, 524279, 524276, 1048570, 1048571, 1048572, 1048573,
        1048574, 1048575,
    ]),
    lav: 31,
};

const T_HUFFMAN_ENV_BAL_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        13, 13, 13, 13, 13, 13, 13, 12, 8, 7, 4, 3, 1, 2, 5, 6, 9, 13, 13, 13, 13, 13, 13, 14, 14,
    ]),
    codes: Uint32Array.from([
        8178, 8179, 8180, 8181, 8182, 8183, 8184, 4088, 254, 126, 14, 6, 0, 2, 30, 62, 510, 8185,
        8186, 8187, 8188, 8189, 8190, 16382, 16383,
    ]),
    lav: 12,
};

const F_HUFFMAN_ENV_BAL_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        13, 13, 13, 13, 13, 14, 14, 11, 8, 7, 4, 2, 1, 3, 5, 6, 9, 12, 13, 14, 14, 14, 14, 14, 14,
    ]),
    codes: Uint32Array.from([
        8183, 8184, 8185, 8186, 8187, 16376, 16377, 2044, 254, 126, 14, 2, 0, 6, 30, 62, 510, 4090,
        8182, 16378, 16379, 16380, 16381, 16382, 16383,
    ]),
    lav: 12,
};

const T_HUFFMAN_NOISE_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13,
        13, 13, 13, 11, 8, 6, 4, 3, 1, 2, 5, 8, 10, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13,
        13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 14, 14,
    ]),
    codes: Uint32Array.from([
        8142, 8143, 8144, 8145, 8146, 8147, 8148, 8149, 8150, 8151, 8152, 8153, 8154, 8155, 8156,
        8157, 8158, 8159, 8160, 8161, 8162, 8163, 8164, 8165, 8166, 8167, 2034, 253, 62, 14, 6, 0,
        2, 30, 252, 1016, 8140, 8168, 8169, 8170, 8171, 8172, 8141, 8173, 8174, 8175, 8176, 8177,
        8178, 8179, 8180, 8181, 8182, 8183, 8184, 8185, 8186, 8187, 8188, 8189, 8190, 16382, 16383,
    ]),
    lav: 31,
};

const T_HUFFMAN_NOISE_BAL_3_0DB: SbrHuffmanTable = {
    bits: Uint8Array.from([
        8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 5, 2, 1, 3, 6, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    ]),
    codes: Uint32Array.from([
        236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 28, 2, 0, 6, 58, 246, 247, 248, 249, 250,
        251, 252, 253, 254, 255,
    ]),
    lav: 12,
};

/**
 * T/F envelope 1.5 dB, balance 1.5 dB, 3 dB, balance 3 dB, then the time-direction noise and noise
 * balance tables.
 */
export const SBR_HUFFMAN_TABLES: readonly SbrHuffmanTable[] = [
    T_HUFFMAN_ENV_1_5DB,
    F_HUFFMAN_ENV_1_5DB,
    T_HUFFMAN_ENV_BAL_1_5DB,
    F_HUFFMAN_ENV_BAL_1_5DB,
    T_HUFFMAN_ENV_3_0DB,
    F_HUFFMAN_ENV_3_0DB,
    T_HUFFMAN_ENV_BAL_3_0DB,
    F_HUFFMAN_ENV_BAL_3_0DB,
    T_HUFFMAN_NOISE_3_0DB,
    T_HUFFMAN_NOISE_BAL_3_0DB,
];

/**
 * Start-frequency offsets per SBR sample-rate class (16, 22.05, 24, 32, 44.1..64, above 64 kHz).
 */
export const SBR_OFFSET: readonly Int8Array[] = [
    Int8Array.from([-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7]),
    Int8Array.from([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13]),
    Int8Array.from([-5, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16]),
    Int8Array.from([-6, -4, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16]),
    Int8Array.from([-4, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16, 20]),
    Int8Array.from([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16, 20, 24]),
];

/** The little-endian float64 values of base64 `text`, unpacked once at load. */
function float64s(text: string): Float64Array {
    const bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return Float64Array.from({ length: bytes.length / 8 }, (_, index) =>
        view.getFloat64(index * 8, true),
    );
}

/**
 * 640-tap QMF prototype window (the 64-band synthesis window; analysis and downsampled synthesis
 * take every other tap).
 */
export const SBR_QMF_WINDOW: Float64Array = float64s(
    'AAAAAAAAAABWfDAi8hpCv8Zhwyt2aEK/D0d7Zkc2QL+IanQNRvM/v0WXa501CUC//sDDFnWEQL9w1pASXCBBv0cd' +
        'E+Wv6UG/xOL1seKaQr+d/gqe5DxDvwbe1WOFGES/Fw+wjE2vRL8rvybRbW5FvzEaOdiJNUa/2zdtQQy/Rr8cDQca' +
        'WHRHv4r97J74xUe/rQSO6elhSL+/8f+rkYtIv6GLltyZK0m/+qrweRJQSb9nLX786atJvwVZZyU6fkm/peNcFTCS' +
        'Sb/xN3NqVJBJvxrX+d/ca0m/HfGhUSwBSb+ST9Vmn6xIv06Zd/Lr+0e/8iksa7WkR78OCpaoL6tGv1MPGr/FykW/' +
        '++sU8bbHRL/NcA4e93tDv9g7yJjnO0K/ciZHLGvcQL/Xq+GFITA+v1k7qhN51jq/PH5WNv/xNr8Nn37dU/wyv7g4' +
        'GcLZgCu/pPOi9T71Ir8VFH282y4Qv+HN5u4ETew+4AN/rUewHD8V5XI9OscqP108Get9VDM/1nP4wmljOj88na04' +
        'Y7xAP4hzGsv3cUQ/4B9jrD5wSD8gAMcOSTVMP66L8+B7MlA/IWjrMahuUj+7O8UCjJtUPznAM+0gx1Y/YxCFA1tN' +
        'WT/Xdeue/KJbPwzm7PPRD14/K6m6F/1AYD8yvLz20ZRhP2nqJ2oR22I/yREqsV0sZD9iWt0r6HZlP5FwfiTc1GY/' +
        '6wKC4zAkaD8JHh5DeX9pP9mix5b+0Wo/aXY5OikybD9kowYre39tP9e9nDAdzm4/aMcefTIPcD+ST6rmQrhwP6Ts' +
        'B9W6T3E/Y2iyjH/pcT+Hc0a5mIRyP8spX6IKF3M/ZYMu3Beicz/wQ598cyB0P1JvTGIXpHQ/W7Lan3MOdT8s5qWz' +
        '83x1P2f32YHp5nU/Q7zgmfEydj/YFGp7K3p2Pzl7w9sMuXY/OUgF34bpdj/4RN9kKQd3P9WY0KDBH3c/E1ziCNYY' +
        'dz+WbjT/7Qt3P9WKrPlV53Y/+NVsi5Gxdj+AKLWrWW12P/IQAPtsDXY/U9eM2qWXdT/WiCZx0gt1PzfyIekRanQ/' +
        'PpuSuaS0cz9HvxM5mNtyP21dzED18HE/HCpGVYzlcD+NMfuu5IBvP0E6L+wtAG0/XTPv9CdKaj/P2yyjt01nP/tm' +
        '3zjQE2Q/xdgxic2bYD+2YP5Sk9xZPzksoqnE3FE/FoU2KHUcQz+1v6nLBvL8PnEG3zHF50G/o8SaCQf0Ur8z0JKO' +
        'TY5dvxvWuYqKVmS/bmrfpv8oar/ftWjegSNwv786ueilV3O/QBxl8oaqdr/zlnlTGyF6v3Po0/dRvn2/QAZ8TJXA' +
        'gL9mxhTRE7SCv0eiUzQvt4S/IZuO/iPMhr/XjtXycvSIv8cvlstBLos/yZNeu794jT9LkTMGutOPP+ROVyJRIpE/' +
        'tUNICb1fkj/IqHUW0qWTP3xZxaCt8ZQ/XpUTBshElj8TIq1oJJ+XP0RUPa6IAJk/R6K3gw9omj/laqq+odabP7So' +
        '7to1S50/GaKrMX/Fnj9QCc6w/yCgP8E3uRYn4qA/1zw8BASloT/1h1S7oGqiP+z4kjq/MKM/I3b/9oL4oz+/3rgd' +
        '/sCkP7ZJXSSIiaU/3rQmiARUpj8/tcyyvx2nP26HqkIB56c/Vv+6r9evqD9phz6mVXepP60hnhAtPqo/NtOv/8ID' +
        'qz8tDqNzCcarP0BGRYf8hqw/kpu4h0pErT+f9lbLtv+tP7gr55cwtq4/TMNm+61orz9J0XXiLAywP6RqEC5xYLA/' +
        'RwbrDpGysD+mD6i5/wGxP+LChEi7TrE//8U3RZyWsT/tnkRU/duxPyhQt/iDHbI/T/8q3/Jasj9eTSBY1ZOyPw1z' +
        'Sozax7I/IVbc0D34sj8GMTFNgSKzP41swMbCR7M/Qj3F/q5nsz8B1rU9y4GzP2tCL+NzlbM/laBAUTmjsz+0vQYS' +
        'TqqzPzMZThWsqrM/EIDKRfSjsz8R8Fsd1pWzP6LVpZwxgLM/k16CORRjsz+1SJG3hz2zP3pg34k7ELM/OSjOQhza' +
        'sj+JLOWD/ZqyP1upTFo9U7I/INkEoqwCsj9BNxs2yKexP/qIjTKRRLE/lJP+1j3WsD9/2IFcql6wP4yQdu5Bua8/' +
        'mWAk80mgrj86O5wvpHKtP2LLwWD9Lqw/vgI/DGfVqj9mMJZG5GSpP2KT/0Du36c/DpoA9JlCpj8DlvFy/o2kP330' +
        '+Sy3wqI/TJ8gKOzfoD/fW93dxsedP3HmX5upoZk/2/HCuIRMlT8JBsWLVMOQP34OVlngFog/EVXRR/SFfD/IVp6f' +
        'JTFgPyz3oxwcSWq/rQMSn8ONgb+5EAGJmu+Mv26vjUBRXJS/WAbC/kVxmr9AN2AKKVygv/PYrgshmaO/lGE5Wn7t' +
        'pr+x7fMrpFuqvyxbIhG+4q2/4neui73AsL++YvR5GJyyvwLMV67gg7S/W9HHdBh3tr+CLbXxLna4v/Fvn7cigbq/' +
        '18lkqjyXvL8amWTB1Li+v9QDzYSycsC/ts7pAU2Owb8Nne7iXK/Cv6VrlKDA1cO/fbnQDhgBxb9BWtC1VzHGvwhY' +
        'QUmOZse/lRdrSHSgyL940CWKO9/Jv+BbPVDzIcu/PdHjoltpzL8a7omZcLTNv1DHuOG9A8+/plCHpWIr0L/+uNS8' +
        't9bQv7awkoKzg9G/i5TudlIy0r/1XPtKdOLSvyYjX/AGlNO/cAbmfehG1L8rN0CN3PrUvymMilAVsNW/J+lRYUJm' +
        '1r8irP+YOh3XP90vLQ4R1dc/f80L0nmN2D8YO/Z3Y0bZP6gMHIez/9k/94AoOHa52j9FJKBIS3PbPwfMzuEkLdw/' +
        'NLeqOwLn3D+qX7SKqKDdP6RqbAwJWt4/JL/9vtgS3z+XyyzcF8vfPwngZvFiQeA/qmdG4aic4D8phn6CmPfgP0Nw' +
        'lrr2UeE/fNN/Faqr4T9vTxYSvgTiP4jYX7z/XOI/OgaU6I204j83Stz3KAvjP42RF9vlYOM/4E6h+Iq14z8ggJfD' +
        'NQnkP4aTN+67W+Q/aB1idxKt5D9KRGNqJf3kP3myr/3jS+U/RzVA91KZ5T+xj0N9QeXlP4VUPLO+L+Y/O0uZp714' +
        '5j+QPOttB8DmP28JkSu0Bec/HTLMpq9J5z8QfbjZ2IvnP4g2uNc/zOc/d2TMH8MK6D/UMbQoVkfoP4XK8of8geg/' +
        'mY7uHJm66D+GH9+QFPHoP2OfohiQJek/SCxg/NhX6T8UbPOt9YfpP0hQQsnZtek/XAxHk3Dh6T9tYOpozgrqP9aY' +
        '3qbJMeo/YKw/J1xW6j/8Y/zgpXjqPwSQmxdnmOo/vjdXo8+16j9x2OYYqtDqPziYqacY6eo/Pxv6Zff+6j/oPq6F' +
        'SBLrPwxMhh4TI+s/RTSq6mYx6z/XM4DPAT3rP6JNeIMURus/q9O3w5xM6z8HQdxYdlDrP6AXUYfTUes/B0HcWHZQ' +
        '6z+r07fDnEzrP6JNeIMURus/1zOAzwE96z9FNKrqZjHrPwxMhh4TI+s/6D6uhUgS6z8/G/pl9/7qPziYqacY6eo/' +
        'cdjmGKrQ6j++N1ejz7XqPwSQmxdnmOo//GP84KV46j9grD8nXFbqP9aY3qbJMeo/bWDqaM4K6j9cDEeTcOHpP0hQ' +
        'QsnZtek/FGzzrfWH6T9ILGD82FfpP2OfohiQJek/hh/fkBTx6D+Zju4cmbroP4XK8of8geg/1DG0KFZH6D93ZMwf' +
        'wwroP4g2uNc/zOc/EH242diL5z8dMsymr0nnP28JkSu0Bec/kDzrbQfA5j87S5mnvXjmP4VUPLO+L+Y/sY9DfUHl' +
        '5T9HNUD3UpnlP3myr/3jS+U/SkRjaiX95D9oHWJ3Eq3kP4aTN+67W+Q/IICXwzUJ5D/gTqH4irXjP42RF9vlYOM/' +
        'N0rc9ygL4z86BpTojbTiP4jYX7z/XOI/b08WEr4E4j98038VqqvhP0Nwlrr2UeE/KYZ+gpj34D+qZ0bhqJzgPwng' +
        'ZvFiQeA/l8ss3BfL3z8kv/2+2BLfP6RqbAwJWt4/ql+0iqig3T80t6o7AufcPwfMzuEkLdw/RSSgSEtz2z/3gCg4' +
        'drnaP6gMHIez/9k/GDv2d2NG2T9/zQvSeY3YP90vLQ4R1dc/Iqz/mDod178n6VFhQmbWvymMilAVsNW/KzdAjdz6' +
        '1L9wBuZ96EbUvyYjX/AGlNO/9Vz7SnTi0r+LlO52UjLSv7awkoKzg9G//rjUvLfW0L+mUIelYivQv1DHuOG9A8+/' +
        'Gu6JmXC0zb890eOiW2nMv+BbPVDzIcu/eNAlijvfyb+VF2tIdKDIvwhYQUmOZse/QVrQtVcxxr99udAOGAHFv6Vr' +
        'lKDA1cO/DZ3u4lyvwr+2zukBTY7Bv9QDzYSycsC/GplkwdS4vr/XyWSqPJe8v/Fvn7cigbq/gi218S52uL9b0cd0' +
        'GHe2vwLMV67gg7S/vmL0eRicsr/id66LvcCwvyxbIhG+4q2/se3zK6Rbqr+UYTlafu2mv/PYrgshmaO/QDdgCilc' +
        'oL9YBsL+RXGav26vjUBRXJS/uRABiZrvjL+tAxKfw42Bvyz3oxwcSWq/yFaenyUxYD8RVdFH9IV8P34OVlngFog/' +
        'CQbFi1TDkD/b8cK4hEyVP3HmX5upoZk/31vd3cbHnT9MnyAo7N+gP330+Sy3wqI/A5bxcv6NpD8OmgD0mUKmP2KT' +
        '/0Du36c/ZjCWRuRkqT++Aj8MZ9WqP2LLwWD9Lqw/OjucL6RyrT+ZYCTzSaCuP4yQdu5Bua8/f9iBXKpesD+Uk/7W' +
        'PdawP/qIjTKRRLE/QTcbNsinsT8g2QSirAKyP1upTFo9U7I/iSzlg/2asj85KM5CHNqyP3pg34k7ELM/tUiRt4c9' +
        'sz+TXoI5FGOzP6LVpZwxgLM/EfBbHdaVsz8QgMpF9KOzPzMZThWsqrM/tL0GEk6qsz+VoEBROaOzP2tCL+NzlbM/' +
        'Ada1PcuBsz9CPcX+rmezP41swMbCR7M/BjExTYEisz8hVtzQPfiyPw1zSozax7I/Xk0gWNWTsj9P/yrf8lqyPyhQ' +
        't/iDHbI/7Z5EVP3bsT//xTdFnJaxP+LChEi7TrE/pg+ouf8BsT9HBusOkbKwP6RqEC5xYLA/SdF14iwMsD9Mw2b7' +
        'rWivP7gr55cwtq4/n/ZWy7b/rT+Sm7iHSkStP0BGRYf8hqw/LQ6jcwnGqz8206//wgOrP60hnhAtPqo/aYc+plV3' +
        'qT9W/7qv16+oP26HqkIB56c/P7XMsr8dpz/etCaIBFSmP7ZJXSSIiaU/v964Hf7ApD8jdv/2gvijP+z4kjq/MKM/' +
        '9YdUu6Bqoj/XPDwEBKWhP8E3uRYn4qA/UAnOsP8goD8Zoqsxf8WeP7So7to1S50/5WqqvqHWmz9HoreDD2iaP0RU' +
        'Pa6IAJk/EyKtaCSflz9elRMGyESWP3xZxaCt8ZQ/yKh1FtKlkz+1Q0gJvV+SP+ROVyJRIpE/S5EzBrrTjz/Jk167' +
        'v3iNP8cvlstBLou/147V8nL0iL8hm47+I8yGv0eiUzQvt4S/ZsYU0RO0gr9ABnxMlcCAv3Po0/dRvn2/85Z5Uxsh' +
        'er9AHGXyhqp2v786ueilV3O/37Vo3oEjcL9uat+m/yhqvxvWuYqKVmS/M9CSjk2OXb+jxJoJB/RSv3EG3zHF50G/' +
        'tb+pywby/D4WhTYodRxDPzksoqnE3FE/tmD+UpPcWT/F2DGJzZtgP/tm3zjQE2Q/z9sso7dNZz9dM+/0J0pqP0E6' +
        'L+wtAG0/jTH7ruSAbz8cKkZVjOVwP21dzED18HE/R78TOZjbcj8+m5K5pLRzPzfyIekRanQ/1ogmcdILdT9T14za' +
        'pZd1P/IQAPtsDXY/gCi1q1ltdj/41WyLkbF2P9WKrPlV53Y/lm40/+0Ldz8TXOII1hh3P9WY0KDBH3c/+ETfZCkH' +
        'dz85SAXfhul2Pzl7w9sMuXY/2BRqeyt6dj9DvOCZ8TJ2P2f32YHp5nU/LOals/N8dT9bstqfcw51P1JvTGIXpHQ/' +
        '8EOffHMgdD9lgy7cF6JzP8spX6IKF3M/h3NGuZiEcj9jaLKMf+lxP6TsB9W6T3E/kk+q5kK4cD9oxx59Mg9wP9e9' +
        'nDAdzm4/ZKMGK3t/bT9pdjk6KTJsP9mix5b+0Wo/CR4eQ3l/aT/rAoLjMCRoP5FwfiTc1GY/YlrdK+h2ZT/JESqx' +
        'XSxkP2nqJ2oR22I/Mry89tGUYT8rqboX/UBgPwzm7PPRD14/13XrnvyiWz9jEIUDW01ZPznAM+0gx1Y/uzvFAoyb' +
        'VD8haOsxqG5SP66L8+B7MlA/IADHDkk1TD/gH2OsPnBIP4hzGsv3cUQ/PJ2tOGO8QD/Wc/jCaWM6P108Get9VDM/' +
        'FeVyPTrHKj/gA3+tR7AcP+HN5u4ETew+FRR9vNsuEL+k86L1PvUiv7g4GcLZgCu/DZ9+3VP8Mr88flY2//E2v1k7' +
        'qhN51jq/16vhhSEwPr9yJkcsa9xAv9g7yJjnO0K/zXAOHvd7Q7/76xTxtsdEv1MPGr/FykW/DgqWqC+rRr/yKSxr' +
        'taRHv06Zd/Lr+0e/kk/VZp+sSL8d8aFRLAFJvxrX+d/ca0m/8TdzalSQSb+l41wVMJJJvwVZZyU6fkm/Zy1+/Omr' +
        'Sb/6qvB5ElBJv6GLltyZK0m/v/H/q5GLSL+tBI7p6WFIv4r97J74xUe/HA0HGlh0R7/bN21BDL9GvzEaOdiJNUa/' +
        'K78m0W1uRb8XD7CMTa9Evwbe1WOFGES/nf4KnuQ8Q7/E4vWx4ppCv0cdE+Wv6UG/cNaQElwgQb/+wMMWdYRAv0WX' +
        'a501CUC/iGp0DUbzP78PR3tmRzZAv8Zhwyt2aEK/VnwwIvIaQr8=',
);

/** 512 complex noise values (real, imaginary interleaved) of the HF adjustment noise generator. */
export const SBR_NOISE_TABLE: Float64Array = float64s(
    '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' +
        'xflshms8o7+N9On5rRnuv+bouu3jc9o/6w7ZGrjq7z9KrOw/BIvFv3dmyIXC+da/aOhqSmPY3b+6hVg4jdCqP4JE' +
        'WrbqaNC/0pnb44N91z/q44l387zYv9V2UYE6VO0/tXibInqT078nuwi7ixTmP98oAUjNGu0/ZYeOi9m92L9q080w' +
        'K9fvPxpWGRB0uNK/4sZF5fz21z8OSB1PIELjv3iz8i/9xOs/Hrm63ocs77+GF82Ss97uP9LnH6vFTuw//1biqxZn' +
        '4j+sl+t0WJ6qPz/vWIqkOcs/PGdwZLAe4b/sH1wwBx7vPwc4kgWKot+/u4wH5Thr7z888vZQxKjvv+TREBZswtm/' +
        'xSTMn9Ni77+cLILXb1Dnv4tY9BEVf9G/7A3lxPr77z8Xl4vw2CewPwSn+Azic+G/AXb34+Ewyr9szfRRUzDCv4jR' +
        'oqYOMeU/RBaWkIo15z/CI6Yq5R/rv4QxFtviSpg/HQwhRyV+7L90x3pK82/sP/Yq3SZmsO4/np5uxvGO6D/1f2Q0' +
        'dYXnP0pGm72IL6O/3uQFGwJR1L+cMcug5pLXvzchXc631NW/j1467TS82T+uiO80MJjePzh7Nq8ZO9m/BTJojat0' +
        '7z+6NdhlHmCUP4GZMGr90NO/riP3OmEjx79Sh1uQZP/vPxd7zpwF0tC/c2PHctPO7b+DG4J00HXvv6PQDRm7+e8/' +
        'pEGLZVCl6b+H5LPJzKfQv4762nvmUei/Yyw0byPb1r/O3ylr4rPIP8QBFqa79++/iQMcZ+7i5z8iw3V0w7LrPxgD' +
        'JuM/yuE/0Zo+3JJh1T+8QpV0WpTrP5xUWqP1ru8/xeZ+XXSQpz8nX/E1mFflv0LPg9ZxU+2/LWJ4b0F85D+tz7XL' +
        'CQjEP3g9SnbR3O8/ZrNUTi1X3T+XXBhHTkzkv3vcGnM0+8o/LB51XsK6s7+YPlnmgqrsv+kebQ6AjO8/YTkEBcM8' +
        '7D/lDrDPvKHpPx/165PQlde/XaS51eoT6T+LY7rp3R/dPzF/v4i/SrY/ERQvwIXm6T+Bd2skocfrvzXZpL2pLtk/' +
        'KsZNPDJC2b/SsX5XB2Hlv348cFnyUe8/ydK1xpAw57/X3l8Rj2nuv6UP0dkEqew/Ai7w30bExT9izoTCon/hP++5' +
        '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' +
        '57AZMEVo778=',
);
