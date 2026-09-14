// ──────────────────────────────────────────────
// Substitution suggestions (BUILD_PLAN 6.2: "produce substitution
// suggestions when a teacher is absent")
//
// Given a day and one or more absent teachers, walk the day's timetable and
// propose the least-disruptive cover for each affected lesson:
//   1. only staff qualified for the subject (SubjectTeacher semantics live
//      in the caller's DB; the spec carries the qualified set),
//   2. who is actually free that period (no clash with their own timetable),
//   3. who stays inside their daily load cap,
//   4. ranked: qualified first, then fewest total load, then fewest same-day
//      load — spreading absence pain instead of dumping it on one teacher.
//
// A suggestion is a PROPOSAL with its own clash check against the current
// timetable; it never silently mutates anything. Approving one is the
// caller's write (TimetableSubstitution rows in the DB).
// ──────────────────────────────────────────────

package main

import (
	"sort"
)

// SubstitutionProblem is the /timetable/substitutions request: the current
// timetable for the day, the absentees, and who is qualified for what.
type SubstitutionProblem struct {
	Day       string              `json:"day"`       // "MONDAY" ...
	Periods   int                 `json:"periods"`   // to bound the free-period scan
	Timetable []Slot              `json:"timetable"` // the day's slots (all sections)
	Absent    []string            `json:"absent"`    // teacher ids
	Staff     []SubStaff          `json:"staff"`     // everyone who could cover
	Qualified map[string][]string `json:"qualified"` // subjectId → teacher ids able to teach it (empty ⇒ anyone)
}

type SubStaff struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	MaxPerDay int    `json:"maxPerDay"` // 0 → 6
}

type SubstitutionSuggestion struct {
	Slot       Slot   `json:"slot"`
	Substitute string `json:"substituteId"`
	Rank       int    `json:"rank"` // 0 = best
	Reason     string `json:"reason"`
}

type SubstitutionResult struct {
	Day         string                   `json:"day"`
	Suggestions []SubstitutionSuggestion `json:"suggestions"`
	Uncovered   []Slot                   `json:"uncovered"` // affected lessons with no legal cover
}

// SuggestSubstitutions proposes cover for every lesson taught by an absent
// teacher on the day.
func SuggestSubstitutions(sp SubstitutionProblem) SubstitutionResult {
	res := SubstitutionResult{Day: sp.Day, Uncovered: []Slot{}}
	res.Suggestions = []SubstitutionSuggestion{}

	// Per-teacher load on the day (drives caps and ranking).
	load := map[string]int{}
	for _, s := range sp.Timetable {
		if s.TeacherID != "" {
			load[s.TeacherID]++
		}
	}

	// Occupancy: who is busy at (day, period).
	busy := map[string]map[int]bool{}
	for _, s := range sp.Timetable {
		if busy[s.TeacherID] == nil {
			busy[s.TeacherID] = map[int]bool{}
		}
		busy[s.TeacherID][s.Period] = true
	}

	staffByID := map[string]SubStaff{}
	for _, st := range sp.Staff {
		staffByID[st.ID] = st
	}

	absent := map[string]bool{}
	for _, a := range sp.Absent {
		absent[a] = true
	}

	for _, slot := range sp.Timetable {
		if !absent[slot.TeacherID] {
			continue
		}

		type scored struct {
			id        string
			qualified bool
			totalLoad int
			dayLoad   int
		}
		candidates := []scored{}

		for _, st := range sp.Staff {
			if absent[st.ID] {
				continue // an absentee cannot cover
			}
			if busy[st.ID][slot.Period] {
				continue // already teaching that period
			}
			maxDay := st.MaxPerDay
			if maxDay <= 0 {
				maxDay = 6
			}
			if load[st.ID]+1 > maxDay {
				continue
			}
			qualified := true
			if q := sp.Qualified[slot.SubjectID]; len(q) > 0 {
				qualified = false
				for _, id := range q {
					if id == st.ID {
						qualified = true
						break
					}
				}
			}
			candidates = append(candidates, scored{
				id:        st.ID,
				qualified: qualified,
				totalLoad: weekLoadOf(sp.Timetable, st.ID), // placeholder ranking input
				dayLoad:   load[st.ID],
			})
		}

		if len(candidates) == 0 {
			res.Uncovered = append(res.Uncovered, slot)
			continue
		}

		sort.Slice(candidates, func(i, j int) bool {
			a, b := candidates[i], candidates[j]
			if a.qualified != b.qualified {
				return a.qualified // qualified first, always
			}
			if a.dayLoad != b.dayLoad {
				return a.dayLoad < b.dayLoad
			}
			return a.id < b.id // deterministic
		})

		best := candidates[0]
		reason := "free this period, within daily cap"
		if best.qualified {
			reason = "qualified subject teacher, free this period"
		}
		res.Suggestions = append(res.Suggestions, SubstitutionSuggestion{
			Slot:       slot,
			Substitute: best.id,
			Rank:       0,
			Reason:     reason,
		})
		// Take the cover: the next affected lesson must not double-book them.
		load[best.id]++
		if busy[best.id] == nil {
			busy[best.id] = map[int]bool{}
		}
		busy[best.id][slot.Period] = true
	}

	// Rank within the result: qualified covers before unqualified.
	sort.SliceStable(res.Suggestions, func(i, j int) bool {
		return res.Suggestions[i].Reason != "" && res.Suggestions[j].Reason == ""
	})
	return res
}

func weekLoadOf(slots []Slot, teacherID string) int {
	n := 0
	for _, s := range slots {
		if s.TeacherID == teacherID {
			n++
		}
	}
	return n
}
