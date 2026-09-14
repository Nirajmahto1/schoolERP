// ──────────────────────────────────────────────
// Timetable problem model (BUILD_PLAN Phase 6.2)
//
// The academic service (or a school admin via the gateway) posts a complete
// problem spec: the period grid, teachers with unavailability and load caps,
// sections, rooms, subject demands per section with the assigned teacher,
// and locked slots to preserve. The engine returns either a full timetable
// with ZERO hard-constraint violations (GATE 6) or an explicit failure —
// never a timetable that "mostly works".
//
// Everything is plain JSON over the internal API; the engine holds no
// database connection, which keeps it stateless and horizontally scalable.
// ──────────────────────────────────────────────

package main

import "fmt"

// Problem is the input spec. All ids are opaque strings (database ids).
type Problem struct {
	Days         []string       `json:"days"`        // e.g. ["MONDAY",...]; weekend days simply omitted
	Periods      int            `json:"periods"`     // periods per day (the grid is rectangular)
	PeriodTimes  []PeriodTime   `json:"periodTimes"` // optional; index i ↔ period i+1
	Teachers     []Teacher      `json:"teachers"`
	Sections     []Section      `json:"sections"`
	Rooms        []Room         `json:"rooms"` // may be empty → rooms unmanaged
	Requirements []Requirement  `json:"requirements"`
	Locked       []LockedSlot   `json:"locked"`
	Seed         int64          `json:"seed"` // deterministic solves for tests/replays
	Options      GenerationOpts `json:"options"`
}

type PeriodTime struct {
	Start string `json:"start"` // "08:00"
	End   string `json:"end"`   // "08:45"
}

type Teacher struct {
	ID             string        `json:"id"`
	Name           string        `json:"name,omitempty"`
	MaxPerDay      int           `json:"maxPerDay"`      // 0 → default (6)
	MaxPerWeek     int           `json:"maxPerWeek"`     // 0 → unlimited beyond demand
	Unavailable    []Unavailable `json:"unavailable"`    // whole-day or specific periods
	NotConsecutive bool          `json:"notConsecutive"` // no back-to-back periods (the plan's "no back-to-back clashes")
}

type Unavailable struct {
	Day     string `json:"day"`     // "MONDAY" or "" for all days
	Periods []int  `json:"periods"` // empty → whole day
}

type Section struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Grade    string `json:"grade,omitempty"`
	Strength int    `json:"strength"` // students; drives room capacity checks
}

type Room struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Capacity int    `json:"capacity"` // 0 → treated as unlimited
	Kind     string `json:"kind"`     // "" | "LAB" | "LIBRARY" | "GAMES" | ...
}

type Requirement struct {
	// One subject taught to one section by one teacher.
	SubjectID      string `json:"subjectId"`
	SubjectName    string `json:"subjectName,omitempty"`
	SectionID      string `json:"sectionId"`
	TeacherID      string `json:"teacherId"`
	PeriodsPerWeek int    `json:"periodsPerWeek"`
	MaxPerDay      int    `json:"maxPerDay"`    // 0 → 1 (a subject meets at most once a day)
	AllowDoubles   bool   `json:"allowDoubles"` // labs/games may run in consecutive periods
	// Room needs: kind must match, capacity must fit the section strength.
	RoomKind string `json:"roomKind"` // "" → any room
}

type LockedSlot struct {
	Day       string `json:"day"`
	Period    int    `json:"period"` // 1-based
	SectionID string `json:"sectionId"`
	SubjectID string `json:"subjectId"`
	TeacherID string `json:"teacherId,omitempty"`
	RoomID    string `json:"roomId,omitempty"`
}

type GenerationOpts struct {
	MaxRestarts      int `json:"maxRestarts"`             // default 12
	DefaultMaxPerDay int `json:"defaultTeacherMaxPerDay"` // default 6
}

// ── Output ──

type Slot struct {
	Day       string `json:"day"`
	Period    int    `json:"period"`
	SectionID string `json:"sectionId"`
	SubjectID string `json:"subjectId"`
	TeacherID string `json:"teacherId"`
	RoomID    string `json:"roomId,omitempty"`
	Locked    bool   `json:"locked,omitempty"`
}

type Violation struct {
	// Which hard constraint failed and where. `slotA`/`slotB` name the two
	// conflicting placements so the UI can highlight both cells.
	Rule   string `json:"rule"`
	Detail string `json:"detail"`
	SlotA  *Slot  `json:"slotA,omitempty"`
	SlotB  *Slot  `json:"slotB,omitempty"`
}

type GenerationResult struct {
	Status     string      `json:"status"` // "solved" | "infeasible"
	Slots      []Slot      `json:"slots,omitempty"`
	Violations []Violation `json:"violations,omitempty"` // infeasible: where the walls are
	Stats      SolveStats  `json:"stats"`
}

type SolveStats struct {
	Attempts      int   `json:"attempts"`
	NodesExplored int64 `json:"nodesExplored"`
	ElapsedMs     int64 `json:"elapsedMs"`
	Placements    int   `json:"placements"`
}

// ── validation of the spec itself ──

func (p *Problem) validate() error {
	if len(p.Days) == 0 {
		return fmt.Errorf("days must not be empty")
	}
	daySet := map[string]bool{}
	for _, d := range p.Days {
		if d == "" {
			return fmt.Errorf("day names must not be empty")
		}
		if daySet[d] {
			return fmt.Errorf("duplicate day %q", d)
		}
		daySet[d] = true
	}
	if p.Periods < 1 || p.Periods > 12 {
		return fmt.Errorf("periods must be between 1 and 12, got %d", p.Periods)
	}
	teachers := map[string]bool{}
	for _, t := range p.Teachers {
		if t.ID == "" {
			return fmt.Errorf("teacher id must not be empty")
		}
		if teachers[t.ID] {
			return fmt.Errorf("duplicate teacher %q", t.ID)
		}
		teachers[t.ID] = true
	}
	sections := map[string]bool{}
	for _, s := range p.Sections {
		if s.ID == "" {
			return fmt.Errorf("section id must not be empty")
		}
		if sections[s.ID] {
			return fmt.Errorf("duplicate section %q", s.ID)
		}
		sections[s.ID] = true
	}
	rooms := map[string]bool{}
	for _, r := range p.Rooms {
		if r.ID == "" {
			return fmt.Errorf("room id must not be empty")
		}
		if rooms[r.ID] {
			return fmt.Errorf("duplicate room %q", r.ID)
		}
		rooms[r.ID] = true
	}
	reqs := map[string]bool{}
	for _, r := range p.Requirements {
		key := r.SubjectID + "/" + r.SectionID
		if reqs[key] {
			return fmt.Errorf("duplicate requirement for subject %q in section %q", r.SubjectID, r.SectionID)
		}
		reqs[key] = true
		if r.PeriodsPerWeek < 1 {
			return fmt.Errorf("subject %q in section %q needs periodsPerWeek >= 1", r.SubjectID, r.SectionID)
		}
		if r.SectionID == "" || r.SubjectID == "" || r.TeacherID == "" {
			return fmt.Errorf("requirement missing subjectId/sectionId/teacherId")
		}
		if !teachers[r.TeacherID] {
			return fmt.Errorf("requirement references unknown teacher %q", r.TeacherID)
		}
		if !sections[r.SectionID] {
			return fmt.Errorf("requirement references unknown section %q", r.SectionID)
		}
		if r.PeriodsPerWeek > len(p.Days)*p.Periods {
			return fmt.Errorf("subject %q in section %q demands more periods than the grid has", r.SubjectID, r.SectionID)
		}
		if r.RoomKind != "" && len(p.Rooms) > 0 {
			any := false
			for _, rm := range p.Rooms {
				if rm.Kind == r.RoomKind {
					any = true
					break
				}
			}
			if !any {
				return fmt.Errorf("no room of kind %q exists for subject %q", r.RoomKind, r.SubjectID)
			}
		}
	}
	for _, l := range p.Locked {
		if !daySet[l.Day] {
			return fmt.Errorf("locked slot on unknown day %q", l.Day)
		}
		if l.Period < 1 || l.Period > p.Periods {
			return fmt.Errorf("locked slot period %d out of range", l.Period)
		}
		if !sections[l.SectionID] {
			return fmt.Errorf("locked slot references unknown section %q", l.SectionID)
		}
	}
	return nil
}
