import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRuleActionCompletions1781222400000
  implements MigrationInterface
{
  name = 'AddRuleActionCompletions1781222400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "rule_action_completion" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "ruleGroupId" integer NOT NULL,
                "userId" varchar NOT NULL,
                "username" varchar,
                "mediaServerId" varchar NOT NULL,
                "parent" varchar,
                "type" varchar,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_rule_action_completion_rulegroup" ON "rule_action_completion" ("ruleGroupId")
        `);
    await queryRunner.query(`
            ALTER TABLE "rule_group" ADD "excludeHandledUsers" boolean NOT NULL DEFAULT (0)
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "rule_group" DROP COLUMN "excludeHandledUsers"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_rule_action_completion_rulegroup"
        `);
    await queryRunner.query(`
            DROP TABLE "rule_action_completion"
        `);
  }
}
