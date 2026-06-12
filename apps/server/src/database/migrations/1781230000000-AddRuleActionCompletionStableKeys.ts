import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRuleActionCompletionStableKeys1781230000000
  implements MigrationInterface
{
  name = 'AddRuleActionCompletionStableKeys1781230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "rule_action_completion" ADD "tmdbId" integer
        `);
    await queryRunner.query(`
            ALTER TABLE "rule_action_completion" ADD "seasonIndex" integer
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "rule_action_completion" DROP COLUMN "seasonIndex"
        `);
    await queryRunner.query(`
            ALTER TABLE "rule_action_completion" DROP COLUMN "tmdbId"
        `);
  }
}
