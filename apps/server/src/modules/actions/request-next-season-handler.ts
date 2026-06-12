import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { TmdbIdService } from '../api/tmdb-api/tmdb-id.service';
import { TmdbApiService } from '../api/tmdb-api/tmdb.service';
import { Collection } from '../collections/entities/collection.entities';
import { CollectionMedia } from '../collections/entities/collection_media.entities';
import { MaintainerrLogger } from '../logging/logs.service';
import { RuleActionCompletion } from '../rules/entities/rule-action-completion.entities';
import { RuleGroup } from '../rules/entities/rule-group.entities';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class RequestNextSeasonHandler {
  constructor(
    private readonly seerrApi: SeerrApiService,
    private readonly tmdbApi: TmdbApiService,
    private readonly tmdbIdService: TmdbIdService,
    private readonly mediaServerFactory: MediaServerFactory,
    private readonly settings: SettingsService,
    @InjectRepository(RuleGroup)
    private readonly ruleGroupRepo: Repository<RuleGroup>,
    @InjectRepository(RuleActionCompletion)
    private readonly ruleActionCompletionRepo: Repository<RuleActionCompletion>,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(RequestNextSeasonHandler.name);
  }

  /**
   * Handle the "Request Next Season" action for a matched season-level media item.
   *
   * Flow:
   * 1. Determine the current season number from media server metadata
   * 2. Resolve the TMDb ID for the show
   * 3. Check if a next season exists on TMDb
   * 4. Check if the next season is already requested in Seerr
   * 5. Find the watching user(s) and resolve to a Seerr user ID
   * 6. Create the request in Seerr on behalf of the resolved user
   */
  public async handleAction(
    collection: Collection,
    media: CollectionMedia,
  ): Promise<void> {
    if (!this.settings.seerrConfigured()) {
      this.logger.warn(
        'Seerr is not configured. Cannot request next season.',
      );
      return;
    }

    if (collection.type !== 'season') {
      this.logger.warn(
        `Request next season action is only supported for season-level collections. Got type: '${collection.type}'`,
      );
      return;
    }

    const mediaServer = await this.mediaServerFactory.getService();

    // Step 1: Get current season metadata
    const mediaData = await mediaServer.getMetadata(media.mediaServerId);
    if (!mediaData?.index) {
      this.logger.warn(
        `Could not determine season number for media server id ${media.mediaServerId}. Skipping request.`,
      );
      return;
    }

    const currentSeasonNumber = mediaData.index;
    const nextSeasonNumber = currentSeasonNumber + 1;

    // Step 2: Resolve TMDb ID for the show
    let tmdbId = media.tmdbId;
    if (!tmdbId && mediaData.parentId) {
      const tmdbResult =
        await this.tmdbIdService.getTmdbIdFromMediaServerId(
          mediaData.parentId,
        );
      tmdbId = tmdbResult?.id;
    }

    if (!tmdbId) {
      this.logger.warn(
        `Could not resolve TMDb ID for media server id ${media.mediaServerId}. Skipping request.`,
      );
      return;
    }

    // Step 3: Check if a next season exists on TMDb (safety net — prefer sw_nextSeasonExists rule constant)
    const tmdbShow = await this.tmdbApi.getTvShow({ tvId: tmdbId });
    if (!tmdbShow) {
      this.logger.warn(
        `Could not fetch TMDb show data for tmdbId ${tmdbId}. Skipping request.`,
      );
      return;
    }

    const nextSeasonExists = tmdbShow.seasons?.some(
      (s) => s.season_number === nextSeasonNumber,
    );

    if (!nextSeasonExists) {
      this.logger.log(
        `No next season (S${String(nextSeasonNumber).padStart(2, '0')}) exists for '${tmdbShow.name}' (tmdbId: ${tmdbId}). Skipping request. Consider using the 'Next season exists (TMDb)' rule constant to prevent items from entering the collection.`,
      );
      return;
    }

    // Step 4: Check if the next season is already requested in Seerr (safety net — prefer sw_nextSeasonRequested rule constant)
    const alreadyRequested = await this.seerrApi.isSeasonRequested(
      tmdbId,
      nextSeasonNumber,
    );

    if (alreadyRequested) {
      this.logger.log(
        `Season ${nextSeasonNumber} of '${tmdbShow.name}' is already requested in Seerr. Skipping. Consider using the 'Next season already requested in Seerr' rule constant to prevent items from entering the collection.`,
      );
      return;
    }

    // Step 5: Resolve a Seerr user to make the request on behalf of.
    // Pick the watcher who has watched the most episodes of the current season
    // (i.e. closest to needing the next season), then map to a Seerr user ID.
    // Skip any user who has already watched (part of) the next season.
    let seerrUserId: number | undefined;

    // When the rule group opts in, skip users this rule already successfully
    // ran for on this media item, and record new completions so their stats
    // are excluded from future rule evaluations.
    const ruleGroup = await this.ruleGroupRepo.findOne({
      where: { collectionId: collection.id },
    });
    const excludeHandled = ruleGroup?.excludeHandledUsers ?? false;
    const handledUserIds = new Set<string>(
      excludeHandled
        ? (
            await this.ruleActionCompletionRepo.find({
              where: {
                ruleGroupId: ruleGroup.id,
                mediaServerId: media.mediaServerId,
              },
            })
          ).map((c) => c.userId)
        : [],
    );

    // Resolve the next season's media server ID so we can check watch history
    const showId = mediaData.parentId;
    let nextSeasonMediaServerId: string | undefined;
    if (showId) {
      const showSeasons = await mediaServer.getChildrenMetadata(showId);
      const nextSeason = showSeasons?.find(
        (s) => s.index === nextSeasonNumber,
      );
      nextSeasonMediaServerId = nextSeason?.id;

      // If the next season isn't on the media server but a HIGHER-numbered season exists,
      // it means the next season was previously downloaded and then deleted (watched & cleaned up).
      // Don't re-request it.
      if (!nextSeasonMediaServerId && showSeasons?.length) {
        const higherSeasonExists = showSeasons.some(
          (s) => s.index > nextSeasonNumber,
        );
        if (higherSeasonExists) {
          this.logger.log(
            `Season ${nextSeasonNumber} of '${tmdbShow.name}' is not on the media server, but a higher season exists ` +
              `(indices: ${showSeasons.map((s) => s.index).join(', ')}). ` +
              `It was likely already downloaded, watched, and deleted. Skipping request.`,
          );
          return;
        }
      }
    }

    const watcherProgress = await this.getWatcherProgressForSeason(
      mediaServer,
      media.mediaServerId,
    );

    if (watcherProgress.length > 0) {
      // Sort descending by episodes watched — the user closest to the next season comes first
      watcherProgress.sort((a, b) => b.episodesWatched - a.episodesWatched);

      let skippedDueToWatched = 0;
      let skippedDueToHandled = 0;

      for (const watcher of watcherProgress) {
        // Skip users this rule already successfully ran for on this media item
        if (handledUserIds.has(watcher.userId)) {
          this.logger.log(
            `Skipping user '${watcher.username}' (id: ${watcher.userId}) — this rule already ran for them on this media item`,
          );
          skippedDueToHandled++;
          continue;
        }

        // Check if this user has already watched part of the next season
        if (nextSeasonMediaServerId) {
          const hasWatchedNextSeason =
            await this.hasUserWatchedAnySeason(
              mediaServer,
              nextSeasonMediaServerId,
              watcher.userId,
            );

          if (hasWatchedNextSeason) {
            this.logger.log(
              `Skipping user '${watcher.username}' (id: ${watcher.userId}) — already watched (part of) season ${nextSeasonNumber}`,
            );
            skippedDueToWatched++;

            // They're past this season already — record the completion so
            // their stats are excluded from future runs of this rule.
            if (excludeHandled) {
              await this.recordCompletion(
                ruleGroup.id,
                collection,
                media,
                showId,
                watcher,
                handledUserIds,
              );
            }
            continue;
          }
        }

        const userId = await this.seerrApi.getUserIdByUsername(
          watcher.username,
        );
        if (userId) {
          seerrUserId = userId;
          this.logger.log(
            `Resolved Seerr user '${watcher.username}' (${watcher.episodesWatched} episodes watched) for next season request`,
          );
          break;
        } else {
          this.logger.debug(
            `Could not resolve Seerr user for watcher '${watcher.username}' (media server userId: ${watcher.userId})`,
          );
        }
      }

      // If ALL watchers have already seen the next season or were already
      // handled by this rule, skip entirely
      if (
        skippedDueToWatched + skippedDueToHandled ===
        watcherProgress.length
      ) {
        this.logger.log(
          `All ${watcherProgress.length} watcher(s) of season ${currentSeasonNumber} of '${tmdbShow.name}' have already watched (part of) season ${nextSeasonNumber} or were already handled by this rule. Skipping request.`,
        );
        return;
      }
    }

    // Fallback: if no watcher mapped, try the original Seerr requester
    if (!seerrUserId) {
      const seerrShow = await this.seerrApi.getShow(tmdbId);
      if (seerrShow?.mediaInfo?.requests?.length) {
        const originalRequest = seerrShow.mediaInfo.requests[0];
        seerrUserId = originalRequest.requestedBy?.id;
      }
    }

    if (!seerrUserId) {
      this.logger.warn(
        `Could not resolve a Seerr user for requesting season ${nextSeasonNumber} of '${tmdbShow.name}'. Creating request as admin.`,
      );
    }

    // Step 6: Create the request in Seerr
    const result = await this.seerrApi.createRequest(
      'tv',
      tmdbId,
      [nextSeasonNumber],
      seerrUserId,
    );

    if (result) {
      this.logger.log(
        `[Seerr] Requested season ${nextSeasonNumber} of '${tmdbShow.name}' (tmdbId: ${tmdbId})` +
          (seerrUserId ? ` on behalf of Seerr user ${seerrUserId}` : ''),
      );

      // The action ran successfully for every current watcher of this season:
      // record completions so their stats are excluded from future runs.
      if (excludeHandled) {
        for (const watcher of watcherProgress) {
          await this.recordCompletion(
            ruleGroup.id,
            collection,
            media,
            showId,
            watcher,
            handledUserIds,
          );
        }
      }
    } else {
      this.logger.warn(
        `[Seerr] Failed to request season ${nextSeasonNumber} of '${tmdbShow.name}' (tmdbId: ${tmdbId})`,
      );
    }
  }

  /**
   * Record that this rule successfully ran for a (user, media item)
   * combination, so the user's stats are excluded from future rule
   * evaluations and the user is skipped by this handler.
   */
  private async recordCompletion(
    ruleGroupId: number,
    collection: Collection,
    media: CollectionMedia,
    showId: string | undefined,
    watcher: { userId: string; username: string },
    handledUserIds: Set<string>,
  ): Promise<void> {
    if (handledUserIds.has(watcher.userId)) {
      return;
    }

    try {
      await this.ruleActionCompletionRepo.save({
        ruleGroupId,
        userId: watcher.userId,
        username: watcher.username,
        mediaServerId: media.mediaServerId,
        parent: showId,
        type: collection.type,
      });
      handledUserIds.add(watcher.userId);
      this.logger.log(
        `Recorded rule completion for user '${watcher.username}' on media item ${media.mediaServerId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record rule completion for user '${watcher.username}' on media item ${media.mediaServerId}`,
      );
      this.logger.debug(error);
    }
  }

  /**
   * Get the list of watchers for a season, ranked by how many episodes they've watched.
   * The user with the most watched episodes is "closest to the next season".
   */
  private async getWatcherProgressForSeason(
    mediaServer: Awaited<ReturnType<MediaServerFactory['getService']>>,
    mediaServerId: string,
  ): Promise<{ userId: string; username: string; episodesWatched: number }[]> {
    try {
      const children = await mediaServer.getChildrenMetadata(mediaServerId);
      if (!children?.length) return [];

      // Count unique episodes watched per user ID
      const userEpisodeMap = new Map<
        string,
        { userId: string; episodeKeys: Set<string> }
      >();

      for (const child of children) {
        const watchHistory = await mediaServer.getWatchHistory(child.id);
        if (!watchHistory) continue;

        for (const entry of watchHistory) {
          if (!entry.userId) continue;

          let userData = userEpisodeMap.get(entry.userId);
          if (!userData) {
            userData = { userId: entry.userId, episodeKeys: new Set() };
            userEpisodeMap.set(entry.userId, userData);
          }
          userData.episodeKeys.add(child.id);
        }
      }

      // Resolve actual usernames from the media server.
      // WatchRecord.userId is a numeric accountID (Plex) or UUID (Jellyfin),
      // but Seerr needs the human-readable username for lookup.
      const results: {
        userId: string;
        username: string;
        episodesWatched: number;
      }[] = [];

      for (const entry of userEpisodeMap.values()) {
        let username = entry.userId; // fallback to raw ID
        try {
          const mediaUser = await mediaServer.getUser(entry.userId);
          if (mediaUser?.name) {
            username = mediaUser.name;
          }
        } catch {
          this.logger.debug(
            `Could not resolve username for media server userId '${entry.userId}'`,
          );
        }

        results.push({
          userId: entry.userId,
          username,
          episodesWatched: entry.episodeKeys.size,
        });
      }

      return results;
    } catch (error) {
      this.logger.debug(error);
      return [];
    }
  }

  /**
   * Check whether a specific user has watched at least one episode of a season.
   */
  private async hasUserWatchedAnySeason(
    mediaServer: Awaited<ReturnType<MediaServerFactory['getService']>>,
    seasonMediaServerId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const episodes =
        await mediaServer.getChildrenMetadata(seasonMediaServerId);
      if (!episodes?.length) {
        this.logger.debug(
          `hasUserWatchedAnySeason: no episodes found for season ${seasonMediaServerId}`,
        );
        return false;
      }

      for (const episode of episodes) {
        const watchHistory = await mediaServer.getWatchHistory(episode.id);
        if (watchHistory?.some((entry) => entry.userId === userId)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.debug(error);
      return false;
    }
  }
}
