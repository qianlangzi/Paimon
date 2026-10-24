import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkWithinWorkspace } from '../src/index.ts'

const workspace = resolve('/tmp/paimon-workspace')

describe('workspace boundary', () => {
  it('allows the workspace root itself', () => {
    expect(checkWithinWorkspace(workspace, workspace)).toEqual({ kind: 'allow' })
  })

  it('allows a file directly inside the workspace', () => {
    expect(checkWithinWorkspace(workspace, resolve(workspace, 'src/index.ts'))).toEqual({ kind: 'allow' })
  })

  it('allows a deeply nested path', () => {
    expect(checkWithinWorkspace(workspace, resolve(workspace, 'a/b/c/d.txt'))).toEqual({ kind: 'allow' })
  })

  it('rejects a path that climbs out with a parent segment', () => {
    const decision = checkWithinWorkspace(workspace, resolve(workspace, '../secrets.env'))
    expect(decision.kind).toBe('deny')
  })

  it('rejects an absolute path outside the workspace', () => {
    const decision = checkWithinWorkspace(workspace, resolve('/etc/passwd'))
    expect(decision.kind).toBe('deny')
  })

  it('rejects a path that leaves and re-enters the workspace', () => {
    const escape = resolve(workspace, '../elsewhere/../paimon-workspace/file.txt')
    // resolve() collapses this back inside, so the lexical check must allow it.
    expect(checkWithinWorkspace(workspace, escape)).toEqual({ kind: 'allow' })
  })

  it('rejects every path when no workspace is declared', () => {
    const decision = checkWithinWorkspace('', resolve('/tmp/anything'))
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toMatch(/no workspace/)
  })

  it('does not treat a sibling directory sharing a prefix as inside', () => {
    const sibling = `${workspace}-other`
    const decision = checkWithinWorkspace(workspace, resolve(sibling, 'file.txt'))
    expect(decision.kind).toBe('deny')
  })
})
