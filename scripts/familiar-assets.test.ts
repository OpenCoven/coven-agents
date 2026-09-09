import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  buildFamiliarAssets,
  FAMILIAR_ASSET_IDS,
  validateFamiliarAssets,
} from "./familiar-assets";

async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "coven-familiar-assets-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return {
    manifestPath: path.join(root, "output", "manifest.json"),
    outputDirectory: path.join(root, "output"),
    root,
    sourceDirectory: path.join(root, "source"),
  };
}

async function writeSources(
  sourceDirectory: string,
  size = 1200
): Promise<void> {
  await Promise.all(
    FAMILIAR_ASSET_IDS.map((id, index) =>
      sharp({
        create: {
          background: {
            alpha: 1,
            b: 90 + index * 10,
            g: 50 + index * 12,
            r: 30 + index * 15,
          },
          channels: 4,
          height: size + index * 20,
          width: size + index * 30,
        },
      })
        .png()
        .toFile(path.join(sourceDirectory, `${id}.png`))
    )
  );
}

async function writeAggregateBudgetBreakingSources(
  sourceDirectory: string
): Promise<void> {
  await Promise.all(
    FAMILIAR_ASSET_IDS.map((id, familiarIndex) => {
      const pixels = Buffer.alloc(20 * 20 * 3);
      let state = 123_456_789 + familiarIndex;
      for (let index = 0; index < pixels.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        pixels[index] = state >>> 24;
      }
      return sharp(pixels, {
        raw: {
          channels: 3,
          height: 20,
          width: 20,
        },
      })
        .resize(1200, 1200, { kernel: "nearest" })
        .png()
        .toFile(path.join(sourceDirectory, `${id}.png`));
    })
  );
}

test("builds deterministic square WebP portraits and a checksummed manifest", async (t) => {
  const paths = await workspace(t);
  await mkdir(paths.sourceDirectory, { recursive: true });
  await writeSources(paths.sourceDirectory);

  const first = await buildFamiliarAssets(paths);
  const firstManifest = await readFile(paths.manifestPath, "utf8");
  const second = await buildFamiliarAssets(paths);

  assert.deepEqual(second, first);
  assert.equal(await readFile(paths.manifestPath, "utf8"), firstManifest);
  assert.deepEqual(
    first.assets.map((asset) => asset.id),
    [...FAMILIAR_ASSET_IDS]
  );
  assert.ok(first.assets.every((asset) => asset.format === "webp"));
  assert.ok(first.assets.every((asset) => asset.height === 512));
  assert.ok(first.assets.every((asset) => asset.width === 512));
  assert.ok(first.assets.every((asset) => asset.bytes <= 20_000));
  assert.ok(first.totalBytes <= 100_000);
  await validateFamiliarAssets({
    manifestPath: paths.manifestPath,
    outputDirectory: paths.outputDirectory,
  });
});

test("rejects sources below the production resolution floor", async (t) => {
  const paths = await workspace(t);
  await mkdir(paths.sourceDirectory, { recursive: true });
  await writeSources(paths.sourceDirectory);
  await sharp({
    create: {
      background: "#123456",
      channels: 3,
      height: 800,
      width: 800,
    },
  })
    .png()
    .toFile(path.join(paths.sourceDirectory, "builder.png"));

  await assert.rejects(
    buildFamiliarAssets(paths),
    /builder.*at least 1024 pixels/u
  );
});

test("accepts supported source extensions regardless of case", async (t) => {
  const paths = await workspace(t);
  await mkdir(paths.sourceDirectory, { recursive: true });
  await writeSources(paths.sourceDirectory);
  await rename(
    path.join(paths.sourceDirectory, "builder.png"),
    path.join(paths.sourceDirectory, "builder.PNG")
  );

  await buildFamiliarAssets(paths);
  await validateFamiliarAssets({
    manifestPath: paths.manifestPath,
    outputDirectory: paths.outputDirectory,
  });
});

test("detects output changes that do not match the manifest", async (t) => {
  const paths = await workspace(t);
  await mkdir(paths.sourceDirectory, { recursive: true });
  await writeSources(paths.sourceDirectory);
  await buildFamiliarAssets(paths);
  await writeFile(
    path.join(paths.outputDirectory, "critic.webp"),
    Buffer.from("changed")
  );

  await assert.rejects(
    validateFamiliarAssets({
      manifestPath: paths.manifestPath,
      outputDirectory: paths.outputDirectory,
    }),
    /critic.*checksum/u
  );
});

test("preserves the published collection when aggregate validation fails", async (t) => {
  const paths = await workspace(t);
  await mkdir(paths.sourceDirectory, { recursive: true });
  await writeSources(paths.sourceDirectory);
  await buildFamiliarAssets(paths);
  const publishedPortrait = await readFile(
    path.join(paths.outputDirectory, "builder.webp")
  );
  const publishedManifest = await readFile(paths.manifestPath);

  await writeAggregateBudgetBreakingSources(paths.sourceDirectory);

  await assert.rejects(buildFamiliarAssets(paths), /collection budget/u);
  assert.deepEqual(
    await readFile(path.join(paths.outputDirectory, "builder.webp")),
    publishedPortrait
  );
  assert.deepEqual(await readFile(paths.manifestPath), publishedManifest);
  assert.equal(
    (await readdir(paths.root)).some((entry) =>
      entry.startsWith(".familiar-assets-build-")
    ),
    false
  );
});
