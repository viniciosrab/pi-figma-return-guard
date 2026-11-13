// Prints the report of the local Figma script journal. Run: npm run report
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const journal = await import(at("../src/journal.ts"));
const lessons = await import(at("../src/lessons.ts"));
const { entries, corrupt } = journal.readJournal();
console.log(`Journal: ${journal.journalPath()}\n`);
console.log(journal.formatReport({ ...journal.summarize(entries), corrupt, lessons: lessons.standing(entries, lessons.readLessons()) }));
