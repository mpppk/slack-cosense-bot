/**
 * ingest 一式の純粋ヘルパー (Issue #16)。
 *
 * AGENTS.md §14 ingest の 10 手順をモデルが Slack スレッド上で実行できる
 * ようにするための、I/O の無い小さな部品集である。Cosense への書き込みは
 * 行わず、ページ本文の組み立て・検証と、規約の機械的な番人だけを持つ。
 * 実際の書き込みは既存の previewEdit / previewNewPage → submitEdit 経由
 * (runCosenseWithInputFile、記法衝突チェック) で行い、このモジュールは
 * その前段の「何を作るか・何をしてはならないか」を定める。
 *
 * 10 手順との対応:
 *  1. source ページ作成 → buildRawSourceBody / buildBookmarkStubBody (§6)
 *  2. takeaways の会話確認 → confirmRequirementForStep + INGEST_CONFIRM_POLICY_TEXT (禁止C)
 *  3. summary 作成 → buildSummaryBody / validateSummaryBody (§7)
 *  4. source へのリンク付与 → §6 の範囲であり本文検証は checkNotationCollisions 側
 *  5. concept/person/organization の作成・追記 → 型は1行目の型名のみ (TYPE_LINES)
 *  6. thesis 更新 → validateThesisEvidence (禁止A) + validateThesisConfidence
 *  7. synthesis 更新 → shouldConsiderNewSynthesis (2本目で検討)
 *  8. idea 更新 → canUpdateIdea / validateNewIdeaCreation (禁止B)
 *  9. 日付ページ追記 → buildIngestLogLine / isDatePageLine (§12)
 * 10. 依頼行の片付け → planMarkerWriteback (Issue #14) を使う。ここでは扱わない。
 *
 * 禁止C (手順2の確認範囲) の設計 — URL貼り自体が明示指示 (§13省略記法)
 * かつ ingest 系の書き戻しは無承認で即時反映する決定と整合させる:
 * - 確認が要るのは手順2の takeaways の内容だけ。スレッドに草案を投稿し、
 *   ユーザーの返信を待ってから手順3以降へ進む。修正指示があれば反映して
 *   再提示する。確認なしに summary の書き込みへ進んではならない。
 * - 手順1 (原文転記の範囲内の source 作成) と手順3〜10 は、URL貼りの指示
 *   と takeaways 合意の転記なので、個別の再承認は要らない。preview→検証→
 *   submit の手順 (§16) だけを守る。
 * - 確認の有無にかかわらずやらないこと: idea の新規作成 (禁止B)、thesis
 *   への generated 根拠の追加 (禁止A)、done/dropped の idea への接触。
 * - URL に文が添えられていれば文を優先する。「意見だけ聞かせて」なら
 *   取り込まない (isBareUrlIngestRequest)。
 */

// ---------------------------------------------------------------------------
// source ページの3形態 (§6 識別)
// ---------------------------------------------------------------------------

/** raw ページのタイトル接頭辞 (U+1F4C4、異体字セレクタ無し)。 */
export const RAW_PREFIX = "📄";
/** bookmark ページのタイトル接頭辞 (U+1F516、異体字セレクタ無し)。 */
export const BOOKMARK_PREFIX = "🔖";
/** raw ページ本文1行目の型。 */
export const RAW_TYPE_LINE = "#raw";
/** 仮置き bookmark 本文1行目の型。 */
export const BOOKMARK_TYPE_LINE = "#bookmark";
/** summary / bookmark summary 本文1行目の型。 */
export const SUMMARY_TYPE_LINE = "[summary]";
/** bookmark summary の本文2行目に置く由来タグ (§7)。層の印ではない。 */
export const BOOKMARK_ORIGIN_TAG = "#bookmark";

/**
 * source 層の判定 (§6 識別をそのまま写した唯一の判定式)。
 *
 * タイトルが 📄 で始まる、または本文1行目が #bookmark のページが source
 * 層で、残りは wiki 層である。🔖 タイトルでも本文1行目が [summary] の
 * bookmark summary は wiki 層なので false になる。
 */
export function isSourceLayerPage(title: string, firstLine: string): boolean {
	return title.startsWith(RAW_PREFIX) || firstLine === BOOKMARK_TYPE_LINE;
}

export type SourcePageKind =
	| "raw"
	| "bookmark-stub"
	| "bookmark-summary"
	| "unclassified";

/**
 * タイトルと本文1行目から source の形態を分類する。
 *
 * - raw: 📄タイトル + 本文1行目 #raw (全文転記の原本)
 * - bookmark-stub: 本文1行目 #bookmark (URL 保持の仮置き。summary 未作成)
 * - bookmark-summary: 🔖タイトル + 本文1行目 [summary] (wiki 層。§7差分)
 * - unclassified: 上のいずれでもない (通常の wiki ページ等)
 */
export function classifySourcePage(
	title: string,
	firstLine: string,
): SourcePageKind {
	if (title.startsWith(RAW_PREFIX) && firstLine === RAW_TYPE_LINE) return "raw";
	if (firstLine === BOOKMARK_TYPE_LINE) return "bookmark-stub";
	if (title.startsWith(BOOKMARK_PREFIX) && firstLine === SUMMARY_TYPE_LINE) {
		return "bookmark-summary";
	}
	return "unclassified";
}

/**
 * raw ページのタイトルを作る。絵文字と原題の間に空白を入れない (§3)。
 * 空白は URL 上で `_` に変換され、区切り位置が戻ってしまうため。
 */
export function rawSourceTitle(originalTitle: string): string {
	return `${RAW_PREFIX}${originalTitle.trim()}`;
}

/** bookmark ページのタイトルを作る。同じく空白を入れない。 */
export function bookmarkTitle(urlTitle: string): string {
	return `${BOOKMARK_PREFIX}${urlTitle.trim()}`;
}

export interface RawSourceBodyParams {
	/** 対応する summary ページのタイトル。raw の2行目にリンクする (§6)。 */
	summaryTitle: string;
	/** 転記した原文テキスト (要約・省略・並べ替えをしない §6)。 */
	rawText: string;
}

/**
 * raw ページ本文を組み立てる。1行目 #raw、2行目は対応する [summary]
 * ページへのリンク、3行目以降が転記原文。Infobox は持たせない (§5)。
 */
export function buildRawSourceBody(params: RawSourceBodyParams): string {
	return `${RAW_TYPE_LINE}\n[${params.summaryTitle}]\n\n${params.rawText}`;
}

export interface BookmarkStubBodyParams {
	/** 対応する [summary] へのリンク。未作成なら空リンクのつもりで渡す。 */
	summaryTitle: string;
	/** そのソース自身の URL。本文に裸の URL 行として置く (Infobox は書かない)。 */
	url: string;
}

/**
 * 仮置き bookmark 本文を組み立てる。1行目 #bookmark (source 層の印)、
 * 2行目は対応する [summary] へのリンク、3行目に URL。summary を書く
 * 段階になったら bookmark summary (§7差分) に起こす。
 */
export function buildBookmarkStubBody(params: BookmarkStubBodyParams): string {
	return `${BOOKMARK_TYPE_LINE}\n[${params.summaryTitle}]\n${params.url}`;
}

/**
 * source ページ本文の検証。違反が無ければ空配列を返す。
 *
 * - 本文1行目は #raw / #bookmark / [summary] のいずれか
 * - source 層 (#raw / #bookmark) のページに Infobox (table:infobox) を
 *   書かない (§5)。出典メタデータは summary 側が持つ
 * - 📄タイトルの本文1行目は #raw、🔖タイトルの仮置きは #bookmark
 */
export function validateSourceBody(title: string, body: string): string[] {
	const errors: string[] = [];
	const lines = body.split("\n");
	const firstLine = (lines[0] ?? "").trim();
	if (
		firstLine !== RAW_TYPE_LINE &&
		firstLine !== BOOKMARK_TYPE_LINE &&
		firstLine !== SUMMARY_TYPE_LINE
	) {
		errors.push(
			`本文1行目は ${RAW_TYPE_LINE} / ${BOOKMARK_TYPE_LINE} / ${SUMMARY_TYPE_LINE} のいずれかにすること (§6)`,
		);
	}
	if (
		(firstLine === RAW_TYPE_LINE || firstLine === BOOKMARK_TYPE_LINE) &&
		/(^|\n)table:infobox/.test(body)
	) {
		errors.push(
			`source ページ (${firstLine}) に Infobox を書かないこと。メタデータは summary 側が持つ (§5)`,
		);
	}
	if (title.startsWith(RAW_PREFIX) && firstLine !== RAW_TYPE_LINE) {
		errors.push(
			`タイトルが ${RAW_PREFIX} で始まるページの本文1行目は ${RAW_TYPE_LINE} にすること (§6)`,
		);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// summary ページ (§7)
// ---------------------------------------------------------------------------

/** summary の credibility に許す閉じた値集合 (§5)。 */
export const SUMMARY_CREDIBILITIES = [
	"peer-reviewed",
	"preprint",
	"primary",
	"secondary",
	"blog",
	"generated",
] as const;

export type SummaryCredibility = (typeof SUMMARY_CREDIBILITIES)[number];

/** thesis の confidence に許す4段階 (§5)。 */
export const THESIS_CONFIDENCES = ["high", "medium", "low", "open"] as const;

export type ThesisConfidence = (typeof THESIS_CONFIDENCES)[number];

export interface SummaryInfobox {
	gist: string;
	kind: string;
	author?: string;
	published?: string;
	ingested: string;
	/** 対応する source ページへのリンク先タイトル。bookmark summary では省略。 */
	raw?: string;
	/** そのソース自身の URL。参考文献 URL は references 節に置く。 */
	url?: string;
	credibility: SummaryCredibility | string;
}

export interface SummaryReference {
	label: string;
	url: string;
	/** 子行の一言 (原文由来か自分の探索かを区別して書く §7)。 */
	note?: string;
}

export interface SummaryBodyParams {
	infobox: SummaryInfobox;
	/** 自分の言葉で書いた箇条書き。固有名詞・概念は [ ] で囲む (§7)。 */
	takeaways: string[];
	/** 原文ママ。3〜5個まで (§7)。 */
	quotes?: string[];
	/** そのソースの限界 (検証範囲・時点・サンプル・利益相反)。 */
	caveats?: string[];
	/** そのソースの外側の URL。5件程度、多くても10件 (§7)。 */
	references?: SummaryReference[];
	/** true のとき §7 bookmark summary 形式 (2行目 #bookmark、raw 省略)。 */
	bookmarkSummary?: boolean;
}

/** summary の節名。takeaways は型ではなく節名であることに注意 (§2)。 */
export const SUMMARY_SECTIONS = [
	"takeaways",
	"quotes",
	"caveats",
	"references",
] as const;

function infoboxLine(key: string, value: string): string {
	return ` ${key}\t${value}`;
}

/**
 * §7構成の summary 本文を組み立てる。bookmarkSummary のときは2行目に
 * #bookmark を置き raw キーを省く (§7差分)。呼び出し側は事前に
 * validateSummaryBody で検証済みの値を渡すこと。
 */
export function buildSummaryBody(params: SummaryBodyParams): string {
	const { infobox } = params;
	const lines: string[] = [SUMMARY_TYPE_LINE];
	if (params.bookmarkSummary) lines.push(BOOKMARK_ORIGIN_TAG);
	lines.push("", "table:infobox");
	lines.push(infoboxLine("gist", infobox.gist));
	lines.push(infoboxLine("kind", infobox.kind));
	if (infobox.author !== undefined) {
		lines.push(infoboxLine("author", infobox.author));
	}
	if (infobox.published !== undefined) {
		lines.push(infoboxLine("published", infobox.published));
	}
	lines.push(infoboxLine("ingested", infobox.ingested));
	if (!params.bookmarkSummary && infobox.raw !== undefined) {
		lines.push(infoboxLine("raw", `[${infobox.raw}]`));
	}
	if (infobox.url !== undefined) {
		lines.push(infoboxLine("url", infobox.url));
	}
	lines.push(infoboxLine("credibility", infobox.credibility));
	lines.push("", "takeaways");
	for (const item of params.takeaways) {
		for (const itemLine of item.split("\n")) {
			lines.push(` ${itemLine}`);
		}
	}
	if (params.quotes && params.quotes.length > 0) {
		lines.push("", "quotes");
		for (const quote of params.quotes) {
			for (const quoteLine of quote.split("\n")) {
				lines.push(` ${quoteLine}`);
			}
		}
	}
	if (params.caveats && params.caveats.length > 0) {
		lines.push("", "caveats");
		for (const caveat of params.caveats) {
			for (const caveatLine of caveat.split("\n")) {
				lines.push(` ${caveatLine}`);
			}
		}
	}
	if (params.references && params.references.length > 0) {
		lines.push("", "references");
		for (const reference of params.references) {
			lines.push(` [${reference.label} ${reference.url}]`);
			if (reference.note !== undefined) {
				for (const noteLine of reference.note.split("\n")) {
					lines.push(`  ${noteLine}`);
				}
			}
		}
	}
	return lines.join("\n");
}

/** Infobox の ` key\tvalue` 行から value を抜く。無ければ undefined。 */
function infoboxValue(body: string, key: string): string | undefined {
	const match = new RegExp(`^ ${key}\t(.*)$`, "m").exec(body);
	return match?.[1]?.trim();
}

/** `[URL]` (ラベル無し) のブラケット断片があるか。画像埋め込みになる (§7)。 */
function hasUnlabeledUrl(body: string): boolean {
	for (const match of body.matchAll(/\[([^\[\]\n]*)\]/g)) {
		if (/^https?:\/\/\S+$/.test((match[1] ?? "").trim())) return true;
	}
	return false;
}

/**
 * summary 本文の検証 (§7 + §5)。違反が無ければ空配列を返す。
 *
 * - 1行目は [summary]。🔖タイトルなら2行目は #bookmark で raw キー無し、
 *   それ以外は raw キー有り (§7差分、§5)
 * - credibility は閉じた6値、ingested は YYYY-MM-DD、published は
 *   YYYY-MM(-DD) (§5)
 * - takeaways 節が必須。thesis/idea 側の極性キー (supported_by /
 *   refuted_by / enabled_by / blocked_by) を summary に書かない (§7)
 * - references は [<ラベル> <URL>] 形式 (裸の [URL] は画像埋め込み §7)。
 *   そのソース自身の URL (Infobox の url) を references に書かない (§7)
 * - 「関連ページ」節を手書きしない (§4)
 */
export function validateSummaryBody(title: string, body: string): string[] {
	const errors: string[] = [];
	const lines = body.split("\n");
	if ((lines[0] ?? "").trim() !== SUMMARY_TYPE_LINE) {
		errors.push(`本文1行目は ${SUMMARY_TYPE_LINE} にすること (§2)`);
	}
	const isBookmarkSummary = title.startsWith(BOOKMARK_PREFIX);
	if (isBookmarkSummary) {
		if ((lines[1] ?? "").trim() !== BOOKMARK_ORIGIN_TAG) {
			errors.push(
				`bookmark summary の2行目は ${BOOKMARK_ORIGIN_TAG} にすること (§7)`,
			);
		}
		if (infoboxValue(body, "raw") !== undefined) {
			errors.push(
				`bookmark summary に raw を書かないこと。降りる先の source ページが無い (§5)`,
			);
		}
	} else if (infoboxValue(body, "raw") === undefined) {
		errors.push(
			`raw を書くこと。省略できるのは対応 source の無い bookmark summary だけ (§5)`,
		);
	}
	const credibility = infoboxValue(body, "credibility");
	if (
		credibility === undefined ||
		!(SUMMARY_CREDIBILITIES as readonly string[]).includes(credibility)
	) {
		errors.push(
			`credibility は ${SUMMARY_CREDIBILITIES.join(" / ")} のいずれかにすること。言い換え禁止 (§5)`,
		);
	}
	const ingested = infoboxValue(body, "ingested");
	if (ingested === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(ingested)) {
		errors.push(`ingested は YYYY-MM-DD 形式で書くこと (§5)`);
	}
	const published = infoboxValue(body, "published");
	if (published !== undefined && !/^\d{4}-\d{2}(-\d{2})?$/.test(published)) {
		errors.push(`published は YYYY-MM または YYYY-MM-DD 形式で書くこと (§5)`);
	}
	if (!lines.some((line) => line.trim() === "takeaways")) {
		errors.push(`takeaways 節を書くこと (§7)`);
	}
	for (const key of [
		"supported_by",
		"refuted_by",
		"enabled_by",
		"blocked_by",
	] as const) {
		if (infoboxValue(body, key) !== undefined) {
			errors.push(
				`${key} は summary に書かないこと。thesis / idea 側に一元化する (§7)`,
			);
		}
	}
	if (hasUnlabeledUrl(body)) {
		errors.push(
			`references は [<ラベル> <URL>] の形にすること。ラベルの無い [URL] は画像埋め込みになる (§7)`,
		);
	}
	const ownUrl = infoboxValue(body, "url");
	if (ownUrl !== undefined) {
		const referencesIndex = lines.findIndex(
			(line) => line.trim() === "references",
		);
		if (
			referencesIndex !== -1 &&
			lines.slice(referencesIndex + 1).some((line) => line.includes(ownUrl))
		) {
			errors.push(
				`そのソース自身の URL は references に書かないこと。Infobox の url の役目 (§7)`,
			);
		}
	}
	if (lines.some((line) => line.trim() === "関連ページ")) {
		errors.push(`「関連ページ」節を手書きしないこと (§4)`);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// thesis 更新と禁止A (generated を supported_by / refuted_by に入れない §13)
// ---------------------------------------------------------------------------

export interface ThesisEvidenceEntry {
	summaryTitle: string;
	credibility: SummaryCredibility | string;
}

/** `generated` は LLM がこの wiki のために生成した調査結果 (§5)。 */
export function isGeneratedCredibility(
	credibility: SummaryCredibility | string,
): boolean {
	return credibility === "generated";
}

/** 根拠候補のうち generated なものだけを抜き出す。空なら thesis に使える。 */
export function findGeneratedThesisEvidence(
	entries: readonly ThesisEvidenceEntry[],
): ThesisEvidenceEntry[] {
	return entries.filter((entry) => isGeneratedCredibility(entry.credibility));
}

/**
 * thesis の supported_by / refuted_by 更新の検証 (禁止A)。
 *
 * generated なソースが1件でも混ざればエラーを返す。LLM の出力を LLM が
 * 要約して確信度の根拠にすると、新しい証拠が増えないまま confidence
 * だけが上がるため (§13)。生成レポートは次に読むべき一次資料の索引と
 * して使い、別途 ingest した一次資料だけを根拠にする。違反が無ければ
 * 空配列。
 */
export function validateThesisEvidence(
	supportedBy: readonly ThesisEvidenceEntry[],
	refutedBy: readonly ThesisEvidenceEntry[],
): string[] {
	const errors: string[] = [];
	for (const entry of [...supportedBy, ...refutedBy]) {
		if (isGeneratedCredibility(entry.credibility)) {
			errors.push(
				`generated なソース「${entry.summaryTitle}」を thesis の supported_by / refuted_by に入れないこと (§13)`,
			);
		}
	}
	return errors;
}

/** confidence は high / medium / low / open の4段階。言い換え禁止 (§5)。 */
export function validateThesisConfidence(
	confidence: string,
): string | undefined {
	if (!(THESIS_CONFIDENCES as readonly string[]).includes(confidence)) {
		return `confidence は ${THESIS_CONFIDENCES.join(" / ")} のいずれかにすること (§5)`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// idea 更新と禁止B (LLM の判断で idea を立てない §8)
// ---------------------------------------------------------------------------

/** idea の status は open / done / dropped の3値。進捗は追わない (§8)。 */
export const IDEA_STATUSES = ["open", "done", "dropped"] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** status が閉じた3値に収まるか。 */
export function validateIdeaStatus(status: string): string | undefined {
	if (!(IDEA_STATUSES as readonly string[]).includes(status)) {
		return `status は ${IDEA_STATUSES.join(" / ")} のいずれかにすること (§8)`;
	}
	return undefined;
}

/**
 * その idea に触ってよいか (§14手順8)。status が done / dropped のものは
 * 触らない。open のときだけ true。
 */
export function canUpdateIdea(status: IdeaStatus | string): boolean {
	return status === "open";
}

/**
 * idea 新規作成の検証 (禁止B)。[idea] はユーザーの意志の記録であり、
 * 作るのはユーザーが指示したときだけ (§8)。明示指示が無いのにモデルが
 * 「作れそう」と判断して立てる経路をここで塞ぐ。作ってよいときだけ
 * undefined を返す。
 */
export function validateNewIdeaCreation(
	userExplicitlyRequested: boolean,
): string | undefined {
	if (!userExplicitlyRequested) {
		return "LLM の判断で [idea] を立てないこと。作るのはユーザーが指示したときだけ (§8)";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// synthesis (§14手順7) と日付ページ (§12)
// ---------------------------------------------------------------------------

/**
 * 同じ主題のソースが揃った数から、新規 [synthesis] の検討が要るかを返す。
 * 2本目が揃った時点で立てられないか検討する (§14手順7)。1本で書ける
 * なら summary、2つ以上必要なら synthesis (§2)。
 */
export function shouldConsiderNewSynthesis(
	sameTopicSourceCount: number,
): boolean {
	return sameTopicSourceCount >= 2;
}

/** 日付ページの行頭動詞。§14の4操作と同じ語だけ。これ以上増やさない (§12)。 */
export const LOG_VERBS = ["ingest", "query", "draft", "lint"] as const;

export type LogVerb = (typeof LOG_VERBS)[number];

/** ingest の日付ページ行: `ingest [<summary のタイトル>]` (§12)。 */
export function buildIngestLogLine(summaryTitle: string): string {
	return `ingest [${summaryTitle}]`;
}

/** 日付ページの1行を組み立てる。動詞は4操作の語に限る (§12)。 */
export function buildDatePageLine(verb: LogVerb, rest: string): string {
	return `${verb} ${rest}`;
}

/** 日付ページの行が規約の動詞で始まるか。 */
export function isDatePageLine(line: string): boolean {
	return LOG_VERBS.some(
		(verb) => line === verb || line.startsWith(`${verb} `),
	);
}

// ---------------------------------------------------------------------------
// 禁止C: チャット投稿の意図判定と確認範囲の設計
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/\S+/g;
const SLACK_LINK_PATTERN = /<https?:\/\/[^|>]+(?:\|[^>]+)?>/g;

/**
 * Slack チャット投稿が「URLだけの ingest 依頼」かを判定する (§13省略記法)。
 *
 * URL だけを貼る行為そのものが ingest の指示なので、取り込み可否を聞き
 * 返さない (§0 の「明示的に指示した時のみ」を満たす)。文が添えられて
 * いればそちらが優先で、「これ読んで意見だけ聞かせて」なら取り込まない。
 * Slack 記法の <url|label> も URL として除去してから残り文を見る。
 */
export function isBareUrlIngestRequest(messageText: string): boolean {
	const withoutLinks = messageText.replace(SLACK_LINK_PATTERN, " ");
	const withoutUrls = withoutLinks.replace(URL_PATTERN, " ");
	return withoutUrls.trim() === "" && URL_PATTERN.test(messageText);
}

export type IngestStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type ConfirmRequirement =
	| "url-is-instruction"
	| "thread-confirmation"
	| "proceed-without-reasking";

/**
 * 手順ごとの確認要件 (禁止Cの設計。詳細は INGEST_CONFIRM_POLICY_TEXT)。
 *
 * - 手順1: URL貼り自体が明示指示 (§13) なので聞き返さない
 * - 手順2: 唯一の対話ゲート。takeaways 草案をスレッドに投稿し、ユーザー
 *   の返信を待ってから手順3以降へ。確認なしに書き込みへ進まない
 * - 手順3〜10: takeaways 合意の転記なので再確認なし (§16 の preview→
 *   検証→submit だけ守る)
 */
export function confirmRequirementForStep(step: IngestStep): ConfirmRequirement {
	if (step === 1) return "url-is-instruction";
	if (step === 2) return "thread-confirmation";
	return "proceed-without-reasking";
}

/**
 * 確認範囲の設計文 (禁止C)。system prompt の運用指針と unit test がこの
 * 定数を正本として参照する。AGENTS.md の規約自体は変えない。
 */
export const INGEST_CONFIRM_POLICY_TEXT = [
	"ingest の確認は手順2の takeaways だけに寄せる。",
	"手順1 (source 作成) は URL 貼り自体が明示指示 (§13) なので「取り込みますか」と聞き返さない。",
	"手順2では takeaways 草案をスレッドに投稿し、ユーザーの返信を待つ。修正指示があれば反映して再提示し、確認なしに手順3以降の書き込みへ進まない。",
	"手順3〜10 (summary / source リンク / concept 等 / thesis / synthesis / idea 更新 / 日付ページ / 依頼行片付け) は takeaways 合意の転記なので、個別の再承認は要らない。必ず previewEdit / previewNewPage で dry-run して適用後ページを確認し、確認できたものだけ submitEdit で確定する (§16)。",
	"確認の有無にかかわらずやらないこと: LLM の判断での idea 新規作成 (§8)、generated なソースの thesis への根拠入れ (§13)、done / dropped の idea への接触 (§8)。",
	"URL に文が添えられていれば文を優先する。「意見だけ聞かせて」なら取り込まない (§13)。",
].join("\n");

/**
 * system prompt (ROLE) に埋める ingest ガード文。禁止A/B/C の要点だけを
 * 短く持ち、詳細は AGENTS.md §13/§14 が正本。prompt.ts がこの定数を
 * そのまま貼ることで、文言の二重持ちを防ぐ。
 */
export const INGEST_GUARDRAIL_TEXT = [
	"ingest (チャットの URL 貼り→§14 の10手順) の守り:",
	"- URL だけの投稿は ingest 依頼 (§13)。「取り込みますか」と聞き返さず手順1から始める。文が添えられていれば文を優先し、「意見だけ」なら取り込まない",
	"- 手順2の takeaways だけスレッドで確認する (草案を投稿→返信待ち→修正は反映して再提示)。確認なしに手順3以降の書き込みへ進まない",
	"- 手順3〜10は takeaways 合意の転記なので再確認なし。必ず preview→確認→submit (§16)",
	"- generated な credibility の summary を thesis の supported_by / refuted_by に入れない (§13)",
	"- LLM の判断で idea を新規作成しない。done / dropped の idea は触らない (§8)",
].join("\n");
