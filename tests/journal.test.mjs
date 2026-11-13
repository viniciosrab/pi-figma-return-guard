// Tests for the local journal of Figma script calls and its report.
// Run: npm test
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-guard-journal-"));
process.env.PI_CODING_AGENT_DIR = dir;
const journalFile = path.join(dir, "figma-return-guard", "journal.jsonl");

const mod = await import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const journal = await import(fileURLToPath(new URL("../src/journal.ts", import.meta.url)));

const handlers = {};
mod.default({ on: (event, fn) => { handlers[event] = fn; }, getAllTools: () => [] });
handlers.session_start?.({}, {});

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log(`FAIL ${name}`); } };
const read = () => (fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(path.join(dir, "figma-return-guard"), { recursive: true, force: true });

const CODE = "const a = 1;\nconst secret = 'Layer name: Meus cursos';\nconst x = null; x.foo = a;\nreturn 'never';";
const result = (text, { toolName = "mcp__figma__use_figma", isError = true, code = CODE } = {}) =>
  handlers.tool_result?.({ toolName, isError, input: { code }, content: [{ type: "text", text }, { type: "text", text: "Figma Debug UUID: abc-123" }] }, {});
const call = (code, toolName = "mcp__figma__use_figma") => {
  const input = { code };
  return { r: handlers.tool_call?.({ toolName, input }), code: input.code };
};

// Normalization of real Figma error texts.
const norm = journal.normalizeError;
check("normalizes node ids", norm('Error: in appendChild: The node with id "142:390" does not exist\n    at <anonymous> (PLUGIN_9_SOURCE:1:187)') === 'Error: in appendChild: The node with id "<id>" does not exist');
check("normalizes instance ids", norm('Error: in appendChild: The node with id "I142:367;105:120" does not exist') === 'Error: in appendChild: The node with id "<id>" does not exist');
check("keeps property names", norm("TypeError: cannot read property 'find' of undefined\n    at <anonymous> (PLUGIN_3_SOURCE:1:168)") === "TypeError: cannot read property 'find' of undefined");
check("normalizes numbers", norm("Error: in query: Invalid selector: unexpected character (0xc3) at position 15") === "Error: in query: Invalid selector: unexpected character (0xc3) at position <n>");
check("normalizes indexes", norm('Error: in set_fills: Property "fills" failed validation: Expected number, received nan at [0].color.b') === 'Error: in set_fills: Property "fills" failed validation: Expected number, received nan at [<n>].color.b');
check("hides quoted text that is not a name", norm("Error: in set_name: 'Meus cursos / Card 2' is invalid") === "Error: in set_name: '<s>' is invalid");
check("drops the debug UUID line", norm("Figma Debug UUID: x\nTypeError: boom") === "TypeError: boom");
check("caps at 200 characters", norm("Error: " + "x".repeat(500)).length === 200);

// One entry per Figma script result.
reset();
result("TypeError: cannot set property 'foo' of null\n    at <anonymous> (PLUGIN_1_SOURCE:3:27)");
result("ok", { isError: false });
let entries = read();
check("writes one entry per result", entries.length === 2);
const [err, ok] = entries;
check("error entry has the exact fields",
  err?.v === 1 && err.kind === "result" && typeof err.ts === "string" && typeof err.session === "string" && err.session.length > 0 &&
  err.tool === "mcp__figma__use_figma" && err.ok === false && err.class === "TypeError: cannot set property 'foo' of null" &&
  err.line === 3 && err.advice === "lookup" && err.scriptError === true);
check("success entry has no class or advice", ok?.ok === true && ok.class === null && ok.line === null && ok.advice === null && ok.scriptError === false && ok.session === err.session);
const raw = fs.readFileSync(journalFile, "utf8");
check("journal is private to the user", (fs.statSync(journalFile).mode & 0o077) === 0 && (fs.statSync(path.dirname(journalFile)).mode & 0o077) === 0);
check("never stores the script or the failing line", !raw.includes("Meus cursos") && !raw.includes("x.foo") && !raw.includes("abc-123"));

reset();
result("Error: in set_fills: Expected array\n    at <anonymous> (PLUGIN_1_SOURCE:99:3)");
result("MCP request timed out after 60000ms");
entries = read();
check("script error without advice is marked none, line outside script is null", entries[0]?.advice === "none" && entries[0].line === null && entries[0].scriptError === true);
check("non-script error has no advice", entries[1]?.advice === null && entries[1].scriptError === false && entries[1].class === "MCP request timed out after <n>ms");

reset();
result("TypeError: x", { toolName: "bash" });
result("TypeError: x", { code: null });
check("does not journal non-Figma tools or calls without a script", read().length === 0);

// Blocks and silent fixes.
reset();
call("return figma.base64Encode(b);");
call("await n.setRangeOpenTypeFeatures(0, 1, {});");
call("const a = ;");
call("const row = 1;\nconst row = 2;\nawait figma.loadAllPagesAsync();\nnode.setPluginData('k', 'v');\nreturn row;");
call("return 'fine';");
call("const a = ;", "bash");
entries = read();
check("records blocks by reason", entries.filter((e) => e.kind === "blocked").map((e) => e.reason).join() === "base64,unsupported:setRangeOpenTypeFeatures,syntax");
const fixed = entries.filter((e) => e.kind === "fixed");
check("records silent fixes", fixed.length === 1 && fixed[0].fixes.slice().sort().join() === "loadAllPagesAsync,pluginData,redeclaration");
check("records nothing for clean scripts and other tools", entries.length === 4);
reset();
result(mod.REASON);
check("does not count a blocked call's result again", read().length === 0);

// Journal failure never changes the outcome.
const goodResult = result("TypeError: cannot read property 'find' of undefined");
const goodBlock = call("return figma.base64Encode(b);").r;
const goodFix = call("const r = 1;\nconst r = 2;\nreturn r;").code;
const asFile = path.join(dir, "not-a-dir");
fs.writeFileSync(asFile, "x");
process.env.PI_CODING_AGENT_DIR = asFile;
let threw = false;
let badResult, badBlock, badFix;
try {
  badResult = result("TypeError: cannot read property 'find' of undefined");
  badBlock = call("return figma.base64Encode(b);").r;
  badFix = call("const r = 1;\nconst r = 2;\nreturn r;").code;
} catch { threw = true; }
check("journal failure does not throw", !threw);
check("journal failure leaves results identical",
  JSON.stringify(badResult) === JSON.stringify(goodResult) && JSON.stringify(badBlock) === JSON.stringify(goodBlock) && badFix === goodFix);
process.env.PI_CODING_AGENT_DIR = dir;

// Rotation: an oversized journal is moved aside, never rewritten.
reset();
fs.mkdirSync(path.dirname(journalFile), { recursive: true });
fs.writeFileSync(journalFile, "x".repeat(5 * 1024 * 1024 + 10));
result("ok", { isError: false });
check("rotates a journal over 5 MB", fs.statSync(journalFile.replace(/\.jsonl$/, ".1.jsonl")).size > 5 * 1024 * 1024 && read().length === 1);

// Report aggregation.
const e = (session, ok, cls = null, advice = null) => ({ v: 1, kind: "result", session, ok, class: cls, advice, scriptError: !ok });
const A = "TypeError: a", B = "TypeError: b";
const s = journal.summarize([
  e("s1", true), e("s1", false, A, "lookup"), e("s1", false, A, "lookup"), e("s1", true),
  e("s2", false, B, "none"), e("s2", true),
  e("s3", false, A, "lookup"),
  { v: 1, kind: "blocked", session: "s1", reason: "base64" },
  { v: 1, kind: "fixed", session: "s2", fixes: ["redeclaration", "pluginData"] },
  { v: 1, kind: "fixed", session: "s3", fixes: ["redeclaration"] },
]);
check("report counts calls and errors", s.calls === 7 && s.errors === 4 && Math.abs(s.errorRate - 4 / 7) < 1e-9);
check("report counts blocks and fixes by kind", s.blocked.base64 === 1 && s.fixed.redeclaration === 2 && s.fixed.pluginData === 1);
const a = s.classes.find((c) => c.class === A);
const b = s.classes.find((c) => c.class === B);
check("report per class: count, sessions, recovered, extra calls",
  a?.count === 3 && a.sessions === 2 && a.recovered === 2 && a.extraCalls === 3 && b?.count === 1 && b.recovered === 1 && b.extraCalls === 1);
check("not covered classes come first", s.classes[0].class === B && s.classes[0].covered === false && a.covered === true);
const text = journal.formatReport({ ...s, corrupt: 2 });
check("formatted report lists not-covered first and corrupt lines",
  text.indexOf("Not covered yet") >= 0 && text.indexOf("Not covered yet") < text.indexOf(A) && text.includes(B) && /corrupt lines skipped: 2/i.test(text));
// Errors that are not script errors (timeouts, argument validation) got no
// advice by design: they are neither covered nor waiting for coverage.
const T = "MCP request timed out after <n>ms";
const s2 = journal.summarize([
  e("s1", false, A, "lookup"), e("s1", true),
  e("s2", false, B, "none"), e("s2", true),
  { v: 1, kind: "result", session: "s3", ok: false, class: T, advice: null, scriptError: false }, e("s3", true),
]);
const t = s2.classes.find((c) => c.class === T);
check("non-script errors are neither covered nor uncovered", t?.scriptError === false && t.count === 1 && t.recovered === 1 && s2.classes.at(-1) === t);
const text2 = journal.formatReport(s2);
const at = (h) => text2.indexOf(h);
check("report lists non-script errors in their own last section",
  at("Not script errors") > at("Covered:") && at("Covered:") > at("Not covered yet") && at("Not covered yet") >= 0 &&
  at(T) > at("Not script errors") && at(A) > at("Covered:") && at(A) < at("Not script errors") && at(B) < at("Covered:"));

const parsed = journal.parseJournal('{"v":1,"kind":"result","session":"s","ok":true}\nnot json\n\n{"v":1,"kind":"result","session":"s","ok":false,"class":"x"}\n');
check("parser skips corrupt lines and counts them", parsed.entries.length === 2 && parsed.corrupt === 1);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} journal checks failed` : "all journal checks passed");
process.exit(failed ? 1 : 0);
