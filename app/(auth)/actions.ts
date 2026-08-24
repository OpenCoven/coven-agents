"use server";

import { compare } from "bcrypt-ts";
import { z } from "zod";
import { passwordChangeDecision } from "@/lib/auth/password-change";
import { createUser, getUser, updateUserPassword } from "@/lib/db/queries";

import { auth, signIn } from "./auth";

const authFormSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
});

export type LoginActionState = {
  status: "idle" | "in_progress" | "success" | "failed" | "invalid_data";
};

export const login = async (
  _: LoginActionState,
  formData: FormData
): Promise<LoginActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};

export type RegisterActionState = {
  status:
    | "idle"
    | "in_progress"
    | "success"
    | "failed"
    | "user_exists"
    | "invalid_data";
};

export const register = async (
  _: RegisterActionState,
  formData: FormData
): Promise<RegisterActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    const [user] = await getUser(validatedData.email);

    if (user) {
      return { status: "user_exists" } as RegisterActionState;
    }
    await createUser(validatedData.email, validatedData.password);
    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};

export type ChangePasswordActionState = {
  status:
    | "idle"
    | "in_progress"
    | "success"
    | "mismatch"
    | "too_short"
    | "unauthorized"
    | "unchanged"
    | "wrong_password"
    | "failed";
};

/**
 * Changes the signed-in user's password.
 *
 * The decision lives in `passwordChangeDecision` rather than here, because it
 * governs who keeps control of an account and a server action is unreachable
 * from a unit test. This function does the parts that need the world: read the
 * session, compare the stored hash, write the new one.
 *
 * The current password is required even though the caller is already signed
 * in, so that a stolen session cookie is not by itself enough to seize the
 * account permanently.
 */
export const changePassword = async (
  _: ChangePasswordActionState,
  formData: FormData
): Promise<ChangePasswordActionState> => {
  try {
    const session = await auth();
    const email = session?.user?.email ?? null;

    const current = String(formData.get("currentPassword") ?? "");
    const next = String(formData.get("newPassword") ?? "");
    const confirmation = String(formData.get("confirmPassword") ?? "");

    const [row] = email ? await getUser(email) : [];

    const currentMatches = Boolean(
      row?.password && (await compare(current, row.password))
    );

    const decision = passwordChangeDecision({
      confirmation,
      currentMatches,
      next,
      nextEqualsCurrent: Boolean(
        row?.password && (await compare(next, row.password))
      ),
      signedIn: Boolean(email && row),
    });

    if (decision.kind !== "allowed") {
      return { status: decision.kind } as ChangePasswordActionState;
    }

    await updateUserPassword(email as string, next);

    return { status: "success" };
  } catch {
    return { status: "failed" };
  }
};
