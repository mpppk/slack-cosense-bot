import { spawn } from "node:child_process";
import {
	EXPECTED_COSENSE_ORIGIN,
	getCosensePat,
	SUPPORTED_COSENSE_PROJECTS,
	validateCosenseOrigin,
	validateCosenseProject,
	type CosenseAuthEnvironment,
} from "./cosense-auth";

const CLI_VERSION = "1.14.1";
const VERIFIER_USAGE_EXIT_CODE = 2;
const VERIFIER_FAILURE_EXIT_CODE = 1;

export interface CosenseCliResult {
	code: number | null;
	spawnError: boolean;
}

export interface VerifierDependencies {
	runCli: (projectUrl: string, pat: string) => Promise<CosenseCliResult>;
}

async function runCosenseCli(
	projectUrl: string,
	pat: string,
): Promise<CosenseCliResult> {
	const childEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		COSENSE_PAT: pat,
	};

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
	runCli: runCosenseCli,
};

function reportFailure(message: string, exitCode: number): number {
	console.error(message);
	return exitCode;
}

/** Run a read-only Personal Access Token authentication check. */
export async function verifyCosenseAuth(
	projectUrl: string | undefined,
	pat: string | undefined,
	dependencyOverrides: Partial<VerifierDependencies> = {},
): Promise<number> {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };

	if (!projectUrl) {
		return reportFailure(
			"Usage: set COSENSE_PAT secret, then run bun run verify:cosense-auth -- <project URL>",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	let parsedProjectUrl: URL;
	try {
		parsedProjectUrl = new URL(projectUrl);
	} catch {
		return reportFailure("The project URL is invalid", VERIFIER_USAGE_EXIT_CODE);
	}

	// Validate the destination before starting the CLI. Paths are only used to
	// identify the project passed to the read-only command; credentials are
	// never written to a settings file.
	try {
		validateCosenseOrigin(parsedProjectUrl.origin);
	} catch {
		return reportFailure(
			`The project URL must use the HTTPS Cosense origin ${EXPECTED_COSENSE_ORIGIN}`,
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	if (
		parsedProjectUrl.username !== "" ||
		parsedProjectUrl.password !== "" ||
		parsedProjectUrl.search !== "" ||
		parsedProjectUrl.hash !== ""
	) {
		return reportFailure(
			"The project URL must not contain credentials, a query, or a fragment",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	const projectSegments = parsedProjectUrl.pathname.split("/").filter(Boolean);
	if (projectSegments.length !== 1) {
		return reportFailure(
			"The project URL must contain exactly one project name",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}
	const projectName = projectSegments[0];

	const authEnvironment: CosenseAuthEnvironment = {
		COSENSE_ORIGIN: parsedProjectUrl.origin,
		COSENSE_PROJECTS: SUPPORTED_COSENSE_PROJECTS.join(","),
		COSENSE_PAT: pat,
	};
	try {
		validateCosenseProject(authEnvironment, projectName);
	} catch (error) {
		return reportFailure(
			error instanceof Error ? error.message : "The Cosense PAT is invalid",
			VERIFIER_USAGE_EXIT_CODE,
		);
	}

	const result = await dependencies.runCli(projectUrl, getCosensePat(authEnvironment));
	if (result.spawnError) {
		return reportFailure("Could not start the Cosense CLI", VERIFIER_FAILURE_EXIT_CODE);
	}
	if (result.code !== 0) {
		return reportFailure(
			`Cosense read-only authentication check did not succeed (exit ${String(result.code)}); no authentication success was recorded.`,
			VERIFIER_FAILURE_EXIT_CODE,
		);
	}

	console.log(
		`Cosense PAT read-only authentication check passed for ${EXPECTED_COSENSE_ORIGIN}/${projectName}`,
	);
	return 0;
}
