// Lessons learned from Figma script errors: one JSON line per lesson in
// <agentDir>/figma-return-guard/lessons.jsonl. The background reviewer
// (src/learn.ts) writes them; the extension reads them when the same error
// happens again. A lesson is model-written text that future agents will read,
// so it is checked when written and again every time it is read.
// @ts-nocheck

import fs from "node:fs";
import path from "node:path";
import { journalPath } from "./journal.ts";

export const dataDir = () => path.dirname(journalPath());
export const lessonsPath = () => path.join(dataDir(), "lessons.jsonl");

const LESSON_MIN = 30;
export const LESSON_MAX = 400;

// A lesson is one plain sentence about Figma scripts. The reviewer writes it
// from an error and a script that may quote a design, so anything that points
// elsewhere or reads like an order about something else is refused.
const FORBIDDEN = [
  /[\u0000-\u001f\u007f]/, // new lines and other control characters
  /:\/\/|\bwww\./i, // links
  /```|<\/?[a-z!]/i, // code fences and tags
  /\bI?\d+:\d+\b/, // node IDs: a lesson is general
  /\b(curl|wget|sudo|ssh|bash|shell|terminal|npm|pip|passwords?|credentials?|secrets?|api[ _-]?keys?)\b|\.env\b/i,
  /\bsystem prompt\b|\b(previous|prior|above|earlier) instructions?\b|\bignore (all|any|the|previous|prior)\b/i,
];

export function validateLesson(text) {
  if (typeof text !== "string") return undefined;
  const lesson = text.trim();
  if (lesson.length < LESSON_MIN || lesson.length > LESSON_MAX) return undefined;
  return FORBIDDEN.some((pattern) => pattern.test(lesson)) ? undefined : lesson;
}

// Error class -> its latest valid lesson. A line with `retired: true` removes
// the class; corrupt and invalid lines are skipped.
export function parseLessons(text) {
  const lessons = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.class !== "string") continue;
      if (entry.retired) {
        lessons.delete(entry.class);
        continue;
      }
      const lesson = validateLesson(entry.lesson);
      if (lesson) lessons.set(entry.class, { ...entry, lesson });
    } catch {}
  }
  return lessons;
}

export function readLessons() {
  try {
    return parseLessons(fs.readFileSync(lessonsPath(), "utf8"));
  } catch {
    return new Map();
  }
}

export function appendLine(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Learning is on unless FIGMA_GUARD_LEARN=off or the file learn.mode says off.
// Lessons already learned keep being used either way.
export function learningOn() {
  if (/^(off|0|false|no)$/i.test(process.env.FIGMA_GUARD_LEARN ?? "")) return false;
  try {
    return fs.readFileSync(path.join(dataDir(), "learn.mode"), "utf8").trim().toLowerCase() !== "off";
  } catch {
    return true;
  }
}

// A lesson joins the session-start hint once its error has happened in this
// many sessions, and leaves it when the error happens in this many more: the
// line is then not preventing it. The volumes are too small for statistics.
export const PROMOTE_AT = 3;
export const DROP_AFTER = 3;
const HINT_MAX_LESSONS = 8;
const HINT_MAX_CHARS = 1200;

// Each lesson with how often its error happened and where it stands:
// "learned" (shown when the error happens), "hint" (also told up front) or
// "dropped" (was told up front and did not prevent the error).
export function standing(entries, lessons) {
  const sessions = new Map();
  const counts = new Map();
  for (const e of entries ?? []) {
    if (e?.kind !== "result" || e.ok || !lessons.has(e.class)) continue;
    if (!sessions.has(e.class)) sessions.set(e.class, new Set());
    sessions.get(e.class).add(e.session);
    counts.set(e.class, (counts.get(e.class) ?? 0) + 1);
  }
  return [...lessons.values()]
    .map((l) => {
      const n = sessions.get(l.class)?.size ?? 0;
      const status = n < PROMOTE_AT ? "learned" : n < PROMOTE_AT + DROP_AFTER ? "hint" : "dropped";
      return { class: l.class, lesson: l.lesson, sessions: n, count: counts.get(l.class) ?? 0, status };
    })
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count);
}

export function hintLessons(entries, lessons) {
  const out = [];
  let chars = 0;
  for (const s of standing(entries, lessons)) {
    if (s.status !== "hint") continue;
    if (out.length >= HINT_MAX_LESSONS || chars + s.lesson.length > HINT_MAX_CHARS) break;
    out.push(s.lesson);
    chars += s.lesson.length;
  }
  return out;
}
