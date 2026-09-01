import { afterAll, expect, mock, test } from "bun:test";

const calls: Array<{
	kind: "mkdir" | "writeFile" | "exec" | "deleteFile";
	args: unknown[];
}> = [];

let execFailureAt: number | undefined;
let writeFailureAt: number | undefined;

const fakeSandbox = {
	mkdir: async (...args: unknown[]) => {
		calls.push({ kind: "mkdir", args });
		return { success: true };
	},
	writeFile: async (...args: unknown[]) => {
		calls.push({ kind: "writeFile", args });
		const writeCount = calls.filter(({ kind }) => kind === "writeFile").length;
		return { success: writeCount !== writeFailureAt };
	},
	exec: async (...args: unknown[]) => {
		calls.push({ kind: "exec", args });
		const execCount = calls.filter(({ kind }) => kind === "exec").length;
		const success = execCount !== execFailureAt;
		return {
			success,
			stdout: success ? "ok" : "",
			stderr: success ? "" : "permission denied",
			exitCode: success ? 0 : 1,
		};
	},
	deleteFile: async (...args: unknown[]) => {
		calls.push({ kind: "deleteFile", args });
		return { success: true };
	},
};

mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => fakeSandbox,
}));

const { runCosense } = await import("../src/sandbox");

afterAll(() => mock.restore());

test("runCosense configures Service Account auth without passing the key as env", async () => {
	calls.length = 0;
	execFailureAt = undefined;
	writeFailureAt = undefined;

  const result = await runCosense(
    {
      COSENSE_PAT: "cs_test_access_key",
      COSENSE_ORIGIN: "https://scrapbox.io",
      COSENSE_PROJECTS: "niki-auth",
    } as never,
    ["searchFullText", "https://scrapbox.io/niki-auth", "a user's query"],
    { timeoutMs: 2_000 },
  );

  expect(result).toEqual({
    ok: true,
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });
	expect(calls.map(({ kind }) => kind)).toEqual([
		"mkdir",
		"exec",
		"writeFile",
		"exec",
		"writeFile",
		"exec",
		"exec",
	]);

	const writeCalls = calls.filter(({ kind }) => kind === "writeFile");
	expect(writeCalls[0]?.args).toEqual(["/root/.cosense/settings.json", ""]);
	expect(writeCalls[1]?.args[0]).toBe("/root/.cosense/settings.json");
	expect(JSON.parse(String(writeCalls[1]?.args[1]))).toEqual({
    projects: [
      {
        url: "https://scrapbox.io/niki-auth",
        serviceAccount: "cs_test_access_key",
      },
    ],
  });

  const execCalls = calls.filter(({ kind }) => kind === "exec");
  expect(execCalls[0]?.args).toEqual(["chmod 700 /root/.cosense", { timeout: 10_000 }]);
  expect(execCalls[1]?.args).toEqual([
    "chmod 600 /root/.cosense/settings.json",
    { timeout: 10_000 },
  ]);
	expect(execCalls[2]?.args).toEqual([
		"chmod 600 /root/.cosense/settings.json",
		{ timeout: 10_000 },
	]);
	expect(execCalls[3]?.args).toEqual([
		"cosense 'searchFullText' 'https://scrapbox.io/niki-auth' 'a user'\\''s query'",
		{ timeout: 2_000, env: { HOME: "/root" } },
	]);
});

test("rejects an unexpected origin before sandbox credential setup", async () => {
	calls.length = 0;
	execFailureAt = undefined;
	writeFailureAt = undefined;

	await expect(
		runCosense(
			{
				COSENSE_PAT: "cs_test_access_key",
				COSENSE_ORIGIN: "https://evil.example",
				COSENSE_PROJECTS: "niki-auth",
			} as never,
			["searchFullText", "https://evil.example/niki-auth", "query"],
		),
	).rejects.toThrow("COSENSE_ORIGIN");

	expect(calls).toEqual([]);
});

test("cleans up when final settings-file permission verification fails", async () => {
	calls.length = 0;
	execFailureAt = 3;
	writeFailureAt = undefined;

	await expect(
		runCosense(
			{
				COSENSE_PAT: "cs_test_access_key",
				COSENSE_ORIGIN: "https://scrapbox.io",
				COSENSE_PROJECTS: "niki-auth",
			} as never,
			["searchFullText", "https://scrapbox.io/niki-auth", "query"],
		),
	).rejects.toThrow("Failed to configure Cosense Service Account settings");

	expect(calls.map(({ kind }) => kind)).toEqual([
		"mkdir",
		"exec",
		"writeFile",
		"exec",
		"writeFile",
		"exec",
		"deleteFile",
	]);
	expect(calls.at(-1)?.args).toEqual(["/root/.cosense/settings.json"]);
});

test("cleans up when writing the secret-bearing settings file fails", async () => {
	calls.length = 0;
	execFailureAt = undefined;
	writeFailureAt = 2;

	await expect(
		runCosense(
			{
				COSENSE_PAT: "cs_test_access_key",
				COSENSE_ORIGIN: "https://scrapbox.io",
				COSENSE_PROJECTS: "niki-auth",
			} as never,
			["searchFullText", "https://scrapbox.io/niki-auth", "query"],
		),
	).rejects.toThrow("Failed to configure Cosense Service Account settings");

	expect(calls.map(({ kind }) => kind)).toEqual([
		"mkdir",
		"exec",
		"writeFile",
		"exec",
		"writeFile",
		"deleteFile",
	]);
});
