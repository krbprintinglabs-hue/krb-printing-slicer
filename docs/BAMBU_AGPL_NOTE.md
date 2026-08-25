# AGPL-3.0 Compliance Note — Bambu Studio backend (migration branch)

## What we run
Bambu Studio **v02.08.02.61**, the official **unmodified** AppImage published by
Bambu Lab (github.com/bambulab/BambuStudio releases), executed as a separate
CLI process: `bambu-studio --slice 0 --load-settings … --export-3mf … model.stl`.

## License
Bambu Studio is licensed under **GNU Affero General Public License v3.0**
(AGPL-3.0), confirmed via the repository license metadata (`LICENSE`).

## Why our worker code is unaffected
- We invoke Bambu Studio as an independent program over its command line
  ("mere aggregation"). AGPL does not extend to works merely aggregated with
  the covered work, so this repository's proprietary worker code carries no
  copyleft obligation from that invocation alone.
- AGPL §13 (remote network interaction → offer source) applies when a
  **modified** version of the covered work offers network interaction. We run
  the binary unmodified and do not expose Bambu Studio itself over a network.

## Obligations we accept
1. Keep the binary unmodified. Any future patch/fork of Bambu Studio used in
   this pipeline triggers §13 obligations for users of the corresponding
   service, including offering that modified source.
2. Preserve upstream copyright/license notices in distribution artifacts we
   control (this note serves as that pointer).
3. Record the exact pinned version in the workflow
   (`v02.08.02.61`) so the running build is always auditable.

## Provenance
- Download URL recorded in `.github/workflows/slice.yml`
  (release asset `BambuStudio_ubuntu24.04-v02.08.02.61-*AppImage`).
- Integrity: cache key pins the exact version/build; verification step runs
  `--help` before use; corruption forces re-download of the same pinned asset.

Reviewed: migration branch `bambu-migration`, backend selectable via
`SLICER_BACKEND` / workflow input `backend` (default `prusa`).
