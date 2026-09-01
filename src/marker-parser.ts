/** The operations that can be requested from a Cosense page. */
export const MARKER_OPERATIONS = ["query", "ingest", "lint"] as const;

export type MarkerOperation = (typeof MARKER_OPERATIONS)[number];

/** Alias used when a caller is switching on the operation discriminator. */
export type MarkerKind = MarkerOperation;

/**
 * A user instruction found in a page body.
 *
 * `text` is the marker-free text on the instruction line. `children` contains
 * consecutive lines indented exactly one space below that line; the one
 * leading indentation space is removed from each returned child.
 */
export interface MarkerInstruction {
	kind: MarkerKind;
	text: string;
	children: string[];
}

/** Instructions grouped by the operation requested by their marker. */
export type RoutedMarkerInstructions = {
	[operation in MarkerOperation]: MarkerInstruction[];
};

const USER_ICON = "[yuki.icon]";
const MARKER_AT_LINE_START = /^\[(query|ingest|lint)\]/;

/**
 * Parse marker instructions from a Cosense page body.
 *
 * Detection is deliberately strict: an operation marker must be at column
 * zero and the user icon must be the final token on the same line. This keeps
 * ordinary questions, comments, and URLs inert. Parsing has no I/O and does
 * not mutate the input.
 */
export function parseMarkerLines(pageBody: string): MarkerInstruction[] {
	const lines = pageBody.split(/\r\n?|\n/);
	const instructions: MarkerInstruction[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const marker = parseMarkerLine(line);
		if (!marker) continue;

		const children: string[] = [];
		let childIndex = lineIndex + 1;
		for (; childIndex < lines.length; childIndex += 1) {
			const child = parseChildLine(lines[childIndex]);
			if (child === undefined) break;
			children.push(child);
		}

		instructions.push({ ...marker, children });
		// Child lines cannot independently be marker lines because they are
		// indented, so skip the block that was just consumed.
		lineIndex = childIndex - 1;
	}

	return instructions;
}

/**
 * Group already-parsed instructions by their operation kind while preserving
 * their order within each group.
 */
export function routeMarkerInstructions(
	instructions: readonly MarkerInstruction[],
): RoutedMarkerInstructions {
	const routed: RoutedMarkerInstructions = {
		query: [],
		ingest: [],
		lint: [],
	};

	for (const instruction of instructions) {
		routed[instruction.kind].push(instruction);
	}

	return routed;
}

/** Parse a page and group its instructions by operation in one step. */
export function routeMarkerLines(pageBody: string): RoutedMarkerInstructions {
	return routeMarkerInstructions(parseMarkerLines(pageBody));
}

function parseMarkerLine(
	line: string,
): Omit<MarkerInstruction, "children"> | undefined {
	const marker = MARKER_AT_LINE_START.exec(line);
	if (!marker || !line.endsWith(USER_ICON)) return undefined;

	const markerEnd = marker[0].length;
	const iconStart = line.length - USER_ICON.length;
	return {
		kind: marker[1] as MarkerKind,
		text: line.slice(markerEnd, iconStart).trim(),
	};
}

/**
 * Cosense uses one leading ASCII space for one level of indentation. A blank
 * line, a same-level line, or a deeper line ends the consecutive child block.
 */
function parseChildLine(line: string): string | undefined {
	if (!line.startsWith(" ") || line.startsWith("  ")) return undefined;

	const child = line.slice(1);
	return child.trim() === "" ? undefined : child;
}
