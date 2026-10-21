// Compiles scalar kernels written in a small subset of JavaScript to the WebAssembly text format of
// scripts/wat.mjs, using the TypeScript parser of the build. Every value is an i32 and every
// operator has its i32 meaning (+, -, * wrap; / and % are signed; >>> is an unsigned shift;
// comparisons are signed), so a kernel gives the integers of the same JavaScript only while its
// values stay within 32 bits, which the kernels keep to.
//
// Supported: function declarations with parameters; let/const with an initializer; =, op= and ++/--
// on locals; if/else, while, do-while, for, labelled loops with break/continue, return; the
// operators above, !, ~, unary -, &&, || and ?: (all giving 0 or 1 or an operand); integer
// literals, true and false; names of `constants`; calls to other kernels, to `externs` (functions
// of the module declared elsewhere, with their result count) and to memory intrinsics: load8u,
// load8s, load16u, load16s, load32(addr) and store8, store16, store32(addr, value), plus clz32(x),
// ltu/leu/gtu/geu(a, b) for unsigned comparisons, min/max(a, b) for signed ones, and fill8(addr,
// byte, n) and copy8(dst, src, n) for memory.fill and memory.copy.
//
// Functions named inline_* are expanded at each call instead: their parameters bind the arguments,
// other names resolve in the caller (so they may update the caller's locals), and a final
// `return value` gives the result.

import ts from 'typescript';

const LOADS = {
    load8u: 'i32.load8_u',
    load8s: 'i32.load8_s',
    load16u: 'i32.load16_u',
    load16s: 'i32.load16_s',
    load32: 'i32.load',
};
const STORES = { store8: 'i32.store8', store16: 'i32.store16', store32: 'i32.store' };
const UNSIGNED = { ltu: 'i32.lt_u', leu: 'i32.le_u', gtu: 'i32.gt_u', geu: 'i32.ge_u' };
const BINARY = {
    [ts.SyntaxKind.PlusToken]: 'i32.add',
    [ts.SyntaxKind.MinusToken]: 'i32.sub',
    [ts.SyntaxKind.AsteriskToken]: 'i32.mul',
    [ts.SyntaxKind.SlashToken]: 'i32.div_s',
    [ts.SyntaxKind.PercentToken]: 'i32.rem_s',
    [ts.SyntaxKind.AmpersandToken]: 'i32.and',
    [ts.SyntaxKind.BarToken]: 'i32.or',
    [ts.SyntaxKind.CaretToken]: 'i32.xor',
    [ts.SyntaxKind.LessThanLessThanToken]: 'i32.shl',
    [ts.SyntaxKind.GreaterThanGreaterThanToken]: 'i32.shr_s',
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: 'i32.shr_u',
    [ts.SyntaxKind.LessThanToken]: 'i32.lt_s',
    [ts.SyntaxKind.LessThanEqualsToken]: 'i32.le_s',
    [ts.SyntaxKind.GreaterThanToken]: 'i32.gt_s',
    [ts.SyntaxKind.GreaterThanEqualsToken]: 'i32.ge_s',
    [ts.SyntaxKind.EqualsEqualsToken]: 'i32.eq',
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: 'i32.eq',
    [ts.SyntaxKind.ExclamationEqualsToken]: 'i32.ne',
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: 'i32.ne',
};
const COMPOUND = {
    [ts.SyntaxKind.PlusEqualsToken]: 'i32.add',
    [ts.SyntaxKind.MinusEqualsToken]: 'i32.sub',
    [ts.SyntaxKind.AsteriskEqualsToken]: 'i32.mul',
    [ts.SyntaxKind.AmpersandEqualsToken]: 'i32.and',
    [ts.SyntaxKind.BarEqualsToken]: 'i32.or',
    [ts.SyntaxKind.CaretEqualsToken]: 'i32.xor',
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: 'i32.shl',
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: 'i32.shr_s',
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: 'i32.shr_u',
};

class FunctionCompiler {
    constructor(compiler, node) {
        this.compiler = compiler;
        this.node = node;
        this.name = node.name.text;
        this.params = node.parameters.map(param => param.name.text);
        this.locals = new Set(this.params);
        /** Scopes of declared names: source name to local name. */
        this.scopes = [new Map(this.params.map(name => [name, name]))];
        /**
         * Enclosing loops innermost last: labels to break to and continue at, and the source label
         * if any.
         */
        this.loops = [];
        this.labelCount = 0;
        this.pendingLabel = null;
        /** Depth of inline expansions being compiled, where return is not allowed. */
        this.inlining = 0;
    }

    fail(node, message) {
        const source = node.getSourceFile();
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        throw new Error(
            `wasm-scalar: ${this.name} line ${line + 1}: ${message}: ${node.getText()}`,
        );
    }

    lookup(name) {
        for (let k = this.scopes.length - 1; k >= 0; k--)
            if (this.scopes[k].has(name)) return this.scopes[k].get(name);
        return undefined;
    }

    declare(name) {
        let local = name;
        for (let k = 2; this.locals.has(local); k++) local = `${name}_${k}`;
        this.locals.add(local);
        this.scopes[this.scopes.length - 1].set(name, local);
        return local;
    }

    compile() {
        const body = this.block(this.node.body.statements);
        const results = this.compiler.returns(this.node) ? ' (result i32)' : '';
        const exported = this.compiler.exported.has(this.name) ? ` (export "${this.name}")` : '';
        const params = this.params.map(name => `(param $${name} i32)`).join(' ');
        const locals = [...this.locals]
            .filter(name => !this.params.includes(name))
            .map(name => `(local $${name} i32)`)
            .join(' ');
        // A function with a result ends in unreachable code after its last return.
        const tail = results ? '\n(unreachable)' : '';
        return `(func $${this.name}${exported} ${params}${results} ${locals}\n${body}${tail}\n)`;
    }

    block(statements) {
        this.scopes.push(new Map());
        const code = statements.map(statement => this.statement(statement)).join('\n');
        this.scopes.pop();
        return code;
    }

    statement(node) {
        const kind = node.kind;
        if (kind === ts.SyntaxKind.Block) return this.block(node.statements);
        if (kind === ts.SyntaxKind.VariableStatement) {
            return node.declarationList.declarations
                .map(declaration => {
                    if (!ts.isIdentifier(declaration.name)) this.fail(declaration, 'destructuring');
                    const value = declaration.initializer
                        ? this.expression(declaration.initializer)
                        : '(i32.const 0)';
                    const local = this.declare(declaration.name.text);
                    return `(local.set $${local} ${value})`;
                })
                .join('\n');
        }
        if (kind === ts.SyntaxKind.ExpressionStatement) return this.effect(node.expression);
        if (kind === ts.SyntaxKind.IfStatement) {
            const then = this.statement(node.thenStatement);
            const otherwise = node.elseStatement
                ? `(else\n${this.statement(node.elseStatement)})`
                : '';
            return `(if ${this.condition(node.expression)}\n(then\n${then})${otherwise})`;
        }
        if (kind === ts.SyntaxKind.LabeledStatement) {
            this.pendingLabel = node.label.text;
            return this.statement(node.statement);
        }
        if (kind === ts.SyntaxKind.WhileStatement)
            return this.loop(null, node.expression, node.statement, null, false);
        if (kind === ts.SyntaxKind.DoStatement)
            return this.loop(null, node.expression, node.statement, null, true);
        if (kind === ts.SyntaxKind.ForStatement) {
            this.scopes.push(new Map());
            let init = '';
            if (node.initializer) {
                if (ts.isVariableDeclarationList(node.initializer)) {
                    init = node.initializer.declarations
                        .map(declaration => {
                            const value = this.expression(declaration.initializer);
                            return `(local.set $${this.declare(declaration.name.text)} ${value})`;
                        })
                        .join('\n');
                } else init = this.effect(node.initializer);
            }
            const code = this.loop(init, node.condition, node.statement, node.incrementor, false);
            this.scopes.pop();
            return code;
        }
        if (kind === ts.SyntaxKind.BreakStatement || kind === ts.SyntaxKind.ContinueStatement) {
            const loop = node.label
                ? this.loops.findLast(entry => entry.source === node.label.text)
                : this.loops[this.loops.length - 1];
            if (!loop) this.fail(node, 'no enclosing loop');
            return `(br ${kind === ts.SyntaxKind.BreakStatement ? loop.exit : loop.next})`;
        }
        if (kind === ts.SyntaxKind.ReturnStatement) {
            if (this.inlining) this.fail(node, 'return before the end of an inline function');
            return node.expression ? `(return ${this.expression(node.expression)})` : '(return)';
        }
        if (kind === ts.SyntaxKind.EmptyStatement) return '';
        return this.fail(node, 'unsupported statement');
    }

    /** while/do/for: `(block $exit (loop $top cond? (block $next body) incr (br $top)))`. */
    loop(init, condition, body, incrementor, testAfter) {
        const id = this.labelCount++;
        const exit = `$exit${id}`;
        const top = `$top${id}`;
        const next = `$next${id}`;
        this.loops.push({ exit, next, source: this.pendingLabel });
        this.pendingLabel = null;
        const test = condition ? `(br_if ${exit} (i32.eqz ${this.condition(condition)}))` : '';
        const code = this.statement(body);
        this.loops.pop();
        const step = incrementor ? this.effect(incrementor) : '';
        const loop = testAfter
            ? `(loop ${top}\n(block ${next}\n${code})\n(br_if ${top} ${this.condition(condition)}))`
            : `(loop ${top}\n${test}\n(block ${next}\n${code})\n${step}\n(br ${top}))`;
        return `${init ?? ''}\n(block ${exit}\n${loop})`;
    }

    /** An expression evaluated for its effects. */
    effect(node) {
        if (ts.isParenthesizedExpression(node)) return this.effect(node.expression);
        if (ts.isBinaryExpression(node)) {
            const operator = node.operatorToken.kind;
            if (operator === ts.SyntaxKind.EqualsToken)
                return this.assign(node.left, this.expression(node.right));
            if (operator in COMPOUND) {
                const target = this.target(node.left);
                return this.assign(
                    node.left,
                    `(${COMPOUND[operator]} (local.get $${target}) ${this.expression(node.right)})`,
                );
            }
            if (operator === ts.SyntaxKind.CommaToken)
                return `${this.effect(node.left)}\n${this.effect(node.right)}`;
        }
        if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
            const operator = node.operator;
            if (
                operator === ts.SyntaxKind.PlusPlusToken ||
                operator === ts.SyntaxKind.MinusMinusToken
            ) {
                const target = this.target(node.operand);
                const op = operator === ts.SyntaxKind.PlusPlusToken ? 'i32.add' : 'i32.sub';
                return `(local.set $${target} (${op} (local.get $${target}) (i32.const 1)))`;
            }
        }
        if (ts.isCallExpression(node)) {
            const [code, results] = this.call(node);
            return results ? `(drop ${code})` : code;
        }
        return this.fail(node, 'expression without effect');
    }

    target(node) {
        if (!ts.isIdentifier(node)) this.fail(node, 'assignment to a non-local');
        const local = this.lookup(node.text);
        if (!local) this.fail(node, 'assignment to an undeclared name');
        return local;
    }

    assign(left, value) {
        return `(local.set $${this.target(left)} ${value})`;
    }

    /** A value used as a condition: comparisons and logical operators already give 0 or 1. */
    condition(node) {
        return this.expression(node);
    }

    call(node) {
        if (!ts.isIdentifier(node.expression)) this.fail(node, 'call of a non-name');
        const name = node.expression.text;
        if (name.startsWith('inline_')) return this.inline(node, name);
        const args = node.arguments.map(arg => this.expression(arg));
        if (name in LOADS) return [`(${LOADS[name]} ${args[0]})`, 1];
        if (name in STORES) return [`(${STORES[name]} ${args[0]} ${args[1]})`, 0];
        if (name in UNSIGNED) return [`(${UNSIGNED[name]} ${args[0]} ${args[1]})`, 1];
        if (name === 'clz32') return [`(i32.clz ${args[0]})`, 1];
        if (name === 'fill8') return [`(memory.fill ${args[0]} ${args[1]} ${args[2]})`, 0];
        if (name === 'copy8') return [`(memory.copy ${args[0]} ${args[1]} ${args[2]})`, 0];
        if (name === 'min' || name === 'max') {
            const a = this.temporary(args[0]);
            const b = this.temporary(args[1]);
            const compare = name === 'min' ? 'i32.lt_s' : 'i32.gt_s';
            return [`(select ${a.get} ${b.get} (${compare} ${a.get} ${b.get}))`, 1, [a.set, b.set]];
        }
        const results = this.compiler.resultsOf(name, node);
        return [`(call $${name} ${args.join(' ')})`, results];
    }

    /**
     * Expands a call of an inline function (a block of its statements, yielding its final return
     * value).
     */
    inline(node, name) {
        const fn = this.compiler.inlineFunction(name, node);
        const args = node.arguments.map(arg => this.expression(arg));
        this.scopes.push(new Map());
        const sets = fn.parameters.map(
            (param, k) => `(local.set $${this.declare(param.name.text)} ${args[k]})`,
        );
        const statements = fn.body.statements;
        const last = statements[statements.length - 1];
        const value =
            last && ts.isReturnStatement(last) && last.expression ? last.expression : null;
        this.inlining++;
        const body = (value ? statements.slice(0, -1) : statements).map(statement =>
            this.statement(statement),
        );
        this.inlining--;
        const result = value ? this.expression(value) : null;
        this.scopes.pop();
        const code = [...sets, ...body].join('\n');
        return result ? [`(block (result i32)\n${code}\n${result})`, 1] : [`(block\n${code})`, 0];
    }

    /** A fresh local holding `value`, for operands read twice. */
    temporary(value) {
        const local = this.declare(`t${this.labelCount++}`);
        return { set: `(local.set $${local} ${value})`, get: `(local.get $${local})` };
    }

    expression(node) {
        if (ts.isParenthesizedExpression(node)) return this.expression(node.expression);
        if (ts.isNumericLiteral(node)) return `(i32.const ${BigInt.asIntN(32, BigInt(node.text))})`;
        if (node.kind === ts.SyntaxKind.TrueKeyword) return '(i32.const 1)';
        if (node.kind === ts.SyntaxKind.FalseKeyword) return '(i32.const 0)';
        if (ts.isIdentifier(node)) {
            const local = this.lookup(node.text);
            if (local) return `(local.get $${local})`;
            if (node.text in this.compiler.constants)
                return `(i32.const ${this.compiler.constants[node.text] | 0})`;
            return this.fail(node, 'unknown name');
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const operand = this.expression(node.operand);
            switch (node.operator) {
                case ts.SyntaxKind.MinusToken:
                    return `(i32.sub (i32.const 0) ${operand})`;
                case ts.SyntaxKind.PlusToken:
                    return operand;
                case ts.SyntaxKind.TildeToken:
                    return `(i32.xor ${operand} (i32.const -1))`;
                case ts.SyntaxKind.ExclamationToken:
                    return `(i32.eqz ${operand})`;
                default:
                    return this.fail(node, 'unsupported unary operator');
            }
        }
        if (ts.isBinaryExpression(node)) {
            const operator = node.operatorToken.kind;
            if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
                return (
                    `(if (result i32) ${this.expression(node.left)} (then ` +
                    `${this.truth(node.right)}) (else ` +
                    '(i32.const 0)))'
                );
            }
            if (operator === ts.SyntaxKind.BarBarToken) {
                return (
                    `(if (result i32) ${this.expression(node.left)} (then (i32.const 1)) ` +
                    `(else ${this.truth(node.right)}))`
                );
            }
            if (operator in BINARY) {
                return (
                    `(${BINARY[operator]} ${this.expression(node.left)} ` +
                    `${this.expression(node.right)})`
                );
            }
            return this.fail(node, 'unsupported operator');
        }
        if (ts.isConditionalExpression(node)) {
            return `(if (result i32) ${this.condition(node.condition)} (then ${this.expression(
                node.whenTrue,
            )}) (else ${this.expression(node.whenFalse)}))`;
        }
        if (ts.isCallExpression(node)) {
            const [code, results, setup] = this.call(node);
            if (!results) this.fail(node, 'call without a result used as a value');
            // Operands needing temporaries are evaluated first inside a block yielding the value.
            return setup ? `(block (result i32) ${setup.join(' ')} ${code})` : code;
        }
        return this.fail(node, 'unsupported expression');
    }

    /** `node` as 0 or 1 (the operands of && and || are used as truth values). */
    truth(node) {
        return `(i32.ne ${this.expression(node)} (i32.const 0))`;
    }
}

/**
 * Compiles the function declarations of `source`. `exported` names the functions exported under
 * their own name, `constants` maps names to integers, `externs` maps other callable function names
 * to their result count.
 */
export function compileScalar(source, { exported = [], constants = {}, externs = {} } = {}) {
    const file = ts.createSourceFile('kernels.js', source, ts.ScriptTarget.ES2022, true);
    const declarations = file.statements.filter(ts.isFunctionDeclaration);
    const inlined = new Map(
        declarations.filter(fn => fn.name.text.startsWith('inline_')).map(fn => [fn.name.text, fn]),
    );
    const functions = declarations.filter(fn => !inlined.has(fn.name.text));
    const returning = new Map();
    const hasValueReturn = node => {
        let found = false;
        const visit = child => {
            if (
                ts.isFunctionDeclaration(child) ||
                ts.isFunctionExpression(child) ||
                ts.isArrowFunction(child)
            )
                return;
            if (ts.isReturnStatement(child) && child.expression) found = true;
            ts.forEachChild(child, visit);
        };
        ts.forEachChild(node.body, visit);
        return found;
    };
    for (const fn of functions) returning.set(fn.name.text, hasValueReturn(fn));
    const compiler = {
        constants,
        exported: new Set(exported),
        returns: fn => returning.get(fn.name.text),
        inlineFunction(name, node) {
            if (!inlined.has(name))
                throw new Error(`wasm-scalar: unknown inline function in ${node.getText()}`);
            return inlined.get(name);
        },
        resultsOf(name, node) {
            if (returning.has(name)) return returning.get(name) ? 1 : 0;
            if (name in externs) return externs[name];
            throw new Error(`wasm-scalar: unknown function ${name} in ${node.getText()}`);
        },
    };
    return functions.map(fn => new FunctionCompiler(compiler, fn).compile());
}
