import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildOpsJson } from "../src/cosense-edit";
import { isSourceLayerPage } from "../src/ingest";
import {
	buildQuestionBody,
	judgeReuseValue,
	planQuestionBacklink,
	QUESTION_GUARDRAIL_TEXT,
	QUESTION_REUSE_THRESHOLD,
	QUESTION_TYPE_LINE,
	STRICT_MIN_ANSWER_CHARS,
	validateQuestionBody,
	type QuestionBodyParams,
} from "../src/question";

mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => {
		throw new Error("must not reach the Sandbox in unit tests");
	},
}));

const { createCosenseTools } = await import("../src/tools/cosense");

function questionParams(): QuestionBodyParams {
	return {
		title: "MCPの認可の仕組み",
		question: "MCP の認可は2026年以降どう動いているか。[MCP] の仕様を知りたい。",
		answer:
			" [OAuth] ベースの認可で、[認可サーバ] がトークンを発行する\n  詳細は仕様の改定で変わることがある",
		sources: [{ title: "MCP Authorization の調査" }],
		relatedConcepts: ["MCP", "OAuth"],
	};
}

describe("[question] の組み立て (§2 + §7風構成)", () => {
	test("1行目は [question] で answer／sources 節を持つ", () => {
		const body = buildQuestionBody(questionParams());
		const lines = body.split("\n");
		expect(lines[0]).toBe("[question]");
		expect(lines[0]).toBe(QUESTION_TYPE_LINE);
		expect(body).toContain("answer");
		expect(body).toContain("sources");
		expect(body).toContain(" [MCP Authorization の調査]");
	});

	test("組み立てた本文は検証を通る", () => {
		const params = questionParams();
		const body = buildQuestionBody(params);
		expect(
			validateQuestionBody(params.title, body, params.relatedConcepts),
		).toEqual([]);
	});

	test("外部 URL はラベル付き [label URL] になる (裸 URL 禁止 §7)", () => {
		const body = buildQuestionBody({
			...questionParams(),
			sources: [
				{ label: "MCP 仕様", url: "https://spec.example.com/mcp" },
			],
		});
		expect(body).toContain(" [MCP 仕様 https://spec.example.com/mcp]");
		expect(validateQuestionBody("MCPの認可の仕組み", body)).toEqual([]);
	});

	test("Infobox と関連ページ節を持たない (§5 §4)", () => {
		const body = buildQuestionBody(questionParams());
		expect(body).not.toContain("table:infobox");
		expect(body).not.toContain("関連ページ");
	});
});

describe("[question] の検証 (§2 §3 §4 §5 §6)", () => {
	test("本文1行目が [question] 以外は違反 (source 層の型も不可)", () => {
		expect(
			validateQuestionBody("Foo", "ただの本文", []).join("\n"),
		).toContain("本文1行目は");
		expect(validateQuestionBody("Foo", "#raw\n本文", []).length).toBeGreaterThan(
			0,
		);
	});

	test("タイトルは名詞句 (§3): 空・/ 始まり・疑似階層・説明文は違反", () => {
		const body = buildQuestionBody(questionParams());
		expect(validateQuestionBody("", body).join("\n")).toContain("空にしない");
		expect(validateQuestionBody("/project/Foo", body).join("\n")).toContain(
			"/ で始めない",
		);
		expect(validateQuestionBody("concept/Foo", body).join("\n")).toContain(
			"疑似階層",
		);
		expect(
			validateQuestionBody("MCPの認可はどう動いているか?", body).join("\n"),
		).toContain("名詞句");
		expect(
			validateQuestionBody("認可の仕組みについて説明します。", body).join("\n"),
		).toContain("名詞句");
	});

	test("タイトルに source 層の印 (📄/🔖) は違反 (question は wiki 層 §6)", () => {
		const body = buildQuestionBody(questionParams());
		expect(validateQuestionBody("📄Foo", body).join("\n")).toContain("wiki 層");
		expect(validateQuestionBody("🔖Foo", body).join("\n")).toContain("wiki 層");
	});

	test("Infobox と関連ページ節は違反", () => {
		const base = buildQuestionBody(questionParams());
		expect(
			validateQuestionBody("Foo", `${base}\ntable:infobox\n gist\tx`).join("\n"),
		).toContain("Infobox を書かない");
		expect(validateQuestionBody("Foo", `${base}\n関連ページ`).join("\n")).toContain(
			"関連ページ",
		);
	});

	test("裸の [URL] は画像埋め込みになるので違反 (§7)", () => {
		const base = buildQuestionBody(questionParams());
		expect(
			validateQuestionBody("Foo", `${base}\n[https://example.com/foo.png]`).join(
				"\n",
			),
		).toContain("[<ラベル>");
	});

	test("relatedConcepts の未言及は違反 (§4 リンクで繋ぐ)", () => {
		const params = questionParams();
		const body = buildQuestionBody(params);
		expect(
			validateQuestionBody(params.title, body, ["存在しない概念"]).join("\n"),
		).toContain("存在しない概念");
	});
});

describe("source 層の除外 (§6 識別)", () => {
	test("[question] の出力は wiki 層 (source 層の判定に当たらない)", () => {
		const params = questionParams();
		const body = buildQuestionBody(params);
		const firstLine = body.split("\n")[0] ?? "";
		expect(isSourceLayerPage(params.title, firstLine)).toBe(false);
	});
});

describe("再利用判定は最初は緩め (Issue #17)", () => {
	test("既定の閾値は lenient", () => {
		expect(QUESTION_REUSE_THRESHOLD).toBe("lenient");
	});

	test("実質のある回答は valuable (既定 true)", () => {
		const judgment = judgeReuseValue(
			"[MCP] の認可は [OAuth] ベースで、[認可サーバ] がトークンを発行する。",
		);
		expect(judgment.valuable).toBe(true);
		expect(judgment.reason).toContain("[question]");
	});

	test("空・挨拶・相槌は落とす", () => {
		expect(judgeReuseValue("").valuable).toBe(false);
		expect(judgeReuseValue("   ").valuable).toBe(false);
		expect(judgeReuseValue("こんにちは").valuable).toBe(false);
		expect(judgeReuseValue("承知しました。").valuable).toBe(false);
		expect(judgeReuseValue("ありがとうございます").valuable).toBe(false);
	});

	test("エラー・未回答の報告は落とす (残す中身が無い)", () => {
		expect(judgeReuseValue("取得に失敗しました").valuable).toBe(false);
		expect(judgeReuseValue("wiki には無いと答える").valuable).toBe(false);
		expect(
			judgeReuseValue("wiki にはありません", {}).valuable,
		).toBe(false);
	});

	test("既存 [question] との重複は落とす", () => {
		const judgment = judgeReuseValue("実質のある回答です。[MCP] について答える。", {
			questionTitle: "MCPの認可の仕組み",
			existingQuestionTitles: ["MCPの認可の仕組み"],
		});
		expect(judgment.valuable).toBe(false);
		expect(judgment.reason).toContain("重複");
	});

	test("重複が無ければ valuable", () => {
		expect(
			judgeReuseValue("実質のある回答です。[MCP] について答える。", {
				questionTitle: "新しい問い",
				existingQuestionTitles: ["別の問い"],
			}).valuable,
		).toBe(true);
	});

	test("strict では短い回答も落とす (閾値は調整可能)", () => {
		const short = "短い回答";
		expect(short.length).toBeLessThan(STRICT_MIN_ANSWER_CHARS);
		expect(judgeReuseValue(short, { threshold: "strict" }).valuable).toBe(
			false,
		);
		expect(
			judgeReuseValue(short, { threshold: "lenient" }).valuable,
		).toBe(true);
	});

	test("reason は常に一言返る (スレッドに残すため)", () => {
		for (const answer of ["", "承知しました", "[MCP] は認可が要る"]) {
			expect(judgeReuseValue(answer).reason.length).toBeGreaterThan(0);
		}
	});
});

describe("孤立防止: [concept] からの被リンク計画 (§4)", () => {
	test("先頭の concept 末尾に [<question>] を足す ops を返す", () => {
		const plan = planQuestionBacklink("MCPの認可の仕組み", ["MCP", "OAuth"]);
		expect(plan?.conceptTitle).toBe("MCP");
		expect(plan?.ops).toEqual([
			{ insertBefore: "_end", text: "[MCPの認可の仕組み]" },
		]);
		// previewEdit にそのまま渡せる形であること
		expect(() => buildOpsJson(plan?.ops ?? [])).not.toThrow();
	});

	test("候補が空なら計画は作れない (undefined)", () => {
		expect(planQuestionBacklink("MCPの認可の仕組み", [])).toBeUndefined();
	});
});

describe("配線: ガード文が prompt とツール説明に届く", () => {
	test("ガード文は判定・preview→submit・孤立防止に触れる", () => {
		expect(QUESTION_GUARDRAIL_TEXT).toContain("再利用価値");
		expect(QUESTION_GUARDRAIL_TEXT).toContain("previewNewPage");
		expect(QUESTION_GUARDRAIL_TEXT).toContain("submitEdit");
		expect(QUESTION_GUARDRAIL_TEXT).toContain("[concept]");
		expect(QUESTION_GUARDRAIL_TEXT).toContain("スレッドに一言");
	});

	test("prompt.ts の ROLE がガード文を埋め込む (二重持ち防止)", () => {
		const promptSource = readFileSync(
			new URL("../src/prompt.ts", import.meta.url),
			"utf-8",
		);
		expect(promptSource).toContain("QUESTION_GUARDRAIL_TEXT");
	});

	test("書き込みツールの説明が question の流れに触れる", () => {
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
		expect(descriptionOf("previewNewPage")).toContain("[question]");
		expect(descriptionOf("previewEdit")).toContain("被リンク");
		expect(descriptionOf("submitEdit")).toContain("[question]");
	});
});
