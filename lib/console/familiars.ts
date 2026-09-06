import type { FamiliarId } from "@opencoven/agent-contracts";

export type FamiliarDefinition = Readonly<{
  name: string;
  profileId: Exclude<FamiliarId, "auto">;
  species: string;
}>;

export const FAMILIARS: Readonly<
  Record<Exclude<FamiliarId, "auto">, FamiliarDefinition>
> = {
  builder: {
    name: "Cinder",
    profileId: "builder",
    species: "forge salamander",
  },
  critic: {
    name: "Rook",
    profileId: "critic",
    species: "obsidian raven",
  },
  custom: {
    name: "Unbound",
    profileId: "custom",
    species: "moonstone cat",
  },
  scout: {
    name: "Vesper",
    profileId: "scout",
    species: "silver fox",
  },
  scribe: {
    name: "Morrow",
    profileId: "scribe",
    species: "archival owl",
  },
  tester: {
    name: "Tinker",
    profileId: "tester",
    species: "clockwork stoat",
  },
};

export function familiarForProfileId(
  profileId: string
): FamiliarDefinition | null {
  return profileId in FAMILIARS
    ? FAMILIARS[profileId as Exclude<FamiliarId, "auto">]
    : null;
}

export function resolveFamiliarProfileId(
  profileId: string,
  familiarId: FamiliarId = "auto"
): Exclude<FamiliarId, "auto"> {
  if (familiarId !== "auto") {
    return familiarId;
  }
  return familiarForProfileId(profileId)?.profileId ?? "custom";
}
