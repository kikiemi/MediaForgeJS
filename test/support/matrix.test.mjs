import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registry } from './cases/index.mjs';
import { caseOf, usedInputs } from './generic.mjs';
import { cellName, supportTable } from './table.mjs';

// Every feature the library declares (./table.mjs) runs one small case through the public API: the
// support matrix. A cell of the host (WebCodecs, MSE, EME) runs in the browser
// (./matrix-browser.test.mjs) and is listed here as such. A declared cell without a case fails,
// and so does an input or case of the registry that serves no declared cell.

const cells = await supportTable();
const inputs = registry();

describe('support matrix', () => {
    for (const cell of cells) {
        const found = caseOf(cell, inputs);
        if (cell.where === 'browser' || found?.browser)
            test(cellName(cell), { skip: 'a browser cell (npm run test:browser)' });
        else if (!found)
            test(cellName(cell), () =>
                assert.fail(
                    `${cell.id} is declared but has no case: give test/support/cases an input ` +
                        'or a case for it',
                ),
            );
        else test(cellName(cell), () => found.run());
    }

    test('every input and case of the registry serves a declared cell', () => {
        const used = usedInputs(cells, inputs);
        const unused = Object.entries(inputs).flatMap(([field, entries]) =>
            Object.keys(entries)
                .map(key => `${field}/${key}`)
                .filter(entry => !used.has(entry)),
        );
        assert.deepEqual(unused, []);
    });
});
