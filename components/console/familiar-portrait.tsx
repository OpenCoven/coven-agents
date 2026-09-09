import type { FamiliarId } from "@opencoven/agent-contracts";
import Image, { type StaticImageData } from "next/image";
import builderPortrait from "@/components/console/familiar-assets/builder.webp";
import criticPortrait from "@/components/console/familiar-assets/critic.webp";
import customPortrait from "@/components/console/familiar-assets/custom.webp";
import scoutPortrait from "@/components/console/familiar-assets/scout.webp";
import scribePortrait from "@/components/console/familiar-assets/scribe.webp";
import testerPortrait from "@/components/console/familiar-assets/tester.webp";
import {
  familiarForProfileId,
  resolveFamiliarProfileId,
} from "@/lib/console/familiars";
import { glyphFor } from "@/lib/console/format";

const PORTRAITS: Readonly<Record<string, StaticImageData>> = {
  builder: builderPortrait,
  critic: criticPortrait,
  custom: customPortrait,
  scout: scoutPortrait,
  scribe: scribePortrait,
  tester: testerPortrait,
};

export function FamiliarPortrait({
  familiarId = "auto",
  fallbackLabel,
  profileId,
  selected,
  size = 30,
}: {
  familiarId?: FamiliarId;
  fallbackLabel: string;
  profileId: string;
  selected: boolean;
  size?: number;
}) {
  const resolvedProfileId = resolveFamiliarProfileId(profileId, familiarId);
  const familiar = familiarForProfileId(resolvedProfileId);
  const portrait = PORTRAITS[resolvedProfileId];
  const title = familiar
    ? `${familiar.name}, the ${familiar.species} familiar`
    : `${fallbackLabel} profile`;

  return (
    <span
      aria-hidden="true"
      className="oc-familiar-portrait"
      data-profile-id={resolvedProfileId}
      data-selected={selected ? "true" : "false"}
      style={{
        fontSize: Math.round(size * 0.42),
        height: size,
        width: size,
      }}
      title={title}
    >
      {portrait ? (
        <>
          <Image
            alt=""
            height={size}
            priority={false}
            sizes={`${size}px`}
            src={portrait}
            unoptimized
            width={size}
          />
          {resolvedProfileId === "custom" ? (
            <span className="oc-familiar-portrait__monogram">
              {glyphFor(fallbackLabel)}
            </span>
          ) : null}
        </>
      ) : (
        glyphFor(fallbackLabel)
      )}
    </span>
  );
}
