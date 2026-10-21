const ID = /[A-Za-z0-9_$\u00AA-\uFFFF]/;
const REGEX_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
    'default',
]);
const CONTROL_HEADS = new Set(['if', 'for', 'while', 'with', 'catch', 'switch']);

/**
 * Removes the comments and the whitespace the code does not need, and joins the pieces of a string
 * the source split with `+`. Linear in the length of `src`: the output is a list of parts, and the
 * checks read only its last few characters.
 */
export function minifyJs(src) {
    /** The output so far, as the parts written, and its length. */
    const parts = [];
    let length = 0;
    /** The last character written that is not whitespace, or '' before any. */
    let lastSignificant = '';
    /** Whether the last text written that is not whitespace was a word. */
    let lastTokenWasWord = false;
    let prev = '';
    let lastWord = '';
    let lastWasRegex = false;
    let lastCloseControl = false;
    const parenStack = [];
    let i = 0;
    const n = src.length;
    const push = (text, sig) => {
        parts.push(text);
        length += text.length;
        for (let index = text.length - 1; index >= 0; index--) {
            const character = text[index];
            if (character !== ' ' && character !== '\n') {
                lastSignificant = character;
                lastTokenWasWord = false;
                break;
            }
        }
        prev = sig;
    };
    /** The last `count` characters of the output. */
    const tail = count => {
        let text = '';
        for (let index = parts.length - 1; index >= 0 && text.length < count; index--)
            text = parts[index] + text;
        return text.slice(Math.max(0, text.length - count));
    };
    /** Drops the output past `size` characters. */
    const truncate = size => {
        while (length > size) {
            const last = parts.pop();
            length -= last.length;
            if (length < size) {
                parts.push(last.slice(0, size - length));
                length = size;
            }
        }
    };
    /**
     * The last string literal written: where it is in the output, its quote, its text so far, and
     * what came before it (the last character that is not whitespace, and the word ending there).
     */
    let string = { start: -1, end: -1, quote: '', text: '', before: '', word: '' };
    /**
     * Whether `literal` (ending at `end` of the source) continues the last literal written as `'a'
     * + 'b'`: same quote, nothing but `+` and a line break between them, and no operator around
     * them that binds tighter than +.
     */
    const canJoin = (literal, source, end) => {
        if (string.end < 0) return false;
        // 'a' + "b" joins when the second text needs no change under the first quote.
        const quotes = `${string.quote}${literal[0]}`;
        if (
            quotes.includes('`')
                ? quotes !== '``'
                : literal[0] !== string.quote && /['"\\]/.test(literal.slice(1, -1))
        )
            return false;
        if (length - string.end > 2 || !/^\+\n?$/.test(tail(length - string.end))) return false;
        const { before, word } = string;
        if (word ? !['return', 'case', 'throw'].includes(word) : !/^[(,=:?[{;+&|<>]?$/.test(before))
            return false;
        let at = end;
        while (at < source.length && /\s/.test(source[at])) at += 1;
        const after = at < source.length ? source[at] : '';
        if ('.[*/%'.includes(after) && after !== '') return false;
        // A NUL escape before a digit would read as an octal escape, and `$` before `{` as a
        // substitution; a template written after a tag is not a plain text.
        const previous = string.text.slice(1, -1);
        const next = literal.slice(1);
        if (/(^|[^\\])(\\\\)*\\0$/.test(previous) && /^[0-9]/.test(next)) return false;
        if (
            string.quote === '`' &&
            (/(^|[^\\])(\\\\)*\$$/.test(previous) || /[\w$.)\]]$/.test(before))
        )
            return false;
        return string.quote !== '`' || !next.startsWith('{');
    };
    const regexAllowed = () => {
        if (!prev || prev === '\n') return true;
        if (prev === ')') return lastCloseControl;
        if (prev === ']') return false;
        if (ID.test(prev)) return REGEX_KEYWORDS.has(lastWord);
        return true;
    };
    const emitSeparator = (hadNewline, next) => {
        if (hadNewline) {
            if (length > 0 && prev !== '\n') push('\n', '\n');
            return;
        }
        if (prev === '' || next === '') return;
        if (ID.test(prev) && ID.test(next)) push(' ', ' ');
        else if ((prev === '+' || prev === '-') && next === prev) push(' ', ' ');
        else if (lastWasRegex && ID.test(next)) push(' ', ' ');
        else if (next === '.' && /^[0-9][0-9_]*$/.test(lastWord)) push(' ', ' ');
        else if (next === '-' && tail(2) === '<!') push(' ', ' ');
    };
    while (i < n) {
        const c = src[i];
        const isWs = c === ' ' || c === '\t' || c === '\r' || c === '\n';
        const isComment = c === '/' && (src[i + 1] === '/' || src[i + 1] === '*');
        const isBanner = c === '/' && src[i + 1] === '*' && src[i + 2] === '!';
        if ((isWs || isComment) && !isBanner) {
            let hadNewline = false;
            while (i < n) {
                const d = src[i];
                if (d === ' ' || d === '\t' || d === '\r') {
                    i += 1;
                    continue;
                }
                if (d === '\n') {
                    hadNewline = true;
                    i += 1;
                    continue;
                }
                if (d === '/' && src[i + 1] === '/') {
                    i += 2;
                    while (i < n && src[i] !== '\n') i += 1;
                    continue;
                }
                if (d === '/' && src[i + 1] === '*' && src[i + 2] !== '!') {
                    i += 2;
                    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                        if (src[i] === '\n') hadNewline = true;
                        i += 1;
                    }
                    i = Math.min(n, i + 2);
                    continue;
                }
                break;
            }
            emitSeparator(hadNewline, i < n ? src[i] : '');
            continue;
        }
        if (isBanner) {
            let j = i + 2;
            while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
            j = Math.min(n, j + 2);
            if (length > 0 && prev !== '\n') push('\n', '\n');
            push(src.slice(i, j) + '\n', '\n');
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '\\') j += 2;
                else if (src[j] === c) {
                    j += 1;
                    break;
                } else j += 1;
            }
            const literal = src.slice(i, j);
            if (canJoin(literal, src, j)) {
                // 'a' + 'b' as the source splits a long text: one literal, as written before the
                // split.
                truncate(string.end - 1);
                push(literal.slice(1, -1) + string.quote, string.quote);
                string.end = length;
                string.text = string.text.slice(0, -1) + literal.slice(1, -1) + string.quote;
            } else {
                const before = lastSignificant;
                const word = lastTokenWasWord ? lastWord : '';
                push(literal, c);
                string = { start: length - literal.length, end: length, quote: c };
                Object.assign(string, { text: literal, before, word: wordOf(word) });
            }
            lastWord = '';
            lastWasRegex = false;
            i = j;
            continue;
        }
        if (c === '`') {
            let j = i + 1;
            let depth = 0;
            while (j < n) {
                if (src[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (depth === 0 && src[j] === '$' && src[j + 1] === '{') {
                    depth = 1;
                    j += 2;
                    continue;
                }
                if (depth > 0) {
                    if (src[j] === '{') depth += 1;
                    else if (src[j] === '}') depth -= 1;
                    else if (src[j] === '`') {
                        let k = j + 1;
                        while (k < n) {
                            if (src[k] === '\\') k += 2;
                            else if (src[k] === '`') {
                                k += 1;
                                break;
                            } else k += 1;
                        }
                        j = k;
                        continue;
                    }
                    j += 1;
                    continue;
                }
                if (src[j] === '`') {
                    j += 1;
                    break;
                }
                j += 1;
            }
            const template = src.slice(i, j);
            if (canJoin(template, src, j)) {
                truncate(string.end - 1);
                push(template.slice(1), '`');
                string.end = length;
                string.text = string.text.slice(0, -1) + template.slice(1);
            } else {
                const before = lastSignificant;
                const word = lastTokenWasWord ? lastWord : '';
                push(template, '`');
                string = { start: length - template.length, end: length, quote: '`' };
                Object.assign(string, { text: template, before, word: wordOf(word) });
            }
            lastWord = '';
            lastWasRegex = false;
            i = j;
            continue;
        }
        if (c === '/' && regexAllowed()) {
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < n) {
                const d = src[j];
                if (d === '\\') {
                    j += 2;
                    continue;
                }
                if (d === '\n') break;
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) {
                    j += 1;
                    closed = true;
                    break;
                }
                j += 1;
            }
            if (closed) {
                while (j < n && /[a-z]/i.test(src[j])) j += 1;
                push(src.slice(i, j), '/');
                lastWord = '';
                lastWasRegex = false;
                lastWasRegex = true;
                i = j;
                continue;
            }
            push('/', '/');
            lastWord = '';
            lastWasRegex = false;
            i += 1;
            continue;
        }
        if (ID.test(c)) {
            let j = i;
            while (j < n && ID.test(src[j])) j += 1;
            const word = src.slice(i, j);
            push(word, word[word.length - 1]);
            lastTokenWasWord = true;
            lastWord = word;
            lastWasRegex = false;
            i = j;
            continue;
        }
        if (c === '(') {
            parenStack.push(CONTROL_HEADS.has(lastWord));
            push('(', '(');
            lastWord = '';
            lastWasRegex = false;
            i += 1;
            continue;
        }
        if (c === ')') {
            lastCloseControl = parenStack.pop() ?? false;
            push(')', ')');
            lastWord = '';
            lastWasRegex = false;
            i += 1;
            continue;
        }
        push(c, c);
        lastWord = '';
        i += 1;
    }
    return parts.join('');
}

/**
 * The identifier that ends a word token, as a pattern finds it at the end of the text before a
 * literal: '' when none does (a number, or a word that starts with no letter).
 */
function wordOf(token) {
    return /[A-Za-z_$][\w$]*$/.exec(token)?.[0] ?? '';
}
