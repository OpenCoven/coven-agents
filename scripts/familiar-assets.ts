import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { FAMILIARS } from "@/lib/console/familiars";

type FamiliarAssetId = keyof typeof FAMILIARS;

export const FAMILIAR_ASSET_IDS = Object.freeze(
  Object.keys(FAMILIARS).sort() as FamiliarAssetId[]
);

export const FAMILIAR_ASSET_LIMITS = Object.freeze({
  collectionBytes: 100_000,
  outputPixels: 512,
  portraitBytes: 20_000,
  sourcePixels: 1024,
});

type FamiliarAssetManifestEntry = Readonly<{
  bytes: number;
  format: "webp";
  height: number;
  id: FamiliarAssetId;
  sha256: string;
  width: number;
}>;

export type FamiliarAssetManifest = Readonly<{
  assets: readonly FamiliarAssetManifestEntry[];
  limits: typeof FAMILIAR_ASSET_LIMITS;
  totalBytes: number;
  version: 1;
}>;

type FamiliarAssetPaths = Readonly<{
  manifestPath: string;
  outputDirectory: string;
}>;

type BuildFamiliarAssetPaths = FamiliarAssetPaths &
  Readonly<{
    sourceDirectory: string;
  }>;

const SOURCE_EXTENSIONS = new Set([
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const MANIFEST_FILENAME = "manifest.json";

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEntryWithinBudget(entry: FamiliarAssetManifestEntry): void {
  if (
    entry.width !== FAMILIAR_ASSET_LIMITS.outputPixels ||
    entry.height !== FAMILIAR_ASSET_LIMITS.outputPixels
  ) {
    throw new Error(
      `${entry.id} must be ${FAMILIAR_ASSET_LIMITS.outputPixels}x${FAMILIAR_ASSET_LIMITS.outputPixels} pixels.`
    );
  }
  if (entry.format !== "webp") {
    throw new Error(`${entry.id} must be encoded as WebP.`);
  }
  if (entry.bytes > FAMILIAR_ASSET_LIMITS.portraitBytes) {
    throw new Error(
      `${entry.id} is ${entry.bytes} bytes; the per-portrait budget is ${FAMILIAR_ASSET_LIMITS.portraitBytes}.`
    );
  }
}

async function inspectOutput(
  id: FamiliarAssetId,
  filename: string
): Promise<FamiliarAssetManifestEntry> {
  const bytes = await readFile(filename);
  const metadata = await sharp(bytes).metadata();
  if (
    metadata.format !== "webp" ||
    metadata.width === undefined ||
    metadata.height === undefined
  ) {
    throw new Error(`${id} is not a readable WebP portrait.`);
  }
  if (metadata.space !== "srgb") {
    throw new Error(`${id} must use the sRGB color space.`);
  }
  if (metadata.hasAlpha) {
    throw new Error(`${id} must be opaque.`);
  }

  const entry: FamiliarAssetManifestEntry = {
    bytes: bytes.byteLength,
    format: "webp",
    height: metadata.height,
    id,
    sha256: checksum(bytes),
    width: metadata.width,
  };
  assertEntryWithinBudget(entry);
  return entry;
}

export async function createFamiliarAssetManifest({
  outputDirectory,
}: Pick<
  FamiliarAssetPaths,
  "outputDirectory"
>): Promise<FamiliarAssetManifest> {
  const files = (await readdir(outputDirectory)).sort();
  const expected = FAMILIAR_ASSET_IDS.map((id) => `${id}.webp`).sort();
  const portraitFiles = files.filter((file) => file !== MANIFEST_FILENAME);
  if (
    portraitFiles.length !== expected.length ||
    portraitFiles.some((file, index) => file !== expected[index])
  ) {
    throw new Error(
      `Familiar output inventory must be exactly: ${expected.join(", ")}.`
    );
  }

  const assets = await Promise.all(
    FAMILIAR_ASSET_IDS.map((id) =>
      inspectOutput(id, path.join(outputDirectory, `${id}.webp`))
    )
  );
  const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0);
  if (totalBytes > FAMILIAR_ASSET_LIMITS.collectionBytes) {
    throw new Error(
      `Familiar portraits total ${totalBytes} bytes; the collection budget is ${FAMILIAR_ASSET_LIMITS.collectionBytes}.`
    );
  }

  return {
    assets,
    limits: FAMILIAR_ASSET_LIMITS,
    totalBytes,
    version: 1,
  };
}

function serializeManifest(manifest: FamiliarAssetManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function sourceFiles(
  sourceDirectory: string
): Promise<ReadonlyMap<FamiliarAssetId, string>> {
  const files = await readdir(sourceDirectory);
  const found = new Map<FamiliarAssetId, string>();
  for (const file of files) {
    const sourceExtension = path.extname(file);
    if (!SOURCE_EXTENSIONS.has(sourceExtension.toLowerCase())) {
      continue;
    }
    const id = path.basename(file, sourceExtension);
    if (!FAMILIAR_ASSET_IDS.includes(id as FamiliarAssetId)) {
      throw new Error(`Unsupported familiar source file: ${file}.`);
    }
    if (found.has(id as FamiliarAssetId)) {
      throw new Error(`Multiple source files found for ${id}.`);
    }
    found.set(id as FamiliarAssetId, path.join(sourceDirectory, file));
  }

  for (const id of FAMILIAR_ASSET_IDS) {
    if (!found.has(id)) {
      throw new Error(`Missing source file for ${id}.`);
    }
  }
  return found;
}

async function validateSource(id: FamiliarAssetId, filename: string) {
  const metadata = await sharp(filename).metadata();
  if (
    metadata.width === undefined ||
    metadata.height === undefined ||
    metadata.width < FAMILIAR_ASSET_LIMITS.sourcePixels ||
    metadata.height < FAMILIAR_ASSET_LIMITS.sourcePixels
  ) {
    throw new Error(
      `${id} source must be at least ${FAMILIAR_ASSET_LIMITS.sourcePixels} pixels on both axes.`
    );
  }
}

function requiredSource(
  sources: ReadonlyMap<FamiliarAssetId, string>,
  id: FamiliarAssetId
): string {
  const source = sources.get(id);
  if (!source) {
    throw new Error(`Missing source file for ${id}.`);
  }
  return source;
}

export async function buildFamiliarAssets({
  manifestPath,
  outputDirectory,
  sourceDirectory,
}: BuildFamiliarAssetPaths): Promise<FamiliarAssetManifest> {
  const expectedManifestPath = path.join(outputDirectory, MANIFEST_FILENAME);
  if (path.resolve(manifestPath) !== path.resolve(expectedManifestPath)) {
    throw new Error(
      `The familiar manifest must be published at ${expectedManifestPath}.`
    );
  }

  const sources = await sourceFiles(sourceDirectory);
  await Promise.all(
    FAMILIAR_ASSET_IDS.map((id) =>
      validateSource(id, requiredSource(sources, id))
    )
  );
  const outputParent = path.dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(outputParent, ".familiar-assets-build-")
  );
  const backupDirectory = `${stagingDirectory}-previous`;
  let previousCollectionMoved = false;

  try {
    const renderResults = await Promise.allSettled(
      FAMILIAR_ASSET_IDS.map(async (id) => {
        const target = path.join(stagingDirectory, `${id}.webp`);
        await sharp(requiredSource(sources, id))
          .rotate()
          .resize(
            FAMILIAR_ASSET_LIMITS.outputPixels,
            FAMILIAR_ASSET_LIMITS.outputPixels,
            {
              fit: "cover",
              position: "attention",
            }
          )
          .flatten({ background: "#17171a" })
          .toColourspace("srgb")
          .webp({
            effort: 6,
            quality: 82,
            smartSubsample: true,
          })
          .toFile(target);
        await inspectOutput(id, target);
      })
    );
    const renderFailure = renderResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (renderFailure) {
      throw renderFailure.reason;
    }

    const manifest = await createFamiliarAssetManifest({
      outputDirectory: stagingDirectory,
    });
    const stagedManifestPath = path.join(stagingDirectory, MANIFEST_FILENAME);
    await writeFile(stagedManifestPath, serializeManifest(manifest));
    await validateFamiliarAssets({
      manifestPath: stagedManifestPath,
      outputDirectory: stagingDirectory,
    });

    try {
      await rename(outputDirectory, backupDirectory);
      previousCollectionMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await rename(stagingDirectory, outputDirectory);
    } catch (error) {
      if (previousCollectionMoved) {
        await rename(backupDirectory, outputDirectory);
        previousCollectionMoved = false;
      }
      throw error;
    }

    if (previousCollectionMoved) {
      try {
        await rm(backupDirectory, { recursive: true });
      } catch (error) {
        console.warn(
          `Familiar assets were published, but the previous collection remains at ${backupDirectory}:`,
          error
        );
      }
      previousCollectionMoved = false;
    }

    return manifest;
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

export async function validateFamiliarAssets({
  manifestPath,
  outputDirectory,
}: FamiliarAssetPaths): Promise<void> {
  const expected = JSON.parse(
    await readFile(manifestPath, "utf8")
  ) as FamiliarAssetManifest;
  await Promise.all(
    expected.assets.map(async (asset) => {
      const bytes = await readFile(
        path.join(outputDirectory, `${asset.id}.webp`)
      );
      if (checksum(bytes) !== asset.sha256) {
        throw new Error(`${asset.id} checksum does not match the manifest.`);
      }
    })
  );
  const actual = await createFamiliarAssetManifest({ outputDirectory });
  if (serializeManifest(actual) !== serializeManifest(expected)) {
    throw new Error("Familiar asset manifest is stale.");
  }
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: readonly string[]): Promise<void> {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const outputDirectory = path.join(
    repositoryRoot,
    "components/console/familiar-assets"
  );
  const manifestPath = path.join(outputDirectory, MANIFEST_FILENAME);
  const [command] = args;

  if (command === "check") {
    await validateFamiliarAssets({ manifestPath, outputDirectory });
    console.log(
      "Familiar assets match their manifest and performance budgets."
    );
    return;
  }
  if (command === "build") {
    const sourceDirectory = argument(args, "--source-dir");
    if (!sourceDirectory) {
      throw new Error(
        "Usage: pnpm familiar:assets --source-dir <source-directory>"
      );
    }
    const manifest = await buildFamiliarAssets({
      manifestPath,
      outputDirectory,
      sourceDirectory: path.resolve(sourceDirectory),
    });
    console.log(
      `Built ${manifest.assets.length} familiar portraits (${manifest.totalBytes} bytes).`
    );
    return;
  }
  throw new Error("Usage: pnpm familiar:assets <check|build>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
