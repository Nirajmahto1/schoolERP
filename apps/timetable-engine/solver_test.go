// ──────────────────────────────────────────────
// Timetable engine tests — GATE 6, verbatim:
//
//   "Timetable generated for a 3-branch school with zero hard-constraint
//    violations, and a clash-injection test proves the checker works."
//
// (The plan says 3-branch; the engine is per-branch by construction, so the
// test builds three realistic branch problems plus a combined multi-section
// solve — the "branch comparison" shape — and injects clashes to prove the
// checker catches what the solver prevents.)
// ──────────────────────────────────────────────

package main

import (
	"strconv"
	"testing"
)

var DAYS = []string{"MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"}

// threeBranchProblem builds a realistic 3-branch school: each branch has
// 2 sections, 8 teachers (some shared subjects), rooms incl. one lab, and
// full subject demands.
func threeBranchProblem() Problem {
	p := Problem{
		Days:    DAYS,
		Periods: 8,
		Seed:    42,
		Teachers: []Teacher{
			{ID: "T1", MaxPerDay: 6},
			{ID: "T2", MaxPerDay: 6},
			{ID: "T3", MaxPerDay: 6},
			{ID: "T4", MaxPerDay: 6},
			{ID: "T5", MaxPerDay: 6, NotConsecutive: true},
			{ID: "T6", MaxPerDay: 5},
			{ID: "T7", MaxPerDay: 6, Unavailable: []Unavailable{{Day: "MONDAY"}}},
			{ID: "T8", MaxPerDay: 6},
			{ID: "T9", MaxPerDay: 6, Unavailable: []Unavailable{{Day: "FRIDAY", Periods: []int{1, 2}}}},
			{ID: "T10", MaxPerDay: 6},
		},
		Sections: []Section{
			{ID: "S6A", Grade: "6", Strength: 40},
			{ID: "S6B", Grade: "6", Strength: 38},
			{ID: "S7A", Grade: "7", Strength: 42},
			{ID: "S7B", Grade: "7", Strength: 40},
			{ID: "S8A", Grade: "8", Strength: 44},
			{ID: "S8B", Grade: "8", Strength: 41},
		},
		Rooms: []Room{
			{ID: "R1", Capacity: 45},
			{ID: "R2", Capacity: 45},
			{ID: "R3", Capacity: 45},
			{ID: "LAB1", Kind: "LAB", Capacity: 50}, // must fit the 44-strong S8A
			{ID: "LIB", Kind: "LIBRARY", Capacity: 60},
		},
	}

	subjects := []struct {
		id    string
		perWk int
		room  string
	}{
		{"MATH", 6, ""}, {"ENG", 6, ""}, {"SCI", 5, "LAB"},
		{"HIST", 3, ""}, {"GEO", 3, ""}, {"HINDI", 4, ""},
		{"COMP", 2, "LAB"}, {"PE", 2, ""}, {"LIB", 1, "LIBRARY"},
	}
	// Section → teacher rotation (a teacher teaches the same subject across
	// sections, which is where cross-section clashes come from).
	teacherFor := map[string]string{
		"MATH": "T1", "ENG": "T2", "SCI": "T3", "HIST": "T4",
		"GEO": "T5", "HINDI": "T6", "COMP": "T8", "PE": "T10", "LIB": "T10",
	}
	for _, sec := range p.Sections {
		for _, sj := range subjects {
			p.Requirements = append(p.Requirements, Requirement{
				SubjectID:      sj.id,
				SectionID:      sec.ID,
				TeacherID:      teacherFor[sj.id],
				PeriodsPerWeek: sj.perWk,
				RoomKind:       sj.room,
			})
		}
	}
	return p
}

func TestGate6ThreeBranchSolvesWithZeroViolations(t *testing.T) {
	p := threeBranchProblem()
	res := p.Solve()
	if res.Status != "solved" {
		t.Fatalf("expected solved, got %s: %+v", res.Status, res.Violations)
	}
	if vs := p.CheckFull(res.Slots); len(vs) > 0 {
		t.Fatalf("checker reports violations the solver missed: %+v", vs)
	}
	if len(res.Slots) == 0 {
		t.Fatal("no slots")
	}
	// Demand completeness is part of the solved contract.
	for _, r := range p.Requirements {
		n := 0
		for _, s := range res.Slots {
			if s.SectionID == r.SectionID && s.SubjectID == r.SubjectID {
				n++
			}
		}
		if n != r.PeriodsPerWeek {
			t.Fatalf("demand unmet: %s in %s = %d/%d", r.SubjectID, r.SectionID, n, r.PeriodsPerWeek)
		}
	}
	t.Logf("solved %d placements in %dms over %d attempts", res.Stats.Placements, res.Stats.ElapsedMs, res.Stats.Attempts)
}

func TestGate6ClashInjectionIsCaught(t *testing.T) {
	p := threeBranchProblem()
	res := p.Solve()
	if res.Status != "solved" {
		t.Fatalf("precondition: solve failed: %+v", res.Violations)
	}

	// Injection 1: a REAL collision — clone an existing slot so the teacher
	// is in two places at once, and add a second clone on a cell the section
	// already occupies. The checker must catch the teacher clash, the section
	// clash, AND the demand overfill.
	victim := res.Slots[0]
	helper := findSlot(res.Slots, func(s Slot) bool {
		return s.TeacherID == victim.TeacherID &&
			!(s.Day == victim.Day && s.Period == victim.Period)
	})
	if helper == nil {
		t.Fatalf("precondition: teacher %s has no second slot to collide with", victim.TeacherID)
	}
	eaClone := *helper // same teacher, same cell → TEACHER_CLASH
	injected := append(append([]Slot{}, res.Slots...), eaClone)

	secClone := *helper
	secClone.SectionID = "S8B"
	secClone.SubjectID = "PE" // S8B needs 2 PE; board already has 2 → overfill too
	injected = append(injected, secClone)

	// Point the section clone at a cell S8B already occupies for a guaranteed
	// SECTION_CLASH even if the helper cell happens to be free for S8B.
	if s8b := findSlot(res.Slots, func(s Slot) bool { return s.SectionID == "S8B" }); s8b != nil {
		secClone.Day, secClone.Period = s8b.Day, s8b.Period
		secClone.TeacherID = "T9" // free unless another clone sits there
		injected[len(injected)-1] = secClone
	}

	vs := p.CheckFull(injected)
	foundSec, foundTea, foundDemand := false, false, false
	for _, v := range vs {
		if v.Rule == "SECTION_CLASH" {
			foundSec = true
		}
		if v.Rule == "TEACHER_CLASH" {
			foundTea = true
		}
		if v.Rule == "DEMAND_UNMET" {
			foundDemand = true // 3 PE periods for a 2/week demand
		}
	}
	if !foundSec || !foundTea || !foundDemand {
		t.Fatalf("injected double-booking not caught (sec=%v tea=%v demand=%v): %+v",
			foundSec, foundTea, foundDemand, vs)
	}

	// Injection 2: teacher unavailability violation.
	bad := victim
	bad.TeacherID = "T7" // unavailable all Monday
	bad.Day = "MONDAY"
	bad.Period = 3
	bad.SectionID = "S6B"
	vs = p.CheckFull(append(append([]Slot{}, res.Slots...), bad))
	found := false
	for _, v := range vs {
		if v.Rule == "TEACHER_UNAVAILABLE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unavailability violation not caught: %+v", vs)
	}

	// Injection 3: back-to-back for T5 (NotConsecutive) — two ADJACENT cells
	// that are free for both T5 and S8B on the solved board, so the only new
	// violation is the consecutive rule itself.
	bbDay, bbPeriod := "", 0
	busyT := map[string]bool{}
	busyS := map[string]bool{}
	for _, s := range res.Slots {
		if s.TeacherID == "T5" {
			busyT[s.Day+"|"+itoa(s.Period)] = true
		}
		if s.SectionID == "S8B" {
			busyS[s.Day+"|"+itoa(s.Period)] = true
		}
	}
outer:
	for _, d := range p.Days {
		for pr := 1; pr < p.Periods; pr++ {
			if !busyT[d+"|"+itoa(pr)] && !busyT[d+"|"+itoa(pr+1)] &&
				!busyS[d+"|"+itoa(pr)] && !busyS[d+"|"+itoa(pr+1)] {
				bbDay, bbPeriod = d, pr
				break outer
			}
		}
	}
	if bbDay == "" {
		t.Fatal("precondition: no adjacent free pair for T5/S8B")
	}
	vs = p.CheckFull(append(append([]Slot{}, res.Slots...),
		Slot{Day: bbDay, Period: bbPeriod, SectionID: "S8B", SubjectID: "GEO", TeacherID: "T5"},
		Slot{Day: bbDay, Period: bbPeriod + 1, SectionID: "S8B", SubjectID: "GEO", TeacherID: "T5"},
	))
	found = false
	for _, v := range vs {
		if v.Rule == "TEACHER_CONSECUTIVE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("back-to-back violation not caught: %+v", vs)
	}

	// Injection 4: room capacity — a self-contained board whose only room is
	// too small for the section (the main fixture's lab was sized to fit, so
	// it cannot prove H10).
	small := &Problem{
		Days: []string{"MONDAY"}, Periods: 4,
		Sections: []Section{{ID: "SA", Strength: 44}},
		Rooms:    []Room{{ID: "R", Capacity: 40}},
		Teachers: []Teacher{{ID: "TX", MaxPerDay: 4}},
		Requirements: []Requirement{
			{SectionID: "SA", SubjectID: "MATH", TeacherID: "TX", PeriodsPerWeek: 1},
		},
	}
	vs = small.CheckFull([]Slot{
		{Day: "MONDAY", Period: 1, SectionID: "SA", SubjectID: "MATH", TeacherID: "TX", RoomID: "R"},
	})
	found = false
	for _, v := range vs {
		if v.Rule == "ROOM_CAPACITY" {
			found = true
		}
	}
	if !found {
		t.Fatalf("room capacity violation not caught: %+v", vs)
	}

	// Injection 5: demand unmet — remove one slot from a solved board.
	short := append([]Slot{}, res.Slots[1:]...)
	vs = p.CheckFull(short)
	found = false
	for _, v := range vs {
		if v.Rule == "DEMAND_UNMET" {
			found = true
		}
	}
	if !found {
		t.Fatalf("demand-unmet not caught: %+v", vs)
	}
}

func TestSolverHonoursTeacherUnavailability(t *testing.T) {
	p := threeBranchProblem()
	res := p.Solve()
	if res.Status != "solved" {
		t.Fatalf("solve failed: %+v", res.Violations)
	}
	for _, s := range res.Slots {
		if s.TeacherID == "T7" && s.Day == "MONDAY" {
			t.Fatalf("T7 scheduled on their unavailable day: %+v", s)
		}
		if s.TeacherID == "T9" && s.Day == "FRIDAY" && s.Period <= 2 {
			t.Fatalf("T9 scheduled in their unavailable Friday P%d", s.Period)
		}
	}
}

func TestSolverHonoursLockedSlots(t *testing.T) {
	p := threeBranchProblem()
	// Lock the first two Monday PE/assembly-style cells.
	p.Locked = []LockedSlot{
		{Day: "MONDAY", Period: 1, SectionID: "S6A", SubjectID: "PE", TeacherID: "T10"},
		{Day: "MONDAY", Period: 2, SectionID: "S6A", SubjectID: "PE", TeacherID: "T10"},
	}
	// Reduce PE demand to exactly the two locked periods so the board closes;
	// allow the double since both locks are on the same day.
	for i := range p.Requirements {
		if p.Requirements[i].SubjectID == "PE" && p.Requirements[i].SectionID == "S6A" {
			p.Requirements[i].PeriodsPerWeek = 2
			p.Requirements[i].AllowDoubles = true
		}
	}
	res := p.Solve()
	if res.Status != "solved" {
		t.Fatalf("solve failed: %+v", res.Violations)
	}
	for _, l := range p.Locked {
		held := false
		for _, s := range res.Slots {
			if s.Day == l.Day && s.Period == l.Period && s.SectionID == l.SectionID &&
				s.SubjectID == l.SubjectID && s.Locked {
				held = true
			}
		}
		if !held {
			t.Fatalf("locked slot not preserved: %+v", l)
		}
	}
}

func TestConflictingLocksAreInfeasible(t *testing.T) {
	p := threeBranchProblem()
	// Two locks need T10 in two places at once.
	p.Locked = []LockedSlot{
		{Day: "MONDAY", Period: 1, SectionID: "S6A", SubjectID: "PE", TeacherID: "T10"},
		{Day: "MONDAY", Period: 1, SectionID: "S7A", SubjectID: "PE", TeacherID: "T10"},
	}
	res := p.Solve()
	if res.Status != "infeasible" {
		t.Fatalf("conflicting locks must be infeasible, got %s", res.Status)
	}
}

func TestOverdemandedTeacherIsInfeasible(t *testing.T) {
	p := threeBranchProblem()
	// T1 teaches 36 MATH periods/week (6 sections × 6). Capping him at 2/day
	// makes the demand mathematically unsatisfiable — the solver must report
	// infeasible QUICKLY, not grind the restart budget (regression: this
	// test used to exhaust 12 × 20s attempts because MRV re-counted legal
	// cells for every lesson on every node).
	for i := range p.Teachers {
		if p.Teachers[i].ID == "T1" {
			p.Teachers[i].MaxPerDay = 2
		}
	}
	p.Options.MaxRestarts = 2
	res := p.Solve()
	if res.Status != "infeasible" {
		t.Fatalf("over-capped teacher must be infeasible, got %s with %d slots", res.Status, len(res.Slots))
	}
}

func TestDeterministicUnderSeed(t *testing.T) {
	p1 := threeBranchProblem()
	p2 := threeBranchProblem()
	r1, r2 := p1.Solve(), p2.Solve()
	if r1.Status != "solved" || r2.Status != "solved" {
		t.Fatalf("both must solve: %s / %s", r1.Status, r2.Status)
	}
	if len(r1.Slots) != len(r2.Slots) {
		t.Fatalf("same seed must give same placement count")
	}
	for i := range r1.Slots {
		if r1.Slots[i] != r2.Slots[i] {
			t.Fatalf("seed divergence at slot %d: %+v vs %+v", i, r1.Slots[i], r2.Slots[i])
		}
	}
}

// ── substitutions ──

func TestSubstitutionSuggestsFreeQualifiedStaff(t *testing.T) {
	sp := SubstitutionProblem{
		Day:     "MONDAY",
		Periods: 4,
		Timetable: []Slot{
			{Day: "MONDAY", Period: 1, SectionID: "S6A", SubjectID: "MATH", TeacherID: "T1"},
			{Day: "MONDAY", Period: 2, SectionID: "S6B", SubjectID: "MATH", TeacherID: "T1"},
			{Day: "MONDAY", Period: 1, SectionID: "S7A", SubjectID: "ENG", TeacherID: "T2"},
			{Day: "MONDAY", Period: 2, SectionID: "S7A", SubjectID: "SCI", TeacherID: "T3"},
			{Day: "MONDAY", Period: 3, SectionID: "S7B", SubjectID: "HIST", TeacherID: "T4"},
		},
		Absent: []string{"T1"},
		Staff: []SubStaff{
			{ID: "T1"}, {ID: "T2"}, {ID: "T3"}, {ID: "T4"}, {ID: "T9"},
		},
		Qualified: map[string][]string{
			"MATH": {"T1", "T9"}, // only T9 is qualified besides the absentee
		},
	}
	res := SuggestSubstitutions(sp)
	if len(res.Suggestions) != 2 {
		t.Fatalf("expected 2 suggestions, got %+v", res.Suggestions)
	}
	for _, s := range res.Suggestions {
		if s.Substitute != "T9" {
			t.Fatalf("unqualified or busy substitute chosen: %+v", s)
		}
	}
	// The two covers must be in different periods (T9 cannot be in two
	// places at once) — the suggester takes its own covers into account.
	if res.Suggestions[0].Slot.Period == res.Suggestions[1].Slot.Period {
		t.Fatalf("substitute double-booked: %+v", res.Suggestions)
	}
}

func TestSubstitutionMarksUncoveredWhenNobodyFits(t *testing.T) {
	sp := SubstitutionProblem{
		Day:     "MONDAY",
		Periods: 2,
		Timetable: []Slot{
			{Day: "MONDAY", Period: 1, SectionID: "S6A", SubjectID: "MATH", TeacherID: "T1"},
			{Day: "MONDAY", Period: 1, SectionID: "S7A", SubjectID: "ENG", TeacherID: "T2"},
		},
		Absent: []string{"T1"},
		Staff: []SubStaff{
			{ID: "T2", MaxPerDay: 1}, // already teaching P1 → cap would exceed
		},
		Qualified: map[string][]string{},
	}
	res := SuggestSubstitutions(sp)
	if len(res.Suggestions) != 0 || len(res.Uncovered) != 1 {
		t.Fatalf("expected uncovered lesson, got suggestions=%d uncovered=%d",
			len(res.Suggestions), len(res.Uncovered))
	}
}

func TestSpecValidationRejectsBadProblems(t *testing.T) {
	p := threeBranchProblem()
	p.Periods = 0
	if err := p.validate(); err == nil {
		t.Fatal("periods=0 must be rejected")
	}
	p = threeBranchProblem()
	p.Requirements[0].TeacherID = "GHOST"
	if err := p.validate(); err == nil {
		t.Fatal("unknown teacher must be rejected")
	}
	p = threeBranchProblem()
	p.Requirements[0].PeriodsPerWeek = 999
	if err := p.validate(); err == nil {
		t.Fatal("impossible demand must be rejected")
	}
}

func findSlot(slots []Slot, pred func(Slot) bool) *Slot {
	for i := range slots {
		if pred(slots[i]) {
			return &slots[i]
		}
	}
	return nil
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
