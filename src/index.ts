import { createSlackAdapter } from "@chat-adapter/slack";
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
		return (
			(await routeAgentRequest(request, env)) ??
			new Response("Not found", { status: 404 })
		);
	},
};
