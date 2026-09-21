import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	BOOKMARK_PREFIX,
	buildBookmarkStubBody,
	buildDatePageLine,
	buildIngestLogLine,
	buildRawSourceBody,
	buildSummaryBody,
	canUpdateIdea,
	classifySourcePage,
	confirmRequirementForStep,
	INGEST_CONFIRM_POLICY_TEXT,
	INGEST_GUARDRAIL_TEXT,
	isBareUrlIngestRequest,
	isDatePageLine,
	isGeneratedCredibility,
	isSourceLayerPage,
	RAW_PREFIX,
	shouldConsiderNewSynthesis,
	validateIdeaStatus,
	validateNewIdeaCreation,
	validateSourceBody,
	validateSummaryBody,
	validateThesisConfidence,
	validateThesisEvidence,
	type SummaryBodyParams,
} from "../src/ingest";

mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => {
		throw new Error("must not reach the Sandbox in unit tests");
	},
}));

const { createCosenseTools } = await import("../src/tools/cosense");

function rawSummaryParams(): SummaryBodyParams {
	return {
		infobox: {
			gist: "[再帰]を使わず[Attention]だけで系列変換ができる",
			kind: "論文",
			author: "[Ashish Vaswani]",
			published: "2017-06",
			ingested: "2026-08-05",
			raw: "📄Attention Is All You Need",
			url: "https://arxiv.org/abs/1706.03762",
			credibility: "peer-reviewed",
		},
		takeaways: [
			"[RNN]の逐次計算が並列化を阻んでいる",
			"[Transformer]は[Self-Attention]のみで構成する\n 位置情報は[Positional Encoding]で与える",
		],
		quotes: ["We propose a new simple network architecture."],
		caveats: ["実験は[機械翻訳]のみ"],
		references: [
			{
				label: "Layer Normalization",
				url: "https://arxiv.org/abs/1607.06450",
				note: "原文が挙げている",
			},
		],
	};
}

describe("source 層の判定 (§6 識別)", () => {
	test("raw ページは source 層", () => {
		expect(isSourceLayerPage("📄Attention Is All You Need", "#raw")).toBe(true);
	});

	test("仮置き bookmark は source 層", () => {
		expect(isSourceLayerPage("🔖Attention Is All You Need", "#bookmark")).toBe(
			true,
		);
	});

	test("bookmark summary (🔖 + [summary]) は wiki 層", () => {
		expect(isSourceLayerPage("🔖Attention Is All You Need", "[summary]")).toBe(
			false,
		);
	});

	test("ふつうの wiki ページは source 層ではない", () => {
		expect(isSourceLayerPage("Transformer", "[concept]")).toBe(false);
	});
});

describe("source 3形態の分類と組み立て (§6)", () => {
	test("raw / bookmark-stub / bookmark-summary を分類する", () => {
		expect(classifySourcePage("📄Foo", "#raw")).toBe("raw");
		expect(classifySourcePage("🔖Foo", "#bookmark")).toBe("bookmark-stub");
		expect(classifySourcePage("🔖Foo", "[summary]")).toBe("bookmark-summary");
		expect(classifySourcePage("Foo", "[concept]")).toBe("unclassified");
	});

	test("タイトルは絵文字直付け (空白なし §3)", () => {
		expect("📄Foo".startsWith(RAW_PREFIX)).toBe(true);
		expect("🔖Foo".startsWith(BOOKMARK_PREFIX)).toBe(true);
	});

	test("raw 本文は #raw + summary リンク + 原文で検証を通る", () => {
		const body = buildRawSourceBody({
			summaryTitle: "Attention Is All You Need",
			rawText: "原文テキスト",
		});
		expect(body.split("\n")[0]).toBe("#raw");
		expect(body.split("\n")[1]).toBe("[Attention Is All You Need]");
		expect(validateSourceBody("📄Attention Is All You Need", body)).toEqual(
			[],
		);
	});

	test("仮置き bookmark 本文は #bookmark 始まりで検証を通る", () => {
		const body = buildBookmarkStubBody({
			summaryTitle: "Attention Is All You Need",
			url: "https://example.com/paper",
		});
		expect(body.split("\n")[0]).toBe("#bookmark");
		expect(validateSourceBody("🔖Attention Is All You Need", body)).toEqual(
			[],
		);
	});

	test("source ページの Infobox は違反 (§5)", () => {
		const body = "#raw\n[Foo]\n\ntable:infobox\n gist\tx";
		expect(validateSourceBody("📄Foo", body).join("\n")).toContain(
			"Infobox を書かない",
		);
	});

	test("📄タイトルに #raw 以外の1行目は違反", () => {
		expect(
			validateSourceBody("📄Foo", "[summary]\n\ntakeaways\n x").join("\n"),
		).toContain("#raw");
	});

	test("本文1行目の型が3種以外は違反", () => {
		expect(validateSourceBody("Foo", "ただの本文").length).toBeGreaterThan(0);
	});
});

describe("summary の組み立てと検証 (§7)", () => {
	test("raw 持ち summary は §7構成になり検証を通る", () => {
		const body = buildSummaryBody(rawSummaryParams());
		const lines = body.split("\n");
		expect(lines[0]).toBe("[summary]");
		expect(body).toContain("table:infobox");
		expect(body).toContain("takeaways");
		expect(body).toContain(" raw\t[📄Attention Is All You Need]");
		expect(body).toContain(
			" [Layer Normalization https://arxiv.org/abs/1607.06450]",
		);
		expect(validateSummaryBody("Attention Is All You Need", body)).toEqual(
			[],
		);
	});

	test("bookmark summary は2行目 #bookmark・raw 無しで検証を通る", () => {
		const params = rawSummaryParams();
		const body = buildSummaryBody({
			...params,
			infobox: {
				gist: params.infobox.gist,
				kind: "ブログ記事",
				ingested: "2026-08-14",
				url: "https://example.com/blog/mcp-authorization",
				credibility: "blog",
			},
			bookmarkSummary: true,
		});
		expect(body.split("\n")[1]).toBe("#bookmark");
		expect(body).not.toContain(" raw\t");
		expect(validateSummaryBody("🔖MCP Authorization", body)).toEqual([]);
	});

	test("bookmark summary に raw があると違反", () => {
		const body = buildSummaryBody(rawSummaryParams());
		const withBookmarkTitle = body.replace("[summary]", "[summary]\n#bookmark");
		expect(
			validateSummaryBody("🔖Foo", withBookmarkTitle).join("\n"),
		).toContain("raw を書かない");
	});

	test("raw 無しの通常 summary は違反", () => {
		const params = rawSummaryParams();
		const { raw: _omitted, ...infobox } = params.infobox;
		expect(
			validateSummaryBody("Foo", buildSummaryBody({ ...params, infobox })).join(
				"\n",
			),
		).toContain("raw を書くこと");
	});

	test("takeaways 無し・極性キー・裸URL・関連ページ節は違反", () => {
		const noTakeaways = "[summary]\n\ntable:infobox\n gist\tx\n credibility\tblog\n ingested\t2026-08-05\n raw\t[📄Foo]";
		expect(validateSummaryBody("Foo", noTakeaways).join("\n")).toContain(
			"takeaways",
		);

		const withThesisKey = `${buildSummaryBody(rawSummaryParams())}\n supported_by\t[Foo]`;
		expect(validateSummaryBody("Foo", withThesisKey).join("\n")).toContain(
			"summary に書かない",
		);

		const withBareUrl = `${buildSummaryBody(rawSummaryParams())}\n[https://example.com/foo.png]`;
		expect(validateSummaryBody("Foo", withBareUrl).join("\n")).toContain(
			"[<ラベル>",
		);

		const withRelated = `${buildSummaryBody(rawSummaryParams())}\n関連ページ`;
		expect(validateSummaryBody("Foo", withRelated).join("\n")).toContain(
			"関連ページ",
		);
	});

	test("credibility・日付の書式違反を検出する", () => {
		const params = rawSummaryParams();
		const badCredibility = buildSummaryBody({
			...params,
			infobox: { ...params.infobox, credibility: "査読付き" },
		});
		expect(
			validateSummaryBody("Foo", badCredibility).join("\n"),
		).toContain("credibility");

		const badDate = buildSummaryBody({
			...params,
			infobox: { ...params.infobox, ingested: "2026/08/05" },
		});
		expect(validateSummaryBody("Foo", badDate).join("\n")).toContain(
			"ingested",
		);
	});

	test("自身の URL を references に書くと違反", () => {
		const params = rawSummaryParams();
		const body =
			`${buildSummaryBody(params)}\n https://arxiv.org/abs/1706.03762`;
		expect(validateSummaryBody("Foo", body).join("\n")).toContain(
			"references に書かない",
		);
	});
});

describe("禁止A: generated を thesis の根拠に入れない (§13)", () => {
	test("generated を検出する", () => {
		expect(isGeneratedCredibility("generated")).toBe(true);
		expect(isGeneratedCredibility("peer-reviewed")).toBe(false);
		expect(isGeneratedCredibility("blog")).toBe(false);
	});

	test("supported_by の generated は違反", () => {
		const errors = validateThesisEvidence(
			[{ summaryTitle: "調査メモ", credibility: "generated" }],
			[],
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("調査メモ");
		expect(errors[0]).toContain("supported_by / refuted_by");
	});

	test("refuted_by の generated も違反", () => {
		const errors = validateThesisEvidence(
			[],
			[{ summaryTitle: "調査メモ", credibility: "generated" }],
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("調査メモ");
	});

	test("一次資料だけなら違反なし", () => {
		expect(
			validateThesisEvidence(
				[
					{ summaryTitle: "論文A", credibility: "peer-reviewed" },
					{ summaryTitle: "記事B", credibility: "blog" },
				],
				[{ summaryTitle: "論文C", credibility: "preprint" }],
			),
		).toEqual([]);
	});

	test("confidence は4段階のみ", () => {
		expect(validateThesisConfidence("high")).toBeUndefined();
		expect(validateThesisConfidence("かなり高い")).toContain("confidence");
	});
});

describe("禁止B: LLM の判断で idea を立てない (§8)", () => {
	test("明示指示なしの新規作成は違反", () => {
		expect(validateNewIdeaCreation(false)).toContain("[idea]");
	});

	test("明示指示ありの新規作成は通る", () => {
		expect(validateNewIdeaCreation(true)).toBeUndefined();
	});

	test("done / dropped の idea は触らない (§14手順8)", () => {
		expect(canUpdateIdea("open")).toBe(true);
		expect(canUpdateIdea("done")).toBe(false);
		expect(canUpdateIdea("dropped")).toBe(false);
	});

	test("status は3値のみ", () => {
		expect(validateIdeaStatus("open")).toBeUndefined();
		expect(validateIdeaStatus("進行中")).toContain("status");
	});
});

describe("synthesis と日付ページ (§14手順7, §12)", () => {
	test("同じ主題の2本目で synthesis を検討する", () => {
		expect(shouldConsiderNewSynthesis(1)).toBe(false);
		expect(shouldConsiderNewSynthesis(2)).toBe(true);
		expect(shouldConsiderNewSynthesis(3)).toBe(true);
	});

	test("ingest の日付行は `ingest [<title>]` (§12)", () => {
		expect(buildIngestLogLine("Attention Is All You Need")).toBe(
			"ingest [Attention Is All You Need]",
		);
		expect(buildDatePageLine("query", "認可の動き")).toBe("query 認可の動き");
		expect(isDatePageLine("ingest [Foo]")).toBe(true);
		expect(isDatePageLine("draft [Bar]")).toBe(true);
		expect(isDatePageLine("今日のメモ")).toBe(false);
		expect(isDatePageLine("progress 進捗")).toBe(false);
	});
});

describe("禁止C: 確認範囲の設計 (Slack スレッド)", () => {
	test("URL だけの投稿は ingest 依頼 (§13省略記法)", () => {
		expect(isBareUrlIngestRequest("https://example.com/paper")).toBe(true);
		expect(
			isBareUrlIngestRequest("<https://example.com/paper|論文タイトル>"),
		).toBe(true);
	});

	test("文が添えられていれば文を優先し、取り込まない", () => {
		expect(
			isBareUrlIngestRequest("https://example.com/paper これ読んで意見だけ聞かせて"),
		).toBe(false);
		expect(isBareUrlIngestRequest("この件どう思う?")).toBe(false);
	});

	test("手順1は指示済み・手順2だけ対話ゲート・手順3〜10は再確認なし", () => {
		expect(confirmRequirementForStep(1)).toBe("url-is-instruction");
		expect(confirmRequirementForStep(2)).toBe("thread-confirmation");
		for (const step of [3, 4, 5, 6, 7, 8, 9, 10] as const) {
			expect(confirmRequirementForStep(step)).toBe("proceed-without-reasking");
		}
	});

	test("確認方針文は takeaways 確認と preview→submit を明記する", () => {
		expect(INGEST_CONFIRM_POLICY_TEXT).toContain("takeaways");
		expect(INGEST_CONFIRM_POLICY_TEXT).toContain("previewEdit");
		expect(INGEST_CONFIRM_POLICY_TEXT).toContain("submitEdit");
	});
});

describe("配線: ガード文が prompt とツール説明に届く", () => {
	test("ガード文は3つの禁止に触れる", () => {
		expect(INGEST_GUARDRAIL_TEXT).toContain("generated");
		expect(INGEST_GUARDRAIL_TEXT).toContain("idea");
		expect(INGEST_GUARDRAIL_TEXT).toContain("takeaways");
	});

	test("prompt.ts の ROLE がガード文を埋め込む (二重持ち防止)", () => {
		const promptSource = readFileSync(
			new URL("../src/prompt.ts", import.meta.url),
			"utf-8",
		);
		expect(promptSource).toContain("INGEST_GUARDRAIL_TEXT");
	});

	test("書き込みツールの説明が ingest 規約に触れる", () => {
		const tools = createCosenseTools({
			env: {
				COSENSE_ORIGIN: "https://scrapbox.io",
				COSENSE_PROJECTS: "niki-auth",
				COSENSE_PAT: "pat_test_token",
			} as never,
			model: {} as never,
			channelId: () => "C123",
		});
		const descriptionOf = (name: string): string => {
			const tool = (tools as Record<string, unknown>)[name] as {
				description?: unknown;
			};
			expect(typeof tool?.description).toBe("string");
			return tool.description as string;
		};
		expect(descriptionOf("previewEdit")).toContain("takeaways");
		expect(descriptionOf("previewEdit")).toContain("generated");
		expect(descriptionOf("previewNewPage")).toContain("idea");
		expect(descriptionOf("submitEdit")).toContain("takeaways");
	});
});
