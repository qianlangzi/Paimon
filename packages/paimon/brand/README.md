# Paimon brand assets

The artwork itself lives where the build reads it — `apps/desktop/resources/`
and `apps/web/public/` — because those paths are the contract the desktop shell,
the installer and the Web manifest already share. This directory only records
what the mark is and how to regenerate its rasters.

## The mark

A geometric uppercase **P**: an 84-unit stem and an elliptical bowl (118 × 142
outer, 56 × 68 counter) whose counter is tangent to the stem's right edge, drawn
in a 284 × 520 space and scaled to 62 % of the tile height. Dark `#14161B → #262932`
on a light `#FFFFFF → #EDEFF5` plate.

Three properties are deliberate:

- **No letterform ambiguity.** A circular bowl on a full-height stem reads as a
  lowercase *p*; the oval bowl is what makes it an uppercase P at every size.
- **Legible at 16 px.** The mark occupies 62 % of the tile, so the Windows tray
  and the taskbar still show a P rather than a smudge. `tray-windows.ico` ships
  seven sizes, each rasterized from the vector rather than downscaled from one
  bitmap.
- **Comfortably inside a mask.** The mark reaches 0.346 of the tile edge from
  the centre, well inside the 0.4 circle a platform mask is guaranteed to show,
  so a maskable launcher icon needs no rescue scaling.

## Regenerating

The vector sources are the truth; every raster is derived. After editing one:

```bash
# desktop PNGs (icon.png, icon-macos.png, icon-windows.png) from their SVGs
cd apps/desktop && pnpm run render:app-icon

# Windows tray .ico, from the `tray-glyph` group in icon-windows.svg
cd apps/desktop && pnpm run render:tray-icon

# Web install icons (192/512/maskable/apple-touch) from icon.svg
pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons
```

`favicon.svg` and `favicon-dark.svg` are hand-written and must differ in exactly
one thing — the fill — because the PWA spec asserts that they are each other's
inverse. The mask's counter therefore uses the named colour `black`, which the
swap does not touch.

Two groups are addressed by id and must stay in every tile source:

| id | meaning |
|---|---|
| `tile` | the plate. The Web icon crop replaces it, which is what drops a desktop shadow |
| `artwork` | the mark. The only element a maskable icon scales |

`icon-windows.svg` additionally carries `tray-glyph` around the mark, which the
tray renderer enlarges while keeping the plate behind it.
