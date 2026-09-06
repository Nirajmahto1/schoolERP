# ──────────────────────────────────────────────
# School ERP — Analytics Service (FastAPI)
# ──────────────────────────────────────────────

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import date, datetime, timedelta
from typing import Optional, List
import os

app = FastAPI(
    title="School ERP Analytics Service",
    description="Reports, dashboards, and analytics endpoints",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WEEKDAYS = [0, 1, 2, 3, 4]  # Monday-Friday


# ── Models ──

class DashboardStats(BaseModel):
    total_students: int
    total_staff: int
    total_revenue: float
    pending_fees: float
    attendance_rate: float
    new_admissions_this_month: int


class AttendanceReport(BaseModel):
    date: date
    total_present: int
    total_absent: int
    total_late: int
    total_on_leave: int
    attendance_rate: float


class FeeReport(BaseModel):
    month: str
    total_expected: float
    total_collected: float
    total_pending: float
    collection_rate: float


class StudentPerformance(BaseModel):
    student_id: str
    student_name: str
    average_marks: float
    attendance_rate: float
    fee_status: str
    risk_level: str  # LOW, MEDIUM, HIGH


class StudentPerformanceInput(BaseModel):
    student_id: str
    student_name: str
    class_id: str
    average_marks: float
    attendance_rate: float
    fee_status: str


SAMPLE_STUDENTS = [
    StudentPerformanceInput(
        student_id="stu_001",
        student_name="Rahul Kumar",
        class_id="class_8A",
        average_marks=78.5,
        attendance_rate=88.0,
        fee_status="PAID",
    ),
    StudentPerformanceInput(
        student_id="stu_002",
        student_name="Ananya Singh",
        class_id="class_8A",
        average_marks=56.0,
        attendance_rate=72.5,
        fee_status="PENDING",
    ),
    StudentPerformanceInput(
        student_id="stu_003",
        student_name="Aarav Patel",
        class_id="class_9B",
        average_marks=68.0,
        attendance_rate=80.0,
        fee_status="PARTIAL",
    ),
    StudentPerformanceInput(
        student_id="stu_004",
        student_name="Neha Verma",
        class_id="class_9B",
        average_marks=90.0,
        attendance_rate=95.0,
        fee_status="PAID",
    ),
]


# ── Auth dependency ──

async def get_current_user(
    x_user_id: str = Header(...),
    x_user_role: str = Header(...),
    x_branch_id: str = Header(...),
):
    return {"user_id": x_user_id, "role": x_user_role, "branch_id": x_branch_id}


# ── Routes ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "analytics-service", "timestamp": datetime.now().isoformat()}


@app.get("/analytics/dashboard", response_model=DashboardStats)
async def get_dashboard_stats(user=Depends(get_current_user)):
    """
    Get top-level dashboard statistics for the branch.
    """
    total_students = 1250
    total_staff = 85
    total_revenue = 5_250_000.00
    pending_fees = 830_000.00
    attendance_rate = 92.5
    new_admissions_this_month = 34

    return DashboardStats(
        total_students=total_students,
        total_staff=total_staff,
        total_revenue=total_revenue,
        pending_fees=pending_fees,
        attendance_rate=attendance_rate,
        new_admissions_this_month=new_admissions_this_month,
    )


@app.get("/analytics/attendance", response_model=List[AttendanceReport])
async def get_attendance_report(
    start_date: date,
    end_date: date,
    class_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    """
    Get daily attendance reports for a date range.
    """
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    days = (end_date - start_date).days + 1
    if days > 60:
        raise HTTPException(status_code=400, detail="Date range cannot exceed 60 days")

    reports: List[AttendanceReport] = []
    for i in range(days):
        current_date = start_date + timedelta(days=i)
        if current_date.weekday() not in WEEKDAYS:
            continue

        baseline_strength = 1250 if not class_id else 120
        absences = 20 + ((current_date.toordinal() * 3) % 18)
        lates = 6 + ((current_date.toordinal() * 5) % 12)
        leaves = 4 + ((current_date.toordinal() * 2) % 7)
        present = max(0, baseline_strength - (absences + lates + leaves))
        attendance_rate = round((present / baseline_strength) * 100, 2)

        reports.append(
            AttendanceReport(
                date=current_date,
                total_present=present,
                total_absent=absences,
                total_late=lates,
                total_on_leave=leaves,
                attendance_rate=attendance_rate,
            )
        )
    return reports


@app.get("/analytics/fees", response_model=List[FeeReport])
async def get_fee_report(
    academic_year_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    """
    Get monthly fee collection reports.
    """
    base_expected = 500_000.0
    reports: List[FeeReport] = []
    today = date.today()

    for idx in range(5, -1, -1):
        month_anchor = date(today.year, today.month, 1) - timedelta(days=idx * 30)
        month_key = f"{month_anchor.year:04d}-{month_anchor.month:02d}"
        expected = base_expected + (idx * 12_000)
        collection_rate = 79 + ((month_anchor.month * 3) % 14)
        collected = round((expected * collection_rate) / 100, 2)
        pending = round(expected - collected, 2)
        reports.append(
            FeeReport(
                month=month_key,
                total_expected=round(expected, 2),
                total_collected=collected,
                total_pending=pending,
                collection_rate=float(collection_rate),
            )
        )
    return reports


@app.get("/analytics/performance", response_model=List[StudentPerformance])
async def get_student_performance(
    class_id: Optional[str] = None,
    risk_level: Optional[str] = None,
    user=Depends(get_current_user),
):
    """
    Get student performance with risk levels.
    """
    normalized_risk = risk_level.upper() if risk_level else None
    if normalized_risk and normalized_risk not in {"LOW", "MEDIUM", "HIGH"}:
        raise HTTPException(status_code=400, detail="risk_level must be LOW, MEDIUM, or HIGH")

    performance_rows: List[StudentPerformance] = []
    for student in SAMPLE_STUDENTS:
        if class_id and student.class_id != class_id:
            continue

        score = 0
        if student.average_marks < 60:
            score += 2
        elif student.average_marks < 75:
            score += 1

        if student.attendance_rate < 75:
            score += 2
        elif student.attendance_rate < 85:
            score += 1

        if student.fee_status != "PAID":
            score += 1

        derived_risk = "HIGH" if score >= 4 else "MEDIUM" if score >= 2 else "LOW"
        if normalized_risk and normalized_risk != derived_risk:
            continue

        performance_rows.append(
            StudentPerformance(
                student_id=student.student_id,
                student_name=student.student_name,
                average_marks=student.average_marks,
                attendance_rate=student.attendance_rate,
                fee_status=student.fee_status,
                risk_level=derived_risk,
            )
        )

    return performance_rows


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT_ANALYTICS_SERVICE", "5001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
