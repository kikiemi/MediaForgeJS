// SILK decoder tables of RFC 6716 section 4.2 (iCDF tables, codebooks and pitch contours); each is
// one flat typed array, two-dimensional tables list their row stride.

/** silk_gain_iCDF[3][N_LEVELS_QGAIN/8] */
export const SILK_GAIN_ICDF = new Uint8Array([
    224, 112, 44, 15, 3, 2, 1, 0, 254, 237, 192, 132, 70, 23, 4, 0, 255, 252, 226, 155, 61, 11, 2,
    0,
]);

/** silk_delta_gain_iCDF[MAX_DELTA_GAIN_QUANT-MIN_DELTA_GAIN_QUANT+1] */
export const SILK_DELTA_GAIN_ICDF = new Uint8Array([
    250, 245, 234, 203, 71, 50, 42, 38, 35, 33, 31, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18,
    17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
]);

/** silk_pitch_lag_iCDF[2*(PITCH_EST_MAX_LAG_MS-PITCH_EST_MIN_LAG_MS)] */
export const SILK_PITCH_LAG_ICDF = new Uint8Array([
    253, 250, 244, 233, 212, 182, 150, 131, 120, 110, 98, 85, 72, 60, 49, 40, 32, 25, 19, 15, 13,
    11, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
]);

/** silk_pitch_delta_iCDF[21] */
export const SILK_PITCH_DELTA_ICDF = new Uint8Array([
    210, 208, 206, 203, 199, 193, 183, 168, 142, 104, 74, 52, 37, 27, 20, 14, 10, 6, 4, 2, 0,
]);

/** silk_pitch_contour_iCDF[34] */
export const SILK_PITCH_CONTOUR_ICDF = new Uint8Array([
    223, 201, 183, 167, 152, 138, 124, 111, 98, 88, 79, 70, 62, 56, 50, 44, 39, 35, 31, 27, 24, 21,
    18, 16, 14, 12, 10, 8, 6, 4, 3, 2, 1, 0,
]);

/** silk_pitch_contour_NB_iCDF[11] */
export const SILK_PITCH_CONTOUR_NB_ICDF = new Uint8Array([
    188, 176, 155, 138, 119, 97, 67, 43, 26, 10, 0,
]);

/** silk_pitch_contour_10_ms_iCDF[12] */
export const SILK_PITCH_CONTOUR_10MS_ICDF = new Uint8Array([
    165, 119, 80, 61, 47, 35, 27, 20, 14, 9, 4, 0,
]);

/** silk_pitch_contour_10_ms_NB_iCDF[3] */
export const SILK_PITCH_CONTOUR_10MS_NB_ICDF = new Uint8Array([113, 63, 0]);

/** silk_pulses_per_block_iCDF[10][18] */
export const SILK_PULSES_PER_BLOCK_ICDF = Uint8Array.from(
    atob(
        'fTMaEg8MCwoJCAcGBQQDAgEAxmktFg8MCwoJCAcGBQQDAgEA1aJ0UzsrIBgSDwwJBwYFAwIA77t0OxwQCwoJ' +
            'CAcGBQQDAgEA+uW8h1YzHhMNCggGBQQDAgEA+evVuZyAZ1NCNSohGhURDQoA/vnrzqR2TS4bEAoHBQQDAgEA' +
            '//3579y/nHdVOSUXDwoGBAIA//379u3fy7OYfGJLNygdFQ8A//7999yiakMqHBIMCQYEAwIA',
    ),
    char => char.charCodeAt(0),
);

/** silk_rate_levels_iCDF[2][9] */
export const SILK_RATE_LEVELS_ICDF = new Uint8Array([
    241, 190, 178, 132, 87, 74, 41, 14, 0, 223, 193, 157, 140, 106, 57, 39, 18, 0,
]);

/** silk_shell_code_table0[152] */
export const SILK_SHELL_CODE_TABLE0 = Uint8Array.from(
    atob(
        'gADWKgDrgBUA9LhICwD41oAqBwD44apQGQUA++zGfjYSAwD67tOfUiMPBQD658uogFg1GQYA/O7YuZRsRygS' +
            'BAD98+HHpoBaOR8NAwD+9unUt5NtSSwXCgIA//rw38amgFo6IRAGAQD/+/Tn0rWSbksuGQwFAQD//fju3cSk' +
            'gFw8IxIIAwEA//358uXQtJJuTDAbDgcDAQA=',
    ),
    char => char.charCodeAt(0),
);

/** silk_shell_code_table1[152] */
export const SILK_SHELL_CODE_TABLE1 = Uint8Array.from(
    atob(
        'gQDPMgDsgRQA9blICgD51YEqBgD64qlXGwQA++nCgj4UBAD67M+gYy8RAwD/8Nm2g1EpCwEA//7pyZ9rPRQC' +
            'AQD/+enOqoBWMhcHAQD/+u7ZupRsRicSBgEA//zz4simgFo4Hg0EAQD//PXn0bSSbkwvGQsEAQD//fjt28Kj' +
            'gF0+JRMIAwEA//768eLNsZFvTzMeDwYCAQA=',
    ),
    char => char.charCodeAt(0),
);

/** silk_shell_code_table2[152] */
export const SILK_SHELL_CODE_TABLE2 = Uint8Array.from(
    atob(
        'gQDLNgDqgRcA9bhJCgD614EpBQD86K1WGAMA/fDIgTgPAgD99NmkXiYKAQD99eK9hEcbBwEA/fbny59pOBcG' +
            'AQD/+OvVs4VVLxMFAQD//vPdwp91RiUMAgEA//746tCrgFUwFggCAQD//vrw3L2Va0MkEAYCAQD//vvz48mm' +
            'gFo3HQ0FAgEA//789urVt5NtSSsWCgQCAQA=',
    ),
    char => char.charCodeAt(0),
);

/** silk_shell_code_table3[152] */
export const SILK_SHELL_CODE_TABLE3 = Uint8Array.from(
    atob(
        'ggDIOgDnghoA9LhMDAD51oIrBgD86K1XGAMA/fHLgzgOAgD+9t2nXiMIAQD++ejBgkEXBQEA//vv06JjLQ8E' +
            'AQD/+/PfuoNKIQsDAQD//PXmyp5pORgIAgEA//3369azhFQsEwcCAQD//vrw38SfcEUkDwYCAQD//v3159Gw' +
            'iF03GwsDAgEA//79/O/dwp51TCoSBAMCAQA=',
    ),
    char => char.charCodeAt(0),
);

/** silk_shell_code_table_offsets[17] */
export const SILK_SHELL_CODE_TABLE_OFFSETS = new Uint8Array([
    0, 0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90, 104, 119, 135,
]);

/** silk_lsb_iCDF[2] */
export const SILK_LSB_ICDF = new Uint8Array([120, 0]);

/** silk_sign_iCDF[42] */
export const SILK_SIGN_ICDF = new Uint8Array([
    254, 49, 67, 77, 82, 93, 99, 198, 11, 18, 24, 31, 36, 45, 255, 46, 66, 78, 87, 94, 104, 208, 14,
    21, 32, 42, 51, 66, 255, 94, 104, 109, 112, 115, 118, 248, 53, 69, 80, 88, 95, 102,
]);

/** silk_uniform3_iCDF[3] */
export const SILK_UNIFORM3_ICDF = new Uint8Array([171, 85, 0]);

/** silk_uniform4_iCDF[4] */
export const SILK_UNIFORM4_ICDF = new Uint8Array([192, 128, 64, 0]);

/** silk_uniform5_iCDF[5] */
export const SILK_UNIFORM5_ICDF = new Uint8Array([205, 154, 102, 51, 0]);

/** silk_uniform6_iCDF[6] */
export const SILK_UNIFORM6_ICDF = new Uint8Array([213, 171, 128, 85, 43, 0]);

/** silk_uniform8_iCDF[8] */
export const SILK_UNIFORM8_ICDF = new Uint8Array([224, 192, 160, 128, 96, 64, 32, 0]);

/** silk_NLSF_EXT_iCDF[7] */
export const SILK_NLSF_EXT_ICDF = new Uint8Array([100, 40, 16, 7, 3, 1, 0]);

/** silk_LTP_per_index_iCDF[3] */
export const SILK_LTP_PER_INDEX_ICDF = new Uint8Array([179, 99, 0]);

/** silk_LTP_gain_iCDF_0[8] */
export const SILK_LTP_GAIN_ICDF_0 = new Uint8Array([71, 56, 43, 30, 21, 12, 6, 0]);

/** silk_LTP_gain_iCDF_1[16] */
export const SILK_LTP_GAIN_ICDF_1 = new Uint8Array([
    199, 165, 144, 124, 109, 96, 84, 71, 61, 51, 42, 32, 23, 15, 8, 0,
]);

/** silk_LTP_gain_iCDF_2[32] */
export const SILK_LTP_GAIN_ICDF_2 = new Uint8Array([
    241, 225, 211, 199, 187, 175, 164, 153, 142, 132, 123, 114, 105, 96, 88, 80, 72, 64, 57, 50, 44,
    38, 33, 29, 24, 20, 16, 12, 9, 5, 2, 0,
]);

/** silk_LTP_gain_vq_0[8][5] */
export const SILK_LTP_GAIN_VQ_0 = new Int8Array([
    4, 6, 24, 7, 5, 0, 0, 2, 0, 0, 12, 28, 41, 13, -4, -9, 15, 42, 25, 14, 1, -2, 62, 41, -9, -10,
    37, 65, -4, 3, -6, 4, 66, 7, -8, 16, 14, 38, -3, 33,
]);

/** silk_LTP_gain_vq_1[16][5] */
export const SILK_LTP_GAIN_VQ_1 = Int8Array.from(
    atob(
        'DRYnFwz/JEAb+vkKNysRAQEIAQEG9Uo19/Q3TPQI/QNdG/waJzsD+AIATQsJ+BYs+gcoCRoDCfkUZfkEA/gq' +
            'GgDxIUQCF/43Lv4PA/8VECk=',
    ),
    char => char.charCodeAt(0),
);

/** silk_LTP_gain_vq_2[32][5] */
export const SILK_LTP_GAIN_VQ_2 = Int8Array.from(
    atob(
        '+hs9JwX1KlgEAf48QQb8//tJOAH3E14d9wAMYwYECO1mLvMDAg0DAgnrVEju9S5o6ggSJjAXAPBGU+sLBfV1' +
            'Fvj6F3X0AwP4XxwE9g9NPPH/BHwC/AMmVBjnAg0qDR8V/Dgu//8jT/MT+UFY9/IUBFEx4xQASwPvBfcsXPgB' +
            '/RZFH/pfKfQFJ0MQ/AEA+ng33PMsegToUQULAwcCAAkKWA==',
    ),
    char => char.charCodeAt(0),
);

/** silk_LTPscale_iCDF[3] */
export const SILK_LTP_SCALE_ICDF = new Uint8Array([128, 64, 0]);

/** silk_LTPScales_table_Q14[3] */
export const SILK_LTP_SCALES_TABLE_Q14 = new Int16Array([15565, 12288, 8192]);

/** silk_type_offset_VAD_iCDF[4] */
export const SILK_TYPE_OFFSET_VAD_ICDF = new Uint8Array([232, 158, 10, 0]);

/** silk_type_offset_no_VAD_iCDF[2] */
export const SILK_TYPE_OFFSET_NO_VAD_ICDF = new Uint8Array([230, 0]);

/** silk_stereo_pred_quant_Q13[STEREO_QUANT_TAB_SIZE] */
export const SILK_STEREO_PRED_QUANT_Q13 = new Int16Array([
    -13732, -10050, -8266, -7526, -6500, -5000, -2950, -820, 820, 2950, 5000, 6500, 7526, 8266,
    10050, 13732,
]);

/** silk_stereo_pred_joint_iCDF[25] */
export const SILK_STEREO_PRED_JOINT_ICDF = new Uint8Array([
    249, 247, 246, 245, 244, 234, 210, 202, 201, 200, 197, 174, 82, 59, 56, 55, 54, 46, 22, 12, 11,
    10, 9, 7, 0,
]);

/** silk_stereo_only_code_mid_iCDF[2] */
export const SILK_STEREO_ONLY_CODE_MID_ICDF = new Uint8Array([64, 0]);

/** silk_LBRR_flags_2_iCDF[3] */
export const SILK_LBRR_FLAGS_2_ICDF = new Uint8Array([203, 150, 0]);

/** silk_LBRR_flags_3_iCDF[7] */
export const SILK_LBRR_FLAGS_3_ICDF = new Uint8Array([215, 195, 166, 125, 110, 82, 0]);

/** silk_NLSF_interpolation_factor_iCDF[5] */
export const SILK_NLSF_INTERPOLATION_FACTOR_ICDF = new Uint8Array([243, 221, 192, 181, 0]);

/** silk_LSFCosTab_FIX_Q12[LSF_COS_TAB_SZ_FIX+1] */
export const SILK_LSF_COS_TAB_Q12 = new Int16Array([
    8192, 8190, 8182, 8170, 8152, 8130, 8104, 8072, 8034, 7994, 7946, 7896, 7840, 7778, 7714, 7644,
    7568, 7490, 7406, 7318, 7226, 7128, 7026, 6922, 6812, 6698, 6580, 6458, 6332, 6204, 6070, 5934,
    5792, 5648, 5502, 5352, 5198, 5040, 4880, 4718, 4552, 4382, 4212, 4038, 3862, 3684, 3502, 3320,
    3136, 2948, 2760, 2570, 2378, 2186, 1990, 1794, 1598, 1400, 1202, 1002, 802, 602, 402, 202, 0,
    -202, -402, -602, -802, -1002, -1202, -1400, -1598, -1794, -1990, -2186, -2378, -2570, -2760,
    -2948, -3136, -3320, -3502, -3684, -3862, -4038, -4212, -4382, -4552, -4718, -4880, -5040,
    -5198, -5352, -5502, -5648, -5792, -5934, -6070, -6204, -6332, -6458, -6580, -6698, -6812,
    -6922, -7026, -7128, -7226, -7318, -7406, -7490, -7568, -7644, -7714, -7778, -7840, -7896,
    -7946, -7994, -8034, -8072, -8104, -8130, -8152, -8170, -8182, -8190, -8192,
]);

/** silk_CB_lags_stage2[PE_MAX_NB_SUBFR][PE_NB_CBKS_STAGE2_EXT] */
export const SILK_CB_LAGS_STAGE2 = new Int8Array([
    0, 2, -1, -1, -1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
    0, 0, 0, -1, 2, 1, 0, 1, 1, 0, 0, -1, -1,
]);

/** silk_CB_lags_stage3[PE_MAX_NB_SUBFR][PE_NB_CBKS_STAGE3_MAX] */
export const SILK_CB_LAGS_STAGE3 = Int8Array.from(
    atob(
        'AAAB/wAB/wD/Af4C/v4C/QID/fwD/AQE+wX6+wb5BgUI9wAAAQAAAAAAAAD/AQAAAf8AAf//Af8CAf8C/v4C' +
            '/gICA/0AAQAAAAAAAAEAAQAAAf8BAAACAf8C//8C/wIC/wP+/v4DAAEAAAEAAf8C/wL/AgP+A/7+BAT9Bf38' +
            'BvwGBfsI+vv5CQ==',
    ),
    char => char.charCodeAt(0),
);

/** silk_CB_lags_stage2_10_ms[PE_MAX_NB_SUBFR>>1][PE_NB_CBKS_STAGE2_10MS] */
export const SILK_CB_LAGS_STAGE2_10MS = new Int8Array([0, 1, 0, 0, 0, 1]);

/** silk_CB_lags_stage3_10_ms[PE_MAX_NB_SUBFR>>1][PE_NB_CBKS_STAGE3_10MS] */
export const SILK_CB_LAGS_STAGE3_10MS = new Int8Array([
    0, 0, 1, -1, 1, -1, 2, -2, 2, -2, 3, -3, 0, 1, 0, 1, -1, 2, -1, 2, -2, 3, -2, 3,
]);

/** silk_NLSF_CB1_NB_MB_Q8[320] */
export const NLSF_CB1_NB_MB_Q8 = Uint8Array.from(
    atob(
        'DCM8U2yEnbTO5A8gN01lfZevyeETKkJZcomiuNHmDBkySGF4k6zI3xosRVpyh5+0zeENFjVQaoKctM3kDxks' +
            'QFpzjqjE3hMYPlJkeJGovtYWHzJPZ3iXqsvjFR0tQWp8lqvE4B4xS2F5jqW60eUTGTRGXXSPpsDbGiI+S2F2' +
            'kafC2RkhOEZbcY+lxN8VIjNIYXWRq8TeFB0yQ1p1kKjF3RYfMEJfdZKoxN4YITNNdIaetMjgFRxGV2p8larC' +
            '2RohNUBTdZitzOEbIkFfbIGbrtLhFBpIY3GDmrDI2yIrPU5dcpuxzeUXHTZhfIqjs9HlHiY4WXaBnrLI5xUd' +
            'MT9Vb46jwd4bME1nhZ6zxNfoHS9KY3yXsMbc7SEqPUxdeZuuz+EdNVdwiJqqvNDjGB40VIOWprrL5SUwQFRo' +
            'dpyxyeY=',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_CB1_Wght_Q9[320] */
export const NLSF_CB1_NB_MB_WGHT_Q9 = new Int16Array([
    2897, 2314, 2314, 2314, 2287, 2287, 2314, 2300, 2327, 2287, 2888, 2580, 2394, 2367, 2314, 2274,
    2274, 2274, 2274, 2194, 2487, 2340, 2340, 2314, 2314, 2314, 2340, 2340, 2367, 2354, 3216, 2766,
    2340, 2340, 2314, 2274, 2221, 2207, 2261, 2194, 2460, 2474, 2367, 2394, 2394, 2394, 2394, 2367,
    2407, 2314, 3479, 3056, 2127, 2207, 2274, 2274, 2274, 2287, 2314, 2261, 3282, 3141, 2580, 2394,
    2247, 2221, 2207, 2194, 2194, 2114, 4096, 3845, 2221, 2620, 2620, 2407, 2314, 2394, 2367, 2074,
    3178, 3244, 2367, 2221, 2553, 2434, 2340, 2314, 2167, 2221, 3338, 3488, 2726, 2194, 2261, 2460,
    2354, 2367, 2207, 2101, 2354, 2420, 2327, 2367, 2394, 2420, 2420, 2420, 2460, 2367, 3779, 3629,
    2434, 2527, 2367, 2274, 2274, 2300, 2207, 2048, 3254, 3225, 2713, 2846, 2447, 2327, 2300, 2300,
    2274, 2127, 3263, 3300, 2753, 2806, 2447, 2261, 2261, 2247, 2127, 2101, 2873, 2981, 2633, 2367,
    2407, 2354, 2194, 2247, 2247, 2114, 3225, 3197, 2633, 2580, 2274, 2181, 2247, 2221, 2221, 2141,
    3178, 3310, 2740, 2407, 2274, 2274, 2274, 2287, 2194, 2114, 3141, 3272, 2460, 2061, 2287, 2500,
    2367, 2487, 2434, 2181, 3507, 3282, 2314, 2700, 2647, 2474, 2367, 2394, 2340, 2127, 3423, 3535,
    3038, 3056, 2300, 1950, 2221, 2274, 2274, 2274, 3404, 3366, 2087, 2687, 2873, 2354, 2420, 2274,
    2474, 2540, 3760, 3488, 1950, 2660, 2897, 2527, 2394, 2367, 2460, 2261, 3028, 3272, 2740, 2888,
    2740, 2154, 2127, 2287, 2234, 2247, 3695, 3657, 2025, 1969, 2660, 2700, 2580, 2500, 2327, 2367,
    3207, 3413, 2354, 2074, 2888, 2888, 2340, 2487, 2247, 2167, 3338, 3366, 2846, 2780, 2327, 2154,
    2274, 2287, 2114, 2061, 2327, 2300, 2181, 2167, 2181, 2367, 2633, 2700, 2700, 2553, 2407, 2434,
    2221, 2261, 2221, 2221, 2340, 2420, 2607, 2700, 3038, 3244, 2806, 2888, 2474, 2074, 2300, 2314,
    2354, 2380, 2221, 2154, 2127, 2287, 2500, 2793, 2793, 2620, 2580, 2367, 3676, 3713, 2234, 1838,
    2181, 2753, 2726, 2673, 2513, 2207, 2793, 3160, 2726, 2553, 2846, 2513, 2181, 2394, 2221, 2181,
]);

/** silk_NLSF_CB1_iCDF_NB_MB[64] */
export const NLSF_CB1_ICDF_NB_MB = Uint8Array.from(
    atob(
        '1LKUgWxgVVJPTT07OTgzMTAtKikoJiQiHx4VDAoDAQD/9fTs6eHZy76wr6GViH1yZltRRzw0KyMcFBMSDAsF' +
            'AA==',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_PRED_NB_MB_Q8[18] */
export const NLSF_PRED_NB_MB_Q8 = new Uint8Array([
    179, 138, 140, 148, 151, 149, 153, 151, 163, 116, 67, 82, 59, 92, 72, 100, 89, 92,
]);

/** silk_NLSF_CB2_SELECT_NB_MB[160] */
export const NLSF_CB2_SELECT_NB_MB = Uint8Array.from(
    atob(
        'EAAAAABjQiQkIiQiIiIiU0UkNCJ0ZkZERLBmREQiQVVEVCR0jZiLqoS7uNiJhPmouYtoZmRERLLaubmq9Ni7' +
            'u6r0u7vbimebuLmJdLebmIiE2bi4qqTZq5uL9Km4uaqk2N/aitaPvNqo9I2Im6qoitzbi6TbytiJqLr2uYt0' +
            'udu5imRkhmRmIkREZESoy93aqKeaiGhGpPariYuJm9rbiw==',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_CB2_iCDF_NB_MB[72] */
export const NLSF_CB2_ICDF_NB_MB = Uint8Array.from(
    atob(
        '//797g4DAgEA//782iMDAgEA//760DsEAgEA//72wkcKAgEA//zst1IIAgEA//zrtFoRAgEA//jgq2EeBAEA' +
            '//7srV8lBwEA',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_DELTA_MIN_NB_MB_Q15[11] */
export const NLSF_DELTA_MIN_NB_MB_Q15 = new Int16Array([250, 3, 6, 3, 3, 3, 4, 3, 3, 3, 461]);

/** silk_NLSF_CB1_WB_Q8[512] */
export const NLSF_CB1_WB_Q8 = Uint8Array.from(
    atob(
        'BxcmNkVVZHSDk6KywdDf7w0ZKTdFU2Jwf46dq7vL3OwPFSIzPU5can6ImKe5zeHwChUkMj9PX25+jZ2tvc3d' +
            '7REUJTM7Tllre4aWpLjN4PAKDyAzQ1FgcIGOnq29zNzsCBUlM0FPYnF+ipuos8DR2gwPIjc/TldsdoOUp7nL' +
            '2+wQEyAkOE9bbHaImqu6zNztCxwrOkpZaXiHlqW0xNPi8QYQIS48S1xre4mcqbnH1uELEx4sOUpZaXmHmKm6' +
            'ytrqDBMdLjlHWGR4hJSltsfY6REXIy44TVxqe4aYp7nM3u0OES01P0tZa3OEl6u8zt3wCRAdKDhHWGd3iZqr' +
            'vc3e7RATJDA5TFdpdoSWp7nK2uwMER02R1FeaH6IlaS2yd3tDxwvPk9hc4GOm6i0wtDf7ggOHi0+Tl5vf4+f' +
            'r8DP3+8RHjE+T1xrd4SRoK6+zNzrDhMkLT1MW2x5ipqsvc3e7gwSHy08TFtre4qaq7vM3ewNER8rNUZTZ3KD' +
            'lae5y9ztERYjKjpOXW59i5uqvM7g8AgPIjJDU2Nzg5KissHR4O8NEClCSVZfb4CJlqO3zuHxERklND9LXGZ3' +
            'hJCgr7/U5xMfMUFTZHWFk6Guu8jV4/ISHzREWGd1foqVo7HAz9/vEB0vPUxaaneFk6GwwdHg8A8VIzI9SVZh' +
            'bneBja/G2u0=',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_CB1_WB_Wght_Q9[512] */
export const NLSF_CB1_WB_WGHT_Q9 = new Int16Array([
    3657, 2925, 2925, 2925, 2925, 2925, 2925, 2925, 2925, 2925, 2925, 2925, 2963, 2963, 2925, 2846,
    3216, 3085, 2972, 3056, 3056, 3010, 3010, 3010, 2963, 2963, 3010, 2972, 2888, 2846, 2846, 2726,
    3920, 4014, 2981, 3207, 3207, 2934, 3056, 2846, 3122, 3244, 2925, 2846, 2620, 2553, 2780, 2925,
    3516, 3197, 3010, 3103, 3019, 2888, 2925, 2925, 2925, 2925, 2888, 2888, 2888, 2888, 2888, 2753,
    5054, 5054, 2934, 3573, 3385, 3056, 3085, 2793, 3160, 3160, 2972, 2846, 2513, 2540, 2753, 2888,
    4428, 4149, 2700, 2753, 2972, 3010, 2925, 2846, 2981, 3019, 2925, 2925, 2925, 2925, 2888, 2726,
    3620, 3019, 2972, 3056, 3056, 2873, 2806, 3056, 3216, 3047, 2981, 3291, 3291, 2981, 3310, 2991,
    5227, 5014, 2540, 3338, 3526, 3385, 3197, 3094, 3376, 2981, 2700, 2647, 2687, 2793, 2846, 2673,
    5081, 5174, 4615, 4428, 2460, 2897, 3047, 3207, 3169, 2687, 2740, 2888, 2846, 2793, 2846, 2700,
    3122, 2888, 2963, 2925, 2925, 2925, 2925, 2963, 2963, 2963, 2963, 2925, 2925, 2963, 2963, 2963,
    4202, 3207, 2981, 3103, 3010, 2888, 2888, 2925, 2972, 2873, 2916, 3019, 2972, 3010, 3197, 2873,
    3760, 3760, 3244, 3103, 2981, 2888, 2925, 2888, 2972, 2934, 2793, 2793, 2846, 2888, 2888, 2660,
    3854, 4014, 3207, 3122, 3244, 2934, 3047, 2963, 2963, 3085, 2846, 2793, 2793, 2793, 2793, 2580,
    3845, 4080, 3357, 3516, 3094, 2740, 3010, 2934, 3122, 3085, 2846, 2846, 2647, 2647, 2846, 2806,
    5147, 4894, 3225, 3845, 3441, 3169, 2897, 3413, 3451, 2700, 2580, 2673, 2740, 2846, 2806, 2753,
    4109, 3789, 3291, 3160, 2925, 2888, 2888, 2925, 2793, 2740, 2793, 2740, 2793, 2846, 2888, 2806,
    5081, 5054, 3047, 3545, 3244, 3056, 3085, 2944, 3103, 2897, 2740, 2740, 2740, 2846, 2793, 2620,
    4309, 4309, 2860, 2527, 3207, 3376, 3376, 3075, 3075, 3376, 3056, 2846, 2647, 2580, 2726, 2753,
    3056, 2916, 2806, 2888, 2740, 2687, 2897, 3103, 3150, 3150, 3216, 3169, 3056, 3010, 2963, 2846,
    4375, 3882, 2925, 2888, 2846, 2888, 2846, 2846, 2888, 2888, 2888, 2846, 2888, 2925, 2888, 2846,
    2981, 2916, 2916, 2981, 2981, 3056, 3122, 3216, 3150, 3056, 3010, 2972, 2972, 2972, 2925, 2740,
    4229, 4149, 3310, 3347, 2925, 2963, 2888, 2981, 2981, 2846, 2793, 2740, 2846, 2846, 2846, 2793,
    4080, 4014, 3103, 3010, 2925, 2925, 2925, 2888, 2925, 2925, 2846, 2846, 2846, 2793, 2888, 2780,
    4615, 4575, 3169, 3441, 3207, 2981, 2897, 3038, 3122, 2740, 2687, 2687, 2687, 2740, 2793, 2700,
    4149, 4269, 3789, 3657, 2726, 2780, 2888, 2888, 3010, 2972, 2925, 2846, 2687, 2687, 2793, 2888,
    4215, 3554, 2753, 2846, 2846, 2888, 2888, 2888, 2925, 2925, 2888, 2925, 2925, 2925, 2963, 2888,
    5174, 4921, 2261, 3432, 3789, 3479, 3347, 2846, 3310, 3479, 3150, 2897, 2460, 2487, 2753, 2925,
    3451, 3685, 3122, 3197, 3357, 3047, 3207, 3207, 2981, 3216, 3085, 2925, 2925, 2687, 2540, 2434,
    2981, 3010, 2793, 2793, 2740, 2793, 2846, 2972, 3056, 3103, 3150, 3150, 3150, 3103, 3010, 3010,
    2944, 2873, 2687, 2726, 2780, 3010, 3432, 3545, 3357, 3244, 3056, 3010, 2963, 2925, 2888, 2846,
    3019, 2944, 2897, 3010, 3010, 2972, 3019, 3103, 3056, 3056, 3010, 2888, 2846, 2925, 2925, 2888,
    3920, 3967, 3010, 3197, 3357, 3216, 3291, 3291, 3479, 3704, 3441, 2726, 2181, 2460, 2580, 2607,
]);

/** silk_NLSF_CB1_iCDF_WB[64] */
export const NLSF_CB1_ICDF_WB = Uint8Array.from(
    atob(
        '4czJuLevnpqZh3dzcW5tY2JfT0Q0MjAtKyAfGxIKAwD/++vm1MnEtqemo5eKfG5oWk5MRkU5LSIYFQsGBQQD' +
            'AA==',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_PRED_WB_Q8[30] */
export const NLSF_PRED_WB_Q8 = new Uint8Array([
    175, 148, 160, 176, 178, 173, 174, 164, 177, 174, 196, 182, 198, 192, 182, 68, 62, 66, 60, 72,
    117, 85, 90, 118, 136, 151, 142, 160, 142, 155,
]);

/** silk_NLSF_CB2_SELECT_WB[256] */
export const NLSF_CB2_SELECT_WB = Uint8Array.from(
    atob(
        'AAAAAAAAAAFkZmZERCQiYKRrnrm0uYtmQEIkIiIAASDQi42/mLmbaGCraKZmZmaEAQAAAAAQEABQbU5ruYtn' +
            'ZdDUjYutmXtnJAAAAAAAAAEwAAAAAAAAIESHe3d3Z0ViRGd4dnZmR2KGiJ24tpmLhtCo+Eu9j3lrIDEiIiIA' +
            'EQLS64t7uYlphmKHaLZkt6uGZEZERkJCIoNApmZEJAIBAIamZkQiIkKE1Paei2trV2Zk2316iXZnhHKHiWmr' +
            'ajIipNaNj7mXeWfAIgAAAAAAAdBtSruG+Z+JZm6adldld2UAAgAkJEJEI2CkZmQkAAIhp4quZmRUAgJka3h3' +
            'JMUYAA==',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_CB2_iCDF_WB[72] */
export const NLSF_CB2_ICDF_WB = Uint8Array.from(
    atob(
        '//799AwDAgEA//784CYDAgEA//770TkEAgEA//70w0UEAgEA//vouFQHAgEA//7wulYOAgEA//7vslseBQEA' +
            '//jjsWQTAgEA',
    ),
    char => char.charCodeAt(0),
);

/** silk_NLSF_DELTA_MIN_WB_Q15[17] */
export const NLSF_DELTA_MIN_WB_Q15 = new Int16Array([
    100, 3, 40, 3, 3, 3, 5, 14, 14, 10, 11, 3, 8, 9, 7, 3, 347,
]);
