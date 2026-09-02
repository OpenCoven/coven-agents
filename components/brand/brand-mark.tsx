import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type BrandMarkProps = Omit<ComponentProps<"span">, "children"> & {
  label?: string;
};

/**
 * Canonical OpenCoven mark. A mask keeps every UI surface on the same source
 * asset while allowing the mark to inherit the surrounding text color.
 */
export function BrandMark({
  className,
  label,
  style,
  ...props
}: BrandMarkProps) {
  const markUrl = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/brand/opencoven-mark.svg`;

  return (
    <span
      {...props}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn("inline-block size-4 shrink-0", className)}
      role="img"
      style={{
        backgroundColor: "currentColor",
        mask: `url(${markUrl}) center / contain no-repeat`,
        WebkitMask: `url(${markUrl}) center / contain no-repeat`,
        ...style,
      }}
    />
  );
}
