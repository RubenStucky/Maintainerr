import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaServerModule } from '../api/media-server/media-server.module';
import { SeerrApiModule } from '../api/seerr-api/seerr-api.module';
import { ServarrApiModule } from '../api/servarr-api/servarr-api.module';
import { TmdbApiModule } from '../api/tmdb-api/tmdb.module';
import { RuleActionCompletion } from '../rules/entities/rule-action-completion.entities';
import { RuleGroup } from '../rules/entities/rule-group.entities';
import { MediaIdFinder } from './media-id-finder';
import { RadarrActionHandler } from './radarr-action-handler';
import { RequestNextSeasonHandler } from './request-next-season-handler';
import { RuleActionCompletionRecorder } from './rule-action-completion-recorder.service';
import { SonarrActionHandler } from './sonarr-action-handler';

@Module({
  imports: [
    MediaServerModule,
    TmdbApiModule,
    ServarrApiModule,
    SeerrApiModule,
    TypeOrmModule.forFeature([RuleGroup, RuleActionCompletion]),
  ],
  providers: [
    RadarrActionHandler,
    SonarrActionHandler,
    RequestNextSeasonHandler,
    RuleActionCompletionRecorder,
    MediaIdFinder,
  ],
  exports: [
    RadarrActionHandler,
    SonarrActionHandler,
    RequestNextSeasonHandler,
    RuleActionCompletionRecorder,
  ],
  controllers: [],
})
export class ActionsModule {}
