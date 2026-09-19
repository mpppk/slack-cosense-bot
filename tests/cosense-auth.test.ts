import { describe, expect, test } from "bun:test";
import {
	COSENSE_PAT_SECRET_NAME,
	getCosensePat,
	validateCosenseOrigin,
	validateCosenseProject,
} from "../src/cosense-auth";

const PAT = "pat_test_token";

function authEnvironment(overrides: Record<string, unknown> = {}) {
	return {
		COSENSE_ORIGIN: "https://scrapbox.io",
		COSENSE_PROJECTS: "niki-auth,niki-ai,niki-cs,niki-tech",
		COSENSE_PAT: PAT,
		...overrides,
	};
}

describe("Cosense PAT authentication", () => {
	test("returns the configured PAT without imposing a provider-specific format", () => {
		expect(getCosensePat({ COSENSE_PAT: PAT })).toBe(PAT);
		expect(getCosensePat({ COSENSE_PAT: " opaque-token " })).toBe("opaque-token");
	});

	test("rejects a missing PAT without exposing its value", () => {
		expect(() => getCosensePat({ COSENSE_PAT: "   " })).toThrow(
			`Missing ${COSENSE_PAT_SECRET_NAME}`,
		);
	});

	test.each(["niki-auth", "niki-ai", "niki-cs", "niki-tech"])(
		"accepts the configured project %s",
		(project) => {
			expect(validateCosenseProject(authEnvironment(), project)).toBe(project);
		},
	);

	test("rejects a project that is not in the allow-list", () => {
		expect(() =>
			validateCosenseProject(authEnvironment(), "other-project"),
		).toThrow("COSENSE_PROJECTS");
	});

	test("rejects an empty project allow-list", () => {
		expect(() =>
			validateCosenseProject(authEnvironment({ COSENSE_PROJECTS: " , " }), "niki-auth"),
		).toThrow("COSENSE_PROJECTS");
	});

	test("rejects a missing PAT before starting authentication", () => {
		expect(() =>
			validateCosenseProject(authEnvironment({ COSENSE_PAT: undefined }), "niki-auth"),
		).toThrow("COSENSE_PAT");
	});

	test.each([
		"http://scrapbox.io",
		"https://evil.example",
		"https://scrapbox.io/other",
	])("rejects an unexpected origin before accepting the PAT (%s)", (origin) => {
		expect(() =>
			validateCosenseProject(
				authEnvironment({ COSENSE_ORIGIN: origin }),
				"niki-auth",
			),
		).toThrow("COSENSE_ORIGIN");
	});

	test("normalizes the expected origin with one trailing slash", () => {
		expect(validateCosenseOrigin("https://scrapbox.io/")).toBe(
			"https://scrapbox.io",
		);
	});
});
