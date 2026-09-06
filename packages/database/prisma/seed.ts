// ──────────────────────────────────────────────
// School ERP — Database Seed Script
// Creates a complete demo school with sample data
// ──────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' })

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ── 1. School ──
  const school = await prisma.school.upsert({
    where: { code: 'DEMO-SCHOOL' },
    update: {},
    create: {
      name: 'Delhi Public School',
      code: 'DEMO-SCHOOL',
      address: '123, Education Lane, Sector 12',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
      phone: '+91 11 2345 6789',
      email: 'info@dps-demo.edu.in',
      website: 'https://dps-demo.edu.in',
    },
  });
  console.log(`✅ School: ${school.name} (${school.id})`);

  // ── 2. Branch ──
  const branch = await prisma.branch.upsert({
    where: { schoolId_code: { schoolId: school.id, code: 'MAIN' } },
    update: {},
    create: {
      schoolId: school.id,
      name: 'Main Campus',
      code: 'MAIN',
      address: '123, Education Lane, Sector 12',
      phone: '+91 11 2345 6789',
      email: 'main@dps-demo.edu.in',
    },
  });
  console.log(`✅ Branch: ${branch.name} (${branch.id})`);

  // ── 3. Users ──
  const password = await bcrypt.hash('Admin@123', 12);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@dps-demo.edu.in' },
    update: {},
    create: {
      email: 'admin@dps-demo.edu.in',
      passwordHash: password,
      role: 'SUPER_ADMIN',
      branchId: branch.id,
      schoolId: school.id,
    },
  });
  console.log(`✅ Admin user: ${adminUser.email}`);

  const principalUser = await prisma.user.upsert({
    where: { email: 'principal@dps-demo.edu.in' },
    update: {},
    create: {
      email: 'principal@dps-demo.edu.in',
      passwordHash: password,
      role: 'PRINCIPAL',
      branchId: branch.id,
      schoolId: school.id,
    },
  });

  const teacherUsers = [];
  const teacherNames = [
    { first: 'Priya', last: 'Sharma', email: 'priya.sharma@dps-demo.edu.in' },
    { first: 'Rajesh', last: 'Kumar', email: 'rajesh.kumar@dps-demo.edu.in' },
    { first: 'Anita', last: 'Verma', email: 'anita.verma@dps-demo.edu.in' },
    { first: 'Suresh', last: 'Patel', email: 'suresh.patel@dps-demo.edu.in' },
    { first: 'Meena', last: 'Gupta', email: 'meena.gupta@dps-demo.edu.in' },
  ];

  for (const t of teacherNames) {
    const user = await prisma.user.upsert({
      where: { email: t.email },
      update: {},
      create: {
        email: t.email,
        passwordHash: password,
        role: 'TEACHER',
        branchId: branch.id,
        schoolId: school.id,
      },
    });
    teacherUsers.push({ ...t, userId: user.id });
  }
  console.log(`✅ Created ${teacherUsers.length} teacher users`);

  // ── 4. Staff (Teachers) ──
  const staffMembers = [];
  for (let i = 0; i < teacherUsers.length; i++) {
    const t = teacherUsers[i];
    const staff = await prisma.staff.upsert({
      where: { employeeId: `EMP-${String(i + 1).padStart(3, '0')}` },
      update: {},
      create: {
        userId: t.userId,
        employeeId: `EMP-${String(i + 1).padStart(3, '0')}`,
        firstName: t.first,
        lastName: t.last,
        dateOfBirth: new Date(1985 + i, i, 10 + i),
        gender: i % 2 === 0 ? 'FEMALE' : 'MALE',
        designation: 'Senior Teacher',
        department: ['Mathematics', 'Science', 'English', 'Hindi', 'Social Science'][i],
        qualification: 'M.Ed',
        experience: 8 + i,
        joinDate: new Date(2020, 0, 15),
        salary: 45000 + i * 5000,
        address: `${100 + i}, Teacher Colony, New Delhi`,
        phone: `+91 98765 ${String(43210 + i).padStart(5, '0')}`,
        branchId: branch.id,
      },
    });
    staffMembers.push(staff);
  }
  console.log(`✅ Created ${staffMembers.length} staff members`);

  // ── 5. Academic Year ──
  const academicYear = await prisma.academicYear.create({
    data: {
      name: '2025-2026',
      startDate: new Date(2025, 3, 1),  // April 2025
      endDate: new Date(2026, 2, 31),   // March 2026
      isCurrent: true,
      branchId: branch.id,
    },
  });
  console.log(`✅ Academic Year: ${academicYear.name}`);

  // ── 6. Classes & Sections ──
  const classNames = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  const classes = [];

  for (let i = 0; i < classNames.length; i++) {
    const cls = await prisma.class.create({
      data: {
        name: `Class ${classNames[i]}`,
        numericOrder: i + 1,
        branchId: branch.id,
        academicYearId: academicYear.id,
      },
    });
    classes.push(cls);

    // Create sections A, B for each class
    for (const sectionName of ['A', 'B']) {
      await prisma.section.create({
        data: {
          name: sectionName,
          classId: cls.id,
          capacity: 40,
        },
      });
    }
  }
  console.log(`✅ Created ${classes.length} classes with 2 sections each`);

  // ── 7. Subjects for each class ──
  const subjectList = [
    { name: 'Mathematics', code: 'MATH', type: 'THEORY' },
    { name: 'Science', code: 'SCI', type: 'THEORY' },
    { name: 'English', code: 'ENG', type: 'THEORY' },
    { name: 'Hindi', code: 'HIN', type: 'THEORY' },
    { name: 'Social Science', code: 'SST', type: 'THEORY' },
  ];

  for (const cls of classes) {
    for (const sub of subjectList) {
      await prisma.subject.create({
        data: {
          name: sub.name,
          code: sub.code,
          classId: cls.id,
          type: sub.type,
        },
      });
    }
  }
  console.log(`✅ Created ${subjectList.length} subjects for each class`);

  // ── 8. Parents & Students (for Class 10A) ──
  const class10 = classes[9]; // Class 10
  const sections = await prisma.section.findMany({ where: { classId: class10.id } });
  const sectionA = sections.find(s => s.name === 'A')!;

  const studentData = [
    { first: 'Aarav', last: 'Singh', gender: 'MALE', father: 'Vikram Singh', mother: 'Sunita Singh' },
    { first: 'Diya', last: 'Patel', gender: 'FEMALE', father: 'Amit Patel', mother: 'Priti Patel' },
    { first: 'Arjun', last: 'Sharma', gender: 'MALE', father: 'Deepak Sharma', mother: 'Kavita Sharma' },
    { first: 'Ananya', last: 'Gupta', gender: 'FEMALE', father: 'Rajeev Gupta', mother: 'Neha Gupta' },
    { first: 'Vihaan', last: 'Kumar', gender: 'MALE', father: 'Sandeep Kumar', mother: 'Rani Kumar' },
    { first: 'Ishita', last: 'Verma', gender: 'FEMALE', father: 'Manoj Verma', mother: 'Seema Verma' },
    { first: 'Rohan', last: 'Joshi', gender: 'MALE', father: 'Anil Joshi', mother: 'Lata Joshi' },
    { first: 'Saanvi', last: 'Reddy', gender: 'FEMALE', father: 'Ravi Reddy', mother: 'Lakshmi Reddy' },
    { first: 'Kabir', last: 'Mishra', gender: 'MALE', father: 'Ramesh Mishra', mother: 'Sita Mishra' },
    { first: 'Myra', last: 'Chauhan', gender: 'FEMALE', father: 'Sunil Chauhan', mother: 'Rekha Chauhan' },
  ];

  let studentCount = 0;
  for (let i = 0; i < studentData.length; i++) {
    const s = studentData[i];

    // Create parent
    const parent = await prisma.parent.create({
      data: {
        fatherName: s.father,
        fatherPhone: `+91 98765 ${String(10000 + i).padStart(5, '0')}`,
        fatherEmail: `${s.father.toLowerCase().replace(' ', '.')}@gmail.com`,
        fatherOccupation: 'Business',
        motherName: s.mother,
        motherPhone: `+91 98765 ${String(20000 + i).padStart(5, '0')}`,
        address: `${200 + i}, Model Town, New Delhi`,
      },
    });

    // Create student user
    const studentUser = await prisma.user.create({
      data: {
        email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@student.dps-demo.edu.in`,
        passwordHash: password,
        role: 'STUDENT',
        branchId: branch.id,
        schoolId: school.id,
      },
    });

    // Create student
    const admNo = `DPS-2025-${String(i + 1).padStart(4, '0')}`;
    await prisma.student.create({
      data: {
        userId: studentUser.id,
        admissionNo: admNo,
        rollNo: String(i + 1),
        firstName: s.first,
        lastName: s.last,
        dateOfBirth: new Date(2010, i, 5 + i),
        gender: s.gender as any,
        bloodGroup: ['A+', 'B+', 'O+', 'AB+', 'A-'][i % 5],
        classId: class10.id,
        sectionId: sectionA.id,
        parentId: parent.id,
        address: `${200 + i}, Model Town, New Delhi`,
        phone: `+91 70000 ${String(10000 + i).padStart(5, '0')}`,
        admissionDate: new Date(2023, 3, 1),
        branchId: branch.id,
      },
    });
    studentCount++;
  }
  console.log(`✅ Created ${studentCount} students with parents (Class 10-A)`);

  // ── 9. Fee Structure ──
  const feeStructure = await prisma.feeStructure.create({
    data: {
      name: 'Monthly Tuition Fee',
      branchId: branch.id,
      classIds: classes.map(c => c.id),
      amount: 5000,
      frequency: 'MONTHLY',
      dueDay: 10,
    },
  });

  await prisma.feeStructure.create({
    data: {
      name: 'Annual Development Fee',
      branchId: branch.id,
      classIds: classes.map(c => c.id),
      amount: 15000,
      frequency: 'YEARLY',
      dueDay: 15,
    },
  });
  console.log(`✅ Created fee structures`);

  // ── 10. Sample Examination ──
  const exam = await prisma.examination.create({
    data: {
      name: 'First Term Exam 2025',
      academicYearId: academicYear.id,
      branchId: branch.id,
      startDate: new Date(2025, 8, 15),  // Sept 15
      endDate: new Date(2025, 8, 25),    // Sept 25
    },
  });

  const subjects10 = await prisma.subject.findMany({ where: { classId: class10.id } });
  for (let i = 0; i < subjects10.length; i++) {
    await prisma.examSubject.create({
      data: {
        examinationId: exam.id,
        subjectId: subjects10[i].id,
        examDate: new Date(2025, 8, 15 + i),
        startTime: '09:00',
        endTime: '12:00',
        maxMarks: 100,
        passingMarks: 33,
      },
    });
  }
  console.log(`✅ Created examination: ${exam.name}`);

  // ── 11. Sample Announcements ──
  await prisma.announcement.create({
    data: {
      title: 'Welcome to New Academic Session 2025-26',
      content: 'We are pleased to welcome all students and staff to the new academic session. Classes will commence from April 1, 2025.',
      type: 'GENERAL',
      targetRoles: [],
      branchId: branch.id,
      createdBy: adminUser.id,
    },
  });

  await prisma.announcement.create({
    data: {
      title: 'Parent-Teacher Meeting - March 15',
      content: 'A PTM is scheduled for March 15, 2026 from 10:00 AM to 1:00 PM. All parents are requested to attend.',
      type: 'EVENT',
      targetRoles: ['PARENT', 'TEACHER'],
      branchId: branch.id,
      createdBy: adminUser.id,
    },
  });
  console.log(`✅ Created sample announcements`);

  // ── 11b. Finance User ──
  const financeUser = await prisma.user.upsert({
    where: { email: 'neha.kapoor@dps-demo.edu.in' },
    update: {},
    create: {
      email: 'neha.kapoor@dps-demo.edu.in',
      passwordHash: password,
      role: 'FINANCE',
      branchId: branch.id,
      schoolId: school.id,
    },
  });
  await prisma.staff.upsert({
    where: { employeeId: 'EMP-FIN-001' },
    update: {},
    create: {
      userId: financeUser.id,
      employeeId: 'EMP-FIN-001',
      firstName: 'Neha',
      lastName: 'Kapoor',
      dateOfBirth: new Date(1990, 5, 15),
      gender: 'FEMALE',
      designation: 'Accounts Head',
      department: 'Finance',
      qualification: 'M.Com, CA',
      experience: 6,
      joinDate: new Date(2021, 7, 15),
      salary: 65000,
      address: '45, Finance Colony, New Delhi',
      phone: '+91 98765 43215',
      branchId: branch.id,
    },
  });
  console.log(`✅ Created Finance user: ${financeUser.email}`);

  // ── 11c. Parent User ──
  const parentUser = await prisma.user.upsert({
    where: { email: 'vikram.singh@parent.dps-demo.edu.in' },
    update: {},
    create: {
      email: 'vikram.singh@parent.dps-demo.edu.in',
      passwordHash: password,
      role: 'PARENT',
      branchId: branch.id,
      schoolId: school.id,
    },
  });
  console.log(`✅ Created Parent user: ${parentUser.email}`);

  const vikramParent = await prisma.parent.findFirst({
    where: { fatherName: 'Vikram Singh' },
  });
  if (vikramParent) {
    await prisma.parent.update({
      where: { id: vikramParent.id },
      data: { userId: parentUser.id },
    });
    console.log(`✅ Linked parent login to Vikram Singh (Aarav Singh)`);
  }

  // ── 12. Library Books ──
  const books = [
    { title: 'Mathematics for Class X', author: 'R.D. Sharma', isbn: '978-9350943182', category: 'Textbook' },
    { title: 'Science for Class X', author: 'Lakhmir Singh', isbn: '978-9352533084', category: 'Textbook' },
    { title: 'Wings of Fire', author: 'A.P.J. Abdul Kalam', isbn: '978-8173711466', category: 'Biography' },
    { title: 'Harry Potter and the Philosopher\'s Stone', author: 'J.K. Rowling', isbn: '978-1408855652', category: 'Fiction' },
    { title: 'The Story of My Experiments with Truth', author: 'Mahatma Gandhi', isbn: '978-8172345365', category: 'Autobiography' },
  ];

  for (const book of books) {
    await prisma.book.create({
      data: {
        ...book,
        publisher: 'Academic Press',
        totalCopies: 10,
        availableCopies: 10,
        shelfLocation: `Shelf-${book.category.charAt(0)}`,
        branchId: branch.id,
      },
    });
  }
  console.log(`✅ Created ${books.length} library books`);

  // ── 13. Transport ──
  const vehicle = await prisma.vehicle.create({
    data: {
      vehicleNo: 'DL-01-AB-1234',
      type: 'Bus',
      capacity: 40,
      driverName: 'Rampal Singh',
      driverPhone: '+91 98765 00001',
      driverLicense: 'DL-0420110012345',
      insuranceExpiry: new Date(2027, 5, 30),
      branchId: branch.id,
    },
  });

  const route = await prisma.transportRoute.create({
    data: {
      name: 'Route A - Connaught Place to School',
      vehicleId: vehicle.id,
      branchId: branch.id,
      fare: 2500,
    },
  });

  const stops = [
    { name: 'Connaught Place', pickupTime: '07:00', dropTime: '15:30', order: 1 },
    { name: 'Karol Bagh', pickupTime: '07:15', dropTime: '15:15', order: 2 },
    { name: 'Rajouri Garden', pickupTime: '07:30', dropTime: '15:00', order: 3 },
    { name: 'School Gate', pickupTime: '07:50', dropTime: '14:45', order: 4 },
  ];

  for (const stop of stops) {
    await prisma.routeStop.create({
      data: { routeId: route.id, ...stop },
    });
  }
  console.log(`✅ Created transport route with ${stops.length} stops`);

  // ── 14. Permissions ──
  const modules = ['students', 'staff', 'academics', 'attendance', 'fees', 'communication', 'library', 'transport', 'reports'];
  const actions = ['create', 'read', 'update', 'delete'];

  for (const module of modules) {
    for (const action of actions) {
      await prisma.permission.upsert({
        where: { module_action: { module, action } },
        update: {},
        create: { module, action, description: `${action} ${module}` },
      });
    }
  }
  console.log(`✅ Created ${modules.length * actions.length} permissions`);

  console.log('\n🎉 Seed complete! You can log in with:');
  console.log('   Email: admin@dps-demo.edu.in');
  console.log('   Password: Admin@123');
  console.log('   (Same password for all users)');
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
