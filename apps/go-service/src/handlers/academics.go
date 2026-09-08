package handlers

import (
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"schoolerp-go-service/src/database"
)

type ExamResult struct {
	StudentID     string  `json:"studentId" gorm:"column:studentId"`
	ExamSubjectID string  `json:"examSubjectId" gorm:"column:examSubjectId"`
	Marks         float64 `json:"marks" gorm:"column:marks"`
	Remarks       string  `json:"remarks" gorm:"column:remarks"`
	BranchId      string  `json:"branchId" gorm:"column:branchId"`
}

func (ExamResult) TableName() string {
	return "ExamResult"
}

type BulkResultRequest struct {
	ExamSubjectID string       `json:"examSubjectId"`
	Results       []ExamResult `json:"results"`
}

func SubmitBulkResults(c *fiber.Ctx) error {
	var req BulkResultRequest

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "Invalid JSON format"})
	}

	if req.ExamSubjectID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "ExamSubjectID is required"})
	}

	branchId := ""

	var batch []ExamResult
	for _, res := range req.Results {
		batch = append(batch, ExamResult{
			StudentID:     res.StudentID,
			ExamSubjectID: req.ExamSubjectID,
			Marks:         res.Marks,
			Remarks:       res.Remarks,
			BranchId:      branchId,
		})
	}

	log.Printf("Processing bulk results for ExamSubject: %s, Count: %d", req.ExamSubjectID, len(batch))

	// Batch Insert
	result := database.DB.Create(&batch)
	if result.Error != nil {
		log.Println("Batch Result Insert Failed:", result.Error)
		return c.Status(500).JSON(fiber.Map{"detail": "Failed to record results batch: " + result.Error.Error()})
	}

	// Async: Update student ranking or progress (simulated)
	go updateStudentRankings(req.ExamSubjectID)

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"message": "Results submitted successfully",
		"count":   len(batch),
	})
}

func updateStudentRankings(examSubjectId string) {
	log.Printf("[Goroutine] Re-calculating rankings for ExamSubject: %s...", examSubjectId)
	time.Sleep(5 * time.Second)
	log.Printf("[Goroutine] Success: Rankings updated for ExamSubject: %s", examSubjectId)
}
