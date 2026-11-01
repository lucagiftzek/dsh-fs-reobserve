---
name: fs-reobserve-doctor
description: Diagnose dsh-fs-reobserve and the FS_STALE_VERSION / FS_NOT_OBSERVED edit errors step by step. Load it when an edit is refused right after your own bash command, when the fs-reobserve notice never appears, or when the user asks whether fs-reobserve is working.
---

# fs-reobserve doctor

dsh-fs-reobserve refreshes this session's file observations after its OWN `bash`/`shell`
call settles, so the next `edit` is accepted. It deliberately does NOT refresh changes made
by anything else. It has no routes, no tools and no UI.

## Rules
- Read-only checks first. Do not print settings files or profile rows into the chat beyond
  the `fs-reobserve` lines.
- Never restart `dsh web` yourself: your chat may run inside it. Ask the human.
- Never work around `FS_STALE_VERSION` (no tricks to force a write): re-read instead.
- Steps marked [HUMAN] need the human.

## 0. Facts (read-only)
1. Plugin dir:
   `node -p "require('path').dirname(require.resolve('dsh-fs-reobserve/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"`
   Docs: `<plugin dir>/docs/TROUBLESHOOTING.md` and `docs/ERRORS.md`.
2. DSH version: `dsh --version`.
3. Log lines (ask the human where DSH logs if not a systemd unit):
   `journalctl -u <your-dsh-unit> --since today | grep -E 'fs-reobserve|duplicate loader entry' | tail -20`
4. Profile rows: `grep -n -B1 -A6 'id: fs-reobserve' "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"`

## 1. Decision tree
- Edit failed with `FS_NOT_OBSERVED` -> `read` the file, then edit. Done (not this plugin).
- Edit failed with `FS_STALE_VERSION`:
  - Your previous bash result carried the notice "fs-reobserve refreshed ..." naming the file
    -> a later write happened (background process, other session, person). `read`, then edit.
  - No notice, and fact 3 shows no `armed` line since the last start -> plugin not mounted:
    go to "Not armed" below.
  - `armed` line present, no notice:
    - the command started background work (`&`, a job, a service) -> wait, `read`, edit.
    - the command ran in a tool not listed in `tools` of the armed line -> suggest adding it
      to the row config (TROUBLESHOOTING entry 4) [HUMAN to approve the config change].
    - a subagent or another chat wrote the file -> `read`, edit.
- Notice too noisy -> suggest `notify: false` or a lower `maxNotifyPaths` in the row (entry 5).
- User wants it off -> kill switch row `- id: fs-reobserve` / `disabled: true` (entry 6) [HUMAN].

## 2. Not armed
Run TROUBLESHOOTING entry 2 diagnosis (read-only). Map:
- not in bundles / not installed -> C1: `dsh plugin --profile web add <package>` then restart [HUMAN].
- `package.json` has no `dsh.bundle.patch` -> update the plugin.
- log shows `duplicate loader entry id: fs-reobserve` -> a hand-written insert row duplicates the
  bundle patch; the human removes it (backup first) and restarts [HUMAN].
- default export is a function, not an object -> update the plugin.

## 3. Fixes you may apply yourself
- Re-reading files and retrying edits.
- Nothing else: config edits and restarts belong to the human.

## 4. Report back
State: armed or not (with the log line), which branch of the tree applied, what you did,
and the exact change the human should make if any (file, row, value).
