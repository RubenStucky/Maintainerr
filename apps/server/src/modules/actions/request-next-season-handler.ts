import { Injectable } from '@nestjs/common';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { TmdbIdService } from '../api/tmdb-api/tmdb-id.service';
import { TmdbApiService } from '../api/tmdb-api/tmdb.service';
import { Collection } from '../collections/entities/collection.entities';
import { CollectionMedia } from '../collections/entities/collection_media.entities';
import { MaintainerrLogger } from '../logging/logs.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class RequestNextSeasonHandler {
  constructor(
    private readonly seerrApi: SeerrApiService,
    private readonly tmdbApi: TmdbApiService,
    private readonly tmdbIdService: TmdbIdService,
    private readonly mediaServerFactory: MediaServerFactory,
    private readonly settings: SettingsService,
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

    // Step 3: Check if a next season exists on TMDb
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
        `No next season (S${String(nextSeasonNumber).padStart(2, '0')}) exists for '${tmdbShow.name}' (tmdbId: ${tmdbId}). Skipping request.`,
      );
      return;
    }

    // Step 4: Check if the next season is already requested in Seerr
    const alreadyRequested = await this.seerrApi.isSeasonRequested(
      tmdbId,
      nextSeasonNumber,
    );

    if (alreadyRequested) {
      this.logger.log(
        `Season ${nextSeasonNumber} of '${tmdbShow.name}' is already requested in Seerr. Skipping.`,
      );
      return;
    }

    // Step 5: Resolve a Seerr user to make the request on behalf of.
    // Pick the watcher who has watched the most episodes of the current season
    // (i.e. closest to needing the next season), then map to a Seerr user ID.
    // Skip any user who has already watched (part of) the next season.
    let seerrUserId: number | undefined;
    let chosenUsername: string | undefined;

    // Resolve the next season's media server ID so we can check watch history
    const showId = mediaData.parentId;
    let nextSeasonMediaServerId: string | undefined;
    if (showId) {
      const showSeasons = await mediaServer.getChildrenMetadata(showId);
      const nextSeason = showSeasons?.find(
        (s) => s.index === nextSeasonNumber,
      );
      nextSeasonMediaServerId = nextSeason?.id;
    }

    const watcherProgress = await this.getWatcherProgressForSeason(
      mediaServer,
      media.mediaServerId,
    );

    if (watcherProgress.length > 0) {
      // Sort descending by episodes watched — the user closest to the next season comes first
      watcherProgress.sort((a, b) => b.episodesWatched - a.episodesWatched);

      for (const watcher of watcherProgress) {
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
              `Skipping user '${watcher.username}' — already watched (part of) season ${nextSeasonNumber}`,
            );
            continue;
          }
        }

        const userId = await this.seerrApi.getUserIdByUsername(
          watcher.username,
        );
        if (userId) {
          seerrUserId = userId;
          chosenUsername = watcher.username;
          this.logger.log(
            `Resolved Seerr user '${watcher.username}' (${watcher.episodesWatched} episodes watched) for next season request`,
          );
          break;
        }
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

    // If all watchers have already seen the next season, skip entirely
    if (
      !seerrUserId &&
      watcherProgress.length > 0 &&
      !chosenUsername
    ) {
      this.logger.log(
        `All watchers of season ${currentSeasonNumber} of '${tmdbShow.name}' have already watched (part of) season ${nextSeasonNumber}. Skipping request.`,
      );
      return;
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
    } else {
      this.logger.warn(
        `[Seerr] Failed to request season ${nextSeasonNumber} of '${tmdbShow.name}' (tmdbId: ${tmdbId})`,
      );
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

      // Convert to result array with episode count.
      // userId from the media server is used as the username for Seerr lookup,
      // since media server watch records store the user identifier.
      return Array.from(userEpisodeMap.values()).map((entry) => ({
        userId: entry.userId,
        username: entry.userId,
        episodesWatched: entry.episodeKeys.size,
      }));
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
      if (!episodes?.length) return false;

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
