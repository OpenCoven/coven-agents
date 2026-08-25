import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  type AtomicWriteOperations,
  executeRoadmapStatus,
  formatRoadmapStatusError,
  type RoadmapStatusConfig,
  type RoadmapStatusDependencies,
  runRoadmapStatus,
  writeFileAtomic,
} from "./roadmap-status";
import {
  ROADMAP_STATUS_END,
  ROADMAP_STATUS_START,
  renderRoadmapStatusBlock,
} from "./roadmap-status-block";
import type { RoadmapProjectItem } from "./roadmap-status-model";
import { summarizeRoadmap } from "./roadmap-status-model";

const OLD_TIMESTAMP = "2026-08-24T12:00:00.000Z";
const NEW_TIMESTAMP = "2026-08-25T22:50:48.305Z";

function item(
  beadId: string,
  overrides: Partial<RoadmapProjectItem> = {}
): RoadmapProjectItem {
  return {
    beadId,
    blocked: "No",
    status: "Todo",
    wave: "1 - Now",
    ...overrides,
  };
}

function roadmapSource(items: readonly RoadmapProjectItem[]): string {
  const block = renderRoadmapStatusBlock(
    summarizeRoadmap(items, items.length),
    OLD_TIMESTAMP
  ).trimEnd();

  return `# Public roadmap\n\nAuthored prefix.\n\n${block}\n\nAuthored suffix.\n`;
}

function config(expectedCount = 1): RoadmapStatusConfig {
  return {
    expectedCount,
    owner: "OpenCoven",
    projectNumber: 10,
    roadmapPath: "/repo/ROADMAP.md",
  };
}

function dependencies(
  source: string,
  items: readonly RoadmapProjectItem[],
  overrides: Partial<RoadmapStatusDependencies> = {}
): RoadmapStatusDependencies {
  return {
    loadItems: () => Promise.resolve([...items]),
    now: () => new Date(NEW_TIMESTAMP),
    readFile: () => Promise.resolve(source),
    stderr: () => undefined,
    stdout: () => undefined,
    writeAtomic: () => Promise.resolve(),
    ...overrides,
  };
}

test("invalid usage and configuration return exit 2 without I/O", async () => {
  const calls = {
    load: 0,
    read: 0,
  };
  const stderr: string[] = [];
  const deps = dependencies("", [], {
    loadItems: () => {
      calls.load += 1;
      return Promise.resolve([]);
    },
    readFile: () => {
      calls.read += 1;
      return Promise.resolve("");
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });

  const argumentCodes = await Promise.all(
    [[], ["preview", "extra"], ["dry-run"], ["PREVIEW"]].map((args) =>
      runRoadmapStatus(args, config(), deps)
    )
  );
  const configCodes = await Promise.all(
    [
      { ...config(), expectedCount: 0 },
      { ...config(), expectedCount: Number.NaN },
      { ...config(), owner: "" },
      { ...config(), projectNumber: 0 },
      { ...config(), projectNumber: Number.NaN },
      { ...config(), roadmapPath: "" },
    ].map((invalidConfig) => runRoadmapStatus(["preview"], invalidConfig, deps))
  );

  assert.deepEqual(argumentCodes, [2, 2, 2, 2]);
  assert.deepEqual(configCodes, [2, 2, 2, 2, 2, 2]);
  assert.deepEqual(calls, { load: 0, read: 0 });
  assert.equal(stderr.length, 10);
  assert.ok(stderr.every((message) => !message.includes("/repo/ROADMAP.md")));
});

test("unchanged preview, check, and apply do not write or read the clock", async () => {
  const items = [item("coven-agents-product.1")];

  await Promise.all(
    (["preview", "check", "apply"] as const).map(async (mode) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let nowCalls = 0;
      let writeCalls = 0;
      const code = await runRoadmapStatus(
        [mode],
        config(),
        dependencies(roadmapSource(items), items, {
          now: () => {
            nowCalls += 1;
            return new Date(NEW_TIMESTAMP);
          },
          stderr: (text) => {
            stderr.push(text);
          },
          stdout: (text) => {
            stdout.push(text);
          },
          writeAtomic: () => {
            writeCalls += 1;
            return Promise.resolve();
          },
        })
      );

      assert.equal(code, 0);
      assert.equal(stdout.join(""), "roadmap status: unchanged\n");
      assert.equal(stderr.join(""), "");
      assert.equal(nowCalls, 0);
      assert.equal(writeCalls, 0);
    })
  );
});

test("changed preview prints aggregate counts without sensitive data", async () => {
  const current = [item("coven-agents-product.1")];
  const next = [
    item("coven-agents-product.987654", {
      blocked: "Yes",
      status: "Done",
      wave: "0 - Delivered",
    }),
  ];
  const stdout: string[] = [];
  let nowCalls = 0;
  let writeCalls = 0;

  const code = await runRoadmapStatus(
    ["preview"],
    config(),
    dependencies(roadmapSource(current), next, {
      now: () => {
        nowCalls += 1;
        return new Date(NEW_TIMESTAMP);
      },
      stdout: (text) => {
        stdout.push(text);
      },
      writeAtomic: () => {
        writeCalls += 1;
        return Promise.resolve();
      },
    })
  );
  const output = stdout.join("");

  assert.equal(code, 0);
  assert.match(output, /roadmap status: changed/);
  assert.match(output, /"totalCount":1/);
  assert.match(output, /"blockedCount":1/);
  assert.match(output, /"Done":1/);
  assert.doesNotMatch(output, /coven-agents-product|987654/);
  assert.doesNotMatch(output, /private|title|body|description/i);
  assert.doesNotMatch(output, /2026-|refreshed|timestamp/i);
  assert.equal(nowCalls, 0);
  assert.equal(writeCalls, 0);
});

test("changed check reports the exact stale message without writing", async () => {
  const current = [item("coven-agents-product.1")];
  const next = [
    item("coven-agents-product.1", {
      status: "In Progress",
    }),
  ];
  const stderr: string[] = [];
  const stdout: string[] = [];
  let writeCalls = 0;

  const code = await runRoadmapStatus(
    ["check"],
    config(),
    dependencies(roadmapSource(current), next, {
      stderr: (text) => {
        stderr.push(text);
      },
      stdout: (text) => {
        stdout.push(text);
      },
      writeAtomic: () => {
        writeCalls += 1;
        return Promise.resolve();
      },
    })
  );

  assert.equal(code, 1);
  assert.equal(stderr.join(""), "ROADMAP.md aggregate status is stale.\n");
  assert.equal(stdout.join(""), "");
  assert.equal(writeCalls, 0);
});

test("changed apply replaces one marked block with one fresh timestamp", async () => {
  const current = [item("coven-agents-product.1")];
  const next = [
    item("coven-agents-product.1", {
      blocked: "Yes",
      status: "In review",
      wave: "2 - Next",
    }),
  ];
  const source = roadmapSource(current);
  const stdout: string[] = [];
  const writes: Array<{ contents: string; path: string }> = [];
  let nowCalls = 0;

  const code = await runRoadmapStatus(
    ["apply"],
    config(),
    dependencies(source, next, {
      now: () => {
        nowCalls += 1;
        return new Date(NEW_TIMESTAMP);
      },
      stdout: (text) => {
        stdout.push(text);
      },
      writeAtomic: (path, contents) => {
        writes.push({ contents, path });
        return Promise.resolve();
      },
    })
  );

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "roadmap status: updated\n");
  assert.equal(nowCalls, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, config().roadmapPath);
  assert.match(writes[0]?.contents ?? "", new RegExp(NEW_TIMESTAMP, "u"));
  assert.equal(
    (writes[0]?.contents.match(new RegExp(ROADMAP_STATUS_START, "gu")) ?? [])
      .length,
    1
  );
  assert.equal(
    (writes[0]?.contents.match(new RegExp(ROADMAP_STATUS_END, "gu")) ?? [])
      .length,
    1
  );
  assert.ok(writes[0]?.contents.startsWith("# Public roadmap"));
  assert.ok(writes[0]?.contents.endsWith("Authored suffix.\n"));
  assert.doesNotMatch(
    writes[0]?.contents ?? "",
    new RegExp(OLD_TIMESTAMP, "u")
  );
});

test("execute catches loader, reader, and writer failures without leakage", async () => {
  const current = [item("coven-agents-product.1")];
  const changed = [
    item("coven-agents-product.1", {
      status: "Done",
      wave: "0 - Delivered",
    }),
  ];
  const scenarios: Array<{
    deps: RoadmapStatusDependencies;
    expected: string;
    secret: string;
  }> = [
    {
      deps: dependencies(roadmapSource(current), current, {
        loadItems: () =>
          Promise.reject(new Error("server secret loader response")),
      }),
      expected: "GitHub Project status query failed.\n",
      secret: "server secret loader response",
    },
    {
      deps: dependencies(roadmapSource(current), current, {
        readFile: () => Promise.reject(new Error("private reader path")),
      }),
      expected: "Roadmap status filesystem operation failed.\n",
      secret: "private reader path",
    },
    {
      deps: dependencies(roadmapSource(current), changed, {
        writeAtomic: () =>
          Promise.reject(new Error("private writer temporary filename")),
      }),
      expected: "Roadmap status filesystem operation failed.\n",
      secret: "private writer temporary filename",
    },
  ];

  await Promise.all(
    scenarios.map(async (scenario) => {
      const stderr: string[] = [];
      const code = await executeRoadmapStatus(["apply"], config(), {
        ...scenario.deps,
        stderr: (text) => {
          stderr.push(text);
        },
      });
      const output = stderr.join("");

      assert.equal(code, 1);
      assert.equal(output, scenario.expected);
      assert.doesNotMatch(output, new RegExp(scenario.secret, "u"));
    })
  );
});

test("execute reports an unexpected inventory count safely", async () => {
  const current = [item("coven-agents-product.1")];
  const stderr: string[] = [];

  const code = await executeRoadmapStatus(
    ["preview"],
    config(2),
    dependencies(roadmapSource(current), current, {
      stderr: (text) => {
        stderr.push(text);
      },
    })
  );

  assert.equal(code, 1);
  assert.equal(stderr.join(""), "Roadmap Project inventory is invalid.\n");
  assert.doesNotMatch(stderr.join(""), /expected|received|product\.1/i);
});

test("formats only safe roadmap status error categories", () => {
  let schemaError: unknown;

  try {
    z.object({ count: z.number() }).parse({
      count: "private schema value",
    });
  } catch (error) {
    schemaError = error;
  }

  assert.equal(
    formatRoadmapStatusError(schemaError),
    "Roadmap status schema validation failed."
  );
  assert.equal(
    formatRoadmapStatusError(
      new Error("Expected exactly one roadmap status marker pair")
    ),
    "ROADMAP.md status markers or data are invalid."
  );
  assert.equal(
    formatRoadmapStatusError(
      new Error("GitHub GraphQL returned private server details")
    ),
    "GitHub Project status query failed."
  );
  assert.equal(
    formatRoadmapStatusError(new Error("arbitrary private failure details")),
    "Roadmap status refresh failed."
  );
});

type TestFileHandle = Awaited<ReturnType<typeof open>>;

function fileHandle(handle: TestFileHandle) {
  return {
    close: () => handle.close(),
    sync: () => handle.sync(),
    writeFile: (contents: string) => handle.writeFile(contents, "utf8"),
  };
}

function directoryHandle(handle: TestFileHandle) {
  return {
    close: () => handle.close(),
    sync: () => handle.sync(),
  };
}

function atomicOperations(
  overrides: Partial<AtomicWriteOperations> = {}
): AtomicWriteOperations {
  return {
    openDirectory: async (path) => directoryHandle(await open(path, "r")),
    openExclusive: async (path) => fileHandle(await open(path, "wx")),
    pid: 4242,
    randomUUID: () => "test-random-uuid",
    rename,
    unlink,
    ...overrides,
  };
}

async function withTestDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), ".roadmap-status-test-"));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("default atomic writer replaces the file without leaving a temp file", async () => {
  await withTestDirectory(async (directory) => {
    const path = join(directory, "ROADMAP.md");
    await writeFile(path, "original", "utf8");

    await writeFileAtomic(path, "updated");

    assert.equal(await readFile(path, "utf8"), "updated");
    assert.deepEqual(await readdir(directory), ["ROADMAP.md"]);
  });
});

test("atomic writer cleans up and preserves the original on write failure", async () => {
  await withTestDirectory(async (directory) => {
    const path = join(directory, "ROADMAP.md");
    let tempPath = "";
    await writeFile(path, "original", "utf8");

    await assert.rejects(
      () =>
        writeFileAtomic(
          path,
          "updated",
          atomicOperations({
            openExclusive: async (candidate) => {
              tempPath = candidate;
              const handle = await open(candidate, "wx");

              return {
                ...fileHandle(handle),
                writeFile: () =>
                  Promise.reject(new Error("private write failure")),
              };
            },
          })
        ),
      /private write failure/
    );

    assert.match(tempPath, /\.ROADMAP\.md\.4242\.test-random-uuid\.tmp$/u);
    assert.equal(await readFile(path, "utf8"), "original");
    assert.deepEqual(await readdir(directory), ["ROADMAP.md"]);
  });
});

test("atomic writer cleans up and preserves the original on fsync failure", async () => {
  await withTestDirectory(async (directory) => {
    const path = join(directory, "ROADMAP.md");
    await writeFile(path, "original", "utf8");

    await assert.rejects(
      () =>
        writeFileAtomic(
          path,
          "updated",
          atomicOperations({
            openExclusive: async (candidate) => {
              const handle = await open(candidate, "wx");

              return {
                ...fileHandle(handle),
                sync: () => Promise.reject(new Error("private fsync failure")),
              };
            },
          })
        ),
      /private fsync failure/
    );

    assert.equal(await readFile(path, "utf8"), "original");
    assert.deepEqual(await readdir(directory), ["ROADMAP.md"]);
  });
});

test("atomic writer cleans up and preserves the original on rename failure", async () => {
  await withTestDirectory(async (directory) => {
    const path = join(directory, "ROADMAP.md");
    await writeFile(path, "original", "utf8");

    await assert.rejects(
      () =>
        writeFileAtomic(
          path,
          "updated",
          atomicOperations({
            rename: () => Promise.reject(new Error("private rename failure")),
          })
        ),
      /private rename failure/
    );

    assert.equal(await readFile(path, "utf8"), "original");
    assert.deepEqual(await readdir(directory), ["ROADMAP.md"]);
  });
});
