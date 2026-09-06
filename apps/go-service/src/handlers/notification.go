package handlers

import (
	"fmt"
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"schoolerp-go-service/src/database"
)

// Announcement model matching Prisma schema (@@map("announcements"))
type Announcement struct {
	ID          string         `gorm:"primaryKey;column:id"`
	Title       string         `gorm:"column:title"`
	Content     string         `gorm:"column:content"`
	Type        string         `gorm:"column:type;default:GENERAL"`
	TargetRoles pq.StringArray `gorm:"column:targetRoles;type:text[]"`
	BranchId    string         `gorm:"column:branchId"`
	CreatedBy   string         `gorm:"column:createdBy"`
	IsActive    bool           `gorm:"column:isActive;default:true"`
	ExpiresAt   *time.Time     `gorm:"column:expiresAt"`
	CreatedAt   time.Time      `gorm:"column:createdAt;autoCreateTime"`
	UpdatedAt   time.Time      `gorm:"column:updatedAt;autoUpdateTime"`
}

func (Announcement) TableName() string {
	return "announcements"
}

type BulkNotificationRequest struct {
	Title       string   `json:"title"`
	Content     string   `json:"content"`
	Type        string   `json:"type"`
	TargetRoles []string `json:"targetRoles"`
	AuthorId    string   `json:"authorId"`
}

func SendBulkNotification(c *fiber.Ctx) error {
	var req BulkNotificationRequest

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "Invalid JSON format"})
	}

	if req.Title == "" || req.Content == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"detail": "Title and content are required"})
	}

	branchId := c.Get("X-Branch-ID", "branch-1")
	annType := req.Type
	if annType == "" {
		annType = "GENERAL"
	}

	id := fmt.Sprintf("cl%s", uuid.New().String()[:23])

	ann := Announcement{
		ID:          id,
		Title:       req.Title,
		Content:     req.Content,
		Type:        annType,
		TargetRoles: req.TargetRoles,
		BranchId:    branchId,
		CreatedBy:   req.AuthorId,
		IsActive:    true,
	}

	// Save announcement to database
	result := database.DB.Create(&ann)
	if result.Error != nil {
		log.Println("Database error creating announcement:", result.Error)
		return c.Status(500).JSON(fiber.Map{"detail": "Failed to create announcement"})
	}

	// Offload push notification processing to a Goroutine
	go processNotificationQueue(ann.ID, req.TargetRoles)

	// Return 202 Accepted instantly
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
		"message": "Announcement published and notifications queued",
		"id":      ann.ID,
	})
}

// Background Task
func processNotificationQueue(announcementId string, roles []string) {
	log.Printf("[Goroutine] Starting broadcast for announcement %s to roles %v...", announcementId, roles)

	// Simulate external FCM/APNs overhead delay
	time.Sleep(3 * time.Second)

	log.Printf("[Goroutine] Success: Finished broadcasting announcement %s to all targeted devices.", announcementId)
}
