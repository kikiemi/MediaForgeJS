import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registry } from './cases/index.mjs';
import { caseOf } from './generic.mjs';
import { cellName, supportTable } from './table.mjs';

// The browser cells of the support matrix (./matrix.test.mjs): the host's WebCodecs, MSE and EME,
// and the cases that need a browser, run in a real one (npm run test:browser); one without a case
// fails. In Node the file skips itself; ./matrix.test.mjs lists those cells there.

const inBrowser = typeof document !== 'undefined';
const cells = inBrowser ? await supportTable() : [];
const inputs = registry();

describe(
    'support matrix in a browser',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        for (const cell of cells) {
            const found = caseOf(cell, inputs);
            if (cell.where !== 'browser' && !found?.browser) continue;
            if (!found)
                test(cellName(cell), () =>
                    assert.fail(
                        `${cell.id} is declared but has no case: give test/support/cases a ` +
                            'case for it',
                    ),
                );
            else test(cellName(cell), t => found.run(t));
        }
    },
);
