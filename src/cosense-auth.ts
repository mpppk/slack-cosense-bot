/**
 * The cosense CLI's environment variable is named COSENSE_PAT, but the CLI
 * always treats that variable as a Personal Access Token. Service Account
 * access keys must therefore be supplied through the project entry in
 * ~/.cosense/settings.json.
 */

export const COSENSE_HOME = "/root";
export const COSENSE_SETTINGS_DIR = `${COSENSE_HOME}/.cosense`;
export const COSENSE_SETTINGS_PATH = `${COSENSE_SETTINGS_DIR}/settings.json`;

export interface CosenseAuthEnvironment {
  COSENSE_ORIGIN: string;
  COSENSE_PROJECTS: string;
  COSENSE_PAT: string;
}

/**
 * Build the settings file consumed by @helpfeel/cosense-cli.
 *
 * Keep this as a pure function so the credential route can be tested without
 * starting a Sandbox or ever printing the credential.
 */
export function buildCosenseSettings(env: CosenseAuthEnvironment): string {
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

  const origin = env.COSENSE_ORIGIN.replace(/\/+$/, "");
  return `${JSON.stringify({
    projects: projectNames.map((project) => ({
      url: `${origin}/${project}`,
      serviceAccount,
    })),
  })}\n`;
}
