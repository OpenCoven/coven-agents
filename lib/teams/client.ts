"use client";

import {
  type ApproveTeamRunInput,
  type CreateSkillInput,
  type CreateTeamInput,
  type CreateTeamRunInput,
  skillEnvelopeSchema,
  skillsEnvelopeSchema,
  teamEnvelopeSchema,
  teamRunEnvelopeSchema,
  teamRunsEnvelopeSchema,
  teamsEnvelopeSchema,
} from "@opencoven/agent-contracts";

type FetchLike = typeof fetch;
type MutationOptions = Readonly<{
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;

export class TeamApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "TeamApiError";
    this.code = code;
    this.status = status;
  }
}

export class TeamClient {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async listSkills(signal?: AbortSignal) {
    return skillsEnvelopeSchema.parse(
      await this.request("/api/skills", { method: "GET", signal })
    ).skills;
  }

  async createSkill(input: CreateSkillInput, options: MutationOptions = {}) {
    return skillEnvelopeSchema.parse(
      await this.request("/api/skills", {
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey ?? crypto.randomUUID(),
        },
        method: "POST",
        signal: options.signal,
      })
    ).skill;
  }

  async listTeams(signal?: AbortSignal) {
    return teamsEnvelopeSchema.parse(
      await this.request("/api/teams", { method: "GET", signal })
    ).teams;
  }

  async createTeam(input: CreateTeamInput, options: MutationOptions = {}) {
    return teamEnvelopeSchema.parse(
      await this.request("/api/teams", {
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey ?? crypto.randomUUID(),
        },
        method: "POST",
        signal: options.signal,
      })
    ).team;
  }

  async listTeamRuns(
    teamId: string,
    options: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}
  ) {
    const query = options.cursor
      ? `?cursor=${encodeURIComponent(options.cursor)}`
      : "";
    return teamRunsEnvelopeSchema.parse(
      await this.request(
        `/api/teams/${encodeURIComponent(teamId)}/runs${query}`,
        {
          method: "GET",
          signal: options.signal,
        }
      )
    );
  }

  async createTeamRun(
    teamId: string,
    input: CreateTeamRunInput,
    options: MutationOptions = {}
  ) {
    return teamRunEnvelopeSchema.parse(
      await this.request(`/api/teams/${encodeURIComponent(teamId)}/runs`, {
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey ?? crypto.randomUUID(),
        },
        method: "POST",
        signal: options.signal,
      })
    ).teamRun;
  }

  async getTeamRun(runId: string, signal?: AbortSignal) {
    return teamRunEnvelopeSchema.parse(
      await this.request(`/api/team-runs/${encodeURIComponent(runId)}`, {
        method: "GET",
        signal,
      })
    ).teamRun;
  }

  async approveTeamRun(
    runId: string,
    input: ApproveTeamRunInput,
    signal?: AbortSignal
  ) {
    return teamRunEnvelopeSchema.parse(
      await this.request(
        `/api/team-runs/${encodeURIComponent(runId)}/approve`,
        {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal,
        }
      )
    ).teamRun;
  }

  async stopTeamRun(
    runId: string,
    expectedVersion: number,
    signal?: AbortSignal
  ) {
    return teamRunEnvelopeSchema.parse(
      await this.request(`/api/team-runs/${encodeURIComponent(runId)}/stop`, {
        body: JSON.stringify({ expectedVersion }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      })
    ).teamRun;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        body &&
        typeof body === "object" &&
        "error" in body &&
        body.error &&
        typeof body.error === "object" &&
        "code" in body.error &&
        typeof body.error.code === "string"
          ? body.error.code
          : "team_request_failed";
      throw new TeamApiError(code, response.status);
    }
    return body;
  }
}
