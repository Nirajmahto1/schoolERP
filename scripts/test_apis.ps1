# API Verification Script for School ERP

$baseUrl = "http://localhost:4000/api/v1"
$token = "your-test-token" # In a real test, you'd login first

function Test-Endpoint {
    param($method, $path, $body)
    
    $url = "$baseUrl$path"
    $headers = @{
        "Content-Type" = "application/json"
        # "Authorization" = "Bearer $token"
        "X-Branch-ID" = "branch-1"
    }
    
    Write-Host "Testing $method $url..." -ForegroundColor Cyan
    try {
        if ($method -eq "POST") {
            $resp = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 10)
        } else {
            $resp = Invoke-RestMethod -Uri $url -Method Get -Headers $headers
        }
        Write-Host "Success: " -NoNewline -ForegroundColor Green
        $resp | ConvertTo-Json | Write-Host
    } catch {
        Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails) {
            Write-Host "Details: $($_.ErrorDetails.Message)" -ForegroundColor Yellow
        }
    }
    Write-Host ("-" * 50)
}

# 1. Health Check
Test-Endpoint "GET" "/health"

# 2. Go Service Health (via Gateway)
Test-Endpoint "GET" "/go/health"

# 3. Attendance Burst Mark (Go Service)
$attendanceBody = @{
    date = "2026-03-16"
    markedBy = "teacher-1"
    records = @(
        @{ studentId = "std-001"; status = "PRESENT" }
        @{ studentId = "std-002"; status = "ABSENT"; remarks = "Unwell" }
    )
}
Test-Endpoint "POST" "/go/attendance/burst-mark" $attendanceBody

# 4. Bulk Academics (Go Service)
$academicsBody = @{
    examSubjectId = "exam-sub-123"
    results = @(
        @{ studentId = "std-001"; marks = 85; remarks = "Good" }
        @{ studentId = "std-002"; marks = 92 }
    )
}
Test-Endpoint "POST" "/go/academics/bulk-results" $academicsBody

# 5. Send Bulk Notification (Go Service)
$notificationBody = @{
    title = "Test Notification"
    content = "This is a test notification from the Go service."
    type = "ANNOUNCEMENT"
    targetRoles = @("STUDENT", "PARENT")
    authorId = "admin-1"
}
Test-Endpoint "POST" "/go/notifications/send" $notificationBody
