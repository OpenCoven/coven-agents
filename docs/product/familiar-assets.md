# Familiar portrait production

Familiar portraits are authored offline and shipped as small static WebP files.
The console never downloads models, initializes WebGL, or calls an image
generation service, so each portrait has no per-view generation cost and adds
no client-side 3D runtime.

## Authoring workflow

1. Establish the silhouette, materials, expression, and role cues with an image
   generation or concept-art tool. Keep a record of the approved prompt,
   references, and usage rights outside the application repository.
2. Refine approved concepts in Blender or ZBrush. Use Substance 3D Painter when
   custom materials materially improve the result. Render the final portrait in
   Blender; use Unreal only when its lighting or scene tools justify the added
   setup.
3. Export one opaque, color-managed PNG, TIFF, JPEG, or WebP per familiar. Each
   source must be at least 1024 pixels on both axes and include enough safe area
   for a centered square crop.
4. Name the files after the familiar IDs:
   `builder`, `critic`, `custom`, `scout`, `scribe`, and `tester`. The pipeline
   rejects missing IDs, duplicate IDs, and unsupported extra portraits.
5. Build the application assets from the directory containing those sources:

   ```bash
   pnpm familiar:assets --source-dir /path/to/approved-familiar-renders
   ```

6. Review the six resulting portraits together at their actual interface sizes,
   then commit the WebP files and
   `components/console/familiar-assets/manifest.json`.

Large layered source files and renders are not committed to this repository.
Store them in the team's approved creative archive with their prompt and
license records. Only approved, reproducible exports cross into the application
repository.

## Output contract

The pipeline normalizes EXIF orientation, crops with content-aware attention,
flattens transparency onto the console's dark portrait ground, converts to
sRGB, strips source metadata, and emits deterministic 512 by 512 WebP files.
Output names are stable because they are imported directly by
`components/console/familiar-portrait.tsx`.

Each portrait must remain at or below 20,000 bytes, and the six-file collection
must remain at or below 100,000 bytes. The manifest records dimensions, file
size, and SHA-256 checksum for every portrait. `pnpm check` runs:

```bash
pnpm familiar:assets:check
```

That check rejects format, dimensions, color-space, transparency, inventory,
performance-budget, checksum, or manifest drift. If a high-detail source cannot
meet the budget cleanly, simplify noisy backgrounds and micro-texture before
lowering visual quality.

## Art direction checklist

- Preserve the familiar's established species, name, and role identity from
  `lib/console/familiars.ts`.
- Use a readable head-and-shoulders silhouette with the eyes and defining
  materials clear at 30 pixels.
- Keep lighting, camera height, crop, and background value coherent across the
  complete set.
- Avoid text, logos, thin edge details, baked UI chrome, and meaningful content
  near the crop boundary.
- Confirm the custom Unbound portrait leaves its lower monogram readable.
- Review light and dark displays for blocked shadows, clipped highlights,
  color casts, and visible compression artifacts.

## Integration checklist

- Run the build command from approved source exports.
- Inspect the generated diff and confirm only intended portraits and manifest
  entries changed.
- Check each portrait in Forge, the run console, and the familiar picker at
  desktop and mobile sizes.
- Run the repository's required local merge gates before opening or merging the
  pull request.
