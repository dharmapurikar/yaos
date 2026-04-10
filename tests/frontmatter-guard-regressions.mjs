const guardModule = await import("../src/sync/frontmatterGuard.ts");
const guard = guardModule.default ?? guardModule;
const {
	extractFrontmatter,
	validateFrontmatterTransition,
	isFrontmatterBlocked,
} = guard;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

console.log("\n--- Test 1: body-only markdown bypasses frontmatter guard ---");
{
	const result = validateFrontmatterTransition(
		"body before\n",
		"body after\n",
	);
	assert(result.risk === "ok", "body-only edit is ok");
	assert(result.frontmatterLength === null, "body-only edit has no frontmatter length");
}

console.log("\n--- Test 2: duplicate frontmatter keys are blocked ---");
{
	const next = [
		"---",
		"taskSourceType: taskNotes",
		"taskSourceType: taskNotes",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "duplicate key is blocked");
	assert(result.reasons.includes("duplicate-key:taskSourceType"), "duplicate key reason is reported");
}

console.log("\n--- Test 3: repeated bare key bursts are blocked ---");
{
	const next = [
		"---",
		"taskSourceType",
		"taskSourceType",
		"taskSourceType",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "repeated bare key burst is blocked");
	assert(
		result.reasons.includes("repeated-bare-key-burst:taskSourceType"),
		"bare key burst reason is reported",
	);
}

console.log("\n--- Test 4: quoted duplicate frontmatter keys are blocked ---");
{
	const next = [
		"---",
		"\"task source\": taskNotes",
		"\"task source\": taskNotes",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "quoted duplicate key is blocked");
	assert(result.reasons.includes("duplicate-key:task source"), "quoted duplicate key reason is reported");
}

console.log("\n--- Test 5: unknown top-level YAML warns instead of blocking ---");
{
	const next = [
		"---",
		"? complex",
		": value",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(result.risk === "warn", "unknown top-level YAML is a warning");
	assert(!isFrontmatterBlocked(result), "unknown top-level YAML is not blocked");
}

console.log("\n--- Test 6: malformed frontmatter fence is blocked ---");
{
	const next = [
		"---",
		"title: Broken",
		"body that never closed",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "missing closing fence is blocked");
	assert(
		result.reasons.includes("malformed-frontmatter:missing-closing-fence"),
		"malformed fence reason is reported",
	);
}

console.log("\n--- Test 7: frontmatter growth burst is blocked ---");
{
	const previous = [
		"---",
		"title: Short",
		"---",
		"body",
	].join("\n");
	const next = [
		"---",
		"title: Short",
		`notes: ${"x".repeat(300)}`,
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(previous, next);
	assert(isFrontmatterBlocked(result), "large frontmatter-only growth burst is blocked");
	assert(result.reasons.includes("frontmatter-growth-burst"), "growth burst reason is reported");
}

console.log("\n--- Test 8: extractor separates frontmatter and body ---");
{
	const markdown = [
		"---",
		"title: Clean",
		"---",
		"",
		"body",
	].join("\n");
	const block = extractFrontmatter(markdown);
	assert(block.kind === "present", "frontmatter block is detected");
	assert(block.kind === "present" && block.frontmatterText.includes("title: Clean"), "frontmatter text is extracted");
	assert(block.kind === "present" && block.bodyText === "\nbody", "body text is extracted");
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
