// Blocks Figma MCP `use_figma` scripts that return images as base64.
// A use_figma return value over 48,000 bytes fails and discards every canvas
// edit of that run; base64 screenshots were the cause of every such failure.
// `await node.screenshot()` sends the image as a separate MCP image part that
// does not count toward the limit, so the guard points the agent there.
// It also tells the agent this up front, once per session, in a hidden
// message, whenever a Figma MCP server is configured.
// Tests: npm test
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  "image part (show it in codemode with `image(part)`). Or use the get_screenshot tool.";

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

export function check(toolName, input) {
  if (!FIGMA_TOOL.test(String(toolName ?? ""))) return undefined;
  if (typeof input?.code !== "string") return undefined;
  return BASE64.test(input.code) ? { block: true, reason: REASON } : undefined;
}

export default function (pi) {
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
  pi.on("session_start", () => {
    hinted = false;
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (hinted || !wantsHint(event, figmaConfigured(ctx?.cwd ?? process.cwd()))) return undefined;
    hinted = true;
    return { message: { customType: "figma-return-guard", content: HINT, display: false } };
  });
  pi.on("tool_call", (event) => check(event?.toolName, event?.input));
}
