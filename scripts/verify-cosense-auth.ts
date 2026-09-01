import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildCosenseSettings } from "../src/cosense-auth";

const CLI_VERSION = "1.14.1";

function fail(message: string, exitCode = 2): never {
  console.error(message);
  process.exit(exitCode);
}

const projectUrl = process.argv[2];
if (!projectUrl) {
  fail("Usage: COSENSE_PAT=<Service Account key> bun run verify:cosense-auth -- <project URL>");
}

const serviceAccount = process.env.COSENSE_PAT?.trim();
if (!serviceAccount) {
  fail(
    "COSENSE_PAT is not configured; provide the Service Account key through a secret manager or protected environment.",
  );
}
if (!serviceAccount.startsWith("cs_")) {
  fail("COSENSE_PAT is not a Service Account access key (expected cs_…)");
}

let parsedProjectUrl: URL;
try {
  parsedProjectUrl = new URL(projectUrl);
} catch {
  fail("The project URL is invalid");
}
const projectName = parsedProjectUrl.pathname.split("/").filter(Boolean)[0];
if (!projectName) {
  fail("The project URL must include a project name");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "cosense-auth-check-"));
const home = join(temporaryRoot, "home");
const settingsDir = join(home, ".cosense");
const settingsPath = join(settingsDir, "settings.json");

try {
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await chmod(settingsDir, 0o700);
  await writeFile(
    settingsPath,
    buildCosenseSettings({
      COSENSE_ORIGIN: parsedProjectUrl.origin,
      COSENSE_PROJECTS: projectName,
      COSENSE_PAT: serviceAccount,
    }),
    { mode: 0o600 },
  );
  await chmod(settingsPath, 0o600);

	const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // Force the same settings-file route used by runCosense. If this variable
  // survives, the CLI would intentionally bypass the Service Account entry.
  delete childEnvironment.COSENSE_PAT;

  const result = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    const child = spawn(
      "npx",
      ["--yes", `@helpfeel/cosense-cli@${CLI_VERSION}`, "readProjectMembers", projectUrl],
      {
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Consume both streams without forwarding page data or error bodies.
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", (error) => resolve({ code: null, spawnError: error }));
    child.once("close", (code) => resolve({ code }));
  });

  if (result.spawnError) {
    fail("Could not start the Cosense CLI", 1);
  }
	if (result.code !== 0) {
		fail(
			`Cosense read-only authentication check did not succeed (exit ${String(result.code)}); no authentication success was recorded.`,
			1,
		);
  }

  console.log(
    `Cosense Service Account read-only authentication check passed for ${parsedProjectUrl.origin}/${projectName}`,
  );
} finally {
  // The temporary settings file contains the credential and must not remain on
  // the host after the check.
  await rm(temporaryRoot, { recursive: true, force: true });
}
