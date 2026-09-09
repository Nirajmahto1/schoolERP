// dev-only cleanup: drop scratch schemas/databases left by earlier probe runs
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const envPath = 'd:/FinalPlan/Projects/schoolERP/.env';
const text = fs.readFileSync(envPath, 'utf8');
const match = text.match(/^DATABASE_URL=(.*)$/m);
if (!match) {
  console.log('no DATABASE_URL in .env');
  process.exit(0);
}
const base = match[1].trim().replace(/"?\s*$/,'').replace(/^"?/,'');

const admin = new PrismaClient({ datasourceUrl: base.replace(/\?schema=.*$/, '?schema=public') });
admin
  .$executeRawUnsafe('DROP SCHEMA IF EXISTS "migrate_check" CASCADE')
  .then(() => console.log('drop schema ok'))
  .catch((e) => console.log('drop schema note:', (e.message || '').split('\n')[0]))
  .finally(() => admin.$disconnect());