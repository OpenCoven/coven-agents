import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError, SnapshotState } from "@daytona/sdk";
import {
  DAYTONA_PROVIDER_RESOURCE_MAXIMA,
  DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
  DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
} from "./config";
import {
  createDaytonaBuildLogSanitizer,
  createDaytonaCopilotImage,
  createDaytonaSnapshotDefinition,
  DAYTONA_BUILD_LOG_MAX_CHARACTERS,
  DAYTONA_COPILOT_IMAGE_BASE,
  DAYTONA_COPILOT_SNAPSHOT_NAME,
  DAYTONA_DEFAULT_API_URL,
  DAYTONA_DEFAULT_TARGET,
  type DaytonaSnapshot,
  type DaytonaSnapshotConfiguration,
  type DaytonaSnapshotService,
  daytonaClientConfiguration,
  daytonaHarnessInstallSpecifiers,
  daytonaSnapshotConfiguration,
  PNPM_VERSION,
  provisionDaytonaSnapshot,
  sanitizeDaytonaBuildLog,
  verifyDaytonaSnapshot,
  WORKSPACE_DIRECTORY,
} from "./image";
import { assertReplacementSnapshotReady } from "./sandbox";

const API_KEY = "daytona-api-key-for-test";
const configuration: DaytonaSnapshotConfiguration = {
  apiKey: API_KEY,
  apiUrl: "https://app.daytona.io/api",
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: DAYTONA_COPILOT_SNAPSHOT_NAME,
  target: "us",
};

function environment(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function missingSnapshot(): DaytonaNotFoundError {
  return new DaytonaNotFoundError("Snapshot not found", 404);
}

function activeSnapshot(): DaytonaSnapshot {
  return {
    cpu: 2,
    disk: 10,
    mem: 4,
    name: DAYTONA_COPILOT_SNAPSHOT_NAME,
    state: SnapshotState.ACTIVE,
  };
}

test("defines the pinned Copilot CLI snapshot image exactly", () => {
  const image = createDaytonaCopilotImage();
  const definition = createDaytonaSnapshotDefinition(configuration);

  assert.equal(
    image.dockerfile,
    [
      `FROM ${DAYTONA_COPILOT_IMAGE_BASE}`,
      `RUN npm install --global pnpm@${PNPM_VERSION} ${daytonaHarnessInstallSpecifiers().join(" ")}`,
      `RUN mkdir --parents ${WORKSPACE_DIRECTORY}`,
      `WORKDIR ${WORKSPACE_DIRECTORY}`,
      "",
    ].join("\n")
  );
  assert.equal(image.contextList.length, 0);
  assert.equal(definition.name, DAYTONA_COPILOT_SNAPSHOT_NAME);
  assert.equal(definition.image.dockerfile, image.dockerfile);
  assert.equal(image.dockerfile.includes("apt-get"), false);
});

/**
 * Snapshots are immutable and `provisionDaytonaSnapshot` refuses to recreate
 * an existing name, so a pin bump that reuses the generation leaves the old
 * CLI baked into the snapshot while discovery reports the new version. This
 * pairs both halves in one literal: change either and this fails, and the fix
 * is to bump the generation and provision a new snapshot.
 */
test("pins the harness versions to the snapshot generation", () => {
  assert.deepEqual(
    {
      harnesses: daytonaHarnessInstallSpecifiers(),
      snapshot: DAYTONA_COPILOT_SNAPSHOT_NAME,
    },
    {
      harnesses: ["@github/copilot@1.0.80"],
      // Generation 2 bakes the resource policy into the snapshot. Generation 1
      // was built without resources, so it carries Daytona's defaults
      // (1 vCPU / 1 GiB / 3 GiB) and every sandbox from it drifts below policy.
      snapshot: "coven-agents-copilot-2",
    }
  );
});

test("validates Daytona snapshot configuration and passes API URL, key, and target", () => {
  assert.throws(
    () => daytonaSnapshotConfiguration(environment()),
    /Missing required Daytona environment variable: DAYTONA_API_KEY\./u
  );
  assert.throws(
    () =>
      daytonaSnapshotConfiguration(
        environment({
          DAYTONA_API_KEY: API_KEY,
          DAYTONA_API_URL: "http://daytona.test/api",
          DAYTONA_SNAPSHOT: DAYTONA_COPILOT_SNAPSHOT_NAME,
          DAYTONA_TARGET: "us",
        })
      ),
    /DAYTONA_API_URL must be an absolute HTTPS URL\./u
  );
  assert.throws(
    () =>
      daytonaSnapshotConfiguration(
        environment({
          DAYTONA_API_KEY: API_KEY,
          DAYTONA_API_URL: configuration.apiUrl,
          DAYTONA_SNAPSHOT: "coven-agents-copilot-latest",
          DAYTONA_TARGET: "moon",
        })
      ),
    /DAYTONA_TARGET must be "us" or "eu"\./u
  );
  assert.throws(
    () =>
      daytonaSnapshotConfiguration(
        environment({
          DAYTONA_API_KEY: API_KEY,
          DAYTONA_API_URL: configuration.apiUrl,
          DAYTONA_SNAPSHOT: "coven-agents-copilot-latest",
          DAYTONA_TARGET: "us",
        })
      ),
    /DAYTONA_SNAPSHOT must be a versioned coven-agents-copilot-N name\./u
  );
  assert.throws(
    () =>
      daytonaSnapshotConfiguration(
        environment({
          DAYTONA_API_KEY: API_KEY,
          DAYTONA_API_URL: configuration.apiUrl,
          DAYTONA_SNAPSHOT: `coven-agents-copilot-${"1".repeat(65)}`,
          DAYTONA_TARGET: "us",
        })
      ),
    /DAYTONA_SNAPSHOT must be a versioned coven-agents-copilot-N name\./u
  );

  const configured = daytonaSnapshotConfiguration(
    environment({
      DAYTONA_API_KEY: API_KEY,
      DAYTONA_API_URL: configuration.apiUrl,
      DAYTONA_SNAPSHOT: configuration.snapshotName,
      DAYTONA_TARGET: configuration.target,
    })
  );

  assert.deepEqual(configured, configuration);
  assert.deepEqual(daytonaClientConfiguration(configured), {
    apiKey: API_KEY,
    apiUrl: configuration.apiUrl,
    target: "us",
  });
});

test("defaults blank endpoint and target through the shared Daytona parser", () => {
  const defaulted = daytonaSnapshotConfiguration(
    environment({
      DAYTONA_API_KEY: API_KEY,
      DAYTONA_API_URL: "  ",
      DAYTONA_SNAPSHOT: configuration.snapshotName,
      DAYTONA_TARGET: "",
    })
  );

  assert.deepEqual(defaulted, {
    ...configuration,
    apiUrl: DAYTONA_DEFAULT_API_URL,
    target: DAYTONA_DEFAULT_TARGET,
  });
});

test("redacts full Authorization header values without altering other log text", () => {
  const basicCredential = "ZGF5dG9uYS11c2VyOnRlc3QtcGFzcw==";
  const bearerCredential = "raw-bearer-credential-value";
  const sanitized = sanitizeDaytonaBuildLog(
    [
      "starting image build",
      `aUtHoRiZaTiOn : Basic ${basicCredential}`,
      `AUTHORIZATION:\tBearer ${bearerCredential}`,
      "image build complete",
    ].join("\n"),
    API_KEY
  );

  assert.equal(sanitized.includes(basicCredential), false);
  assert.equal(sanitized.includes(bearerCredential), false);
  assert.equal(
    sanitized,
    [
      "starting image build",
      "aUtHoRiZaTiOn : [REDACTED]",
      "AUTHORIZATION:\t[REDACTED]",
      "image build complete",
    ].join("\n")
  );
});

test("fails closed after detecting a split Authorization marker", () => {
  const basicCredential = "ZGF5dG9uYS11c2VyOnRlc3QtcGFzcw==";
  const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);

  assert.equal(
    sanitizer.write("starting image build\nAuthorization: Basic "),
    "starting image build\nAuthorization: [REDACTED]"
  );
  assert.equal(sanitizer.write("Ba"), "");
  assert.equal(sanitizer.write(`sic ${basicCredential}\r`), "");
  assert.equal(
    sanitizer.write("\nAuthorization: Bearer raw-bearer-credential-"),
    ""
  );
  assert.equal(sanitizer.write("value\r"), "");
  assert.equal(sanitizer.write("\nimage build complete"), "");
  assert.equal(sanitizer.flush(), "");
});

test("streams SDK-trimmed chunks without waiting for newline boundaries", () => {
  const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
  const chunks = [
    "starting image build",
    ` installing ${"dependencies ".repeat(12)}`,
    " image build complete",
  ];
  const emitted = chunks.map((chunk) => sanitizer.write(chunk));
  emitted.push(sanitizer.flush());

  assert.equal(emitted.join(""), chunks.join(""));
  assert.ok(emitted.slice(0, -1).some((chunk) => chunk.length > 0));
});

test("bounds total build output even for huge no-newline SDK chunks", () => {
  const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
  const log = "x".repeat(1_000_000);
  const emitted = sanitizer.write(log);

  assert.equal(emitted.length, DAYTONA_BUILD_LOG_MAX_CHARACTERS);
  assert.equal(sanitizer.write(log), "");
  assert.equal(sanitizer.flush(), "");
});

test("read-only verification requires the exact active snapshot resource profile", async () => {
  const accepted = [
    activeSnapshot(),
    { ...activeSnapshot(), mem: undefined, memory: 4 },
  ];
  await Promise.all(
    accepted.map(async (snapshot) => {
      assert.equal(
        await verifyDaytonaSnapshot(configuration, {
          get: (name) => {
            assert.equal(name, configuration.snapshotName);
            return Promise.resolve(snapshot);
          },
        }),
        snapshot
      );
    })
  );
  await Promise.all(
    [
      { cpu: undefined },
      { cpu: Number.NaN },
      { cpu: Number.POSITIVE_INFINITY },
      { cpu: 1 },
      { cpu: 4 },
      { disk: 3 },
      { mem: undefined },
      { mem: 4, memory: 8 },
      { state: "building" },
      { state: `provider-secret-${"x".repeat(10_000)}` },
      { name: "wrong-snapshot" },
    ].map(async (mismatch) => {
      await assert.rejects(
        verifyDaytonaSnapshot(configuration, {
          get: () => Promise.resolve({ ...activeSnapshot(), ...mismatch }),
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("does not match") &&
          error.message.length < 256 &&
          !error.message.includes("provider-secret")
      );
    })
  );
});

test("redacts markers split across SDK-trimmed chunks and suppresses values", () => {
  const scenarios = [
    {
      chunks: ["safe output Author", "ization: Bear", "er secret-value"],
      expected: "safe output Authorization: [REDACTED]",
      secret: "secret-value",
    },
    {
      chunks: ["safe output Ba", "sic ", "basic-credential"],
      expected: "safe output Basic [REDACTED]",
      secret: "basic-credential",
    },
    {
      chunks: ["safe output Be", "arer ", "bearer-token"],
      expected: "safe output Bearer [REDACTED]",
      secret: "bearer-token",
    },
    {
      chunks: ["safe output cred", "ential = ", "credential-value"],
      expected: "safe output credential = [REDACTED]",
      secret: "credential-value",
    },
    {
      chunks: ["safe output daytona-api", "-key-for-test"],
      expected: "safe output [REDACTED]",
      secret: API_KEY,
    },
    {
      chunks: ["safe output Authorization", " ".repeat(128), ": secret-value"],
      expected: "safe output Authorization [REDACTED]",
      secret: "secret-value",
    },
  ] as const;

  for (const scenario of scenarios) {
    const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
    const emitted = scenario.chunks.map((chunk) => sanitizer.write(chunk));
    emitted.push(sanitizer.flush());
    const output = emitted.join("");

    assert.equal(output, scenario.expected);
    assert.equal(output.includes(scenario.secret), false);
  }
});

test("redacts auth schemes ending SDK-trimmed callback chunks", () => {
  const scenarios = [
    {
      chunks: [
        "starting image build BeArEr ",
        "bearer-credential-",
        "continued ",
      ],
      expected: "starting image build BeArEr [REDACTED]",
      secret: "bearer-credential-continued",
    },
    {
      chunks: [
        "starting image build bAsIc\t",
        "basic-credential-",
        "continued\t",
      ],
      expected: "starting image build bAsIc [REDACTED]",
      secret: "basic-credential-continued",
    },
  ] as const;

  for (const scenario of scenarios) {
    const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
    const emitted = scenario.chunks.map((chunk) =>
      sanitizer.write(chunk.trimEnd())
    );

    assert.equal(emitted.join(""), scenario.expected);
    assert.equal(emitted.join("").includes(scenario.secret), false);
    assert.equal(sanitizer.flush(), "");
  }
});

test("does not retain huge sensitive values or flush suppressed remainders", () => {
  const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
  const hugeSecret = "s".repeat(1_000_000);

  assert.equal(
    sanitizer.write("starting token="),
    "starting token= [REDACTED]"
  );
  assert.equal(sanitizer.write(hugeSecret), "");
  assert.equal(sanitizer.flush(), "");
});

test("does not flush incomplete sensitive marker prefixes", () => {
  const sanitizer = createDaytonaBuildLogSanitizer(API_KEY);
  assert.equal(sanitizer.write("starting Authorizatio"), "");
  assert.equal(sanitizer.flush(), "starting ");
});

test("refuses to recreate a snapshot that already exists", async () => {
  let createCalls = 0;
  const snapshot: DaytonaSnapshotService = {
    create: () => {
      createCalls += 1;
      return Promise.resolve(activeSnapshot());
    },
    get: () => Promise.resolve(activeSnapshot()),
  };

  await assert.rejects(
    provisionDaytonaSnapshot(configuration, {
      log: () => undefined,
      snapshot,
    }),
    /already exists; refusing to recreate/u
  );
  assert.equal(createCalls, 0);
});

test("creates the configured image and verifies the resulting active snapshot", async () => {
  const getCalls: string[] = [];
  const createCalls: Parameters<DaytonaSnapshotService["create"]>[] = [];
  const logs: string[] = [];
  const snapshot: DaytonaSnapshotService = {
    create: (...arguments_) => {
      createCalls.push(arguments_);
      arguments_[1].onLogs("building Copilot CLI");
      return Promise.resolve({
        name: DAYTONA_COPILOT_SNAPSHOT_NAME,
        state: SnapshotState.BUILDING,
      });
    },
    get: (name) => {
      getCalls.push(name);
      if (getCalls.length === 1) {
        return Promise.reject(missingSnapshot());
      }
      return Promise.resolve(activeSnapshot());
    },
  };

  const result = await provisionDaytonaSnapshot(configuration, {
    log: (message) => logs.push(message),
    snapshot,
  });

  assert.deepEqual(result, activeSnapshot());
  assert.deepEqual(getCalls, [
    DAYTONA_COPILOT_SNAPSHOT_NAME,
    DAYTONA_COPILOT_SNAPSHOT_NAME,
  ]);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0]?.[0].name, DAYTONA_COPILOT_SNAPSHOT_NAME);
  assert.equal(
    createCalls[0]?.[0].image.dockerfile,
    createDaytonaCopilotImage().dockerfile
  );
  assert.deepEqual(logs, ["building Copilot CLI"]);
});

test("forwards sanitized snapshot build logs without secrets", async () => {
  const logs: string[] = [];
  const token = "build-token-value";
  const credential = "credential-value";
  const snapshot: DaytonaSnapshotService = {
    create: (_parameters, options) => {
      options.onLogs(
        [
          `api_key=${API_KEY}`,
          `token: ${token}`,
          `credential=${credential}`,
          `Authorization: Bearer ${token}`,
        ].join("\n")
      );
      return Promise.resolve(activeSnapshot());
    },
    get: () => {
      if (logs.length === 0) {
        return Promise.reject(missingSnapshot());
      }
      return Promise.resolve(activeSnapshot());
    },
  };

  await provisionDaytonaSnapshot(configuration, {
    log: (message) => logs.push(message),
    snapshot,
  });

  assert.equal(logs.length, 1);
  const log = logs.join("");
  assert.ok(log);
  assert.equal(log.includes(API_KEY), false);
  assert.equal(log.includes(token), false);
  assert.equal(log.includes(credential), false);
  assert.match(log, /api_key= \[REDACTED\]/u);
});

test("fails closed for a split Authorization value when snapshot creation fails", async () => {
  const logs: string[] = [];
  const basicCredential = "ZGF5dG9uYS11c2VyOnRlc3QtcGFzcw==";
  const snapshot: DaytonaSnapshotService = {
    create: (_parameters, options) => {
      options.onLogs("starting image build Author");
      options.onLogs("ization: Ba");
      options.onLogs(`sic ${basicCredential}`);
      return Promise.reject(new Error("Daytona unavailable"));
    },
    get: () => Promise.reject(missingSnapshot()),
  };

  await assert.rejects(
    provisionDaytonaSnapshot(configuration, {
      log: (message) => logs.push(message),
      snapshot,
    }),
    /Failed to create Daytona snapshot/u
  );

  assert.deepEqual(logs, ["starting image build Authorization: [REDACTED]"]);
  assert.equal(logs.join("").includes(basicCredential), false);
});

test("rejects a created snapshot that cannot be verified as active", async () => {
  let getCount = 0;
  const snapshot: DaytonaSnapshotService = {
    create: () => Promise.resolve(activeSnapshot()),
    get: () => {
      getCount += 1;
      if (getCount === 1) {
        return Promise.reject(missingSnapshot());
      }
      return Promise.resolve({
        name: DAYTONA_COPILOT_SNAPSHOT_NAME,
        state: SnapshotState.BUILD_FAILED,
      });
    },
  };

  await assert.rejects(
    provisionDaytonaSnapshot(configuration, {
      log: () => undefined,
      snapshot,
    }),
    /is not active after creation \(state: build_failed\)/u
  );
});

test("the snapshot is created with the resources the policy asks for", async () => {
  // Daytona applies its own defaults (1 vCPU / 1 GiB / 3 GiB) to a snapshot
  // created without resources, and a sandbox created FROM a snapshot cannot
  // ask for more than the snapshot carries. Omitting this is what left every
  // production sandbox permanently below policy and reported as drift.
  const createCalls: Parameters<DaytonaSnapshotService["create"]>[] = [];
  await provisionDaytonaSnapshot(
    { ...configuration, resources: { cpu: 2, disk: 10, memory: 4 } },
    {
      log: () => undefined,
      snapshot: {
        create: (...arguments_) => {
          createCalls.push(arguments_);
          return Promise.resolve(activeSnapshot());
        },
        get: (() => {
          let calls = 0;
          return () => {
            calls += 1;
            return calls === 1
              ? Promise.reject(missingSnapshot())
              : Promise.resolve(activeSnapshot());
          };
        })(),
      },
    }
  );

  assert.deepEqual(createCalls[0]?.[0].resources, {
    cpu: 2,
    disk: 10,
    memory: 4,
  });
});

test("no expressible resource policy exceeds Daytona's per-sandbox maxima", () => {
  // A create above a provider maximum is rejected outright, so a cap that
  // permits one is a configuration that cannot work. `disk` was 40 against a
  // documented ceiling of 10.
  for (const field of ["cpu", "disk", "memory"] as const) {
    assert.ok(
      DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS[field] <=
        DAYTONA_PROVIDER_RESOURCE_MAXIMA[field],
      `cap for ${field} (${DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS[field]}) exceeds the provider maximum (${DAYTONA_PROVIDER_RESOURCE_MAXIMA[field]})`
    );
    assert.ok(
      DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS[field] <=
        DAYTONA_PROVIDER_RESOURCE_MAXIMA[field],
      `default for ${field} exceeds the provider maximum`
    );
  }
});

test("snapshot resources are derived from the environment, not hardcoded", () => {
  // The pass-through test above proves provisionDaytonaSnapshot forwards what
  // it is given. It does NOT prove the configuration reads the same policy the
  // running app will enforce. Hardcoding the resources in
  // daytonaSnapshotConfiguration passed the entire suite, which would bake a
  // snapshot that silently disagrees with the runtime — and snapshots are
  // immutable, so recovering needs another generation bump.
  const configured = daytonaSnapshotConfiguration({
    DAYTONA_API_KEY: "test-key",
    DAYTONA_SANDBOX_CPU_CORES: "3",
    DAYTONA_SANDBOX_DISK_GIB: "10",
    DAYTONA_SANDBOX_MEMORY_GIB: "7",
    DAYTONA_SNAPSHOT: DAYTONA_COPILOT_SNAPSHOT_NAME,
  } as unknown as NodeJS.ProcessEnv);

  assert.deepEqual(configured.resources, { cpu: 3, disk: 10, memory: 7 });
});

test("a snapshot created below policy fails the build instead of shipping", async () => {
  // Snapshots are immutable, so a clamped snapshot cannot be corrected in
  // place: the runtime guard would refuse the whole fleet permanently and the
  // only remedy is another generation. This is the moment it is still cheap.
  await assert.rejects(
    provisionDaytonaSnapshot(
      { ...configuration, resources: { cpu: 2, disk: 10, memory: 4 } },
      {
        log: () => undefined,
        snapshot: {
          create: () =>
            Promise.resolve({
              name: configuration.snapshotName,
              state: SnapshotState.ACTIVE,
            }),
          get: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              return calls === 1
                ? Promise.reject(missingSnapshot())
                : Promise.resolve({
                    cpu: 2,
                    disk: 10,
                    mem: 1,
                    name: configuration.snapshotName,
                    state: SnapshotState.ACTIVE,
                  });
            };
          })(),
        },
      }
    ),
    /was created outside policy \(memory\)/u,
    "a clamped snapshot must not be reported as a successful build"
  );
});

test("the build-time and runtime checks reject the same snapshot", async () => {
  // Two structurally parallel checks: one refuses to ship a snapshot, the
  // other refuses to delete a workspace for it. If they disagree, a snapshot
  // can pass the build and then permanently refuse the whole fleet. This
  // drives BOTH real functions rather than restating their logic.
  const resources = { cpu: 2, disk: 10, memory: 4 };
  const belowPolicy = {
    cpu: 2,
    disk: 10,
    mem: 1,
    name: configuration.snapshotName,
    state: SnapshotState.ACTIVE,
  };

  await assert.rejects(
    provisionDaytonaSnapshot(
      { ...configuration, resources },
      {
        log: () => undefined,
        snapshot: {
          create: () =>
            Promise.resolve({
              name: configuration.snapshotName,
              state: SnapshotState.ACTIVE,
            }),
          get: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              return calls === 1
                ? Promise.reject(missingSnapshot())
                : Promise.resolve(belowPolicy);
            };
          })(),
        },
      }
    ),
    /outside policy/u,
    "the build must refuse it"
  );

  await assert.rejects(
    assertReplacementSnapshotReady(
      {
        autoArchiveInterval: 10_080,
        autoDeleteInterval: -1,
        autoStopInterval: 15,
        resources,
        snapshotName: configuration.snapshotName,
        target: "us",
        ttlMinutes: 0,
      },
      { daytona: { snapshot: { get: () => Promise.resolve(belowPolicy) } } }
    ),
    /outside policy/u,
    "the runtime guard must refuse the same snapshot"
  );
});
