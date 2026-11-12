// Tests for the up-front hint in src/index.ts. Run: npm test
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
const handlers = {};
mod.default({ on: (event, fn) => { handlers[event] = fn; }, getAllTools: () => tools });

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log(`FAIL ${name}`); } };
const newSession = () => handlers.session_start?.({}, {});
const prompt = (systemPrompt, ctx = { cwd: project }, messageType = "user") =>
  handlers.before_agent_start?.({ messageType, prompt: "hi", systemPrompt }, ctx);
const isHint = (r) => r?.message?.customType === "figma-return-guard" && r.message.content === mod.HINT && r.message.display === false;

check("registers before_agent_start and session_start handlers",
  typeof handlers.before_agent_start === "function" && typeof handlers.session_start === "function");
check("hint names node.screenshot and forbids base64", /node\.screenshot/.test(mod.HINT ?? "") && /base64/.test(mod.HINT ?? ""));

const withFigma = "You are an agent.\n<mcp_servers>\n- mcp__figma (codemode): The official Figma MCP server.\n</mcp_servers>";
const plain = "You are an agent.";

newSession();
check("injects the hint as a hidden message when a Figma MCP server is in the prompt", isHint(prompt(withFigma)));
check("injects it only once per session", prompt(withFigma) === undefined);
newSession();
check("injects it again in a new session", isHint(prompt(withFigma)));

newSession();
check("also matches other Figma server names", isHint(prompt("x\n- mcp__figma_linux_next (codemode): local")));

newSession();
check("nothing when no Figma server is in the prompt, tools or mcp.json", prompt(plain) === undefined);
check("skips runs started by custom messages", (newSession(), prompt(withFigma, undefined, "custom")) === undefined);
check("tolerates a missing event", (newSession(), handlers.before_agent_start?.(undefined, undefined)) === undefined);

newSession();
tools = [{ name: "read" }, { name: "mcp__figma__use_figma" }];
check("injects when a Figma MCP tool is registered, even if the prompt does not list it", isHint(prompt(plain)));
newSession();
tools = [{ name: "read" }, { name: "mcp__supabase__execute_sql" }];
check("nothing when only non-Figma tools are registered", prompt(plain) === undefined);

// Figma configured in mcp.json, tools not connected yet (first prompt).
tools = [{ name: "read" }];
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { supabase: {} } }));
newSession();
check("nothing when mcp.json has no Figma server", prompt(plain) === undefined);
fs.writeFileSync(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "figma-linux-next": {} } }));
newSession();
check("injects when the project mcp.json has a Figma server", isHint(prompt(plain)));
fs.rmSync(path.join(project, ".pi", "mcp.json"));
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" } } }));
newSession();
check("injects when the global mcp.json has a Figma server", isHint(prompt(plain)));
fs.writeFileSync(path.join(agentDir, "mcp.json"), "{ not json");
newSession();
check("invalid mcp.json is ignored", prompt(plain) === undefined);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} prompt-hint checks failed` : "all prompt-hint checks passed");
process.exit(failed ? 1 : 0);
