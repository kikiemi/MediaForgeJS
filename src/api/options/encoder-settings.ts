import type { OptionNormalizer } from '../../core/errors/option-policy';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';

/**
 * Host VideoEncoder settings of a request or options object; unusable values are dropped with a
 * finding.
 */
export function snapshotEncoderSettings(
    normalizer: OptionNormalizer,
    raw: {
        readonly hardwareAcceleration?: unknown;
        readonly latencyMode?: unknown;
        readonly bitrateMode?: unknown;
    },
): HostVideoEncoderOptions {
    return {
        hardwareAcceleration: normalizer.choice(
            'hardwareAcceleration',
            raw.hardwareAcceleration,
            ['no-preference', 'prefer-hardware', 'prefer-software'],
            {
                optional: true,
                aliases: {
                    auto: 'no-preference',
                    hardware: 'prefer-hardware',
                    gpu: 'prefer-hardware',
                    software: 'prefer-software',
                    cpu: 'prefer-software',
                },
            },
        ),
        latencyMode: normalizer.choice('latencyMode', raw.latencyMode, ['quality', 'realtime'], {
            optional: true,
            aliases: { live: 'realtime', 'real-time': 'realtime' },
        }),
        bitrateMode: normalizer.choice('bitrateMode', raw.bitrateMode, ['constant', 'variable'], {
            optional: true,
            aliases: { cbr: 'constant', vbr: 'variable' },
        }),
    };
}
