// ──────────────────────────────────────────────
// School ERP — Timetable Engine (Go)
// Constraint-based timetable generation
// ──────────────────────────────────────────────

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ── Models ──

type TimetableRequest struct {
	BranchID       string       `json:"branch_id" binding:"required"`
	AcademicYearID string       `json:"academic_year_id" binding:"required"`
	Constraints    []Constraint `json:"constraints"`
}

type Constraint struct {
	Type  string `json:"type"`  // NO_CONSECUTIVE, MAX_PER_DAY, TEACHER_UNAVAILABLE, ROOM_CAPACITY
	Value string `json:"value"` // JSON-encoded constraint parameters
}

type TimetableSlot struct {
	Day       string `json:"day"`
	StartTime string `json:"start_time"`
	EndTime   string `json:"end_time"`
	SubjectID string `json:"subject_id"`
	TeacherID string `json:"teacher_id"`
	SectionID string `json:"section_id"`
	Room      string `json:"room"`
}

type TimetableResponse struct {
	Status    string          `json:"status"`
	Message   string          `json:"message"`
	Slots     []TimetableSlot `json:"slots"`
	Conflicts []string        `json:"conflicts"`
}

type teacherUnavailableConstraint struct {
	TeacherID string   `json:"teacher_id"`
	Days      []string `json:"days"`
}

var weekdays = []string{"Monday", "Tuesday", "Wednesday", "Thursday", "Friday"}
var subjectRotation = []string{"MATH", "SCI", "ENG", "HIST", "GEO", "COMP"}
var teacherRotation = []string{"TCH-001", "TCH-002", "TCH-003", "TCH-004", "TCH-005", "TCH-006"}

func normalizeDay(day string) string {
	trimmed := strings.ToLower(strings.TrimSpace(day))
	switch trimmed {
	case "monday":
		return "Monday"
	case "tuesday":
		return "Tuesday"
	case "wednesday":
		return "Wednesday"
	case "thursday":
		return "Thursday"
	case "friday":
		return "Friday"
	default:
		return ""
	}
}

func parseMaxPerDay(constraints []Constraint) int {
	maxPerDay := 6
	for _, constraint := range constraints {
		if strings.ToUpper(strings.TrimSpace(constraint.Type)) != "MAX_PER_DAY" {
			continue
		}
		var parsed struct {
			Value int `json:"value"`
		}
		if err := json.Unmarshal([]byte(constraint.Value), &parsed); err == nil && parsed.Value > 0 && parsed.Value <= 8 {
			maxPerDay = parsed.Value
		}
	}
	return maxPerDay
}

func parseTeacherUnavailability(constraints []Constraint) map[string]map[string]bool {
	byTeacher := map[string]map[string]bool{}
	for _, constraint := range constraints {
		if strings.ToUpper(strings.TrimSpace(constraint.Type)) != "TEACHER_UNAVAILABLE" {
			continue
		}

		var parsed teacherUnavailableConstraint
		if err := json.Unmarshal([]byte(constraint.Value), &parsed); err != nil {
			continue
		}
		if parsed.TeacherID == "" || len(parsed.Days) == 0 {
			continue
		}

		if _, ok := byTeacher[parsed.TeacherID]; !ok {
			byTeacher[parsed.TeacherID] = map[string]bool{}
		}
		for _, day := range parsed.Days {
			dayName := normalizeDay(day)
			if dayName != "" {
				byTeacher[parsed.TeacherID][dayName] = true
			}
		}
	}
	return byTeacher
}

func slotTimes(period int) (string, string) {
	start := time.Date(2000, time.January, 1, 8, 0, 0, 0, time.UTC).Add(time.Duration(period) * 50 * time.Minute)
	end := start.Add(45 * time.Minute)
	return start.Format("15:04"), end.Format("15:04")
}

func generateTimetable(constraints []Constraint) ([]TimetableSlot, []string) {
	maxPerDay := parseMaxPerDay(constraints)
	unavailableByTeacher := parseTeacherUnavailability(constraints)
	conflicts := []string{}
	slots := make([]TimetableSlot, 0, len(weekdays)*maxPerDay)

	for dayIndex, day := range weekdays {
		for period := 0; period < maxPerDay; period++ {
			rotationIndex := (dayIndex*maxPerDay + period) % len(subjectRotation)
			teacherID := teacherRotation[rotationIndex]
			startTime, endTime := slotTimes(period)

			if unavailableByTeacher[teacherID][day] {
				conflicts = append(conflicts, "Teacher "+teacherID+" unavailable on "+day+" for slot "+startTime)
				continue
			}

			slots = append(slots, TimetableSlot{
				Day:       day,
				StartTime: startTime,
				EndTime:   endTime,
				SubjectID: subjectRotation[rotationIndex],
				TeacherID: teacherID,
				SectionID: "SEC-A",
				Room:      "R-" + string(rune('1'+(rotationIndex%5))),
			})
		}
	}

	return slots, conflicts
}

func main() {
	port := os.Getenv("PORT_TIMETABLE_ENGINE")
	if port == "" {
		port = "6003"
	}

	r := gin.Default()

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "ok",
			"service":   "timetable-engine",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	r.POST("/timetable/generate", func(c *gin.Context) {
		var req TimetableRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		slots, conflicts := generateTimetable(req.Constraints)

		c.JSON(http.StatusOK, TimetableResponse{
			Status:    "generated",
			Message:   "Timetable generated successfully",
			Slots:     slots,
			Conflicts: conflicts,
		})
	})

	log.Printf("📅 Timetable Engine running on http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
