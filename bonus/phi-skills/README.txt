Phi Skills for Claude Code

These are Claude Code skills (https://docs.claude.com/en/docs/claude-code/skills)
that ship with phi and let Claude drive phi features — currently just the
sync-board coordinator.

To install a skill, copy its folder to ~/.claude/skills/<skill-name>/ on
the machine that runs `claude`:

    cp -r bonus/phi-skills/phi-sync-board ~/.claude/skills/

Or copy the whole tree to install every phi skill at once:

    cp -r bonus/phi-skills/* ~/.claude/skills/

Restart Claude Code after installing so the skills load.

Before using a skill, edit its SKILL.md and replace the `<phi-coordinator>`
placeholder with your own phi server's coordinator address. See the skill's
own README for how to find that address (it differs per machine and per
network setup — tailnet IP, LAN IP, or localhost).
