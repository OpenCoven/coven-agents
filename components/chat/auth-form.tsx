import Form from "next/form";

import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function AuthForm({
  action,
  children,
  defaultEmail = "",
}: {
  action: NonNullable<
    string | ((formData: FormData) => void | Promise<void>) | undefined
  >;
  children: React.ReactNode;
  defaultEmail?: string;
}) {
  return (
    <Form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label
          className="font-medium text-[12px] text-muted-foreground uppercase tracking-[0.08em]"
          htmlFor="email"
        >
          Email
        </Label>
        <Input
          autoComplete="email"
          autoFocus
          className="h-10 rounded-[8px] border-border bg-secondary text-sm transition-colors focus-visible:border-[var(--oc-accent-line)] focus-visible:ring-[3px] focus-visible:ring-[var(--oc-accent-soft)]"
          defaultValue={defaultEmail}
          id="email"
          name="email"
          placeholder="you@someo.ne"
          required
          type="email"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label
          className="font-medium text-[12px] text-muted-foreground uppercase tracking-[0.08em]"
          htmlFor="password"
        >
          Password
        </Label>
        <Input
          className="h-10 rounded-[8px] border-border bg-secondary text-sm transition-colors focus-visible:border-[var(--oc-accent-line)] focus-visible:ring-[3px] focus-visible:ring-[var(--oc-accent-soft)]"
          id="password"
          name="password"
          placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
          required
          type="password"
        />
      </div>

      {children}
    </Form>
  );
}
