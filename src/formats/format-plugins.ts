import type { PluginManifest } from '../core/contracts/plugin';
import { aviManifest } from './avi/manifest';
import { flvManifest } from './flv/manifest';
import { asfManifest } from './asf/manifest';
import { mxfManifest } from './mxf/manifest';
import { mpegPsManifest } from './mpeg-ps/manifest';
import { ivfManifest } from './ivf/manifest';
import { iamfManifest } from './iamf/manifest';
import { apvManifest } from './apv/manifest';

/**
 * The manifests of the library's format plugins, in catalog order: the catalog lists them, and the
 * library's detection asks the signatures of their readers whether or not a plugin is in use.
 */
export const FORMAT_PLUGIN_MANIFESTS: readonly PluginManifest[] = Object.freeze([
    aviManifest,
    flvManifest,
    asfManifest,
    mxfManifest,
    mpegPsManifest,
    ivfManifest,
    iamfManifest,
    apvManifest,
]);
