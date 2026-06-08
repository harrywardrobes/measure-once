---
name: Log snapshot staleness after restart
description: Why /tmp/logs/*.log look stale right after restart_workflow, and how to get a real fresh boot log.
---

# Log snapshots are written by refresh_all_logs, not by restart_workflow

The `/tmp/logs/<workflow>_<ts>.log` files are point-in-time snapshots produced by
the `refresh_all_logs` tool. `restart_workflow` does **not** rewrite them.

**Symptom:** right after `restart_workflow`, `tail`/`ls -t` on `/tmp/logs/*.log`
still shows the *previous* boot (old timestamps, e.g. a stale-bundle warning that
you already fixed), making it look like the restart did nothing.

**Why:** the running workflow logs live elsewhere; the `/tmp/logs` copy only
updates when you call `refresh_all_logs`.

**How to apply:** after a restart, call `refresh_all_logs` (not just `tail` on the
old file) to get the new boot's log. To sanity-check serving without logs at all,
compare on-disk artifact mtimes (e.g. `public/react/main.js` vs the edited source)
and `curl localhost:5000` — static assets are read from disk per request, so a
boot-time stale-bundle WARN does not mean stale files are being served.
