# Customization Guide

## Profile (config/profile.yml)

This is the single source of truth for your identity. All modes read from here.

Key sections:
- **candidate**: Name, email, phone, location, LinkedIn, portfolio
- **target_roles**: Your North Star roles and archetypes
- **narrative**: Your headline, exit story, superpowers, proof points
- **compensation**: Target range, minimum, currency
- **location**: Country, timezone, visa status, on-site availability
- **culture_screen**: Structural criteria for team culture (the `deprioritize_if_absent` strict flag caps the culture score at 2/5 if evidence is entirely missing)

## Target Roles (modes/_profile.md)

The archetype table in `_profile.md` determines how offers are scored and CVs are framed. Edit the table to match YOUR career targets:

```markdown
| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Your Role 1** | key skills | what they need |
| **Your Role 2** | key skills | what they need |
```

Also update the "Adaptive Framing" table to map YOUR specific projects to each archetype.

## Portals (portals.yml)

Copy from `templates/portals.example.yml` and customize:

1. **title_filter.positive**: Keywords matching your target roles
2. **title_filter.negative**: Tech stacks or domains to exclude
3. **search_queries**: WebSearch queries for job boards (Ashby, Greenhouse, Lever)
4. **tracked_companies**: Companies to check directly

## CV Template (templates/cv-template.html)

The HTML template uses these design tokens:
- **Fonts**: Space Grotesk (headings) + DM Sans (body) -- self-hosted in `fonts/`
- **Colors**: Cyan primary (`hsl(187,74%,32%)`) + Purple accent (`hsl(270,70%,45%)`)
- **Layout**: Single-column, ATS-optimized

To customize fonts/colors, edit the CSS in the template. Update font files in `fonts/` if switching fonts.

## Negotiation Scripts (modes/_shared.md)

The negotiation section provides frameworks for salary discussions. Replace the example scripts with your own:
- Target ranges
- Geographic arbitrage strategy
- Pushback responses

## Hooks (Optional)

Career-ops can integrate with external systems via Claude Code hooks. Example hooks:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo 'Career-ops session started'"
      }]
    }]
  }
}
```

Save hooks in `.claude/settings.json` (Claude Code). OpenCode does not support hooks. For equivalent functionality, use custom commands (`.opencode/commands/`) or agents (`.opencode/agents/`) — see https://opencode.ai/docs/commands/.

## States (templates/states.yml)

The canonical states are the single source of truth in `templates/states.yml`.
To add or rename a state, edit that file only — every reader derives from it:

1. `templates/states.yml` — add the state (with `id`, `label`, `owner`,
   `suggests`, `next_states`, `dashboard_group`, and any legacy `aliases`).
2. Nothing else needs a status list. The Go dashboard and the Node tracker
   scripts (`tracker.mjs`, `normalize-statuses.mjs`, `merge-tracker.mjs`,
   `dedup-tracker.mjs`, `followup-cadence.mjs`) all read `states.yml` at runtime
   via the shared reader in `tracker-utils.mjs`, so they pick up the change with
   no code edits.
