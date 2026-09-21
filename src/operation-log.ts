/**
 * 操作ログの純粋ヘルパー (Issue #18)。
 *
 * AGENTS.md §12 の日付ページ追記をモデルが Slack スレッド上で実行できる
 * ようにするための、I/O の無い小さな部品集である。Cosense への書き込みは
 * 行わず、日付タイトルの組み立て・ログ行の組み立て・検証と、規約の機械的
 * な番人だけを持つ。実際の書き込みは既存の previewEdit / previewNewPage →
 * submitEdit 経由 (runCosenseWithInputFile、記法衝突チェック) で行い、
 * このモジュールはその前段の「何を作るか・何をしてはならないか」を定める。
 * ページ本文をシェルに直書きする経路は作らない (§16)。
 *
 * §12 との対応:
 *  - 日付ページ (YYYY/MM/DD) に1行ずつ append → datePageTitleFor (§12)
 *  - 各行は動詞で始める → LOG_VERBS (ingest.ts が正本) + buildQueryLogLine /
 *    buildLintLogLine / buildDraftLogLine + buildIngestLogLine (ingest.ts)
 *  - 動詞は増やさない → validateDatePageBody / validateLogLine (§12)
 *  - [synthesis]/[question]/[idea] は操作の動詞で記録 → logVerbForRecord (§12)
 *  - 新規日付ページの1行目は [log] → buildNewDatePageBody (§12)
 *  - 既存ページは末尾に1行追加 → planDatePageAppendOps (insertBefore _end)
 *  - bot の署名は付けない → hasSignatureMark / validateDatePageBody (§13)
 *
 * 動詞の正本は src/ingest.ts の LOG_VERBS である。このモジュールは動詞の
 * 一覧を重複して持たず、必ずそこから import して使う。Issue 文面は3動詞
 * (ingest/query/lint) だが、現行 AGENTS.md は draft を含む4動詞であり、
 * draft を削らず、新動詞も足さない。
 */

import type { CosenseEditOp } from "./cosense-edit";
import {
	buildDatePageLine,
	isDatePageLine,
	LOG_VERBS,
	type LogVerb,
} from "./ingest";

// ---------------------------------------------------------------------------
// 日付ページ (§12)
// ---------------------------------------------------------------------------

/** 日付ページ本文1行目の型 (§2 + §12)。 */
export const LOG_TYPE_LINE = "[log]";

/** 日付ページタイトルの形 (YYYY/MM/DD §12)。 */
export const DATE_PAGE_TITLE_PATTERN = /^\d{4}\/\d{2}\/\d{2}$/;

/** 日付ページのタイトルか。 */
export function isDatePageTitle(title: string): boolean {
	return DATE_PAGE_TITLE_PATTERN.test(title.trim());
}

/**
 * Date から日付ページタイトル (YYYY/MM/DD) を作る。
 *
 * TODAY の判定は JST (Asia/Tokyo) で行う (§12「その日の日付ページ」)。
 * Intl.DateTimeFormat に timeZone を渡して切り出すので、Worker の実行
 * TZ に依存しない。例: 2026-09-21。
 */
export function datePageTitleFor(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		throw new Error("無効な Date から日付ページタイトルは作れない");
	}
	const ymd = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
	return ymd.replaceAll("-", "/");
}

/** 今日の日付ページタイトル (JST)。既定は now = new Date()。 */
export function todayDatePageTitle(now: Date = new Date()): string {
	return datePageTitleFor(now);
}

// ---------------------------------------------------------------------------
// ログ行の組み立て (動詞は LOG_VERBS のみ §12)
// ---------------------------------------------------------------------------

/**
 * query の日付ページ行: `query <要旨>` (§12)。
 *
 * 要旨には固有名詞・概念の [ ] リンクを含めてよい (§4)。前後の空白は
 * 落とす。動詞は buildDatePageLine 経由で組み立てる。
 */
export function buildQueryLogLine(gist: string): string {
	return buildDatePageLine("query", gist.trim());
}

/** lint の日付ページ行: `lint <要旨>` (§12)。 */
export function buildLintLogLine(gist: string): string {
	return buildDatePageLine("lint", gist.trim());
}

/**
 * draft の日付ページ行: `draft [<article のページ名>]` (§12 + §14 draft)。
 *
 * 骨子の作成も執筆も同じ1行になる。どこまで進んだかは [article] の
 * status が持つのでログで区別しない (§12)。
 */
export function buildDraftLogLine(articleTitle: string): string {
	return buildDatePageLine("draft", `[${articleTitle.trim()}]`);
}

/**
 * 汎用の日付ページ行。動詞は LOG_VERBS の語に限る (§12)。
 *
 * ingest 行は ingest.ts の buildIngestLogLine を使うこと。ここでは
 * query / lint / draft の3 builder と同じく buildDatePageLine に委譲し、
 * 動詞の正本を一箇所に保つ。
 */
export function buildOperationLogLine(verb: LogVerb, rest: string): string {
	return buildDatePageLine(verb, rest);
}

// ---------------------------------------------------------------------------
// [synthesis]/[question]/[idea] の動詞解決 (§12)
// ---------------------------------------------------------------------------

/** 操作の中で生じうる記録の種別 (§12)。動詞ではない。 */
export type OperationRecordKind = "synthesis" | "question" | "idea";

/**
 * [synthesis]/[question]/[idea] を書いた記録の動詞を返す (§12)。
 *
 * どの操作の中で生じたかで決まり、新しい動詞は作らない。取り込みの過程
 * で synthesis を更新したなら ingest、問われて比較や分析を書いたなら
 * query、アイデアの書き留めも query。戻り値の型が LogVerb なので、
 * synthesis/question/idea/log/progress 等を動詞として返す経路は型で塞ぐ。
 */
export function logVerbForRecord(
	operation: LogVerb,
	_record: OperationRecordKind,
): LogVerb {
	return operation;
}

// ---------------------------------------------------------------------------
// 署名なし (§13: 無署名であること自体が LLM の署名)
// ---------------------------------------------------------------------------

const ICON_MARK_PATTERN = /\[[^\[\]\s]+\.icon\]/;

/** bot のログ行に署名 ([*.icon]) が混ざっているか。 */
export function hasSignatureMark(line: string): boolean {
	return ICON_MARK_PATTERN.test(line);
}

// ---------------------------------------------------------------------------
// 日付ページ本文の組み立てと検証 (§12)
// ---------------------------------------------------------------------------

/**
 * 新規日付ページの本文 (タイトル行を除く) を組み立てる。
 *
 * 1行目は [log]、2行目が最初のログ行 (§12)。previewNewPage の input-file
 * 内容は buildNewDatePageInput で作る (1行目がタイトル、2行目以降が本文)。
 * 呼び出し側は事前に validateLogLine でログ行を検証すること。
 */
export function buildNewDatePageBody(firstLogLine: string): string {
	return `${LOG_TYPE_LINE}\n${firstLogLine}`;
}

/**
 * previewNewPage に渡す入力全文を作る (タイトル + 本文)。
 *
 * previewNewPage の body は「1行目がタイトル、2行目以降が本文」なので、
 * 日付タイトルと buildNewDatePageBody を結合したものを
 * runCosenseWithInputFile 経由でのみ CLI へ渡す。シェルに本文を直書き
 * する経路 (printf | やヒアドキュメント) は作らない (§16)。
 */
export function buildNewDatePageInput(
	title: string,
	firstLogLine: string,
): string {
	return `${title.trim()}\n${buildNewDatePageBody(firstLogLine)}`;
}

/**
 * 既存日付ページへの追記 ops を作る。
 *
 * EXACTLY ONE 行だけをページ末尾に足す (insertBefore _end §16 追記優先)。
 * 呼び出し側は既存の previewEdit → 検証 → submitEdit (§16) で確定する。
 * ops JSON は buildOpsJson 経由で組み立て、本文は runCosenseWithInputFile
 * でのみ渡す。
 */
export function planDatePageAppendOps(logLine: string): CosenseEditOp[] {
	return [{ insertBefore: "_end", text: logLine }];
}

/** 単一ログ行の検証。違反があれば1件の指摘を返し、無ければ undefined。 */
export function validateLogLine(line: string): string | undefined {
	if (!isDatePageLine(line)) {
		return `ログ行は ${LOG_VERBS.join(" / ")} のいずれかで始めること。動詞は増やさない (§12)`;
	}
	if (hasSignatureMark(line)) {
		return "bot のログ行に署名 ([*.icon]) を付けないこと。無署名であること自体が署名 (§13)";
	}
	return undefined;
}

/**
 * 日付ページ本文 (タイトル行を除く) の検証 (§12 + §13)。違反が無ければ
 * 空配列を返す。
 *
 * - 本文1行目は [log] (§12)
 * - 2行目以降の空でない各行は LOG_VERBS で始まる1行 (§12)。synthesis /
 *   question / idea / log / progress 等の新動詞はここで落ちる
 * - bot のログ行に署名 ([*.icon]) を付けない (§13)
 * - Infobox (table:infobox) を書かない。書いたページ自体が定義ページに
 *   なり、リンクした全ページが捏造行として表に並ぶ (§5)
 * - 「関連ページ」節を手書きしない (§4)
 */
export function validateDatePageBody(body: string): string[] {
	const errors: string[] = [];
	const lines = body.split("\n");
	if ((lines[0] ?? "").trim() !== LOG_TYPE_LINE) {
		errors.push(`本文1行目は ${LOG_TYPE_LINE} にすること (§12)`);
	}
	const logLines = lines.slice(1).filter((line) => line.trim() !== "");
	if (logLines.length === 0) {
		errors.push(
			`日付ページには ${LOG_TYPE_LINE} の次にログ行を1行以上書くこと (§12)`,
		);
	}
	for (const line of logLines) {
		const violation = validateLogLine(line.trim());
		if (violation !== undefined) errors.push(violation);
	}
	if (/(^|\n)table:infobox/.test(body)) {
		errors.push(
			`日付ページに Infobox を書かないこと。書いたページ自体が定義ページになり、リンクした全ページが捏造行として表に並ぶ (§5)`,
		);
	}
	if (lines.some((line) => line.trim() === "関連ページ")) {
		errors.push(`「関連ページ」節を手書きしないこと (§4)`);
	}
	return errors;
}

/**
 * system prompt (ROLE) に埋める操作ログのガード文。§12 の要点だけを短く
 * 持ち、詳細は AGENTS.md §12/§13/§14/§16 が正本。prompt.ts がこの定数を
 * そのまま貼ることで、文言の二重持ちを防ぐ。
 */
export const OPERATION_LOG_GUARDRAIL_TEXT = [
	"操作のあと (§12) の守り:",
	"- 操作が完了するたび、その日の日付ページ (JST の YYYY/MM/DD) に EXACTLY ONE 行だけ追記する。単一のログページは作らない",
	"- 動詞は ingest / query / draft / lint の4つだけ (ingest.ts の LOG_VERBS が正本)。synthesis / question / idea / log / progress 等の新動詞を作らない",
	"- [synthesis] [question] [idea] を書いた記録は、どの操作の中で生じたかで動詞が決まる (ingest なら ingest 行、query なら query 行)。draft の骨子作成も執筆も同じ draft 行",
	"- 新規日付ページの本文1行目は [log]、次がログ行。既存ページは末尾に1行追加 (insertBefore _end)",
	"- bot のログ行に署名 ([*.icon]) を付けない。無署名であること自体が署名 (§13)",
	"- 必ず previewEdit / previewNewPage で dry-run して適用後ページを確認し、確認できたものだけ submitEdit で確定する (§16)。ページ本文をシェルに直書きしない",
].join("\n");
