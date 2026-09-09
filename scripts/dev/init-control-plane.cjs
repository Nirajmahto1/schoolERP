// dev-only: ensure CONTROL_PLANE_DATABASE_URL exists in .env and the control
// database exists in the local cluster. Idempotent.
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const envPath = 'd:/FinalPlan/Projects/schoolERP/.env';
const text = fs.readFileSync(envPath, 'utf8');

function get(key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

async function main() {
  const databaseUrl = get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL missing from .env');

  // Derive the control-plane URL from DATABASE_URL by swapping the database name.
  const controlUrl = databaseUrl.replace(/\/([^/?]+)(\?[^/]*)?$/, '/school_erp_control$2');

  if (!text.includes('CONTROL_PLANE_DATABASE_URL=')) {
    const block = `\n# Control plane (Phase 1): platform registry database.\nCONTROL_PLANE_DATABASE_URL=${controlUrl}\n`;
    fs.writeFileSync(envPath, text.replace(/\s*$/, '') + block, 'utf8');
    console.log('added CONTROL_PLANE_DATABASE_URL to .env');
  } else {
    console.log('CONTROL_PLANE_DATABASE_URL already present');
  }

  // Create the control database if it does not exist.
  const maintenance = databaseUrl.replace(/\/([^/?]+)(\?[^/]*)?$/, '/postgres$2');
  const admin = new PrismaClient({ datasourceUrl: maintenance });
  try {
    const rows = await admin.$queryRawUnsafe(
      "SELECT 1 AS ok FROM pg_database WHERE datname = 'school_erp_control'",
    );
    if (rows.length === 0) {
      await admin.$executeRawUnsafe('CREATE DATABASE "school_erp_control"');
      console.log('created database school_erp_control');
    } else {
      console.log('database school_erp_control already exists');
    }
  } finally {
    await admin.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});