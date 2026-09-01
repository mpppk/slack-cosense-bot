import { expect, test } from "bun:test";
import { verifyCosenseAuth, type VerifierDependencies } from "../src/cosense-auth-verifier";

const PROJECT_URL = "https://scrapbox.io/niki-auth";
const SERVICE_ACCOUNT = "cs_test_access_key";
const TEMPORARY_ROOT = "/tmp/cosense-auth-check-test";

function dependenciesFor(
	overrides: Partial<VerifierDependencies> = {},
): VerifierDependencies {
	return {
		mkdtemp: async () => TEMPORARY_ROOT,
		mkdir: async () => undefined,
		chmod: async () => undefined,
		writeFile: async () => undefined,
		rm: async () => undefined,
		runCli: async () => ({ code: 0, spawnError: false }),
		...overrides,
	};
}

test("rejects an unexpected verifier origin before creating a temporary workspace", async () => {
	let temporaryWorkspaceCreated = false;

	const exitCode = await verifyCosenseAuth(
		"http://scrapbox.io/niki-auth",
		SERVICE_ACCOUNT,
		dependenciesFor({
			mkdtemp: async () => {
				temporaryWorkspaceCreated = true;
				return TEMPORARY_ROOT;
			},
		}),
	);

	expect(exitCode).toBe(2);
	expect(temporaryWorkspaceCreated).toBe(false);
});

test("removes the temporary tree after a CLI authentication failure", async () => {
	const calls: string[] = [];
	const writtenContents: string[] = [];

	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		SERVICE_ACCOUNT,
		dependenciesFor({
			mkdtemp: async () => {
				calls.push("mkdtemp");
				return TEMPORARY_ROOT;
			},
			mkdir: async () => {
				calls.push("mkdir");
			},
			chmod: async () => {
				calls.push("chmod");
			},
			writeFile: async (_path, content) => {
				calls.push("writeFile");
				writtenContents.push(content);
			},
			runCli: async () => {
				calls.push("runCli");
				return { code: 1, spawnError: false };
			},
			rm: async () => {
				calls.push("rm");
			},
		}),
	);

	expect(exitCode).toBe(1);
	expect(calls).toEqual([
		"mkdtemp",
		"mkdir",
		"chmod",
		"writeFile",
		"chmod",
		"writeFile",
		"chmod",
		"runCli",
		"rm",
	]);
	expect(writtenContents[0]).toBe("");
	expect(writtenContents[1]).toContain(SERVICE_ACCOUNT);
});

test("removes the temporary tree after a settings permission failure", async () => {
	const calls: string[] = [];

	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		SERVICE_ACCOUNT,
		dependenciesFor({
			writeFile: async () => {
				calls.push("writeFile");
			},
			chmod: async () => {
				calls.push("chmod");
				if (calls.filter((call) => call === "chmod").length === 2) {
					throw new Error("permission denied");
				}
			},
			rm: async () => {
				calls.push("rm");
			},
		}),
	);

	expect(exitCode).toBe(1);
	expect(calls).toEqual(["chmod", "writeFile", "chmod", "rm"]);
});

test("returns failure when temporary-tree cleanup itself fails", async () => {
		const exitCode = await verifyCosenseAuth(
			PROJECT_URL,
			SERVICE_ACCOUNT,
			dependenciesFor({
				rm: async () => {
					throw new Error("cleanup denied");
				},
			}),
		);

		expect(exitCode).toBe(1);
});
