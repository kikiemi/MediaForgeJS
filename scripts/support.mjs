// The support table with the status of every cell, for reading: tested in Node (structural: on a
// stream built by its specification, which checks carriage, not decoding), tested in a browser, or
// missing a case. The cells come from the library's declarations (test/support/table.mjs) and the
// cases from test/support/cases; the matrix tests run them.
//   npm run support            every cell
//   npm run support -- copy    the cells of one kind (read, write, copy, decode, ...)
//   npm run support -- --docs  writes the table into docs/README.md (EN and JA)
// Run it after npm run build.
import { readFile, writeFile } from 'node:fs/promises';
import { registry } from '../test/support/cases/index.mjs';
import { withSupportBlocks } from '../test/support/docs.mjs';
import { caseOf, structuralCells } from '../test/support/generic.mjs';
import { KINDS, supportTable } from '../test/support/table.mjs';

const MARKS = {
    node: '✔ node',
    structural: '✔ node (structural)',
    browser: '✔ browser',
    missing: '✖ missing',
};
const WIDTH = Math.max(...Object.values(MARKS).map(mark => mark.length));
const args = process.argv.slice(2);
const table = await supportTable();
if (args.includes('--docs')) {
    const guide = new URL('../docs/README.md', import.meta.url);
    const text = await readFile(guide, 'utf8');
    await writeFile(guide, withSupportBlocks(text, table, structuralCells(table, registry())));
    console.log('docs/README.md: the support table is written in English and Japanese');
    process.exit(0);
}
const cells = table.filter(cell => !args.length || args.includes(cell.kind));
const inputs = registry();
const totals = { node: 0, structural: 0, browser: 0, missing: 0 };
for (const kind of Object.keys(KINDS)) {
    const ofKind = cells.filter(cell => cell.kind === kind);
    if (!ofKind.length) continue;
    console.log(`\n${kind}: ${KINDS[kind].title} (${ofKind.length})`);
    for (const cell of ofKind) {
        const found = caseOf(cell, inputs);
        const status = !found
            ? 'missing'
            : cell.where === 'browser' || found.browser
              ? 'browser'
              : found.structural
                ? 'structural'
                : 'node';
        totals[status]++;
        console.log(`  ${MARKS[status].padEnd(WIDTH)}  ${cell.id}`);
    }
}
console.log(
    `\n${cells.length} cells: ${totals.node + totals.structural} tested in Node ` +
        `(${totals.structural} of them on structural streams), ${totals.browser} in a browser, ` +
        `${totals.missing} missing`,
);
