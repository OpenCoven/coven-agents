"use client";

import { useEffect, useState } from "react";
import {
  buildReasoningCardModel,
  reasoningCardActivities,
} from "@/lib/reasoning-card";
import { ReasoningCard } from "./reasoning-card";

type MessageReasoningProps = {
  isLoading: boolean;
  parts: readonly unknown[];
};

export function MessageReasoning({ isLoading, parts }: MessageReasoningProps) {
  const [hasBeenStreaming, setHasBeenStreaming] = useState(isLoading);

  useEffect(() => {
    if (isLoading) {
      setHasBeenStreaming(true);
    }
  }, [isLoading]);

  const model = buildReasoningCardModel({
    activities: reasoningCardActivities(parts),
    isStreaming: isLoading,
  });

  return (
    <ReasoningCard
      defaultOpen={hasBeenStreaming}
      isStreaming={isLoading}
      model={model}
    />
  );
}
