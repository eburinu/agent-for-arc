"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatToolResult } = require("../format");

for (const [name, content] of [
  ["short article", { title: "Article", content: "x".repeat(700) + "article-end" }],
  ["search results", [{ title: "Result", summary: "x".repeat(700) + "result-end" }]],
  ["plain text", "x".repeat(700) + "text-end"],
  ["empty text", ""],
]) {
  test(`full extraction preserves ${name}`, () => {
    const output = formatToolResult("page_extract_content", {
      content_type: "article", method: "semantic_extraction", content,
    });
    const expected = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    assert.equal(output, `Extracted article content using semantic_extraction:\n\n${expected}`.trimEnd());
  });
}

test("summary extraction keeps the summary format", () => {
  const output = formatToolResult("page_extract_content", {
    content_type: "article", extraction_method: "semantic_extraction",
    summary: { title: "Article", word_count: 10, reading_time: 1, preview: "Summary tail" },
  });
  assert.match(output, /Article: "Article"/);
  assert.match(output, /Preview: Summary tail$/);
});

for (const truncated of [false, true]) {
  test(`selection preserves the extension's length limit (truncated=${truncated})`, () => {
    const selected_text = "x".repeat(700) + "selection-end";
    const output = formatToolResult("get_selected_text", {
      has_selection: true, selected_text, character_count: 1200, truncated,
    });
    assert.ok(output.includes(`"${selected_text}"`));
    assert.equal(output.includes("Text was truncated"), truncated);
  });
}

test("run_steps preserves full read results", () => {
  const selected_text = "x".repeat(700) + "batch-end";
  const output = formatToolResult("run_steps", {
    success: true, steps_total: 1, steps_run: 1,
    report: [{ ok: true, index: 0, tool: "get_selected_text", ms: 1,
      result: { has_selection: true, selected_text, character_count: selected_text.length } }],
  });
  assert.ok(output.includes(`"${selected_text}"`));
});
