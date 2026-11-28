#!/usr/bin/env node
// Patches @ian-pascoe/pi-minimal-subagents so its viewer-shortcut editor Proxy keeps a
// handleInput assigned by a later wrapper (e.g. pi-vim-editor) instead of writing it through
// to the target. Without this, the two wrappers call each other until the stack overflows.
//
// Usage: patch-minimal-subagents.mjs [path/to/minimal-subagents-extension.ts]
// Safe to re-run: exits 0 without changes if the patch is already applied.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file =
  process.argv[2] ??
  join(
    homedir(),
    ".pi/agent/npm/node_modules/@ian-pascoe/pi-minimal-subagents/src/minimal-subagents-extension.ts",
  );

const edits = [
  [
    "    let focused = false;\n    const handleInput = (data: string) => {\n",
    "    let focused = false;\n    let outerHandleInput: ((data: string) => void) | undefined;\n    const handleInput = (data: string) => {\n",
  ],
  [
    '        if (property === "handleInput") return handleInput;\n',
    '        if (property === "handleInput") return outerHandleInput ?? handleInput;\n',
  ],
  [
    '      set(target, property, value) {\n        if (property === "focused") {\n',
    '      set(target, property, value) {\n' +
      "        // A later wrapper (e.g. a Vim editor) installs its handler over ours; keep it on the\n" +
      "        // proxy so its passthrough still reaches ours instead of looping through the target.\n" +
      '        if (property === "handleInput") {\n' +
      "          outerHandleInput = value;\n" +
      "          return true;\n" +
      "        }\n" +
      '        if (property === "focused") {\n',
  ],
];

let source;
try {
  source = readFileSync(file, "utf8");
} catch (error) {
  console.error(`Cannot read ${file}: ${error.message}`);
  process.exit(1);
}

if (source.includes("outerHandleInput")) {
  console.log(`Already patched: ${file}`);
  process.exit(0);
}

// Check every anchor before writing, so a changed upstream file is never half-patched.
const missing = edits.filter(([from]) => source.split(from).length !== 2);
if (missing.length > 0) {
  console.error(
    `Upstream code changed; ${missing.length} of ${edits.length} anchors not found exactly once in ${file}.`,
  );
  console.error("Check whether the bug is fixed upstream before patching by hand.");
  process.exit(1);
}

for (const [from, to] of edits) source = source.replace(from, to);
writeFileSync(file, source);
console.log(`Patched: ${file}\nRestart pi to load it.`);
