// The support table as the guide shows it (docs/README.md, "Formats and codecs", EN and JA): a
// block between markers that `npm run support -- --docs` writes from the table and
// test/support/docs.test.mjs holds the guide to, so the guide lists what the matrix tests.

const LABELS = {
    en: {
        title: 'Everything the library declares, generated from the support table',
        container: 'Container',
        read: 'Read',
        write: 'Written',
        video: 'Video copied into it',
        audio: 'Audio copied into it',
        lines: {
            decode: 'Decoded by the library',
            encode: 'Encoded by the library',
            'image-in': 'Image formats read and decoded by the library',
            'image-in-host': 'Image formats read, and decoded by the host where it can',
            'image-out': 'Image formats written by the library',
            'image-out-host': "Image formats written by the host's canvas where it can",
            package: 'Packaging targets',
            play: 'Played by `mediaforgejs-player`',
            'host-decode': "Decoded by the host's WebCodecs where it can",
            'host-encode': "Encoded by the host's WebCodecs where it can",
        },
        structural:
            'Copied as streams built by their specification, which checks that a copy carries ' +
            'them, not that they decode',
    },
    ja: {
        title: 'ライブラリが宣言するすべて（対応表から生成）',
        container: '入れ物',
        read: '読む',
        write: '書く',
        video: 'コピーする動画',
        audio: 'コピーする音声',
        lines: {
            decode: 'ライブラリが復号する',
            encode: 'ライブラリが符号化する',
            'image-in': 'ライブラリが読んで復号する画像形式',
            'image-in-host': '読む画像形式（復号はできる場合にホスト）',
            'image-out': 'ライブラリが書く画像形式',
            'image-out-host': 'ホストのキャンバスが書く画像形式（できる場合）',
            package: 'パッケージ化の対象',
            play: '`mediaforgejs-player` が再生する',
            'host-decode': 'ホストのWebCodecsが復号する（できる場合）',
            'host-encode': 'ホストのWebCodecsが符号化する（できる場合）',
        },
        structural:
            '仕様から組み立てたストリームでコピーを確かめる（コピーが運ぶことを確かめ、' +
            '復号できることは確かめない）',
    },
};

const code = names => names.map(name => `\`${name}\``).join(' ') || '–';

/**
 * The block of `language` ('en' or 'ja') for `cells`, markers included; `structural` holds the ids
 * of the cells whose case runs on a stream built by its specification.
 */
export function supportBlock(cells, language, structural = new Set()) {
    const labels = LABELS[language];
    const of = kind => cells.filter(cell => cell.kind === kind);
    // '<kind>-host' lines the cells of the kind only the host handles (`host`), '<kind>' the rest.
    const lineOf = line => {
        const host = line.endsWith('-host');
        return of(host ? line.slice(0, -'-host'.length) : line).filter(
            cell => (cell.host === true) === host,
        );
    };
    const read = new Set(of('read').map(cell => cell.subject));
    const write = new Set(of('write').map(cell => cell.subject));
    const copies = (container, media) =>
        of('copy')
            .filter(cell => cell.container === container && cell.media === media)
            .map(cell => cell.subject);
    const containers = [
        ...new Set([...read, ...write, ...of('copy').map(cell => cell.container)]),
    ].sort();
    const lines = [
        `<!-- support-table ${language}: written by npm run support -- --docs -->`,
        '',
        `**${labels.title}**`,
        '',
        `| ${labels.container} | ${labels.read} | ${labels.write} | ` +
            `${labels.video} | ${labels.audio} |`,
        '| --- | --- | --- | --- | --- |',
        ...containers.map(
            container =>
                `| \`${container}\` | ${read.has(container) ? '✔' : ''} | ` +
                `${write.has(container) ? '✔' : ''} | ${code(copies(container, 'video'))} | ` +
                `${code(copies(container, 'audio'))} |`,
        ),
        '',
        ...Object.entries(labels.lines).map(
            ([line, label]) => `- ${label}: ${code(lineOf(line).map(cell => cell.subject))}`,
        ),
        `- ${labels.structural}: ` +
            code([
                ...new Set(
                    of('copy')
                        .filter(cell => structural.has(cell.id))
                        .map(cell => cell.subject),
                ),
            ]),
        '',
        `<!-- /support-table ${language} -->`,
    ];
    return lines.join('\n');
}

/** `block` with its table cells unpadded, so a block that Prettier aligned compares as written. */
export const unpadded = block =>
    block
        .split('\n')
        .map(line =>
            line.startsWith('|')
                ? line
                      .split('|')
                      .map(cell => cell.trim().replace(/^-+$/, '---'))
                      .join(' | ')
                      .trim()
                : line,
        )
        .join('\n');

const BLOCK = language =>
    new RegExp(`<!-- support-table ${language}:[^]*?<!-- /support-table ${language} -->`);

/** The blocks of `text` (the guide) for each language, or undefined where one is missing. */
export function guideBlocks(text) {
    return Object.fromEntries(
        Object.keys(LABELS).map(language => [language, BLOCK(language).exec(text)?.[0]]),
    );
}

/** The guide `text` with its blocks written from `cells` (`structural` as supportBlock() takes). */
export function withSupportBlocks(text, cells, structural) {
    let written = text;
    for (const language of Object.keys(LABELS)) {
        if (!BLOCK(language).test(written))
            throw new Error(`docs/README.md has no support-table ${language} block`);
        written = written.replace(BLOCK(language), () => supportBlock(cells, language, structural));
    }
    return written;
}
