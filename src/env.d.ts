// Secrets are set with `bunx wrangler secret put` and so never appear in
// wrangler.jsonc — `bunx wrangler types` cannot see them. Merge them into the
// generated Env interfaces here so they are typed like any other binding.
//
// This file must stay free of top-level import/export to remain a global script.

declare namespace Cloudflare {
	interface Env {
		SLACK_BOT_TOKEN: string;
		SLACK_SIGNING_SECRET: string;
		OPENROUTER_API_KEY: string;
		/** Service Account access key for the bot's own Cosense account (cs_…). */
		COSENSE_PAT: string;
	}
}

interface Env {
	SLACK_BOT_TOKEN: string;
	SLACK_SIGNING_SECRET: string;
	OPENROUTER_API_KEY: string;
	COSENSE_PAT: string;
}
