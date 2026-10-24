import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Outcome of a workspace boundary check. */
export type BoundaryDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/**
 * Lexically decides whether `candidate` stays inside `workspace`.
 *
 * The check is deliberately lexical: it normalises both paths and compares path
 * segments, so `workspace/../etc` is rejected without touching the filesystem.
 *
 * **Symlinks are out of scope.** A lexical check cannot see that
 * `workspace/link` points at `/etc`. Callers that need that guarantee must
 * resolve both paths with `fs.realpath` first and pass the results in. This is
 * recorded as a known limitation rather than silently implied, because a
 * boundary that claims more than it delivers is worse than one that is honest.
 *
 * Windows comparison is case-insensitive to match the filesystem, while the
 * returned paths keep the caller's original casing.
 */
export function checkWithinWorkspace(workspace: string, candidate: string): BoundaryDecision {
  if (workspace.trim().length === 0) {
    return { kind: 'deny', reason: 'the task declares no workspace, so no path is authorised' }
  }

  const workspaceAbs = normalise(resolve(workspace))
  const candidateAbs = normalise(resolve(candidate))
  const rel = relative(workspaceAbs, candidateAbs)

  if (rel === '') {
    return { kind: 'allow' }
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      kind: 'deny',
      reason: `"${candidate}" resolves outside the task workspace "${workspace}"`,
    }
  }
  // A path that climbs out and back in is still an escape attempt worth naming.
  if (rel.split(sep).includes('..')) {
    return {
      kind: 'deny',
      reason: `"${candidate}" leaves and re-enters the task workspace "${workspace}"`,
    }
  }
  return { kind: 'allow' }
}

function normalise(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}
