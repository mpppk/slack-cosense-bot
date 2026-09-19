import { getSandbox } from "@cloudflare/sandbox";
import {
	COSENSE_HOME,
	getCosensePat,
	validateCosenseProject,
} from "./cosense-auth";

/** The shared container keeps the cosense CLI install warm across requests. */
const SHARED_SANDBOX_ID = "cosense-cli";

/**
 * Quote a single argument for /bin/sh.
 *
 * The stable @cloudflare/sandbox exec() takes a command *string*, so every
 * value that reaches it — page titles, search queries, anything a Slack user
 * typed — has to be quoted here. Single quotes disable all shell expansion;
 * the only character needing care is the single quote itself.
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
 * PAT is passed through the child process environment, never interpolated
 * into the shell command and never persisted in the container filesystem.
 * `COSENSE_PROJECTS` is still checked before execution because a PAT can
 * reach every project visible to its owner.
 */
export async function runCosense(
	env: Env,
	project: string,
	args: string[],
	options: { timeoutMs?: number } = {},
): Promise<CosenseResult> {
	validateCosenseProject(env, project);
	const pat = getCosensePat(env);
	const command = ["cosense", ...args.map(shellQuote)].join(" ");
	const sandbox = getSandbox(env.Sandbox, SHARED_SANDBOX_ID);
	const result = await sandbox.exec(command, {
		timeout: options.timeoutMs ?? 60_000,
		env: {
			HOME: COSENSE_HOME,
			COSENSE_PAT: pat,
		},
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
