import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { registry } from './cases/index.mjs';
import { guideBlocks, supportBlock, unpadded } from './docs.mjs';
import { structuralCells } from './generic.mjs';
import { supportTable } from './table.mjs';

// The guide's support tables (docs/README.md, EN and JA) are the support table, so the guide lists
// what the matrix tests. Padding in the table's cells does not count.

const guide = await readFile(new URL('../../docs/README.md', import.meta.url), 'utf8');
const cells = await supportTable();
const structural = structuralCells(cells, registry());

describe('support table in the guide', () => {
    for (const [language, block] of Object.entries(guideBlocks(guide)))
        test(`the ${language} guide shows the support table (npm run support -- --docs)`, () => {
            assert(block, `docs/README.md has a support-table ${language} block`);
            assert.equal(
                unpadded(block),
                unpadded(supportBlock(cells, language, structural)),
                'The guide differs from the support table: run npm run support -- --docs.',
            );
        });
});
