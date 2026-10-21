import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--write';
if (mode !== '--write' && mode !== '--check')
    throw new Error('Usage: node scripts/format.mjs [--write|--check]');
let configured = true;
try {
    await access(join(root, 'prettier.config.mjs'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configured = false;
}
if (configured) {
    const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
            join(root, 'node_modules/prettier/bin/prettier.cjs'),
            mode,
            'src/**/*.ts',
            'scripts/**/*.{mjs,cjs}',
            'test/**/*.mjs',
            'packages/**/*.{js,mjs,ts,json}',
            'package.json',
            'prettier.config.mjs',
            'tsconfig.json',
        ],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
} else {
    console.log('Formatting is disabled because prettier.config.mjs is absent.');
}

/**
 * Columns a line of src/, scripts/, test/ or a package's test/ may take; Prettier wraps code there
 * but leaves long strings and comments.
 */
const MAX_COLUMNS = 100;

async function files(dir, pattern) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'fixtures' && entry.name !== 'node_modules')
                found.push(...(await files(path, pattern)));
        } else if (pattern.test(entry.name)) found.push(path);
    }
    return found;
}

const tooLong = [];
for (const file of [
    ...(await files(join(root, 'src'), /\.ts$/)),
    ...(await files(join(root, 'scripts'), /\.[mc]js$/)),
    ...(await files(join(root, 'test'), /\.[mc]?js$/)),
    ...(await files(join(root, 'packages'), /\.test\.mjs$/)),
]) {
    const name = relative(root, file).split('\\').join('/');
    (await readFile(file, 'utf8')).split('\n').forEach((line, index) => {
        const columns = [...line].length;
        if (columns > MAX_COLUMNS) tooLong.push(`${name}:${index + 1}: ${columns} columns`);
    });
}
if (tooLong.length) {
    console.error(
        `Lines over ${MAX_COLUMNS} columns (break them by hand; Prettier does ` +
            `not):\n${tooLong.join('\n')}`,
    );
    if (mode === '--check') process.exitCode = 1;
}
