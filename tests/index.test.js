/**
 * Unit tests for the pure parts of dsh-compact-threshold: the ratio tag that
 * preset ids admit, the managed id derived from it, and the composition
 * rewrite that injects or replaces the compaction threshold.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { managedId, ratioTag, rewriteThreshold } from "../lib/index.js";

const COMPOSITION = fileURLToPath(new URL("../fixtures/standard-like.cordis.yml", import.meta.url));

test("ratioTag keeps the id grammar (letters, digits, hyphens only)", () => {
	assert.equal(ratioTag(0.4), "4");
	assert.equal(ratioTag(0.75), "75");
	assert.equal(ratioTag(0.8), "8");
	assert.equal(ratioTag(0.385), "385");
	assert.equal(ratioTag(0.4), ratioTag(0.40), "equal ratios must map to one id");
	for (const ratio of [0.4, 0.75, 0.385]) {
		assert.match(managedId("standard", ratio), /^[a-z0-9][a-z0-9-]*$/);
	}
});

test("managedId appends the tagged ratio to the source id", () => {
	assert.equal(managedId("standard", 0.4), "standard-compact-4");
	assert.equal(managedId("ptc", 0.6), "ptc-compact-6");
});

test("rewriteThreshold replaces a threshold the row already has", () => {
	const text = ["- id: compaction-basic", "  name: x", "  config:", "    thresholdRatio: 0.8", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, true);
	assert.match(result.text, /thresholdRatio: 0\.4/);
	assert.doesNotMatch(result.text, /0\.8/);
	assert.equal(result.text.split("\n").filter((line) => line.includes("thresholdRatio")).length, 1);
});

test("rewriteThreshold inserts a config block when the row has none", () => {
	const text = ["- id: compaction-basic", "  name: x", "- id: command-compact", "  name: y", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, true);
	// The block is appended to the row's own keys, so the next row still starts
	// at column 0 with its own `- id:` marker.
	assert.match(result.text, /- id: compaction-basic\n {2}name: x\n {2}config:\n {4}thresholdRatio: 0\.4\n- id: command-compact/);
});

test("rewriteThreshold inserts before an unindented sibling key too", () => {
	const text = ["- id: compaction-basic", "  name: x", "# a comment", "- id: next", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.match(result.text, /- id: compaction-basic\n {2}name: x\n# a comment\n {2}config:\n {4}thresholdRatio: 0\.4\n- id: next/);
});

test("rewriteThreshold leaves other rows untouched", () => {
	const text = ["- id: compaction-basic-extra", "  name: x", "  config:", "    thresholdRatio: 0.9", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, false);
	assert.equal(result.text, text);
});

test("rewriteThreshold handles the real shipped composition", async () => {
	const original = await readFile(COMPOSITION, "utf8");
	const result = rewriteThreshold(original, 0.4);
	assert.equal(result.found, true);
	assert.match(result.text, /thresholdRatio: 0\.4/);
	// Everything outside the inserted lines must survive verbatim.
	const before = original.split("\n");
	const after = result.text.split("\n");
	assert.equal(after.length, before.length + 2);
	assert.equal(after[0], before[0]);
	assert.equal(after[after.length - 1], before[before.length - 1]);
});
