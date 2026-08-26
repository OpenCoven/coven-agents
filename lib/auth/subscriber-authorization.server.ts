import "server-only";

import { findUserById } from "@/lib/db/queries";
import type { SessionLike } from "./subscriber-access";
import { revalidateSubscriberAccess } from "./subscriber-authorization";

export function authorizeSubscriberAccess(session: SessionLike) {
  return revalidateSubscriberAccess(session, findUserById);
}
