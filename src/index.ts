// Blocks Figma MCP `use_figma` scripts that return images as base64.
// A use_figma return value over 48,000 bytes fails and discards every canvas
// edit of that run; base64 screenshots were the cause of every such failure.
// `await node.screenshot()` sends the image as a separate MCP image part that
// does not count toward the limit, so the guard points the agent there.
// Tests: npm test
// @ts-nocheck

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

export function check(toolName, input) {
  if (!FIGMA_TOOL.test(String(toolName ?? ""))) return undefined;
  if (typeof input?.code !== "string") return undefined;
  return BASE64.test(input.code) ? { block: true, reason: REASON } : undefined;
}

export default function (pi) {
  pi.on("tool_call", (event) => check(event?.toolName, event?.input));
}
