"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { getProviders, useSession } from "next-auth/react";
import { Suspense, useActionState, useEffect, useState } from "react";

import { AuthForm } from "@/components/chat/auth-form";
import { BetaNotice } from "@/components/chat/beta-notice";
import { GithubSignIn } from "@/components/chat/github-sign-in";
import { SubmitButton } from "@/components/chat/submit-button";
import { toast } from "@/components/chat/toast";
import { type LoginActionState, login } from "../actions";

export default function Page() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);

  /**
   * Asked of the server rather than read from a public env flag, so the button
   * cannot drift out of sync with what is actually configured -- a button that
   * leads to a provider error is worse than no button.
   */
  const [hasGithub, setHasGithub] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getProviders()
      .then((providers) => {
        if (!cancelled) {
          setHasGithub(Boolean(providers?.github));
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const [state, formAction] = useActionState<LoginActionState, FormData>(
    login,
    { status: "idle" }
  );

  const { update: updateSession } = useSession();

  // biome-ignore lint/correctness/useExhaustiveDependencies: router and updateSession are stable refs
  useEffect(() => {
    if (state.status === "failed") {
      toast({ description: "Invalid credentials!", type: "error" });
    } else if (state.status === "invalid_data") {
      toast({
        description: "Failed validating your submission!",
        type: "error",
      });
    } else if (state.status === "success") {
      setIsSuccessful(true);
      updateSession();
      router.refresh();
    }
  }, [state.status]);

  const handleSubmit = (formData: FormData) => {
    setEmail(formData.get("email") as string);
    formAction(formData);
  };

  return (
    <>
      <Suspense fallback={null}>
        <BetaNotice />
      </Suspense>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="text-sm text-muted-foreground">
        Sign in to your account to continue
      </p>
      {hasGithub ? <GithubSignIn callbackUrl="/" /> : null}
      <AuthForm action={handleSubmit} defaultEmail={email}>
        <SubmitButton isSuccessful={isSuccessful}>Sign in</SubmitButton>
        <p className="text-center text-[13px] text-muted-foreground">
          {"No account? "}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/register"
          >
            Sign up
          </Link>
        </p>
      </AuthForm>
    </>
  );
}
