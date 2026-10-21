// Release verification only: deny Node's outgoing network APIs before importing packages.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const attempts = [];
const deny = api =>
    function () {
        attempts.push(api);
        const error = new Error(`Offline verification blocked network API: ${api}`);
        error.code = 'MEDIAFORGE_OFFLINE_NETWORK';
        throw error;
    };
for (const [name, methods] of [
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
    ['node:dgram', ['createSocket']],
    ['node:dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
]) {
    const api = require(name);
    for (const method of methods) api[method] = deny(`${name}.${method}`);
}
require('node:net').Socket.prototype.connect = deny('net.Socket.connect');
const dnsPromises = require('node:dns').promises;
for (const key of Object.keys(dnsPromises)) {
    if (typeof dnsPromises[key] === 'function' && key !== 'Resolver')
        dnsPromises[key] = deny(`dns.promises.${key}`);
}
for (const key of ['fetch', 'WebSocket', 'EventSource']) globalThis[key] = deny(key);
syncBuiltinESMExports();
Object.defineProperty(globalThis, '__mediaforgeOfflineNetworkBlocked', { value: true });
process.on('exit', () => {
    if (process.env.MEDIAFORGE_NETWORK_REPORT) {
        fs.writeFileSync(
            process.env.MEDIAFORGE_NETWORK_REPORT,
            JSON.stringify({ blocked: true, attempts }) + '\n',
        );
    }
    // A caller swallowing an optional-dependency fetch failure must still fail verification.
    if (attempts.length) process.exitCode = 86;
});
