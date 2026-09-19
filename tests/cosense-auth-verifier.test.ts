import { expect, test } from "bun:test";
import {
	verifyCosenseAuth,
	type VerifierDependencies,
} from "../src/cosense-auth-verifier";

const PROJECT_URL = "https://scrapbox.io/niki-auth";
const PAT = "pat_test_token";

function dependenciesFor(
	overrides: Partial<VerifierDependencies> = {},
): VerifierDependencies {
	return {
		runCli: async () => ({ code: 0, spawnError: false }),
		...overrides,
	};
}

test("rejects an unexpected verifier origin before starting the CLI", async () => {
	let cliStarted = false;

	const exitCode = await verifyCosenseAuth(
		"http://scrapbox.io/niki-auth",
		PAT,
		dependenciesFor({
			runCli: async () => {
				cliStarted = true;
				return { code: 0, spawnError: false };
			},
		}),
	);

	expect(exitCode).toBe(2);
	expect(cliStarted).toBe(false);
});

test("rejects a missing PAT before starting the CLI", async () => {
	let cliStarted = false;

	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		undefined,
		dependenciesFor({
			runCli: async () => {
				cliStarted = true;
				return { code: 0, spawnError: false };
			},
		}),
	);

	expect(exitCode).toBe(2);
	expect(cliStarted).toBe(false);
});

test("passes the PAT to the read-only CLI without writing a settings file", async () => {
	let received: { projectUrl: string; pat: string } | undefined;

	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		PAT,
		dependenciesFor({
			runCli: async (projectUrl, pat) => {
				received = { projectUrl, pat };
				return { code: 0, spawnError: false };
			},
		}),
	);

	expect(exitCode).toBe(0);
	expect(received).toEqual({ projectUrl: PROJECT_URL, pat: PAT });
});

test("returns failure when the read-only CLI exits unsuccessfully", async () => {
	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		PAT,
		dependenciesFor({
			runCli: async () => ({ code: 1, spawnError: false }),
		}),
	);

	expect(exitCode).toBe(1);
});

test("returns failure when the CLI cannot be spawned", async () => {
	const exitCode = await verifyCosenseAuth(
		PROJECT_URL,
		PAT,
		dependenciesFor({
			runCli: async () => ({ code: null, spawnError: true }),
		}),
	);

	expect(exitCode).toBe(1);
});

test("rejects an unknown project without starting the CLI", async () => {
	let cliStarted = false;

	const exitCode = await verifyCosenseAuth(
		"https://scrapbox.io/unknown-project",
		PAT,
		dependenciesFor({
			runCli: async () => {
				cliStarted = true;
				return { code: 0, spawnError: false };
			},
		}),
	);

	expect(exitCode).toBe(2);
	expect(cliStarted).toBe(false);
});

test.each(["niki-auth", "niki-ai", "niki-cs", "niki-tech"])(
	"verifies the PAT for the configured project %s",
	async (project) => {
		let receivedProjectUrl = "";
		const exitCode = await verifyCosenseAuth(
			`https://scrapbox.io/${project}`,
			PAT,
			dependenciesFor({
				runCli: async (projectUrl) => {
					receivedProjectUrl = projectUrl;
					return { code: 0, spawnError: false };
				},
			}),
		);

		expect(exitCode).toBe(0);
		expect(receivedProjectUrl).toBe(`https://scrapbox.io/${project}`);
	},
);
