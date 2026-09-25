import { ConverterImage } from '../image/converter-image.js';
import { probeStructure } from '../core/structure-probe.js';
export const imageConversion = Object.assign(((config, host) => new ConverterImage(config, host)), { validate: probeStructure });
