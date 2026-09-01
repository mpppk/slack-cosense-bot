import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestPath = new URL(
	"../slack-app-manifest.template.json",
	import.meta.url,
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const expectedBotScopes = [
	"app_mentions:read",
	"chat:write",
	"channels:history",
	"groups:history",
	"im:history",
	"channels:read",
	"groups:read",
	"im:read",
];
const expectedBotEvents = [
	"app_mention",
	"message.channels",
	"message.groups",
	"message.im",
];

assert.equal(manifest.display_information?.name, "Cosense Bot");
assert.equal(manifest.features?.bot_user?.display_name, "cosense-bot");
assert.deepEqual(manifest.oauth_config?.scopes?.bot, expectedBotScopes);
assert.deepEqual(
	manifest.settings?.event_subscriptions?.bot_events,
	expectedBotEvents,
);
assert.equal(
	manifest.settings?.event_subscriptions?.request_url,
	"https://<worker>.workers.dev/messengers/slack/webhook",
);
assert.equal(manifest.settings?.socket_mode_enabled, false);

function stringValues(value) {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringValues);
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(stringValues);
	}
	return [];
}

const serializedValues = stringValues(manifest).join("\n");
for (const secretPattern of [
	/xox[baprs]-/i,
	/xapp-/i,
	/xoxe\./i,
	/(?:^|[^a-z])(?:token|secret|client_secret)(?:$|[^a-z])/i,
	/sk-[a-z0-9]/i,
]) {
	assert.equal(
		secretPattern.test(serializedValues),
		false,
		`manifest contains a value that resembles a credential (${secretPattern})`,
	);
}

console.log("Validated slack-app-manifest.template.json");
