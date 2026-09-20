import { describe, expect, mock, test } from "bun:test";

// src/tools/cosense.ts reaches @cloudflare/sandbox through src/sandbox.ts,
// which needs the workerd runtime (cloudflare:workers). Mock it like
// tests/sandbox.test.ts does — formatCosenseFailure never touches it.
mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => {
		throw new Error("getSandbox must not be called in this test");
	},
}));

const {
	ClassifiedTurnError,
	classifyError,
	isClassifiedTurnError,
	sanitizeText,
	threadErrorMessage,
} = await import("../src/errors");
import type { ErrorKind } from "../src/errors";
const { formatCosenseFailure } = await import("../src/tools/cosense");

/**
 * Fake secrets used across these tests. None of them may ever appear in a
 * thread-facing message or a sanitized log line — the assertions below
 * enforce that for every classified message and every formatter output.
 */
const FAKE_SLACK_TOKEN = "xoxb-fake-secret-token-00000";
const FAKE_BEARER = "Bearer fake-bearer-secret-00000";
const FAKE_API_KEY = "sk-fake-secret-key-00000";
const FAKE_PAT_ASSIGNMENT = "COSENSE_PAT=fake-pat-secret-00000";
const FAKE_PATH = "/root/.cosense/fake-secret-config";
const FAKE_STACK_LINE = "    at fakeFunction (/var/task/fake-secret-index.js:1:2)";

const FAKE_SECRETS = [
	FAKE_SLACK_TOKEN,
	FAKE_BEARER,
	"fake-bearer-secret-00000",
	FAKE_API_KEY,
	"fake-pat-secret-00000",
	FAKE_PATH,
	"/var/task/fake-secret-index.js",
];

const KINDS: ErrorKind[] = ["sandbox", "openrouter", "slack", "unknown"];

describe("classifyError", () => {
	test.each([
		[new Error("getSandbox failed: container did not start"), "sandbox"],
		[new Error("cosense searchVector exited with code 1"), "sandbox"],
		[new Error("Missing COSENSE_PAT"), "sandbox"],
		[new Error("Sandbox exec timed out after 60000ms"), "sandbox"],
	])("classifies %p as %s", (error, expected) => {
		expect(classifyError(error)).toBe(expected);
	});

	test.each([
		[
			new Error("OpenRouter request failed with 402: insufficient credits"),
			"openrouter",
		],
		[new Error("AI SDK NoSuchModelError: model not found"), "openrouter"],
		[new Error("generateText failed: fetch failed"), "openrouter"],
		[{ status: 402, message: "credit limit reached" }, "openrouter"],
	])("classifies %p as %s", (error, expected) => {
		expect(classifyError(error)).toBe(expected);
	});

	test.each([
		[new Error("Slack API conversations.info failed: channel_not_found"), "slack"],
		[new Error("WebClient error: rate_limited"), "slack"],
		[new Error(`invalid_auth for token ${FAKE_SLACK_TOKEN}`), "slack"],
	])("classifies %p as %s", (error, expected) => {
		expect(classifyError(error)).toBe(expected);
	});

	test.each([
		[new Error("something completely unexpected"), "unknown"],
		[new Error("429 Too Many Requests"), "unknown"],
		[null, "unknown"],
		[undefined, "unknown"],
	])("classifies %p as %s", (error, expected) => {
		expect(classifyError(error)).toBe(expected);
	});
});

describe("threadErrorMessage", () => {
	test("the four kinds are pairwise distinguishable", () => {
		const messages = KINDS.map(threadErrorMessage);
		expect(new Set(messages).size).toBe(KINDS.length);
	});

	test.each([
		["sandbox", "Sandbox"],
		["openrouter", "OpenRouter"],
		["slack", "Slack"],
	] as Array<[ErrorKind, string]>)("%s message names its failure system", (kind, marker) => {
		expect(threadErrorMessage(kind)).toContain(marker);
	});

	test.each(KINDS)("the %s message leaks no secret substrings", (kind) => {
		const message = threadErrorMessage(kind);
		for (const secret of FAKE_SECRETS) {
			expect(message).not.toContain(secret);
		}
		expect(message).not.toContain("    at ");
	});
});

describe("sanitizeText", () => {
	test("redacts tokens, assignments, paths, and stack frames", () => {
		const dirty = [
			`token ${FAKE_SLACK_TOKEN} here`,
			`auth ${FAKE_BEARER} here`,
			`key ${FAKE_API_KEY} here`,
			`env ${FAKE_PAT_ASSIGNMENT} here`,
			`config at ${FAKE_PATH} missing`,
			"Error: boom",
			FAKE_STACK_LINE,
			"see https://scrapbox.io/niki-auth/some-page for details",
		].join("\n");

		const clean = sanitizeText(dirty);

		for (const secret of FAKE_SECRETS) {
			expect(clean).not.toContain(secret);
		}
		expect(clean).not.toContain("    at ");
		// Legitimate content survives: CLI error wording and page URLs.
		expect(clean).toContain("Error: boom");
		expect(clean).toContain("https://scrapbox.io/niki-auth/some-page");
	});
});

describe("formatCosenseFailure", () => {
	test("keeps the cause distinguishable without leaking secrets", () => {
		const stderr = [
			`auth failed for ${FAKE_SLACK_TOKEN}`,
			`using ${FAKE_PAT_ASSIGNMENT}`,
			`config at ${FAKE_PATH}`,
			FAKE_STACK_LINE,
			"cosense: page not found",
		].join("\n");

		const message = formatCosenseFailure(["searchVector"], stderr, 1);

		expect(message).toContain("cosense searchVector");
		expect(message).toContain("exit 1");
		expect(message).toContain("cosense: page not found");
		for (const secret of FAKE_SECRETS) {
			expect(message).not.toContain(secret);
		}
		expect(message).not.toContain("    at ");
	});
});

describe("ClassifiedTurnError", () => {
	test("is recognized by the delivery-policy predicate", () => {
		const error = new ClassifiedTurnError(
			"sandbox",
			threadErrorMessage("sandbox"),
			new Error("boom"),
		);
		expect(isClassifiedTurnError(error)).toBe(true);
		expect(isClassifiedTurnError(new Error("boom"))).toBe(false);
		expect(isClassifiedTurnError(null)).toBe(false);
	});
});
