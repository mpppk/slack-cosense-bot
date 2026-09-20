import { expect, test } from "bun:test";
import {
	ACK_RECEIPT_TEXT,
	FALLBACK_STREAM_PLACEHOLDER,
	resolveReceiptPost,
} from "../src/receipt";

test("rewrites the fallback-stream placeholder into the cold-start receipt", () => {
	expect(resolveReceiptPost(FALLBACK_STREAM_PLACEHOLDER)).toBe(
		ACK_RECEIPT_TEXT,
	);
});

test("leaves real content and structured posts untouched", () => {
	expect(resolveReceiptPost("hello")).toBe("hello");
	expect(resolveReceiptPost("...hello")).toBe("...hello");
	const structured = { markdown: "Sorry, I couldn't answer that right now." };
	expect(resolveReceiptPost(structured)).toBe(structured);
});

test("receipt sets a cold-start expectation for the user", () => {
	expect(ACK_RECEIPT_TEXT).toContain("10秒");
	expect(ACK_RECEIPT_TEXT).toContain("コンテナ");
});
