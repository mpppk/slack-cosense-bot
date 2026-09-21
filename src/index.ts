import { createSlackAdapter } from "@chat-adapter/slack";
import { verifySlackRequest } from "@chat-adapter/slack/webhook";
import { Sandbox } from "@cloudflare/sandbox";
import { Think, type ChatOptions, type StreamCallback, type TurnInputMessages } from "@cloudflare/think";
import {
	chatSdkMessenger,
	ThinkMessengerStateAgent,
	type ThinkMessengers,
} from "@cloudflare/think/messengers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import {
	ClassifiedTurnError,
	classifyError,
	isClassifiedTurnError,
	sanitizeText,
	threadErrorMessage,
} from "./errors";
import {
	getEnvelopeEvent,
	handleCosenseNotification,
	isCosenseNotificationEnvelope,
	liveNotificationDeps,
} from "./cosense-notification";
import { buildSystemPrompt } from "./prompt";
import { resolveReceiptPost } from "./receipt";
import { createCosenseTools } from "./tools/cosense";

// Sandbox backs the cosense CLI container; ThinkMessengerStateAgent backs Chat
// SDK thread state. Both must be exported for sub-agent routing to resolve them.
export { Sandbox, ThinkMessengerStateAgent };

export class SlackCosenseBot extends Think {
	getModel(): LanguageModel {
		const openrouter = createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY });
		return openrouter.chat(this.env.OPENROUTER_MODEL);
	}

	/**
	 * Classify a failed model turn and post exactly one safe message to the
	 * originating thread (Issue #10).
	 *
	 * This override runs inside chatWithMessengerContext's messenger-context
	 * window, so deliverNotice resolves the bound thread surface (not "web").
	 * The raw error is only written to server-side logs after sanitization;
	 * the thread gets the classified定型文 with no interpolated content.
	 * Replaces the failure with ClassifiedTurnError so the delivery policy
	 * below suppresses Think's generic errorResponseText (no duplicate post).
	 */
	override async chat(
		userMessage: TurnInputMessages,
		callback: StreamCallback,
		options?: ChatOptions,
	): Promise<void> {
		try {
			await super.chat(userMessage, callback, options);
		} catch (error) {
			if (isClassifiedTurnError(error)) throw error;
			const kind = classifyError(error);
			const threadMessage = threadErrorMessage(kind);
			const detail =
				error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			console.error(
				`[slack-cosense-bot] turn failed kind=${kind} detail=${sanitizeText(detail)}`,
			);
			await this.deliverNotice({ markdown: threadMessage }).catch(
				() => undefined,
			);
			throw new ClassifiedTurnError(kind, threadMessage, error);
		}
	}

	getSystemPrompt(): string {
		return buildSystemPrompt();
	}

	getTools(): ToolSet {
		return createCosenseTools({
			env: this.env,
			model: this.getModel(),
			// thread.id is the Chat SDK id (slack:C123:1787.123); the Slack channel
			// the description lives on is thread.channelId.
			channelId: () => this.getMessengerContext()?.thread.channelId,
		});
	}

	getMessengers(): ThinkMessengers {
		const slack = createSlackAdapter({
			botToken: this.env.SLACK_BOT_TOKEN,
			signingSecret: this.env.SLACK_SIGNING_SECRET,
			webClientOptions: {
				// axios の fetch adapter は cache:'default' を固定で渡すが、
				// workerd の Request はそれを拒否する (TypeError)。失敗すると
				// WebClient の約30分 retry が発動し webhook が無応答になるため、
				// fetchOptions で no-store を強制し、timeout も付ける。
				requestInterceptor: (config) => {
					config.fetchOptions = {
						...(config.fetchOptions ?? {}),
						cache: "no-store",
					};
					return config;
				},
				timeout: 15_000,
			},
		});

		// The Chat SDK fallback streamer opens every channel-mention answer with
		// a bare "..." post, then rewrites it with edits as model chunks arrive
		// (native streaming needs a DM/recipient context, which mentions lack).
		// Rewrite only that placeholder into a cold-start-aware receipt (#9);
		// stream edits and the empty/error/interrupted texts pass through
		// untouched — errorResponseText and error classification belong to a
		// parallel task and are not modified here.
		const postMessage = slack.postMessage.bind(slack);
		slack.postMessage = (threadId, message) =>
			postMessage(threadId, resolveReceiptPost(message));

		return {
			// The key becomes the webhook path: /messengers/slack/webhook
			slack: chatSdkMessenger({
				adapter: slack,
				provider: "slack",
				userName: this.env.SLACK_BOT_USER_NAME,

				// The Slack adapter verifies the signing secret itself, so Think
				// must not try to verify the webhook a second time.
				verifyWebhook: false,

				// Issue #10: turn failures outside the model turn (and any path
				// that escapes chat() before it posts a classified message) fall
				// back to this safe generic text — never raw error content.
				// Failures already reported via chat() throw ClassifiedTurnError,
				// which this predicate recognizes so Think skips a duplicate
				// generic post and the thread sees exactly one message.
				delivery: {
					errorResponseText: threadErrorMessage("unknown"),
					isExpectedDeliveryCompletion: (error) =>
						isClassifiedTurnError(error),
				},

				// "mention" alone only covers the first message. subscribed-thread is
				// what makes "@bot ...ですか" then plain replies work, which is the
				// Slack-native shape we want.
				respondTo: ["direct-message", "mention", "subscribed-thread"],
			}),
		};
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx?: { waitUntil: (promise: Promise<unknown>) => void },
	): Promise<Response> {
		// Messenger webhooks are root Think routes. Forward them to the single
		// root agent instance because routeAgentRequest only handles /agents/*.
		if (new URL(request.url).pathname === "/messengers/slack/webhook") {
			// Slack's URL verification must complete before the Agent is started.
			// Handling that handshake at the Worker edge avoids a cold-start timeout;
			// ordinary events continue through Think for normal processing.
			const body = await request.clone().text();
			let payload: { type?: unknown; challenge?: unknown };
			try {
				payload = JSON.parse(body) as typeof payload;
			} catch {
				return new Response("Invalid JSON", { status: 400 });
			}
			if (payload.type === "url_verification") {
				try {
					await verifySlackRequest(request.clone(), {
						signingSecret: env.SLACK_SIGNING_SECRET,
					});
				} catch {
					return new Response("Invalid signature", { status: 401 });
				}
				if (typeof payload.challenge !== "string") {
					return new Response("Invalid challenge", { status: 400 });
				}
				return Response.json({ challenge: payload.challenge });
			}
			if (typeof payload.type !== "string") {
				return new Response("Invalid event", { status: 400 });
			}
			// Issue #12: explicit detector/route for Cosense notifications.
			// Bot-posted channel messages queue in Chat SDK without starting a
			// Think answer turn (respondTo has no bot-message kind), so the
			// notifier is handled here at the edge: signature-verified, then
			// processed in the background while the envelope still forwards
			// to Think below (queue behavior unchanged). No receipt (#9) or
			// error-classification (#10) paths are altered by this hunk.
			if (payload.type === "event_callback") {
				try {
					if (isCosenseNotificationEnvelope(payload, env)) {
						const inner = getEnvelopeEvent(payload);
						const botId =
							typeof inner?.bot_id === "string" ? inner.bot_id : "unknown";
						const channel =
							typeof inner?.channel === "string" ? inner.channel : "unknown";
						const ts = typeof inner?.ts === "string" ? inner.ts : "unknown";
						console.log(
							`[cosense-notification] detected channel=${channel} ts=${ts} bot_id=${botId}`,
						);
						try {
							await verifySlackRequest(request.clone(), {
								signingSecret: env.SLACK_SIGNING_SECRET,
							});
						} catch {
							console.error(
								"[cosense-notification] signature invalid, skipping",
							);
							throw new Error("skip-notification");
						}
						const task = handleCosenseNotification(
							inner ?? {},
							env,
							liveNotificationDeps(env),
						).catch((error) => {
							console.error(
								`[cosense-notification] background handle failed error=${error instanceof Error ? error.name : "unknown"}`,
							);
						});
						if (ctx) ctx.waitUntil(task);
						else void task;
					}
				} catch (error) {
					if (error instanceof Error && error.message === "skip-notification") {
						// Signature failure already logged; still forward to Think so
						// the adapter applies its own verification.
					} else {
						console.error(
							`[cosense-notification] detector failed error=${error instanceof Error ? error.name : "unknown"}`,
						);
					}
				}
			}
			const agent = env.SlackCosenseBot.get(
				env.SlackCosenseBot.idFromName("default"),
			);
			return agent.fetch(request);
		}

		return (
			(await routeAgentRequest(request, env)) ??
			new Response("Not found", { status: 404 })
		);
	},
};
