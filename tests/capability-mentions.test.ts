import { describe, expect, it } from 'vitest'
import { mentionHint, MENTION_MARK } from '../src/core/capability-mentions.js'

const caps = { skills: ['code-review', 'create-skill'], mcpServers: ['github', 'filesystem'] }

describe('@mentions of skills, servers and agents', () => {
  it('turns @skill and @server into plain instructions', () => {
    const h = mentionHint('@code-review check this diff, and use @github for the PR', caps)!
    expect(h).toContain(MENTION_MARK)
    expect(h).toContain('skill "code-review"')
    expect(h).toContain('MCP server "github"')
  })
  it('knows @agents / @web, ignores unknown names, files and e-mail addresses', () => {
    expect(mentionHint('@agents fix all three modules', caps)).toContain('delegate')
    expect(mentionHint('@web latest node LTS?', caps)).toContain('web_search')
    expect(mentionHint('read @src/a.ts and mail me@example.com about @nobody', caps)).toBeNull()
  })
  it('matches case-insensitively, trailing punctuation included, and never adds the hint twice', () => {
    const once = 'use @Code-Review, please'
    const h = mentionHint(once, caps)!
    expect(h).toContain('code-review')
    expect(mentionHint(once + h, caps)).toBeNull()
  })
})
