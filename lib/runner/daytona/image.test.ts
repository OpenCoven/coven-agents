import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError, SnapshotState } from "@daytona/sdk";
import {
  COPILOT_CLI_VERSION,
  createDaytonaCopilotImage,
  createDaytonaSnapshotDefinition,
  DAYTONA_COPILOT_IMAGE_BASE,
  DAYTONA_COPILOT_SNAPSHOT_NAME,
  type DaytonaSnapshot,
  type DaytonaSnapshotConfiguration,
  type DaytonaSnapshotService,
  daytonaClientConfiguration,
  daytonaSnapshotConfiguration,
  PNPM_VERSION,
  provisionDaytonaSnapshot,
  sanitizeDaytonaBuildLog,
  WORKSPACE_DIRECTORY,
} from "./image";

const API_KEY = "daytona-api-key-for-test";
const configuration: DaytonaSnapshotConfiguration = {
  apiKey: API_KEY,
  apiUrl: "https://app.daytona.io/api",
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
      `RUN npm install --global pnpm@${PNPM_VERSION} @github/copilot@${COPILOT_CLI_VERSION}`,
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
        `api_key=${API_KEY}\ntoken: ${token}\ncredential=${credential}\nAuthorization: Bearer ${token}`
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
  const [log] = logs;
  assert.ok(log);
  assert.equal(log.includes(API_KEY), false);
  assert.equal(log.includes(token), false);
  assert.equal(log.includes(credential), false);
  assert.match(log, /api_key= \[REDACTED\]/u);
  assert.match(log, /token: \[REDACTED\]/u);
  assert.match(log, /Authorization: \[REDACTED\]/u);
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
