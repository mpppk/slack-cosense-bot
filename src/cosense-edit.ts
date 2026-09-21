import { z } from "zod";

/**
 * Edit ops for `cosense previewEdit` (Issue #15).
 *
 * The cosense CLI takes ops JSON on stdin or via `--input-file`; it has no
 * argv slot for ops. Assembling the JSON here (rather than letting the model
 * hand-write it) keeps the shape contract in one place: `insertBefore` may
 * target a line id or `_end` and may carry multi-line text, `replace` targets
 * a line id with single-line text only, `delete` targets a line id.
 */

export const insertBeforeOpSchema = z.object({
	insertBefore: z
		.string()
		.min(1)
		.describe("挿入先の行ID。ページ末尾に足すときは `_end`"),
	text: z.string().min(1).describe("挿入する行。改行を含む複数行も可"),
});

export const replaceOpSchema = z.object({
	replace: z.string().min(1).describe("置き換える行の行ID"),
	text: z
		.string()
		.min(1)
		.refine((text) => !text.includes("\n"), {
			message: "replace の text は単行のみ。改行を含む text は拒否される",
		})
		.describe("置き換え後の行（単行のみ。改行不可）"),
});

export const deleteOpSchema = z.object({
	delete: z.string().min(1).describe("削除する行の行ID"),
});

export const cosenseEditOpSchema = z.union([
	insertBeforeOpSchema,
	replaceOpSchema,
	deleteOpSchema,
]);

export type CosenseEditOp = z.infer<typeof cosenseEditOpSchema>;

/** Anchor reserved for "append at the end of the page". */
export const END_ANCHOR = "_end";

/**
 * Serialize ops to the stdin/`--input-file` JSON shape previewEdit expects.
 *
 * Throws on structural misuse the CLI would reject with 422: an empty op
 * list, a `replace` with multi-line text, or a `replace`/`delete` pointed at
 * the `_end` anchor (only `insertBefore` may use it).
 */
export function buildOpsJson(ops: CosenseEditOp[]): string {
	if (ops.length === 0) {
		throw new Error("ops が空です。1 件以上の op を指定してください");
	}
	for (const op of ops) {
		if ("replace" in op) {
			if (op.replace === END_ANCHOR) {
				throw new Error(
					`replace の anchor に ${END_ANCHOR} は使えません。行IDを指定してください`,
				);
			}
			if (op.text.includes("\n")) {
				throw new Error("replace の text は単行のみ。改行を含む text は拒否される");
			}
		}
		if ("delete" in op && op.delete === END_ANCHOR) {
			throw new Error(
				`delete の anchor に ${END_ANCHOR} は使えません。行IDを指定してください`,
			);
		}
	}
	return JSON.stringify({ ops });
}

// ---------------------------------------------------------------------------
// 記法衝突の点検 (Issue #15, 項目3)
// ---------------------------------------------------------------------------

export type NotationCollisionKind =
	| "hashtag-number"
	| "bracket-fragment"
	| "unlabeled-url";

export interface NotationCollision {
	kind: NotationCollisionKind;
	/** 1-based line number within the checked text. */
	line: number;
	/** Truncated excerpt of the offending line. */
	excerpt: string;
	/** What the model should do about it. */
	message: string;
}

const HASHTAG_NUMBER = /#\d/;
const BRACKET_SPAN = /\[([^\[\]\n]*)\]/g;
const URL_ONLY = /^https?:\/\/\S+$/;
/** Characters that never appear in an intended page-title link (§3: 名詞句). */
const CODE_CHARS = /[(){};=<>"'`*|\\]/;
const SINGLE_ALNUM = /^[A-Za-z0-9]$/;

function looksLikeCode(inner: string): boolean {
	const text = inner.trim();
	if (text === "") return true;
	if (/^\d+$/.test(text)) return true;
	if (SINGLE_ALNUM.test(text)) return true;
	if (CODE_CHARS.test(text)) return true;
	return false;
}

function excerptOf(line: string): string {
	const trimmed = line.trim();
	return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}…`;
}

/**
 * Inspect a free-text fragment (an op `text`, or a new-page body) for Cosense
 * notation collisions before it reaches previewEdit:
 *
 * - `#数字` は hashtag 記法になる (`#15` → タグ `#15` へのリンク扱い)。
 *   `#raw` / `#bookmark` は型の目印なので対象外。`#` の直後に数字が無い
 *   もの (`C#`、文末の `# ` 等) も対象外。
 * - `[]` を含むコード断片はリンク記法と衝突する (`arr[0]` の `[0]` が
 *   ページ `[0]` へのリンク扱いになる)。意図した `[ページ名]` リンクと
 *   `[ラベル URL]` 形式は警告しない。
 * - ラベルの無い `[URL]` は画像埋め込みになる。`references` 等では必ず
 *   `[<ラベル> <URL>]` と書く (§7)。
 *
 * Bracket spans are checked first; hashtag scanning runs on the text with
 * those spans removed so a URL fragment inside an intentional external link
 * (`[label https://…#123]`) is not misreported as a hashtag.
 */
export function checkNotationCollisions(text: string): NotationCollision[] {
	const collisions: NotationCollision[] = [];
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		const lineNo = index + 1;
		let stripped = "";
		let lastEnd = 0;
		for (const match of line.matchAll(BRACKET_SPAN)) {
			const inner = match[1] ?? "";
			const trimmed = inner.trim();
			stripped += line.slice(lastEnd, match.index);
			lastEnd = match.index + match[0].length;
			if (URL_ONLY.test(trimmed)) {
				collisions.push({
					kind: "unlabeled-url",
					line: lineNo,
					excerpt: excerptOf(line),
					message:
						`ラベルの無い [URL] は画像埋め込みになる。` +
						`[<ラベル> ${trimmed}] の形に直すこと`,
				});
			} else if (looksLikeCode(inner)) {
				collisions.push({
					kind: "bracket-fragment",
					line: lineNo,
					excerpt: excerptOf(line),
					message:
						`[...] がコード断片の可能性。意図したページリンクでなければ` +
						`バッククォート/コードブロックで囲むこと`,
				});
			}
		}
		stripped += line.slice(lastEnd);
		if (stripped.includes("[") || stripped.includes("]")) {
			collisions.push({
				kind: "bracket-fragment",
				line: lineNo,
				excerpt: excerptOf(line),
				message:
					`対応の取れていない [ または ] がある。` +
					`コードとして書くならバッククォート/コードブロックで囲むこと`,
			});
		}
		if (HASHTAG_NUMBER.test(stripped)) {
			collisions.push({
				kind: "hashtag-number",
				line: lineNo,
				excerpt: excerptOf(line),
				message:
					`#数字 は hashtag 記法になる。` +
					`番号として書くならバッククォートで囲むか、意図したタグか確認すること`,
			});
		}
	});
	return collisions;
}

/** Collect collisions across every op `text` in one pass. */
export function checkOpsCollisions(ops: CosenseEditOp[]): NotationCollision[] {
	return ops.flatMap((op) =>
		"text" in op ? checkNotationCollisions(op.text) : [],
	);
}

/**
 * Render collisions as model-facing guidance. Returns an empty string when
 * there is nothing to report, so callers can prepend unconditionally.
 */
export function formatCollisionReport(
	collisions: NotationCollision[],
): string {
	if (collisions.length === 0) return "";
	const lines = collisions.map(
		(collision, index) =>
			`${index + 1}. [${collision.kind}] ${collision.line}行目: ${collision.excerpt}\n   → ${collision.message}`,
	);
	return (
		`記法衝突の疑いが ${collisions.length} 件ある。` +
		`意図した記法か確認し、違うものは直してから previewEdit をやり直すこと:\n` +
		lines.join("\n")
	);
}
