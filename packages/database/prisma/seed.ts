// ──────────────────────────────────────────────
// School ERP — Database Seed (GATE 2)
//
// Produces a realistic demo school: 3 branches, ~1,200 students, two academic
// years, with attendance, exam results, and a fee ledger that ties out — the
// BUILD_PLAN 13.2.1 "never demo on empty tables" asset.
//
// The heavy lifting lives in @school-erp/domain's demo-seed (imported by
// relative path so `pnpm db:seed` needs no build step).
// ──────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { seedDemoTenant } from '@school-erp/domain';

dotenv.config({ path: '../../.env' });

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  const result = await seedDemoTenant(prisma, {
    code: 'DEMO',
    schoolName: 'Delhi Public School',
    branches: 3,
    studentsPerBranch: 400,
    attendanceDaysPerYear: 30,
  });

  const s = result.stats;
  console.log(`✅ School: ${result.schoolId}`);
  console.log(`✅ Branches: ${result.branchIds.length} (${result.branchIds.join(', ')})`);
  console.log(`✅ Academic years: ${result.academicYearIds.past} (past) → ${result.academicYearIds.current} (current)`);
  console.log(`✅ Students: ${s.students}`);
  console.log(`✅ Enrollments (2 years): ${s.enrollments}`);
  console.log(`✅ Users: ${s.users}`);
  console.log(`✅ Attendance sessions/records/summaries: ${s.attendanceSessions} / ${s.attendanceRecords} / ${s.attendanceSummaries}`);
  console.log(`✅ Exam results: ${s.examResults}`);
  console.log(`✅ Invoices / lines / payments / ledger entries: ${s.invoices} / ${s.invoiceLines} / ${s.payments} / ${s.ledgerEntries}`);

  console.log('\n🎉 Seed complete! You can log in with:');
  console.log('   Email: admin@demo-main.demo.edu.in');
  console.log('   Password: Admin@123');
  console.log('   (Same password for all seeded users — teachers, parents, students)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });