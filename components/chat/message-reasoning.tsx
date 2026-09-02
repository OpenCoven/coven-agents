"use client";

import { useEffect, useState } from "react";
import {
  buildReasoningCardModel,
  type ReasoningActivity,
} from "@/lib/reasoning-card";
import { ReasoningCard } from "./reasoning-card";

type MessageReasoningProps = {
  activities: readonly ReasoningActivity[];
  isLoading: boolean;
};

export function MessageReasoning({
  activities,
  isLoading,
}: MessageReasoningProps) {
  const [hasBeenStreaming, setHasBeenStreaming] = useState(isLoading);

  useEffect(() => {
    if (isLoading) {
      setHasBeenStreaming(true);
    }
  }, [isLoading]);

  const model = buildReasoningCardModel({
    activities,
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
