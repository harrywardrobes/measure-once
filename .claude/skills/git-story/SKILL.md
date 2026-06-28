---
name: git-story
description: Analyse all uncommitted changes, group them by logical concern, propose split commits with descriptive messages, then stage and commit each group interactively. Use when the user wants to commit changes, asks what has changed, wants help writing commit messages, or says things like "commit this", "what needs committing", "split into commits", "tidy up the git history", or "write good commit messages".
version: 1.0.0
---

# Git Story

You are creating a clean, readable git history from a pile of uncommitted work. The goal is commits a future developer (or Harry) can scan in `git log` and immediately understand — not a blob of "wip" or a single mega-commit.

---

## Step 1 — Read the working tree

Run these in parallel before saying anything:

```powershell
git status
```
```powershell
git diff HEAD
```
```powershell
git log --oneline -12
```
```powershell
git diff --cached
```

If `git status` is clean (nothing to commit), tell the user and stop.

---

## Step 2 — Understand the changes

Read every changed file in full if needed — don't guess at what a diff means from the filename alone. For files that appear in the diff but whose full context matters (e.g. migrations, new components, config files), use the Read tool to read them.

Identify:
- **What type of change each file represents** — feature, bug fix, refactor, migration, config, UI, test, docs, dependency
- **Which files belong together** — files that form a single logical unit should be one commit (e.g. a migration + the server route that uses it; a new component + its story + its localStorageKeys entry)
- **Which files are independent** — unrelated changes that happened to land in the same session should be separate commits

---

## Step 3 — Propose the commit plan

Present the plan as a numbered list before touching git. Format:

```
Proposed commits (oldest → newest):

1. <type>: <short imperative description>
   Files: src/react/components/Foo.tsx, src/react/components/Bar.tsx
   Why grouped: both implement the new X feature together

2. fix: <description>
   Files: server.js (lines ~340–380)
   Why grouped: standalone bug fix, unrelated to above

3. chore: update migration for Y
   Files: migrations/20260628_add_y_column.js, db-migrate.js
   Why grouped: schema change + rename entry always travel together
```

For each commit, write the **full commit message** (subject + optional body) you will use — not a placeholder. Match the voice and style of recent commits from `git log`. If the recent history uses conventional commits (`feat:`, `fix:`, `chore:`), continue that style. If it uses prose titles, use prose.

Ask: "Does this split look right? Any changes to the grouping or messages before I start committing?"

**Wait for explicit approval before running any git commands.**

---

## Step 4 — Execute commit by commit

For each proposed commit, in order:

1. Stage exactly the files listed:
   ```powershell
   git add <file1> <file2> ...
   ```
   For partial file staging (e.g. only certain changes in `server.js`), explain the limitation and ask the user whether to stage the whole file or split the approach.

2. Confirm the staged diff looks right:
   ```powershell
   git diff --cached --stat
   ```
   If unexpected files appear in the staged diff, **stop and report** — don't commit until the staged set matches the plan.

3. Commit with the agreed message:
   ```powershell
   git commit -m "$(cat <<'EOF'
   <subject line>
   
   <body if needed>
   
   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

4. After each commit, show the one-liner from `git log -1 --oneline` and confirm it landed cleanly before moving to the next.

---

## Step 5 — Close out

After all commits:

```powershell
git log --oneline -<N>
```
(where N = number of commits made + a few before)

Show the user the resulting log so they can see the history they've just written. Keep any follow-up commentary brief — "N commits, all clean" is enough.

---

## Behaviour rules

- **Never commit without approval.** The plan is always presented first; the user must greenlight it.
- **Never use `git add .` or `git add -A`** — always name specific files. Blanket staging can accidentally include `.env`, generated artifacts, or unrelated work.
- **Never amend existing commits** unless the user explicitly asks.
- **Never skip hooks** (`--no-verify`). If a pre-commit hook fails, investigate and fix the underlying issue.
- **Partial file staging:** if two separate logical changes live in one file (e.g. two unrelated function edits in `server.js`), flag this — don't silently lump them. Options: stage the whole file under whichever commit is more relevant, or ask the user if they want to use `git add -p` interactively.
- **Untracked files:** treat new files (shown as `??` in `git status`) the same as modified files — include them in the relevant commit group.
- **Large diffs:** if the total diff is very large, read the most structurally significant files first (migrations, new components, route handlers) and ask clarifying questions if grouping is unclear rather than guessing.
- **Commit message quality:** subject lines must be ≤72 chars, imperative mood, no trailing period. Body lines ≤100 chars. Focus on *why*, not *what* — the diff already shows what changed.
- **Don't add `Co-Authored-By`** to a commit if the user asks you not to.
