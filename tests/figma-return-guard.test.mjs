// Tests for src/index.ts. Run:
//   npm test
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the journal away from the real ~/.pi/agent.
const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-guard-block-"));
process.env.PI_CODING_AGENT_DIR = journalDir;
process.on("exit", () => fs.rmSync(journalDir, { recursive: true, force: true }));

const guardPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const mod = await import(guardPath);

let handler;
mod.default({ on: (event, fn) => { if (event === "tool_call") handler = fn; } });

const b64 = "const b = await n.exportAsync(); return 'data:image/png;base64,' + figma.base64Encode(b);";
const cases = [
  // Blocked: base64 image returns in any Figma tool that runs code.
  ["mcp__figma__use_figma", { code: b64 }, true],
  ["mcp__figma_linux_next__use_figma", { code: b64 }, true],
  ["mcp__figma_desktop__use_figma", { code: b64 }, true],
  ["mcp__figma__use_figma_1a2b3c4d", { code: b64 }, true],
  ["mcp__figma__use_figma", { code: "return figma['base64Encode'](b)" }, true],
  ["mcp__figma__use_figma", { code: "return figma.base64Encode?.(b)" }, true],
  ["mcp__figma__use_figma", { code: "const enc = figma.base64Encode; return enc(b)" }, true],
  ["mcp__figma__use_figma", { code: "return btoa(String.fromCharCode(...b))" }, true],
  // Allowed.
  ["mcp__figma__use_figma", { code: "await n.screenshot({ scale: 0.5 }); return { ids: [n.id] };" }, false],
  ["mcp__figma__use_figma", { code: "const img = figma.createImage(figma.base64Decode(s)); return img.hash;" }, false],
  ["mcp__figma__get_screenshot", { nodeId: "1:2", fileKey: "x" }, false],
  ["mcp__figma__use_figma", {}, false],
  ["mcp__figma__use_figma", undefined, false],
  ["mcp__figma__use_figma", { code: 42 }, false],
  ["bash", { command: "echo figma.base64Encode(x)" }, false],
  ["codemode", { code: "await tools.mcp__figma__use_figma({ code: 'figma.base64Encode(b)' })" }, false],
  ["mcp__supabase__execute_sql", { code: "select base64Encode(x)" }, false],
];

let failed = 0;
for (const [toolName, input, wantBlock] of cases) {
  const result = handler({ toolName, input });
  const blocked = !!(result && result.block);
  const reasonOk = !blocked || (result.reason === mod.REASON && /node\.screenshot/.test(result.reason));
  if (blocked !== wantBlock || !reasonOk) {
    failed++;
    console.log(`FAIL ${toolName} ${JSON.stringify(input)?.slice(0, 70)} -> blocked=${blocked}, want ${wantBlock}`);
  }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
