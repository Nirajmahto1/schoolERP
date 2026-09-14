// ──────────────────────────────────────────────
// Hard-constraint checker (BUILD_PLAN 6.2, GATE 6)
//
// "Timetable generated ... with zero hard-constraint violations, and a
// clash-injection test proves the checker works."
//
// The checker is the source of truth: the solver uses it inside the search,
// and the same function validates any externally supplied timetable. A
// violation here is never advisory — if CheckFull returns violations, the
// timetable is rejected wherever it came from.
//
// Hard rules (violations make the timetable unusable):
//   H1  a teacher is in two places at once
//   H2  a section has two lessons at once
//   H3  a room hosts two lessons at once
//   H4  a teacher is unavailable (day or specific periods)
//   H5  a teacher exceeds maxPerDay
//   H6  a teacher exceeds maxPerWeek
//   H7  back-to-back periods for a teacher flagged NotConsecutive
//   H8  a subject exceeds its per-section maxPerDay
//   H9  a room is required by kind but the room's kind differs
//   H10 room capacity < section strength
//   H11 a locked slot's cell does not hold exactly the locked lesson
// ──────────────────────────────────────────────

package main

import (
	"fmt"
	"sort"
)

// CheckFull validates every hard rule over a complete assignment.
func (p *Problem) CheckFull(slots []Slot) []Violation {
	vs := []Violation{}
	byKey := map[string]*Slot{} // "day|period|section"
	for i := range slots {
		s := slots[i]
		byKey[cellKey(s.Day, s.Period, s.SectionID)] = &slots[i]
	}

	// H1/H2/H3: occupancy maps per (day, period).
	type axes struct {
		teacher map[string][]*Slot
		section map[string][]*Slot
		room    map[string][]*Slot
	}
	occ := func() axes {
		return axes{
			teacher: map[string][]*Slot{},
			section: map[string][]*Slot{},
			room:    map[string][]*Slot{},
		}
	}
	tOcc, sOcc, rOcc := occ(), occ(), occ()
	for i := range slots {
		s := &slots[i]
		tp := timeKey(s.Day, s.Period)
		tOcc.teacher[s.TeacherID+"\x00"+tp] = append(tOcc.teacher[s.TeacherID+"\x00"+tp], s)
		sOcc.section[s.SectionID+"\x00"+tp] = append(sOcc.section[s.SectionID+"\x00"+tp], s)
		if s.RoomID != "" {
			rOcc.room[s.RoomID+"\x00"+tp] = append(rOcc.room[s.RoomID+"\x00"+tp], s)
		}
	}

	// H1: teacher clash.
	for k, group := range tOcc.teacher {
		if len(group) > 1 {
			vs = append(vs, p.violation("TEACHER_CLASH",
				fmt.Sprintf("teacher %s is booked %d times at %s", teacherOf(k), len(group), whenOf(k)), group[0], group[1]))
		}
	}
	// H2: section clash.
	for k, group := range sOcc.section {
		if len(group) > 1 {
			vs = append(vs, p.violation("SECTION_CLASH",
				fmt.Sprintf("section %s has %d lessons at %s", sectionOf(k), len(group), whenOf(k)), group[0], group[1]))
		}
	}
	// H3: room clash.
	for k, group := range rOcc.room {
		if len(group) > 1 {
			vs = append(vs, p.violation("ROOM_CLASH",
				fmt.Sprintf("room %s hosts %d lessons at %s", roomOf(k), len(group), whenOf(k)), group[0], group[1]))
		}
	}

	// H4/H5/H6/H7 per teacher.
	for _, t := range p.Teachers {
		lessons := []*Slot{}
		for i := range slots {
			if slots[i].TeacherID == t.ID {
				lessons = append(lessons, &slots[i])
			}
		}
		if len(lessons) == 0 {
			continue
		}

		// H4: unavailability.
		for _, l := range lessons {
			if p.teacherUnavailable(t, l.Day, l.Period) {
				vs = append(vs, p.violation("TEACHER_UNAVAILABLE",
					fmt.Sprintf("teacher %s is unavailable %s P%d but is booked there", t.ID, l.Day, l.Period), l, nil))
			}
		}

		// H5/H6: load caps.
		perDay := map[string]int{}
		perWeek := 0
		for _, l := range lessons {
			perDay[l.Day]++
			perWeek++
		}
		maxDay := t.MaxPerDay
		if maxDay <= 0 {
			maxDay = p.effectiveDefaultMaxPerDay()
		}
		for d, n := range perDay {
			if n > maxDay {
				vs = append(vs, p.violation("TEACHER_MAX_PER_DAY",
					fmt.Sprintf("teacher %s has %d periods on %s (max %d)", t.ID, n, d, maxDay), perDayFirst(lessons, d), nil))
			}
		}
		if t.MaxPerWeek > 0 && perWeek > t.MaxPerWeek {
			vs = append(vs, p.violation("TEACHER_MAX_PER_WEEK",
				fmt.Sprintf("teacher %s has %d periods/week (max %d)", t.ID, perWeek, t.MaxPerWeek), lessons[0], nil))
		}

		// H7: back-to-back.
		if t.NotConsecutive {
			byDay := map[string][]int{}
			for _, l := range lessons {
				byDay[l.Day] = append(byDay[l.Day], l.Period)
			}
			for d, periods := range byDay {
				sort.Ints(periods)
				for i := 1; i < len(periods); i++ {
					if periods[i] == periods[i-1]+1 {
						a := perDayFirst(lessons, d)
						b := perDayPeriod(lessons, d, periods[i])
						vs = append(vs, p.violation("TEACHER_CONSECUTIVE",
							fmt.Sprintf("teacher %s has back-to-back P%d→P%d on %s", t.ID, periods[i-1], periods[i], d), a, b))
					}
				}
			}
		}
	}

	// H8: subject per-day cap per section. AllowDoubles opts out of the
	// default once-a-day rule (labs, games, double periods).
	for _, r := range p.Requirements {
		if r.AllowDoubles {
			continue
		}
		maxDay := r.MaxPerDay
		if maxDay <= 0 {
			maxDay = 1
		}
		perDay := map[string]int{}
		var first *Slot
		for i := range slots {
			s := &slots[i]
			if s.SectionID == r.SectionID && s.SubjectID == r.SubjectID {
				perDay[s.Day]++
				if first == nil {
					first = s
				}
			}
		}
		for d, n := range perDay {
			if n > maxDay {
				vs = append(vs, p.violation("SUBJECT_MAX_PER_DAY",
					fmt.Sprintf("subject %s in section %s appears %d times on %s (max %d)", r.SubjectID, r.SectionID, n, d, maxDay), first, nil))
			}
		}
	}

	// H9/H10: room kind + capacity (only when rooms are managed).
	if len(p.Rooms) > 0 {
		roomByID := map[string]Room{}
		for _, r := range p.Rooms {
			roomByID[r.ID] = r
		}
		sectionByID := map[string]Section{}
		for _, s := range p.Sections {
			sectionByID[s.ID] = s
		}
		reqBySS := map[string]Requirement{}
		for _, r := range p.Requirements {
			reqBySS[r.SubjectID+"/"+r.SectionID] = r
		}
		for i := range slots {
			s := &slots[i]
			if s.RoomID == "" {
				continue
			}
			room, ok := roomByID[s.RoomID]
			if !ok {
				vs = append(vs, p.violation("ROOM_UNKNOWN",
					fmt.Sprintf("slot references unknown room %q", s.RoomID), s, nil))
				continue
			}
			if req, ok := reqBySS[s.SubjectID+"/"+s.SectionID]; ok && req.RoomKind != "" && room.Kind != req.RoomKind {
				vs = append(vs, p.violation("ROOM_KIND",
					fmt.Sprintf("subject %s in section %s needs a %s room but %s is a %s",
						s.SubjectID, s.SectionID, req.RoomKind, s.RoomID, room.Kind), s, nil))
			}
			if room.Capacity > 0 {
				if sec, ok := sectionByID[s.SectionID]; ok && sec.Strength > room.Capacity {
					vs = append(vs, p.violation("ROOM_CAPACITY",
						fmt.Sprintf("room %s (cap %d) cannot hold section %s (%d students)",
							s.RoomID, room.Capacity, s.SectionID, sec.Strength), s, nil))
				}
			}
		}
	}

	// H11: locked slots must hold exactly their lesson.
	locked := p.lockedIndex()
	for _, l := range p.Locked {
		got, ok := byKey[cellKey(l.Day, l.Period, l.SectionID)]
		if !ok {
			vs = append(vs, p.violation("LOCKED_SLOT_MISSING",
				fmt.Sprintf("locked slot %s P%d (%s) is empty", l.Day, l.Period, l.SectionID), nil, nil))
			continue
		}
		if got.SubjectID != l.SubjectID {
			vs = append(vs, p.violation("LOCKED_SLOT_ALTERED",
				fmt.Sprintf("locked slot %s P%d (%s) holds %s, expected %s",
					l.Day, l.Period, l.SectionID, got.SubjectID, l.SubjectID), got, nil))
		}
		if l.TeacherID != "" && got.TeacherID != l.TeacherID {
			vs = append(vs, p.violation("LOCKED_SLOT_ALTERED",
				fmt.Sprintf("locked slot %s P%d (%s) is taken by %s, expected %s",
					l.Day, l.Period, l.SectionID, got.TeacherID, l.TeacherID), got, nil))
		}
	}
	_ = locked

	// Demand completeness: every required period must actually be scheduled.
	for _, r := range p.Requirements {
		n := 0
		for i := range slots {
			if slots[i].SectionID == r.SectionID && slots[i].SubjectID == r.SubjectID {
				n++
			}
		}
		if n != r.PeriodsPerWeek {
			vs = append(vs, p.violation("DEMAND_UNMET",
				fmt.Sprintf("subject %s in section %s scheduled %d/%d required periods",
					r.SubjectID, r.SectionID, n, r.PeriodsPerWeek), nil, nil))
		}
	}

	return vs
}

// ── helpers ──

func cellKey(day string, period int, section string) string {
	return fmt.Sprintf("%s|%d|%s", day, period, section)
}

func timeKey(day string, period int) string {
	return fmt.Sprintf("%s|%d", day, period)
}

func teacherOf(k string) string { return splitFirst(k) }
func sectionOf(k string) string { return splitFirst(k) }
func roomOf(k string) string    { return splitFirst(k) }

func splitFirst(k string) string {
	for i := 0; i < len(k); i++ {
		if k[i] == 0 {
			return k[:i]
		}
	}
	return k
}

func whenOf(k string) string {
	for i := 0; i < len(k); i++ {
		if k[i] == 0 {
			return k[i+1:]
		}
	}
	return k
}

func perDayFirst(lessons []*Slot, day string) *Slot {
	for _, l := range lessons {
		if l.Day == day {
			return l
		}
	}
	return nil
}

func perDayPeriod(lessons []*Slot, day string, period int) *Slot {
	for _, l := range lessons {
		if l.Day == day && l.Period == period {
			return l
		}
	}
	return nil
}

func (p *Problem) violation(rule, detail string, a, b *Slot) Violation {
	v := Violation{Rule: rule, Detail: detail}
	if a != nil {
		cp := *a
		v.SlotA = &cp
	}
	if b != nil {
		cp := *b
		v.SlotB = &cp
	}
	return v
}

// teacherUnavailable checks H4 against the teacher's unavailability list.
func (p *Problem) teacherUnavailable(t Teacher, day string, period int) bool {
	for _, u := range t.Unavailable {
		if u.Day != "" && u.Day != day {
			continue
		}
		if len(u.Periods) == 0 {
			return true // whole-day block
		}
		for _, pr := range u.Periods {
			if pr == period {
				return true
			}
		}
	}
	return false
}

func (p *Problem) effectiveDefaultMaxPerDay() int {
	if p.Options.DefaultMaxPerDay > 0 {
		return p.Options.DefaultMaxPerDay
	}
	return 6
}

// lockedIndex returns "day|period|section" → LockedSlot for quick checks.
func (p *Problem) lockedIndex() map[string]LockedSlot {
	m := map[string]LockedSlot{}
	for _, l := range p.Locked {
		m[cellKey(l.Day, l.Period, l.SectionID)] = l
	}
	return m
}

// CheckSlots is a convenience wrapper for external validation requests.
func CheckSlots(p *Problem, slots []Slot) []Violation {
	return p.CheckFull(slots)
}
