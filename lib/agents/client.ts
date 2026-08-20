import {
  type AgentDefinition,
  agentEnvelopeSchema,
  agentsEnvelopeSchema,
  apiErrorSchema,
  type CreateAgentInput,
  okEnvelopeSchema,
  type RunResult,
  runEnvelopeSchema,
} from "@opencoven/agent-contracts";

export interface RunnerConnection {
  endpoint: string;
  token: string;
}

export class RunnerApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RunnerApiError";
    this.code = code;
    this.status = status;
  }
}

type Fetch = typeof globalThis.fetch;

export class RunnerClient {
  private readonly connection: RunnerConnection;
  private readonly endpoint: string;
  private readonly request: Fetch;

  constructor(connection: RunnerConnection, request: Fetch = globalThis.fetch) {
    this.connection = connection;
    this.endpoint = connection.endpoint.replace(/\/+$/, "");
    this.request = request;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    const response = await this.fetch("/api/agents", { signal });
    return agentsEnvelopeSchema.parse(await response.json()).agents;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    const response = await this.fetch("/api/agents", {
      body: JSON.stringify(input),
      method: "POST",
    });
    return agentEnvelopeSchema.parse(await response.json()).agent;
  }

  async runAgent(agentId: string, task: string): Promise<RunResult> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      {
        body: JSON.stringify({ task }),
        method: "POST",
      }
    );
    return runEnvelopeSchema.parse(await response.json()).run;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
    okEnvelopeSchema.parse(await response.json());
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.endpoint) {
      throw new RunnerApiError(
        "Runner endpoint is required.",
        "missing_endpoint",
        0
      );
    }
    if (!this.connection.token) {
      throw new RunnerApiError(
        "Runner access token is required.",
        "missing_token",
        0
      );
    }

    const response = await this.request(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.connection.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      const parsed = apiErrorSchema.safeParse(body);
      throw new RunnerApiError(
        parsed.success
          ? parsed.data.error
          : `Runner request failed (${response.status}).`,
        parsed.success ? parsed.data.code : "runner_error",
        response.status
      );
    }

    return response;
  }
}
