/**
 * Failure classification for user-facing error messages (Issue #10).
 *
 * 決定事項: エラーは対象スレッドに返す。内部例外のスタックやシークレットを
 * そのまま出さない。Sandbox 起動 / OpenRouter / Slack API の3系統を切り分け
 * られる文言にし、原因系統ごとの定型文だけをスレッドに出す。
 *
 * Raw error detail (message, stack, stderr) is only ever written to
 * server-side logs, and only after sanitizeText() redaction. Thread-facing
 * strings come exclusively from threadErrorMessage(), which contains no
 * interpolated error content at all.
 */

export type ErrorKind = "sandbox" | "openrouter" | "slack" | "unknown";

/** Slack Web API snake_case error codes observed on conversations.info etc. */
const SLACK_API_CODES =
	/conversations\.info|chat\.postmessage|conversations\.replies|webclient|slack_webapi|channel_not_found|not_in_channel|is_archived|message_not_found|thread_not_found|ratelimited|rate_limited|invalid_auth|token_revoked|account_inactive|missing_scope|not_authed|no_permission|restricted_action|invalid_blocks|msg_too_long/i;

/** Bare "slack" mention (adapter, token prefix, bot token env name). */
const SLACK_MENTION = /slack|xox[bpas]-|SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET/i;

const SANDBOX_SIGNALS =
	/sandbox|cosense|getSandbox|COSENSE_PAT|COSENSE_ORIGIN|COSENSE_PROJECTS|container|instance_type|max_instances/i;

const OPENROUTER_SIGNALS =
	/openrouter|OPENROUTER_API_KEY|OPENROUTER_MODEL|ai[\s-]?sdk|generateText|streamText|doGenerate|NoSuchModel|model_not_found|insufficient.*quota|credits|gateway/i;

function errorText(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

function errorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	for (const key of ["status", "statusCode", "code"] as const) {
		const value = (error as Record<string, unknown>)[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && /^\d{3}$/.test(value)) {
			return Number(value);
		}
	}
	return undefined;
}

/**
 * Map an arbitrary thrown value to one of the three failure systems from
 * Issue #10, or "unknown" when nothing identifies the origin.
 *
 * Order matters: provider-specific API codes win over generic words, and a
 * bare HTTP status alone never classifies (a lone 429 could be any Hop).
 */
export function classifyError(error: unknown): ErrorKind {
	const text = errorText(error);
	if (SLACK_API_CODES.test(text)) return "slack";
	if (OPENROUTER_SIGNALS.test(text)) return "openrouter";
	if (SANDBOX_SIGNALS.test(text)) return "sandbox";
	if (SLACK_MENTION.test(text)) return "slack";

	// 402 Payment Required is OpenRouter-specific in this stack (credit
	// exhaustion); other bare statuses stay "unknown" to avoid mis-triage.
	if (errorStatus(error) === 402) return "openrouter";

	return "unknown";
}

/**
 * Thread-facing定型文. Each message names its failure system so the three
 * kinds are distinguishable in the thread, and none interpolates raw error
 * content — safe to post to Slack as-is.
 */
export function threadErrorMessage(kind: ErrorKind): string {
	switch (kind) {
		case "sandbox":
			return (
				"Cosense の読み込み処理（Sandbox 系）で障害が発生しました。" +
				"しばらく待ってからもう一度お試しください。直らない場合は管理者に連絡してください。"
			);
		case "openrouter":
			return (
				"回答の生成処理（OpenRouter 系）で障害が発生しました。" +
				"しばらく待ってからもう一度お試しください。直らない場合は管理者に連絡してください。"
			);
		case "slack":
			return (
				"Slack への送信処理（Slack API 系）で障害が発生しました。" +
				"スレッドの表示を更新して確認してください。直らない場合は管理者に連絡してください。"
			);
		case "unknown":
			return (
				"一時的な障害が発生しました。" +
				"しばらく待ってからもう一度お試しください。直らない場合は管理者に連絡してください。"
			);
	}
}

const SECRET_PATTERNS: RegExp[] = [
	// Slack tokens: xoxb-..., xoxp-..., xoxa-..., xoxs-...
	/\bxox[bpas]-[A-Za-z0-9-]+\b/g,
	// Authorization headers that may echo a token.
	/\bBearer\s+[A-Za-z0-9\-._~+/=]+\b/g,
	// OpenAI-style / generic API keys.
	/\bsk-[A-Za-z0-9-]{8,}\b/g,
	// env-style assignments that would echo a secret value.
	/\b[A-Z_]*(?:PAT|TOKEN|SECRET|API_KEY)\b\s*[:=]\s*['"]?[^\s'"]+/g,
];

const PATH_PATTERNS: RegExp[] = [
	// Absolute container/host paths, never Cosense page URLs or slugs.
	/\/(?:root|home|var|tmp|etc|usr|opt|workspace|app)\/[^\s"'`]*/g,
	// Windows-style absolute paths.
	/\b[A-Za-z]:\\[^\s"'`]*/g,
	// workerd / wrangler internal locations.
	/\bworkerd[^:\s]*:[^\s]*/gi,
];

/**
 * Redact secrets, internal paths, and stack-trace lines from arbitrary text
 * before it reaches a thread message or a server log line.
 *
 * Cosense page URLs (https://scrapbox.io/...) and ordinary tool output are
 * preserved — only the patterns above are replaced.
 */
export function sanitizeText(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	for (const pattern of PATH_PATTERNS) {
		out = out.replace(pattern, "[PATH]");
	}
	// V8/JSC stack frames ("    at fn (/path/file.js:1:2)"). The raw stack
	// never helps a Slack user and routinely contains internal paths.
	out = out
		.split("\n")
		.filter((line) => !/^\s*at\s+\S/.test(line))
		.join("\n");
	return out;
}

/**
 * Marker thrown after a classified thread message has already been posted.
 * Think's delivery policy recognizes it via isClassifiedTurnError() and
 * suppresses the generic errorResponseText so the thread gets exactly one
 * classified message, never a duplicate generic one.
 */
export class ClassifiedTurnError extends Error {
	readonly kind: ErrorKind;
	readonly threadMessage: string;

	constructor(kind: ErrorKind, threadMessage: string, cause: unknown) {
		super(`classified turn failure (${kind})`, { cause });
		this.name = "ClassifiedTurnError";
		this.kind = kind;
		this.threadMessage = threadMessage;
	}
}

export function isClassifiedTurnError(error: unknown): boolean {
	if (error instanceof ClassifiedTurnError) return true;
	// deliverMessengerReply may wrap or re-read the thrown value; also accept
	// the marker shape structurally so suppression never silently breaks.
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; kind?: unknown };
	return (
		candidate.name === "ClassifiedTurnError" &&
		(candidate.kind === "sandbox" ||
			candidate.kind === "openrouter" ||
			candidate.kind === "slack" ||
			candidate.kind === "unknown")
	);
}
