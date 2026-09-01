import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	buildCosenseSettings,
	EXPECTED_COSENSE_ORIGIN,
	validateCosenseOrigin,
} from "./cosense-auth";

const CLI_VERSION = "1.14.1";
const VERIFIER_USAGE_EXIT_CODE = 2;
const VERIFIER_FAILURE_EXIT_CODE = 1;

export interface CosenseCliResult {
	code: number | null;
	spawnError: boolean;
}

export interface VerifierDependencies {
	mkdtemp: (prefix: string) => Promise<unknown>;
	mkdir: (
		path: string,
		options?: { recursive?: boolean; mode?: number },
	) => Promise<unknown>;
	chmod: (path: string, mode: number) => Promise<unknown>;
	writeFile: (
		path: string,
		content: string,
		options?: { mode?: number },
	) => Promise<unknown>;
	rm: (
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	) => Promise<unknown>;
	runCli: (projectUrl: string, home: string) => Promise<CosenseCliResult>;
}

async function runCosenseCli(projectUrl: string, home: string): Promise<CosenseCliResult> {
	const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	// Force the same settings-file route used by runCosense. If this variable
	// survives, the CLI would intentionally bypass the Service Account entry.
	delete childEnvironment.COSENSE_PAT;

	return new Promise((resolve) => {
		let settled = false;
		const settle = (result: CosenseCliResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn(
			"npx",
			["--yes", `@helpfeel/cosense-cli@${CLI_VERSION}`, "readProjectMembers", projectUrl],
			{
				env: childEnvironment,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		// Consume both streams without forwarding page data or error bodies.
		child.stdout?.resume();
		child.stderr?.resume();
		child.once("error", () => settle({ code: null, spawnError: true }));
		child.once("close", (code) => settle({ code, spawnError: false }));
	});
}

const defaultDependencies: VerifierDependencies = {
	mkdtemp,
	mkdir,
	chmod,
	writeFile,
	rm,
	runCli: runCosenseCli,
};

function reportFailure(message: string, exitCode: number): number {
	console.error(message);
	return exitCode;
}

/**
 * Run a read-only Service Account authentication check.
 *
 * The function returns an exit code instead of terminating the process. This
 * is important after the temporary HOME exists: callers must unwind through
 * the `finally` block so the settings file containing the credential is
 * always removed.
 */
export async function verifyCosenseAuth(
	projectUrl: string | undefined,
	serviceAccountValue: string | undefined,
	dependencyOverrides: Partial<VerifierDependencies> = {},
): Promise<number> {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };

	if (!projectUrl) {
		return reportFailure(
			"Usage: COSENSE_PAT=<Service Account key> bun run verify:cosense-auth -- <project URL>",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	let parsedProjectUrl: URL;
	try {
		parsedProjectUrl = new URL(projectUrl);
	} catch {
		return reportFailure("The project URL is invalid", VERIFIER_USAGE_EXIT_CODE);
	}

	// Validate the destination before reading or materializing the credential.
	// `origin` is all that belongs in settings; paths are only used to identify
	// the project passed to the read-only CLI command.
	try {
		validateCosenseOrigin(parsedProjectUrl.origin);
	} catch {
		return reportFailure(
			`The project URL must use the HTTPS Cosense origin ${EXPECTED_COSENSE_ORIGIN}`,
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	const projectName = parsedProjectUrl.pathname.split("/").filter(Boolean)[0];
	if (!projectName) {
		return reportFailure(
			"The project URL must include a project name",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	const serviceAccount = serviceAccountValue?.trim();
	if (!serviceAccount) {
		return reportFailure(
			"COSENSE_PAT is not configured; provide the Service Account key through a secret manager or protected environment.",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}
	if (!serviceAccount.startsWith("cs_")) {
		return reportFailure(
			"COSENSE_PAT is not a Service Account access key (expected cs_…)",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	let temporaryRoot: string;
	try {
		temporaryRoot = String(
			await dependencies.mkdtemp(join(tmpdir(), "cosense-auth-check-")),
		);
	} catch {
		return reportFailure("Could not create a temporary authentication workspace", VERIFIER_FAILURE_EXIT_CODE);
	}

	const home = join(temporaryRoot, "home");
	const settingsDir = join(home, ".cosense");
	const settingsPath = join(settingsDir, "settings.json");
	let exitCode = VERIFIER_FAILURE_EXIT_CODE;
	let cleanupFailed = false;

	try {
		await dependencies.mkdir(settingsDir, { recursive: true, mode: 0o700 });
		await dependencies.chmod(settingsDir, 0o700);

		const settings = buildCosenseSettings({
			COSENSE_ORIGIN: parsedProjectUrl.origin,
			COSENSE_PROJECTS: projectName,
			COSENSE_PAT: serviceAccount,
		});

		// Create and secure the file while empty, then write the credential and
		// verify its final mode. The temporary tree is removed in `finally` for
		// every failure path, including CLI and permission failures.
		await dependencies.writeFile(settingsPath, "", { mode: 0o600 });
		await dependencies.chmod(settingsPath, 0o600);
		await dependencies.writeFile(settingsPath, settings);
		await dependencies.chmod(settingsPath, 0o600);

		const result = await dependencies.runCli(projectUrl, home);
		if (result.spawnError) {
			console.error("Could not start the Cosense CLI");
		} else if (result.code !== 0) {
			console.error(
				`Cosense read-only authentication check did not succeed (exit ${String(result.code)}); no authentication success was recorded.`,
			);
		} else {
			console.log(
				`Cosense Service Account read-only authentication check passed for ${EXPECTED_COSENSE_ORIGIN}/${projectName}`,
			);
			exitCode = 0;
		}
	} catch {
		console.error("Cosense read-only authentication check could not be completed safely");
	} finally {
		// The temporary settings file contains the credential and must not remain
		// on the host after the check, regardless of the result above.
		try {
			await dependencies.rm(temporaryRoot, { recursive: true, force: true });
		} catch {
			cleanupFailed = true;
		}
	}

	if (cleanupFailed) {
		console.error("Could not remove the temporary authentication workspace safely");
		return VERIFIER_FAILURE_EXIT_CODE;
	}

	return exitCode;
}
