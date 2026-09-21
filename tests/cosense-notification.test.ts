import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COSENSE_NOTIFIER_BOT_IDS,
	extractNotificationExcerpts,
	extractNotificationTargets,
	filterUnpostedMarkers,
	formatMarkerThreadText,
	getConfiguredNotifierBotIds,
	handleCosenseNotification,
	isCosenseNotificationEnvelope,
	isCosenseNotificationMessage,
	markerSignature,
	parseCosensePageUrl,
	stripNotificationTitlePrefix,
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

/** Live-sampled Cosense notifier bot id (coordinator-captured). */
const LIVE_BOT_ID = "B0C39SDPHRP";

/** Generic Cosense-shaped event; defaults to the live notifier identity. */
function cosenseAttachmentEvent(botId = LIVE_BOT_ID) {
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
	test("defaults to the live-sampled bot_id, overridable via env", () => {
		expect(DEFAULT_COSENSE_NOTIFIER_BOT_IDS).toContain(LIVE_BOT_ID);
		expect(getConfiguredNotifierBotIds(baseEnv)).toEqual([LIVE_BOT_ID]);
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

	test("matches the live notifier with no explicit config (default)", () => {
		expect(isCosenseNotificationMessage(cosenseAttachmentEvent(), baseEnv)).toBe(
			true,
		);
	});

	test("rejects a different bot_id", () => {
		expect(
			isCosenseNotificationMessage(
				cosenseAttachmentEvent("B999OTHER"),
				withNotifier("B000COSENSE"),
			),
		).toBe(false);
		expect(
			isCosenseNotificationMessage(cosenseAttachmentEvent("B999OTHER"), baseEnv),
		).toBe(false);
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

describe("live-sample shape (coordinator-captured real notification)", () => {
	/** Exact live shape: bookmark-prefixed title, anchored title_link. */
	function liveNotificationEvent() {
		return {
			type: "message",
			subtype: "bot_message",
			bot_id: LIVE_BOT_ID,
			username: "Scrapbox",
			text: "New lines on <https://scrapbox.io/niki-auth/|niki-auth>",
			channel: "C8P1104Q4",
			ts: "1789910193.426639",
			attachments: [
				{
					title: ":bookmark:Test query page",
					title_link:
						"https://scrapbox.io/niki-auth/Test%20query%20page#68d1234abc",
					text: "<https://scrapbox.io/niki-auth/query|query> test",
					fallback: "<https://scrapbox.io/niki-auth/query|query> test",
					author_name: "yuki",
				},
			],
		} as unknown as NotificationMessageEvent;
	}

	test("detector matches the live event with default config", () => {
		expect(isCosenseNotificationMessage(liveNotificationEvent(), baseEnv)).toBe(
			true,
		);
		expect(
			isCosenseNotificationEnvelope(
				{ type: "event_callback", event: liveNotificationEvent() },
				baseEnv,
			),
		).toBe(true);
	});

	test("extracts the page URL from title_link (anchor stripped)", () => {
		expect(extractNotificationTargets(liveNotificationEvent(), baseEnv)).toEqual([
			{
				project: "niki-auth",
				title: "Test query page",
				pageUrl: "https://scrapbox.io/niki-auth/Test%20query%20page",
			},
		]);
	});

	test("extracts the marker line from the attachments text", () => {
		expect(extractNotificationExcerpts(liveNotificationEvent())).toEqual([
			"<https://scrapbox.io/niki-auth/query|query> test",
		]);
	});

	test("extracts the project from the text link (no title_link variant)", () => {
		const event = liveNotificationEvent();
		const attachments = (
			event.attachments as Array<Record<string, unknown>>
		).map((attachment) => {
			const copy = { ...attachment };
			delete copy["title_link"];
			return copy;
		});
		const withoutLink = { ...event, attachments };
		expect(
			extractNotificationTargets(withoutLink, baseEnv),
		).toEqual([
			{
				project: "niki-auth",
				title: "Test query page",
				pageUrl: "https://scrapbox.io/niki-auth/Test%20query%20page",
			},
		]);
	});

	test("strips the bookmark prefix on the fallback path only", () => {
		expect(stripNotificationTitlePrefix(":bookmark:Test query page")).toBe(
			"Test query page",
		);
		expect(stripNotificationTitlePrefix("🔖Test query page")).toBe(
			"Test query page",
		);
		expect(stripNotificationTitlePrefix("Plain title")).toBe("Plain title");
	});

	test("handler creates a thread from the live event via reread", async () => {
		const posted: string[] = [];
		const result = await handleCosenseNotification(
			liveNotificationEvent(),
			baseEnv,
			{
				browsePageText: async (project, title) => {
					expect(project).toBe("niki-auth");
					expect(title).toBe("Test query page");
					return "本文\n[query] test [yuki.icon]";
				},
				listThreadReplyTexts: async () => [],
				postThreadReply: async (channel, threadTs, text) => {
					expect(channel).toBe("C8P1104Q4");
					expect(threadTs).toBe("1789910193.426639");
					posted.push(text);
				},
			},
		);
		expect(result.handled).toBe(true);
		expect(result.threadsCreated).toBe(1);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toContain("[query] test");
		expect(posted[0]).toContain(
			"https://scrapbox.io/niki-auth/Test%20query%20page",
		);
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

describe("prod-miss regression (icon-less marker, exact live attachment shape)", () => {
  /** Exact shape of the missed prod notification (ts 1789961895.695819). */
  function missedNotificationEvent() {
    return {
      type: "message",
      subtype: "bot_message",
      bot_id: LIVE_BOT_ID,
      username: "Scrapbox",
      text: "New lines on <https://scrapbox.io/niki-auth/|niki-auth>",
      channel: "C8P1104Q4",
      ts: "1789961895.695819",
      attachments: [
        {
          title: ":bookmark:Test query page",
          title_link:
            "https://scrapbox.io/niki-auth/Test%20query%20page#6ab0a64dabcd",
          text: "<https://scrapbox.io/niki-auth/query|query> prod-verify",
          fallback: "<https://scrapbox.io/niki-auth/query|query> prod-verify",
          author_name: "yuki",
        },
      ],
    } as unknown as NotificationMessageEvent;
  }

  test("detector and target extraction match the missed event", () => {
    expect(
      isCosenseNotificationMessage(missedNotificationEvent(), baseEnv),
    ).toBe(true);
    expect(
      extractNotificationTargets(missedNotificationEvent(), baseEnv),
    ).toEqual([
      {
        project: "niki-auth",
        title: "Test query page",
        pageUrl: "https://scrapbox.io/niki-auth/Test%20query%20page",
      },
    ]);
  });

  test("icon-less marker line parses (trailing icon optional)", () => {
    expect(parseMarkerLines("[query] prod-verify")).toEqual([
      { kind: "query", text: "prod-verify", children: [] },
    ]);
    // Other users' icons and the legacy icon parse identically.
    expect(parseMarkerLines("[query] foo [niboshi.icon]")[0]?.text).toBe(
      "foo",
    );
    expect(parseMarkerLines("[query] foo [yuki.icon]")[0]?.text).toBe("foo");
    // Column-zero requirement still holds: indented markers stay inert.
    expect(parseMarkerLines(" [query] prod-verify")).toEqual([]);
  });

  test("handler creates a thread from the missed event via reread", async () => {
    const posted: string[] = [];
    const result = await handleCosenseNotification(
      missedNotificationEvent(),
      baseEnv,
      {
        browsePageText: async () => "[query] prod-verify",
        listThreadReplyTexts: async () => [],
        postThreadReply: async (channel, threadTs, text) => {
          expect(channel).toBe("C8P1104Q4");
          expect(threadTs).toBe("1789961895.695819");
          posted.push(text);
        },
      },
    );
    expect(result.handled).toBe(true);
    expect(result.pagesWithoutMarkers).toBe(0);
    expect(result.threadsCreated).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("[query] prod-verify");
  });
});
