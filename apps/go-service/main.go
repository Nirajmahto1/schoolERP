package main

import (
	"log"
	"os"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"schoolerp-go-service/src/database"
	"schoolerp-go-service/src/handlers"
)

func main() {
	// Initialize database connection
	database.ConnectDB()

	app := fiber.New(fiber.Config{
		AppName: "School ERP - Go Microservice",
	})

	// NOTE: CORS was removed in Phase 0. This is an internal service reachable
	// only through the API gateway, which owns the browser-facing CORS policy.
	// The previous `AllowOrigins: "*"` let any website call it directly.

	// Add Logger Middleware
	app.Use(logger.New(logger.Config{
		Format: "[${time}] ${status} - ${latency} ${method} ${path}\n",
	}))

	// Health check
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "service": "go-service"})
	})

	// API Routes
	api := app.Group("/api/v1")
	
	// Attendance Routes
	attendance := api.Group("/attendance")
	attendance.Post("/burst-mark", handlers.BurstMarkAttendance)
	
	// Notification Routes
	notifications := api.Group("/notifications")
	notifications.Post("/send", handlers.SendBulkNotification)

	// Academics Routes
	academics := api.Group("/academics")
	academics.Post("/bulk-results", handlers.SubmitBulkResults)

	port := os.Getenv("PORT")
	if port == "" {
		port = "5003"
	}

	log.Printf("Starting Go Microservice on port %s", port)
	log.Fatal(app.Listen(":" + port))
}
