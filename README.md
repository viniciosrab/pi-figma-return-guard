# pi-figma-return-guard

Pi extension that stops Figma MCP `use_figma` scripts from returning images as base64.

Figma's remote MCP server rejects a `use_figma` call whose `return` value is larger than 48,000 bytes:

```
Return value exceeds the 48000-byte limit (94070 bytes). Canvas edits from this run were not committed.
```

Every canvas edit the script made in that run is discarded too. Agents hit this most often by exporting a frame with `exportAsync` and returning it as a base64 data URL so they can look at it. Even a small screenshot is over the limit once it is base64.

The extension checks each Figma MCP tool call before it runs. When the script calls `base64Encode` or `btoa`, the call is blocked and the agent gets this instead:

> Blocked: this Figma script encodes data as base64 (base64Encode or btoa). [...] Inside the script call `await node.screenshot({ scale })`; the image comes back as a separate image part of the result that does not count toward the limit. Return only IDs or 'ok', then show the image in codemode with `image(result.content.find(p => p.type === 'image'))`. Or call the Figma MCP get_screenshot tool, which returns a URL.

Nothing reaches Figma, so no edit is lost, and the agent switches to `node.screenshot()` on its next try.

To make the first try right, the extension also tells the agent up front, once per session, in a hidden message: use `node.screenshot()`, never return base64. It does this only when a Figma MCP server is configured (in `mcp.json`, registered as tools, or listed in the prompt). A hidden message reaches every provider, including ones such as claude-bridge that rebuild the system prompt and drop prompt changes from extensions. The block stays as the safety net for when the agent forgets.

## Other script mistakes

The same hint also tells the agent to filter layer lookups by type and to look nodes up again after `remove()` or `detachInstance()`.

Before a script reaches Figma, the extension silently fixes mistakes that have a fix with the same meaning, so the agent never sees an error for them:

- a name declared twice, usually after joining stored helper code with new code: everything from the second declaration to the end goes into a `{ }` block, so the helpers keep their binding and the new code sees the new one;
- `figma.loadAllPagesAsync()`, which the use_figma runtime rejects, becomes a loop that loads each page;
- `setPluginData` and `getPluginData`, which the runtime rejects, become `setSharedPluginData` and `getSharedPluginData` in one fixed namespace (`piagent`).

It blocks only scripts that cannot work and have no such fix: `setFileThumbnailNodeAsync`, `setRangeOpenTypeFeatures`, and scripts that still do not parse, naming the problem and the line.

When a script fails in Figma, the extension adds to the error text:

- the script line the error points at;
- the likely cause and fix for the errors seen in real sessions: a lookup that found nothing or a TEXT layer named like its FRAME, a node used after it was removed or detached, an unsupported API, a locked instance layer, an unquoted non-ASCII `query()` selector, a NaN value, a component property reference outside a component, and syntax errors;
- a note that Figma discarded all of the run's canvas edits, so the agent reruns the fixed script instead of cleaning up.

Argument validation errors, timeouts and blocked calls are left alone, because nothing ran in Figma.

## Journal and report

The extension keeps a local journal of Figma script calls, so repeated errors can be found without anyone relaying screenshots. It appends one JSON line per script result, block or silent fix to `~/.pi/agent/figma-return-guard/journal.jsonl` (or under `PI_CODING_AGENT_DIR`), readable only by you.

- It stores: time, a random id per session, the tool name, whether the call worked, the error class with IDs, numbers and quoted design text removed, the failing line number, which advice was given, and which blocks or fixes were applied.
- It never stores: the script code, the failing line's text, the full error text or anything else from the design.
- It only appends, so several Pi sessions can write at once. Past 5 MB it moves the file to `journal.1.jsonl`. If writing fails, the tool call goes on unchanged.

`npm run report` prints the total of calls, the error rate, blocks and fixes, and each error class with how many times it happened, in how many sessions, how often the agent recovered and how many extra calls that took. Classes the extension has no advice for are listed first, under "Not covered yet".

## Learning from new errors

When a Figma script fails with an error the extension has no advice for, and the agent gets past it later in the same turn, the extension learns a lesson from it without involving the agent:

1. When the turn ends, it starts a background process and does not wait for it. The agent's session never sees it.
2. That process asks a model (`claude -p`, default `claude-opus-5-5`) with no tools, no settings, no MCP servers and no saved session for one general rule, given the error, the failing script, what the agent wrote afterwards and the scripts it ran next. The model may answer that there is no clear rule.
3. The rule is saved to `~/.pi/agent/figma-return-guard/lessons.jsonl` only if it passes a check: one line of 30-400 characters, with no links, tags, code fences, node IDs, shell or credential words, or text about instructions. The same check runs every time lessons are read.
4. The next time the same error happens, in any session, the lesson is added to the error text, labeled as learned. Built-in advice always wins.
5. When a learned error still happens in 3 different sessions, its lesson is also told up front in the session-start hint (at most 8 lessons, 1200 characters). If the error then happens in 3 more sessions, the lesson leaves the hint, because telling it up front did not prevent it.

Limits: one reviewer at a time, 5 attempts a day, and at most 2 failed attempts per kind of error. `learn.log` records each attempt's outcome, never the script or the answer. The script and notes sent to the model can contain names from your design; they go to the same provider your Claude sessions already use, and are never written to disk.

To stop learning, write `off` to `~/.pi/agent/figma-return-guard/learn.mode` or set `FIGMA_GUARD_LEARN=off`; lessons already learned keep being used. To remove a lesson, delete its line or append `{"class": "<its class>", "retired": true}`. `FIGMA_GUARD_LEARN_MODEL`, `FIGMA_GUARD_LEARN_DAILY_CAP` and `FIGMA_GUARD_LEARN_CMD` change the model, the daily cap and the CLI. `npm run report` lists each lesson and where it stands.

## What it checks

- **Tools:** any tool of an MCP server whose name contains `figma` (`mcp__figma__*`, `mcp__figma_linux_next__*`, hash-suffixed names) and that receives a `code` string. Tools without `code`, such as `get_screenshot`, always pass.
- **Code:** `base64Encode` (including `figma['base64Encode']`, `base64Encode?.(...)` and aliases) and `btoa(`. `base64Decode`, used to insert images, is allowed.
- It also covers calls made from inside a `codemode` script.

The word `base64Encode` in a comment or a string is blocked too; the agent removes it and retries.

## Install

```
pi install git:github.com/viniciosrab/pi-figma-return-guard
```

Or add the local checkout to `packages` in `~/.pi/agent/settings.json`. Run `/reload` in sessions that are already open.

## Develop

```
npm test
git config core.hooksPath .githooks   # once per clone: run the tests before every commit
```
