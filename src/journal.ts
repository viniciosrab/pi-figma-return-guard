// Local journal of Figma script calls, and the report built from it.
// One JSON line per script result, block or silent fix, appended to
// <agentDir>/figma-return-guard/journal.jsonl. It never stores script code,
// failing lines or full error texts, and it never rewrites the file: several
// Pi sessions can append at once. Journaling can never fail a tool call.
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_LINE_BYTES = 4000; // under PIPE_BUF, so concurrent appends stay whole
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function journalPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "figma-return-guard", "journal.jsonl");
}

export function record(entry) {
  try {
    const line = `${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...entry })}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
    const file = journalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
    } catch {}
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {}
}

const NOISE = /^(at\s|Figma Debug UUID|Script (completed|failed)|Script error:|Wall time|Output:)/;
const NODE_ID = /I?\d+:\d+(?:;\d+:\d+)*/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// The first meaningful line of an error, without IDs, numbers or names from
// the design, so the same mistake always gets the same class.
export function normalizeError(text) {
  const first = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !NOISE.test(l)) ?? "";
  return first
    .replace(/(["'])((?:(?!\1).)*)\1/g, (_, q, inner) =>
      IDENTIFIER.test(inner) ? `${q}${inner}${q}` : NODE_ID.test(inner) && inner.replace(new RegExp(NODE_ID.source, "g"), "") === "" ? `${q}<id>${q}` : `${q}<s>${q}`)
    .replace(new RegExp(NODE_ID.source, "g"), "<id>")
    .replace(/(?<![\w$])\d+(\.\d+)?(?![xX\d])/g, "<n>")
    .slice(0, 200);
}

export function parseJournal(text) {
  const entries = [];
  let corrupt = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object") entries.push(entry);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { entries, corrupt };
}

// Totals, plus per error class: how often, in how many sessions, how often the
// agent recovered in the same session, and how many calls that took.
export function summarize(entries) {
  const results = entries.filter((e) => e?.kind === "result");
  const blocked = {};
  const fixed = {};
  for (const e of entries) {
    if (e?.kind === "blocked") blocked[e.reason] = (blocked[e.reason] ?? 0) + 1;
    if (e?.kind === "fixed") for (const f of e.fixes ?? []) fixed[f] = (fixed[f] ?? 0) + 1;
  }
  const bySession = new Map();
  for (const e of results) {
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const classes = new Map();
  for (const list of bySession.values()) {
    list.forEach((e, i) => {
      if (e.ok) return;
      const key = e.class ?? "(no message)";
      const c = classes.get(key) ?? { class: key, count: 0, sessions: new Set(), recovered: 0, extraCalls: 0, covered: true };
      c.count++;
      c.sessions.add(e.session);
      if (e.advice === "none") c.covered = false;
      const next = list.findIndex((later, j) => j > i && later.ok);
      if (next > i) {
        c.recovered++;
        c.extraCalls += next - i;
      }
      classes.set(key, c);
    });
  }
  const sorted = [...classes.values()]
    .map((c) => ({ ...c, sessions: c.sessions.size }))
    .sort((x, y) => Number(x.covered) - Number(y.covered) || y.count - x.count);
  const errors = results.filter((e) => !e.ok).length;
  return { calls: results.length, errors, errorRate: results.length ? errors / results.length : 0, blocked, fixed, classes: sorted };
}

export function formatReport(summary) {
  const pct = (summary.errorRate * 100).toFixed(1);
  const kinds = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const row = (c) => `  ${String(c.count).padStart(4)}  ${String(c.sessions).padStart(8)}  ${String(c.recovered).padStart(9)}  ${String(c.extraCalls).padStart(11)}  ${c.class}`;
  const header = "  count  sessions  recovered  extra calls  error";
  const out = [
    `Figma script calls: ${summary.calls}`,
    `Errors: ${summary.errors} (${pct}%)`,
    `Blocked before sending: ${kinds(summary.blocked)}`,
    `Fixed silently before sending: ${kinds(summary.fixed)}`,
  ];
  if (summary.corrupt) out.push(`Corrupt lines skipped: ${summary.corrupt}`);
  const notCovered = summary.classes.filter((c) => !c.covered);
  const covered = summary.classes.filter((c) => c.covered);
  if (notCovered.length) out.push("", "Not covered yet (the agent got no specific advice):", header, ...notCovered.map(row));
  if (covered.length) out.push("", "Covered:", header, ...covered.map(row));
  return out.join("\n");
}

export function readJournal() {
  const file = journalPath();
  let text = "";
  for (const f of [file.replace(/\.jsonl$/, ".1.jsonl"), file]) {
    try {
      text += `${fs.readFileSync(f, "utf8")}\n`;
    } catch {}
  }
  return parseJournal(text);
}
