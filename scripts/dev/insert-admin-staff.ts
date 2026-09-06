import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' })

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { role: { in: ['SUPER_ADMIN', 'PRINCIPAL'] } }
  });

  for (const user of users) {
    const existing = await prisma.staff.findFirst({ where: { userId: user.id } });
    if (!existing) {
      await prisma.staff.create({
        data: {
          userId: user.id,
          employeeId: `EMP-${user.role}`,
          firstName: user.role === 'PRINCIPAL' ? 'Sanjay' : 'System',
          lastName: user.role === 'PRINCIPAL' ? 'Mehta' : 'Admin',
          dateOfBirth: new Date(1980, 0, 1),
          gender: 'MALE',
          designation: user.role === 'PRINCIPAL' ? 'Principal' : 'System Administrator',
          department: 'Administration',
          qualification: 'Ph.D.',
          experience: 15,
          joinDate: new Date(2015, 0, 1),
          salary: 150000,
          address: 'School Campus',
          phone: '+91 99999 88888',
          branchId: user.branchId,
        }
      });
      console.log(`Created staff profile for ${user.role}`);
    } else {
      console.log(`Staff profile for ${user.role} already exists.`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
