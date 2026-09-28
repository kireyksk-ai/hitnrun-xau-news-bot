import test from "node:test";
import assert from "node:assert/strict";
import { reusableEditorialPrompt } from "../dist/editor.js";

test("Sol reuses only stable editorial instructions, never article facts", () => {
  const first = reusableEditorialPrompt("gpt-5.6-sol", "stable guide", "article A");
  const second = reusableEditorialPrompt("gpt-5.6-sol", "stable guide", "article B");
  assert.deepEqual(first.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(first.input[0], second.input[0]);
  assert.deepEqual(first.input[0].content, [{ type: "input_text", text: "stable guide", prompt_cache_breakpoint: { mode: "explicit" } }]);
  assert.equal(first.input[1].content, "article A");
  assert.equal(second.input[1].content, "article B");
});

test("older models retain their original prompt shape", () => {
  assert.deepEqual(reusableEditorialPrompt("gpt-5-mini", "guide", "article"), {
    input: [{ role: "developer", content: "guide" }, { role: "user", content: "article" }]
  });
});
