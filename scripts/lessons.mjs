// Lists learned lessons, and retires one by number.
//   npm run lessons                     list them, numbered
//   npm run lessons -- retire <n>       stop using lesson n, and never learn it again
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const lessons = await import(at("../src/lessons.ts"));
const journal = await import(at("../src/journal.ts"));
const [action, n] = process.argv.slice(2);

if (action === "retire") {
  const done = lessons.retireLesson(n);
  if (done === "missing") {
    console.error(`No lesson ${n}. Run \`npm run lessons\` to see the numbers.`);
    process.exit(1);
  }
  console.log(`Lesson ${n} ${done}.`);
} else if (action) {
  console.error("Usage: npm run lessons [-- retire <n>]");
  process.exit(1);
} else {
  const standing = new Map(lessons.standing(journal.readJournal().entries, lessons.readLessons()).map((s) => [s.class, s]));
  const list = lessons.numbered();
  if (!list.length) console.log("No lessons learned yet.");
  list.forEach((l, i) => {
    const s = standing.get(l.key);
    console.log(`${i + 1}. ${l.key}\n   ${s?.status ?? "learned"} - ${s?.sessions ?? 0} sessions since learned\n   ${l.lesson}`);
  });
}
