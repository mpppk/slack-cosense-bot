import { afterAll, describe, expect, mock, test } from "bun:test";
import {
	buildOpsJson,
	checkNotationCollisions,
	checkOpsCollisions,
	formatCollisionReport,
} from "../src/cosense-edit";

const inputFileCalls: string[] = [];
const writtenFiles: Array<{ path: string; content: string }> = [];
const deletedFiles: string[] = [];

const fakeInputSandbox = {
	exec: async (command: string) => {
		inputFileCalls.push(command);
		return { success: true, stdout: "previewId: abc", stderr: "", exitCode: 0 };
	},
	writeFile: async (path: string, content: string) => {
		writtenFiles.push({ path, content });
		return { success: true, path, bytesWritten: content.length, timestamp: "" };
	},
	deleteFile: async (path: string) => {
		deletedFiles.push(path);
		return { success: true };
	},
};

mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => fakeInputSandbox,
}));

const { runCosenseWithInputFile } = await import("../src/sandbox");

afterAll(() => mock.restore());

function kindsOf(text: string): string[] {
	return checkNotationCollisions(text).map((collision) => collision.kind);
}

describe("hashtag-number collisions (#数字はhashtag記法になる)", () => {
	test("flags a bare issue number", () => {
		expect(kindsOf("issue #15 を見る")).toContain("hashtag-number");
	});

	test("flags a leading numeric hashtag", () => {
		expect(kindsOf("#123 から始まる行")).toContain("hashtag-number");
	});

	test("does not flag the #raw / #bookmark type markers", () => {
		expect(kindsOf("#raw")).toEqual([]);
		expect(kindsOf("#bookmark")).toEqual([]);
	});

	test("does not flag # without a trailing digit", () => {
		expect(kindsOf("C# のコード")).toEqual([]);
		expect(kindsOf("文末の # はタグにならない")).toEqual([]);
	});
});

describe("bracket-fragment collisions ([]を含むコード断片はリンク記法と衝突する)", () => {
	test("flags an array index", () => {
		expect(kindsOf("arr[0]の要素")).toContain("bracket-fragment");
	});

	test("flags an empty bracket pair", () => {
		expect(kindsOf("foo[] bar")).toContain("bracket-fragment");
	});

	test("flags a call-like fragment", () => {
		expect(kindsOf("[foo(bar)]を呼ぶ")).toContain("bracket-fragment");
	});

	test("flags a single-letter span (almost never a page title)", () => {
		expect(kindsOf("a[i]とb[j]")).toContain("bracket-fragment");
	});

	test("flags an unbalanced bracket", () => {
		expect(kindsOf("array[0の要素")).toContain("bracket-fragment");
	});

	test("does not flag intended page links", () => {
		expect(kindsOf("[Transformer]は速い")).toEqual([]);
		expect(kindsOf("[Attention Is All You Need]を読む")).toEqual([]);
	});

	test("does not flag a labeled external link", () => {
		expect(
			kindsOf("[summary https://scrapbox.io/niki-auth/summary]"),
		).toEqual([]);
	});
});

describe("unlabeled-url collisions (ラベルの無い[URL]は画像埋め込みになる)", () => {
	test("flags a bare https URL in brackets", () => {
		expect(kindsOf("[https://example.com/foo.png]")).toEqual([
			"unlabeled-url",
		]);
	});

	test("flags a bare http URL in brackets", () => {
		expect(kindsOf("[http://example.com]")).toEqual(["unlabeled-url"]);
	});

	test("does not flag a labeled URL", () => {
		expect(kindsOf("[論文 https://arxiv.org/abs/1706.03762]")).toEqual([]);
	});
});

describe("checkOpsCollisions / formatCollisionReport", () => {
	test("collects collisions across op texts and skips deletes", () => {
		const collisions = checkOpsCollisions([
			{ insertBefore: "_end", text: "issue #15 のメモ" },
			{ replace: "abcdef1234567890abcdef12", text: "arr[0]を直す" },
			{ delete: "abcdef1234567890abcdef12" },
		]);
		expect(collisions.map((collision) => collision.kind)).toEqual([
			"hashtag-number",
			"bracket-fragment",
		]);
	});

	test("returns an empty report when there is nothing to warn about", () => {
		expect(formatCollisionReport([])).toBe("");
	});

	test("report names the kind, the line, and the fix", () => {
		const report = formatCollisionReport(
			checkNotationCollisions("[https://example.com/foo.png]"),
		);
		expect(report).toContain("unlabeled-url");
		expect(report).toContain("1行目");
		expect(report).toContain("[<ラベル>");
	});
});

describe("buildOpsJson (insertBefore/replace/delete)", () => {
	test("assembles ops in array order", () => {
		const json = buildOpsJson([
			{ insertBefore: "_end", text: "a\nb" },
			{ replace: "abcdef1234567890abcdef12", text: "c" },
			{ delete: "abcdef1234567890abcdef12" },
		]);
		expect(JSON.parse(json)).toEqual({
			ops: [
				{ insertBefore: "_end", text: "a\nb" },
				{ replace: "abcdef1234567890abcdef12", text: "c" },
				{ delete: "abcdef1234567890abcdef12" },
			],
		});
	});

	test("rejects an empty op list", () => {
		expect(() => buildOpsJson([])).toThrow();
	});

	test("rejects multi-line replace text (CLI returns 422)", () => {
		expect(() =>
			buildOpsJson([
				{ replace: "abcdef1234567890abcdef12", text: "a\nb" },
			]),
		).toThrow("単行");
	});

	test("rejects the _end anchor for replace and delete", () => {
		expect(() =>
			buildOpsJson([{ replace: "_end", text: "a" }]),
		).toThrow("_end");
		expect(() => buildOpsJson([{ delete: "_end" }])).toThrow("_end");
	});
});

describe("runCosenseWithInputFile (ページ本文をシェルに届けない)", () => {
	const inputEnv = {
		COSENSE_ORIGIN: "https://scrapbox.io",
		COSENSE_PROJECTS: "niki-auth,niki-ai,niki-cs,niki-tech",
		COSENSE_PAT: "pat_test_token",
	};

	test("page text travels via writeFile + --input-file, never the shell", async () => {
		inputFileCalls.length = 0;
		writtenFiles.length = 0;
		deletedFiles.length = 0;

		const hostile = `$(rm -rf /); 'quote'; \`backtick\`; issue #15 arr[0]`;
		const opsJson = buildOpsJson([
			{ insertBefore: "_end", text: hostile },
		]);
		const result = await runCosenseWithInputFile(
			inputEnv as never,
			"niki-auth",
			(inputPath) => [
				"previewEdit",
				"--input-file",
				inputPath,
				"https://scrapbox.io/niki-auth",
				"pageid123",
			],
			opsJson,
		);

		expect(result.ok).toBe(true);
		expect(writtenFiles).toHaveLength(1);
		expect(writtenFiles[0]?.content).toBe(opsJson);

		const command = inputFileCalls[0] ?? "";
		expect(command).toContain("'--input-file'");
		expect(command).not.toContain(hostile);
		expect(command).not.toContain("rm -rf");
		expect(command).not.toContain(inputEnv.COSENSE_PAT);

		expect(deletedFiles).toEqual([writtenFiles[0]?.path]);
	});
});
