# 🏫 School ERP — Comprehensive School Management System

A **production-grade School ERP** built with a polyglot microservice architecture.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 + TypeScript + shadcn/ui |
| API Gateway | Node.js + Express |
| Core Services | Node.js + Express + Prisma |
| Analytics & AI | FastAPI (Python) + Pandas + scikit-learn |
| Performance | Go (Gin) + goroutines |
| Database | PostgreSQL 16 + MongoDB + Redis |
| Storage | MinIO (S3-compatible) |
| Monorepo | Turborepo |

## Modules

**Core**: Student Mgmt · Staff & HR · Academics · Daily Attendance · Examinations · Timetable · Fee Mgmt · Communication · Library · Transport

**Advanced**: Hostel · Inventory · AI Analytics · Online Classes · Admission Portal · Parent Portal · Multi-Branch · Compliance · Document Mgmt · PWA

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start infrastructure (PostgreSQL, Redis, MongoDB, MinIO)
npm run docker:up

# 3. Copy environment file
cp .env.example .env

# 4. Run database migrations
npm run db:migrate

# 5. Start all services in dev mode
npm run dev
```

## Project Structure

```
schoolERP/
├── apps/
│   ├── web/                    # Next.js frontend
│   ├── api-gateway/            # Node.js API Gateway
│   ├── student-service/        # Node.js — Students, Parents, Auth
│   ├── staff-service/          # Node.js — Staff, HR, Payroll
│   ├── academic-service/       # Node.js — Classes, Subjects, Exams
│   ├── fee-service/            # Node.js — Fees, Invoices, Payments
│   ├── attendance-service/     # Node.js — Daily Attendance
│   ├── communication-service/  # Node.js — Announcements
│   ├── analytics-service/      # FastAPI — Reports & Dashboards
│   ├── ai-service/             # FastAPI — Predictions & OCR
│   ├── notification-engine/    # Go — WebSocket Notifications
│   └── timetable-engine/       # Go — Constraint-based Timetable
├── packages/
│   ├── shared-types/           # TypeScript interfaces
│   └── database/               # Prisma schema & migrations
└── docker/                     # Docker Compose files
```

## API Gateway Routes

All requests go through `http://localhost:4000/api/v1/`:

| Route | Service | Port |
|---|---|---|
| `/auth` | Student Service | 4001 |
| `/students` | Student Service | 4001 |
| `/staff` | Staff Service | 4002 |
| `/academics` | Academic Service | 4003 |
| `/fees` | Fee Service | 4004 |
| `/communication` | Communication Service | 4005 |
| `/attendance` | Attendance Service | 4006 |
| `/analytics` | Analytics Service | 5001 |
| `/ai` | AI Service | 5002 |
| `/notifications` | Notification Engine | 6001 |
| `/timetable` | Timetable Engine | 6003 |

## License

ISC
