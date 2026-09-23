import { describe, expect, test } from "bun:test";
import {
	extractProjectNameFromToken,
	parseBindingDescription,
	parseExplicitBindingValues,
	toSlackChannelId,
} from "../src/project-binding";

const ALLOWED = ["niki-auth", "niki-ai", "niki-cs", "niki-tech"];

describe("toSlackChannelId", () => {
	test("strips the Chat SDK provider prefix", () => {
		expect(toSlackChannelId("slack:C8P1104Q4")).toBe("C8P1104Q4");
	});

	test("leaves a raw Slack channel id untouched", () => {
		expect(toSlackChannelId("C8P1104Q4")).toBe("C8P1104Q4");
	});
});

describe("extractProjectNameFromToken", () => {
	test("bare project name", () => {
		expect(extractProjectNameFromToken("niki-auth")).toBe("niki-auth");
	});

	test("full URL", () => {
		expect(extractProjectNameFromToken("https://scrapbox.io/niki-auth")).toBe(
			"niki-auth",
		);
	});

	test("URL with trailing slash and page path", () => {
		expect(extractProjectNameFromToken("https://scrapbox.io/niki-ai/")).toBe(
			"niki-ai",
		);
		expect(
			extractProjectNameFromToken("https://scrapbox.io/niki-cs/Some_Page"),
		).toBe("niki-cs");
	});

	test("Slack link wrapper", () => {
		expect(
			extractProjectNameFromToken("<https://scrapbox.io/niki-auth|niki-auth>"),
		).toBe("niki-auth");
	});

	test("natural language is ignored", () => {
		expect(extractProjectNameFromToken("認証認可メモ")).toBeUndefined();
		expect(extractProjectNameFromToken("相談チャンネル")).toBeUndefined();
		expect(extractProjectNameFromToken("")).toBeUndefined();
	});
});

describe("parseExplicitBindingValues", () => {
	test("no marker returns null", () => {
		expect(parseExplicitBindingValues("認証認可の相談チャンネル")).toBeNull();
	});

	test("single bare name", () => {
		expect(parseExplicitBindingValues("cosense: niki-auth")).toEqual([
			"niki-auth",
		]);
	});

	test("multiple names with mixed separators", () => {
		expect(
			parseExplicitBindingValues("cosense: niki-auth, niki-ai niki-cs、niki-tech"),
		).toEqual(["niki-auth", "niki-ai", "niki-cs", "niki-tech"]);
	});

	test("URLs are normalized to names", () => {
		expect(
			parseExplicitBindingValues(
				"cosense: https://scrapbox.io/niki-auth, niki-ai",
			),
		).toEqual(["niki-auth", "niki-ai"]);
	});

	test("case-insensitive prefix and full-width colon", () => {
		expect(parseExplicitBindingValues("Cosense：niki-auth")).toEqual([
			"niki-auth",
		]);
	});

	test("natural words on the same line are ignored", () => {
		expect(parseExplicitBindingValues("cosense: 認証メモ niki-auth")).toEqual([
			"niki-auth",
		]);
	});

	test("marker with no readable token returns empty", () => {
		expect(parseExplicitBindingValues("cosense: 認証メモ")).toEqual([]);
	});
});

describe("parseBindingDescription", () => {
	test("explicit single project", () => {
		expect(
			parseBindingDescription("認証認可の相談\ncosense: niki-auth", ALLOWED),
		).toEqual({ kind: "resolved", projects: ["niki-auth"] });
	});

	test("explicit multiple projects", () => {
		expect(
			parseBindingDescription("cosense: niki-auth, niki-ai", ALLOWED),
		).toEqual({ kind: "resolved", projects: ["niki-auth", "niki-ai"] });
	});

	test("explicit mixed name and URL", () => {
		expect(
			parseBindingDescription(
				"cosense: https://scrapbox.io/niki-auth, niki-ai",
				ALLOWED,
			),
		).toEqual({ kind: "resolved", projects: ["niki-auth", "niki-ai"] });
	});

	test("explicit unknown project is rejected", () => {
		expect(parseBindingDescription("cosense: unknown-proj", ALLOWED)).toEqual({
			kind: "rejected",
			candidates: ["unknown-proj"],
		});
	});

	test("explicit mixed valid and invalid resolves valid with warning", () => {
		expect(
			parseBindingDescription("cosense: niki-auth, unknown-proj", ALLOWED),
		).toEqual({
			kind: "resolved",
			projects: ["niki-auth"],
			rejected: ["unknown-proj"],
		});
	});

	test("explicit takes precedence over legacy URLs", () => {
		expect(
			parseBindingDescription(
				"https://scrapbox.io/niki-cs\ncosense: niki-auth",
				ALLOWED,
			),
		).toEqual({ kind: "resolved", projects: ["niki-auth"] });
	});

	test("legacy URL still resolves (backward compat)", () => {
		expect(
			parseBindingDescription(
				"niki の認証認可メモ https://scrapbox.io/niki-auth",
				ALLOWED,
			),
		).toEqual({ kind: "resolved", projects: ["niki-auth"] });
	});

	test("legacy bare name still resolves (backward compat)", () => {
		expect(parseBindingDescription("niki-auth の相談", ALLOWED)).toEqual({
			kind: "resolved",
			projects: ["niki-auth"],
		});
	});

	test("natural text without project names is unset", () => {
		const resolution = parseBindingDescription("認証認可の相談チャンネル", ALLOWED);
		expect(resolution.kind).toBe("unset");
	});

	test("legacy unknown URL is rejected", () => {
		expect(
			parseBindingDescription("https://scrapbox.io/other-proj", ALLOWED),
		).toEqual({ kind: "rejected", candidates: ["other-proj"] });
	});
});
