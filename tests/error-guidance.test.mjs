// Tests for the guidance added to failed Figma script results, and for the
// checks that stop scripts which cannot work before they reach Figma.
// Every error text below is what Figma returned when the mistake was reproduced.
// Run: npm test
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = "/nonexistent-figma-guard-test";
const mod = await import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const handlers = {};
mod.default({ on: (event, fn) => { handlers[event] = fn; }, getAllTools: () => [] });

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log(`FAIL ${name}`); } };

const UUID = "Figma Debug UUID: x";
const CODE = "const a = 1;\nconst b = 2;\n\nconst x = null; x.foo = a + b;\nreturn 'never';";
const result = (text, { toolName = "mcp__figma__use_figma", isError = true, code = CODE } = {}) =>
  handlers.tool_result?.({ toolName, isError, input: { code }, content: [{ type: "text", text }, { type: "text", text: UUID }] }, {});
// The advice goes into the error's own text part, so scripts that read only
// `content[0].text` still see it.
const added = (r, text) => (r?.content?.[0]?.text?.startsWith(text + "\n\n") ? r.content[0].text.slice(text.length) : "");
const keeps = (r, text) => r?.content?.length === 2 && r.content[0].text.startsWith(text + "\n\n") && r.content[1].text === UUID;

check("registers tool_result and tool_call handlers", typeof handlers.tool_result === "function" && typeof handlers.tool_call === "function");

const cases = [
  ["lookup: findAll on TEXT", "TypeError: node.findAll: no such property 'findAll' on TEXT node. The 'findAll' method is only available on node types that support children", mod.LOOKUP_GUIDANCE],
  ["lookup: find of undefined", "TypeError: cannot read property 'find' of undefined\n    at <anonymous> (PLUGIN_3_SOURCE:1:168)", mod.LOOKUP_GUIDANCE],
  ["lookup: id of null", "Error: in appendChild: TypeError: cannot read property 'id' of null\n    at <anonymous> (PLUGIN_13_SOURCE:1:201)", mod.LOOKUP_GUIDANCE],
  ["lookup: set property of null", "TypeError: cannot set property 'visible' of null", mod.LOOKUP_GUIDANCE],
  ["lookup: frame prop on TEXT", "TypeError: node.paddingTop: no such property 'paddingTop' on TEXT node", mod.LOOKUP_GUIDANCE],
  ["missing node: removed", 'Error: in appendChild: The node with id "142:390" does not exist\n    at <anonymous> (PLUGIN_9_SOURCE:1:187)', mod.MISSING_NODE_GUIDANCE],
  ["missing node: detached instance", 'Error: in appendChild: The node with id "I142:367;105:120" does not exist', mod.MISSING_NODE_GUIDANCE],
  ["missing node: getter", 'Error: in get_name: The node with id "140:2015" does not exist', mod.MISSING_NODE_GUIDANCE],
  ["unsupported API", 'Error: in loadAllPagesAsync: "loadAllPagesAsync" is not a supported API', mod.UNSUPPORTED_GUIDANCE],
  ["unsupported in host runtime", "Error: in setPluginData: figma.setPluginData is not supported in this host runtime (only private plugins on web can use it).", mod.UNSUPPORTED_GUIDANCE],
  ["not a function", "TypeError: figma.createAutoLayout is not a function", mod.UNSUPPORTED_GUIDANCE],
  ["instance override", "Error: in set_y: This property cannot be overridden in an instance: relative-transform", mod.INSTANCE_GUIDANCE],
  ["selector", "Error: in query: Invalid selector: unexpected character (0xc3) at position 15", mod.SELECTOR_GUIDANCE],
  ["NaN value", 'Error: in set_fills: Property "fills" failed validation: Expected number, received nan at [0].color.b', mod.NAN_GUIDANCE],
  ["component reference", "Error: in set_componentPropertyReferences: Can only set component property references on symbol sublayer", mod.COMPONENT_REF_GUIDANCE],
  ["syntax", "SyntaxError: invalid redefinition of lexical identifier", mod.SYNTAX_GUIDANCE],
];
for (const [name, text, advice] of cases) {
  const r = result(text);
  check(`${name}: keeps the original error`, keeps(r, text));
  check(`${name}: adds its advice`, typeof advice === "string" && added(r, text).includes(advice));
  check(`${name}: says the run was rolled back`, typeof mod.ROLLBACK_NOTE === "string" && added(r, text).includes(mod.ROLLBACK_NOTE));
}
check("lookup advice tells to filter by type and mentions hidden instance children",
  /n\.type === 'FRAME'/.test(mod.LOOKUP_GUIDANCE ?? "") && /skipInvisibleInstanceChildren/.test(mod.LOOKUP_GUIDANCE ?? ""));
check("missing-node advice covers remove, detachInstance and failed runs",
  /remove\(\)/.test(mod.MISSING_NODE_GUIDANCE ?? "") && /detachInstance/.test(mod.MISSING_NODE_GUIDANCE ?? "") && /failed run/i.test(mod.MISSING_NODE_GUIDANCE ?? ""));
check("selector advice shows a quoted value", /"Botão"/.test(mod.SELECTOR_GUIDANCE ?? ""));
check("rollback note tells not to clean up", /do not (clean up|delete)/i.test(mod.ROLLBACK_NOTE ?? ""));

// The failing line of the script is echoed.
const lineErr = "TypeError: cannot set property 'foo' of null\n    at <anonymous> (PLUGIN_1_SOURCE:4:27)\n    at <eval> (PLUGIN_1_SOURCE:6:3)";
check("echoes the failing script line", added(result(lineErr), lineErr).includes("line 4: const x = null; x.foo = a + b;"));
const synErr = "SyntaxError: invalid redefinition of lexical identifier";
check("no echo when the error has no script position", !/line \d+:/.test(added(result(synErr), synErr)));
const farErr = "TypeError: cannot read property 'x' of null\n    at <eval> (PLUGIN_1_SOURCE:99:3)";
check("no echo when the position is outside the script", !/line \d+:/.test(added(result(farErr), farErr)));
const longCode = "a".repeat(600) + "BOOM()" + "b".repeat(600);
const longErr = "TypeError: cannot read property 'x' of null\n    at <anonymous> (PLUGIN_1_SOURCE:1:602)";
const longEcho = added(result(longErr, { code: longCode }), longErr);
check("long lines are cut around the column", longEcho.includes("BOOM()") && longEcho.length < longCode.length);

// Unknown script errors still get the rollback note, without advice.
const other = "Error: in set_fills: Expected array";
check("unknown script error: keeps it and adds only the rollback note",
  keeps(result(other), other) && added(result(other), other).trim() === mod.ROLLBACK_NOTE);

// Left alone.
const missing = 'Error: in appendChild: The node with id "1:2" does not exist';
check("works for other Figma servers", added(result(missing, { toolName: "mcp__figma_linux_next__use_figma" }), missing).includes(mod.MISSING_NODE_GUIDANCE));
check("leaves successful results alone", result("ok", { isError: false }) === undefined);
check("leaves non-Figma tools alone", result("TypeError: x", { toolName: "bash" }) === undefined);
check("leaves the 48 KB error alone", result("Return value exceeds the 48000-byte limit (60000 bytes). Canvas edits from this run were not committed.") === undefined);
check("leaves blocked calls alone", result(mod.REASON) === undefined);
check("leaves argument validation errors alone (nothing ran)", result('Validation failed for tool "mcp__figma__use_figma":\n  - description: must have required property') === undefined);
check("leaves timeouts alone (the run may still finish)", result("MCP request timed out after 60000ms") === undefined);
check("does not add the guidance twice", result("TypeError: x\n\n" + mod.ROLLBACK_NOTE) === undefined);
check("tolerates a missing event", handlers.tool_result?.(undefined, {}) === undefined);

// Checks before sending.
const call = (code, toolName = "mcp__figma__use_figma") => handlers.tool_call?.({ toolName, input: { code } });
for (const api of ["loadAllPagesAsync", "setFileThumbnailNodeAsync", "setPluginData", "getPluginData", "setRangeOpenTypeFeatures"]) {
  const r = call(`const n = figma.currentPage;\nawait n.${api}(0, 1);\nreturn 'ok';`);
  check(`blocks unsupported ${api}`, r?.block === true && r.reason.startsWith("Blocked:") && r.reason.includes(api) && r.reason.includes("not supported"));
}
for (const ok of ["getSharedPluginData", "setSharedPluginData", "createImageAsync", "createAutoLayout", "getPluginDataKeys"]) {
  check(`allows ${ok}`, call(`return figma.root.${ok}('a', 'b');`) === undefined);
}
const syn = call("const cols = 1;\nconst cols = 2;\nreturn cols;");
check("blocks a script that does not parse, naming the problem and the line",
  syn?.block === true && syn.reason.startsWith("Blocked:") && /cols/.test(syn.reason) && /line 2\b/.test(syn.reason));
check("allows top-level await and return", call("const n = await figma.getNodeByIdAsync('1:2');\nreturn n ? n.id : null;") === undefined);
check("allows modern syntax", call("const { a = 1, ...rest } = { b: 2 };\nconst v = rest?.b ?? a;\nfor await (const x of [Promise.resolve(v)]) {}\nreturn `${v}`;") === undefined);
check("syntax check ignores non-Figma tools", call("const a = ;", "bash") === undefined);
check("base64 block still comes first", call("return figma.base64Encode(x)")?.reason === mod.REASON);

console.log(failed ? `${failed} error-guidance checks failed` : "all error-guidance checks passed");
process.exit(failed ? 1 : 0);
