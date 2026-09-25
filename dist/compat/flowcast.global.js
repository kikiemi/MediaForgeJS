(function () {
'use strict';
(function installFlowCast(target, install) {
    const canonical = target.MediaForgeJS;
    if (!canonical || typeof canonical.MediaForgeConverter !== 'function') {
        throw new Error('Load the MediaForgeJS browser bundle before the FlowCast compatibility shim');
    }
    const legacy = Object.assign({}, canonical, {
        FlowCastConverter: canonical.MediaForgeConverter,
        FlowCastError: canonical.MediaForgeError,
    });
    const restore = install(target, { FlowCast: legacy, FlowCastReady: Promise.resolve(legacy) });
    legacy.noConflict = () => {
        restore();
        return legacy;
    };
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        try {
            document.dispatchEvent(new CustomEvent('flowcast:ready', { detail: legacy }));
        } catch (error) {
            void error;
        }
    }
})(globalThis, function installGlobals(target, values) {
    const names = Object.keys(values);
    const previous = names.map(name => Object.getOwnPropertyDescriptor(target, name));
    const installedDescriptors = [];
    for (let index = 0; index < names.length; index++) {
        const descriptor = previous[index];
        if (descriptor && !descriptor.configurable && !('value' in descriptor && descriptor.writable)) {
            throw new TypeError(`Cannot install global ${names[index]}`);
        }
        if (!descriptor && !Object.isExtensible(target)) throw new TypeError(`Cannot install global ${names[index]}`);
    }
    const restore = count => {
        for (let index = count - 1; index >= 0; index--) {
            const name = names[index];
            const current = Object.getOwnPropertyDescriptor(target, name);
            const installed = installedDescriptors[index];
            if (
                !current ||
                !('value' in current) ||
                current.value !== installed.value ||
                current.configurable !== installed.configurable ||
                current.enumerable !== installed.enumerable ||
                current.writable !== installed.writable
            )
                continue;
            if (previous[index]) Object.defineProperty(target, name, previous[index]);
            else delete target[name];
        }
    };
    let installed = 0;
    try {
        for (const name of names) {
            const old = previous[installed];
            Object.defineProperty(
                target,
                name,
                old && !old.configurable
                    ? { value: values[name] }
                    : { value: values[name], configurable: true, enumerable: true, writable: true },
            );
            installedDescriptors.push(Object.getOwnPropertyDescriptor(target, name));
            installed++;
        }
    } catch (error) {
        restore(installed);
        throw error;
    }
    return () => restore(names.length);
});
})();
