# Error codes: dsh-fs-reobserve

This plugin returns no errors of its own: it has no routes and no tools, and it never fails
a tool call (a failed re-stat keeps the old observation, a failed notice is dropped). Its
reserved prefix for future codes is `REOBSERVE_`.

What you meet instead are the harness's file-observation codes, which this plugin
influences, and two log lines that tell you whether it is working.

| Code / log line | Where it appears | Meaning | Agent action |
|---|---|---|---|
| FS_STALE_VERSION | `edit` / `write` tool result (harness) | the file changed since this session last observed it | re-read, then edit; if it follows your own bash command, see [details](#fs_stale_version) |
| FS_NOT_OBSERVED | `edit` / `write` tool result (harness) | the session never read this file | `read` it first ([details](#fs_not_observed)) |
| `fs-reobserve: armed` | DSH log, once per start | plugin mounted, shows `tools`, `notify`, `maxNotifyPaths` | none; absence means not mounted ([details](#log-armed)) |
| `fs-reobserve: refreshed` | DSH log, per refreshing call | N observations refreshed after a bash/shell call | none ([details](#log-refreshed)) |
| `duplicate loader entry id: fs-reobserve` | DSH log at boot (harness) | the entry is defined twice (bundle patch plus a hand-written row) | ask the human to remove the hand-written insert row ([details](#log-duplicate)) |

### FS_STALE_VERSION
- **Meaning:** the observation policy holds an older version of the file than the one on disk.
- **Where:** the result of `edit` or `write`.
- **With this plugin:** your OWN `bash`/`shell` writes are refreshed when the call settles,
  so this code now points at a write that did not come from that call: a background process,
  another session or subagent, a scheduled job, or a person.
- **Agent action:** `read` the file again (the content changed), then edit. Never work around it.
- **Needs the human:** no.
- **Troubleshooting:** [entry 1](TROUBLESHOOTING.md#t-stale-after-own-bash)

### FS_NOT_OBSERVED
- **Meaning:** the session has no observation of the file at all.
- **Where:** the result of `edit` or `write` of an existing file.
- **Agent action:** `read` the file (a small `limit` is enough), then edit. Observations do
  not survive a session resume.
- **Needs the human:** no.
- **Troubleshooting:** [entry 3](TROUBLESHOOTING.md#t-not-observed)

<a id="log-armed"></a>
### Log: `fs-reobserve: armed`
- **Meaning:** the plugin mounted and lists its effective options.
- **Agent action:** if missing after a DSH start, follow [entry 2](TROUBLESHOOTING.md#t-not-armed).

<a id="log-refreshed"></a>
### Log: `fs-reobserve: refreshed`
- **Meaning:** after the named tool call, N observations were refreshed (changed, removed,
  created counts). The same information reaches the agent as a notice in the tool result
  when `notify` is on.

<a id="log-duplicate"></a>
### Log: `duplicate loader entry id: fs-reobserve`
- **Meaning:** the profile patch inserts an `fs-reobserve` entry that the package's own
  bundle patch already inserts. DSH reports it at boot instead of mounting the entry twice.
- **Needs the human:** yes, to edit the profile patch and restart `dsh web`.
- **Troubleshooting:** [entry 2](TROUBLESHOOTING.md#t-not-armed), cause 3.
