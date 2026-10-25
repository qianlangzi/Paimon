/** Committed install icon dimensions and the generator's SVG crop and safe-zone scale. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_ARTWORK_SCALE, TILE_SOURCE,
  maskableDocument, tileDocument,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('crops the desktop tile group and scales only the maskable artwork', async () => {
    const source = await readFile(TILE_SOURCE, 'utf8')
    const tile = tileDocument(source)
    const maskable = maskableDocument(source)
    expect(tile).toContain('viewBox="40 32 1024 1024"')
    // The crop replaces the tile group, which is what drops a desktop shadow.
    expect(tile).not.toContain('<g id="tile">')
    expect(tile).not.toContain(`scale(${MASKABLE_ARTWORK_SCALE})`)
    expect(tile).toContain('<g id="artwork">')
    // The mark itself has to survive the crop, not just the plate: it is the one
    // element that carries the counter mask.
    expect(tile).toContain('mask="url(#counter)"')
    expect(tile).toContain(source.match(/<defs>[\s\S]*<\/defs>/u)![0])
    expect(maskable).toContain(`transform="translate(552 544) scale(${MASKABLE_ARTWORK_SCALE}) translate(-552 -544)"`)
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('fails loudly on a source without the tile it transforms', () => {
    expect(() => tileDocument('')).toThrow(/no root element/)
    expect(() => tileDocument('<svg></svg>')).toThrow(/no tile group/)
    expect(() => maskableDocument('<svg><g id="tile"></g></svg>'))
      .toThrow(/no artwork group/)
  })
})
