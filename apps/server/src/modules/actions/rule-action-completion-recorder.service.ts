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
   * Record rule completions for every user that watched (part of) the media
   * item, when the rule group opts in via excludeHandledUsers. Used by
   * generic collection actions (delete, unmonitor, ...) so the watchers'
   * stats are excluded from future rule evaluations and the rule doesn't
   * re-trigger for them when the media is re-added.
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

      const history = await mediaServer.getWatchHistory(media.mediaServerId);
      const watcherIds = [
        ...new Set((history ?? []).map((r) => r.userId).filter(Boolean)),
      ];
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
}
