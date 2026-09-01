import { getSandbox } from "@cloudflare/sandbox";
import {
	buildCosenseSettings,
	COSENSE_HOME,
	COSENSE_SETTINGS_DIR,
	COSENSE_SETTINGS_PATH,
} from "./cosense-auth";

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
 * Store the Service Account key in the format expected by the CLI.
 *
 * `COSENSE_PAT` cannot be passed to the child process: cosense classifies that
 * variable as a Personal Access Token and sends the wrong authentication
 * header for a `cs_…` Service Account key.
 */
async function configureCosenseServiceAccount(
	sandbox: ReturnType<typeof getSandbox>,
	env: Env,
): Promise<void> {
	const settings = buildCosenseSettings(env);
	let settingsFileMayContainSecret = false;

	try {
		const directoryResult = await sandbox.mkdir(COSENSE_SETTINGS_DIR, { recursive: true });
		if (!directoryResult.success) {
			throw new Error("settings directory creation failed");
		}

		const directoryPermissionResult = await sandbox.exec(
			`chmod 700 ${COSENSE_SETTINGS_DIR}`,
			{ timeout: 10_000 },
		);
		if (!directoryPermissionResult.success) {
			throw new Error("settings directory permission setup failed");
		}

		// The top-level SDK writeFile API has no permissions option. Create the
		// constant file path while it is empty, then secure it before any
		// credential bytes are written. If any step below fails, remove this file
		// so a partial write cannot leave the Service Account key behind.
		settingsFileMayContainSecret = true;
		const precreateResult = await sandbox.writeFile(COSENSE_SETTINGS_PATH, "");
		if (!precreateResult.success) {
			throw new Error("settings file creation failed");
		}

		const initialFilePermissionResult = await sandbox.exec(
			`chmod 600 ${COSENSE_SETTINGS_PATH}`,
			{ timeout: 10_000 },
		);
		if (!initialFilePermissionResult.success) {
			throw new Error("settings file permission setup failed");
		}

		const writeResult = await sandbox.writeFile(COSENSE_SETTINGS_PATH, settings);
		if (!writeResult.success) {
			throw new Error("settings file write failed");
		}

		// Some file APIs replace the destination rather than writing in place.
		// Re-apply 0600 after the secret write and treat a failed chmod as a
		// failed authentication setup; this is the final mode verification.
		const finalFilePermissionResult = await sandbox.exec(
			`chmod 600 ${COSENSE_SETTINGS_PATH}`,
			{ timeout: 10_000 },
		);
		if (!finalFilePermissionResult.success) {
			throw new Error("final settings file permission verification failed");
		}
	} catch {
		if (settingsFileMayContainSecret) {
			let cleanupSucceeded = false;
			try {
				cleanupSucceeded = (await sandbox.deleteFile(COSENSE_SETTINGS_PATH)).success;
			} catch {
				// Preserve a generic failure below; neither SDK errors nor paths should
				// be allowed to expose the settings contents.
			}
			if (!cleanupSucceeded) {
				throw new Error(
					"Failed to configure Cosense Service Account settings and clean up the settings file",
				);
			}
		}
		throw new Error("Failed to configure Cosense Service Account settings");
	}
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

	await configureCosenseServiceAccount(sandbox, env);
	const result = await sandbox.exec(command, {
		timeout: options.timeoutMs ?? 60_000,
		// Keep HOME aligned with the path written above. In particular, do not set
		// COSENSE_PAT here: the CLI would classify the Service Account key as a PAT.
		env: { HOME: COSENSE_HOME },
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
