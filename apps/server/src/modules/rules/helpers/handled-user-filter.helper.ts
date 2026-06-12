import { RulesDto } from '../dtos/rules.dto';

/**
 * Resolved set of users whose stats must be excluded for a specific media
 * item, because the rule's action already successfully ran for the
 * (user, media item) combination. See `RuleGroup.excludeHandledUsers`.
 */
export interface HandledUserFilter {
  userIds: Set<string>;
  // lowercased usernames
  usernames: Set<string>;
}

interface ItemRef {
  id: string;
  parentId?: string;
  grandparentId?: string;
}

/**
 * Build the handled-user filter for a media item from the completions
 * preloaded on the rule group DTO. Returns undefined when the feature is
 * disabled or no completion applies to this item, so callers can skip
 * filtering entirely.
 *
 * A completion applies to the exact media item it was recorded for and to
 * that item's children (e.g. episodes of a handled season).
 */
export function getHandledUserFilter(
  ruleGroup: RulesDto | undefined,
  item: ItemRef,
): HandledUserFilter | undefined {
  if (!ruleGroup?.excludeHandledUsers) return undefined;

  const completions = ruleGroup.handledUserCompletions;
  if (!completions?.length) return undefined;

  const relevant = completions.filter(
    (c) =>
      c.mediaServerId === item.id ||
      (item.parentId && c.mediaServerId === item.parentId) ||
      (item.grandparentId && c.mediaServerId === item.grandparentId),
  );

  if (!relevant.length) return undefined;

  return {
    userIds: new Set(
      relevant.map((c) => String(c.userId)).filter((id) => id !== ''),
    ),
    usernames: new Set(
      relevant
        .map((c) => c.username?.toLowerCase())
        .filter((u): u is string => !!u),
    ),
  };
}

export function isHandledUser(
  filter: HandledUserFilter | undefined,
  userId?: string | number | null,
  username?: string | null,
): boolean {
  if (!filter) return false;
  if (userId != null && filter.userIds.has(String(userId))) return true;
  if (username && filter.usernames.has(username.toLowerCase())) return true;
  return false;
}
