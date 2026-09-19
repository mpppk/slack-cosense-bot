import { createSlackAdapter } from "@chat-adapter/slack";
import { verifySlackRequest } from "@chat-adapter/slack/webhook";
import { Sandbox } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import {
	chatSdkMessenger,
	ThinkMessengerStateAgent,
	type ThinkMessengers,
} from "@cloudflare/think/messengers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { buildSystemPrompt } from "./prompt";
import { createCosenseTools } from "./tools/cosense";

// Sandbox backs the cosense CLI container; ThinkMessengerStateAgent backs Chat
// SDK thread state. Both must be exported for sub-agent routing to resolve them.
export { Sandbox, ThinkMessengerStateAgent };

export class SlackCosenseBot extends Think {
	getModel(): LanguageModel {
		const openrouter = createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY });
		return openrouter.chat(this.env.OPENROUTER_MODEL);
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
		});

		return {
			// The key becomes the webhook path: /messengers/slack/webhook
			slack: chatSdkMessenger({
				adapter: slack,
				provider: "slack",
				userName: this.env.SLACK_BOT_USER_NAME,

				// The Slack adapter verifies the signing secret itself, so Think
				// must not try to verify the webhook a second time.
				verifyWebhook: false,

				// "mention" alone only covers the first message. subscribed-thread is
				// what makes "@bot ...ですか" then plain replies work, which is the
				// Slack-native shape we want.
				respondTo: ["direct-message", "mention", "subscribed-thread"],
			}),
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
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
