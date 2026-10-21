import type { AacSbrTools } from './decoder';
import { AacSbr } from './sbr';

/** SBR with parametric stereo for the AAC decoder, which the aac plugin's decoder loads with it. */
export const AAC_SBR_TOOLS: AacSbrTools = Object.freeze({
    createSbr: (elementType: number) => new AacSbr(elementType),
});
