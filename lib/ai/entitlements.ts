import type { UserType } from "@/app/(auth)/auth";

type Entitlements = {
  maxMessagesPerHour: number;
};

export const entitlementsByUserType: Record<UserType, Entitlements> = {
  guest: {
    maxMessagesPerHour: 10,
  },
  regular: {
    maxMessagesPerHour: 10,
  },
  /**
   * A paying tenant. Kept deliberately modest until billing exists to make it
   * meaningful — this entry exists because `UserType` gained `subscriber` and
   * the Record type refuses to be incomplete, which is the point of it.
   */
  subscriber: {
    maxMessagesPerHour: 200,
  },
};
