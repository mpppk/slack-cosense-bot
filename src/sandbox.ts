import { getSandbox } from "@cloudflare/sandbox";

/**
 * 決定事項: Sandbox コンテナは全体で1本共有する。
 *
 * A fixed id means every thread and every project reuses the same container, so
 * the cosense CLI install (baked into the image) and any warm filesystem state
 * are paid for once. wrangler.jsonc pins max_instances to 1 to match.
 */
const SHARED_SANDBOX_ID = "cosense-cli";

/**
 * Quote a single argument for /bin/sh.
 *
 * The stable @cloudflare/sandbox exec() takes a command *string*, so every
 * value that reaches it — page titles, search queries, anything a Slack user
 * typed — has to be quoted here. Single quotes disable all shell expansion; the
 * only character needing care is the single quote itself.
 */
export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export interface CosenseResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run the cosense CLI in the shared container.
 *
 * `args` are passed as separate values and quoted individually — never
 * interpolate user input into the command string at the call site.
 */
export async function runCosense(
	env: Env,
	args: string[],
	options: { timeoutMs?: number } = {},
): Promise<CosenseResult> {
	const sandbox = getSandbox(env.Sandbox, SHARED_SANDBOX_ID);
	const command = ["cosense", ...args.map(shellQuote)].join(" ");

	const result = await sandbox.exec(command, {
		timeout: options.timeoutMs ?? 60_000,
		// The CLI prefers COSENSE_PAT over ~/.cosense/settings.json, which is the
		// only credential path that works unattended — `cosense login` is
		// TTY-only. See README "Cosense の認証" for the Service Account caveat.
		env: { COSENSE_PAT: env.COSENSE_PAT },
	});

	return {
		ok: result.success,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}

/** Cap tool output so one big page cannot blow up the context window. */
export function truncate(text: string, maxChars = 12_000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n…(truncated: ${text.length - maxChars} more characters)`;
}
