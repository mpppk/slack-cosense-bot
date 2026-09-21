import { describe, expect, test } from "bun:test";
import {
	formatSlackLink,
	parsePreviewId,
	planMarkerWriteback,
	stripMarkerSyntax,
	type EditablePageLine,
} from "../src/cosense-writeback";
import {
	handleCosenseNotification,
	type NotificationHandlerDeps,
	type NotificationMessageEvent,
} from "../src/cosense-notification";
import { parseMarkerLines } from "../src/marker-parser";
import type { CosenseEditOp } from "../src/cosense-edit";

const PERMALINK =
	"https://example.slack.com/archives/C8P1104Q4/p1789910193426639";

function linesOf(...texts: string[]): EditablePageLine[] {
	return texts.map((text, index) => ({ id: `line${index}`, text }));
}

describe("formatSlackLink (labeled external-URL notation)", () => {
	test("uses the [label URL] form, never a bare URL", () => {
		const link = formatSlackLink(PERMALINK);
		expect(link).toBe(`[Slack ${PERMALINK}]`);
		expect(link.startsWith("[Slack https://")).toBe(true);
		// A bare [URL] line would render as an embedded image (AGENTS.md §7).
		expect(link).not.toBe(`[${PERMALINK}]`);
	});
});

describe("stripMarkerSyntax", () => {
	test("removes the marker link and separator space, keeps wording+icon", () => {
		expect(stripMarkerSyntax("[query]MCP auth [yuki.icon]")).toBe(
			"MCP auth [yuki.icon]",
		);
		expect(stripMarkerSyntax("[query] MCP auth [yuki.icon]")).toBe(
			"MCP auth [yuki.icon]",
		);
		expect(stripMarkerSyntax("[lint] 古い記述を確認")).toBe("古い記述を確認");
	});

	test("leaves non-marker lines untouched", () => {
		expect(stripMarkerSyntax("ただの本文です")).toBe("ただの本文です");
		expect(stripMarkerSyntax(" [query] indented")).toBe(" [query] indented");
	});
});

describe("planMarkerWriteback (one submitEdit for all markers)", () => {
	test("content marker: replace strips marker, insertBefore adds indented child", () => {
		const lines = linesOf(
			"前文",
			"[query]MCP auth [yuki.icon]",
			"後文",
		);
		const instructions = parseMarkerLines(
			lines.map((line) => line.text).join("\n"),
		);
		const plan = planMarkerWriteback(lines, instructions, PERMALINK);
		expect(plan.matched).toBe(1);
		expect(plan.unmatched).toBe(0);
		expect(plan.ops).toEqual([
			{ replace: "line1", text: "MCP auth [yuki.icon]" },
			{ insertBefore: "line2", text: ` [Slack ${PERMALINK}]` },
		]);
	});

	test("issue example: marker removed, wording kept, link remains", () => {
		const lines = linesOf("[query]MCP の認可を調べて [yuki.icon]");
		const instructions = parseMarkerLines(lines[0]?.text ?? "");
		const plan = planMarkerWriteback(lines, instructions, PERMALINK);
		expect(plan.ops).toEqual([
			{ replace: "line0", text: "MCP の認可を調べて [yuki.icon]" },
			{ insertBefore: "_end", text: ` [Slack ${PERMALINK}]` },
		]);
	});

	test("link child lands after existing children (anchor is next sibling)", () => {
		const lines = linesOf(
			"[query] 調べる [yuki.icon]",
			" 補足メモ",
			"次の本文",
		);
		const instructions = parseMarkerLines(
			lines.map((line) => line.text).join("\n"),
		);
		const plan = planMarkerWriteback(lines, instructions, PERMALINK);
		expect(plan.ops).toEqual([
			{ replace: "line0", text: "調べる [yuki.icon]" },
			{ insertBefore: "line2", text: ` [Slack ${PERMALINK}]` },
		]);
	});

	test("bare marker rolls up: single replace with the link, no delete", () => {
		for (const bare of ["[query][yuki.icon]", "[query] [yuki.icon]", "[query]"]) {
			const lines = linesOf("前文", bare, "後文");
			const instructions = parseMarkerLines(
				lines.map((line) => line.text).join("\n"),
			);
			expect(instructions[0]?.text).toBe("");
			const plan = planMarkerWriteback(lines, instructions, PERMALINK);
			expect(plan.matched).toBe(1);
			expect(plan.ops).toEqual([
				{ replace: "line1", text: `[Slack ${PERMALINK}]` },
			]);
		}
	});

	test("bare marker with children keeps them under the rolled-up link", () => {
		const lines = linesOf("[query][yuki.icon]", " 既存の子行");
		// parseMarkerLines treats two-space indent as block end; build the
		// instruction directly to cover the bare+children shape.
		const plan = planMarkerWriteback(
			lines,
			[{ kind: "query", text: "", children: [] }],
			PERMALINK,
		);
		expect(plan.ops).toEqual([
			{ replace: "line0", text: `[Slack ${PERMALINK}]` },
		]);
	});

	test("multiple markers batch into one ops array, never delete ops", () => {
		const lines = linesOf(
			"[query] A [yuki.icon]",
			"[lint] B [yuki.icon]",
			"[query][yuki.icon]",
		);
		const instructions = parseMarkerLines(
			lines.map((line) => line.text).join("\n"),
		);
		expect(instructions).toHaveLength(3);
		const plan = planMarkerWriteback(lines, instructions, PERMALINK);
		expect(plan.matched).toBe(3);
		expect(plan.ops).toHaveLength(5); // 2 + 2 + 1 (bare)
		for (const op of plan.ops) {
			expect("delete" in op).toBe(false);
		}
		// Adjacent markers anchor on each other's (replaced, never deleted) ids.
		expect(plan.ops[1]).toEqual({
			insertBefore: "line1",
			text: ` [Slack ${PERMALINK}]`,
		});
	});

	test("already-processed lines yield no ops (dedup: marker is gone)", () => {
		const lines = linesOf(
			"MCP auth [yuki.icon]",
			` [Slack ${PERMALINK}]`,
		);
		const plan = planMarkerWriteback(
			lines,
			[{ kind: "query", text: "MCP auth", children: [] }],
			PERMALINK,
		);
		expect(plan.ops).toEqual([]);
		expect(plan.matched).toBe(0);
		expect(plan.unmatched).toBe(1);
	});

	test("unmatched instructions are skipped without touching other markers", () => {
		const lines = linesOf("[query] A [yuki.icon]");
		const plan = planMarkerWriteback(
			lines,
			[
				{ kind: "query", text: "gone", children: [] },
				{ kind: "query", text: "A", children: [] },
			],
			PERMALINK,
		);
		expect(plan.matched).toBe(1);
		expect(plan.unmatched).toBe(1);
		expect(plan.ops).toHaveLength(2);
	});
});

describe("parsePreviewId", () => {
	test("reads the previewId header line", () => {
		expect(
			parsePreviewId(
				"previewId: abc123\nexpireAt:  2026-09-21T00:00:00Z\nstatus:    update",
			),
		).toBe("abc123");
	});

	test("returns undefined when no header is present", () => {
		expect(parsePreviewId("some error output")).toBeUndefined();
		expect(parsePreviewId("")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Handler-level: order gating + single-submitEdit batching (Issue #14).
// ---------------------------------------------------------------------------

const baseEnv = {
	COSENSE_PROJECTS: "niki-auth",
	COSENSE_ORIGIN: "https://scrapbox.io",
	SLACK_BOT_TOKEN: "xoxb-test",
} as unknown as Env;

function notificationEvent() {
	return {
		type: "message",
		subtype: "bot_message",
		bot_id: "B0C39SDPHRP",
		username: "Scrapbox",
		text: "New lines on <https://scrapbox.io/niki-auth|niki-auth>",
		channel: "C8P1104Q4",
		ts: "1789910193.426639",
		attachments: [
			{
				title: "Auth memo",
				title_link: "https://scrapbox.io/niki-auth/Auth%20memo",
				text: "excerpt",
				author_name: "yuki",
			},
		],
	} as unknown as NotificationMessageEvent;
}

interface RecordedCalls {
	order: string[];
	submittedOps: CosenseEditOp[][];
}

function recordingDeps(
	pageBody: string,
	options: { postFails?: boolean; permalink?: string | null } = {},
): { deps: NotificationHandlerDeps; calls: RecordedCalls } {
	const calls: RecordedCalls = { order: [], submittedOps: [] };
	const deps: NotificationHandlerDeps = {
		browsePageText: async () => pageBody,
		listThreadReplyTexts: async () => [],
		postThreadReply: async () => {
			calls.order.push("postThreadReply");
			if (options.postFails) throw new Error("post failed");
		},
		getPermalink: async () => {
			calls.order.push("getPermalink");
			return options.permalink === undefined ? PERMALINK : options.permalink;
		},
		readPageForEdit: async (_project, title) => {
			calls.order.push("readPageForEdit");
			return {
				pageId: `page-${title}`,
				lines: pageBody
					.split("\n")
					.map((text, index) => ({ id: `line${index}`, text })),
			};
		},
		previewAndSubmitEdit: async (_project, _pageId, ops) => {
			calls.order.push("previewAndSubmitEdit");
			calls.submittedOps.push(ops);
			return true;
		},
	};
	return { deps, calls };
}

describe("handleCosenseNotification writeback gating (Issue #14)", () => {
	test("writeback runs after thread creation, batched in a single submit", async () => {
		const pageBody =
			"[query] MCP の認可を調べて [yuki.icon]\n[lint] 古い記述を確認 [yuki.icon]";
		const { deps, calls } = recordingDeps(pageBody);
		const result = await handleCosenseNotification(
			notificationEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(2);
		expect(result.writebacksSucceeded).toBe(1);
		expect(result.writebacksFailed).toBe(0);
		// Order: threads first, then exactly one preview+submit batch.
		expect(calls.order).toEqual([
			"postThreadReply",
			"postThreadReply",
			"getPermalink",
			"readPageForEdit",
			"previewAndSubmitEdit",
		]);
		expect(calls.submittedOps).toHaveLength(1);
		const ops = calls.submittedOps[0] ?? [];
		expect(ops).toHaveLength(4); // 2 ops per content marker
		expect(ops[0]).toEqual({
			replace: "line0",
			text: "MCP の認可を調べて [yuki.icon]",
		});
		expect(ops[1]).toEqual({
			insertBefore: "line1",
			text: ` [Slack ${PERMALINK}]`,
		});
	});

	test("failed thread posts never reach the writeback", async () => {
		const { deps, calls } = recordingDeps("[query] 調べる [yuki.icon]", {
			postFails: true,
		});
		const result = await handleCosenseNotification(
			notificationEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(0);
		expect(result.writebacksSucceeded).toBe(0);
		expect(result.writebacksFailed).toBe(0);
		expect(calls.order).toEqual(["postThreadReply"]);
		expect(calls.submittedOps).toHaveLength(0);
	});

	test("missing permalink skips the writeback, marker stays for retry", async () => {
		const { deps, calls } = recordingDeps("[query] 調べる [yuki.icon]", {
			permalink: null,
		});
		const result = await handleCosenseNotification(
			notificationEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(1);
		expect(result.writebacksSucceeded).toBe(0);
		expect(result.writebacksFailed).toBe(1);
		expect(calls.order).toEqual(["postThreadReply", "getPermalink"]);
	});

	test("duplicate-suppressed notifications do no writeback", async () => {
		const pageBody = "[query] 調べる [yuki.icon]";
		const { deps, calls } = recordingDeps(pageBody);
		const first = await handleCosenseNotification(
			notificationEvent(),
			baseEnv,
			{
				...deps,
				// Second run sees the thread already posted: pending is empty.
				listThreadReplyTexts: async () => ["[query] 調べる\n"],
			},
		);
		expect(first.threadsCreated).toBe(0);
		expect(first.skippedDuplicates).toBe(1);
		expect(first.writebacksSucceeded).toBe(0);
		expect(first.writebacksFailed).toBe(0);
		expect(calls.order).not.toContain("getPermalink");
		expect(calls.submittedOps).toHaveLength(0);
	});

	test("partial post failure writes back only the posted markers", async () => {
		const pageBody = "[query] A [yuki.icon]\n[lint] B [yuki.icon]";
		const calls: RecordedCalls = { order: [], submittedOps: [] };
		let postCount = 0;
		const deps: NotificationHandlerDeps = {
			browsePageText: async () => pageBody,
			listThreadReplyTexts: async () => [],
			postThreadReply: async () => {
				postCount += 1;
				if (postCount === 1) throw new Error("post failed");
			},
			getPermalink: async () => PERMALINK,
			readPageForEdit: async () => ({
				pageId: "page1",
				lines: pageBody
					.split("\n")
					.map((text, index) => ({ id: `line${index}`, text })),
			}),
			previewAndSubmitEdit: async (_p, _id, ops) => {
				calls.submittedOps.push(ops);
				return true;
			},
		};
		const result = await handleCosenseNotification(
			notificationEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(1);
		expect(result.writebacksSucceeded).toBe(1);
		expect(calls.submittedOps).toHaveLength(1);
		// Only the posted [lint] marker is written back.
		expect(calls.submittedOps[0]).toEqual([
			{ replace: "line1", text: "B [yuki.icon]" },
			{ insertBefore: "_end", text: ` [Slack ${PERMALINK}]` },
		]);
	});
});
