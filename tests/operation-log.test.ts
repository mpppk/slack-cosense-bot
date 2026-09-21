import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildOpsJson } from "../src/cosense-edit";
import { buildIngestLogLine, isDatePageLine, LOG_VERBS } from "../src/ingest";
import {
	buildDraftLogLine,
	buildLintLogLine,
	buildNewDatePageBody,
	buildNewDatePageInput,
	buildOperationLogLine,
	buildQueryLogLine,
	datePageTitleFor,
	hasSignatureMark,
	isDatePageTitle,
	LOG_TYPE_LINE,
	logVerbForRecord,
	OPERATION_LOG_GUARDRAIL_TEXT,
	planDatePageAppendOps,
	todayDatePageTitle,
	validateDatePageBody,
	validateLogLine,
} from "../src/operation-log";

mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => {
		throw new Error("must not reach the Sandbox in unit tests");
	},
}));

describe("日付ページタイトル (§12 YYYY/MM/DD, JST)", () => {
	test("YYYY/MM/DD 形式になる", () => {
		const title = datePageTitleFor(new Date("2026-09-21T00:00:00+09:00"));
		expect(title).toBe("2026/09/21");
		expect(isDatePageTitle(title)).toBe(true);
	});

	test("TODAY は JST で決まる (UTC 境界をまたぐ)", () => {
		// UTC 2026-09-20 15:00 = JST 2026-09-21 00:00 → 09/21
		expect(datePageTitleFor(new Date("2026-09-20T15:00:00Z"))).toBe(
			"2026/09/21",
		);
		// UTC 2026-09-20 14:59:59 = JST 2026-09-20 23:59:59 → 09/20
		expect(datePageTitleFor(new Date("2026-09-20T14:59:59Z"))).toBe(
			"2026/09/20",
		);
	});

	test("todayDatePageTitle は datePageTitleFor と一致する", () => {
		const now = new Date("2026-09-21T12:34:56+09:00");
		expect(todayDatePageTitle(now)).toBe(datePageTitleFor(now));
	});

	test("YYYY-MM-DD や単一ログページ名はタイトルとして拒否する", () => {
		expect(isDatePageTitle("2026-09-21")).toBe(false);
		expect(isDatePageTitle("log")).toBe(false);
		expect(isDatePageTitle("2026/9/1")).toBe(false);
	});
});

describe("ログ行の組み立て (動詞は LOG_VERBS のみ §12)", () => {
	test("動詞の正本は ingest.ts の LOG_VERBS (4動詞、重複なし)", () => {
		expect([...LOG_VERBS]).toEqual(["ingest", "query", "draft", "lint"]);
		const source = readFileSync(
			new URL("../src/operation-log.ts", import.meta.url),
			"utf-8",
		);
		expect(source).toContain('from "./ingest"');
		expect(source).toContain("LOG_VERBS");
		// 動詞一覧の二重持ちをしない (リテラルの再定義は無い)
		expect(source).not.toMatch(/LOG_VERBS\s*=\s*\[/);
	});

	test("query / lint / draft の行が規約どおりに組める", () => {
		expect(buildQueryLogLine("認可の動き")).toBe("query 認可の動き");
		expect(buildLintLogLine("孤立ページの検査")).toBe("lint 孤立ページの検査");
		expect(buildDraftLogLine("エージェント比較の骨子")).toBe(
			"draft [エージェント比較の骨子]",
		);
		expect(buildOperationLogLine("query", "要旨")).toBe("query 要旨");
	});

	test("ingest 行は ingest.ts の正本を使い、日付行として通る", () => {
		const line = buildIngestLogLine("Attention Is All You Need");
		expect(line).toBe("ingest [Attention Is All You Need]");
		expect(isDatePageLine(line)).toBe(true);
		expect(isDatePageLine(buildQueryLogLine("要旨"))).toBe(true);
		expect(isDatePageLine(buildLintLogLine("要旨"))).toBe(true);
		expect(isDatePageLine(buildDraftLogLine("骨子"))).toBe(true);
	});

	test("新動詞は日付行にならない (synthesis/question/idea/log/progress)", () => {
		for (const line of [
			"synthesis 比較メモ",
			"question 問いメモ",
			"idea アイデアメモ",
			"log 進捗メモ",
			"progress 進捗",
		]) {
			expect(isDatePageLine(line)).toBe(false);
			expect(validateLogLine(line)).toContain("動詞は増やさない");
		}
	});
});

describe("[synthesis]/[question]/[idea] は操作の動詞で記録 (§12)", () => {
	test("記録の種別にかかわらず操作の動詞をそのまま返す", () => {
		expect(logVerbForRecord("ingest", "synthesis")).toBe("ingest");
		expect(logVerbForRecord("query", "synthesis")).toBe("query");
		expect(logVerbForRecord("query", "question")).toBe("query");
		expect(logVerbForRecord("query", "idea")).toBe("query");
		expect(logVerbForRecord("lint", "question")).toBe("lint");
		expect(logVerbForRecord("draft", "idea")).toBe("draft");
	});

	test("解決した動詞で行を作っても検証を通る", () => {
		const verb = logVerbForRecord("ingest", "synthesis");
		const line = buildOperationLogLine(verb, "[比較メモ] を更新");
		expect(validateLogLine(line)).toBeUndefined();
	});
});

describe("署名なし (§13: 無署名であること自体が署名)", () => {
	test("bot のログ行に [*.icon] を検出する", () => {
		expect(hasSignatureMark("query 要旨")).toBe(false);
		expect(hasSignatureMark("query 要旨 [bot.icon]")).toBe(true);
		expect(hasSignatureMark("ingest [Foo] [yuki.icon]")).toBe(true);
	});

	test("署名付きログ行は検証で落ちる", () => {
		expect(validateLogLine("query 要旨 [bot.icon]")).toContain(
			"署名",
		);
		expect(
			validateDatePageBody("[log]\nquery 要旨 [bot.icon]").join("\n"),
		).toContain("署名");
	});
});

describe("日付ページ本文 (新規は [log] 始まり、既存は末尾追記 §12)", () => {
	test("新規本文は1行目 [log]、次がログ行", () => {
		const body = buildNewDatePageBody("query 認可の動き");
		expect(body.split("\n")[0]).toBe("[log]");
		expect(body.split("\n")[0]).toBe(LOG_TYPE_LINE);
		expect(body).toBe("[log]\nquery 認可の動き");
		expect(validateDatePageBody(body)).toEqual([]);
	});

	test("previewNewPage 入力は1行目タイトル + [log] + ログ行", () => {
		const input = buildNewDatePageInput("2026/09/21", "query 認可の動き");
		const lines = input.split("\n");
		expect(lines[0]).toBe("2026/09/21");
		expect(lines[1]).toBe("[log]");
		expect(lines[2]).toBe("query 認可の動き");
		// 本文部分 (タイトル行を除く) は検証を通る
		expect(validateDatePageBody(lines.slice(1).join("\n"))).toEqual([]);
	});

	test("追記 ops は EXACTLY ONE 行を _end に足す", () => {
		const ops = planDatePageAppendOps("query 認可の動き");
		expect(ops).toEqual([
			{ insertBefore: "_end", text: "query 認可の動き" },
		]);
		// previewEdit にそのまま渡せる形であること
		expect(() => buildOpsJson(ops)).not.toThrow();
	});

	test("本文1行目が [log] 以外・ログ行なしは違反", () => {
		expect(validateDatePageBody("query 要旨").join("\n")).toContain(
			"本文1行目は",
		);
		expect(validateDatePageBody("[log]").join("\n")).toContain("ログ行");
		expect(validateDatePageBody("[log]\n今日のメモ").join("\n")).toContain(
			"動詞は増やさない",
		);
	});

	test("Infobox と関連ページ節は違反 (§5 §4)", () => {
		expect(
			validateDatePageBody("[log]\nquery 要旨\ntable:infobox\n gist\tx").join(
				"\n",
			),
		).toContain("Infobox を書かない");
		expect(
			validateDatePageBody("[log]\nquery 要旨\n関連ページ").join("\n"),
		).toContain("関連ページ");
	});
});

describe("配線: ガード文が prompt に届く", () => {
	test("ガード文は1行・動詞・[log]・無署名・preview→submit に触れる", () => {
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("EXACTLY ONE");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("LOG_VERBS");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("[log]");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("署名");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("previewEdit");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("previewNewPage");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("submitEdit");
		expect(OPERATION_LOG_GUARDRAIL_TEXT).toContain("JST");
	});

	test("prompt.ts の ROLE がガード文を埋め込む (二重持ち防止)", () => {
		const promptSource = readFileSync(
			new URL("../src/prompt.ts", import.meta.url),
			"utf-8",
		);
		expect(promptSource).toContain("OPERATION_LOG_GUARDRAIL_TEXT");
	});
});
