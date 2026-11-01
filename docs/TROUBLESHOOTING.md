# Troubleshooting dsh-fs-reobserve

Checked on: DSH 0.1.5-rc.1 (and the 0.2.1-rc.5 loader rules), plugin 1.0.0.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `fs-reobserve-doctor` skill (copy it into
`~/.dsh/skills/` first, see [the skill section](#skill)), or follow section 0 below.
This plugin has no HTTP routes, no tools and no UI: everything is visible in the DSH
log and in the notice it appends to `bash`/`shell` tool results. The codes you will
meet are the harness's own (`FS_STALE_VERSION`, `FS_NOT_OBSERVED`), see [ERRORS.md](ERRORS.md).

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | `FS_STALE_VERSION` on an edit right after your own bash command | plugin not armed, or the write did not come from that command | [1](#t-stale-after-own-bash) |
| 2 | No "armed" line in the log, plugin seems absent | not mounted (bundle, duplicate row, old build) | [2](#t-not-armed) |
| 3 | `FS_NOT_OBSERVED` on edit | expected: read the file first | [3](#t-not-observed) |
| 4 | Tuning (`tools`, `notify`, `maxNotifyPaths`) has no effect | set in the wrong place | [4](#t-tuning-ignored) |
| 5 | The notice is noisy or too long | `notify` / `maxNotifyPaths` | [5](#t-notice-noise) |
| 6 | You want it off without uninstalling | kill switch | [6](#t-kill-switch) |

## 0. Collect facts (read-only, always safe)

```bash
dsh --version
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).filter(b=>/reobserve/.test(b)))' "$D/package.json"
grep -n -B1 -A4 'id: fs-reobserve' "$D/cordis.patch.yml"        # profile rows that mention it (kill switch, config)
# DSH log: the terminal running `dsh web`, or your service manager, for example:
journalctl -u <your-dsh-unit> --since today | grep -E 'fs-reobserve|duplicate loader entry' | tail -20
```

Healthy: one line `fs-reobserve: armed -- reacting to [bash, shell], notify=true, maxNotifyPaths=4`
per DSH start, and `fs-reobserve: refreshed N observation(s) after bash ...` lines when a
command of yours changed files you had read.

<a id="t-stale-after-own-bash"></a>
## 1. An edit fails with `FS_STALE_VERSION` right after your own bash command

**Likely causes** (most likely first)
1. The plugin is not armed (not mounted, see [2](#t-not-armed)).
2. The write did not happen inside that tool call: a command started in the background
   (a job, `&`, `nohup`, a service it triggered) kept writing AFTER the call returned. The
   plugin re-stats only when the call settles.
3. The command ran through a tool that is not in `tools` (default `bash` and `shell`; for
   example a `subprocess` tool or a differently named shell tool).
4. The file was written by ANOTHER session: a subagent, another chat, or a scheduled job.
   Observations are per session and are refreshed only for the session that ran the command.
5. The re-stat failed (permission denied, path replaced during the stat); the old
   observation is kept on purpose.
6. Someone else really changed the file. This is the protection working.

**Diagnose** (read-only)
- Did the tool result of your command carry the notice "fs-reobserve refreshed stale file
  observations ..." naming the file? Yes: the observation was refreshed, so a stale error
  afterwards means a LATER write (cause 2, 4 or 6).
- No notice at all on any bash result that changed a read file: check the log (section 0).
  No `armed` line = cause 1. `armed` but no `refreshed` line = causes 2 to 5.
```bash
ls -la --time-style=full-iso <file>      # when was it last written, by which user
lsof <file> 2>/dev/null                  # is something still writing it
```

**Fix**
- Cause 1: see [2](#t-not-armed).
- Cause 2: wait for the background work to finish, then `read` the file again before editing.
- Cause 3: add the tool name to `tools` in the profile row ([4](#t-tuning-ignored)).
- Causes 4 to 6: re-read the file, then edit. Do not try to bypass the guard.

**Verify:** `read` the file, `edit` it: accepted.

<a id="t-not-armed"></a>
## 2. The plugin seems absent (no `armed` line in the log)

**Likely causes**
1. Not in the profile bundles, or `dsh web` not restarted since install (common C1).
2. An old build without `dsh.bundle.patch` in `package.json`: the bundle's own patch never
   applied, so no loader entry exists. Some installs worked around that with a hand-written
   `insert` row in the profile patch.
3. Both: the fixed build PLUS a leftover hand-written insert row for `fs-reobserve`. DSH
   refuses to boot the entry and logs `duplicate loader entry id: fs-reobserve`.
4. A build whose default export is the bare `apply` function: the loader calls it with no
   context, it throws before logging, and nothing appears in the log. Current builds export
   `{ name, apply, inject }`.
5. The filesystem service (`inject: ['fs']`) is not present in the profile (non-standard
   profile without the fs plugins).

**Diagnose**
```bash
P=$(node -p "require('path').dirname(require.resolve('dsh-fs-reobserve/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))")
node -p "const p=require('$P/package.json'); p.version + ' bundle.patch=' + (p.dsh&&p.dsh.bundle&&p.dsh.bundle.patch)"
grep -c 'id: fs-reobserve' "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"   # >0 with an insert: block = leftover row
node -e "import('$P/lib/index.js').then(m=>console.log(typeof m.default, Object.keys(m.default||{})))"
dsh --profile web --dump-config 2>/dev/null | grep -n 'fs-reobserve' | head
```

**Fix**
- Cause 1: `dsh plugin --profile web add <path-or-package>`, restart `dsh web` **[HUMAN]**.
- Cause 2: update the plugin.
- Cause 3: remove the hand-written `insert` row for `fs-reobserve` from the profile patch
  (keep a `disabled:` or `config:` row if you use one), back up the file first, restart **[HUMAN]**.
- Cause 4: update the plugin (default export must be an object).

**Verify:** after the restart the log shows `fs-reobserve: armed ...` once.

<a id="t-not-observed"></a>
## 3. `FS_NOT_OBSERVED` on edit

Not a fault of this plugin, and it does not change it: the harness requires a `read` of a
file in the current session before `edit`/`write` of an existing file. Observations do not
survive a session resume. **Fix:** `read` the file (a small `limit` is enough), then edit.

<a id="t-tuning-ignored"></a>
## 4. Tuning has no effect

The plugin reads its options from its loader entry config, not from a settings namespace.
A `fs-reobserve:` section in `settings.yaml` is NOT read by this version (it registers no
settings namespace), on either DSH line. Put the options in the profile row:

```yaml
# ${DSH_HOME:-~/.dsh}/profiles/web/cordis.patch.yml
- id: fs-reobserve
  config:
    tools: [bash, shell]
    notify: true
    maxNotifyPaths: 4
```

Profile patches reload live on DSH 0.1.5 and 0.2.x (the entry remounts). **Verify:** a new
`armed` line in the log shows the new values.

<a id="t-notice-noise"></a>
## 5. The notice is noisy or too long

Set `notify: false` (no notice, refresh still happens) or lower `maxNotifyPaths` in the row
([4](#t-tuning-ignored)). The notice is what tells an agent its next edit will be accepted,
so turning it off makes agents re-read more often, which is safe.

<a id="t-kill-switch"></a>
## 6. Turn it off without uninstalling

```yaml
- id: fs-reobserve
  disabled: true
```
in the profile patch. The harness then behaves strictly: every out-of-band write by your own
commands yields `FS_STALE_VERSION` on the next edit until you re-read.

<a id="skill"></a>
## The doctor skill

`skills/fs-reobserve-doctor/SKILL.md` is a step-by-step guide for agents. This version does
not register it automatically; copy it once:

```bash
P=$(node -p "require('path').dirname(require.resolve('dsh-fs-reobserve/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))")
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills" && cp -r "$P/skills/fs-reobserve-doctor" "${DSH_HOME:-$HOME/.dsh}/skills/"
```

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `DSH_HOME` defaults to `~/.dsh`, the profile is `web`. Items that cannot
apply to this plugin (routes, UI, webhooks, media) are left out; numbering follows the
shared standard.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start.

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-fs-reobserve' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-fs-reobserve" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'fs-reobserve' | head    # composed tree, does not boot
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'reobserve|incompatible|skipped|exemption|duplicate loader entry' | tail -40
```

**Fix:** install with `dsh plugin --profile web add <package-or-path>` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`), then restart `dsh web`
**[HUMAN if your chat runs inside dsh web]**. If the log says the bundle was skipped as
incompatible, update the plugin; DSH 0.2.x also offers an exact-version exemption
(`dsh plugin allow-version`, see the log message), which must be granted again after every
DSH version change.

**Verify:** the `fs-reobserve: armed` line appears once after the restart.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not apply

This plugin has no settings form on either DSH line: options live only in its profile row
(see [4](#t-tuning-ignored)). On DSH 0.2.x the first boot renames `settings.yaml` to
`settings.yaml.imported`; a `fs-reobserve:` section there was never read and is not
imported. Back up `cordis.patch.yml` before a hand edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add <package-or-path>
```
A runaway then kills only itself. Check afterwards that your other services are up.
<!-- /dsh-common-install -->
