/**
 * Cosense Slack-notification detection plus per-marker thread creation
 * (Issue #12).
 *
 * Delivery evidence (Issue #2 comments):
 * - Cosense posts arrive as a *different bot's* `message.channels`
 *   `subtype: "bot_message"` event. The Slack adapter does NOT list
 *   `bot_message` in its ignored subtypes, so the event reaches
 *   `Chat.processMessage` and is queued (`message-debouncing` /
 *   `message-dequeued` in prod tail) WITHOUT auto-reply — Think's
 *   `chatSdkMessenger` only registers `direct-message` / `mention` /
 *   `subscribed-thread` / `action` handlers, so an unsubscribed channel
 *   bot post triggers no answer turn.
 * - Live sample (coordinator-captured real notification):
 *   `subtype: "bot_message"`, `bot_id: "B0C39SDPHRP"`, username `Scrapbox`,
 *   text `New lines on <https://scrapbox.io/niki-auth/|niki-auth>`
 *   (project link with trailing slash), `attachments[0]` =
 *   `{ title: ":bookmark:<page title>"` (bookmark-emoji prefix — never used
 *   for identity), `title_link: "<page URL>#<anchor>"` (page identity; the
 *   `#anchor` line fragment is stripped for the canonical page URL),
 *   `text: "<https://scrapbox.io/niki-auth/query|query> test"`
 *   (marker-line content excerpt — hint only, never trusted for detection),
 *   `author_name: "yuki"`, `fallback` mirroring `text` }.
 *   The notifier identity stays configurable via env (`COSENSE_SLACK_BOT_IDS`,
 *   comma-separated; legacy single `COSENSE_SLACK_BOT_ID` also read) with
 *   the live-sampled `B0C39SDPHRP` as the default — never hardcoded at
 *   call sites.
 * - `users:read` is NOT granted (`missing_scope` warn in prod tail is
 *   non-fatal), so detection must not depend on user-info enrichment.
 *
 * Pipeline this module implements:
 * 1. `isCosenseNotificationMessage` — explicit detector for the notifier's
 *    top-level `bot_message` (thread replies excluded so our own thread
 *    posts can never retrigger it).
 * 2. `extractNotificationTargets` — target page(s) from the notification,
 *    matched to the live-sampled shape (`attachments[].title_link` first,
 *    still defensive: outer-text project link + attachment title as
 *    fallback).
 * 3. Re-read via `browsePage` (never trust the excerpt) then reuse the
 *    existing marker detection (`parseMarkerLines`, Issue #13 — trailing
 *    user icon optional since the Issue #12 prod-miss fix; a page with no
 *    markers is logged at info level so the miss is never silent).
 * 4. Post ONE thread reply per marker instruction under the notification
 *    message; debounce repeats are suppressed by checking existing thread
 *    replies before posting (no persistent store, no take-missing fallback).
 *
 * Secrets: `SLACK_BOT_TOKEN` / `COSENSE_PAT` values are never logged or
 * interpolated into posted text. Logs carry only channel/ts/bot_id/project
 * titles plus a truncated excerpt hint (bot_id and page URLs are non-secret
 * identifiers).
 */

import { allowedProjects, projectUrl } from "./config";
import { parseMarkerLines, type MarkerInstruction } from "./marker-parser";
import { runCosense } from "./sandbox";

/** A notifier message as delivered inside the Events API envelope. */
export interface NotificationMessageEvent {
	type?: unknown;
	subtype?: unknown;
	bot_id?: unknown;
	username?: unknown;
	text?: unknown;
	channel?: unknown;
	ts?: unknown;
	thread_ts?: unknown;
	attachments?: unknown;
	[key: string]: unknown;
}

export interface NotificationTarget {
	project: string;
	title: string;
	pageUrl: string;
}

const COSENSE_FALLBACK_ORIGIN = "https://scrapbox.io";

/**
 * Live-sampled Cosense notifier bot id. Default when
 * `COSENSE_SLACK_BOT_IDS` / `COSENSE_SLACK_BOT_ID` are unset — override via
 * env if Cosense ever rotates the integration. A bot_id is a non-secret
 * identifier, safe to keep in code and logs.
 */
export const DEFAULT_COSENSE_NOTIFIER_BOT_IDS = ["B0C39SDPHRP"] as const;

/** Configured notifier bot ids, falling back to the live-sampled default. */
export function getConfiguredNotifierBotIds(env: Env): string[] {
	const record = env as unknown as Record<string, unknown>;
	const rawList =
		record["COSENSE_SLACK_BOT_IDS"] ?? record["COSENSE_SLACK_BOT_ID"];
	if (typeof rawList === "string") {
		const parsed = rawList
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0);
		if (parsed.length > 0) return parsed;
	}
	return [...DEFAULT_COSENSE_NOTIFIER_BOT_IDS];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as Record<string, unknown>;
}

function stringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

/** Pull the inner `event` out of an Events API envelope (or pass through). */
export function getEnvelopeEvent(
	envelope: unknown,
): NotificationMessageEvent | undefined {
	const record = asRecord(envelope);
	if (!record) return undefined;
	if (record["type"] === "event_callback") {
		const inner = asRecord(record["event"]);
		return inner as NotificationMessageEvent | undefined;
	}
	// Already an inner event (tests / adapter-level input).
	if (typeof record["type"] === "string" || typeof record["subtype"] === "string") {
		return record as NotificationMessageEvent;
	}
	return undefined;
}

function eventAttachments(
	event: NotificationMessageEvent,
): Array<Record<string, unknown>> {
	const record = asRecord(event.attachments);
	if (record && Array.isArray((record as { attachments?: unknown }).attachments)) {
		// Chat SDK normalized shape nests under raw.attachments; not used at
		// the edge, but accept it defensively.
		return ((record as { attachments?: unknown }).attachments as unknown[]).flatMap(
			(item) => (asRecord(item) ? [asRecord(item) as Record<string, unknown>] : []),
		);
	}
	if (!Array.isArray(event.attachments)) return [];
	return event.attachments.flatMap((item) =>
		asRecord(item) ? [asRecord(item) as Record<string, unknown>] : [],
	);
}

function hasCosenseShapedAttachment(event: NotificationMessageEvent): boolean {
	const text = typeof event.text === "string" ? event.text : "";
	const outerLooksCosense =
		text.includes("New lines on") || text.includes("scrapbox.io");
	for (const attachment of eventAttachments(event)) {
		const titleLink = stringField(attachment, "title_link");
		const title = stringField(attachment, "title");
		const attachmentText =
			stringField(attachment, "text") ?? stringField(attachment, "rawText") ?? "";
		if (
			(titleLink && titleLink.includes("scrapbox.io")) ||
			(title && outerLooksCosense) ||
			attachmentText.includes("scrapbox.io")
		) {
			return true;
		}
	}
	return outerLooksCosense && eventAttachments(event).length > 0;
}

/**
 * Explicit detector for Cosense notifications.
 *
 * - Requires a top-level channel `bot_message` (thread replies — including
 *   our own per-marker posts — are excluded so they can never retrigger).
 * - `bot_id` must be a configured notifier id (default: the live-sampled
 *   `B0C39SDPHRP`, overridable via `COSENSE_SLACK_BOT_IDS`).
 * - The payload must additionally have the Cosense shape (project link /
 *   scrapbox attachment), so unrelated posts from the same integration —
 *   if it ever sends any — are ignored.
 */
export function isCosenseNotificationMessage(
	event: NotificationMessageEvent | unknown,
	env: Env,
): boolean {
	const record = asRecord(event);
	if (!record) return false;
	if (record["type"] !== undefined && record["type"] !== "message") return false;
	if (record["subtype"] !== "bot_message") return false;

	const channel = stringField(record, "channel");
	const ts = stringField(record, "ts");
	if (!channel || !ts) return false;

	// Thread replies are follow-ups, never fresh notifications.
	const threadTs = stringField(record, "thread_ts");
	if (threadTs !== undefined && threadTs !== ts) return false;

	const configured = getConfiguredNotifierBotIds(env);
	const botId = stringField(record, "bot_id");
	if (!botId || !configured.includes(botId)) return false;
	return hasCosenseShapedAttachment(record as NotificationMessageEvent);
}

/** Envelope-level detector used at the webhook edge. */
export function isCosenseNotificationEnvelope(
	envelope: unknown,
	env: Env,
): boolean {
	// Only event_callback envelopes carry channel messages; url_verification
	// and other envelope types must never match.
	if (asRecord(envelope)?.["type"] !== "event_callback") return false;
	const event = getEnvelopeEvent(envelope);
	if (!event) return false;
	return isCosenseNotificationMessage(event, env);
}

/** Cosense origin for link parsing (env value, validated elsewhere). */
function cosenseOrigin(env: Env): string {
	const origin =
		(env as unknown as Record<string, unknown>)["COSENSE_ORIGIN"];
	return typeof origin === "string" && origin.length > 0
		? origin
		: COSENSE_FALLBACK_ORIGIN;
}

/**
 * Split a Cosense page URL into project + title.
 * Titles may contain slashes, so only the first path segment is the project
 * and the remainder (joined) is the title.
 */
export function parseCosensePageUrl(
	pageUrl: string,
	origin: string,
): { project: string; title: string } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(pageUrl);
	} catch {
		return undefined;
	}
	const expected = (() => {
		try {
			return new URL(origin).origin;
		} catch {
			return COSENSE_FALLBACK_ORIGIN;
		}
	})();
	if (parsed.origin !== expected) return undefined;
	const segments = parsed.pathname.split("/").filter((part) => part.length > 0);
	if (segments.length < 2) return undefined;
	const project = segments[0];
	if (!project) return undefined;
	const title = decodeURIComponent(segments.slice(1).join("/")).trim();
	if (!title) return undefined;
	return { project, title };
}

/** Find scrapbox page URLs inside free text (outer text fallback). */
function findPageUrls(text: string, origin: string): string[] {
	const urls: string[] = [];
	const pattern = /https?:\/\/[^\s<>"'`|]+/g;
	for (const match of text.matchAll(pattern)) {
		const candidate = match[0].replace(/[.,;:!?)\]]+$/, "");
		if (candidate.startsWith(origin)) urls.push(candidate);
	}
	return urls;
}

/**
 * Best-effort strip of the bookmark-emoji/shortcode prefix the live
 * notification prepends to `attachments[].title` (`:bookmark:Foo`, 🔖Foo).
 * Fallback path only — page identity always comes from `title_link`, so a
 * title that is legitimately emoji-first is never harmed on the primary
 * path.
 */
export function stripNotificationTitlePrefix(title: string): string {
	return title
		.replace(/^(?::[A-Za-z0-9_+-]+:|\p{Extended_Pictographic}\uFE0F?)+/u, "")
		.trim();
}

/**
 * Identify target page(s) from a notification, matched to the live-sampled
 * shape and still defensive.
 *
 * Order: `attachments[].title_link` first (page identity; a `#anchor` line
 * fragment is stripped for the canonical page URL), then outer-text project
 * link combined with `attachments[].title` (bookmark prefix stripped),
 * then any scrapbox URL found in attachment text fields. Projects outside
 * `COSENSE_PROJECTS` are dropped — the notification is not a trust
 * boundary. Never throws; unparsable input yields an empty list.
 */
export function extractNotificationTargets(
	event: NotificationMessageEvent | unknown,
	env: Env,
): NotificationTarget[] {
	try {
		const record = asRecord(event);
		if (!record) return [];
		const origin = cosenseOrigin(env);
		const allowed = new Set(allowedProjects(env));
		const targets: NotificationTarget[] = [];
		const seen = new Set<string>();

		const push = (project: string, title: string, pageUrl: string) => {
			const cleanTitle = title.trim();
			if (!allowed.has(project) || cleanTitle === "") return;
			const key = `${project}\u0000${cleanTitle}`;
			if (seen.has(key)) return;
			seen.add(key);
			// Strip a `#anchor` line fragment: it points at one revision's
			// line, not the page identity (a literal `#` in a Cosense title
			// arrives percent-encoded as %23, so this never harms titles).
			const canonicalUrl = pageUrl.split("#")[0] || pageUrl;
			targets.push({ project, title: cleanTitle, pageUrl: canonicalUrl });
		};

		const outerText = stringField(record, "text") ?? "";
		const outerUrls = findPageUrls(outerText, origin);
		const outerProject = (() => {
			for (const url of outerUrls) {
				const parsed = parseCosensePageUrl(url, origin);
				// Outer "New lines on <origin/project>" links carry only the
				// project (single path segment); accept that shape here.
				if (!parsed) {
					try {
						const u = new URL(url);
						const segments = u.pathname
							.split("/")
							.filter((part) => part.length > 0);
						if (u.origin === new URL(origin).origin && segments.length === 1) {
							return segments[0];
						}
					} catch {
						// fall through
					}
					continue;
				}
				return parsed.project;
			}
			return undefined;
		})();

		for (const attachment of eventAttachments(
			record as NotificationMessageEvent,
		)) {
			const titleLink = stringField(attachment, "title_link");
			if (titleLink) {
				const parsed = parseCosensePageUrl(titleLink, origin);
				if (parsed) {
					push(parsed.project, parsed.title, titleLink);
					continue;
				}
			}
			// Fallback: attachment title + outer project link.
			const title = stringField(attachment, "title");
			if (title && outerProject) {
				push(
					outerProject,
					stripNotificationTitlePrefix(title),
					`${origin}/${outerProject}/${encodeURIComponent(stripNotificationTitlePrefix(title))}`,
				);
				continue;
			}
			// Last resort: scrapbox URLs buried in attachment text fields.
			const fallbackText = [
				stringField(attachment, "text") ?? "",
				stringField(attachment, "rawText") ?? "",
			].join("\n");
			for (const url of findPageUrls(fallbackText, origin)) {
				const parsed = parseCosensePageUrl(url, origin);
				if (parsed) push(parsed.project, parsed.title, url);
			}
		}
		return targets;
	} catch {
		return [];
	}
}

/**
 * Excerpt hint lines from a notification (`attachments[].text`, then
 * `fallback` when different). The live sample carries the marker-line
 * content here — useful as a log hint, but NEVER trusted for marker
 * detection; threads are created only from the `browsePage` re-read.
 */
export function extractNotificationExcerpts(
	event: NotificationMessageEvent | unknown,
): string[] {
	const record = asRecord(event);
	if (!record) return [];
	const excerpts: string[] = [];
	for (const attachment of eventAttachments(
		record as NotificationMessageEvent,
	)) {
		for (const key of ["text", "fallback"] as const) {
			const value = stringField(attachment, key);
			if (!value) continue;
			const trimmed = value.trim();
			if (trimmed !== "" && !excerpts.includes(trimmed)) {
				excerpts.push(trimmed);
			}
		}
	}
	return excerpts;
}

/** Stable per-marker identity used for duplicate suppression. */export function markerSignature(instruction: MarkerInstruction): string {
	const children = instruction.children.join("\n");
	return `[${instruction.kind}] ${instruction.text}\n${children}`;
}

/**
 * One thread reply per marker instruction. The text embeds the page link and
 * the marker content so the thread is actionable without trusting the
 * notification excerpt.
 */
export function formatMarkerThreadText(
	target: NotificationTarget,
	instruction: MarkerInstruction,
): string {
	const childLines =
		instruction.children.length > 0
			? `\n${instruction.children.map((child) => ` ${child}`).join("\n")}`
			: "";
	return (
		`「${target.title}」 ${target.pageUrl} のマーカーを検出しました\n` +
		`[${instruction.kind}] ${instruction.text}${childLines}`
	);
}

/** Drop markers whose signature already appears in existing thread replies. */
export function filterUnpostedMarkers(
	instructions: readonly MarkerInstruction[],
	existingReplyTexts: readonly string[],
): MarkerInstruction[] {
	if (existingReplyTexts.length === 0) return [...instructions];
	return instructions.filter((instruction) => {
		const signature = markerSignature(instruction).trim();
		if (signature === "[]") return true;
		return !existingReplyTexts.some((reply) => reply.includes(signature));
	});
}

/** Fingerprint for logs (channel + notification ts + page). */
export function notificationKey(
	channel: string,
	threadTs: string,
	target: NotificationTarget,
): string {
	return `${channel}:${threadTs}:${target.project}/${target.title}`;
}

export interface NotificationHandlerDeps {
	browsePageText: (project: string, title: string) => Promise<string | null>;
	listThreadReplyTexts: (channel: string, threadTs: string) => Promise<string[]>;
	postThreadReply: (
		channel: string,
		threadTs: string,
		text: string,
	) => Promise<void>;
}

export interface NotificationHandleResult {
	handled: boolean;
	targets: NotificationTarget[];
	threadsCreated: number;
	skippedDuplicates: number;
	pagesWithoutMarkers: number;
}

/**
 * Handle one notifier message: re-read each target page with browsePage,
 * detect markers, and post one thread per unposted marker.
 * Never trusts the notification excerpt for marker detection.
 */
export async function handleCosenseNotification(
	event: NotificationMessageEvent,
	env: Env,
	deps: NotificationHandlerDeps,
): Promise<NotificationHandleResult> {
	const empty: NotificationHandleResult = {
		handled: false,
		targets: [],
		threadsCreated: 0,
		skippedDuplicates: 0,
		pagesWithoutMarkers: 0,
	};
	if (!isCosenseNotificationMessage(event, env)) return empty;

	const channel = (event.channel as string) ?? "";
	const threadTs = (event.ts as string) ?? "";
	const targets = extractNotificationTargets(event, env);
	const excerpts = extractNotificationExcerpts(event);
	if (excerpts.length > 0) {
		console.log(
			`[cosense-notification] excerpt hint channel=${channel} ts=${threadTs} excerpt=${excerpts[0]?.slice(0, 200)}`,
		);
	}
	if (targets.length === 0) {
		console.log(
			`[cosense-notification] no target page extracted channel=${channel} ts=${threadTs}`,
		);
		return { ...empty, handled: true };
	}

	const result: NotificationHandleResult = {
		handled: true,
		targets,
		threadsCreated: 0,
		skippedDuplicates: 0,
		pagesWithoutMarkers: 0,
	};

	let existingTexts: string[] | undefined;
	for (const target of targets) {
		const key = notificationKey(channel, threadTs, target);
		let pageBody: string | null;
		try {
			pageBody = await deps.browsePageText(target.project, target.title);
		} catch (error) {
			console.error(
				`[cosense-notification] browsePage failed key=${key} error=${error instanceof Error ? error.name : "unknown"}`,
			);
			continue;
		}
		if (!pageBody) {
			console.error(`[cosense-notification] browsePage empty key=${key}`);
			continue;
		}
		const instructions = parseMarkerLines(pageBody);
		if (instructions.length === 0) {
			// Info-level (not silent): a notification that yields no markers
			// is the primary miss signal — prod showed an icon-less marker
			// line dropping here with zero log output before this line.
			console.log(
				`[cosense-notification] no markers key=${key} page=${target.project}/${target.title}`,
			);
			result.pagesWithoutMarkers += 1;
			continue;
		}
		try {
			existingTexts ??= await deps.listThreadReplyTexts(channel, threadTs);
		} catch (error) {
			console.error(
				`[cosense-notification] listReplies failed key=${key} error=${error instanceof Error ? error.name : "unknown"}`,
			);
			existingTexts = [];
		}
		const pending = filterUnpostedMarkers(instructions, existingTexts);
		result.skippedDuplicates += instructions.length - pending.length;
		for (const instruction of pending) {
			const text = formatMarkerThreadText(target, instruction);
			try {
				await deps.postThreadReply(channel, threadTs, text);
			} catch (error) {
				console.error(
					`[cosense-notification] postReply failed key=${key} error=${error instanceof Error ? error.name : "unknown"}`,
				);
				continue;
			}
			existingTexts.push(markerSignature(instruction));
			result.threadsCreated += 1;
			console.log(
				`[cosense-notification] thread created key=${key} kind=${instruction.kind}`,
			);
		}
	}
	return result;
}

async function slackApi(
	method: "conversations.replies" | "chat.postMessage",
	token: string,
	params: Record<string, string>,
	body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const url =
		method === "conversations.replies"
			? `https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`
			: `https://slack.com/api/${method}`;
	const response = await fetch(url, {
		method: method === "conversations.replies" ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	const payload = (await response.json()) as Record<string, unknown>;
	if (payload["ok"] !== true) {
		throw new Error(
			`Slack API ${method} failed: ${typeof payload["error"] === "string" ? payload["error"] : "unknown_error"}`,
		);
	}
	return payload;
}

/** Production deps: Sandbox browsePage re-read + Slack thread APIs. */
export function liveNotificationDeps(env: Env): NotificationHandlerDeps {
	return {
		browsePageText: async (project, title) => {
			const result = await runCosense(env, project, [
				"browsePage",
				`${projectUrl(env, project)}/${encodeURIComponent(title)}`,
			]);
			if (!result.ok) return null;
			return result.stdout;
		},
		listThreadReplyTexts: async (channel, threadTs) => {
			const payload = await slackApi(
				"conversations.replies",
				env.SLACK_BOT_TOKEN,
				{ channel, ts: threadTs, limit: "50" },
			);
			const messages = Array.isArray(payload["messages"])
				? (payload["messages"] as unknown[])
				: [];
			return messages.flatMap((message) => {
				const text = asRecord(message)?.["text"];
				return typeof text === "string" ? [text] : [];
			});
		},
		postThreadReply: async (channel, threadTs, text) => {
			await slackApi("chat.postMessage", env.SLACK_BOT_TOKEN, {}, {
				channel,
				thread_ts: threadTs,
				text,
			});
		},
	};
}
