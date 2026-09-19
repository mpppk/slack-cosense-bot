import { afterAll, expect, mock, test } from "bun:test";

const calls: Array<{
	kind: "exec";
	args: unknown[];
}> = [];

const fakeSandbox = {
	exec: async (...args: unknown[]) => {
		calls.push({ kind: "exec", args });
		return {
			success: true,
			stdout: "ok",
			stderr: "",
			exitCode: 0,
		};
	},
};

mock.module("@cloudflare/sandbox", () => ({
	getSandbox: () => fakeSandbox,
}));

const { runCosense } = await import("../src/sandbox");

afterAll(() => mock.restore());

const authEnvironment = {
	COSENSE_ORIGIN: "https://scrapbox.io",
	COSENSE_PROJECTS: "niki-auth,niki-ai,niki-cs,niki-tech",
	COSENSE_PAT: "pat_test_token",
};

test("runCosense passes the PAT only through the child environment", async () => {
	calls.length = 0;

	const result = await runCosense(
		authEnvironment as never,
		"niki-auth",
		["searchFullText", "https://scrapbox.io/niki-auth", "a user's query"],
		{ timeoutMs: 2_000 },
	);

	expect(result).toEqual({
		ok: true,
		stdout: "ok",
		stderr: "",
		exitCode: 0,
	});

	expect(calls).toHaveLength(1);
	const [command, options] = calls[0]?.args ?? [];
	expect(command).toBe(
		"cosense 'searchFullText' 'https://scrapbox.io/niki-auth' 'a user'\\''s query'",
	);
	expect(String(command)).not.toContain(authEnvironment.COSENSE_PAT);
	expect(options).toEqual({
		timeout: 2_000,
		env: {
		HOME: "/root",
		COSENSE_PAT: authEnvironment.COSENSE_PAT,
		},
	});
});

test("rejects an unexpected origin before sandbox execution", async () => {
	calls.length = 0;

	await expect(
		runCosense(
			{ ...authEnvironment, COSENSE_ORIGIN: "https://evil.example" } as never,
			"niki-auth",
			["searchFullText", "https://evil.example/niki-auth", "query"],
		),
	).rejects.toThrow("COSENSE_ORIGIN");

	expect(calls).toEqual([]);
});

test("rejects a missing PAT before sandbox execution", async () => {
	calls.length = 0;

	await expect(
		runCosense(
			{ ...authEnvironment, COSENSE_PAT: undefined } as never,
			"niki-auth",
			["searchFullText", "https://scrapbox.io/niki-auth", "query"],
		),
	).rejects.toThrow("COSENSE_PAT");

	expect(calls).toEqual([]);
});
