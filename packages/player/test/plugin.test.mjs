import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { player } from 'mediaforgejs-player';

// The player as a plugin of mediaforgejs: what it declares, and what play() and capabilities() see
// once it is added.

describe('the player plugin', () => {
    test('declares the HLS and DASH players and loads each on demand', async () => {
        assert.equal(player.name, 'player');
        assert.deepEqual(
            player.players.map(part => [part.id, [...part.protocols]]),
            [
                ['hls', ['hls']],
                ['dash', ['dash']],
            ],
        );
        for (const part of player.players) {
            const play = await part.load();
            assert.equal(typeof play, 'function', part.id);
            assert.equal(await part.load(), play, `${part.id} loads once`);
        }
    });

    test('is a plugin mediaforgejs reports once it is added', async () => {
        const forge = new MediaForge({ plugins: { add: [player] } });
        assert.ok((await forge.capabilities()).plugins.includes('player'));
        assert.ok(!(await new MediaForge().capabilities()).plugins.includes('player'));
    });
});
