---
name: prompt-planner
description: Activated when the user says "create a plan", "generate a prompt", "produce a blueprint", or similar. Conducts a structured interview to deeply understand a task, then writes a detailed, self-contained plan document to docs/plans/ that a cheaper execution agent can follow step-by-step without needing to think or ask questions.
version: 1.0.0
---

# Prompt Planner

Your job is to produce a **complete, unambiguous execution plan** — a document so thorough that a cheaper, non-reasoning model can implement it mechanically without needing to make any decisions of its own.

You will do this in two stages: **interview**, then **write**.

---

## Stage 1 — Interview

Do NOT start writing the plan yet. First, gather enough information to remove all ambiguity. Ask questions in focused batches — don't ask everything at once, but also don't trickle one question at a time forever. A typical interview runs 2–4 rounds.

### Round 1 — Establish the goal and scope

Always ask these first:

1. **What is the goal?** One or two sentences: what should exist or work differently when this plan is executed?
2. **What type of change is this?** (new feature, bug fix, refactor, DB migration, API integration, UI update, infrastructure change, etc.)
3. **Which layer(s) of the stack are involved?** (server-side Express routes, DB schema/migrations, vanilla JS in `public/`, React islands in `src/react/`, both, other)
4. **What should be explicitly OUT of scope?** Anything this plan should deliberately not touch?

Wait for the user's answers before continuing.

### Round 2 — Drill into specifics

Based on the Round 1 answers, ask targeted follow-ups. Typical areas to cover — adapt to what's relevant:

- **Files / surfaces affected.** Which specific files, routes, components, tables, or API endpoints are involved? If the user isn't sure, say you'll note that and do a quick lookup when writing the plan.
- **Data model.** Does this require a new DB migration? New columns, tables, indexes? Are there existing rows to backfill?
- **API contract.** New or changed endpoints? Request/response shapes? Auth requirements?
- **UI/UX behaviour.** If there's a UI component, what does the happy path look like? What happens on error or empty state? Does form state need to be persisted (CLAUDE.md requirement)?
- **Privilege gating.** Is this admin-only, manager+, or visible to all roles?
- **Dependencies between steps.** Is there an order that must be respected — e.g., migration before deploy, backend route before frontend hook?
- **Environment or secrets.** Any new env vars, API keys, or GCP resources needed?
- **Known constraints or gotchas.** Anything tricky the user already knows about?

### Round 3 (if needed) — Close gaps

After Round 2, if there are still ambiguous steps in your mental model of the plan, ask a focused third round. Examples:
- "Should the old behaviour be preserved as a fallback during rollout, or is a clean cutover OK?"
- "Is there a specific MUI component you have in mind, or should I propose one?"
- "Should this work offline (Service Worker / IndexedDB) or is network required?"

Only move to Stage 2 once you can write every step of the plan without guessing.

---

## Stage 2 — Write the plan

Tell the user you're now writing the plan, then produce the document below. Save it to `docs/plans/<slug>.md` where `<slug>` is a short kebab-case name derived from the goal (e.g. `add-customer-notes-field`, `migrate-photos-to-gcs`, `offline-sync-phase-3`). Never overwrite an existing plan file — pick a unique name.

After saving, tell the user the file path and offer a brief summary of the plan's key steps.

---

### Plan document format

````markdown
# Plan: <Title>

**Created:** <date>  
**Status:** draft  
**Scope:** <one-line scope description>

---

## 1. Description

<2–5 sentence overview of what this plan accomplishes and why. Written for someone who has no context — they should understand the goal and the approach after reading this paragraph alone.>

## 2. Goal & success criteria

<Bulleted list of concrete, observable outcomes. Each item should be something an agent or reviewer can verify.>

- [ ] <criterion 1>
- [ ] <criterion 2>
- …

## 3. Out of scope

<Explicit list of things this plan does NOT cover. If the user said nothing is out of scope, write "Nothing explicitly excluded — flag anything unexpected for the user before proceeding.">

## 4. Affected files

List every file the executing agent will need to **read**, **edit**, **create**, or **delete**. If a file is read-only reference material, label it as such. If the agent needs to discover files (e.g. "all components that import X"), describe the grep/glob needed.

| Action | File | Purpose |
|--------|------|---------|
| Read   | `server.js` | Understand existing route structure before adding |
| Edit   | `src/react/components/CustomerForm.tsx` | Add new notes field |
| Create | `migrations/20260625120000_add_customer_notes.js` | New DB column |
| …      | …    | … |

## 5. Dependencies & prerequisites

List everything that must be true **before execution begins**. Include:
- Environment state (env vars, secrets, running services)
- Other plan files that must be completed first
- Specific git branch state
- Anything in this project's CLAUDE.md that is especially relevant

> **CLAUDE.md reminders for the executing agent:**
> - <copy any CLAUDE.md rules that are directly relevant — e.g. localStorage key registry, privilege check helpers, form persistence requirement>

## 6. Step-by-step instructions

Number every step. Each step must be **atomic** — one action, one file, one command. If a step has a gate ("do not continue until X"), state it explicitly in bold.

Steps that depend on a prior step completing must say so: "This step requires step N to be complete."

```
Step 1. <verb> <object>
  File: <path>
  Action: <precise description of what to add/change/remove. Include exact function names, line hints, or code snippets where it removes ambiguity.>
  
  > ⛔ STOP: Do not proceed to step 2 until [condition is met / user has confirmed X].

Step 2. …

Step 3. Run the migration
  Command: npm run db:migrate
  Expected output: either the migration name listed as applied, or "No migrations to run!"
  If output is anything else: stop and report to the user before continuing.

…
```

## 7. Verification

After all steps are complete, the executing agent must verify the following before reporting success:

- [ ] <check 1 — e.g. "Run npm run test:ci and confirm it passes">
- [ ] <check 2 — e.g. "Visit the affected page and confirm the new field renders">
- [ ] <check 3 — e.g. "Check the DB: SELECT ... FROM ... WHERE ... shows the expected rows">

## 8. Notes & constraints

<Any additional context, gotchas, or decisions made during planning that the executing agent should know. Link to relevant docs. Flag anything that may need a follow-up task.>

**Proposed follow-up tasks (do not implement these as part of this plan):**
- <item 1>
- <item 2>
````

---

## Behaviour rules (apply throughout)

- **Never guess.** If you don't know something — a file path, which component to use, whether a migration is needed — ask the user rather than assuming. A wrong assumption in the plan means the executing agent will implement the wrong thing.
- **Be specific.** Vague steps like "update the frontend" are not acceptable. Name the file, the component, the prop, the function.
- **Flag CLAUDE.md constraints inline.** When writing steps that touch React components, forms, auth, or localStorage, copy the relevant CLAUDE.md rule directly into the plan so the executing agent sees it in context.
- **One plan per task.** If the user describes two separate, independently deployable changes, propose splitting them into two plan files.
- **Never commit or deploy as part of planning.** The plan is a document only. If the user asks you to also execute the plan, confirm before doing so and treat it as a separate action.
