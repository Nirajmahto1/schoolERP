// ──────────────────────────────────────────────
// Constraint solver (BUILD_PLAN 6.2)
//
// A CP-style backtracking search over "which lesson goes in which cell":
//   • variables  = the required lesson instances (one per required period of
//     each subject × section demand; locked slots consume instances up front)
//   • assignment = place a lesson into a (day, period) for its section
//   • hard constraints checked incrementally (only the affected axes)
//
// Heuristics, the difference between instant and forever:
//   • MRV + degree: place the most-constrained lesson next (fewest legal
//     cells; ties broken by the more-shared teacher). Fail fast when a
//     lesson has zero legal cells.
//   • Randomised restarts with a seeded RNG: a dead search slice restarts
//     with a new value order — on school-timetable-shaped problems a lucky
//     order beats exhaustive unwinding. Seed+attempt reproduces any run.
//   • Locked slots are seeded first and immovable; partial regeneration is
//     "delete the slots to regenerate, re-solve with the rest locked".
//
// Room choice is deterministic (not RNG-touched) so a lock pinning a room
// stays consistent across attempts.
// ──────────────────────────────────────────────

package main

import (
	"fmt"
	"math/rand"
	"sort"
	"time"
)

type cell struct {
	day    string
	period int
}

// lesson is one concrete instance to place.
type lesson struct {
	reqIdx int
}

type solver struct {
	p        *Problem
	rng      *rand.Rand
	nodes    int64
	deadline time.Time

	lessons []lesson // expanded demands, lock instances filtered out

	// occupancy mirrors (per attempt)
	teacherBusy map[string]map[cell]bool
	sectionBusy map[string]map[cell]bool
	roomBusy    map[string]map[cell]bool
	// per-day counters
	subjectDay map[string]map[string]int // "section/subject" → day → count
	teacherDay map[string]map[string]int // teacher → day → count

	lockedCells map[string]bool // "day|period|section" owned by locks
}

// Solve runs the restart loop and returns a fully-checked result.
func (p *Problem) Solve() *GenerationResult {
	maxRestarts := p.Options.MaxRestarts
	if maxRestarts <= 0 {
		maxRestarts = 12
	}

	start := time.Now()
	s := &solver{p: p}
	s.lockedCells = map[string]bool{}
	for _, l := range p.Locked {
		s.lockedCells[cellKey(l.Day, l.Period, l.SectionID)] = true
	}

	// Locks that fight each other or violate hard rules are infeasible
	// outright — the board is seeded with them, so no search can fix them.
	// DEMAND_UNMET is filtered: a locks-only board has not placed the rest of
	// the demand yet, so "demand unmet" says nothing about the locks.
	var lockVs []Violation
	for _, v := range p.CheckFull(p.lockSlotsOnly()) {
		if v.Rule != "DEMAND_UNMET" {
			lockVs = append(lockVs, v)
		}
	}
	if len(lockVs) > 0 {
		return &GenerationResult{Status: "infeasible", Violations: lockVs}
	}

	// Mathematically unsatisfiable problems (an over-capped teacher, subject
	// demand exceeding the week, no fitting room) are rejected before the
	// search burns its restart budget — no value order fixes a pigeonhole.
	if vs := p.staticFeasibility(); len(vs) > 0 {
		return &GenerationResult{Status: "infeasible", Violations: vs}
	}

	remaining := s.expandDemands()
	s.lessons = remaining
	totalNodes := int64(0)
	attempts := 0
	var result []Slot

	for attempt := 0; attempt < maxRestarts; attempt++ {
		attempts++
		s.rng = rand.New(rand.NewSource(p.Seed + int64(attempt)*7919))
		s.deadline = time.Now().Add(20 * time.Second)
		s.resetDynamic()
		assign := make(map[int]cellRoom, len(remaining))
		if s.search(assign, remaining) {
			result = s.materialise(assign)
			break
		}
		result = nil
	}
	totalNodes += s.nodes

	stats := SolveStats{
		Attempts:      attempts,
		NodesExplored: totalNodes,
		ElapsedMs:     time.Since(start).Milliseconds(),
	}
	if result == nil {
		return &GenerationResult{
			Status: "infeasible",
			Violations: []Violation{{
				Rule:   "INFEASIBLE",
				Detail: "no assignment satisfied all hard constraints within the attempt budget — check teacher availability vs demand, or relax a cap",
			}},
			Stats: stats,
		}
	}

	// The full checker is the authority; incremental checking must agree.
	if vs := p.CheckFull(result); len(vs) > 0 {
		stats.Placements = len(result)
		return &GenerationResult{Status: "infeasible", Violations: vs, Stats: stats}
	}
	stats.Placements = len(result)
	return &GenerationResult{Status: "solved", Slots: result, Stats: stats}
}

// staticFeasibility catches demand-vs-capacity pigeonholes before any
// search: a problem that fails here is infeasible on arithmetic alone.
func (p *Problem) staticFeasibility() []Violation {
	var vs []Violation
	infeasible := func(detail string) {
		vs = append(vs, p.violation("INFEASIBLE", detail, nil, nil))
	}

	// Grid capacity: a section cannot hold more lessons than cells.
	secLoad := map[string]int{}
	for _, r := range p.Requirements {
		secLoad[r.SectionID] += r.PeriodsPerWeek
	}
	for sec, load := range secLoad {
		if load > len(p.Days)*p.Periods {
			infeasible(fmt.Sprintf("section %s needs %d lessons/week but the grid offers only %d cells",
				sec, load, len(p.Days)*p.Periods))
		}
	}

	// Teacher loads vs their caps.
	load := map[string]int{}
	for _, r := range p.Requirements {
		if r.TeacherID != "" {
			load[r.TeacherID] += r.PeriodsPerWeek
		}
	}
	for _, t := range p.Teachers {
		total := load[t.ID]
		if total == 0 {
			continue
		}
		maxDay := t.MaxPerDay
		if maxDay <= 0 {
			maxDay = p.effectiveDefaultMaxPerDay()
		}
		if t.NotConsecutive {
			// at most ceil(Periods/2) lessons/day without back-to-back
			if cap := (p.Periods + 1) / 2; cap < maxDay {
				maxDay = cap
			}
		}
		if t.MaxPerWeek > 0 && total > t.MaxPerWeek {
			infeasible(fmt.Sprintf("teacher %s is demanded %d lessons/week but maxPerWeek is %d",
				t.ID, total, t.MaxPerWeek))
		}
		if total > maxDay*len(p.Days) {
			infeasible(fmt.Sprintf("teacher %s is demanded %d lessons/week but a %d/day cap over %d days allows only %d",
				t.ID, total, maxDay, len(p.Days), maxDay*len(p.Days)))
		}
	}

	// Subject-per-section pigeonholes.
	for _, r := range p.Requirements {
		if r.PeriodsPerWeek > len(p.Days)*p.Periods {
			infeasible(fmt.Sprintf("subject %s in section %s demands %d periods/week but the grid has %d cells",
				r.SubjectID, r.SectionID, r.PeriodsPerWeek, len(p.Days)*p.Periods))
			continue
		}
		if !r.AllowDoubles {
			maxSub := r.MaxPerDay
			if maxSub <= 0 {
				maxSub = 1
			}
			if r.PeriodsPerWeek > maxSub*len(p.Days) {
				infeasible(fmt.Sprintf("subject %s in section %s demands %d periods/week but maxPerDay %d over %d days allows only %d",
					r.SubjectID, r.SectionID, r.PeriodsPerWeek, maxSub, len(p.Days), maxSub*len(p.Days)))
			}
		}
	}

	// Room-kind capacity: some room of the demanded kind must fit the section.
	if len(p.Rooms) > 0 {
		strength := map[string]int{}
		for _, sec := range p.Sections {
			strength[sec.ID] = sec.Strength
		}
		for _, r := range p.Requirements {
			if r.RoomKind == "" || r.PeriodsPerWeek == 0 {
				continue
			}
			fits := false
			for _, rm := range p.Rooms {
				if rm.Kind == r.RoomKind && (rm.Capacity == 0 || rm.Capacity >= strength[r.SectionID]) {
					fits = true
					break
				}
			}
			if !fits {
				infeasible(fmt.Sprintf("no %s room fits section %s (%d students) for subject %s",
					r.RoomKind, r.SectionID, strength[r.SectionID], r.SubjectID))
			}
		}
	}

	return vs
}

func (p *Problem) lockSlotsOnly() []Slot {
	slots := make([]Slot, 0, len(p.Locked))
	for _, l := range p.Locked {
		slots = append(slots, Slot{
			Day: l.Day, Period: l.Period, SectionID: l.SectionID,
			SubjectID: l.SubjectID, TeacherID: l.TeacherID, RoomID: l.RoomID, Locked: true,
		})
	}
	return slots
}

// expandDemands turns requirements into lesson instances. Locked slots
// consume instances of their (subject, section) up front — those instances
// need no placement; their occupancy is seeded in resetDynamic and they are
// rendered from p.Locked in materialise.
func (s *solver) expandDemands() []lesson {
	consumed := map[string]int{} // "section/subject" → instances consumed
	lessons := []lesson{}

	for i, r := range s.p.Requirements {
		key := r.SectionID + "/" + r.SubjectID
		for n := 0; n < r.PeriodsPerWeek; n++ {
			if consumed[key] < lockConsumption(s.p, r.SectionID, r.SubjectID) {
				consumed[key]++
				continue
			}
			lessons = append(lessons, lesson{reqIdx: i})
		}
	}
	return lessons
}

func lockConsumption(p *Problem, sectionID, subjectID string) int {
	n := 0
	for _, l := range p.Locked {
		if l.SectionID == sectionID && l.SubjectID == subjectID {
			n++
		}
	}
	return n
}

func (s *solver) resetDynamic() {
	s.teacherBusy = map[string]map[cell]bool{}
	s.sectionBusy = map[string]map[cell]bool{}
	s.roomBusy = map[string]map[cell]bool{}
	s.subjectDay = map[string]map[string]int{}
	s.teacherDay = map[string]map[string]int{}
	s.nodes = 0
	// Seed locks into the per-attempt mirrors.
	for _, l := range s.p.Locked {
		c := cell{day: l.Day, period: l.Period}
		s.sectionBusy[l.SectionID] = addBusy(s.sectionBusy[l.SectionID], c)
		if l.TeacherID != "" {
			s.teacherBusy[l.TeacherID] = addBusy(s.teacherBusy[l.TeacherID], c)
		}
		if l.RoomID != "" {
			s.roomBusy[l.RoomID] = addBusy(s.roomBusy[l.RoomID], c)
		}
		key := l.SectionID + "/" + l.SubjectID
		s.subjectDay[key] = bumpDay(s.subjectDay[key], l.Day)
		if l.TeacherID != "" {
			s.teacherDay[l.TeacherID] = bumpDay(s.teacherDay[l.TeacherID], l.Day)
		}
	}
}

func addBusy(m map[cell]bool, c cell) map[cell]bool {
	if m == nil {
		m = map[cell]bool{}
	}
	m[c] = true
	return m
}

func bumpDay(m map[string]int, day string) map[string]int {
	if m == nil {
		m = map[string]int{}
	}
	m[day]++
	return m
}

// ── the incremental hard-constraint check ──

// canPlace reports whether requirement r's lesson may occupy c right now.
// Mirrors CheckFull's rules exactly, on current occupancy only.
func (s *solver) canPlace(r Requirement, c cell, roomID string) bool {
	// H2 section clash.
	if s.sectionBusy[r.SectionID][c] {
		return false
	}
	t := s.teacherByID(r.TeacherID)
	// H1 teacher clash.
	if s.teacherBusy[r.TeacherID][c] {
		return false
	}
	// H4 unavailability.
	if s.p.teacherUnavailable(t, c.day, c.period) {
		return false
	}
	// H5 teacher per-day cap.
	maxDay := t.MaxPerDay
	if maxDay <= 0 {
		maxDay = s.p.effectiveDefaultMaxPerDay()
	}
	if s.teacherDay[r.TeacherID][c.day]+1 > maxDay {
		return false
	}
	// H7 back-to-back.
	if t.NotConsecutive {
		if s.teacherBusy[r.TeacherID][cell{day: c.day, period: c.period - 1}] ||
			s.teacherBusy[r.TeacherID][cell{day: c.day, period: c.period + 1}] {
			return false
		}
	}
	// H8 subject per-day cap per section. AllowDoubles (labs, games,
	// assemblies) opts the requirement out of the default once-a-day rule.
	if !r.AllowDoubles {
		maxSub := r.MaxPerDay
		if maxSub <= 0 {
			maxSub = 1
		}
		key := r.SectionID + "/" + r.SubjectID
		if s.subjectDay[key][c.day]+1 > maxSub {
			return false
		}
	}
	// H3 room clash (room chosen by pickRoom is free by construction, but
	// locks may have taken it between pickRoom and here — recheck).
	if roomID != "" && s.roomBusy[roomID][c] {
		return false
	}
	return true
}

// pickRoom returns a free, kind-matching, capacity-fitting room for the cell.
// "" means rooms are unmanaged; "none fits" is signalled by the caller
// re-checking when rooms exist.
func (s *solver) pickRoom(r Requirement, c cell) string {
	if len(s.p.Rooms) == 0 {
		return ""
	}
	sectionStrength := 0
	for _, sec := range s.p.Sections {
		if sec.ID == r.SectionID {
			sectionStrength = sec.Strength
			break
		}
	}
	for i := range s.p.Rooms {
		rm := &s.p.Rooms[i]
		if r.RoomKind != "" && rm.Kind != r.RoomKind {
			continue
		}
		if rm.Capacity > 0 && sectionStrength > rm.Capacity {
			continue
		}
		if s.roomBusy[rm.ID][c] {
			continue
		}
		return rm.ID
	}
	return noRoom
}

const noRoom = "\x00none"

func (s *solver) teacherByID(id string) Teacher {
	for _, t := range s.p.Teachers {
		if t.ID == id {
			return t
		}
	}
	return Teacher{}
}

// ── search ──

type cellRoom struct {
	c      cell
	roomID string
}

func (s *solver) search(assign map[int]cellRoom, lessons []lesson) bool {
	// MRV + degree: most-constrained unplaced lesson next.
	bestIdx := -1
	bestCount := 0
	bestDeg := 0
	var bestCands []cell

	for i, l := range lessons {
		if _, done := assign[i]; done {
			continue
		}
		r := s.p.Requirements[l.reqIdx]
		count := 0
		var cands []cell
		for _, d := range s.p.Days {
			for pr := 1; pr <= s.p.Periods; pr++ {
				c := cell{day: d, period: pr}
				if s.lockedCells[cellKey(c.day, c.period, r.SectionID)] {
					continue
				}
				roomID := s.pickRoom(r, c)
				if roomID == noRoom {
					continue
				}
				if roomID != "" && s.roomBusy[roomID][c] {
					continue
				}
				if s.canPlace(r, c, roomID) {
					count++
					if count <= 64 { // MRV needs ordering, not the full list
						cands = append(cands, c)
					}
				}
			}
		}
		deg := 0
		for _, l2 := range lessons {
			if s.p.Requirements[l2.reqIdx].TeacherID == r.TeacherID {
				deg++
			}
		}
		if bestIdx == -1 || count < bestCount || (count == bestCount && deg > bestDeg) {
			bestIdx, bestCount, bestDeg, bestCands = i, count, deg, cands
		}
		if count == 0 {
			return false // dead branch, fail fast
		}
	}

	if bestIdx == -1 {
		return true // everything placed
	}

	l := lessons[bestIdx]
	r := s.p.Requirements[l.reqIdx]
	s.rng.Shuffle(len(bestCands), func(i, j int) { bestCands[i], bestCands[j] = bestCands[j], bestCands[i] })

	for _, c := range bestCands {
		s.nodes++
		if s.nodes%4096 == 0 && time.Now().After(s.deadline) {
			return false
		}
		roomID := s.pickRoom(r, c)
		if roomID == noRoom || (roomID != "" && s.roomBusy[roomID][c]) {
			continue
		}
		s.doPlace(assign, bestIdx, r, c, roomID)
		if s.search(assign, lessons) {
			return true
		}
		s.undoPlace(assign, bestIdx, r, c, roomID)
	}
	return false
}

func (s *solver) doPlace(assign map[int]cellRoom, li int, r Requirement, c cell, roomID string) {
	assign[li] = cellRoom{c: c, roomID: roomID}
	s.sectionBusy[r.SectionID] = addBusy(s.sectionBusy[r.SectionID], c)
	s.teacherBusy[r.TeacherID] = addBusy(s.teacherBusy[r.TeacherID], c)
	if roomID != "" && roomID != noRoom {
		s.roomBusy[roomID] = addBusy(s.roomBusy[roomID], c)
	}
	key := r.SectionID + "/" + r.SubjectID
	s.subjectDay[key] = bumpDay(s.subjectDay[key], c.day)
	s.teacherDay[r.TeacherID] = bumpDay(s.teacherDay[r.TeacherID], c.day)
}

func (s *solver) undoPlace(assign map[int]cellRoom, li int, r Requirement, c cell, roomID string) {
	delete(assign, li)
	delete(s.sectionBusy[r.SectionID], c)
	delete(s.teacherBusy[r.TeacherID], c)
	if roomID != "" && roomID != noRoom {
		delete(s.roomBusy[roomID], c)
	}
	key := r.SectionID + "/" + r.SubjectID
	s.subjectDay[key][c.day]--
	s.teacherDay[r.TeacherID][c.day]--
}

// ── output ──

func (s *solver) materialise(assign map[int]cellRoom) []Slot {
	slots := []Slot{}
	for li, cr := range assign {
		r := s.p.Requirements[s.lessons[li].reqIdx]
		roomID := cr.roomID
		if roomID == noRoom {
			roomID = ""
		}
		slots = append(slots, Slot{
			Day:       cr.c.day,
			Period:    cr.c.period,
			SectionID: r.SectionID,
			SubjectID: r.SubjectID,
			TeacherID: r.TeacherID,
			RoomID:    roomID,
		})
	}
	for _, l := range s.p.Locked {
		slots = append(slots, Slot{
			Day: l.Day, Period: l.Period, SectionID: l.SectionID,
			SubjectID: l.SubjectID, TeacherID: l.TeacherID, RoomID: l.RoomID, Locked: true,
		})
	}
	sort.Slice(slots, func(i, j int) bool {
		a, b := slots[i], slots[j]
		if a.Day != b.Day {
			return s.dayIndex(a.Day) < s.dayIndex(b.Day)
		}
		if a.Period != b.Period {
			return a.Period < b.Period
		}
		return a.SectionID < b.SectionID
	})
	return slots
}

func (s *solver) dayIndex(day string) int {
	for i, d := range s.p.Days {
		if d == day {
			return i
		}
	}
	return len(s.p.Days)
}
