"use client";

import { useEffect, useState } from "react";

export type TabOrientation = "horizontal" | "vertical";

export function useResponsiveTabOrientation(
  horizontalMediaQuery: string
): TabOrientation {
  const [orientation, setOrientation] = useState<TabOrientation>("vertical");

  useEffect(() => {
    const query = window.matchMedia(horizontalMediaQuery);
    const update = () => {
      setOrientation(query.matches ? "horizontal" : "vertical");
    };
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, [horizontalMediaQuery]);

  return orientation;
}
