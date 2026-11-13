// Blocks Figma MCP `use_figma` scripts that return images as base64.
// A use_figma return value over 48,000 bytes fails and discards every canvas
// edit of that run; base64 screenshots were the cause of every such failure.
// `await node.screenshot()` sends the image as a separate MCP image part that
// does not count toward the limit, so the guard points the agent there.
// It also tells the agent this up front, once per session, in a hidden
// message, whenever a Figma MCP server is configured.
// It also fixes, before sending, script mistakes that have a fix with the same
// meaning, blocks scripts that cannot work, and adds the likely cause and fix
// to failed results.
// Tests: npm test
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeError, readJournal, record } from "./journal.ts";
import { hintLessons, learningOn, readLessons } from "./lessons.ts";

// Any tool of a Figma MCP server (figma, figma-linux-next, figma-desktop, hash
// suffixes) that takes a `code` script; get_screenshot has no `code` and passes.
const FIGMA_TOOL = /^mcp__[A-Za-z0-9_]*figma[A-Za-z0-9_]*__/i;
const BASE64 = /\bbase64Encode\b|\bbtoa\s*\(/;

export const REASON =
  "Blocked: this Figma script encodes data as base64 (base64Encode or btoa). A use_figma return value over 48,000 bytes fails " +
  "and discards every canvas edit of the run, and base64 images exceed it. Do not export images as base64 or data " +
  "URLs. Inside the script call `await node.screenshot({ scale })`; the image comes back as a separate image part " +
  "of the result that does not count toward the limit. Return only IDs or 'ok', then show the image in codemode " +
  "with `image(result.content.find(p => p.type === 'image'))`. Or call the Figma MCP get_screenshot tool, which returns a URL.";

// Told to the agent up front, so its first script is already right and the
// block above stays a safety net.
export const HINT =
  "Figma MCP scripts (use_figma): never return images as base64 or data URLs (`exportAsync` + `figma.base64Encode` or " +
  "`btoa`); a return over 48,000 bytes fails and discards the run's canvas edits. To see a frame, call " +
  "`await node.screenshot({ scale })` inside the script and return only IDs or 'ok'; the image arrives as a separate " +
  "image part (show it in codemode with `image(part)`). Or use the get_screenshot tool. When looking layers up by " +
  "name, filter by type too (`n.type === 'FRAME' && n.name === '...'`): section titles are often TEXT layers named " +
  "like their FRAME. Look nodes up again after `remove()` or `detachInstance()` instead of reusing earlier references " +
  "or IDs. A failed run discards all of its canvas edits.";

const FIGMA_SERVER = /mcp__[A-Za-z0-9_]*figma/i;

// `figmaConfigured` reports whether any Figma MCP tool exists; the prompt's
// mcp_servers list is not always part of the system prompt the hook sees.
// Whether the hint belongs in this run: a user prompt in a session that has a
// Figma MCP server (listed in the prompt, registered as tools, or configured).
export function wantsHint(event, figmaConfigured = false) {
  if (event?.messageType !== "user") return false;
  const prompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
  return figmaConfigured || FIGMA_SERVER.test(prompt);
}

// Names of the MCP servers in the global and project mcp.json files.
export function configuredServerNames(cwd, home = os.homedir()) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const files = [path.join(agentDir, "mcp.json")];
  if (cwd) files.push(path.join(cwd, ".pi", "mcp.json"));
  const names = [];
  for (const file of files) {
    try {
      names.push(...Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers ?? {}));
    } catch {}
  }
  return names;
}

// APIs the use_figma runtime rejects (each reproduced) that have no
// replacement doing the same thing, with what to do instead.
const UNSUPPORTED = {
  setFileThumbnailNodeAsync: "The file thumbnail cannot be set from a script; ask the user to set it in Figma.",
  setRangeOpenTypeFeatures: "OpenType features cannot be set from a script; leave them out or ask the user.",
};
const UNSUPPORTED_CALL = new RegExp(`\\.\\s*(${Object.keys(UNSUPPORTED).join("|")})\\s*\\(`);

// Rejected APIs that have an equivalent, replaced before the script is sent.
// Private plugin data is unavailable in this runtime, so every value the agent
// reads was written through the same replacement, in the same namespace.
const NAMESPACE = "piagent";
const REPLACEMENTS = [
  [/\bfigma\.loadAllPagesAsync\(\s*\)/g, "(async () => { for (const __page of figma.root.children) await __page.loadAsync(); })()", "loadAllPagesAsync"],
  [/\.setPluginData\(/g, `.setSharedPluginData('${NAMESPACE}', `, "pluginData"],
  [/\.getPluginData\(/g, `.getSharedPluginData('${NAMESPACE}', `, "pluginData"],
];

// The script's first syntax error and its line, or undefined when it parses.
// It is only compiled, never run.
function parseError(code) {
  try {
    new vm.Script(`(async () => {\n${code}\n})`, { filename: "figma-script" });
    return undefined;
  } catch (error) {
    if (error?.name !== "SyntaxError") return undefined;
    const line = /figma-script:(\d+)/.exec(String(error.stack))?.[1];
    return { message: String(error.message), line: line ? Number(line) - 1 : undefined };
  }
}

export function syntaxError(code) {
  const error = parseError(code);
  return error && `${error.message}${error.line ? ` (line ${error.line})` : ""}`;
}

// A name declared twice, usually after joining stored helper code with new
// code. Wrapping everything from the second declaration to the end in a block
// keeps what the agent meant: code before it, helpers included, keeps the first
// binding, and code after it sees the new one.
const REDECLARED = /declare a (const|let) variable twice|has already been declared|redefinition of lexical/i;

export function fixRedeclarations(code) {
  let fixed = code;
  for (let i = 0; i < 10; i++) {
    const error = parseError(fixed);
    if (!error) return fixed;
    const lines = fixed.split("\n");
    if (!REDECLARED.test(error.message) || !error.line || error.line > lines.length) return code;
    lines.splice(error.line - 1, 0, "{");
    fixed = `${lines.join("\n")}\n}`;
  }
  return parseError(fixed) ? code : fixed;
}

// Blocks what cannot work, and silently fixes what can be fixed without
// changing what the script does, so the agent never sees those errors.
// What the pre-send check did: the tool_call result, and for the journal the
// kind of block and the silent fixes applied.
function inspect(toolName, input) {
  const none = { result: undefined, blocked: undefined, fixes: [] };
  if (!FIGMA_TOOL.test(String(toolName ?? ""))) return none;
  if (typeof input?.code !== "string") return none;
  if (BASE64.test(input.code)) return { ...none, result: { block: true, reason: REASON }, blocked: "base64" };
  const api = UNSUPPORTED_CALL.exec(input.code)?.[1];
  if (api) {
    return {
      ...none,
      blocked: `unsupported:${api}`,
      result: {
        block: true,
        reason: `Blocked: \`${api}\` is not supported in use_figma scripts; Figma rejects it and discards the run's canvas edits. ${UNSUPPORTED[api]}`,
      },
    };
  }
  const fixes = new Set();
  let code = input.code;
  for (const [pattern, replacement, fix] of REPLACEMENTS) {
    const next = code.replace(pattern, replacement);
    if (next !== code) fixes.add(fix);
    code = next;
  }
  const fixed = fixRedeclarations(code);
  if (fixed !== code) fixes.add("redeclaration");
  if (fixed !== input.code) input.code = fixed;
  const syntax = syntaxError(input.code);
  if (syntax) {
    return {
      blocked: "syntax",
      fixes: [...fixes],
      result: {
        block: true,
        reason:
          `Blocked: this Figma script does not parse (SyntaxError: ${syntax}), so nothing was sent to Figma. ` +
          "When joining helper snippets, wrap each block in `{ }` or rename duplicate `const` names.",
      },
    };
  }
  return { ...none, fixes: [...fixes] };
}

export function check(toolName, input) {
  return inspect(toolName, input).result;
}

// Added to failed Figma script results so the agent fixes the actual cause on
// its next try. Each matches an error reproduced in Figma.
const MARK = "[figma-return-guard]";

export const ROLLBACK_NOTE =
  `${MARK} This run failed, so Figma discarded all of its canvas edits: nothing it created or changed is on the ` +
  "canvas, and IDs it created do not exist. Fix the script and run it again in full; do not clean up or delete " +
  "anything because of this failure.";

export const LOOKUP_GUIDANCE =
  `${MARK} A lookup returned nothing or the wrong kind of node, or the property does not exist on that node type. ` +
  "Section titles are often TEXT layers named like their FRAME, so filter by type: " +
  "`findOne(n => n.type === 'FRAME' && n.name === '...')`, with parentheses around each `||` alternative. Check the " +
  "result (and `'prop' in node`) before using it. Inside instances, hidden layers are skipped unless the script sets " +
  "`figma.skipInvisibleInstanceChildren = false` first.";

export const MISSING_NODE_GUIDANCE =
  `${MARK} The script used a node that no longer exists. Usual causes: it was removed earlier in the same script ` +
  "(`remove()`, a removed parent, a helper that replaces a node by name, a connector removed with its shape); a " +
  "`detachInstance()` replaced the instance's layers, so earlier references and IDs inside it (IDs starting with " +
  "'I') are gone; or the ID came from an earlier failed run. Look nodes up again after `remove()` or " +
  "`detachInstance()` instead of reusing references or IDs.";

export const UNSUPPORTED_GUIDANCE =
  `${MARK} This API is not available in use_figma scripts. Do not retry it; use the alternative Figma's message ` +
  "suggests, or another approach (for example `setSharedPluginData` instead of `setPluginData`, or " +
  "`figma.createFrame()` with `layoutMode` instead of `createAutoLayout`).";

export const INSTANCE_GUIDANCE =
  `${MARK} This layer is inside an instance (its ID starts with 'I'), where position, size and structure are locked: ` +
  "layers cannot be added, moved or removed there. " +
  "Change it in the main component, through the instance's component properties (`setProperties`), or detach the " +
  "instance first (`detachInstance()`, then look its layers up again).";

export const SELECTOR_GUIDANCE =
  `${MARK} Quote attribute values in \`query()\` selectors when they have spaces or non-ASCII characters: ` +
  '`FRAME[name^="Botão"]`, not `FRAME[name^=Botão]`.';

export const NAN_GUIDANCE =
  `${MARK} A computed value is NaN. Check the helper that built it, for example a hex color helper given a 3-digit ` +
  "color such as '#555' (write '#555555').";

export const COMPONENT_REF_GUIDANCE =
  `${MARK} \`componentPropertyReferences\` works only on layers already inside a component. Append the layer to the ` +
  "component first, then set the references.";

export const SYNTAX_GUIDANCE =
  `${MARK} The script does not parse. A common cause is a \`const\` declared twice after joining helper snippets; ` +
  "wrap each block in `{ }` or rename the duplicate.";

// Most specific first.
const ADVICE = [
  [/The node with id "[^"]+" does not exist/, MISSING_NODE_GUIDANCE, "missing-node"],
  [/cannot be overridden in an instance|is an instance or is inside of an instance/, INSTANCE_GUIDANCE, "instance"],
  [/Invalid selector/, SELECTOR_GUIDANCE, "selector"],
  [/failed validation: Expected number, received nan/i, NAN_GUIDANCE, "nan"],
  [/Can only set component property references/, COMPONENT_REF_GUIDANCE, "component-ref"],
  [/is not a supported API|is not supported in this host runtime|\bfigma\.[\w.]+ is not a function|not implemented/, UNSUPPORTED_GUIDANCE, "unsupported"],
  [/^SyntaxError\b/m, SYNTAX_GUIDANCE, "syntax"],
  [/no such property '[^']+' on [A-Z_]+ node|cannot (read|set) property '[^']+' of (undefined|null)/, LOOKUP_GUIDANCE, "lookup"],
];

// Errors raised by a script that ran in Figma. Argument validation errors,
// timeouts (the run may still finish) and blocked calls never ran there.
const SCRIPT_ERROR = /PLUGIN_\d+_SOURCE|^(Type|Syntax|Reference|Range)Error\b|^Error: in \w+:/m;
const NOT_A_SCRIPT_ERROR = /^Blocked:|48000-byte limit|timed out|Validation failed for tool/m;

// The script line an error points at, cut around the column when it is long.
function failingLine(text, code) {
  const m = /PLUGIN_\d+_SOURCE:(\d+):(\d+)/.exec(text);
  if (!m || typeof code !== "string") return undefined;
  const lines = code.split("\n");
  const n = Number(m[1]);
  if (n < 1 || n > lines.length) return undefined;
  let line = lines[n - 1].trim();
  if (line.length > 240) {
    const col = Number(m[2]);
    const raw = lines[n - 1];
    line = `…${raw.slice(Math.max(0, col - 120), col + 120)}…`;
  }
  return `${MARK} The error is on line ${n}: ${line}`;
}

const textOf = (content) => (Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text : "")).join("\n") : "");
const isScriptError = (text) => !text.includes(MARK) && !NOT_A_SCRIPT_ERROR.test(text) && SCRIPT_ERROR.test(text);

// The script line number an error points at, when it is inside the script.
function errorLine(text, code) {
  const n = Number(/PLUGIN_\d+_SOURCE:(\d+):\d+/.exec(text)?.[1]);
  return typeof code === "string" && n >= 1 && n <= code.split("\n").length ? n : null;
}

// Put before a lesson the background reviewer learned from an earlier failure.
export const LEARNED_NOTE = `${MARK} Learned from an earlier failure with this same error (check that it applies here):`;

// What the extension knows about a failed Figma script: its error class and
// the advice for it, built in or learned. Undefined when the result is not a
// script error.
function analyze(toolName, isError, content) {
  if (!isError || !FIGMA_TOOL.test(String(toolName ?? "")) || !Array.isArray(content)) return undefined;
  const text = textOf(content);
  if (!isScriptError(text)) return undefined;
  const cls = normalizeError(text);
  const builtin = ADVICE.find(([pattern]) => pattern.test(text));
  if (builtin) return { text, class: cls, key: builtin[2], advice: builtin[1] };
  const lesson = readLessons().get(cls)?.lesson;
  return lesson
    ? { text, class: cls, key: "learned", advice: `${LEARNED_NOTE} ${lesson}` }
    : { text, class: cls, key: "none", advice: undefined };
}

function advise(info, content, code) {
  const notes = [failingLine(info.text, code), info.advice, ROLLBACK_NOTE].filter(Boolean).join("\n\n");
  // Into the error's own text part, so scripts that read only that part see it.
  const at = content.findIndex((p) => p?.type === "text" && SCRIPT_ERROR.test(p.text));
  return { content: content.map((p, i) => (i === at ? { ...p, text: `${p.text}\n\n${notes}` } : p)) };
}

export function guidance(toolName, isError, content, code) {
  const info = analyze(toolName, isError, content);
  return info && advise(info, content, code);
}

// One journal entry per Figma script result; never the code or the error text.
function journalResult(event, session, info) {
  const tool = event?.toolName;
  const code = event?.input?.code;
  if (!FIGMA_TOOL.test(String(tool ?? "")) || typeof code !== "string") return;
  const text = textOf(event?.content);
  if (/^Blocked:/.test(text.trim())) return; // already journaled by tool_call
  const ok = !event?.isError;
  record({
    kind: "result",
    session,
    tool,
    ok,
    class: ok ? null : normalizeError(text),
    line: info ? errorLine(text, code) : null,
    advice: info ? info.key : null,
    scriptError: Boolean(info),
  });
}

// What the agent wrote (text and thinking) after a moment in the turn.
function notesSince(ctx, at) {
  try {
    const out = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      const m = entry?.message;
      if (entry?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      if ((Date.parse(entry.timestamp) || Number(m.timestamp) || 0) < at) continue;
      for (const part of m.content) {
        if (part?.type === "text" && part.text) out.push(part.text);
        if (part?.type === "thinking" && part.thinking) out.push(part.thinking);
      }
    }
    return out.join("\n").slice(0, 3000);
  } catch {
    return "";
  }
}

// Starts the background reviewer (scripts/learn.mjs) on one episode and does
// not wait for it. The episode goes through an already-unlinked file: it never
// stays on disk, and it survives Pi exiting right after this (`pi -p`).
function launchLearner(episode) {
  const script = fileURLToPath(new URL("../scripts/learn.mjs", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-guard-learn-"));
  const file = path.join(dir, "episode.json");
  let fd;
  try {
    fs.writeFileSync(file, JSON.stringify(episode), { mode: 0o600 });
    fd = fs.openSync(file, "r");
  } finally {
    // The episode never stays on disk, even when writing or opening it failed.
    fs.rmSync(dir, { recursive: true, force: true });
  }
  try {
    const node = process.env.FIGMA_GUARD_NODE || "node";
    const child = spawn(node, ["--experimental-strip-types", "--no-warnings", script], { detached: true, stdio: [fd, "ignore", "ignore"] });
    child.on("error", () => {});
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

// Lessons whose errors keep repeating across sessions, for the hint.
function learnedHint() {
  try {
    const lessons = readLessons();
    if (!lessons.size) return "";
    const list = hintLessons(readJournal().entries, lessons);
    if (!list.length) return "";
    return ` Learned from errors that kept repeating in earlier sessions: ${list.map((l, i) => `(${i + 1}) ${l}`).join(" ")}`;
  } catch {
    return "";
  }
}

const MAX_EPISODES = 3;
const MAX_AFTER = 3;

export default createExtension();

export function createExtension({ launch = launchLearner } = {}) {
  return (pi) => extension(pi, launch);
}

function extension(pi, launch) {
  // MCP servers connect in the background, so on the first prompt their tools
  // may not be registered yet; the configured server names are known already.
  const figmaConfigured = (cwd) => {
    try {
      if ((pi.getAllTools?.() ?? []).some((t) => FIGMA_TOOL.test(String(t?.name ?? "")))) return true;
    } catch {}
    return configuredServerNames(cwd).some((name) => /figma/i.test(name));
  };
  // The hint goes in as a hidden conversation message, once per session: every
  // provider receives it, including ones (such as claude-bridge) that rebuild
  // the system prompt and drop prompt changes made by extensions.
  let hinted = false;
  let session = crypto.randomUUID?.() ?? String(Date.now());
  // Errors of the current turn that have no advice yet, held in memory until
  // the turn ends. If the agent got past one, the background reviewer may
  // learn a lesson from it; nothing here reaches the agent's session.
  let episodes = [];
  const track = (event, info) => {
    const tool = event?.toolName;
    const code = event?.input?.code;
    if (!FIGMA_TOOL.test(String(tool ?? "")) || typeof code !== "string") return;
    const ok = !event?.isError;
    const text = textOf(event?.content).split(MARK)[0].trim();
    if (/^Blocked:/.test(text)) return;
    for (const episode of episodes) {
      if (ok) episode.recovered = true;
      if (episode.after.length < MAX_AFTER) {
        episode.after.push({ code: code.slice(0, 6000), outcome: ok ? "ok" : `failed: ${normalizeError(text)}` });
      }
    }
    if (ok || info?.key !== "none") return;
    if (episodes.length >= MAX_EPISODES || episodes.some((e) => e.class === info.class) || !learningOn()) return;
    episodes.push({ class: info.class, error: text.slice(0, 800), failing: code.slice(0, 12000), at: Date.now(), after: [], recovered: false });
  };
  pi.on("session_start", () => {
    hinted = false;
    episodes = [];
    try {
      session = crypto.randomUUID();
    } catch {}
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (hinted || !wantsHint(event, figmaConfigured(ctx?.cwd ?? process.cwd()))) return undefined;
    hinted = true;
    return { message: { customType: "figma-return-guard", content: HINT + learnedHint(), display: false } };
  });
  pi.on("agent_settled", (event, ctx) => {
    const done = episodes;
    episodes = [];
    if (event?.aborted) return;
    for (const episode of done) {
      if (!episode.recovered) continue;
      try {
        const { class: cls, error, failing, after, at } = episode;
        launch({ class: cls, error, failing, notes: notesSince(ctx, at), after });
      } catch {}
    }
  });
  pi.on("tool_call", (event) => {
    const { result, blocked, fixes } = inspect(event?.toolName, event?.input);
    const tool = event?.toolName;
    if (blocked) record({ kind: "blocked", session, tool, reason: blocked });
    if (fixes.length) record({ kind: "fixed", session, tool, fixes });
    return result;
  });
  pi.on("tool_result", (event) => {
    const info = analyze(event?.toolName, event?.isError, event?.content);
    try {
      journalResult(event, session, info);
    } catch {}
    try {
      track(event, info);
    } catch {}
    return info && advise(info, event.content, event.input?.code);
  });
}
