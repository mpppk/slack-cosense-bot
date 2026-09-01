import { describe, expect, test } from "bun:test";
import { buildCosenseSettings, validateCosenseOrigin } from "../src/cosense-auth";

describe("buildCosenseSettings", () => {
  test("writes project-scoped Service Account entries", () => {
    const settings = JSON.parse(
      buildCosenseSettings({
        COSENSE_ORIGIN: "https://scrapbox.io/",
        COSENSE_PROJECTS: " niki-auth, niki-ai, niki-auth ",
        COSENSE_PAT: "cs_test_access_key",
      }),
    );

    expect(settings).toEqual({
      projects: [
        {
          url: "https://scrapbox.io/niki-auth",
          serviceAccount: "cs_test_access_key",
        },
        {
          url: "https://scrapbox.io/niki-ai",
          serviceAccount: "cs_test_access_key",
        },
      ],
    });
  });

  test("rejects a PAT so the wrong header cannot be selected silently", () => {
    expect(() =>
      buildCosenseSettings({
        COSENSE_ORIGIN: "https://scrapbox.io",
        COSENSE_PROJECTS: "niki-auth",
        COSENSE_PAT: "pat_value",
      }),
    ).toThrow("Service Account access key");
  });

  test("rejects an empty project allow-list", () => {
    expect(() =>
      buildCosenseSettings({
        COSENSE_ORIGIN: "https://scrapbox.io",
        COSENSE_PROJECTS: " , ",
        COSENSE_PAT: "cs_test_access_key",
      }),
    ).toThrow("COSENSE_PROJECTS");
  });

  test.each(["http://scrapbox.io", "https://evil.example", "https://scrapbox.io/other"])(
    "rejects an unexpected origin before constructing credential settings (%s)",
    (origin) => {
      expect(() =>
        buildCosenseSettings({
          COSENSE_ORIGIN: origin,
          COSENSE_PROJECTS: "niki-auth",
          COSENSE_PAT: "cs_test_access_key",
        }),
      ).toThrow("COSENSE_ORIGIN");
    },
  );

  test("normalizes the expected origin with one trailing slash", () => {
    expect(validateCosenseOrigin("https://scrapbox.io/")).toBe("https://scrapbox.io");
  });
});
