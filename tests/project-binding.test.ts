import { describe, expect, test } from "bun:test";
import { toSlackChannelId } from "../src/project-binding";

describe("toSlackChannelId", () => {
	test("strips the Chat SDK provider prefix", () => {
		expect(toSlackChannelId("slack:C8P1104Q4")).toBe("C8P1104Q4");
	});

	test("leaves a raw Slack channel id untouched", () => {
		expect(toSlackChannelId("C8P1104Q4")).toBe("C8P1104Q4");
	});
});
