/**
 * The cosense CLI's environment variable is named COSENSE_PAT, but the CLI
 * always treats that variable as a Personal Access Token. Service Account
 * access keys must therefore be supplied through the project entry in
 * ~/.cosense/settings.json.
 */

export const COSENSE_HOME = "/root";
export const COSENSE_SETTINGS_DIR = `${COSENSE_HOME}/.cosense`;
export const COSENSE_SETTINGS_PATH = `${COSENSE_SETTINGS_DIR}/settings.json`;
export const EXPECTED_COSENSE_ORIGIN = "https://scrapbox.io";

export interface CosenseAuthEnvironment {
  COSENSE_ORIGIN: string;
  COSENSE_PROJECTS: string;
  COSENSE_PAT: string;
}

/**
 * Validate and normalize the only Cosense origin this bot is trusted to use.
 *
 * The origin is part of the credential-routing decision: accepting an
 * arbitrary host here would allow a typo or an attacker-controlled verifier
 * argument to receive the Service Account key. Keep the error independent of
 * all credential values so it is safe to surface to callers.
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
 * Build the settings file consumed by @helpfeel/cosense-cli.
 *
 * Keep this as a pure function so the credential route can be tested without
 * starting a Sandbox or ever printing the credential.
 */
export function buildCosenseSettings(env: CosenseAuthEnvironment): string {
  // Validate the destination before handling the credential value. The
  // resulting settings string must never be constructed for another origin.
  const origin = validateCosenseOrigin(env.COSENSE_ORIGIN);
  const serviceAccount = env.COSENSE_PAT.trim();
  if (!serviceAccount.startsWith("cs_")) {
    throw new Error("COSENSE_PAT must contain a Cosense Service Account access key (cs_…)");
  }

  const projectNames = [
    ...new Set(
      env.COSENSE_PROJECTS.split(",")
        .map((project) => project.trim())
        .filter((project) => project.length > 0),
    ),
  ];
  if (projectNames.length === 0) {
    throw new Error("COSENSE_PROJECTS must contain at least one project");
  }

  return `${JSON.stringify({
    projects: projectNames.map((project) => ({
      url: `${origin}/${project}`,
      serviceAccount,
    })),
  })}\n`;
}
