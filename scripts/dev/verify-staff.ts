import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ where: { role: 'PRINCIPAL' } });
  console.log('Principal Users:', JSON.stringify(users, null, 2));

  for (const u of users) {
    const staff = await prisma.staff.findFirst({ where: { userId: u.id } });
    console.log(`Staff for User ${u.id}:`, JSON.stringify(staff, null, 2));
  }
}
main().finally(() => prisma.$disconnect());
