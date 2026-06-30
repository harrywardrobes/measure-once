---
name: batch-tasks
description: Take a single prompt containing MULTIPLE tasks/bugs/changes, de-duplicate and order them, produce one plan for the user to approve, then execute the tasks one-by-one on a feature branch — verifying and committing each — and finally open a PR. Use when the user pastes or dictates a batch of work and wants it planned then shipped, e.g. "here are several tasks", "implement all of these", "work through this list", "I've got a bunch of bugs and changes", "do these and commit each as you go", "plan then build these". Do NOT use for a single task or a one-off commit (use git-story for commits, prompt-planner for a single deep plan).
version: 1.0.0
---

# Batch Tasks

Turn a messy dump of many tasks into a clean, approved plan, then ship them one
at a time on a feature branch with a commit per task and a PR at the end. You
are the orchestrator: you decompose, de-duplicate, get sign-off **once**, then
execute autonomously, stopping only when something genuinely needs the user.

**Recommended model & effort:** run this skill on **Opus 4.8**. Use **`/effort high`**
for the whole run; bump to **`max`** for the planning stages (0–3) when the batch
is large or the tasks are tangled, then drop back to `high` for execution. The
planning stage is where overlap/dependency mistakes compound, so spend reasoning
there; execution is guarded by per-task checks so `high` is plenty. Don't run the
whole batch at `max` — it overthinks mechanical edits and burns tokens.

---

## Operating contract (decided with the user — do not silently change these)

- **Git:** one feature branch for the **whole batch**. Commit per task. Push the
  branch and open a **PR** at the end. **Never commit or push to `main` directly.**
- **Approval:** the user approves the plan **once**. After that, execute every
  task and commit without asking again — stop only on failure or a genuine
  ambiguity you cannot resolve from the code.
- **On failure:** attempt to fix it yourself (up to ~2 focused attempts). If it
  still fails, **stop and ask** — report what failed, what's already committed,
  and the options. Never pile up broken commits.
- **Pre-commit checks (every task):** TypeScript build + repo guard scripts +
  the targeted test suite(s) for the touched area must pass before the commit.

---

## Stage 0 — Intake & clarify

1. Read the user's prompt and pull out every discrete unit of work. A "task" is
   one observable change: a bug fix, a feature, a refactor, a copy tweak.
2. **Apply the project's UX-first rule (CLAUDE.md).** Before planning any task
   that adds or changes a *feature* (not a pure bug fix), note the clarifying
   questions you need: expected workflow, edge cases, frequency, pain points.
   Batch all clarifying questions across all tasks into **one** round — use
   `AskUserQuestion` — so the user answers once, not per task.
3. If a task is too vague to plan or execute, it goes in the question round too.
   Do not invent scope.

Do not start decomposing into a plan until ambiguous tasks are resolved.

---

## Stage 1 — Decompose & detect overlap

Build the canonical task list. For each candidate task, classify the
relationship to the others:

- **Duplicate** — two asks are the same thing → merge into one task.
- **Overlapping** — they touch the same file/function/component and should be
  done together to avoid conflicting edits or double work → merge or chain them.
- **Dependent** — task B needs task A first (e.g. a migration before the route
  that reads the new column; a server endpoint before the React hook that calls
  it) → record the order.
- **Conflicting** — two asks want incompatible outcomes → flag for the user;
  do not guess which wins.
- **Independent** — no relationship → can go in any order.

Decide an execution order that respects every dependency and keeps overlapping
work adjacent. Smaller/lower-risk tasks earlier is a good tie-breaker.

---

## Stage 2 — Ground each task in the codebase

For every task, do a quick read-only lookup (Glob/Grep/Read, or delegate a broad
search to the `Explore` agent) to find:

- The exact files/functions/components/routes/tables it will touch.
- Whether a **DB migration** is needed (schema is migration-owned — never
  `CREATE TABLE` in app code; new sync-relevant tables need
  `updated_at` + `version` + trigger).
- Which **CLAUDE.md constraints** apply (see the checklist in Behaviour rules).
- Which **test suite(s)** in `package.json` cover the area (match by name, e.g.
  auth → `test:login` / `test:set-password` / `test:change-password`; design
  visits → `test:design-visit*`; localStorage → `test:ls-keys`).

This keeps the plan concrete instead of hand-wavy. Don't write code yet.

---

## Stage 3 — Present the plan & get approval (the one gate)

Present the plan as a numbered, ordered list. For each task show:

```
Plan (execution order):

1. fix: <short imperative title>
   Files:   server.js (~L340–380), auth.js
   Migration: none
   Checks:  typecheck + test:ls-keys + test:privilege-reads + test:login
   Risk:    low
   Commit:  fix: <conventional-commit subject>

2. feat: <title>   ← depends on #1 (needs the new endpoint)
   Files:   src/react/components/Foo.tsx, src/react/constants/localStorageKeys.ts
   Migration: none
   Checks:  typecheck + test:ls-keys + test:privilege-reads + <targeted vitest>
   Risk:    medium — touches form state (must persist to localStorage)
   Commit:  feat: <subject>

Merged / dropped:
- "fix login typo" + "login button copy" → merged into task 1 (same file).
Conflicts needing your call:
- (none) | or: tasks X and Y want opposite behaviours — which wins?
```

State explicitly:
- The single **feature branch name** you'll create (e.g.
  `batch/<short-slug>` derived from the overall theme).
- That you'll commit per task and open a PR at the end (no push to `main`).
- That you'll run the per-task checks and stop-to-ask on a failure you can't fix.

Then ask: **"Approve this plan and order? Once you say go, I'll execute all of
it and only come back on a failure or a real ambiguity."**

**Wait for explicit approval. Do not touch the working tree until the user says go.**
If they amend the plan, re-present the changed version and wait again.

---

## Stage 4 — Create the branch

After approval, confirm the tree is clean and branch from an up-to-date `main`.
If `main` is the current branch and there is uncommitted work, surface it first
(don't sweep it into the batch).

```powershell
git status
git fetch origin
git switch -c batch/<slug> origin/main   # or: git switch -c batch/<slug> (from current main)
```

If the user is mid-work on another branch, ask whether to branch from `main` or
from their current branch before proceeding.

---

## Stage 5 — Execute the loop (one task at a time)

For each task **in order**:

### 5a. Implement
Make the change. Reuse existing components before writing new ones. Honour every
applicable CLAUDE.md constraint (checklist below). If a task needs a migration,
create it with `npm run db:migrate:create -- <name>` and write raw `pgm.sql`;
never edit an applied migration.

### 5b. Verify (must pass before committing)
Run, in this order, stopping at the first failure:

```powershell
npm run build:react        # typecheck + vite build + bundle-size gate
npm run test:ls-keys       # localStorage key registry guard
npm run test:privilege-reads  # privilege-bypass guard
```
Then the **targeted** suite(s) for the touched area, e.g.:
```powershell
npm run test:login            # example — pick what matches the task
```

- Per-task runs use **targeted** suites, not the whole CI set (too slow). The
  full `npm run test:ci` is an optional final gate before the PR (Stage 6).
- If the task touches **auth, data integrity, or API error handling** and no
  test covers the new behaviour, add one (CLAUDE.md test policy). Do **not** add
  tests for UI behaviour, CI docs, or test infrastructure.

### 5c. Fix-or-ask
If a check fails: make up to ~2 focused attempts to fix the **same** task. If it
still fails, **stop the loop** and report:
- which task and check failed (paste the relevant output),
- what is already committed on the branch,
- options (fix together now / skip this task and continue / abort the batch).

Do not move to the next task with a failing check.

### 5d. Commit
Stage **only** this task's files by name (never `git add .` / `-A`). Match the
conventional-commit style of recent history (`feat:` / `fix:` / `chore:`).

```powershell
git add <file1> <file2>
git diff --cached --stat          # confirm only the intended files are staged
git commit -m "<type>: <subject>" -m "<body: the why, if needed>" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git log -1 --oneline              # confirm it landed
```

> Use multiple `-m` flags for multi-line messages — it's the most reliable form
> across PowerShell and Bash. Subject ≤72 chars, imperative, no trailing period.
> Update the `Co-Authored-By` model name if you are running a different model.

Then continue to the next task. **Do not push between tasks** — push once at the end.

---

## Stage 6 — Push & open the PR

After the **last** task commits cleanly:

1. (Recommended) run the full guard once: `npm run test:ci`. If it fails,
   fix-or-ask exactly as in 5c before opening the PR.
2. Push the branch and open a PR against `main`:

```powershell
git push -u origin batch/<slug>
gh pr create --base main --head batch/<slug> --title "<batch summary>" --body "<body>"
```

PR body: a short intro, then a checklist of the tasks (one line each, linking
the commit), then the verification run. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

If `gh` isn't available or the repo has no GitHub remote, push the branch and
give the user the compare URL / branch name so they can open the PR manually.

---

## Stage 7 — Close out

- Show `git log --oneline -<N>` (N = commits made) so the user sees the history.
- Give a one-paragraph summary: tasks shipped, anything merged/dropped, the PR link.
- **Propose follow-up tasks** (CLAUDE.md): keep them small and focused, and
  never pre-approve anything that materially changes app behaviour — surface it
  for the user to approve. Examples: a Storybook story for a new component (never
  auto-created), a migration backfill, a test for an untested edge case.

---

## Behaviour rules

**Git**
- One branch per batch; commit per task; PR at the end. Never push to `main`.
- Never `git add .` / `git add -A` — name files (avoids staging `.env`,
  generated `public/react/`, `public/storybook/`, `sw.js`).
- Never amend or force-push unless the user asks. Never `--no-verify`.

**Approval & autonomy**
- Exactly one approval gate (Stage 3). After "go", don't ask again except on a
  failure you can't fix or a genuine conflict. Don't re-litigate approved scope.

**CLAUDE.md constraints to honour per task (check each that applies):**
- **Form persistence:** in-progress forms/multi-step inputs must draft-save to
  localStorage/sessionStorage and restore on re-mount; clear only after success.
- **localStorage key registry:** every key must be a named export in
  `src/react/constants/localStorageKeys.ts` — never a raw string to
  get/set/removeItem (`test:ls-keys` enforces this).
- **Privilege checks:** React → `usePrivilege()`; vanilla → `getPrivilegeLevel()`;
  server → `getRequestPrivilegeLevel(req)` or `requireAdmin`/`requirePrivilege`.
  Never read `privilege_level` directly (`test:privilege-reads` enforces this).
- **Component reuse:** reuse existing site components; for a genuinely new MUI
  component, reference MUI docs; anything outside MUI/existing set → confirm first.
- **MUI v6:** Stack layout props go inside `sx={{}}`; `data-testid` on Drawer/
  Dialog paper via a `ref` callback in `slotProps.paper`.
- **Migrations:** schema lives only in `migrations/`; never `CREATE TABLE` in app
  code; never edit an applied migration; renames need a `MIGRATION_RENAMES` entry.
- **Bundle size:** keep heavy deps out of the always-loaded `main.js` (dynamic
  `import()`); `build:react` enforces the ~40kB gzip cap.
- **Dev-only admin features:** anything gated on `NODE_ENV !== 'production'` in
  the admin panel needs a matching `#tab-devenv` entry.
- **Storybook stories:** never create or update a story unless the user asked in
  this request — propose it as a follow-up instead.
- **Shared CJS/ESM modules:** server requires the explicit `.cjs`; React imports
  the `.ts`. Keep the pair in sync (drift-guard tests).

**Scope & quality**
- If the batch is very large (say >8 tasks or lots of context), consider
  delegating each task's *implementation* to a subagent (`general-purpose`) while
  you, the orchestrator, run the checks and own every commit — this preserves
  context. Default to inline execution for smaller batches.
- Never guess a file path, component, or migration need — look it up (Stage 2)
  or ask. A wrong assumption ships a wrong commit.
- Report faithfully: if a check was skipped or a test failed, say so with output.
