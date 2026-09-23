import { allowedProjects } from "./config";

/**
 * Slack チャンネル ↔ Cosense プロジェクトの紐づけ (複数対応)。
 *
 * 書式 (チャンネルの description / purpose / topic のどこかに1行):
 *
 *   cosense: niki-auth, niki-ai
 *
 * - プレフィックス `cosense:` は大文字小文字を問わない。全角 `：` と `=` も可
 * - 区切りはカンマ・空白・`、` のいずれも可
 * - 各トークンはプロジェクト名 (`niki-auth`) でも URL
 *   (`https://scrapbox.io/niki-auth`) でもよい。URL からは先頭の
 *   プロジェクト名部分だけを抜き出す
 * - 自然文との見分けはプレフィックスの有無で行う。`cosense:` の無い
 *   description はレガシーとして扱い、`scrapbox.io/<name>` 形式の URL と
 *   allowlist に完全一致する素のプロジェクト名だけを拾う
 *
 * 判定は正規表現による決定的パースのみで行い、LLM は使わない。
 * 旧実装の LLM 抜き出しは、自然文との区別が付かず・モデル呼び出しの
 * コストもかかるため廃止した。
 *
 * The description is editable by any channel member, so it is NOT a trust
 * boundary. Two things contain the blast radius:
 *
 *   1. parsed names are checked against COSENSE_PROJECTS, and
 *   2. the PAT owner's Cosense account is a member of the intended projects.
 *
 * The PAT may see more projects than this bot should use, so neither the
 * account membership nor the allow-list alone is enough — keep both.
 */

export type ProjectResolution =
	| { kind: "resolved"; projects: string[]; rejected?: string[] }
	| { kind: "unset"; reason: string }
	| { kind: "rejected"; candidates: string[] };

interface CachedResolution {
	value: ProjectResolution;
	expiresAt: number;
}

/**
 * Per-isolate memo. conversations.info on every message would be wasteful,
 * and channel descriptions change rarely. A cold isolate just looks it up
 * again, so there is nothing to invalidate on deploy.
 */
const cache = new Map<string, CachedResolution>();
const CACHE_TTL_MS = 5 * 60_000;

interface SlackConversationInfo {
	ok: boolean;
	error?: string;
	channel?: {
		name?: string;
		purpose?: { value?: string };
		topic?: { value?: string };
	};
}

/**
 * Strip the Chat SDK provider prefix ("slack:C123" -> "C123").
 *
 * Thread/channel ids from the messenger context are provider-prefixed, but
 * the Slack Web API wants the raw channel id and answers channel_not_found
 * otherwise. Slack channel ids never contain a colon, so the first segment
 * is always the provider.
 */
export function toSlackChannelId(channelId: string): string {
	const index = channelId.indexOf(":");
	return index === -1 ? channelId : channelId.slice(index + 1);
}

/**
 * Read a channel's description text.
 *
 * Slack exposes two free-text fields and people use them interchangeably, so
 * both are handed to the parser. Requires channels:read (public channels),
 * groups:read (private), and im:read (DMs) on the bot token.
 */
async function fetchChannelDescription(
	env: Env,
	channelId: string,
): Promise<{ text: string; channelName: string } | { error: string }> {
	const response = await fetch(
		`https://slack.com/api/conversations.info?channel=${encodeURIComponent(toSlackChannelId(channelId))}`,
		{ headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
	);

	const body = (await response.json()) as SlackConversationInfo;
	if (!body.ok) return { error: body.error ?? "conversations.info failed" };

	const purpose = body.channel?.purpose?.value ?? "";
	const topic = body.channel?.topic?.value ?? "";
	return {
		text: [purpose, topic].filter(Boolean).join("\n"),
		channelName: body.channel?.name ?? channelId,
	};
}

/**
 * 1トークンからプロジェクト名を抜き出す。URL でも素の名前でもよい。
 * プロジェクト名らしくないトークン (日本語の自然文など) は undefined。
 */
export function extractProjectNameFromToken(token: string): string | undefined {
	let clean = token.trim();
	if (clean === "") return undefined;
	clean = clean.replace(/^[<("「『【\[]+/, "").replace(/[/\s]+$/, "");
	clean = clean.replace(/[>)"」』】\],.;:!?]+$/, "").trim();
	if (clean === "") return undefined;

	const urlMatch = clean.match(/scrapbox\.io\/([A-Za-z0-9_-]+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	if (/^[A-Za-z0-9_-]+$/.test(clean)) return clean;
	return undefined;
}

function dedupe(names: string[]): string[] {
	return [...new Set(names)];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `cosense:` 明示行の値を抜き出す。明示行が無ければ null、
 * あってもトークンが空なら [] を返す (呼び出し側で区別するため)。
 */
export function parseExplicitBindingValues(text: string): string[] | null {
	const matches = [
		...text.matchAll(/^.*cosense\s*[:：=]\s*(.+?)\s*$/gim),
	];
	if (matches.length === 0) return null;
	const joined = matches.map((m) => m[1] ?? "").join(",");
	const names = joined
		.split(/[,\s、]+/)
		.map((token) => extractProjectNameFromToken(token))
		.filter((name): name is string => name !== undefined);
	return dedupe(names);
}

/** レガシー (プレフィックス無し): URL と allowlist 完全一致の素名を拾う。 */
function parseLegacyBindingNames(text: string, allowed: string[]): string[] {
	const fromUrls = dedupe(
		[...text.matchAll(/scrapbox\.io\/([A-Za-z0-9_-]+)/g)]
			.map((m) => m[1])
			.filter((name): name is string => name !== undefined),
	);
	const names = [...fromUrls];
	for (const project of allowed) {
		if (names.includes(project)) continue;
		const pattern = new RegExp(
			`(^|[^A-Za-z0-9_-])${escapeRegExp(project)}([^A-Za-z0-9_-]|$)`,
		);
		if (pattern.test(text)) names.push(project);
	}
	return names;
}

export const BINDING_FORMAT_GUIDE =
	"チャンネルの description に `cosense: プロジェクト名` と書いてください (複数可、例: `cosense: niki-auth, niki-ai`)。プロジェクト名の代わりに URL (`https://scrapbox.io/niki-auth`) でも構いません";

/**
 * 純粋関数: description テキストから紐づけを判定する (fetch なし)。
 * テストから直接呼ぶことを想定している。
 */
export function parseBindingDescription(
	text: string,
	allowed: string[],
): ProjectResolution {
	const allowedSet = new Set(allowed);

	const explicit = parseExplicitBindingValues(text);
	if (explicit !== null) {
		const projects = explicit.filter((name) => allowedSet.has(name));
		const rejected = explicit.filter((name) => !allowedSet.has(name));
		if (projects.length === 0 && rejected.length === 0) {
			return {
				kind: "unset",
				reason: `cosense: の指定からプロジェクトを読み取れませんでした。${BINDING_FORMAT_GUIDE}`,
			};
		}
		if (projects.length === 0) {
			return { kind: "rejected", candidates: rejected };
		}
		return rejected.length > 0
			? { kind: "resolved", projects, rejected }
			: { kind: "resolved", projects };
	}

	const legacy = parseLegacyBindingNames(text, allowed);
	if (legacy.length === 0) {
		return {
			kind: "unset",
			reason: `description からプロジェクトを特定できませんでした。${BINDING_FORMAT_GUIDE}`,
		};
	}
	const projects = legacy.filter((name) => allowedSet.has(name));
	const rejected = legacy.filter((name) => !allowedSet.has(name));
	if (projects.length === 0) {
		return { kind: "rejected", candidates: rejected };
	}
	return rejected.length > 0
		? { kind: "resolved", projects, rejected }
		: { kind: "resolved", projects };
}

export async function resolveProjects(
	env: Env,
	channelId: string,
): Promise<ProjectResolution> {
	const cached = cache.get(channelId);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	const resolution = await resolveUncached(env, channelId);
	cache.set(channelId, { value: resolution, expiresAt: Date.now() + CACHE_TTL_MS });
	return resolution;
}

async function resolveUncached(
	env: Env,
	channelId: string,
): Promise<ProjectResolution> {
	const allowed = allowedProjects(env);

	const description = await fetchChannelDescription(env, channelId);
	if ("error" in description) {
		return { kind: "unset", reason: `Slack API error: ${description.error}` };
	}
	if (description.text.trim() === "") {
		return {
			kind: "unset",
			reason: `チャンネルの description が空です。${BINDING_FORMAT_GUIDE}`,
		};
	}

	// The allowlist check, not the description, is what decides. A
	// description that names some other project stops at "rejected" here.
	return parseBindingDescription(description.text, allowed);
}

/** テスト用にキャッシュをクリアする。 */
export function clearProjectBindingCache(): void {
	cache.clear();
}
