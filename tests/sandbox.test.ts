import { afterAll, expect, mock, test } from "bun:test";

const calls: Array<{
  kind: "mkdir" | "writeFile" | "exec";
  args: unknown[];
}> = [];

const fakeSandbox = {
  mkdir: async (...args: unknown[]) => {
    calls.push({ kind: "mkdir", args });
  },
  writeFile: async (...args: unknown[]) => {
    calls.push({ kind: "writeFile", args });
    return { success: true };
  },
  exec: async (...args: unknown[]) => {
    calls.push({ kind: "exec", args });
    return { success: true, stdout: "ok", stderr: "", exitCode: 0 };
  },
};

mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => fakeSandbox,
}));

const { runCosense } = await import("../src/sandbox");

afterAll(() => mock.restore());

test("runCosense configures Service Account auth without passing the key as env", async () => {
  calls.length = 0;

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
  expect(calls.map(({ kind }) => kind)).toEqual(["mkdir", "exec", "writeFile", "exec", "exec"]);

  const writeCall = calls.find(({ kind }) => kind === "writeFile");
  expect(writeCall?.args[0]).toBe("/root/.cosense/settings.json");
  expect(JSON.parse(String(writeCall?.args[1]))).toEqual({
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
    "cosense 'searchFullText' 'https://scrapbox.io/niki-auth' 'a user'\\''s query'",
    { timeout: 2_000, env: { HOME: "/root" } },
  ]);
});
