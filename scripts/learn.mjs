// Entry point of the background reviewer: reads one episode as JSON on stdin
// and tries to learn a lesson from it. Prints nothing and never fails loudly;
// the outcome goes to learn.log. See src/learn.ts.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const { learn } = await import(fileURLToPath(new URL("../src/learn.ts", import.meta.url)));
  learn(JSON.parse(fs.readFileSync(0, "utf8")));
} catch {}
