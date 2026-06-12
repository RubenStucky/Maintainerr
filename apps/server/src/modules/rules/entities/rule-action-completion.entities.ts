import { MediaItemType } from '@maintainerr/contracts';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Records that a rule's action has successfully run for a specific
 * (user, media item) combination. When the rule group has
 * `excludeHandledUsers` enabled, these users are excluded from user
 * statistics (seen by, watchers, view counts, ...) for the recorded media
 * item in future rule evaluations, and action handlers skip them.
 */
@Entity('rule_action_completion')
@Index('idx_rule_action_completion_rulegroup', ['ruleGroupId'])
export class RuleActionCompletion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  ruleGroupId: number;

  // Media server user identifier (Plex accountID / Jellyfin user UUID)
  @Column()
  userId: string;

  @Column({ nullable: true })
  username: string;

  // The media item the rule matched when the action ran (e.g. the season)
  @Column()
  mediaServerId: string;

  // Parent media item (e.g. the show), when applicable
  @Column({ nullable: true })
  parent: string;

  @Column({ nullable: true })
  type: MediaItemType | undefined;

  @Column({
    type: 'datetime',
    nullable: false,
    default: () => "datetime('now')",
  })
  createdAt: Date;
}
