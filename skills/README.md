# Agent skills

Three [Agent Skills](https://agentskills.io) for working with spintax — the same files spintax.net publishes
at [`/.well-known/agent-skills/`](https://spintax.net/.well-known/agent-skills/index.json).

| Skill | Use it for |
| --- | --- |
| [`spintax-authoring`](spintax-authoring/SKILL.md) | turning finished copy into a template that stays grammatical in every variant |
| [`spintax-syntax`](spintax-syntax/SKILL.md) | writing and debugging the constructs themselves |
| [`spintax-engines`](spintax-engines/SKILL.md) | installing and calling an engine from JavaScript, PHP, Python, Object Pascal or .NET |

Install all three into Claude Code, Codex, Cursor and the other agents the
[`skills`](https://github.com/vercel-labs/skills) command supports:

```sh
npx skills add https://spintax.net      # straight from the site
npx skills add investblog/spintax-js    # from this repository
```

These are copies. The site is the source: a skill changes there first, and a test on the site's side fails
until the copy here matches it.
