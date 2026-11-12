// Tests for the system-prompt hint in src/index.ts. Run: npm test
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from the real ~/.pi/agent/mcp.json.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-guard-test-"));
const agentDir = path.join(dir, "agent");
const project = path.join(dir, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const mod = await import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

let tools = [];
let handler;
mod.default({ on: (event, fn) => { if (event === "before_agent_start") handler = fn; }, getAllTools: () => tools });

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log(`FAIL ${name}`); } };

check("registers a before_agent_start handler", typeof handler === "function");

const withFigma = "You are an agent.\n<mcp_servers>\n- mcp__figma (codemode): The official Figma MCP server.\n</mcp_servers>";
const r1 = handler?.({ systemPrompt: withFigma });
check("appends the hint when a Figma MCP server is in the prompt", r1?.systemPrompt === withFigma + "\n\n" + mod.HINT);
check("hint names node.screenshot and forbids base64", /node\.screenshot/.test(mod.HINT ?? "") && /base64/.test(mod.HINT ?? ""));

const local = "x\n- mcp__figma_linux_next (codemode): local";
check("also matches other Figma server names", handler?.({ systemPrompt: local })?.systemPrompt === local + "\n\n" + mod.HINT);

const noFigma = "You are an agent.\n<mcp_servers>\n- mcp__supabase (codemode): db\n</mcp_servers>";
check("leaves prompts without a Figma server unchanged", handler?.({ systemPrompt: noFigma }) === undefined);

const already = withFigma + "\n\n" + mod.HINT;
check("does not add the hint twice", handler?.({ systemPrompt: already }) === undefined);

check("tolerates a missing system prompt", handler?.({}) === undefined);

tools = [{ name: "read" }, { name: "mcp__figma__use_figma" }];
const plain = "You are an agent.";
check("appends the hint when a Figma MCP tool is registered, even if the prompt does not list it", handler?.({ systemPrompt: plain })?.systemPrompt === plain + "\n\n" + mod.HINT);
tools = [{ name: "read" }, { name: "mcp__supabase__execute_sql" }];
check("no hint when only non-Figma tools are registered", handler?.({ systemPrompt: plain }) === undefined);

// Figma configured in mcp.json, tools not connected yet (first prompt).
tools = [{ name: "read" }];
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { supabase: {} } }));
check("no hint when mcp.json has no Figma server", handler?.({ systemPrompt: plain }, { cwd: project }) === undefined);
fs.writeFileSync(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "figma-linux-next": {} } }));
check("hint when the project mcp.json has a Figma server", handler?.({ systemPrompt: plain }, { cwd: project })?.systemPrompt === plain + "\n\n" + mod.HINT);
fs.rmSync(path.join(project, ".pi", "mcp.json"));
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" } } }));
check("hint when the global mcp.json has a Figma server", handler?.({ systemPrompt: plain }, { cwd: project })?.systemPrompt === plain + "\n\n" + mod.HINT);
fs.writeFileSync(path.join(agentDir, "mcp.json"), "{ not json");
check("invalid mcp.json is ignored", handler?.({ systemPrompt: plain }, { cwd: project }) === undefined);
fs.rmSync(dir, { recursive: true, force: true });

console.log(failed ? `${failed} prompt-hint checks failed` : "all prompt-hint checks passed");
process.exit(failed ? 1 : 0);
