// Lists learned lessons, and approves or retires one by number.
//   npm run lessons                     list them, numbered
//   npm run lessons -- approve <n>      let lesson n join the session-start hint
//   npm run lessons -- retire <n>       stop using lesson n, and never learn it again
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const lessons = await import(at("../src/lessons.ts"));
const journal = await import(at("../src/journal.ts"));
const [action, n] = process.argv.slice(2);

if (action === "approve" || action === "retire") {
  const done = action === "approve" ? lessons.approveLesson(n) : lessons.retireLesson(n);
  if (done === "missing") {
    console.error(`No lesson ${n}. Run \`npm run lessons\` to see the numbers.`);
    process.exit(1);
  }
  console.log(`Lesson ${n} ${done}.`);
} else if (action) {
  console.error("Usage: npm run lessons [-- approve <n> | -- retire <n>]");
  process.exit(1);
} else {
  const standing = new Map(lessons.standing(journal.readJournal().entries, lessons.readLessons()).map((s) => [s.class, s]));
  const list = lessons.numbered();
  if (!list.length) console.log("No lessons learned yet.");
  list.forEach((l, i) => {
    const s = standing.get(l.class);
    console.log(`${i + 1}. ${l.class}\n   ${s?.status ?? "learned"}${l.approved ? ", approved" : ""} - ${s?.sessions ?? 0} sessions since learned\n   ${l.lesson}`);
  });
}
