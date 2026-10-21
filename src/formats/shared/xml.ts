import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { positiveLimit } from '../../core/errors/limits';

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const NAME = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';

export interface XmlNode {
    name: string;
    namespace: string;
    attributes: Record<string, string>;
    children: Array<XmlNode | string>;
}

// Text that is not well-formed XML is malformed (DEMUX), a DTD this subset does not read is
// unsupported (FORMAT), an invalid argument or option is INPUT, and a document past a size limit is
// OOM.

function xmlError(message: string): never {
    throw new DemuxError(`Invalid XML: ${message}`);
}

function overLimit(message: string): never {
    throw new MediaForgeError(message, 'OOM');
}

function validCodePoint(value: number): boolean {
    return (
        value === 9 ||
        value === 10 ||
        value === 13 ||
        (value >= 0x20 && value <= 0xd7ff) ||
        (value >= 0xe000 && value <= 0xfffd) ||
        (value >= 0x10000 && value <= 0x10ffff)
    );
}

function entities(value: string): string {
    return value.replace(/&([^;]*);|&/g, (match, name: string | undefined) => {
        if (!name) return xmlError('unterminated entity');
        const builtin: Record<string, string> = {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'",
        };
        if (Object.prototype.hasOwnProperty.call(builtin, name)) return builtin[name]!;
        if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) return xmlError(`unknown entity ${match}`);
        const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return validCodePoint(code)
            ? String.fromCodePoint(code)
            : xmlError('invalid character reference');
    });
}

interface XmlParseOptions {
    readonly maxDepth?: number;
    readonly maxNodes?: number;
}

/**
 * Bounded XML subset without DTD/entity declarations. Callers must also bound source byte length.
 */
export function parseXml(source: string, options: XmlParseOptions = {}): XmlNode {
    if (typeof source !== 'string') throw new MediaForgeError('Expected XML text', 'INPUT');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected XML parse options', 'INPUT');

    const { maxDepth: depth, maxNodes: nodes } = options;
    const maxDepth = positiveLimit(depth, 64, 'XML maxDepth');
    if (maxDepth > 256) throw new MediaForgeError('maxDepth must not exceed 256', 'INPUT');
    const maxNodes = positiveLimit(nodes, 200000, 'XML maxNodes');

    source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    for (const char of source)
        if (!validCodePoint(char.codePointAt(0)!)) xmlError('invalid character');

    let count = 0;
    const consume = (): void => {
        if (++count > maxNodes) overLimit('XML input exceeds maxNodes');
    };

    const stack: Array<{ node: XmlNode; qname: string; namespaces: Record<string, string> }> = [];
    let root: XmlNode | undefined;
    const addText = (value: string): void => {
        if (!value) return;
        consume();
        if (!stack.length) {
            if (value.trim()) xmlError('text outside document element');
        } else stack[stack.length - 1]!.node.children.push(value);
    };

    for (let offset = 0; offset < source.length;) {
        if (source[offset] !== '<') {
            const end = source.indexOf('<', offset);
            const text = source.slice(offset, end < 0 ? source.length : end);
            if (text.includes(']]>')) xmlError('CDATA terminator in text');
            addText(entities(text));
            offset = end < 0 ? source.length : end;
            continue;
        }

        if (source.startsWith('<!--', offset)) {
            const end = source.indexOf('-->', offset + 4);
            if (end < 0 || source.slice(offset + 4, end).includes('--'))
                xmlError('malformed comment');
            consume();
            offset = end + 3;
            continue;
        }

        if (source.startsWith('<![CDATA[', offset)) {
            if (!stack.length) xmlError('CDATA outside document element');
            const end = source.indexOf(']]>', offset + 9);
            if (end < 0) xmlError('unterminated CDATA');
            addText(source.slice(offset + 9, end));
            offset = end + 3;
            continue;
        }

        if (source.startsWith('<?', offset)) {
            const end = source.indexOf('?>', offset + 2);
            if (end < 0) xmlError('unterminated processing instruction');
            const instruction = source.slice(offset + 2, end);
            if (
                /^xml(?:\s|$)/i.test(instruction) &&
                (offset !== 0 || !instruction.startsWith('xml '))
            )
                xmlError('misplaced XML declaration');
            consume();
            offset = end + 2;
            continue;
        }

        if (source.startsWith('<!', offset))
            throw new MediaForgeError(
                'Invalid XML: DTD and entity declarations are not supported',
                'FORMAT',
            );
        let end = offset + 1;
        let quote = '';
        for (; end < source.length; end++) {
            const char = source[end]!;
            if (quote) {
                if (char === quote) quote = '';
            } else if (char === '"' || char === "'") quote = char;
            else if (char === '>') break;
        }

        if (end === source.length) xmlError('unterminated tag');
        const body = source.slice(offset + 1, end);
        offset = end + 1;

        if (body.startsWith('/')) {
            if (!new RegExp(`^/${NAME}\\s*$`).test(body)) xmlError('invalid closing tag');
            const closed = stack.pop();
            if (!closed || closed.qname !== body.slice(1).trim())
                xmlError('mismatched closing tag');
            continue;
        }

        const match = new RegExp(`^(${NAME})(?=\\s|/|$)`).exec(body);
        if (!match) xmlError('invalid element name');
        const qname = match[1]!;
        const selfClosing = body.endsWith('/');
        const tail = body.slice(match[0].length, selfClosing ? -1 : undefined);

        const attributes: Record<string, string> = Object.create(null);
        const namespaces: Record<string, string> = Object.assign(
            Object.create(null),
            stack[stack.length - 1]?.namespaces ?? { xml: XML_NS },
        );

        const attributeRegex = new RegExp(`\\s+(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
        let cursor = 0;
        while (cursor < tail.length) {
            attributeRegex.lastIndex = cursor;
            const attribute = attributeRegex.exec(tail);
            if (!attribute) {
                if (!tail.slice(cursor).trim()) break;
                xmlError('invalid attribute');
            }

            cursor = attributeRegex.lastIndex;
            const key = attribute[1]!;
            if (Object.prototype.hasOwnProperty.call(attributes, key))
                xmlError('duplicate attribute');
            attributes[key] = entities((attribute[2] ?? attribute[3]!).replace(/[\t\n\r]/g, ' '));
            consume();
            if (key === 'xmlns' || key.startsWith('xmlns:')) {
                const prefix = key === 'xmlns' ? '' : key.slice(6);
                const namespace = attributes[key]!;
                if (
                    prefix === 'xmlns' ||
                    namespace === XMLNS_NS ||
                    (prefix === 'xml') !== (namespace === XML_NS) ||
                    (prefix && !namespace)
                )
                    xmlError('invalid namespace declaration');
                if (!(prefix in namespaces) && Object.keys(namespaces).length >= 128)
                    overLimit('XML input has more than 128 active namespace bindings');
                namespaces[prefix] = namespace;
            }
        }

        const expanded = (name: string, attribute: boolean): [string, string] => {
            const parts = name.split(':');
            const prefix = parts.length === 2 ? parts[0]! : attribute ? undefined : '';
            const namespace = prefix === undefined ? '' : namespaces[prefix];
            if (prefix && namespace === undefined) xmlError('unbound namespace prefix');
            return [namespace ?? '', parts[parts.length - 1]!];
        };

        const [namespace, name] = expanded(qname, false);
        const attrs: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
            const [uri, local] = expanded(key, true);
            const fullName = `${uri}|${local}`;
            if (Object.prototype.hasOwnProperty.call(attrs, fullName))
                xmlError('duplicate expanded attribute');
            attrs[fullName] = value;
        }

        consume();
        const node: XmlNode = { name, namespace, attributes: attrs, children: [] };
        if (stack.length) stack[stack.length - 1]!.node.children.push(node);
        else if (root) xmlError('multiple document elements');
        else root = node;
        if (stack.length + 1 > maxDepth) overLimit('XML input exceeds maxDepth');
        if (!selfClosing) stack.push({ node, qname, namespaces });
    }

    if (stack.length || !root) xmlError('unclosed or absent document element');
    return root;
}

export function xmlEscape(value: string): string {
    if (typeof value !== 'string') throw new MediaForgeError('Expected XML text', 'INPUT');
    for (const char of value)
        if (!validCodePoint(char.codePointAt(0)!))
            throw new MediaForgeError('XML cannot state a character of this text', 'FORMAT');
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
