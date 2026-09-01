"use client";

import { useEffect, useState } from "react";
import { browserApplicationLoginPath } from "@/lib/application-path";

export function useApplicationLoginPath(): string | null {
  const [loginPath, setLoginPath] = useState<string | null>(null);

  useEffect(() => {
    setLoginPath(
      browserApplicationLoginPath(
        `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
    );
  }, []);

  return loginPath;
}
