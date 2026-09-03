// biome-ignore-all lint/performance/noJsxPropsBind: team controls stay beside the state and entity they mutate.

"use client";

import {
  type AgentDefinition,
  type CreateAgentInput,
  type SkillResource,
  sanitizeEvidenceText,
  type TeamCapability,
  type TeamResource,
  type TeamRun,
} from "@opencoven/agent-contracts";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleStop,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TEMPLATES } from "@/lib/agents/formations";
import {
  isGitHubProjectCapabilityCurrent,
  visibleGitHubProjectCapabilityExpiry,
} from "@/lib/github/project-authority";
import { BUILT_IN_SKILLS, GITHUB_DELIVERY_TEAM } from "@/lib/teams/catalog";
import { TeamApiError, TeamClient } from "@/lib/teams/client";
import { Btn, Eyebrow, Spinner, StatusDot } from "./primitives";
import { pill, truncate } from "./styles";

const BASE_CAPABILITIES: readonly TeamCapability[] = [
  "workspace.read",
  "workspace.write",
  "github.contents.write",
  "github.issues.read",
  "github.issues.write",
  "github.pull_requests.read",
  "github.pull_requests.write",
];
const PROJECT_CAPABILITIES: readonly TeamCapability[] = [
  "github.projects.read",
  "github.projects.write",
];
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const TERMINAL_TEAM_STATUSES = new Set([
  "cancelled",
  "completed",
  "completed_with_warnings",
  "failed",
]);
const BUILT_IN_TEAM_REQUEST_ID = "builtin-github-delivery-team-v1";

type DraftMember = {
  agentId: string;
  draftId: string;
  required: boolean;
  responsibility: string;
  skillIds: string[];
};

type SubmissionIdentity = {
  fingerprint: string;
  idempotencyKey: string;
};

type RunSubmissionIdentity = SubmissionIdentity & {
  operationId: string;
};

function isGitHubDeliveryTeam(team: TeamResource): boolean {
  return (
    team.name === GITHUB_DELIVERY_TEAM.name &&
    team.description === GITHUB_DELIVERY_TEAM.description &&
    team.members.length === GITHUB_DELIVERY_TEAM.members.length &&
    team.members.every((member, index) => {
      const definition = GITHUB_DELIVERY_TEAM.members[index];
      return (
        definition !== undefined &&
        member.position === index &&
        member.required === definition.required &&
        member.responsibility === definition.responsibility
      );
    })
  );
}

function teamTone(
  status: TeamRun["status"] | TeamRun["steps"][number]["status"]
) {
  if (status === "completed") {
    return "success" as const;
  }
  if (status === "failed") {
    return "danger" as const;
  }
  if (status === "running" || status === "waiting_approval") {
    return "warning" as const;
  }
  return "muted" as const;
}

function readableError(error: unknown): string {
  if (error instanceof TeamApiError) {
    return error.code.replaceAll("_", " ");
  }
  return "The team request could not be completed.";
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the nested control arrives as children and keeps the implicit label association.
    <label className="oc-team-field">
      <Eyebrow>{label}</Eyebrow>
      {children}
    </label>
  );
}

function StepRecord({
  agents,
  skills,
  step,
}: {
  agents: readonly AgentDefinition[];
  skills: readonly SkillResource[];
  step: TeamRun["steps"][number];
}) {
  const agent = agents.find(({ id }) => id === step.agentId);
  const stepSkills = step.skillIds
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is SkillResource => Boolean(skill));

  return (
    <article className="oc-team-step">
      <div className="oc-team-step__head">
        <StatusDot label={step.status} size={7} tone={teamTone(step.status)} />
        <span className="oc-team-step__position">
          {String(step.position + 1).padStart(2, "0")}
        </span>
        <div>
          <strong>
            {sanitizeEvidenceText(agent?.name ?? "Execution profile")}
          </strong>
          <p>{sanitizeEvidenceText(step.responsibility)}</p>
        </div>
        <span style={pill(teamTone(step.status))}>
          {step.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="oc-team-step__skills">
        {stepSkills.map((skill) => (
          <span key={skill.id}>{sanitizeEvidenceText(skill.name)}</span>
        ))}
        <span>{step.required ? "required" : "optional"}</span>
        {step.approvalStatus === "not_required" ? null : (
          <span>approval {step.approvalStatus.replaceAll("_", " ")}</span>
        )}
      </div>
      {step.handoff ? (
        <details className="oc-team-handoff">
          <summary>
            Handoff · {step.handoff.commandEvidence.length} commands ·{" "}
            {step.handoff.fileEvidence.length} files
          </summary>
          <div>
            <p>{sanitizeEvidenceText(step.handoff.output)}</p>
            {step.handoff.commandEvidence.map((evidence) => (
              <code key={JSON.stringify(evidence)}>
                {sanitizeEvidenceText(evidence.command)}
              </code>
            ))}
            {step.handoff.fileEvidence.map((evidence) => (
              <code key={JSON.stringify(evidence)}>
                {sanitizeEvidenceText(evidence.path)}
              </code>
            ))}
          </div>
        </details>
      ) : null}
      {step.runnerRunId ? (
        <div className="oc-team-receipt">
          <span>Runner run ID</span>
          <code>{step.runnerRunId}</code>
        </div>
      ) : null}
    </article>
  );
}

export function TeamConsole({
  agents,
  onBusyChange,
  onCreateAgent,
  onExit,
}: {
  agents: AgentDefinition[];
  onBusyChange: (busy: boolean) => void;
  onCreateAgent: (
    input: CreateAgentInput,
    idempotencyKey?: string
  ) => Promise<AgentDefinition>;
  onExit: () => void;
}) {
  const client = useMemo(() => new TeamClient(), []);
  const [skills, setSkills] = useState<SkillResource[]>([]);
  const [teams, setTeams] = useState<TeamResource[]>([]);
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [nextRunCursor, setNextRunCursor] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<TeamRun | null>(null);
  const [runRefreshError, setRunRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"browse" | "skill" | "team">("browse");
  const [projectAuthorityExpiresAt, setProjectAuthorityExpiresAt] = useState<
    number | null
  >(null);
  const [projectAuthorityCheckedAt, setProjectAuthorityCheckedAt] = useState(0);
  const [mission, setMission] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillCapabilities, setSkillCapabilities] = useState<TeamCapability[]>(
    []
  );
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [members, setMembers] = useState<DraftMember[]>([]);
  const lifecycleControllerRef = useRef<AbortController | null>(null);
  const paginationControllerRef = useRef<AbortController | null>(null);
  const provisioningRef = useRef(false);
  const runSubmissionRef = useRef<RunSubmissionIdentity | null>(null);
  const selectedRunIdRef = useRef(selectedRun?.id ?? null);
  const selectedTeamIdRef = useRef(selectedTeamId);
  const skillSubmissionRef = useRef<SubmissionIdentity | null>(null);
  const teamSubmissionRef = useRef<SubmissionIdentity | null>(null);
  selectedRunIdRef.current = selectedRun?.id ?? null;
  selectedTeamIdRef.current = selectedTeamId;
  const projectAuthorityCurrent = isGitHubProjectCapabilityCurrent(
    projectAuthorityExpiresAt,
    projectAuthorityCheckedAt
  );
  const availableCapabilities = useMemo(
    () =>
      projectAuthorityCurrent
        ? [...BASE_CAPABILITIES, ...PROJECT_CAPABILITIES]
        : BASE_CAPABILITIES,
    [projectAuthorityCurrent]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${BASE_PATH}/api/github/connection`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const body = (await response.json()) as {
          projectAuthorityExpiresAt?: unknown;
        };
        return visibleGitHubProjectCapabilityExpiry(
          body.projectAuthorityExpiresAt,
          new Date()
        );
      })
      .then((expiresAt) => {
        if (controller.signal.aborted) {
          return;
        }
        setProjectAuthorityCheckedAt(Date.now());
        if (expiresAt === null) {
          setProjectAuthorityExpiresAt(null);
          return;
        }
        setProjectAuthorityExpiresAt(expiresAt.getTime());
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setProjectAuthorityExpiresAt(null);
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (projectAuthorityExpiresAt === null) {
      return;
    }
    const clearExpiredAuthority = () => {
      const now = Date.now();
      setProjectAuthorityCheckedAt(now);
      if (isGitHubProjectCapabilityCurrent(projectAuthorityExpiresAt, now)) {
        return;
      }
      setProjectAuthorityExpiresAt(null);
      setSkillCapabilities((current) =>
        current.filter(
          (capability) => !PROJECT_CAPABILITIES.includes(capability)
        )
      );
    };
    const expiryTimer = globalThis.setTimeout(
      clearExpiredAuthority,
      Math.max(0, projectAuthorityExpiresAt - Date.now())
    );
    globalThis.addEventListener("focus", clearExpiredAuthority);
    document.addEventListener("visibilitychange", clearExpiredAuthority);
    clearExpiredAuthority();
    return () => {
      globalThis.clearTimeout(expiryTimer);
      globalThis.removeEventListener("focus", clearExpiredAuthority);
      document.removeEventListener("visibilitychange", clearExpiredAuthority);
    };
  }, [projectAuthorityExpiresAt]);

  useEffect(() => {
    onBusyChange(busy);
    return () => {
      if (busy) {
        onBusyChange(false);
      }
    };
  }, [busy, onBusyChange]);

  const selectedTeam = teams.find(({ id }) => id === selectedTeamId) ?? null;
  const githubTeam = teams.find(isGitHubDeliveryTeam) ?? null;
  const selectedRunId = selectedRun?.id ?? null;
  const selectedRunStatus = selectedRun?.status ?? null;

  const refreshCatalog = useCallback(
    async (signal?: AbortSignal) => {
      const [nextSkills, nextTeams] = await Promise.all([
        client.listSkills(signal),
        client.listTeams(signal),
      ]);
      setSkills(nextSkills);
      setTeams(nextTeams);
      setSelectedTeamId((current) => current ?? nextTeams[0]?.id ?? null);
    },
    [client]
  );

  useEffect(() => {
    const controller = new AbortController();
    refreshCatalog(controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        toast.error("Could not load teams.", {
          description: readableError(error),
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [refreshCatalog]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycleControllerRef.current = controller;
    return () => {
      controller.abort();
      paginationControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectedTeamId) {
      setRuns([]);
      setNextRunCursor(null);
      setSelectedRun(null);
      setLoadingRuns(false);
      return;
    }
    paginationControllerRef.current?.abort();
    setRuns([]);
    setNextRunCursor(null);
    setSelectedRun(null);
    setRunRefreshError(null);
    setLoadingRuns(true);
    const controller = new AbortController();
    client
      .listTeamRuns(selectedTeamId, { signal: controller.signal })
      .then(({ nextCursor, teamRuns }) => {
        setRuns(teamRuns);
        setNextRunCursor(nextCursor);
        setSelectedRun((current) =>
          current && teamRuns.some(({ id }) => id === current.id)
            ? current
            : (teamRuns[0] ?? null)
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        toast.error("Could not load team runs.", {
          description: readableError(error),
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingRuns(false);
        }
      });
    return () => controller.abort();
  }, [client, selectedTeamId]);

  useEffect(() => {
    if (
      !selectedRunId ||
      !selectedRunStatus ||
      TERMINAL_TEAM_STATUSES.has(selectedRunStatus)
    ) {
      setRunRefreshError(null);
      return;
    }
    const controller = new AbortController();
    const runId = selectedRunId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await client.getTeamRun(runId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setRunRefreshError(null);
        setSelectedRun((current) => {
          if (current?.id !== runId || current.version > next.version) {
            return current;
          }
          return next;
        });
        setRuns((current) => {
          const existing = current.find(({ id }) => id === next.id);
          if (existing && existing.version > next.version) {
            return current;
          }
          return [next, ...current.filter(({ id }) => id !== next.id)];
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          setRunRefreshError(readableError(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = globalThis.setTimeout(poll, 1500);
        }
      }
    };
    timer = globalThis.setTimeout(poll, 1500);
    return () => {
      controller.abort();
      if (timer) {
        globalThis.clearTimeout(timer);
      }
    };
  }, [client, selectedRunId, selectedRunStatus]);

  const provisionGitHubTeam = async () => {
    if (githubTeam) {
      setSelectedTeamId(githubTeam.id);
      return;
    }
    if (provisioningRef.current) {
      return;
    }
    provisioningRef.current = true;
    setBusy(true);
    try {
      const available = [...agents];
      const resolvedAgents: AgentDefinition[] = [];
      for (const member of GITHUB_DELIVERY_TEAM.members) {
        const template = TEMPLATES.find(
          ({ id }) => id === member.agentTemplateId
        );
        if (!template) {
          throw new Error("Built-in team profile is unavailable.");
        }
        const existingIndex = available.findIndex(
          ({ instructions }) => instructions === template.instructions
        );
        if (existingIndex >= 0) {
          const [existing] = available.splice(existingIndex, 1);
          if (existing) {
            resolvedAgents.push(existing);
            continue;
          }
        }
        resolvedAgents.push(
          // biome-ignore lint/performance/noAwaitInLoops: built-in profile creation is intentionally serialized to avoid catalog write races.
          await onCreateAgent(
            {
              backend: "cloud",
              description: template.blurb,
              instructions: template.instructions,
              model: "auto",
              name: member.name,
              runtime: "copilot",
              workspace: "/workspace",
            },
            `builtin-github-agent-${member.agentTemplateId}-${member.name
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/gu, "-")}-v1`
          )
        );
      }

      const resolvedSkills: SkillResource[] = [];
      for (const definition of BUILT_IN_SKILLS) {
        const existing = skills.find(
          ({ instructions, name }) =>
            instructions === definition.instructions && name === definition.name
        );
        resolvedSkills.push(
          existing ??
            // biome-ignore lint/performance/noAwaitInLoops: skill creation is serialized so partial setup remains deterministic and reusable.
            (await client.createSkill(
              {
                description: definition.description,
                instructions: definition.instructions,
                name: definition.name,
                requiredCapabilities: [...definition.requiredCapabilities],
              },
              {
                idempotencyKey: `builtin-github-skill-${definition.id}-v1`,
                signal: lifecycleControllerRef.current?.signal,
              }
            ))
        );
      }
      const skillByCatalogId = new Map(
        BUILT_IN_SKILLS.map((definition, index) => [
          definition.id,
          resolvedSkills[index]?.id,
        ])
      );
      const team = await client.createTeam(
        {
          description: GITHUB_DELIVERY_TEAM.description,
          members: GITHUB_DELIVERY_TEAM.members.map((member, index) => ({
            agentId: resolvedAgents[index]?.id ?? "",
            required: member.required,
            responsibility: member.responsibility,
            skillIds: member.skillIds
              .map((id) => skillByCatalogId.get(id))
              .filter((id): id is string => Boolean(id)),
          })),
          name: GITHUB_DELIVERY_TEAM.name,
        },
        {
          idempotencyKey: BUILT_IN_TEAM_REQUEST_ID,
          signal: lifecycleControllerRef.current?.signal,
        }
      );
      await refreshCatalog();
      setSelectedTeamId(team.id);
      toast.success("GitHub delivery team is ready.");
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      toast.error("Could not create the GitHub delivery team.", {
        description: readableError(error),
      });
    } finally {
      provisioningRef.current = false;
      setBusy(false);
    }
  };

  const createSkill = async () => {
    const currentCapabilities = isGitHubProjectCapabilityCurrent(
      projectAuthorityExpiresAt,
      Date.now()
    )
      ? skillCapabilities
      : skillCapabilities.filter(
          (capability) => !PROJECT_CAPABILITIES.includes(capability)
        );
    const input = {
      description: skillDescription,
      instructions: skillInstructions,
      name: skillName,
      requiredCapabilities: currentCapabilities,
    };
    const fingerprint = JSON.stringify(input);
    const submission =
      skillSubmissionRef.current?.fingerprint === fingerprint
        ? skillSubmissionRef.current
        : {
            fingerprint,
            idempotencyKey: crypto.randomUUID(),
          };
    skillSubmissionRef.current = submission;
    setBusy(true);
    try {
      const skill = await client.createSkill(input, {
        idempotencyKey: submission.idempotencyKey,
        signal: lifecycleControllerRef.current?.signal,
      });
      skillSubmissionRef.current = null;
      setSkills((current) => [...current, skill]);
      setSkillName("");
      setSkillDescription("");
      setSkillInstructions("");
      setSkillCapabilities([]);
      setMode("browse");
      toast.success("Skill saved for reuse.");
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      toast.error("Could not create the skill.", {
        description: readableError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const beginTeam = () => {
    const initialAgents = agents.slice(0, 2);
    setMembers(
      initialAgents.map((agent, index) => ({
        agentId: agent.id,
        draftId: crypto.randomUUID(),
        required: true,
        responsibility:
          index === 0
            ? "Investigate the mission and establish a bounded plan."
            : "Complete the next verified stage and return evidence.",
        skillIds: [],
      }))
    );
    setMode("team");
  };

  const createTeam = async () => {
    const input = {
      description: teamDescription,
      members: members.map(
        ({ agentId, required, responsibility, skillIds }) => ({
          agentId,
          required,
          responsibility,
          skillIds,
        })
      ),
      name: teamName,
    };
    const fingerprint = JSON.stringify(input);
    const submission =
      teamSubmissionRef.current?.fingerprint === fingerprint
        ? teamSubmissionRef.current
        : {
            fingerprint,
            idempotencyKey: crypto.randomUUID(),
          };
    teamSubmissionRef.current = submission;
    setBusy(true);
    try {
      const team = await client.createTeam(input, {
        idempotencyKey: submission.idempotencyKey,
        signal: lifecycleControllerRef.current?.signal,
      });
      teamSubmissionRef.current = null;
      setTeams((current) => [...current, team]);
      setSelectedTeamId(team.id);
      setTeamName("");
      setTeamDescription("");
      setMembers([]);
      setMode("browse");
      toast.success("Team created.");
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      toast.error("Could not create the team.", {
        description: readableError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fills the mission field from the team's own roster. Whatever is already
   * typed is passed as a steer, so a half-written note becomes a full
   * mission rather than being thrown away. The result is editable and still
   * requires the person to start the run.
   */
  const draftMission = async () => {
    if (!selectedTeam || drafting) {
      return;
    }
    const teamId = selectedTeam.id;
    setDrafting(true);
    try {
      const drafted = await client.draftTeamMission(
        teamId,
        { hint: mission.trim() },
        lifecycleControllerRef.current?.signal
      );
      if (selectedTeamIdRef.current !== teamId) {
        return;
      }
      setMission(drafted);
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      toast.error("Could not draft a mission.", {
        description: readableError(error),
      });
    } finally {
      setDrafting(false);
    }
  };

  const startRun = async () => {
    const task = mission.trim();
    if (!selectedTeam || !task || loadingRuns) {
      return;
    }
    const teamId = selectedTeam.id;
    const fingerprint = JSON.stringify({ task, teamId });
    const submission =
      runSubmissionRef.current?.fingerprint === fingerprint
        ? runSubmissionRef.current
        : {
            fingerprint,
            idempotencyKey: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
          };
    runSubmissionRef.current = submission;
    setBusy(true);
    try {
      const run = await client.createTeamRun(
        teamId,
        {
          operationId: submission.operationId,
          task,
        },
        {
          idempotencyKey: submission.idempotencyKey,
          signal: lifecycleControllerRef.current?.signal,
        }
      );
      if (selectedTeamIdRef.current !== teamId) {
        return;
      }
      runSubmissionRef.current = null;
      setRuns((current) => [run, ...current]);
      setSelectedRun(run);
      setMission("");
      toast.success("Team run started.");
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      toast.error("Could not start the team run.", {
        description: readableError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const decideApproval = async (decision: "approve" | "reject") => {
    if (!selectedRun) {
      return;
    }
    const step = selectedRun.steps.find(
      ({ status }) => status === "waiting_approval"
    );
    if (!step) {
      return;
    }
    const capabilities = step.approvalCapabilities;
    if (decision === "approve" && capabilities.length === 0) {
      toast.error("No declared GitHub write capability is available.");
      return;
    }
    const { id: runId, teamId } = selectedRun;
    setBusy(true);
    try {
      const next = await client.approveTeamRun(
        runId,
        decision === "approve"
          ? {
              capabilities,
              decision,
              expectedVersion: step.version,
            }
          : { capabilities: [], decision, expectedVersion: step.version },
        lifecycleControllerRef.current?.signal
      );
      if (
        selectedTeamIdRef.current !== teamId ||
        selectedRunIdRef.current !== runId
      ) {
        return;
      }
      setSelectedRun(next);
      setRuns((current) => [
        next,
        ...current.filter(({ id }) => id !== next.id),
      ]);
      toast.success(
        decision === "approve" ? "Write approved." : "Write rejected."
      );
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      if (error instanceof TeamApiError && error.code === "stale_version") {
        try {
          const latest = await client.getTeamRun(
            runId,
            lifecycleControllerRef.current?.signal
          );
          if (
            selectedTeamIdRef.current !== teamId ||
            selectedRunIdRef.current !== runId
          ) {
            return;
          }
          setSelectedRun(latest);
          setRuns((current) => [
            latest,
            ...current.filter(({ id }) => id !== latest.id),
          ]);
          toast.info("The run changed and was refreshed.");
          return;
        } catch {
          toast.error("The run changed and could not be refreshed.");
          return;
        }
      }
      toast.error("Could not record the approval.", {
        description: readableError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async () => {
    if (!selectedRun) {
      return;
    }
    const { id: runId, teamId } = selectedRun;
    setBusy(true);
    try {
      const next = await client.stopTeamRun(
        runId,
        selectedRun.version,
        lifecycleControllerRef.current?.signal
      );
      if (
        selectedTeamIdRef.current !== teamId ||
        selectedRunIdRef.current !== runId
      ) {
        return;
      }
      setSelectedRun(next);
      setRuns((current) => [
        next,
        ...current.filter(({ id }) => id !== next.id),
      ]);
      toast.success("Team run stopped.");
    } catch (error) {
      if (lifecycleControllerRef.current?.signal.aborted) {
        return;
      }
      if (error instanceof TeamApiError && error.code === "stale_version") {
        try {
          const latest = await client.getTeamRun(
            runId,
            lifecycleControllerRef.current?.signal
          );
          if (
            selectedTeamIdRef.current !== teamId ||
            selectedRunIdRef.current !== runId
          ) {
            return;
          }
          setSelectedRun(latest);
          setRuns((current) => [
            latest,
            ...current.filter(({ id }) => id !== latest.id),
          ]);
          toast.info("The run changed and was refreshed.");
          return;
        } catch {
          toast.error("The run changed and could not be refreshed.");
          return;
        }
      }
      toast.error("Could not stop the team run.", {
        description: readableError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const loadOlderRuns = async () => {
    if (!selectedTeam || !nextRunCursor || loadingOlderRuns) {
      return;
    }
    paginationControllerRef.current?.abort();
    const controller = new AbortController();
    paginationControllerRef.current = controller;
    const teamId = selectedTeam.id;
    setLoadingOlderRuns(true);
    try {
      const page = await client.listTeamRuns(teamId, {
        cursor: nextRunCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted || selectedTeamIdRef.current !== teamId) {
        return;
      }
      setRuns((current) => [
        ...current,
        ...page.teamRuns.filter(
          (run) => !current.some(({ id }) => id === run.id)
        ),
      ]);
      setNextRunCursor(page.nextCursor);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      toast.error("Could not load older team runs.", {
        description: readableError(error),
      });
    } finally {
      if (paginationControllerRef.current === controller) {
        paginationControllerRef.current = null;
        setLoadingOlderRuns(false);
      }
    }
  };

  if (loading) {
    return (
      <div className="oc-team-loading">
        <Spinner />
        Loading teams
      </div>
    );
  }

  const approvalStep = selectedRun?.steps.find(
    ({ status }) => status === "waiting_approval"
  );
  const approvalCapabilities = approvalStep?.approvalCapabilities ?? [];

  return (
    <section className="oc-team-console">
      <aside className="oc-team-rail">
        <div className="oc-team-rail__head">
          <div>
            <Eyebrow>Coordinated execution</Eyebrow>
            <h1>Teams</h1>
          </div>
          <Btn disabled={busy} onClick={onExit} size="xs" variant="ghost">
            <X size={13} />
            Runs
          </Btn>
        </div>
        <button
          className="oc-team-built-in"
          data-selected={githubTeam?.id === selectedTeamId ? "" : undefined}
          disabled={busy}
          onClick={provisionGitHubTeam}
          type="button"
        >
          <ShieldCheck size={17} />
          <span>
            <strong>{GITHUB_DELIVERY_TEAM.name}</strong>
            <small>Issues · PRs · approvals</small>
          </span>
          {busy ? (
            <Spinner size={12} />
          ) : githubTeam ? (
            <Check size={14} />
          ) : (
            <Plus size={14} />
          )}
        </button>
        <div className="oc-team-rail__label">
          <span>Saved teams</span>
          <span>{teams.length}</span>
        </div>
        <div className="oc-team-list">
          {teams.map((team) => (
            <button
              data-selected={team.id === selectedTeamId ? "" : undefined}
              disabled={busy}
              key={team.id}
              onClick={() => {
                setSelectedTeamId(team.id);
                setMode("browse");
              }}
              type="button"
            >
              <UsersRound size={14} />
              <span>
                <strong>{sanitizeEvidenceText(team.name)}</strong>
                <small>{team.members.length} members</small>
              </span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
        <div className="oc-team-rail__actions">
          <Btn
            disabled={busy || agents.length < 2}
            fullWidth
            onClick={beginTeam}
          >
            <Plus size={13} />
            Create team
          </Btn>
          <Btn
            disabled={busy}
            fullWidth
            onClick={() => setMode("skill")}
            variant="ghost"
          >
            <Sparkles size={13} />
            Create reusable skill
          </Btn>
        </div>
      </aside>

      <div className="oc-team-canvas">
        {mode === "skill" ? (
          <div className="oc-team-form">
            <Eyebrow>Reusable instruction set</Eyebrow>
            <h2>Create a skill</h2>
            <p>
              Skills add bounded operating guidance. Capabilities remain
              explicit and cannot be granted by instructions.
            </p>
            <Field label="Name">
              <input
                onChange={(event) => setSkillName(event.currentTarget.value)}
                value={skillName}
              />
            </Field>
            <Field label="Description">
              <input
                onChange={(event) =>
                  setSkillDescription(event.currentTarget.value)
                }
                value={skillDescription}
              />
            </Field>
            <Field label="Instructions">
              <textarea
                onChange={(event) =>
                  setSkillInstructions(event.currentTarget.value)
                }
                rows={8}
                value={skillInstructions}
              />
            </Field>
            <fieldset className="oc-team-capabilities">
              <legend>Required capabilities</legend>
              {availableCapabilities.map((capability) => (
                <label key={capability}>
                  <input
                    checked={skillCapabilities.includes(capability)}
                    onChange={() =>
                      setSkillCapabilities((current) =>
                        current.includes(capability)
                          ? current.filter((value) => value !== capability)
                          : [...current, capability]
                      )
                    }
                    type="checkbox"
                  />
                  {capability}
                </label>
              ))}
            </fieldset>
            <p className="oc-team-capability-note">
              GitHub Project capabilities appear only while exact user
              Project-management authority remains current.
            </p>
            <div className="oc-team-form__actions">
              <Btn onClick={() => setMode("browse")} variant="ghost">
                Cancel
              </Btn>
              <Btn
                disabled={
                  busy || !skillName.trim() || !skillInstructions.trim()
                }
                onClick={createSkill}
                variant="primary"
              >
                {busy ? <Spinner size={12} /> : null}
                Save skill
              </Btn>
            </div>
          </div>
        ) : mode === "team" ? (
          <div className="oc-team-form oc-team-form--wide">
            <Eyebrow>Custom sequence</Eyebrow>
            <h2>Create a team</h2>
            <p>
              Order profiles into a durable sequence, attach reusable skills,
              and decide whether a failed member stops the run.
            </p>
            <div className="oc-team-form__grid">
              <Field label="Name">
                <input
                  onChange={(event) => setTeamName(event.currentTarget.value)}
                  value={teamName}
                />
              </Field>
              <Field label="Description">
                <input
                  onChange={(event) =>
                    setTeamDescription(event.currentTarget.value)
                  }
                  value={teamDescription}
                />
              </Field>
            </div>
            <div className="oc-team-member-editor">
              {members.map((member, index) => {
                const memberName =
                  agents.find(({ id }) => id === member.agentId)?.name ??
                  `member ${index + 1}`;
                return (
                  <fieldset key={member.draftId}>
                    <legend className="oc-team-member-editor__legend">
                      Team member {index + 1}: {memberName}
                    </legend>
                    <div className="oc-team-member-editor__head">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <select
                        aria-label={`Agent for team member ${index + 1}`}
                        onChange={(event) => {
                          const agentId = event.currentTarget.value;
                          setMembers((current) =>
                            current.map((value, position) =>
                              position === index ? { ...value, agentId } : value
                            )
                          );
                        }}
                        value={member.agentId}
                      >
                        {agents.map((agent) => (
                          <option
                            disabled={members.some(
                              (value, position) =>
                                position !== index && value.agentId === agent.id
                            )}
                            key={agent.id}
                            value={agent.id}
                          >
                            {sanitizeEvidenceText(agent.name)}
                          </option>
                        ))}
                      </select>
                      <button
                        aria-label={`Move ${memberName} up`}
                        disabled={index === 0}
                        onClick={() =>
                          setMembers((current) =>
                            current.map((value, position) =>
                              position === index - 1
                                ? (current[index] ?? value)
                                : position === index
                                  ? (current[index - 1] ?? value)
                                  : value
                            )
                          )
                        }
                        type="button"
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        aria-label={`Move ${memberName} down`}
                        disabled={index === members.length - 1}
                        onClick={() =>
                          setMembers((current) =>
                            current.map((value, position) =>
                              position === index + 1
                                ? (current[index] ?? value)
                                : position === index
                                  ? (current[index + 1] ?? value)
                                  : value
                            )
                          )
                        }
                        type="button"
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        aria-label={`Remove ${memberName}`}
                        disabled={members.length <= 2}
                        onClick={() =>
                          setMembers((current) =>
                            current.filter((_, position) => position !== index)
                          )
                        }
                        type="button"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <textarea
                      aria-label={`Responsibility for member ${index + 1}`}
                      onChange={(event) => {
                        const responsibility = event.currentTarget.value;
                        setMembers((current) =>
                          current.map((value, position) =>
                            position === index
                              ? {
                                  ...value,
                                  responsibility,
                                }
                              : value
                          )
                        );
                      }}
                      rows={2}
                      value={member.responsibility}
                    />
                    <div className="oc-team-member-editor__skills">
                      {skills.map((skill) => (
                        <label key={skill.id}>
                          <input
                            aria-label={`Attach ${skill.name} to ${memberName}`}
                            checked={member.skillIds.includes(skill.id)}
                            onChange={() =>
                              setMembers((current) =>
                                current.map((value, position) =>
                                  position === index
                                    ? {
                                        ...value,
                                        skillIds: value.skillIds.includes(
                                          skill.id
                                        )
                                          ? value.skillIds.filter(
                                              (id) => id !== skill.id
                                            )
                                          : [...value.skillIds, skill.id],
                                      }
                                    : value
                                )
                              )
                            }
                            type="checkbox"
                          />
                          {sanitizeEvidenceText(skill.name)}
                        </label>
                      ))}
                      <label>
                        <input
                          aria-label={`${memberName} is a required step`}
                          checked={member.required}
                          onChange={() =>
                            setMembers((current) =>
                              current.map((value, position) =>
                                position === index
                                  ? { ...value, required: !value.required }
                                  : value
                              )
                            )
                          }
                          type="checkbox"
                        />
                        Required step
                      </label>
                    </div>
                  </fieldset>
                );
              })}
            </div>
            <Btn
              disabled={members.length >= 8 || members.length >= agents.length}
              onClick={() => {
                const next = agents.find(
                  (agent) =>
                    !members.some(({ agentId }) => agentId === agent.id)
                );
                if (next) {
                  setMembers((current) => [
                    ...current,
                    {
                      agentId: next.id,
                      draftId: crypto.randomUUID(),
                      required: true,
                      responsibility:
                        "Complete the next bounded stage and return evidence.",
                      skillIds: [],
                    },
                  ]);
                }
              }}
              variant="ghost"
            >
              <Plus size={13} />
              Add member
            </Btn>
            <div className="oc-team-form__actions">
              <Btn onClick={() => setMode("browse")} variant="ghost">
                Cancel
              </Btn>
              <Btn
                disabled={
                  busy ||
                  !teamName.trim() ||
                  members.length < 2 ||
                  members.some(({ responsibility }) => !responsibility.trim())
                }
                onClick={createTeam}
                variant="primary"
              >
                {busy ? <Spinner size={12} /> : null}
                Create team
              </Btn>
            </div>
          </div>
        ) : selectedTeam ? (
          <div className="oc-team-workspace">
            <header className="oc-team-workspace__head">
              <div>
                <Eyebrow>{selectedTeam.members.length} member sequence</Eyebrow>
                <h2>{sanitizeEvidenceText(selectedTeam.name)}</h2>
                <p>{sanitizeEvidenceText(selectedTeam.description)}</p>
              </div>
              <Btn onClick={() => refreshCatalog()} size="xs" variant="ghost">
                <RefreshCw size={12} />
                Refresh
              </Btn>
            </header>
            <div className="oc-team-mission">
              <Field label="Mission">
                <textarea
                  onChange={(event) => setMission(event.currentTarget.value)}
                  placeholder="Name the issue, pull request, repository, expected outcome, and evidence the team must return."
                  rows={4}
                  value={mission}
                />
              </Field>
              <div className="oc-team-mission__actions">
                <Btn
                  disabled={busy || loadingRuns || drafting}
                  onClick={draftMission}
                >
                  {drafting ? <Spinner size={12} /> : <Sparkles size={13} />}
                  {mission.trim() ? "Rewrite as a mission" : "Draft a mission"}
                </Btn>
                <Btn
                  disabled={busy || loadingRuns || drafting || !mission.trim()}
                  onClick={startRun}
                  variant="primary"
                >
                  {busy || loadingRuns ? (
                    <Spinner size={12} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  Start coordinated run
                </Btn>
              </div>
            </div>
            <div className="oc-team-run-layout">
              <aside className="oc-team-run-list">
                <div className="oc-team-rail__label">
                  <span>Run history</span>
                  <span>{runs.length}</span>
                </div>
                {runs.map((run) => (
                  <button
                    data-selected={run.id === selectedRun?.id ? "" : undefined}
                    disabled={busy}
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    type="button"
                  >
                    <StatusDot
                      label={run.status}
                      size={7}
                      tone={teamTone(run.status)}
                    />
                    <span style={truncate}>
                      {sanitizeEvidenceText(run.mission)}
                    </span>
                  </button>
                ))}
                {loadingRuns ? <p>Loading run history.</p> : null}
                {!loadingRuns && runs.length === 0 ? (
                  <p>No coordinated runs yet.</p>
                ) : null}
                {nextRunCursor ? (
                  <Btn
                    disabled={loadingOlderRuns}
                    fullWidth
                    onClick={loadOlderRuns}
                    size="xs"
                    variant="ghost"
                  >
                    {loadingOlderRuns ? <Spinner size={11} /> : null}
                    Load older runs
                  </Btn>
                ) : null}
              </aside>
              <div className="oc-team-run-record">
                {selectedRun ? (
                  <>
                    {runRefreshError ? (
                      <div className="oc-team-refresh-error" role="alert">
                        Live updates are retrying: {runRefreshError}
                      </div>
                    ) : null}
                    <header>
                      <div>
                        <Eyebrow>Coordinated run</Eyebrow>
                        <h3>{sanitizeEvidenceText(selectedRun.mission)}</h3>
                      </div>
                      <span style={pill(teamTone(selectedRun.status))}>
                        {selectedRun.status.replaceAll("_", " ")}
                      </span>
                    </header>
                    {selectedRun.status === "waiting_approval" ? (
                      <div className="oc-team-approval">
                        <ShieldCheck size={18} />
                        <div>
                          <strong>GitHub write approval required</strong>
                          <p>
                            The current step may use only its declared write
                            capabilities. Instructions cannot expand this grant.
                          </p>
                          <div className="oc-team-approval__capabilities">
                            {approvalCapabilities.length > 0 ? (
                              approvalCapabilities.map((capability) => (
                                <code key={capability}>{capability}</code>
                              ))
                            ) : (
                              <span>
                                No declared write capability is available.
                              </span>
                            )}
                          </div>
                        </div>
                        <Btn
                          disabled={busy}
                          onClick={() => decideApproval("reject")}
                          variant="danger-ghost"
                        >
                          Reject
                        </Btn>
                        <Btn
                          disabled={busy || approvalCapabilities.length === 0}
                          onClick={() => decideApproval("approve")}
                          variant="primary"
                        >
                          Approve changes
                        </Btn>
                      </div>
                    ) : null}
                    <div className="oc-team-steps">
                      {selectedRun.steps.map((step) => (
                        <StepRecord
                          agents={agents}
                          key={step.id}
                          skills={skills}
                          step={step}
                        />
                      ))}
                    </div>
                    {TERMINAL_TEAM_STATUSES.has(selectedRun.status) ? null : (
                      <Btn
                        disabled={busy}
                        onClick={stopRun}
                        variant="danger-ghost"
                      >
                        <CircleStop size={13} />
                        Stop team run
                      </Btn>
                    )}
                    <div className="oc-team-run-id">
                      <span>Run request ID</span>
                      <code>{selectedRun.operationId}</code>
                    </div>
                  </>
                ) : (
                  <div className="oc-team-empty">
                    <UsersRound size={24} />
                    <h3>Start the first coordinated run</h3>
                    <p>
                      The record will show every member, approval, handoff, and
                      execution identifier in sequence.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="oc-team-empty">
            <UsersRound size={28} />
            <h2>Create a coordinated team</h2>
            <p>
              Set up the GitHub delivery team or compose a custom sequence from
              your execution profiles and reusable skills.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
