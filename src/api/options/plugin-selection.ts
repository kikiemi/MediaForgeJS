import { MediaForgeError } from '../../core/errors/errors';
import type { PluginName } from '../../plugins/catalog';
import type { MediaForgePlugin } from '../../core/contracts/plugin';

/**
 * Which plugins to use: an array lists exactly those; `{ exclude, add }` starts from the entry's
 * plugins, leaves out the named ones and adds others.
 */
export type PluginSelection =
    | readonly MediaForgePlugin[]
    | {
          readonly exclude?: readonly (PluginName | (string & {}))[];
          readonly add?: readonly MediaForgePlugin[];
      };

/**
 * The plugins a selection picks from `base`; unknown names in `exclude` are reported through
 * `onUnknown`.
 */
export function selectPlugins(
    selection: unknown,
    base: readonly MediaForgePlugin[],
    onUnknown: (name: string) => void,
): readonly MediaForgePlugin[] {
    if (selection === undefined) return base;
    if (Array.isArray(selection)) return selection;
    if (!selection || typeof selection !== 'object')
        throw new MediaForgeError(
            'plugins must be an array of plugins or { exclude, add }',
            'INPUT',
            {
                hint: "Pass plugins: { exclude: ['h264'] }, or a list such as [avi, h264].",
            },
        );
    const { exclude = [], add = [] } = selection as { exclude?: unknown; add?: unknown };
    if (!Array.isArray(exclude) || exclude.some(name => typeof name !== 'string'))
        throw new MediaForgeError('plugins.exclude must be an array of plugin names', 'INPUT');
    if (!Array.isArray(add))
        throw new MediaForgeError('plugins.add must be an array of plugins', 'INPUT');
    const known = new Set(base.map(plugin => plugin.name));
    for (const name of exclude as string[]) if (!known.has(name)) onUnknown(name);
    return [
        ...base.filter(plugin => !(exclude as string[]).includes(plugin.name)),
        ...(add as MediaForgePlugin[]),
    ];
}
