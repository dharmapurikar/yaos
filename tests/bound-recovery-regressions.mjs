import { readFileSync } from "node:fs";
import * as Y from "yjs";

const diffModule = await import("../src/sync/diff.ts");
const { applyDiffToYText } = diffModule.default;

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

function makeText(content) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, content);
	return { doc, ytext };
}

console.log("\n--- Test 1: bound-file recovery applies one content authority ---");
{
	const crdt = [
		"---",
		"timeEstimate: 2",
		"kind: op",
		"---",
		"",
	].join("\n");
	const disk = [
		"---",
		"timeEstimate: 20",
		"kind: op",
		"---",
		"",
	].join("\n");
	const staleEditor = [
		"---",
		"timeEstimate: 200",
		"kind: op",
		"---",
		"",
	].join("\n");

	const fixed = makeText(crdt);
	applyDiffToYText(fixed.ytext, crdt, disk, "disk-sync-recover-bound");
	assert(
		fixed.ytext.toString() === disk,
		"fixed recovery leaves CRDT at the chosen disk content",
	);
	fixed.doc.destroy();

	const oldAmplifier = makeText(crdt);
	applyDiffToYText(oldAmplifier.ytext, crdt, disk, "disk-sync-recover-bound");
	applyDiffToYText(oldAmplifier.ytext, disk, staleEditor, "editor-health-heal");
	assert(
		oldAmplifier.ytext.toString() === staleEditor,
		"old disk-then-heal sequence can reapply stale editor content",
	);
	assert(
		oldAmplifier.ytext.toString() !== disk,
		"old disk-then-heal sequence does not preserve the chosen disk authority",
	);
	oldAmplifier.doc.destroy();
}

console.log("\n--- Test 2: local-only recovery branch uses non-writing repair ---");
{
	const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const localOnlyStart = mainSource.indexOf("const localOnlyViews = viewStates.filter");
	const crdtOnlyStart = mainSource.indexOf("const crdtOnlyViews = viewStates.filter");
	const branch = mainSource.slice(localOnlyStart, crdtOnlyStart);

	assert(localOnlyStart > -1 && crdtOnlyStart > localOnlyStart, "local-only recovery branch found");
	assert(branch.includes("editorBindings?.repair("), "local-only recovery repairs binding without content heal");
	assert(!branch.includes("editorBindings?.heal("), "local-only recovery does not call content-writing heal");
	assert(branch.includes('"disk-sync-recover-bound"'), "local-only recovery still applies disk-selected CRDT diff");
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
