import { describe, expect, it } from 'vitest'
import { DEFAULT_PATH_ARGUMENT_KEYS, extractPathArgument } from '../src/path-args.ts'

describe('path argument extraction', () => {
  it('finds each default key', () => {
    expect(extractPathArgument({ path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(extractPathArgument({ file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(extractPathArgument({ filePath: '/a/b.ts' })).toBe('/a/b.ts')
    expect(extractPathArgument({ target: '/a/b.ts' })).toBe('/a/b.ts')
  })

  it('prefers the earlier key when several are present', () => {
    expect(extractPathArgument({ target: '/second', path: '/first' })).toBe('/first')
  })

  it('returns undefined for arguments with no path-like key', () => {
    expect(extractPathArgument({ command: 'ls -la' })).toBeUndefined()
  })

  it('ignores a non-string value instead of stringifying it', () => {
    // Coercing a number would invent a path the caller never supplied and then
    // check the boundary against a fiction.
    expect(extractPathArgument({ path: 42 })).toBeUndefined()
    expect(extractPathArgument({ path: { nested: true } })).toBeUndefined()
    expect(extractPathArgument({ path: ['/a', '/b'] })).toBeUndefined()
  })

  it('ignores empty and whitespace-only strings', () => {
    expect(extractPathArgument({ path: '' })).toBeUndefined()
    expect(extractPathArgument({ path: '   ' })).toBeUndefined()
  })

  it('returns undefined for non-object arguments', () => {
    expect(extractPathArgument(undefined)).toBeUndefined()
    expect(extractPathArgument(null)).toBeUndefined()
    expect(extractPathArgument('a string')).toBeUndefined()
    expect(extractPathArgument(['path'])).toBeUndefined()
  })

  it('honours a caller-supplied key list', () => {
    expect(extractPathArgument({ cwd: '/work' }, ['cwd'])).toBe('/work')
    expect(extractPathArgument({ path: '/a' }, ['cwd'])).toBeUndefined()
  })

  it('declares the documented defaults', () => {
    expect(DEFAULT_PATH_ARGUMENT_KEYS).toEqual(['path', 'file_path', 'filePath', 'target'])
  })
})
