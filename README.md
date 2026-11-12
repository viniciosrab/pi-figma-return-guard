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

Before a script reaches Figma, the extension blocks two kinds of scripts that cannot work:

- calls the use_figma runtime rejects (`loadAllPagesAsync`, `setFileThumbnailNodeAsync`, `setPluginData`, `getPluginData`, `setRangeOpenTypeFeatures`), naming what to use instead;
- scripts that do not parse, such as a `const` declared twice after joining helper snippets, naming the problem and the line.

When a script fails in Figma, the extension adds to the error text:

- the script line the error points at;
- the likely cause and fix for the errors seen in real sessions: a lookup that found nothing or a TEXT layer named like its FRAME, a node used after it was removed or detached, an unsupported API, a locked instance layer, an unquoted non-ASCII `query()` selector, a NaN value, a component property reference outside a component, and syntax errors;
- a note that Figma discarded all of the run's canvas edits, so the agent reruns the fixed script instead of cleaning up.

Argument validation errors, timeouts and blocked calls are left alone, because nothing ran in Figma.

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
