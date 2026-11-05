# AGENTS.md — how to work in this repo

## Before you write code

1. Read `brief/00-task.md`, `brief/01-context.md`, `brief/02-constraints.md`, `brief/03-examples.md`, and `brief/04-contracts.md` if it exists.
2. If anything is ambiguous or missing, ask up to 5 questions. Don't invent requirements.
3. Write or update `brief/05-plan.md`. Wait for approval before implementing.

## While implementing

- Follow the existing patterns in `01-context.md`. Don't introduce a second way to do the same thing.
- Stay inside the scope. If you think a file outside scope must change, stop and ask.
- Make small, reviewable commits. One logical change per commit.
- Update the brief when a decision changes. The brief is the source of truth.

## Before you say you're done

- Run the build and the tests. Paste the actual output.
- Walk through each acceptance criterion in `00-task.md` and say how it's met.
- List what you changed, what you didn't, and anything you're unsure about.
- Don't claim something works if you didn't run it.

## Style

- Concise. No filler. Explain the "why" only when it's non-obvious.
