import type { CosenseEditOp } from "./cosense-edit";
import type { MarkerInstruction } from "./marker-parser";

/**
 * Marker deletion + Slack-link writeback in ONE submitEdit (Issue #14).
 *
 * This is the ONLY duplicate-execution guard: the writeback (link append +
 * marker removal) runs after thread creation and is awaited before the
 * handler finishes, so a repeated notification finds no marker and does
 * nothing. Debounced notifications therefore process exactly once.
 *
 * Pure ops planning lives here (unit-tested); the preview→submit round trip
 * with NO approval is wired in `cosense-notification.ts` via injected deps.
 */

export const WRITEBACK_LINK_LABEL = "Slack";

/** A page line with the stable id `previewEdit` ops anchor on. */
export interface EditablePageLine {
	id: string;
	text: string;
}

/**
 * Labeled external-URL notation for the Slack link. The label is mandatory:
 * a bare `[URL]` line is rendered by Cosense as an embedded image
 * (AGENTS.md §7), so `[Slack <permalink>]` — never a bare URL.
 */
export function formatSlackLink(permalink: string): string {
	return `[${WRITEBACK_LINK_LABEL} ${permalink}]`;
}

/**
 * Marker + trailing-icon patterns. These intentionally mirror
 * `marker-parser.ts` (`MARKER_AT_LINE_START`, `TRAILING_USER_ICON`):
 * the planner re-locates the already-parsed instructions on the fresh
 * `readPage` lines, so the match predicate must be identical.
 */
const MARKER_AT_LINE_START = /^\[(query|ingest|lint)\]/;
const TRAILING_USER_ICON = /\s*\[[^\[\]\s]+\.icon\]$/;

/** Normalize a marker line for identity comparison (marker + icon free). */
function markerIdentity(line: string): { kind: string; text: string } | undefined {
	const marker = MARKER_AT_LINE_START.exec(line);
	if (!marker) return undefined;
	const kind = marker[1] as string;
	const rest = line.slice(marker[0].length);
	const withoutIcon = rest.replace(TRAILING_USER_ICON, "");
	return { kind, text: withoutIcon.trim() };
}

/**
 * Marker syntax removed, wording preserved: `[query] foo [yuki.icon]` →
 * `foo [yuki.icon]`, `[query]foo` → `foo`. The single separator space after
 * the marker is consumed too — leaving it would indent the line and turn it
 * into a child of the previous line.
 */
export function stripMarkerSyntax(line: string): string {
	const marker = MARKER_AT_LINE_START.exec(line);
	if (!marker) return line;
	const rest = line.slice(marker[0].length);
	return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/** Cosense child block: consecutive lines indented exactly one space. */
function childBlockEnd(lines: readonly EditablePageLine[], start: number): number {
	let end = start;
	while (end < lines.length) {
		const text = lines[end]?.text ?? "";
		if (!text.startsWith(" ") || text.startsWith("  ")) break;
		if (text.trim() === "") break;
		end += 1;
	}
	return end;
}

export interface MarkerWritebackPlan {
	/** Ops for ONE submitEdit covering every matched marker. */
	ops: CosenseEditOp[];
	matched: number;
	unmatched: number;
}

/**
 * Plan the writeback ops for markers whose threads were created.
 *
 * Per matched marker line (page order, replace-then-insert):
 * - Content markers: `replace` the marker line with the marker-free text,
 *   then `insertBefore` the first line after its child block (or `_end`)
 *   with ` [Slack <permalink>]` — one leading space, a child of the
 *   instruction line.
 * - Bare markers (`instruction.text === ""`, e.g. `[query][yuki.icon]`):
 *   a single `replace` of the marker line with the top-level
 *   `[Slack <permalink>]`. The link takes the marker's slot (rolled up)
 *   and any existing children stay attached under it.
 *
 * Deliberately replace-only, never `delete`: deletes would invalidate the
 * `insertBefore` anchors of sibling markers, while replace keeps every
 * line id stable — so one batched submitEdit is order-safe. The visible
 * result is identical to delete (marker gone, link remains).
 *
 * Instructions that no longer match a marker line (already processed by a
 * concurrent run — the dedup mechanism working) yield no ops.
 */
export function planMarkerWriteback(
	lines: readonly EditablePageLine[],
	instructions: readonly MarkerInstruction[],
	permalink: string,
): MarkerWritebackPlan {
	const link = formatSlackLink(permalink);
	const ops: CosenseEditOp[] = [];
	const used = new Set<number>();
	let unmatched = 0;

	for (const instruction of instructions) {
		let found = -1;
		for (let index = 0; index < lines.length; index += 1) {
			if (used.has(index)) continue;
			const identity = markerIdentity(lines[index]?.text ?? "");
			if (
				identity &&
				identity.kind === instruction.kind &&
				identity.text === instruction.text
			) {
				found = index;
				break;
			}
		}
		if (found === -1) {
			unmatched += 1;
			continue;
		}
		used.add(found);
		const line = lines[found];
		if (!line) {
			unmatched += 1;
			continue;
		}

		if (instruction.text === "") {
			// Bare marker: the link takes the marker line's slot.
			ops.push({ replace: line.id, text: link });
			continue;
		}

		ops.push({ replace: line.id, text: stripMarkerSyntax(line.text) });
		const blockEnd = childBlockEnd(lines, found + 1);
		const anchor = blockEnd < lines.length ? (lines[blockEnd]?.id ?? "_end") : "_end";
		ops.push({ insertBefore: anchor, text: ` ${link}` });
	}

	return { ops, matched: used.size, unmatched };
}

/**
 * Pull the `previewId` out of `previewEdit` stdout. The CLI prints a plain
 * text header whose first line is `previewId: <id>`; the id is single-use
 * and expires after 5 minutes, so callers submit immediately with no
 * approval step in between.
 */
export function parsePreviewId(previewOutput: string): string | undefined {
	const match = /^previewId:\s*(\S+)/m.exec(previewOutput);
	return match?.[1];
}
