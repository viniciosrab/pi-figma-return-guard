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
// from an error and a script that may quote a design, so its form is checked:
// plain ASCII (no look-alike letters, hidden or line-breaking characters), no
// links, tags, entities, code fences or node IDs, and none of a few phrases no
// Figma rule needs. A keyword check cannot catch every rewording, so it is not
// the defense: lessons always reach the agent labeled as tips, and a lesson
// joins the session-start hint only after its error keeps repeating.
const TYPOGRAPHIC = [
  [/[\u2018\u2019\u201a\u201b]/g, "'"],
  [/[\u201c\u201d\u201e\u201f]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];
const PLAIN = /^[\x20-\x7e]+$/;
const FORBIDDEN = [
  /:\/\/|\bwww\.|\]\(/i, // links
  /```|<[\/!a-z]|<\s+[\/!]?[a-z][\w-]*\s*>|&#?\w+;/i, // code fences, tags, entities
  /\bI?\d+\s*[:;]\s*\d+\b/, // node IDs: a lesson is general
  /\b(curl|wget|sudo|ssh|passwords?|credentials?|secrets?|(access|auth|bearer|api|refresh) tokens?|cookies?|passphrases?|private keys?|api[ _-]?keys?|keychain)\b|\.env\b/i,
  /\b(system prompt|instructions?|disregard|forget|ignore|you must now|from now on|new rule|rules? above)\b|\bas (the|an|your) (assistant|ai|agent|model)\b|\bthe user (says|said|wants|asked|requires)\b|\btold (you )?before\b/i,
  /\bpay no attention\b|\byour (real|actual|true) (task|job|goal)\b|\breply only\b|\brespond only\b|\bdeveloper mode\b|^\s*\[\s*system\s*\]|^\s*system\s*:/i,
];

const plainText = (text) => TYPOGRAPHIC.reduce((t, [pattern, plain]) => t.replace(pattern, plain), String(text).trim());

// The reviewer's way of saying it found no clear rule: "NONE", alone or
// followed by punctuation. "None of ..." is a lesson.
export const isNone = (text) => typeof text === "string" && /^none\s*([.,:;!-]|$)/i.test(plainText(text));

export function validateLesson(text) {
  if (typeof text !== "string" || isNone(text)) return undefined;
  const lesson = plainText(text);
  if (lesson.length < LESSON_MIN || lesson.length > LESSON_MAX || !PLAIN.test(lesson)) return undefined;
  return FORBIDDEN.some((pattern) => pattern.test(lesson)) ? undefined : lesson;
}

// An error message that names no property, function or API ("cannot read
// property of undefined") has many unrelated causes, so its class alone does
// not say which mistake was made. A lesson for such an error is one known
// cause, tied to `when`: one to three names the failing script must use.
export const namesNothing = (cls) => /^[A-Za-z]*Error: [a-z][a-z ]*$/.test(String(cls ?? ""));

const NAME = /^[A-Za-z_$][\w$]{1,39}$/;
const uses = (text, name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(String(text ?? ""));

// Keeps the names that the lesson itself mentions, so they add nothing from
// the script to what is stored, and that `script` uses when it is given (the
// reviewer often also lists the name of the fix, which the script lacks).
export function validateWhen(names, lesson, script) {
  if (!Array.isArray(names)) return undefined;
  const when = [...new Set(names.map((n) => String(n).trim().replace(/^[.`]+/, "").replace(/[`()]+$/, "")))]
    .filter((n) => NAME.test(n) && uses(lesson, n) && (script === undefined || uses(script, n)))
    .sort();
  return when.length >= 1 && when.length <= 3 ? when : undefined;
}

// What identifies a lesson: its error class, plus its names for a vague error.
export const lessonKey = (cls, when) => (Array.isArray(when) && when.length ? `${cls} [${when.join(", ")}]` : cls);

// The lessons for an error in a script: the one of its class or, for an error
// that names nothing, those whose names the script uses, the latest first.
export function lessonsFor(lessons, cls, script) {
  if (!namesNothing(cls)) return lessons.has(cls) ? [lessons.get(cls)] : [];
  return [...lessons.values()].filter((l) => l.class === cls && l.when?.every((n) => uses(script, n))).reverse();
}

// Keys of the lessons the user retired: they are not learned again.
export function retiredClasses(text) {
  const retired = new Set();
  for (const line of String(text ?? "").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.class === "string" && entry.retired) retired.add(lessonKey(entry.class, entry.when));
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

// Lesson key -> its latest valid lesson. A line with `retired: true` removes
// the lesson; corrupt and invalid lines are skipped, and so is a lesson for a
// vague error that has no valid names.
export function parseLessons(text) {
  const lessons = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.class !== "string") continue;
      if (entry.retired) {
        lessons.delete(lessonKey(entry.class, entry.when));
        continue;
      }
      // Approval lines written by older versions; lessons need none now.
      if ("approved" in entry) continue;
      const lesson = validateLesson(entry.lesson);
      if (!lesson) continue;
      const when = namesNothing(entry.class) ? validateWhen(entry.when, lesson) : undefined;
      if (namesNothing(entry.class) && !when) continue;
      const key = lessonKey(entry.class, when);
      lessons.set(key, { ...entry, key, lesson, when });
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

// The lessons in the order `npm run lessons` numbers them.
export const numbered = () => [...readLessons().values()];

// Approves or retires lesson number `n` (1-based). Returns what happened.
function mark(n, entry) {
  const lesson = numbered()[Number(n) - 1];
  if (!lesson) return "missing";
  appendLine(lessonsPath(), { v: 1, ts: new Date().toISOString(), class: lesson.class, ...(lesson.when ? { when: lesson.when } : {}), ...entry(lesson) });
  return "ok";
}
export const retireLesson = (n) => (mark(n, () => ({ retired: true })) === "ok" ? "retired" : "missing");

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

// A lesson joins the session-start hint by itself once its error has happened
// in this many sessions, and leaves it when the error happens in this many
// more: the line is then not preventing it. The volumes are too small for
// statistics.
export const PROMOTE_AT = 3;
export const DROP_AFTER = 3;
const HINT_MAX_LESSONS = 8;
const HINT_MAX_CHARS = 1200;

// Each lesson with its number, how often its error happened and where it
// stands: "learned" (shown when the error happens), "hint" (also told up front) or
// "dropped" (was told up front and did not prevent the error).
export function standing(entries, lessons) {
  const sessions = new Map();
  const counts = new Map();
  const add = (map, key, value) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(value);
  for (const e of entries ?? []) {
    if (e?.kind !== "result" || e.ok) continue;
    // A vague error counts toward the lessons that were shown for it.
    for (const key of Array.isArray(e.lessons) ? e.lessons : [e.class]) {
      const lesson = lessons.get(key);
      if (!lesson) continue;
      const at = Date.parse(e.ts ?? "");
      // Only errors after the lesson was saved say whether it helps.
      const savedAt = Date.parse(lesson.ts ?? "");
      if (savedAt && at < savedAt) continue;
      add(sessions, key, e.session);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // `class` is the lesson's key: the error class, with the names for a vague one.
  return [...lessons.entries()]
    .map(([key, l], i) => {
      const n = sessions.get(key)?.size ?? 0;
      // Sessions past the one that put the lesson in the hint.
      const since = Math.max(0, n - PROMOTE_AT);
      const status = n < PROMOTE_AT ? "learned" : since < DROP_AFTER ? "hint" : "dropped";
      return { number: i + 1, class: key, lesson: l.lesson, sessions: n, count: counts.get(key) ?? 0, status };
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
