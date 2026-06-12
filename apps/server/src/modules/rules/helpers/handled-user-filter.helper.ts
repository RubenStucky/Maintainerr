import { RulesDto } from '../dtos/rules.dto';
import { RuleActionCompletion } from '../entities/rule-action-completion.entities';

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
  index?: number;
  parentIndex?: number;
}

/**
 * Return the completions (preloaded on the rule group DTO) that apply to a
 * media item. A completion applies to the exact media item it was recorded
 * for and to that item's children (e.g. episodes of a handled season).
 *
 * Media server ids change when an item is deleted and re-downloaded, so a
 * completion also applies when its recorded parent (the show) and season
 * number line up with the evaluated item — that combination is stable as
 * long as the show itself remains on the server.
 */
export function getHandledCompletionsForItem(
  ruleGroup: RulesDto | undefined,
  item: ItemRef,
): RuleActionCompletion[] {
  if (!ruleGroup?.excludeHandledUsers) return [];

  const completions = ruleGroup.handledUserCompletions;
  if (!completions?.length) return [];

  return completions.filter(
    (c) =>
      c.mediaServerId === item.id ||
      (item.parentId && c.mediaServerId === item.parentId) ||
      (item.grandparentId && c.mediaServerId === item.grandparentId) ||
      (c.parent != null &&
        c.seasonIndex != null &&
        // the evaluated item is the (re-added) season itself
        ((item.parentId === c.parent && item.index === c.seasonIndex) ||
          // the evaluated item is an episode of the (re-added) season
          (item.grandparentId === c.parent &&
            item.parentIndex === c.seasonIndex))),
  );
}

/**
 * Build the handled-user filter for a media item from the completions
 * preloaded on the rule group DTO. Returns undefined when the feature is
 * disabled or no completion applies to this item, so callers can skip
 * filtering entirely.
 */
export function getHandledUserFilter(
  ruleGroup: RulesDto | undefined,
  item: ItemRef,
): HandledUserFilter | undefined {
  const relevant = getHandledCompletionsForItem(ruleGroup, item);

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
