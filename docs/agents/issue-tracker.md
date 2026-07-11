# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in
`giacomoguidotto/career-ops`. Use the `gh` CLI for all operations and always pass
`--repo giacomoguidotto/career-ops`; automatic repository detection resolves to
the upstream remote in this two-remote checkout.

## Conventions

- **Create an issue**: `gh issue create --repo giacomoguidotto/career-ops --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo giacomoguidotto/career-ops --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo giacomoguidotto/career-ops --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo giacomoguidotto/career-ops --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo giacomoguidotto/career-ops --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo giacomoguidotto/career-ops --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo giacomoguidotto/career-ops --comments`.
