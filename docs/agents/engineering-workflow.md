# Engineering Workflow

This fork retains a shared engineering workflow for turning a decision into a
reviewed implementation. Invoke the named skill directly when the current agent
does not expose slash commands.

## Skill availability

The fork-specific entry points are maintained in the public
[`giacomoguidotto/workspace`](https://github.com/giacomoguidotto/workspace/tree/main/cfg/home/agents/skills)
skill source. They are adapted from
[`mattpocock/skills`](https://github.com/mattpocock/skills). If an agent does not
list the entry points below, install the required set globally so the skill
files remain outside this repository:

```bash
npx skills@latest add giacomoguidotto/workspace --full-depth --global \
  --skill setup-matt-pocock-skills \
  --skill to-spec \
  --skill to-tickets \
  --skill implement \
  --skill code-review \
  --skill domain-modeling \
  --skill improve-codebase-architecture
```

Restart or refresh the agent's skill discovery if required. This repository's
tracker, triage, and domain configuration is already committed under
`docs/agents/`; run `setup-matt-pocock-skills` only when deliberately changing
that configuration or setting up another repository.

## Read before changing the system

- Read `CONTEXT.md` and use `docs/agents/domain.md` when exploring or changing
  the domain model.
- Use `docs/agents/issue-tracker.md` for the configured GitHub tracker.
- Use `docs/agents/triage-labels.md` for the tracker label vocabulary.

Contributor guidance, issue titles, acceptance criteria, tests, and code should
use the glossary terms Application, Stage, Owner, Automation, Hiring surface,
and Candidacy cluster. Do not replace them with the avoided synonyms listed in
`CONTEXT.md`.

## Specification-to-implementation flow

1. Run `to-spec` to publish an agreed specification to the GitHub tracker.
2. Run `to-tickets` to split the specification into tracer-bullet tickets with
   explicit blocking edges.
3. Triage each ticket using `docs/agents/triage-labels.md`. Apply
   `ready-for-agent` only when the ticket is fully specified and can be completed
   without a new product decision.
4. Run `implement` for one ready ticket in the dedicated worktree, branch, and
   pull-request target named by that ticket. Preserve the ticket's acceptance
   criteria as the implementation contract.
5. Run `code-review` against the ticket's fixed base before publishing. Keep its
   standards and specification findings separate, and resolve valid findings.

One ticket owns one branch and one pull request. Follow the fork integration
matrix in `AGENTS.md`; ticket-specific base and target instructions take
precedence over a generic branch convention.

## Domain and architecture flow

- Run `domain-modeling` when a change introduces or sharpens domain language or
  records an architectural decision. Update `CONTEXT.md` or the relevant ADR as
  the decision is made.
- Run `improve-codebase-architecture` for the architecture-review workflow. Its
  proposals must use the glossary and identify any ADR they would contradict.

## System-guidance boundary

Keep system-layer guidance portable. Personal scheduler configuration, absolute
machine paths, credentials, and external-orchestrator bindings belong in local
user-owned configuration, never in these repository instructions.
