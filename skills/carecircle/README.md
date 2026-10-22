# CareCircle Agent Skill

`SKILL.md` teaches an agent to use the CareCircle MCP server well. It covers how to connect,
which tool fits each request, the safety rules (no medical advice, a person's yes before any
order or booking, no URLs read aloud) and two worked examples. It follows the
[Agent Skills](https://agentskills.io/) format: YAML front matter with `name` and
`description`, then instructions.

The skill only describes how to use the server. The agent also needs the server itself
connected as an MCP server. Start it first:

```bash
cd server
npm install
npm run dev     # http://127.0.0.1:8000/mcp
```

## Claude Code

1. Copy the skill folder into your project's `.claude/skills/` (or `~/.claude/skills/` to use it
   in every project):

   ```bash
   mkdir -p .claude/skills
   cp -r skills/carecircle .claude/skills/
   ```

2. Add the server, choosing who you are with the header (`dev:rose`, `dev:sam` or `dev:maya`):

   ```bash
   claude mcp add --transport http carecircle http://127.0.0.1:8000/mcp --header "Authorization: Bearer dev:sam"
   ```

   Or use the repo's `mcp.config.json`, which has the same settings.

3. Ask "How is Mom today?". Claude Code loads the skill when a request matches its
   description.

## Kiro

1. Copy the folder into the workspace's `.kiro/skills/` (or `~/.kiro/skills/` for every
   workspace):

   ```bash
   mkdir -p .kiro/skills
   cp -r skills/carecircle .kiro/skills/
   ```

   If your Kiro version doesn't load Agent Skills yet, copy `SKILL.md` to
   `.kiro/steering/carecircle.md` instead. Kiro reads steering files as standing instructions.

2. Add the server to `.kiro/settings/mcp.json`:

   ```json
   {
     "mcpServers": {
       "carecircle": {
         "url": "http://127.0.0.1:8000/mcp",
         "headers": { "Authorization": "Bearer dev:sam" }
       }
     }
   }
   ```

## Notes

- All data in the demo family is synthetic.
- `dev:<user>` auth is for local development only. A deployed server uses real tokens, and the
  skill's tool guidance stays the same.
