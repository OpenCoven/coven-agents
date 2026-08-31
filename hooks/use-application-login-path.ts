"use client";

import { useEffect, useState } from "react";
import { browserApplicationLoginPath } from "@/lib/application-path";

export function useApplicationLoginPath(): string {
  const [loginPath, setLoginPath] = useState("/login");

  useEffect(() => {
    setLoginPath(
      browserApplicationLoginPath(
        `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
    );
  }, []);

  return loginPath;
}
