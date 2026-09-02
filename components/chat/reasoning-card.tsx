"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Clock3Icon,
  EllipsisIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  foldReasoningCardSteps,
  type ReasoningCardModel,
  type ReasoningCardStep,
} from "@/lib/reasoning-card";
import { cn } from "@/lib/utils";
import { Shimmer } from "../ai-elements/shimmer";

type ReasoningCardProps = Readonly<{
  defaultOpen?: boolean;
  isStreaming: boolean;
  model: ReasoningCardModel;
}>;

const streamdownPlugins = { cjk, code, math, mermaid };
const AUTO_CLOSE_DELAY = 1000;
const UNMOUNT_DELAY = 170;

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "—";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function stepIcon(step: ReasoningCardStep) {
  if (step.kind === "fold") {
    return EllipsisIcon;
  }
  if (step.state === "failed") {
    return CircleAlertIcon;
  }
  if (step.state === "waiting") {
    return Clock3Icon;
  }
  if (step.state === "completed") {
    return step.kind === "reasoning" ? SparklesIcon : CircleCheckIcon;
  }
  return step.kind === "reasoning" ? SparklesIcon : WrenchIcon;
}

function stateTone(step: ReasoningCardStep): string {
  if (step.state === "failed") {
    return "text-[var(--color-danger,var(--destructive))]";
  }
  if (step.state === "waiting") {
    return "text-[var(--color-warning,var(--muted-foreground))]";
  }
  if (step.state === "active") {
    return "text-[var(--accent-presence,var(--primary))]";
  }
  return "text-[var(--text-muted,var(--muted-foreground))]";
}

function ReasoningStepDescription({ step }: { step: ReasoningCardStep }) {
  if (step.kind !== "reasoning") {
    return (
      <span className="text-[12px] text-[var(--text-secondary,var(--muted-foreground))] leading-[1.5]">
        {step.description}
      </span>
    );
  }

  return (
    <Streamdown
      className="text-[12px] text-[var(--text-secondary,var(--muted-foreground))] leading-[1.5] [&_p]:m-0"
      plugins={streamdownPlugins}
    >
      {step.description}
    </Streamdown>
  );
}

export function ReasoningCard({
  defaultOpen = false,
  isStreaming,
  model,
}: ReasoningCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen || isStreaming);
  const [isMounted, setIsMounted] = useState(defaultOpen || isStreaming);
  const [expanded, setExpanded] = useState(false);
  const [duration, setDuration] = useState<number>();
  const reduceMotion = useReducedMotion();
  const startedAtRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const hasAutoClosedRef = useRef(!isStreaming);
  const explicitlyClosedRef = useRef(false);
  const expandedFocusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming) {
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now();
      }
      hasAutoClosedRef.current = expanded;
      if (!explicitlyClosedRef.current) {
        setIsOpen(true);
        setIsMounted(true);
      }
      return;
    }

    if (startedAtRef.current !== null) {
      setDuration(
        Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000))
      );
      startedAtRef.current = null;
      if (!isOpen) {
        hasAutoClosedRef.current = true;
      }
    }
    if (expanded) {
      hasAutoClosedRef.current = true;
      return;
    }
    if (isOpen && !hasAutoClosedRef.current) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        hasAutoClosedRef.current = true;
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [expanded, isOpen, isStreaming]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      return;
    }
    const timer = setTimeout(() => setIsMounted(false), UNMOUNT_DELAY);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const collapsedSteps = useMemo(
    () => foldReasoningCardSteps(model.steps, false),
    [model.steps]
  );
  const totalCollapsedCount = useMemo(
    () =>
      collapsedSteps.reduce(
        (total, step) => total + (step.collapsedCount ?? 0),
        0
      ),
    [collapsedSteps]
  );
  const visibleSteps = expanded ? model.steps : collapsedSteps;
  const firstHiddenStepId = useMemo(() => {
    const visibleIds = new Set(
      collapsedSteps
        .filter((step) => step.kind !== "fold")
        .map((step) => step.id)
    );
    return model.steps.find((step) => !visibleIds.has(step.id))?.id;
  }, [collapsedSteps, model.steps]);

  useEffect(() => {
    if (expanded) {
      expandedFocusRef.current?.focus();
    }
  }, [expanded]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      explicitlyClosedRef.current = !next && isStreaming;
      if (!(next || isStreaming)) {
        hasAutoClosedRef.current = true;
      }
      if (next) {
        setIsMounted(true);
      }
      setIsOpen(next);
    },
    [isStreaming]
  );
  const handleExpand = useCallback(() => {
    hasAutoClosedRef.current = true;
    setExpanded(true);
  }, []);

  return (
    <Collapsible
      className="not-prose overflow-hidden rounded-[8px] border border-[var(--border-hairline,var(--border))] bg-[var(--bg-raised,var(--card))] font-[var(--font-sans)] text-[13px] text-[var(--text-primary,var(--foreground))]"
      data-testid="message-reasoning"
      onOpenChange={handleOpenChange}
      open={isOpen}
    >
      <section aria-label="Reasoning">
        <CollapsibleTrigger className="grid w-full grid-cols-[16px_minmax(0,1fr)_14px] items-center gap-x-2.5 gap-y-1 border-0 bg-transparent px-3 py-[9px] text-left text-inherit transition-colors hover:bg-[var(--bg-hover,var(--accent))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring-focus,var(--ring))] sm:grid-cols-[16px_minmax(0,1fr)_auto_14px] motion-reduce:transition-none">
          <BrainIcon
            aria-hidden="true"
            className="size-[15px] text-[var(--text-secondary,var(--muted-foreground))]"
          />
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-semibold">Reasoning</span>
            <span className="truncate text-[12px] text-[var(--text-secondary,var(--muted-foreground))]">
              {model.summary}
            </span>
          </span>
          <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-muted,var(--muted-foreground))] sm:col-start-3 sm:row-start-1 sm:whitespace-nowrap">
            {model.failureCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[var(--color-danger,var(--destructive))]">
                <CircleAlertIcon aria-hidden="true" className="size-[11px]" />
                {model.failureCount} failed
              </span>
            )}
            <span>
              {model.stepCount} {model.stepCount === 1 ? "step" : "steps"}
            </span>
            <span className="font-[var(--font-mono)]">
              {isStreaming ? (
                reduceMotion ? (
                  "live"
                ) : (
                  <Shimmer as="span" duration={1}>
                    live
                  </Shimmer>
                )
              ) : (
                formatDuration(duration)
              )}
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "col-start-3 row-start-1 size-3.5 text-[var(--text-muted,var(--muted-foreground))] transition-transform duration-150 sm:col-start-4 motion-reduce:transition-none",
              isOpen && "rotate-180"
            )}
          />
        </CollapsibleTrigger>

        <CollapsibleContent
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows] duration-[160ms] ease-[cubic-bezier(0.3,0,0,1)] motion-reduce:transition-none",
            isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
          forceMount
        >
          <div className="min-h-0 overflow-hidden">
            {isMounted ? (
              <div
                aria-hidden={!isOpen}
                className="border-[var(--border-hairline,var(--border))] border-t px-3 pt-3 pb-1"
                inert={!isOpen}
              >
                {visibleSteps.map((step, index) => {
                  const Icon = stepIcon(step);
                  return (
                    <div
                      className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring-focus,var(--ring))]"
                      data-state={step.state}
                      key={step.id}
                      ref={
                        expanded && step.id === firstHiddenStepId
                          ? expandedFocusRef
                          : undefined
                      }
                      tabIndex={
                        expanded && step.id === firstHiddenStepId
                          ? -1
                          : undefined
                      }
                    >
                      <span className="grid justify-items-center">
                        <span
                          className={cn(
                            "inline-flex h-[18px] items-center",
                            stateTone(step)
                          )}
                        >
                          <Icon aria-hidden="true" className="size-3.5" />
                        </span>
                        <span
                          className={cn(
                            "min-h-2 w-px flex-1 bg-[var(--border-hairline,var(--border))]",
                            index === visibleSteps.length - 1 &&
                              "bg-transparent"
                          )}
                        />
                      </span>
                      <div className="grid min-w-0 gap-0.5 pb-3">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span
                            className={cn(
                              "truncate text-[12px] font-semibold",
                              step.state === "failed"
                                ? "text-[var(--color-danger,var(--destructive))]"
                                : "text-[var(--text-primary,var(--foreground))]"
                            )}
                          >
                            {step.title}
                          </span>
                          {step.tool ? (
                            <code className="truncate font-[var(--font-mono)] text-[11px] text-[var(--text-muted,var(--muted-foreground))]">
                              {step.tool}
                            </code>
                          ) : null}
                        </div>
                        <ReasoningStepDescription step={step} />
                      </div>
                    </div>
                  );
                })}

                {!expanded && totalCollapsedCount > 0 ? (
                  <div className="pb-2 pl-[26px]">
                    <button
                      className="border-0 bg-transparent p-0 text-[12px] text-[var(--accent-presence,var(--primary))] hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring-focus,var(--ring))]"
                      onClick={handleExpand}
                      type="button"
                    >
                      Show {totalCollapsedCount} routine tool calls
                    </button>
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-3 border-[var(--border-hairline,var(--border))] border-t py-2 pl-[26px] text-[12px] text-[var(--text-muted,var(--muted-foreground))]">
                  <span>{model.footer}</span>
                  <span className="shrink-0 font-[var(--font-mono)] text-[11px]">
                    {model.toolCallCount} tool{" "}
                    {model.toolCallCount === 1 ? "call" : "calls"}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
