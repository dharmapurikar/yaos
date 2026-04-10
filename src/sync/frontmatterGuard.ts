export type FrontmatterRisk = "ok" | "warn" | "block" | "unknown";

export interface FrontmatterValidationResult {
	risk: FrontmatterRisk;
	reasons: string[];
	frontmatterLength: number | null;
	previousFrontmatterLength?: number | null;
}

type FrontmatterBlock =
	| { kind: "none" }
	| { kind: "malformed"; reason: string }
	| {
		kind: "present";
		frontmatterText: string;
		bodyText: string;
		start: number;
		end: number;
	};

const FRONTMATTER_OPEN = "---";
const FRONTMATTER_CLOSE = new Set(["---", "..."]);
const REPEATED_KEY_BURST_THRESHOLD = 3;

export function validateFrontmatterTransition(
	previousContent: string | null | undefined,
	nextContent: string,
): FrontmatterValidationResult {
	const next = extractFrontmatter(nextContent);
	if (next.kind === "none") {
		return {
			risk: "ok",
			reasons: [],
			frontmatterLength: null,
			previousFrontmatterLength: getFrontmatterLength(previousContent),
		};
	}

	if (next.kind === "malformed") {
		return {
			risk: "block",
			reasons: [`malformed-frontmatter:${next.reason}`],
			frontmatterLength: null,
			previousFrontmatterLength: getFrontmatterLength(previousContent),
		};
	}

	const analysis = analyzeFrontmatter(next.frontmatterText);
	const reasons = [...analysis.blockReasons];
	const previousLength = getFrontmatterLength(previousContent);
	const nextLength = next.frontmatterText.length;
	if (
		previousLength != null
		&& previousLength > 0
		&& nextLength > previousLength * 2
		&& nextLength - previousLength > 128
	) {
		reasons.push("frontmatter-growth-burst");
	}

	return {
		risk: reasons.length > 0 ? "block" : (analysis.warnReasons.length > 0 ? "warn" : "ok"),
		reasons: reasons.length > 0 ? reasons : analysis.warnReasons,
		frontmatterLength: nextLength,
		previousFrontmatterLength: previousLength,
	};
}

export function isFrontmatterBlocked(result: FrontmatterValidationResult): boolean {
	return result.risk === "block";
}

export function extractFrontmatter(content: string): FrontmatterBlock {
	const firstLineEnd = findLineEnd(content, 0);
	const firstLine = content.slice(0, firstLineEnd).trim();
	if (firstLine !== FRONTMATTER_OPEN) {
		return { kind: "none" };
	}

	let cursor = advancePastLineBreak(content, firstLineEnd);
	const frontmatterStart = cursor;
	while (cursor < content.length) {
		const lineEnd = findLineEnd(content, cursor);
		const line = content.slice(cursor, lineEnd).trim();
		if (FRONTMATTER_CLOSE.has(line)) {
			const bodyStart = advancePastLineBreak(content, lineEnd);
			return {
				kind: "present",
				frontmatterText: content.slice(frontmatterStart, cursor),
				bodyText: content.slice(bodyStart),
				start: frontmatterStart,
				end: cursor,
			};
		}
		cursor = advancePastLineBreak(content, lineEnd);
	}

	return { kind: "malformed", reason: "missing-closing-fence" };
}

function getFrontmatterLength(content: string | null | undefined): number | null {
	if (content == null) return null;
	const block = extractFrontmatter(content);
	return block.kind === "present" ? block.frontmatterText.length : null;
}

function analyzeFrontmatter(frontmatterText: string): { blockReasons: string[]; warnReasons: string[] } {
	const blockReasons = new Set<string>();
	const warnReasons = new Set<string>();
	const topLevelKeys = new Map<string, number>();
	const bareTopLevelKeys = new Map<string, number>();

	for (const rawLine of frontmatterText.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (/^\s/.test(line) || trimmed.startsWith("- ")) continue;

		const keyMatch = /^([A-Za-z0-9_-][A-Za-z0-9_-]*)\s*:/.exec(trimmed);
		const quotedKeyMatch = /^["']([^"']+)["']\s*:/.exec(trimmed);
		const key = keyMatch?.[1] ?? quotedKeyMatch?.[1];
		if (key) {
			const count = (topLevelKeys.get(key) ?? 0) + 1;
			topLevelKeys.set(key, count);
			if (count > 1) blockReasons.add(`duplicate-key:${key}`);
			continue;
		}

		const bareKeyMatch = /^([A-Za-z0-9_-][A-Za-z0-9_-]*)$/.exec(trimmed);
		if (bareKeyMatch?.[1]) {
			const key = bareKeyMatch[1];
			const count = (bareTopLevelKeys.get(key) ?? 0) + 1;
			bareTopLevelKeys.set(key, count);
			blockReasons.add(`bare-top-level-scalar:${key}`);
			if (count >= REPEATED_KEY_BURST_THRESHOLD) {
				blockReasons.add(`repeated-bare-key-burst:${key}`);
			}
			continue;
		}

		warnReasons.add("unknown-top-level-yaml");
	}

	for (const [key, count] of topLevelKeys) {
		if (count >= REPEATED_KEY_BURST_THRESHOLD) {
			blockReasons.add(`repeated-key-burst:${key}`);
		}
	}

	return {
		blockReasons: Array.from(blockReasons),
		warnReasons: Array.from(warnReasons),
	};
}

function findLineEnd(content: string, start: number): number {
	const newline = content.indexOf("\n", start);
	if (newline === -1) return content.length;
	return content.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
}

function advancePastLineBreak(content: string, lineEnd: number): number {
	if (lineEnd >= content.length) return content.length;
	if (content.charCodeAt(lineEnd) === 13 && content.charCodeAt(lineEnd + 1) === 10) {
		return lineEnd + 2;
	}
	if (content.charCodeAt(lineEnd) === 10) {
		return lineEnd + 1;
	}
	if (content.charCodeAt(lineEnd) === 13) {
		return lineEnd + 1;
	}
	return lineEnd;
}
