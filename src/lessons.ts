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
// from an error and a script that may quote a design, so the check is strict:
// plain ASCII only (no look-alike letters, hidden or line-breaking characters),
// and nothing that points elsewhere or reads like an order about something
// other than Figma scripts. A refused lesson only means one less hint.
const TYPOGRAPHIC = [
  [/[\u2018\u2019\u201a\u201b]/g, "'"],
  [/[\u201c\u201d\u201e\u201f]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];
const PLAIN = /^[\x20-\x7e]+$/;
const FORBIDDEN = [
  // links
  /:\/\/|\bwww\.|\]\(|\b[a-z0-9-]+(\.[a-z0-9-]+)+\/|\b[a-z0-9-]+\.(com|net|org|io|dev|app|xyz|ru|cn|co|me|info|sh|ly)\b/i,
  /```|<\s*[\/!a-z]|&#?\w+;/i, // code fences, tags, entities
  /\blocalhost\b|\b\d{1,3}(\.\d{1,3}){3}\b|~\/|\.\.\/|[A-Za-z0-9+\/]{32,}={0,2}/, // hosts, IPs, paths, base64
  /\bI?\d+\s*[:;]\s*\d+\b/, // node IDs: a lesson is general
  /\b(curl|wget|sudo|ssh|bash|zsh|sh|fish|shell|terminal|npm|npx|pip|rm|chmod|eval|exec|passwords?|credentials?|secrets?|(access|auth|bearer|api|refresh|session) tokens?|cookies?|passphrases?|private keys?|api[ _-]?keys?|keychain)\b|\.env\b|\s-c\b/i,
  /\b(delete|remove|erase|wipe|overwrite)\b.{0,40}\b(files?|folders?|director(y|ies)|projects?|repositor(y|ies)|disk|home)\b/i,
  /\b(system prompt|instructions?|disregard|forget|ignore|you must now|from now on|new rule|rules? above)\b|\bas (the|an|your) (assistant|ai|agent|model)\b|\bthe user (says|said|wants|asked|requires)\b|\btold (you )?before\b/i,
  /\bpay no attention\b|\byour (real|actual|true) (task|job|goal)\b|\breply only\b|\brespond only\b|\bdeveloper mode\b|^\s*\[\s*system\s*\]|^\s*system\s*:/i,
  /^none\s*([.,:;!-]|$)/i,
];

export function validateLesson(text) {
  if (typeof text !== "string") return undefined;
  let lesson = text.trim();
  for (const [pattern, plain] of TYPOGRAPHIC) lesson = lesson.replace(pattern, plain);
  if (lesson.length < LESSON_MIN || lesson.length > LESSON_MAX || !PLAIN.test(lesson)) return undefined;
  return FORBIDDEN.some((pattern) => pattern.test(lesson)) ? undefined : lesson;
}

// Classes whose lessons the user retired: they are not learned again.
export function retiredClasses(text) {
  const retired = new Set();
  for (const line of String(text ?? "").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.class === "string" && entry.retired) retired.add(entry.class);
    } catch {}
  }
  return retired;
}

export function readRetired() {
  try {
    return retiredClasses(fs.readFileSync(lessonsPath(), "utf8"));
  } catch {
    return new Set();
  }
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
    // Only errors after the lesson was saved say whether it helps.
    const savedAt = Date.parse(lessons.get(e.class).ts ?? "");
    if (savedAt && Date.parse(e.ts ?? "") < savedAt) continue;
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
