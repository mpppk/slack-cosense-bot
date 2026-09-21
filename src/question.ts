/**
 * [question] ページの純粋ヘルパー (Issue #17)。
 *
 * AGENTS.md §14 query 手順4「回答に再利用価値があれば `[question]`
 * ページとして wiki に戻す」の前段である。Cosense への書き込みは行わず、
 * ページ本文の組み立て・検証、再利用価値の判定、孤立防止の被リンク計画
 * だけを持つ。実際の書き込みは既存の previewNewPage → submitEdit 経由
 * (runCosenseWithInputFile、記法衝突チェック) で行い、このモジュールは
 * その前段の「何を作るか・何をしてはならないか」を定める。
 * src/ingest.ts と同じ純粋ヘルパー + ガード文のパターンである。
 *
 * query 手順との対応:
 *  1. §10 の順序で検索・読解 → 既存ツール (searchVector / browsePage 等)
 *  2. 外部調査 → §13 調査結果ページ (ingest.ts の source 系ヘルパー)
 *  3. summary へのリンクを示して回答 → スレッド (書き込みなし)
 *  4. 再利用価値があれば [question] として wiki に戻す → このモジュール
 *     (judgeReuseValue → buildQuestionBody / validateQuestionBody →
 *     planQuestionBacklink → previewNewPage → 検証 → submitEdit)
 *  5. wiki 上の指示なら依頼行の片付け → planMarkerWriteback (Issue #14)
 *
 * 判定の設計 — Issue #17 の決定「最初は緩め」:
 * - 既定は valuable=true。一問一答の確認まで全部ページにすると wiki が
 *   肥大するが、慎重すぎると §12 の目的 (wiki を複利で育てる) を果たさ
 *   ない。溜まったページを見て絞る方が早いので、落とすのは挨拶・相槌・
 *   エラー・重複の trivial なものだけにする。
 * - 判定はブラックボックスにしない。judgeReuseValue は必ず reason
 *   (一言) を返し、モデルはそれをスレッドに残す。運用で基準を調整する
 *   ときは QUESTION_REUSE_THRESHOLD を切り替える。
 */

import type { CosenseEditOp } from "./cosense-edit";

// ---------------------------------------------------------------------------
// [question] ページの組み立て (§2 + §7風構成)
// ---------------------------------------------------------------------------

/** [question] ページ本文1行目の型 (§2)。 */
export const QUESTION_TYPE_LINE = "[question]";

/** [question] の節名。§0 の語彙規則に従いすべて小文字・単数形の英語。 */
export const QUESTION_SECTIONS = ["answer", "sources"] as const;

export interface QuestionSource {
	/** wiki 内の summary 等。`[タイトル]` のページリンクになる。 */
	title?: string;
	/** 外部 URL。ラベル付き `[<ラベル> <URL>]` になる (裸 URL 禁止 §7)。 */
	label?: string;
	url?: string;
}

export interface QuestionBodyParams {
	/** ページタイトル (§3: 名詞句、/ で始めない、疑似階層を作らない)。 */
	title: string;
	/** ユーザーの問いを清書した散文。固有名詞・概念は [ ] で囲む (§4)。 */
	question: string;
	/** 回答を清書したもの。固有名詞・概念は [ ] で囲む。 */
	answer: string;
	/** 回答の根拠。summary へのページリンクかラベル付き外部 URL。 */
	sources?: QuestionSource[];
	/**
	 * 回答の文脈にある concept。呼び出し側 (モデル) は answer／question
	 * の散文内で `[concept]` として言及すること。ここで渡した concept
	 * は planQuestionBacklink の被リンク元候補にもなる (§4 孤立防止)。
	 * 本文に未言及の concept は validateQuestionBody が指摘する。
	 */
	relatedConcepts?: string[];
}

/**
 * §7風の [question] 本文を組み立てる。1行目は型 (§2)、続けて問いの
 * 清書、`answer` 節に回答の清書、`sources` 節に根拠を置く。
 *
 * - Infobox は書かない。`table:infobox` を書いたページはそれ自体が定義
 *   ページになり、リンクした全ページが捏造行として表に並ぶ (§5制約2)。
 *   question に定義済みキーは無いので、書けば害にしかならない。
 * - 「関連ページ」節は書かない。被リンクの自動表示に任せる (§4)。
 *   relatedConcepts は節にせず、散文内の `[link]` 言及 + concept 側から
 *   の被リンク (planQuestionBacklink) で接続する。
 * - そのソース自身の URL を裸で置かない。`[<ラベル> <URL>]` の形にし、
 *   ラベルの無い `[URL]` は画像埋め込みになる (§7)。
 */
export function buildQuestionBody(params: QuestionBodyParams): string {
	const lines: string[] = [QUESTION_TYPE_LINE, ""];
	for (const paragraph of params.question.split("\n")) {
		lines.push(paragraph);
	}
	lines.push("", "answer");
	for (const answerLine of params.answer.split("\n")) {
		lines.push(` ${answerLine}`);
	}
	if (params.sources && params.sources.length > 0) {
		lines.push("", "sources");
		for (const source of params.sources) {
			if (source.title !== undefined) {
				lines.push(` [${source.title}]`);
			} else if (source.url !== undefined) {
				lines.push(` [${source.label ?? source.url} ${source.url}]`);
			}
		}
	}
	return lines.join("\n");
}

/** `[URL]` (ラベル無し) の断片があるか。画像埋め込みになる (§7)。 */
function hasUnlabeledUrl(body: string): boolean {
	for (const match of body.matchAll(/\[([^\[\]\n]*)\]/g)) {
		if (/^https?:\/\/\S+$/.test((match[1] ?? "").trim())) return true;
	}
	return false;
}

/** タイトルが疑似階層のプレフィックス (`concept/xxx` 等) を持つか (§3)。 */
function hasPseudoHierarchyPrefix(title: string): boolean {
	return /^[A-Za-z0-9_-]+\//.test(title);
}

/** タイトルが説明文に見えるか (文末の句点・疑問符・感嘆符 §3 名詞句)。 */
function looksLikeSentence(title: string): boolean {
	return /[。？?！!…]+$/.test(title);
}

/**
 * [question] のタイトルと本文の検証 (§2 §3 §4 §5 §6)。違反が無ければ
 * 空配列を返す。
 *
 * - 本文1行目は [question] (§2)。source 層の型 (#raw / #bookmark) 禁止
 * - タイトルは名詞句 (§3): 空・`/` 始まり・疑似階層プレフィックス・
 *   文末の句点類を拒否。summary と同じく日付や連番の付加はしない
 * - タイトルに source 層の印 (📄 / 🔖) を付けない。question は wiki 層
 *   であり、印を付ければ source 層の判定 (§6) に混ざる
 * - Infobox (table:infobox) を書かない (§5制約2: 定義ページ化と捏造行)
 * - 「関連ページ」節を手書きしない (§4)
 * - relatedConcepts に渡した concept は本文に `[link]` 言及があること。
 *   言及も被リンクも無い concept はグラフに繋がらない (§4)
 */
export function validateQuestionBody(
	title: string,
	body: string,
	relatedConcepts: readonly string[] = [],
): string[] {
	const errors: string[] = [];
	const lines = body.split("\n");
	if ((lines[0] ?? "").trim() !== QUESTION_TYPE_LINE) {
		errors.push(`本文1行目は ${QUESTION_TYPE_LINE} にすること (§2)`);
	}
	const trimmedTitle = title.trim();
	if (trimmedTitle === "") {
		errors.push(`タイトルは空にしないこと (§3)`);
	} else {
		if (trimmedTitle.startsWith("/")) {
			errors.push(
				`タイトルを / で始めないこと。[/project/page] は他プロジェクトへのリンク記法と衝突する (§3)`,
			);
		}
		if (hasPseudoHierarchyPrefix(trimmedTitle)) {
			errors.push(
				`タイトルにプレフィックスで疑似階層を作らないこと。型で表す (§3)`,
			);
		}
		if (looksLikeSentence(trimmedTitle)) {
			errors.push(
				`タイトルは名詞句にすること。説明文にしない ([...] の形で自然に書ける形 §3)`,
			);
		}
		if (trimmedTitle.startsWith("📄") || trimmedTitle.startsWith("🔖")) {
			errors.push(
				`[question] のタイトルに 📄 / 🔖 を付けないこと。question は wiki 層であり source 層の印は混ぜない (§6)`,
			);
		}
	}
	if (/(^|\n)table:infobox/.test(body)) {
		errors.push(
			`[question] に Infobox を書かないこと。書いたページ自体が定義ページになり、リンクした全ページが捏造行として表に並ぶ (§5)`,
		);
	}
	if (lines.some((line) => line.trim() === "関連ページ")) {
		errors.push(`「関連ページ」節を手書きしないこと (§4)`);
	}
	for (const concept of relatedConcepts) {
		if (!body.includes(`[${concept}]`)) {
			errors.push(
				`related concept [${concept}] が本文にリンクされていない。answer／question の散文内で [ ] で囲むこと (§4)`,
			);
		}
	}
	if (hasUnlabeledUrl(body)) {
		errors.push(
			`sources は [<ラベル> <URL>] の形にすること。ラベルの無い [URL] は画像埋め込みになる (§7)`,
		);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// 再利用価値の判定 (Issue #17「最初は緩め」)
// ---------------------------------------------------------------------------

/**
 * 再利用判定の厳しさ。運用で溜まった [question] を見ながら切り替える。
 * - "lenient": 既定。trivial (挨拶・相槌・エラー・重複・空) だけ落とす
 * - "strict": 上に加え、STRICT_MIN_CHARS 未満の短い回答も落とす
 */
export const QUESTION_REUSE_THRESHOLD = "lenient" as const;

export type QuestionReuseThreshold = typeof QUESTION_REUSE_THRESHOLD | "strict";

/** strict 判定で求める回答の最小文字数。 */
export const STRICT_MIN_ANSWER_CHARS = 40;

export interface ReuseContext {
	/** 予定している question タイトル。既存と重複すれば作らない。 */
	questionTitle?: string;
	/** 既存の [question] タイトル一覧。重複検出に使う。 */
	existingQuestionTitles?: readonly string[];
	/** 判定の厳しさ。省略時は QUESTION_REUSE_THRESHOLD。 */
	threshold?: QuestionReuseThreshold;
}

export interface ReuseJudgment {
	valuable: boolean;
	/** スレッドに一言残す判定理由 (Issue #17 Done「判定の理由が追える」)。 */
	reason: string;
}

const ACK_ONLY_PATTERN =
	/^(承知しました|了解(しました|です)?|わかりました|分かりました|かしこまりました|OK|ok|はい|ありがとう(ございます|ございました)?|どういたしまして)[。!！.\s]*$/;

const GREETING_ONLY_PATTERN =
	/^(こんにちは|こんばんは|おはよう(ございます)?|お疲れ様(です)?|はじめまして)[。!！\s]*$/;

const ERROR_PATTERN =
	/(失敗しました|エラー|分かりません|わかりません|wiki には(無い|ありません)|見つかりませんでした|取得できませんでした|タイムアウト)/;

/**
 * 回答に [question] として残す再利用価値があるかを判定する。
 *
 * lenient (既定) では valuable=true が出発点で、次の trivial なもの
 * だけを落とす:
 * - 空の回答
 * - 挨拶・相槌だけ (ACK_ONLY / GREETING_ONLY)
 * - エラー・「分からない」「wiki に無い」の報告 (ページ化する中身が無い)
 * - 既存 [question] との重複 (context.questionTitle が existingQuestionTitles にある)
 *
 * strict では短い回答 (STRICT_MIN_ANSWER_CHARS 未満) も落とす。
 * reason は常に一言返し、呼び出し側は valuable の可否にかかわらず
 * スレッドに残す (運用で基準を見直す材料にするため)。
 */
export function judgeReuseValue(
	answer: string,
	context: ReuseContext = {},
): ReuseJudgment {
	const trimmed = answer.trim();
	if (trimmed === "") {
		return { valuable: false, reason: "ページ化しない: 回答が空" };
	}
	if (GREETING_ONLY_PATTERN.test(trimmed)) {
		return { valuable: false, reason: "ページ化しない: 挨拶だけの応答" };
	}
	if (ACK_ONLY_PATTERN.test(trimmed)) {
		return { valuable: false, reason: "ページ化しない: 相槌だけの応答" };
	}
	if (ERROR_PATTERN.test(trimmed)) {
		return {
			valuable: false,
			reason: "ページ化しない: エラー／未回答の報告 (残す中身が無い)",
		};
	}
	const { questionTitle, existingQuestionTitles } = context;
	if (
		questionTitle !== undefined &&
		(existingQuestionTitles ?? []).includes(questionTitle.trim())
	) {
		return {
			valuable: false,
			reason: `ページ化しない: [${questionTitle.trim()}] と重複`,
		};
	}
	const threshold = context.threshold ?? QUESTION_REUSE_THRESHOLD;
	if (threshold === "strict" && trimmed.length < STRICT_MIN_ANSWER_CHARS) {
		return {
			valuable: false,
			reason: `ページ化しない: strict 判定で短すぎる (${trimmed.length} 文字 < ${STRICT_MIN_ANSWER_CHARS})`,
		};
	}
	return { valuable: true, reason: "再利用価値ありと判定: 回答を [question] に起こす" };
}

// ---------------------------------------------------------------------------
// 孤立防止: 関係する [concept] からの被リンク計画 (§4)
// ---------------------------------------------------------------------------

export interface QuestionBacklinkPlan {
	/** 被リンクを張る concept ページのタイトル。 */
	conceptTitle: string;
	/** concept ページ末尾に `[<question タイトル>]` を足す ops。 */
	ops: CosenseEditOp[];
}

/**
 * [question] を孤立させないための被リンク計画 (§4)。
 *
 * question から summary／concept へ外向きに張るだけでは question 自身
 * の被リンクは 0 のままなので、関係する [concept] ページの末尾に
 * `[<question タイトル>]` を1行足す ops を返す。呼び出し側は既存の
 * previewEdit → 検証 → submitEdit (§16) で確定する。
 *
 * relatedConcepts が空なら計画は作れない (undefined)。呼び出し側は
 * 必ず1件以上の候補を渡すこと。候補の先頭を被リンク元にする。
 * [summary] [thesis] [idea] [article] 型ページからは張らない (§4:
 * instance 以外からのリンクは Infobox に捏造行を作る。導線が要れば
 * 外部 URL 記法を使う)。
 */
export function planQuestionBacklink(
	questionTitle: string,
	relatedConcepts: readonly string[],
): QuestionBacklinkPlan | undefined {
	const conceptTitle = relatedConcepts[0];
	if (conceptTitle === undefined) return undefined;
	return {
		conceptTitle,
		ops: [{ insertBefore: "_end", text: `[${questionTitle.trim()}]` }],
	};
}

/**
 * system prompt (ROLE) に埋める question ガード文。§14 query 手順4の
 * 要点だけを短く持ち、詳細は AGENTS.md §2/§3/§4/§14 が正本。prompt.ts
 * がこの定数をそのまま貼ることで、文言の二重持ちを防ぐ。
 */
export const QUESTION_GUARDRAIL_TEXT = [
	"回答のあと (§14 query 手順4) の守り:",
	"- 回答に再利用価値があるか判定する。最初は緩め (既定は残す)。落とすのは挨拶・相槌・エラー・重複だけ。判定の理由をスレッドに一言残す",
	"- 価値があれば [question] ページを作る。タイトルは名詞句 (§3)。/ で始めない。疑似階層を作らない。Infobox を書かない。「関連ページ」節を書かない (§4)",
	"- 必ず previewNewPage で dry-run して適用後ページを確認し、確認できたものだけ submitEdit で確定する (§16)",
	"- 孤立させない: 関係する [concept] から1本リンクを張る (§4)。[summary] [thesis] [idea] [article] 型ページには instance 以外からリンクしない",
].join("\n");
