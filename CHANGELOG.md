# Changelog

## 1.0.0 (2026-11-01)

First public release.

- Re-observes the files a session had observed after that session's own `bash` or `shell` call, covering rewrite, delete and create, so self-inflicted `FS_STALE_VERSION` errors disappear while changes made by anyone else still trip the guard.
- Optional notice on the tool result naming the refreshed files (`notify`, `maxNotifyPaths`).
- Notice source kind `plugin:fs-reobserve`, accepted by DSH 0.2.x.
- Troubleshooting guide, error reference and the `fs-reobserve-doctor` skill.
- Unit tests on a mock plugin context (`npm test`).
