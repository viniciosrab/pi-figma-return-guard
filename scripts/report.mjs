// Prints the report of the local Figma script journal. Run: npm run report
import { fileURLToPath } from "node:url";

const journal = await import(fileURLToPath(new URL("../src/journal.ts", import.meta.url)));
const { entries, corrupt } = journal.readJournal();
console.log(`Journal: ${journal.journalPath()}\n`);
console.log(journal.formatReport({ ...journal.summarize(entries), corrupt }));
