import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const students = await prisma.student.findMany({
    include: {
      class: true,
      section: true,
    }
  });

  console.log(`Total students: ${students.length}`);

  const counts: Record<string, number> = {};
  for (const s of students) {
    const key = `${s.class.name}-${s.section.name}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log("Students per class/section:", counts);
}

main().finally(() => prisma.$disconnect());
