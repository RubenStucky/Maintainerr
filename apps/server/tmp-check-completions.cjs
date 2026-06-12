const db = require('better-sqlite3')('../../data/maintainerr.sqlite', {
  readonly: true,
});
const rows = db
  .prepare(
    'SELECT id, ruleGroupId, userId, username, mediaServerId, parent, type, createdAt FROM rule_action_completion ORDER BY id DESC LIMIT 25',
  )
  .all();
console.log('completion rows:', rows.length);
for (const r of rows) console.log(JSON.stringify(r));
const groups = db
  .prepare('SELECT id, name, dataType, excludeHandledUsers FROM rule_group')
  .all();
for (const g of groups) console.log('group:', JSON.stringify(g));
