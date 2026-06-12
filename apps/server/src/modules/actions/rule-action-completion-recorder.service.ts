import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { Collection } from '../collections/entities/collection.entities';
import { CollectionMedia } from '../collections/entities/collection_media.entities';
import { MaintainerrLogger } from '../logging/logs.service';
import { RuleActionCompletion } from '../rules/entities/rule-action-completion.entities';
import { RuleGroup } from '../rules/entities/rule-group.entities';

@Injectable()
export class RuleActionCompletionRecorder {
  constructor(
    private readonly mediaServerFactory: MediaServerFactory,
    @InjectRepository(RuleGroup)
    private readonly ruleGroupRepo: Repository<RuleGroup>,
    @InjectRepository(RuleActionCompletion)
    private readonly completionRepo: Repository<RuleActionCompletion>,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(RuleActionCompletionRecorder.name);
  }

  /**
   * Record rule completions for every user that fully watched the media
   * item (for seasons/shows: saw all available episodes), when the rule
   * group opts in via excludeHandledUsers. Used by generic collection
   * actions (delete, unmonitor, ...) so those users' stats are excluded
   * from future rule evaluations and the rule doesn't re-trigger for them
   * when the media is re-added. Partial watchers are NOT recorded — their
   * stats keep counting.
   *
   * Must be called BEFORE the media is deleted from the media server, since
   * it reads the item's watch history.
   */
  public async recordCompletionsForWatchers(
    collection: Collection,
    media: CollectionMedia,
  ): Promise<void> {
    try {
      const ruleGroup = await this.ruleGroupRepo.findOne({
        where: { collectionId: collection.id },
      });
      if (!ruleGroup?.excludeHandledUsers) {
        return;
      }

      const mediaServer = await this.mediaServerFactory.getService();
      const mediaData = await mediaServer.getMetadata(media.mediaServerId);
      const seasonIndex =
        collection.type === 'season' ? (mediaData?.index ?? null) : null;

      const watcherIds = await this.getUsersWhoSawAllEpisodes(
        mediaServer,
        media.mediaServerId,
        collection.type,
      );
      if (watcherIds.length === 0) {
        return;
      }

      const existing = await this.completionRepo.find({
        where: { ruleGroupId: ruleGroup.id, mediaServerId: media.mediaServerId },
      });
      const handled = new Set(existing.map((c) => c.userId));

      for (const userId of watcherIds) {
        if (handled.has(userId)) {
          continue;
        }

        let username = userId;
        try {
          const user = await mediaServer.getUser(userId);
          if (user?.name) {
            username = user.name;
          }
        } catch {
          // keep the raw id as username fallback
        }

        await this.completionRepo.save({
          ruleGroupId: ruleGroup.id,
          userId,
          username,
          mediaServerId: media.mediaServerId,
          parent: mediaData?.parentId,
          tmdbId: media.tmdbId ?? null,
          seasonIndex,
          type: collection.type,
        });
        handled.add(userId);
        this.logger.log(
          `Recorded rule completion for user '${username}' on media item ${media.mediaServerId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to record rule completions for media item ${media.mediaServerId}`,
      );
      this.logger.debug(error);
    }
  }

  /**
   * Users that fully consumed the media item. For movies and episodes:
   * anyone in its watch history. For seasons and shows: only users that
   * appear in the watch history of EVERY available episode.
   */
  private async getUsersWhoSawAllEpisodes(
    mediaServer: Awaited<ReturnType<MediaServerFactory['getService']>>,
    mediaServerId: string,
    type: Collection['type'],
  ): Promise<string[]> {
    if (type === 'movie' || type === 'episode') {
      const history = await mediaServer.getWatchHistory(mediaServerId);
      return [...new Set((history ?? []).map((r) => r.userId).filter(Boolean))];
    }

    // seasons & shows: gather all episode ids
    const episodeIds: string[] = [];
    if (type === 'season') {
      const episodes = await mediaServer.getChildrenMetadata(mediaServerId);
      episodeIds.push(...(episodes ?? []).map((e) => e.id));
    } else {
      const seasons = await mediaServer.getChildrenMetadata(mediaServerId);
      for (const season of seasons ?? []) {
        const episodes = await mediaServer.getChildrenMetadata(season.id);
        episodeIds.push(...(episodes ?? []).map((e) => e.id));
      }
    }

    if (episodeIds.length === 0) {
      return [];
    }

    // intersect the viewers of every episode
    let qualified: Set<string> | undefined;
    for (const episodeId of episodeIds) {
      const history = await mediaServer.getWatchHistory(episodeId);
      const viewers = new Set(
        (history ?? []).map((r) => r.userId).filter(Boolean),
      );

      qualified =
        qualified === undefined
          ? viewers
          : new Set([...qualified].filter((u) => viewers.has(u)));

      if (qualified.size === 0) {
        return [];
      }
    }

    return [...(qualified ?? [])];
  }
}
