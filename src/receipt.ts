import type { AdapterPostableMessage } from "chat";

/**
 * The Chat SDK fallback streamer (`Thread.fallbackStream` in `chat`) opens a
 * streamed answer with this placeholder post, then rewrites it with edits as
 * model chunks arrive. Think never overrides `fallbackStreamingPlaceholderText`,
 * so a bare "..." post from the Slack adapter is the streaming receipt's first
 * paint on channel-mention threads (native streaming needs a DM/recipient
 * context, which mentions lack).
 *
 * Pinned against chat@4.39.0 / @cloudflare/think@0.17.0.
 */
export const FALLBACK_STREAM_PLACEHOLDER = "...";

/**
 * Cold-start-aware receipt replacing the bare placeholder above.
 *
 * Motivation (mpppk/slack-cosense-bot#5, local `wrangler dev` measurement):
 * `cosense --version` takes ~5-7s cold / ~3.2s+ warm, read-only search
 * ~6-7s cold / ~3.2-5.4s warm, and the container exits after ~9-10min idle.
 * Neither path fits Slack's 3s webhook window, so the first visible post must
 * set a ~10s expectation up front.
 */
export const ACK_RECEIPT_TEXT =
	"調べています…コンテナを起動中の可能性があるため、10秒ほどかかることがあります";

/**
 * Rewrite only the fallback-stream placeholder into the receipt text.
 * Stream edits, final content, and the empty/error/interrupted texts (owned
 * by other tasks) pass through untouched.
 */
export function resolveReceiptPost(
	message: AdapterPostableMessage,
): AdapterPostableMessage {
	if (message === FALLBACK_STREAM_PLACEHOLDER) return ACK_RECEIPT_TEXT;
	return message;
}
