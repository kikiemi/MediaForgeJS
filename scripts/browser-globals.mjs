export function installGlobals(target, values) {
    const names = Object.keys(values);
    const previous = names.map(name => Object.getOwnPropertyDescriptor(target, name));
    const installedDescriptors = [];
    for (let index = 0; index < names.length; index++) {
        const descriptor = previous[index];
        if (
            descriptor &&
            !descriptor.configurable &&
            !('value' in descriptor && descriptor.writable)
        ) {
            throw new TypeError(`Cannot install global ${names[index]}`);
        }
        if (!descriptor && !Object.isExtensible(target))
            throw new TypeError(`Cannot install global ${names[index]}`);
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
}
