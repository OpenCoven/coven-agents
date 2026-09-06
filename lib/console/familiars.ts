export type FamiliarDefinition = Readonly<{
  name: string;
  profileId: string;
  species: string;
}>;

const FAMILIARS: Readonly<Record<string, FamiliarDefinition>> = {
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
  return FAMILIARS[profileId] ?? null;
}
