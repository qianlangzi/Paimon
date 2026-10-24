#!/usr/bin/env node
/**
 * Installs the Paimon overlay into a dsh profile's own patch layer.
 *
 * Why a script rather than "just edit the file": the profile patch at
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml` is user state, and the overlay
 * in this repository is the reviewable source of truth. Copying by hand drifts;
 * this keeps one command between them.
 *
 * The script refuses to overwrite a patch file that contains entries it did not
 * write, because a profile layer may hold the user's own overrides and silently
 * replacing them would be destructive.
 *
 *   node packages/paimon/profile/install.mjs [--profile paimon] [--dsh-home <dir>]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const overlayPath = join(here, 'cordis.patch.yml')

/** Marker that identifies a patch file this script owns. */
const MARKER = '# --- paimon overlay (managed by packages/paimon/profile/install.mjs) ---'

/**
 * Whether a patch file carries no entries.
 *
 * A fresh profile ships a commented-out template ending in `[]`, so "is this
 * file ours to replace" cannot be a plain string comparison against `[]` —
 * comment lines have to be discarded first.
 */
function isEffectivelyEmpty(text) {
  const meaningful = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .join('')
  return meaningful.length === 0 || meaningful === '[]'
}

function parseArgs(argv) {  const options = { profile: 'paimon', dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`install.mjs: ${error.message}`)
    process.exit(1)
  }
  if (options.help) {
    console.log('usage: node packages/paimon/profile/install.mjs [--profile <name>] [--dsh-home <dir>]')
    return
  }

  const profileDir = resolve(options.dshHome, 'profiles', options.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  if (!existsSync(profileDir)) {
    console.error(`install.mjs: no profile at ${profileDir}`)
    console.error('Create one first, for example:')
    console.error(`  dsh --profile ${options.profile} --from-default-profile headless --dump-config`)
    process.exit(1)
  }

  const overlay = readFileSync(overlayPath, 'utf8')
  const body = `${MARKER}\n${overlay.trimEnd()}\n`

  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const owned = existing.includes(MARKER) || isEffectivelyEmpty(existing)

  if (!owned) {
    console.error(`install.mjs: ${patchPath} already contains entries this script did not write.`)
    console.error('Merge these rows into it by hand instead of letting the script replace them:')
    console.error('')
    console.error(overlay.trimEnd())
    process.exit(2)
  }

  mkdirSync(profileDir, { recursive: true })
  writeFileSync(patchPath, body, 'utf8')
  console.log(`installed the Paimon overlay into ${patchPath}`)
  console.log(`boot it with: dsh --profile ${options.profile}`)
}

main()
