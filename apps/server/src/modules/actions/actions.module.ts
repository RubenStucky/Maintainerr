import { Module } from '@nestjs/common';
import { MediaServerModule } from '../api/media-server/media-server.module';
import { SeerrApiModule } from '../api/seerr-api/seerr-api.module';
import { ServarrApiModule } from '../api/servarr-api/servarr-api.module';
import { TmdbApiModule } from '../api/tmdb-api/tmdb.module';
import { MediaIdFinder } from './media-id-finder';
import { RadarrActionHandler } from './radarr-action-handler';
import { RequestNextSeasonHandler } from './request-next-season-handler';
import { SonarrActionHandler } from './sonarr-action-handler';

@Module({
  imports: [MediaServerModule, TmdbApiModule, ServarrApiModule, SeerrApiModule],
  providers: [
    RadarrActionHandler,
    SonarrActionHandler,
    RequestNextSeasonHandler,
    MediaIdFinder,
  ],
  exports: [RadarrActionHandler, SonarrActionHandler, RequestNextSeasonHandler],
  controllers: [],
})
export class ActionsModule {}
