package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"schoolerp-go-service/src/database"
)

type AttendanceRecord struct {
	StudentID string `json:"studentId"`
	Status    string `json:"status"` // PRESENT, ABSENT, LATE, HALF_DAY
	Remarks   string `json:"remarks,omitempty"`
}

type MarkAttendanceRequest struct {
	Date     string             `json:"date"`
	Records  []AttendanceRecord `json:"records"`
	MarkedBy string             `json:"markedBy"`
}

// Model for Go Gorm mapping - matches Prisma schema
type Attendance struct {
	ID        string    `gorm:"primaryKey;column:id"`
	StudentID *string   `gorm:"column:studentId"`
	StaffID   *string   `gorm:"column:staffId"`
	Date      time.Time `gorm:"column:date;type:date"`
	Status    string    `gorm:"column:status"`
	Remarks   *string   `gorm:"column:remarks"`
	MarkedBy  string    `gorm:"column:markedBy"`
	BranchId  string    `gorm:"column:branchId"`
	CreatedAt time.Time `gorm:"column:createdAt;autoCreateTime"`
}

func (Attendance) TableName() string {
	return "attendances"
}

func generateCUID() string {
	return "cl" + uuid.New().String()[:23]
}

func BurstMarkAttendance(c *fiber.Ctx) error {
	var req MarkAttendanceRequest

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "Invalid JSON format"})
	}

	date, err := time.Parse("2006-01-02", req.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "Invalid date format. Use YYYY-MM-DD"})
	}

	if len(req.Records) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "No attendance records provided"})
	}

	// Get branchId from header or use default
	branchId := c.Get("X-Branch-ID", "branch-1")

	log.Printf("Processing burst-mark attendance: Branch: %s, Records: %d, MarkedBy: %s", branchId, len(req.Records), req.MarkedBy)

	// Delete existing records for this date + these students, then re-insert (upsert pattern)
	studentIDs := make([]string, len(req.Records))
	for i, rec := range req.Records {
		studentIDs[i] = rec.StudentID
	}
	database.DB.Where(`"date" = ? AND "studentId" IN ?`, date, studentIDs).Delete(&Attendance{})

	var batch []Attendance
	for _, rec := range req.Records {
		remarks := rec.Remarks
		var remarksPtr *string
		if remarks != "" {
			remarksPtr = &remarks
		}
		batch = append(batch, Attendance{
			ID:        generateCUID(),
			StudentID: &rec.StudentID,
			StaffID:   nil,
			Date:      date,
			Status:    rec.Status,
			Remarks:   remarksPtr,
			MarkedBy:  req.MarkedBy,
			BranchId:  branchId,
		})
	}

	// Batch Insert into PostgreSQL to handle 8 AM burst
	result := database.DB.Create(&batch)
	if result.Error != nil {
		log.Println("Batch Insert Failed:", result.Error)
		return c.Status(500).JSON(fiber.Map{"detail": "Failed to record attendance batch: " + result.Error.Error()})
	}

	// Async: Fire-and-forget goroutine for parent notifications via Notification Engine
	go sendParentAttendanceNotifications(batch, req.Date)

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"message": "Attendance marked successfully via Go high-throughput service",
		"count":   len(batch),
	})
}

// Background notification processor — calls Notification Engine (Go, port 6001)
func sendParentAttendanceNotifications(records []Attendance, dateStr string) {
	absentCount := 0
	lateCount := 0

	for _, r := range records {
		if r.Status == "ABSENT" {
			absentCount++
		} else if r.Status == "LATE" {
			lateCount++
		}
	}

	total := absentCount + lateCount
	if total == 0 {
		log.Println("[Goroutine] All students present — no parent notifications needed.")
		return
	}

	log.Printf("[Goroutine] Sending parent notifications: %d Absent, %d Late for date %s", absentCount, lateCount, dateStr)

	// Call the Notification Engine REST API
	notifPort := os.Getenv("PORT_NOTIFICATION_ENGINE")
	if notifPort == "" {
		notifPort = "6001"
	}
	notifURL := fmt.Sprintf("http://localhost:%s/notifications/send", notifPort)

	payload := map[string]interface{}{
		"title":     fmt.Sprintf("Attendance Alert — %s", dateStr),
		"body":      fmt.Sprintf("%d student(s) marked Absent and %d marked Late. Please contact the school if needed.", absentCount, lateCount),
		"type":      "ALERT",
		"branch_id": records[0].BranchId,
	}

	jsonBody, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[Goroutine] Failed to marshal notification payload: %v", err)
		return
	}

	resp, err := http.Post(notifURL, "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		log.Printf("[Goroutine] Failed to reach Notification Engine at %s: %v (notifications skipped)", notifURL, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 200 {
		log.Printf("[Goroutine] ✅ Notification Engine dispatched alerts: %d Absent + %d Late SMS/WebSocket alerts sent to parents.", absentCount, lateCount)
	} else {
		log.Printf("[Goroutine] ⚠️ Notification Engine returned status %d", resp.StatusCode)
	}
}

