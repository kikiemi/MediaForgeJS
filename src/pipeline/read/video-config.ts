import type { Source } from '../../core/model/types';
import type { DemuxResult } from '../../core/model/track';
import { readSampleBytes, sampleAt, sampleCount } from '../../core/model/sample-index';
import { awaitWithAbort } from '../../core/io/abort';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import {
    isAnnexB,
    splitAnnexBNals,
    splitLengthPrefixedNals,
    buildAvcCFromAnnexB,
} from '../../core/codec-config/video/annexb';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import { avcCodecString } from '../../core/codec-config/video/video-sps';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import { throwIfAborted } from '../../core/errors/errors';
import { mpegVideoFamily, isHevcCodec } from '../../core/model/codec-strings';
import { mpegVideoConfig, parseMpegVideoConfig } from '../../core/codec-config/video/mpeg-video';
import { hevcCodecString } from '../../core/codec-config/video/hevc-codec';
import {
    buildVvcCFromAnnexB,
    isVvcCodec,
    vvcCodecString,
    vvcNalType,
    VVC_NAL,
} from '../../core/codec-config/video/vvc';
import {
    av1CodecString,
    av1ConfigFromSequenceHeader,
    av1SequenceHeaderFromConfig,
    av1SequenceHeaderOf,
} from '../../core/codec-config/video/av1-config';

export async function recoverVideoConfigurations(
    result: DemuxResult,
    source: Source,
    diagnostics: DiagnosticContext,
    maxPacketBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    for (const track of result.videoTracks) {
        const hevc = isHevcCodec(track.codec);
        const vvc = isVvcCodec(track.codec);
        const av1 = track.codec.startsWith('av01');
        const mpeg = mpegVideoFamily(track.codec);
        const configured = av1
            ? !!av1SequenceHeaderFromConfig(track.codecConfig)
            : !!track.codecConfig?.length;
        if (configured || (!hevc && !vvc && !av1 && !mpeg && !track.codec.startsWith('avc')))
            continue;
        const parameters: Uint8Array[] = [];
        let parameterBytes = 0;
        let inspectedBytes = 0;
        for (let index = 0, length = Math.min(64, sampleCount(track)); index < length; index++) {
            const sample = sampleAt(track, index)!;
            throwIfAborted(signal);
            if (sample.size > maxPacketBytes || sample.size > 8 * 1024 * 1024 - inspectedBytes)
                break;
            inspectedBytes += sample.size;
            const bytes = await awaitWithAbort(
                readSampleBytes(track, sample, source, signal),
                signal,
            );
            assertSourceBytes(bytes, sample.size, 'Video configuration scan');
            if (mpeg) {
                const syntax = mpeg === 'mpeg4v' ? 'mpeg4' : 'mpeg12';
                const config = mpegVideoConfig(syntax, bytes);
                const format = config && parseMpegVideoConfig(syntax, config);
                if (!format) continue;
                track.codecConfig = config;
                track.codec = format.codec;
                if (!(track.width > 0 && track.height > 0)) {
                    track.width = format.width;
                    track.height = format.height;
                }
                const header = syntax === 'mpeg4' ? 'MPEG-4 VOL' : 'MPEG sequence header';
                diagnostics.warn({
                    code: 'VIDEO_CONFIG_DERIVED',
                    trackId: track.id,
                    message: `Derived the ${header} configuration from in-band headers`,
                });
                break;
            }
            if (av1) {
                const sequence = av1SequenceHeaderOf(bytes);
                if (!sequence) continue;
                track.codecConfig = av1ConfigFromSequenceHeader(sequence);
                track.codec = av1CodecString(track.codecConfig) ?? track.codec;
                if (!(track.width > 0 && track.height > 0)) {
                    track.width = sequence.width;
                    track.height = sequence.height;
                }
                track.colour ??= sequence.colour;
                diagnostics.warn({
                    code: 'VIDEO_CONFIG_DERIVED',
                    trackId: track.id,
                    message: 'Derived av1C from the in-band sequence header',
                });
                break;
            }

            // Samples without a configuration record are Annex B, or four-byte length-prefixed with
            // in-band sets.
            const nals = isAnnexB(bytes)
                ? splitAnnexBNals(bytes)
                : splitLengthPrefixedNals(bytes, 4);
            if (!nals) continue;
            let changed = false;
            for (const nal of nals) {
                const type = vvc ? vvcNalType(nal) : hevc ? (nal[0]! >>> 1) & 63 : nal[0]! & 31;
                if (
                    !(vvc
                        ? type >= VVC_NAL.OPI && type <= VVC_NAL.PREFIX_APS
                        : hevc
                          ? type >= 32 && type <= 34
                          : type === 7 || type === 8)
                )
                    continue;
                if (nal.length > 65535 || parameterBytes + nal.length + 4 > 1024 * 1024) break;
                if (
                    parameters.some(
                        previous =>
                            previous.length === nal.length &&
                            previous.every((byte, i) => byte === nal[i]),
                    )
                )
                    continue;
                parameters.push(nal.slice());
                parameterBytes += nal.length + 4;
                changed = true;
            }
            if (!changed) continue;
            const data = new Uint8Array(parameterBytes);
            let offset = 0;
            for (const nal of parameters) {
                data.set([0, 0, 0, 1], offset);
                data.set(nal, offset + 4);
                offset += nal.length + 4;
            }
            const config = (
                vvc ? buildVvcCFromAnnexB : hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB
            )(data);
            if (!config) continue;
            track.codecConfig = config;
            if (vvc)
                track.codec = vvcCodecString(
                    track.codec.startsWith('vvi1') ? 'vvi1' : 'vvc1',
                    config,
                );
            // The codec string takes the profile and level of the derived record: the entry had
            // none to state (an empty avcC reads as a placeholder 'avc1.640028').
            else if (hevc && /^(hvc1|hev1)(\.|$)/.test(track.codec))
                track.codec = hevcCodecString(track.codec.slice(0, 4), config);
            else if (/^avc[13](\.|$)/.test(track.codec) && config.length >= 4)
                track.codec = avcCodecString(config, track.codec.slice(0, 4));
            diagnostics.warn({
                code: 'VIDEO_CONFIG_DERIVED',
                trackId: track.id,
                message:
                    `Derived ${vvc ? 'vvcC' : hevc ? 'hvcC' : 'avcC'} from in-band video ` +
                    `parameter sets`,
            });
            break;
        }
    }
}
