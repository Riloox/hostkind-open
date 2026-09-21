import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * The only strings `typeof` can ever produce. Comparisons against anything
 * else (e.g. `typeof x === "integer"`) are dead conditions that can never be
 * true, so they are always reported.
 */
const TYPEOF_RESULTS = new Set([
	"string",
	"number",
	"boolean",
	"bigint",
	"symbol",
	"function",
	"undefined",
	"object",
]);

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Strip parenthesis and optional-chaining wrappers that do not change meaning. */
function unwrapExpression(node: ESTree.Expression): ESTree.Expression {
	let current = node;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "ChainExpression"
	) {
		current = current.expression;
	}
	return current;
}

/** Structural equality of expressions, ignoring parens and chain wrappers. */
function sameExpression(aNode: ESTree.Expression, bNode: ESTree.Expression): boolean {
	const a = unwrapExpression(aNode);
	const b = unwrapExpression(bNode);
	if (a.type === "Identifier" && b.type === "Identifier") {
		return a.name === b.name;
	}
	if (a.type === "ThisExpression" && b.type === "ThisExpression") {
		return true;
	}
	if (
		a.type === "Literal" &&
		b.type === "Literal" &&
		typeof a.value !== "object" &&
		typeof b.value !== "object"
	) {
		return Object.is(a.value, b.value);
	}
	if (a.type === "CallExpression" && b.type === "CallExpression") {
		if (a.arguments.length !== b.arguments.length) return false;
		if (!sameExpression(a.callee, b.callee)) return false;
		return a.arguments.every((arg, index) => {
			const other = b.arguments[index];
			if (arg.type === "SpreadElement" || other.type === "SpreadElement") {
				return arg.type === "SpreadElement" && other.type === "SpreadElement"
					? sameExpression(arg.argument, other.argument)
					: false;
			}
			return sameExpression(arg, other);
		});
	}
	// Member expressions: oxc models them as Static/Computed/PrivateField
	// nodes, but all expose `object` and `property`.
	if ("object" in a && "property" in a && "object" in b && "property" in b) {
		const am = a as ESTree.MemberExpression;
		const bm = b as ESTree.MemberExpression;
		return (
			am.computed === bm.computed &&
			sameExpression(am.object, bm.object) &&
			sameExpression(am.property, bm.property)
		);
	}
	return false;
}

function isDescendantOf(node: ESTree.Node, ancestor: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

interface GuardEvidence {
	excludesNull: boolean;
	excludesArray: boolean;
}

function isNullLiteral(node: ESTree.Expression): boolean {
	return node.type === "Literal" && node.value === null;
}

function isArrayIsArrayCall(node: ESTree.Node): boolean {
	const callee = node.type === "CallExpression" ? node.callee : null;
	if (!callee) return false;
	const member = unwrapExpression(callee);
	if (member.type !== "MemberExpression") return false;
	return (
		member.object.type === "Identifier" &&
		member.object.name === "Array" &&
		member.property.type === "Identifier" &&
		member.property.name === "isArray"
	);
}

/**
 * Scan a guard expression for facts that must hold when control reaches the
 * checked `typeof` comparison. `required` is true when the expression must be
 * truthy at that point, false when it must be falsy.
 *
 * Derivable facts are limited to what the checked operand provably is NOT:
 *  - required (must be truthy): `x !== null`, `x != null`, bare `x` (truthy),
 *    and `!Array.isArray(x)` prove the operand is not null / not an array.
 *  - not required (must be falsy): `x === null` / `x == null` and
 *    `Array.isArray(x)` prove the same, since they must be false.
 */
function scanGuardNode(
	node: ESTree.Node,
	required: boolean,
	target: ESTree.Expression,
	comparison: ESTree.BinaryExpression,
	evidence: GuardEvidence,
): void {
	switch (node.type) {
		case "ParenthesizedExpression":
		case "ChainExpression":
			scanGuardNode(node.expression, required, target, comparison, evidence);
			return;
		case "LogicalExpression":
			if (node.operator === "&&" && required) {
				scanGuardNode(node.left, true, target, comparison, evidence);
				scanGuardNode(node.right, true, target, comparison, evidence);
			} else if (node.operator === "||") {
				if (!required) {
					scanGuardNode(node.left, false, target, comparison, evidence);
					scanGuardNode(node.right, false, target, comparison, evidence);
				} else {
					// Disjunction: the side that does not contain the checked
					// comparison must be false for the comparison to decide the
					// outcome, e.g. `x === null || typeof x === "object"`.
					for (const side of [node.left, node.right]) {
						const containsComparison =
							side === comparison || isDescendantOf(comparison, side);
						scanGuardNode(
							side,
							containsComparison,
							target,
							comparison,
							evidence,
						);
					}
				}
			}
			// `??` and indeterminate shapes carry no derivable guard facts.
			return;
		case "UnaryExpression":
			scanGuardNode(node.argument, !required, target, comparison, evidence);
			return;
		case "BinaryExpression":
			if (node === comparison) return;
			if (
				(node.operator === "===" || node.operator === "==") &&
				!required
			) {
				if (
					(sameExpression(node.left, target) && isNullLiteral(node.right)) ||
					(sameExpression(node.right, target) && isNullLiteral(node.left))
				) {
					evidence.excludesNull = true;
				}
			} else if (
				(node.operator === "!==" || node.operator === "!=") &&
				required
			) {
				if (
					(sameExpression(node.left, target) && isNullLiteral(node.right)) ||
					(sameExpression(node.right, target) && isNullLiteral(node.left))
				) {
					evidence.excludesNull = true;
				}
			}
			return;
		case "CallExpression":
			if (
				!required &&
				isArrayIsArrayCall(node) &&
				node.arguments.length === 1 &&
				sameExpression(node.arguments[0], target)
			) {
				evidence.excludesArray = true;
			}
			return;
		default:
			// A bare truthiness reference to the operand (`x &&`) excludes null.
			if (
				required &&
				node.type !== "Literal" &&
				sameExpression(node as ESTree.Expression, target)
			) {
				evidence.excludesNull = true;
			}
			return;
	}
}

/** A statement that always leaves the current control-flow path. */
function alwaysExits(stmt: ESTree.Statement): boolean {
	switch (stmt.type) {
		case "ReturnStatement":
		case "ThrowStatement":
		case "BreakStatement":
		case "ContinueStatement":
			return true;
		case "BlockStatement":
			return stmt.body.length > 0 && alwaysExits(stmt.body[stmt.body.length - 1]);
		case "IfStatement":
			return (
				stmt.alternate !== null &&
				alwaysExits(stmt.consequent) &&
				alwaysExits(stmt.alternate)
			);
		default:
			return false;
	}
}

/**
 * Collect the tests that must be falsy for control to reach `ifNode`'s test:
 * the outer tests of an else-if chain and preceding sibling if-guards whose
 * branch always exits (e.g. `if (value == null) return value;`).
 */
function precedingGuardTests(ifNode: ESTree.IfStatement): Array<ESTree.Expression> {
	const tests: Array<ESTree.Expression> = [];
	let current: ESTree.Node = ifNode;
	let parent = current.parent;
	while (parent !== null && parent.type === "IfStatement" && parent.alternate === current) {
		tests.push(parent.test);
		current = parent;
		parent = current.parent;
	}
	if (parent !== null && (parent.type === "BlockStatement" || parent.type === "Program")) {
		const body = parent.body;
		const index = body.indexOf(current as ESTree.Statement);
		for (let i = index - 1; i >= 0; i -= 1) {
			const sibling = body[i];
			if (sibling.type !== "IfStatement" || !alwaysExits(sibling.consequent)) break;
			tests.push(sibling.test);
		}
	}
	return tests;
}

/**
 * A positive `typeof x === "object"` is sound only when the guard context
 * proves the operand is not null or not an array — otherwise the check
 * accepts `null` (`typeof null === "object"`) and every object kind without
 * establishing a contract.
 */
function isStrengthenedObjectCheck(
	comparison: ESTree.BinaryExpression,
	target: ESTree.Expression,
): boolean {
	let context: ESTree.Node = comparison;
	let negated = false;
	let parent = context.parent;
	while (parent !== null) {
		if (
			parent.type === "LogicalExpression" ||
			parent.type === "ParenthesizedExpression"
		) {
			context = parent;
		} else if (parent.type === "UnaryExpression" && parent.operator === "!") {
			context = parent;
			negated = !negated;
		} else {
			break;
		}
		parent = context.parent;
	}
	// A negated comparison is a rejection (`!(typeof x === "object")`), not an
	// acceptance, and carries no contract claim.
	if (negated) return true;

	const evidence: GuardEvidence = { excludesNull: false, excludesArray: false };
	scanGuardNode(context, true, target, comparison, evidence);
	const container = context.parent;
	if (container !== null && container.type === "IfStatement" && container.test === context) {
		for (const test of precedingGuardTests(container)) {
			scanGuardNode(test, false, target, comparison, evidence);
		}
	}
	return evidence.excludesNull || evidence.excludesArray;
}

/**
 * Disallow unsound runtime `typeof` comparisons.
 *
 * A `typeof` check is legitimate boundary validation when it confirms a
 * primitive (`typeof x === "string"`), probes callability
 * (`typeof fn === "function"`), or rejects non-objects — so those uses are
 * allowed. The rule only reports:
 *  - positive object acceptance without a guard that excludes `null` or
 *    arrays (`typeof null === "object"` is the classic footgun, and the check
 *    claims a contract it never establishes), and
 *  - comparisons against strings `typeof` can never produce
 *    (`typeof x === "integer"` is dead code).
 *
 * Bare `typeof` evaluations (e.g. `assert.equal(typeof fn, "function")`) are
 * allowed; the rule governs comparisons, not evaluations.
 */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow unsound `typeof` comparisons: contract-free positive object checks and comparisons that can never be true. Primitive validation, callable capability checks, and strengthened object guards are sound boundary validation and remain allowed.",
		},
		messages: {
			objectAcceptance:
				"A positive `typeof x === 'object'` check cannot establish a contract: it accepts `null` (`typeof null === 'object'`) and any object kind. Strengthen the guard (e.g. `x !== null && typeof x === 'object' && !Array.isArray(x)`) or decode the value at its I/O boundary.",
			deadTypeofComparison:
				"`typeof` only ever returns 'undefined', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function', or 'object', so this comparison can never be true. Compare against a real type name or decode the value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;

				let typeofNode: ESTree.UnaryExpression | null = null;
				let literalNode: ESTree.Node | null = null;
				if (
					node.left.type === "UnaryExpression" &&
					node.left.operator === "typeof"
				) {
					typeofNode = node.left;
					literalNode = node.right;
				} else if (
					node.right.type === "UnaryExpression" &&
					node.right.operator === "typeof"
				) {
					typeofNode = node.right;
					literalNode = node.left;
				}
				if (typeofNode === null || literalNode === null) return;
				if (allowInTypeGuards && isInsideTypeGuard(typeofNode)) return;

				const target = unwrapExpression(typeofNode.argument);

				if (literalNode.type !== "Literal") {
					// Compared against a non-literal (e.g. a variable): the
					// intent cannot be judged statically, so it is allowed.
					return;
				}
				if (typeof literalNode.value !== "string") {
					// `typeof x === 3` / `=== null` can never be true.
					context.report({ node, messageId: "deadTypeofComparison" });
					return;
				}
				if (!TYPEOF_RESULTS.has(literalNode.value)) {
					context.report({ node, messageId: "deadTypeofComparison" });
					return;
				}
				if (
					literalNode.value === "object" &&
					(node.operator === "===" || node.operator === "==") &&
					!isStrengthenedObjectCheck(node, target)
				) {
					context.report({ node, messageId: "objectAcceptance" });
				}
			},
		};
	},
});