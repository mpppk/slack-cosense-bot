/**
 * The cosense CLI's `COSENSE_PAT` environment variable is always treated as
 * a Personal Access Token. PATs are user-scoped, so one token can be used for
 * every allow-listed project that the token owner can access.
 */

export const COSENSE_HOME = "/root";
export const COSENSE_PAT_SECRET_NAME = "COSENSE_PAT" as const;
export const EXPECTED_COSENSE_ORIGIN = "https://scrapbox.io";
export const SUPPORTED_COSENSE_PROJECTS = [
	"niki-auth",
	"niki-ai",
	"niki-cs",
	"niki-tech",
] as const;

export type CosenseAuthEnvironment = {
	COSENSE_ORIGIN: string;
	COSENSE_PROJECTS: string;
	COSENSE_PAT?: string | undefined;
};

/**
 * Validate and normalize the only Cosense origin this bot is trusted to use.
 *
 * The origin is part of the credential-routing decision: accepting an
 * arbitrary host here would allow a typo or an attacker-controlled verifier
 * argument to receive the PAT. Keep the error independent of the credential
 * value so it is safe to surface to callers.
 */
export function validateCosenseOrigin(rawOrigin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawOrigin.trim());
	} catch {
		throw new Error(
			`COSENSE_ORIGIN must be the HTTPS Cosense origin ${EXPECTED_COSENSE_ORIGIN}`,
		);
	}

	if (
		parsed.protocol !== "https:" ||
		parsed.origin !== EXPECTED_COSENSE_ORIGIN ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new Error(
			`COSENSE_ORIGIN must be the HTTPS Cosense origin ${EXPECTED_COSENSE_ORIGIN}`,
		);
	}

	return EXPECTED_COSENSE_ORIGIN;
}

/**
 * Return the PAT without ever including its value in an error message.
 * PAT format is intentionally not validated here because its opaque format
 * belongs to Cosense and may change independently of this Worker.
 */
export function getCosensePat(
	env: Pick<CosenseAuthEnvironment, "COSENSE_PAT">,
): string {
	const value = env.COSENSE_PAT?.trim();
	if (!value) throw new Error(`Missing ${COSENSE_PAT_SECRET_NAME}`);
	return value;
}

/**
 * Validate the destination project and the PAT before starting the Sandbox.
 * The project allow-list remains necessary because a PAT can access every
 * project visible to its owner, not only the projects used by this bot.
 */
export function validateCosenseProject(
	env: CosenseAuthEnvironment,
	project: string,
): string {
	validateCosenseOrigin(env.COSENSE_ORIGIN);

	const projectName = project.trim();
	const projectNames = env.COSENSE_PROJECTS.split(",")
		.map((allowedProject) => allowedProject.trim())
		.filter((allowedProject) => allowedProject.length > 0);
	if (projectNames.length === 0) {
		throw new Error("COSENSE_PROJECTS must contain at least one project");
	}
	if (!projectNames.includes(projectName)) {
		throw new Error(`Cosense project "${projectName}" is not in COSENSE_PROJECTS`);
	}

	getCosensePat(env);
	return projectName;
}
