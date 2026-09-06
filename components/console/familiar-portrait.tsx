import Image, { type StaticImageData } from "next/image";
import builderPortrait from "@/components/console/familiar-assets/builder.webp";
import criticPortrait from "@/components/console/familiar-assets/critic.webp";
import scoutPortrait from "@/components/console/familiar-assets/scout.webp";
import scribePortrait from "@/components/console/familiar-assets/scribe.webp";
import testerPortrait from "@/components/console/familiar-assets/tester.webp";
import { familiarForProfileId } from "@/lib/console/familiars";
import { glyphFor } from "@/lib/console/format";

const PORTRAITS: Readonly<Record<string, StaticImageData>> = {
  builder: builderPortrait,
  critic: criticPortrait,
  scout: scoutPortrait,
  scribe: scribePortrait,
  tester: testerPortrait,
};

export function FamiliarPortrait({
  fallbackLabel,
  profileId,
  selected,
  size = 30,
}: {
  fallbackLabel: string;
  profileId: string;
  selected: boolean;
  size?: number;
}) {
  const familiar = familiarForProfileId(profileId);
  const portrait = PORTRAITS[profileId];
  const title = familiar
    ? `${familiar.name}, the ${familiar.species} familiar`
    : `${fallbackLabel} profile`;

  return (
    <span
      aria-hidden="true"
      className="oc-familiar-portrait"
      data-profile-id={profileId}
      data-selected={selected ? "true" : "false"}
      style={{
        fontSize: Math.round(size * 0.42),
        height: size,
        width: size,
      }}
      title={title}
    >
      {portrait ? (
        <Image
          alt=""
          height={size}
          priority={false}
          sizes={`${size}px`}
          src={portrait}
          unoptimized
          width={size}
        />
      ) : (
        glyphFor(fallbackLabel)
      )}
    </span>
  );
}
