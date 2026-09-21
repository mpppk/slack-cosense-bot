import { describe, expect, test } from "bun:test";
import {
	extractNotificationTargets,
	filterUnpostedMarkers,
	formatMarkerThreadText,
	getConfiguredNotifierBotIds,
	handleCosenseNotification,
	isCosenseNotificationEnvelope,
	isCosenseNotificationMessage,
	markerSignature,
	parseCosensePageUrl,
	type NotificationMessageEvent,
} from "../src/cosense-notification";
import { parseMarkerLines } from "../src/marker-parser";

const baseEnv = {
	COSENSE_PROJECTS: "niki-auth,niki-ai,niki-cs,niki-tech",
	COSENSE_ORIGIN: "https://scrapbox.io",
	SLACK_BOT_TOKEN: "xoxb-test",
} as unknown as Env;

const withNotifier = (botId: string) =>
	({
		...baseEnv,
		COSENSE_SLACK_BOT_IDS: botId,
	}) as unknown as Env;

/** Shape from the public Cosense→webhook payload record (ids redacted). */
function cosenseAttachmentEvent(botId = "B000COSENSE") {
	return {
		type: "message",
		subtype: "bot_message",
		bot_id: botId,
		username: "Scrapbox",
		text: "New lines on <https://scrapbox.io/niki-auth|niki-auth>",
		channel: "C8P1104Q4",
		ts: "1789910193.426639",
		attachments: [
			{
				title: "Auth memo",
				title_link: "https://scrapbox.io/niki-auth/Auth%20memo",
				text: "recently changed excerpt\n ",
				rawText: "raw excerpt and embedded URLs",
				mrkdwn_in: ["text"],
				author_name: "editor-name",
			},
		],
	} as unknown as NotificationMessageEvent;
}

describe("getConfiguredNotifierBotIds", () => {
	test("reads list and legacy single vars, never hardcoded", () => {
		expect(getConfiguredNotifierBotIds(baseEnv)).toEqual([]);
		expect(getConfiguredNotifierBotIds(withNotifier("B123"))).toEqual(["B123"]);
		expect(
			getConfiguredNotifierBotIds({
				...baseEnv,
				COSENSE_SLACK_BOT_IDS: "B1, B2",
			} as unknown as Env),
		).toEqual(["B1", "B2"]);
		expect(
			getConfiguredNotifierBotIds({
				...baseEnv,
				COSENSE_SLACK_BOT_ID: "B9",
			} as unknown as Env),
		).toEqual(["B9"]);
	});
});

describe("isCosenseNotificationMessage (bot_message detector)", () => {
	test("detects the configured notifier bot_message", () => {
		expect(
			isCosenseNotificationMessage(
				cosenseAttachmentEvent("B000COSENSE"),
				withNotifier("B000COSENSE"),
			),
		).toBe(true);
	});

	test("rejects a different bot_id when configured", () => {
		expect(
			isCosenseNotificationMessage(
				cosenseAttachmentEvent("B999OTHER"),
				withNotifier("B000COSENSE"),
			),
		).toBe(false);
	});

	test("heuristic mode matches Cosense shape so the real bot_id can be captured", () => {
		const event = cosenseAttachmentEvent("B0REALUNKNOWN");
		expect(isCosenseNotificationMessage(event, baseEnv)).toBe(true);
		expect(event.bot_id).toBe("B0REALUNKNOWN");
	});

	test("rejects human messages, other subtypes, and thread replies", () => {
		const human = {
			type: "message",
			channel: "C8P1104Q4",
			ts: "1.1",
			user: "U123",
			text: "hello",
		};
		expect(isCosenseNotificationMessage(human, baseEnv)).toBe(false);

		const otherSubtype = {
			...cosenseAttachmentEvent(),
			subtype: "channel_join",
		};
		expect(isCosenseNotificationMessage(otherSubtype, baseEnv)).toBe(false);

		// Our own per-marker thread posts carry thread_ts != ts: never retrigger.
		const threadReply = {
			...cosenseAttachmentEvent(),
			thread_ts: "1789910193.426639",
			ts: "1789910200.000001",
		};
		expect(isCosenseNotificationMessage(threadReply, baseEnv)).toBe(false);

		// Missing channel/ts is not routable.
		const noTs = { ...cosenseAttachmentEvent() };
		delete (noTs as Record<string, unknown>)["ts"];
		expect(isCosenseNotificationMessage(noTs, baseEnv)).toBe(false);
	});

	test("envelope detector only accepts event_callback", () => {
		const envelope = {
			type: "event_callback",
			event: cosenseAttachmentEvent(),
		};
		expect(isCosenseNotificationEnvelope(envelope, baseEnv)).toBe(true);
		expect(
			isCosenseNotificationEnvelope(
				{ type: "url_verification", challenge: "x" },
				baseEnv,
			),
		).toBe(false);
	});
});

describe("extractNotificationTargets (defensive page identification)", () => {
	test("prefers attachments title_link", () => {
		const targets = extractNotificationTargets(
			cosenseAttachmentEvent(),
			baseEnv,
		);
		expect(targets).toEqual([
			{
				project: "niki-auth",
				title: "Auth memo",
				pageUrl: "https://scrapbox.io/niki-auth/Auth%20memo",
			},
		]);
	});

	test("falls back to outer project link plus attachment title", () => {
		const event = {
			type: "message",
			subtype: "bot_message",
			bot_id: "B1",
			text: "New lines on <https://scrapbox.io/niki-ai|niki-ai>",
			channel: "C1",
			ts: "1.1",
			attachments: [{ title: "Some page" }],
		};
		expect(extractNotificationTargets(event, baseEnv)).toEqual([
			{
				project: "niki-ai",
				title: "Some page",
				pageUrl: "https://scrapbox.io/niki-ai/Some%20page",
			},
		]);
	});

	test("drops projects outside COSENSE_PROJECTS and unknown shapes", () => {
		const evil = {
			type: "message",
			subtype: "bot_message",
			bot_id: "B1",
			text: "New lines on <https://scrapbox.io/evil-proj|evil-proj>",
			channel: "C1",
			ts: "1.1",
			attachments: [
				{ title: "X", title_link: "https://scrapbox.io/evil-proj/X" },
			],
		};
		expect(extractNotificationTargets(evil, baseEnv)).toEqual([]);
		expect(extractNotificationTargets({ nope: true }, baseEnv)).toEqual([]);
		expect(extractNotificationTargets(null, baseEnv)).toEqual([]);
	});
});

describe("parseCosensePageUrl", () => {
	test("keeps slashes inside the title", () => {
		expect(
			parseCosensePageUrl(
				"https://scrapbox.io/niki-auth/a%2Fb/c",
				"https://scrapbox.io",
			),
		).toEqual({ project: "niki-auth", title: "a/b/c" });
		expect(
			parseCosensePageUrl("https://evil.test/p/T", "https://scrapbox.io"),
		).toBeUndefined();
	});
});

describe("handleCosenseNotification (reread + one thread per marker)", () => {
	function depsWithPage(pageBody: string, existing: string[] = []) {
		const posted: Array<{ channel: string; threadTs: string; text: string }> =
			[];
		return {
			posted,
			deps: {
				browsePageText: async () => pageBody,
				listThreadReplyTexts: async () => [...existing],
				postThreadReply: async (
					channel: string,
					threadTs: string,
					text: string,
				) => {
					posted.push({ channel, threadTs, text });
				},
			},
		};
	}

	test("creates ONE thread per marker line from the reread page", async () => {
		const pageBody =
			"[query] MCP の認可を調べて [yuki.icon]\n" +
			"補足\n" +
			"[lint] 古い記述を確認 [yuki.icon]";
		const { posted, deps } = depsWithPage(pageBody);
		const result = await handleCosenseNotification(
			cosenseAttachmentEvent(),
			baseEnv,
			deps,
		);
		expect(result.handled).toBe(true);
		expect(result.targets).toHaveLength(1);
		expect(result.threadsCreated).toBe(2);
		expect(posted).toHaveLength(2);
		expect(posted[0]?.threadTs).toBe("1789910193.426639");
		expect(posted[0]?.channel).toBe("C8P1104Q4");
		expect(posted[0]?.text).toContain("[query]");
		expect(posted[1]?.text).toContain("[lint]");
	});

	test("never trusts the excerpt: markers only in browsePage still fire", async () => {
		// Attachment text has no marker; the reread page does.
		const { posted, deps } = depsWithPage(
			"本文\n[ingest] 取り込み [yuki.icon]",
		);
		const result = await handleCosenseNotification(
			cosenseAttachmentEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(1);
		expect(posted[0]?.text).toContain("[ingest]");
	});

	test("debounce repeats do not duplicate threads", async () => {
		const pageBody = "[query] 調べる [yuki.icon]";
		const instructions = parseMarkerLines(pageBody);
		const target = extractNotificationTargets(
			cosenseAttachmentEvent(),
			baseEnv,
		)[0];
		if (!target) throw new Error("fixture must extract a target");
		const existing = [formatMarkerThreadText(target, instructions[0]!)];
		const { posted, deps } = depsWithPage(pageBody, existing);
		const result = await handleCosenseNotification(
			cosenseAttachmentEvent(),
			baseEnv,
			deps,
		);
		expect(result.threadsCreated).toBe(0);
		expect(result.skippedDuplicates).toBe(1);
		expect(posted).toHaveLength(0);
	});

	test("pages without markers create no threads", async () => {
		const { posted, deps } = depsWithPage("ただの本文です");
		const result = await handleCosenseNotification(
			cosenseAttachmentEvent(),
			baseEnv,
			deps,
		);
		expect(result.handled).toBe(true);
		expect(result.pagesWithoutMarkers).toBe(1);
		expect(posted).toHaveLength(0);
	});

	test("filterUnpostedMarkers matches on marker signature", () => {
		const instructions = parseMarkerLines(
			"[query] A [yuki.icon]\n[lint] B [yuki.icon]",
		);
		const pending = filterUnpostedMarkers(instructions, [
			`noise ${markerSignature(instructions[0]!)} noise`,
		]);
		expect(pending.map((instruction) => instruction.kind)).toEqual(["lint"]);
	});
});
