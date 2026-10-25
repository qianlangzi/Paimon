/**
 * Render the desktop application icons from their vector sources.
 *
 * The three committed PNGs used to be exports nobody could reproduce: the
 * sources were in the repository but the rasterization step was not, so any
 * artwork change meant a manual trip through a design tool and a guess at the
 * size. This keeps the PNGs derived from the SVGs the way the tray bitmap
 * already is, and it is what makes a rebrand a two-minute edit instead of an
 * afternoon.
 *
 * The committed PNGs are the output; rerun `pnpm run render:app-icon` in
 * `apps/desktop` after changing a vector source.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** One vector source and the bitmap the desktop shell ships. */
export interface AppIconTarget {
  /** SVG file, relative to `apps/desktop/resources`. */
  readonly source: string
  /** PNG file, relative to `apps/desktop/resources`. */
  readonly output: string
  /** Edge length of the emitted bitmap, in pixels. */
  readonly edge: number
  /** Edge length of the source viewBox, which sharp's density is scaled against. */
  readonly sourceEdge: number
}

/**
 * The shipped set. `icon.png` is 1104 square because its source keeps the drop
 * shadow band around the 1024 tile; the platform variants crop to their own grid.
 */
export const APP_ICON_TARGETS: readonly AppIconTarget[] = [
  { source: 'icon.svg', output: 'icon.png', edge: 1104, sourceEdge: 1104 },
  { source: 'icon-macos.svg', output: 'icon-macos.png', edge: 1024, sourceEdge: 1024 },
  { source: 'icon-windows.svg', output: 'icon-windows.png', edge: 1024, sourceEdge: 1024 },
]

/** Density at which the source's own 1:1 scale renders. */
const SOURCE_DENSITY = 72

/**
 * Rasterize one source into its bitmap.
 * @param target - the source/output pair to render.
 * @returns the PNG bytes.
 */
export async function renderAppIcon(target: AppIconTarget): Promise<Buffer> {
  const path = (rel: string): string => fileURLToPath(new URL(`../resources/${rel}`, import.meta.url))
  const svg = await readFile(path(target.source))
  return sharp(svg, { density: SOURCE_DENSITY * target.edge / target.sourceEdge })
    .resize(target.edge, target.edge)
    .png()
    .toBuffer()
}

async function main(): Promise<void> {
  for (const target of APP_ICON_TARGETS) {
    const png = await renderAppIcon(target)
    await writeFile(fileURLToPath(new URL(`../resources/${target.output}`, import.meta.url)), png)
    console.info(`app icon: wrote ${target.output} at ${target.edge}x${target.edge} from ${target.source}`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
