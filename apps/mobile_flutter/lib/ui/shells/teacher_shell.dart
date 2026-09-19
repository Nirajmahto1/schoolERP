// ──────────────────────────────────────────────
// Teacher shell — live dashboard, week timetable, leave apply with native
// date pickers, the HOD/Principal approvals inbox, and the student
// directory. Port of the RN teacher app.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';


import '../../core/api.dart';
import '../../core/auth_state.dart';
import '../../core/models.dart';
import '../../core/photo.dart';
import '../widgets/common.dart';

class TeacherShell extends StatefulWidget {
  const TeacherShell({super.key});

  @override
  State<TeacherShell> createState() => _TeacherShellState();
}

class _TeacherShellState extends State<TeacherShell> {
  int _tab = 0;
  bool _isApprover = false;
  // Punctuality report is a leadership view — principals and admins only.
  bool _isLeader = false;

  @override
  void initState() {
    super.initState();
    final auth = context.read<AuthState>();
    _isApprover = auth.roles.any((r) => ['HOD', 'PRINCIPAL', 'BRANCH_ADMIN', 'ACADEMIC_HEAD'].contains(r));
    _isLeader = auth.roles.any((r) => ['PRINCIPAL', 'SUPER_ADMIN', 'BRANCH_ADMIN', 'ACADEMIC_HEAD'].contains(r));
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      const TeacherHomeTab(),
      const TeacherTimetableTab(),
      const MyAttendanceTab(),
      const MyLeavesTab(),
      if (_isApprover) const ApprovalsTab(),
      if (_isLeader) const PunctualityTab(),
      const DirectoryTab(),
    ];
    return Scaffold(
      body: tabs[_tab],
      appBar: AppBar(
        title: Text(switch (_tab) { 0 => 'Home', 1 => 'My Timetable', 2 => 'My Attendance', 3 => 'My Leaves', 4 => 'Leave Approvals', 5 => 'Punctuality', _ => 'Students' }),
        leading: const AvatarAction(),
        actions: const [SchoolLogoAction(), LogoutAction()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab.clamp(0, tabs.length - 1),
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          const NavigationDestination(icon: Icon(Icons.calendar_view_week), label: 'Timetable'),
          const NavigationDestination(icon: Icon(Icons.fact_check_outlined), label: 'Attendance'),
          const NavigationDestination(icon: Icon(Icons.beach_access_outlined), label: 'Leaves'),
          if (_isApprover)
            const NavigationDestination(icon: Icon(Icons.approval_outlined), selectedIcon: Icon(Icons.approval), label: 'Approvals'),
          if (_isLeader)
            const NavigationDestination(icon: Icon(Icons.timer_outlined), selectedIcon: Icon(Icons.timer), label: 'Punctuality'),
          const NavigationDestination(icon: Icon(Icons.groups_outlined), label: 'Students'),
        ],
      ),
    );
  }
}

/// My month attendance — a calendar grid fed by
/// GET /attendance/staff/me?month=&year=. Tap the header to jump months.
class MyAttendanceTab extends StatefulWidget {
  const MyAttendanceTab({super.key});

  @override
  State<MyAttendanceTab> createState() => _MyAttendanceTabState();
}

class _MyAttendanceTabState extends State<MyAttendanceTab> {
  List<_AttendanceDay>? _days;
  String? _error;
  late int _month;
  late int _year;
  bool _marking = false;
  String? _markResult;

  static const _statusColor = {
    'PRESENT': Colors.green,
    'HALF_DAY': Colors.lightGreen,
    'LATE': Colors.orange,
    'ON_LEAVE': Colors.blue,
    'ABSENT': Colors.red,
    'MEDICAL': Colors.purple,
    'EXCUSED': Colors.grey,
  };

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _month = now.month;
    _year = now.year;
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final data = await ApiClient.instance
          .get('/attendance/staff/me?month=$_month&year=$_year');
      final rows = (data is Map ? data['days'] : null) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() {
        _days = rows
            .map((e) => _AttendanceDay.fromJson(Map<String, dynamic>.from(e)))
            .toList();
      });
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.detail);
    } catch (e) {
      if (mounted) setState(() => _error = 'Network error: $e');
    }
  }

  bool get _isCurrentMonth {
    final now = DateTime.now();
    return _month == now.month && _year == now.year;
  }

  _AttendanceDay? get _today {
    final now = DateTime.now();
    final key = now.toUtc().toIso8601String().substring(0, 10);
    for (final d in _days ?? []) {
      if (d.date == key) return d;
    }
    return null;
  }

  bool get _todayHasCheckIn => _today?.checkInAt != null;
  bool get _todayHasCheckout => _today?.checkOutAt != null;

  static String _fmtTime(DateTime? t) =>
      t == null ? '—' : '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  static String _fmtDuration(int minutes) {
    final h = minutes ~/ 60, m = minutes % 60;
    return h > 0 ? '${h}h ${m}m worked' : '${m}m worked';
  }

  /// GPS self-mark: locate → mock check → POST → refresh the calendar.
  /// The server decides whether this call is a check-in or a check-out (it
  /// looks at the day's row) and re-checks the fence with the server clock.
  Future<void> _selfMark() async {
    setState(() { _marking = true; _markResult = null; });
    try {
      LocationPermission perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        setState(() { _marking = false; _markResult = 'Location permission is required to mark attendance.'; });
        return;
      }
      if (!await Geolocator.isLocationServiceEnabled()) {
        setState(() { _marking = false; _markResult = 'Turn on location (GPS) and try again.'; });
        return;
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)),
      );
      final res = await ApiClient.instance.post('/attendance/staff/self-mark', body: {
        'latitude': pos.latitude,
        'longitude': pos.longitude,
        // geolocator flags emulator/fake-GPS positions; the server refuses
        // any mark that arrives with this flag.
        'mocked': pos.isMocked,
      });
      await _load();
      if (!mounted) return;
      final kind = res is Map ? res['kind']?.toString() : null;
      final lateBy = res is Map ? res['lateBy'] : null;
      setState(() {
        _marking = false;
        _markResult = kind == 'CHECKOUT'
            ? 'Checked out ✓ — time recorded from the server clock.'
            : lateBy is num && lateBy > 0
                ? 'Checked in ✓ — marked LATE by $lateBy min (cutoff set by your branch).'
                : 'Checked in ✓ — time recorded from the server clock. Remember to check out when you leave.';
      });
    } on ApiError catch (e) {
      setState(() { _marking = false; _markResult = e.detail; });
    } catch (e) {
      setState(() { _marking = false; _markResult = 'Could not mark: $e'; });
    }
  }

  Future<void> _pickMonth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(_year, _month, 1),
      firstDate: DateTime(now.year - 2),
      lastDate: DateTime(now.year + 1),
      helpText: 'Select month (pick any day)',
    );
    if (picked != null && (picked.month != _month || picked.year != _year)) {
      setState(() { _month = picked.month; _year = picked.year; });
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    final first = DateTime(_year, _month, 1);
    final lead = (first.weekday - DateTime.monday) % 7; // Monday-first grid
    final daysInMonth = DateTime(_year, _month + 1, 0).day;
    final byDay = {for (final d in _days ?? []) d.date.substring(8, 10): d};
    final tally = <String, int>{};
    for (final d in _days ?? []) { tally[d.status] = (tally[d.status] ?? 0) + 1; }
    // Late arrives as data: how many LATE days, how many minutes in total.
    final lateCount = tally['LATE'] ?? 0;
    final totalLateMinutes = (_days ?? []).fold<int>(0, (sum, d) => sum + (d.lateMinutes ?? 0));

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          // Self-mark today — GPS geofenced, server-timestamped. The button
          // mirrors the day's state: check in → check out → done (refused).
          if (_isCurrentMonth) ...[
            FilledButton.icon(
              onPressed: (_marking || _todayHasCheckout) ? null : _selfMark,
              icon: _marking
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : Icon(_todayHasCheckout ? Icons.task_alt : (_todayHasCheckIn ? Icons.logout : Icons.where_to_vote)),
              label: Text(
                _marking
                    ? 'Checking your location…'
                    : _todayHasCheckout
                        ? 'Attendance complete for today'
                        : _todayHasCheckIn
                            ? 'Mark my check-out'
                            : 'Mark my check-in',
              ),
            ),
            if (_today?.checkInAt != null || _today?.checkOutAt != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  'In ${_fmtTime(_today?.checkInAt)}'
                  '${_today?.checkOutAt != null ? '  ·  Out ${_fmtTime(_today?.checkOutAt)}' : ''}'
                  '${_today?.workedMinutes != null ? '  ·  ${_fmtDuration(_today!.workedMinutes!)}' : ''}',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
              ),
            if (_markResult != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(_markResult!, style: const TextStyle(fontSize: 12.5)),
              ),
            const SizedBox(height: 10),
          ],          // Month header — tap to change.
          Card(
            child: ListTile(
              leading: const Icon(Icons.calendar_month),
              title: Text('${monthNames[_month - 1]} $_year', style: const TextStyle(fontWeight: FontWeight.w700)),
              trailing: const Icon(Icons.expand_more),
              onTap: _pickMonth,
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 18),
              child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            )
          else if (_days == null)
            const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
          if (_days != null && _error == null) ...[
            const SizedBox(height: 10),
            // Weekday header.
            Row(children: ['M', 'T', 'W', 'T', 'F', 'S', 'S']
                .map((d) => Expanded(child: Center(child: Text(d, style: Theme.of(context).textTheme.labelSmall))))
                .toList()),
            const SizedBox(height: 6),
            // Calendar grid.
            ...List.generate((lead + daysInMonth + 6) ~/ 7, (week) => Row(
              children: List.generate(7, (dow) {
                final cell = week * 7 + dow - lead + 1;
                if (cell < 1 || cell > daysInMonth) return const Expanded(child: SizedBox(height: 40));
                final day = byDay[cell.toString().padLeft(2, '0')];
                final color = day == null ? null : _statusColor[day.status] ?? Colors.grey;
                return Expanded(
                  child: Container(
                    height: 44,
                    margin: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      color: color?.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(8),
                      border: color != null ? Border.all(color: color, width: 1.2) : null,
                    ),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text('$cell', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                      if (day != null) ...[
                        Text(switch (day.status) { 'PRESENT' => 'P', 'ABSENT' => 'A', 'ON_LEAVE' => 'L', 'LATE' => 'Late', 'HALF_DAY' => '½', _ => '·' },
                            style: TextStyle(fontSize: 9, color: color, fontWeight: FontWeight.w700)),
                        if (day.checkInAt != null)
                          Text('${_fmtTime(day.checkInAt)}${day.checkOutAt != null ? '–${_fmtTime(day.checkOutAt)}' : ''}',
                              style: TextStyle(fontSize: 7.5, color: color)),
                      ],
                    ]),
                  ),
                );
              }),
            )),
            const SizedBox(height: 14),
            // Legend + tally. LATE is always shown once the month has any
            // marks, with the summed minutes when there were any lates.
            Wrap(
              spacing: 14, runSpacing: 8,
              children: [
                ...tally.entries.map((e) => Row(mainAxisSize: MainAxisSize.min, children: [
                      CircleAvatar(radius: 6, backgroundColor: _statusColor[e.key] ?? Colors.grey),
                      const SizedBox(width: 5),
                      Text('${e.key == 'ON_LEAVE' ? 'LEAVE' : e.key} ${e.value}', style: const TextStyle(fontSize: 12)),
                    ])),
                if (tally.isNotEmpty && !tally.containsKey('LATE'))
                  Row(mainAxisSize: MainAxisSize.min, children: const [
                    CircleAvatar(radius: 6, backgroundColor: Colors.orange),
                    SizedBox(width: 5),
                    Text('LATE 0', style: TextStyle(fontSize: 12)),
                  ]),
                if (totalLateMinutes > 0)
                  Text('· late $totalLateMinutes min this month', style: TextStyle(fontSize: 12, color: Colors.orange.shade800, fontWeight: FontWeight.w600)),
              ],
            ),
            if (tally.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 14),
                child: Center(child: Text('No attendance marked this month', style: TextStyle(fontSize: 13))),
              ),
          ],
        ],
      ),
    );
  }
}

class _AttendanceDay {
  final String date;
  final String status;
  final String? remarks;
  final DateTime? checkInAt;
  final DateTime? checkOutAt;
  final int? workedMinutes;
  final int? lateMinutes;
  _AttendanceDay({required this.date, required this.status, this.remarks, this.checkInAt, this.checkOutAt, this.workedMinutes, this.lateMinutes});

  factory _AttendanceDay.fromJson(Map<String, dynamic> j) => _AttendanceDay(
        date: j['date']?.toString() ?? '',
        status: (j['status'] ?? '').toString(),
        remarks: j['remarks']?.toString(),
        checkInAt: j['checkInAt'] == null ? null : DateTime.tryParse(j['checkInAt'].toString())?.toLocal(),
        checkOutAt: j['checkOutAt'] == null ? null : DateTime.tryParse(j['checkOutAt'].toString())?.toLocal(),
        workedMinutes: j['workedMinutes'] == null ? null : int.tryParse(j['workedMinutes'].toString()),
        lateMinutes: j['lateMinutes'] == null ? null : int.tryParse(j['lateMinutes'].toString()),
      );
}

class TeacherHomeTab extends StatefulWidget {
  const TeacherHomeTab({super.key});

  @override
  State<TeacherHomeTab> createState() => _TeacherHomeTabState();
}

class _TeacherHomeTabState extends State<TeacherHomeTab> {
  Map<String, dynamic>? _dash;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final d = await ApiClient.instance.get('/teacher/dashboard');
      setState(() { _dash = d is Map ? Map<String, dynamic>.from(d) : {}; _error = null; });
    } on ApiError catch (e) { setState(() => _error = e.detail); }
    catch (_) { setState(() => _error = 'Network error'); }
  }

  @override
  Widget build(BuildContext context) {
    final d = _dash ?? const {};
    final next = d['nextClass'] is Map ? Map<String, dynamic>.from(d['nextClass'] as Map) : null;
    return RefreshIndicator(
      onRefresh: _load,
      child: Scaffold(
        
        body: _error != null
            ? Center(child: Text(_error!))
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Next class', style: Theme.of(context).textTheme.labelMedium),
                        const SizedBox(height: 6),
                        Text(
                          next != null
                              ? '${next['subject'] ?? '-'} · P${next['period'] ?? '?'} ${next['startTime'] ?? ''}'
                              : 'No more classes today',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ]),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(children: [
                    _Stat(label: 'Sections', value: (d['sectionCount'] ?? d['sections'] ?? '-').toString()),
                    _Stat(label: 'Students', value: (d['studentCount'] ?? d['students'] ?? '-').toString()),
                  ]),
                  Row(children: [
                    _Stat(label: 'Today slots', value: '${d['todaySlots'] ?? '-'}'),
                    _Stat(label: 'Marked', value: '${d['markedToday'] ?? '-'}'),
                  ]),
                ],
              ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Card(
        margin: const EdgeInsets.all(6),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: Theme.of(context).textTheme.labelSmall),
            const SizedBox(height: 4),
            Text(value, style: Theme.of(context).textTheme.titleMedium),
          ]),
        ),
      ),
    );
  }
}

class TeacherTimetableTab extends StatefulWidget {
  const TeacherTimetableTab({super.key});

  @override
  State<TeacherTimetableTab> createState() => _TeacherTimetableTabState();
}

class _TeacherTimetableTabState extends State<TeacherTimetableTab> {
  List<TimetableSlot>? _slots;
  String? _error;

  static const _days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final data = await ApiClient.instance.get('/teacher/timetable');
      // Wire shape: { days: [{ day: 'MONDAY', slots: [{ startTime, subject,
      // classSection, room }] }] } — flatten to a slot list. period is not in
      // the payload; derive it from the slot's order within its day.
      final days = (data is Map ? data['days'] : null) as List<dynamic>? ?? const [];
      final List<TimetableSlot> slots = [];
      for (final d in days) {
        final row = Map<String, dynamic>.from(d as Map);
        final day = (row['day'] ?? '').toString().toUpperCase();
        final short = day.substring(0, 3); // MONDAY → MON
        final daySlots = (row['slots'] as List<dynamic>? ?? const [])
            .asMap()
            .entries
            .map((e) => TimetableSlot.fromJson(Map<String, dynamic>.from(e.value as Map))
              ..day = short
              ..period = e.key + 1)
            .toList();
        slots.addAll(daySlots);
      }
      setState(() { _slots = slots; _error = null; });
    } on ApiError catch (e) { setState(() => _error = e.detail); }
    catch (_) { setState(() => _error = 'Network error'); }
  }

  @override
  Widget build(BuildContext context) {
    final today = DateFormat('EEE').format(DateTime.now()).toUpperCase().substring(0, 3);
    return Scaffold(
      
      body: _error != null
          ? Center(child: Text(_error!))
          : DefaultTabController(
              length: _days.length,
              initialIndex: _days.contains(today) ? _days.indexOf(today) : 0,
              child: Column(children: [
                TabBar(isScrollable: true, tabs: _days.map((d) => Tab(text: d)).toList()),
                Expanded(
                  child: TabBarView(
                    children: _days.map((d) {
                      final daySlots = (_slots ?? []).where((s) => s.day == d).toList()
                        ..sort((a, b) => a.period.compareTo(b.period));
                      if (daySlots.isEmpty) return const Center(child: Text('No classes'));
                      return ListView(
                        padding: const EdgeInsets.all(12),
                        children: daySlots.map((s) => Card(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          child: ListTile(
                            leading: CircleAvatar(child: Text('${s.period}')),
                            title: Text(s.subject ?? '-'),
                            subtitle: Text([s.className(), s.room].whereType<String>().join(' · ')),
                            trailing: Text(s.startTime ?? ''),
                          ),
                        )).toList(),
                      );
                    }).toList(),
                  ),
                ),
              ]),
            ),
    );
  }
}

extension on TimetableSlot {
  String? className() => null; // payload may carry class-section for teachers
}

class MyLeavesTab extends StatefulWidget {
  const MyLeavesTab({super.key});

  @override
  State<MyLeavesTab> createState() => _MyLeavesTabState();
}

class _MyLeavesTabState extends State<MyLeavesTab> {
  List<LeaveRequest>? _rows;
  String? _error;
  String _filter = 'ALL';

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.list('/teacher/leave-requests');
      if (!mounted) return;
      setState(() { _rows = rows.map((e) => LeaveRequest.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) { if (mounted) setState(() => _error = e.detail); }
    catch (e) { if (mounted) setState(() => _error = 'Network error: $e'); }
  }

  Future<void> _apply() async {
    final now = DateTime.now();
    DateTime? from = now;
    DateTime? to = now;
    String type = 'CASUAL';
    final reason = TextEditingController();

    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Apply for leave', style: Theme.of(ctx).textTheme.titleMedium),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: type,
                decoration: const InputDecoration(labelText: 'Leave type'),
                items: const [
                  DropdownMenuItem(value: 'CASUAL', child: Text('Casual Leave')),
                  DropdownMenuItem(value: 'SICK', child: Text('Sick Leave')),
                  DropdownMenuItem(value: 'EARNED', child: Text('Earned Leave')),
                  DropdownMenuItem(value: 'DUTY', child: Text('Duty Leave')),
                ],
                onChanged: (v) => setSheet(() => type = v ?? type),
              ),
              const SizedBox(height: 12),
              InkWell(
                onTap: () async {
                  final d = await showDatePicker(
                    context: ctx,
                    initialDate: from,
                    firstDate: DateTime(now.year, now.month, now.day),
                    lastDate: now.add(const Duration(days: 365)),
                  );
                  if (d != null) setSheet(() { from = d; if (to!.isBefore(from!)) to = d; });
                },
                child: InputDecorator(
                  decoration: const InputDecoration(labelText: 'From date', prefixIcon: Icon(Icons.event)),
                  child: Text(DateFormat('EEE, d MMM yyyy').format(from!)),
                ),
              ),
              const SizedBox(height: 12),
              InkWell(
                onTap: () async {
                  final d = await showDatePicker(
                    context: ctx,
                    initialDate: to,
                    firstDate: from!,
                    lastDate: now.add(const Duration(days: 365)),
                  );
                  if (d != null) setSheet(() => to = d);
                },
                child: InputDecorator(
                  decoration: const InputDecoration(labelText: 'To date', prefixIcon: Icon(Icons.event)),
                  child: Text(DateFormat('EEE, d MMM yyyy').format(to!)),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: reason,
                maxLines: 2,
                decoration: const InputDecoration(labelText: 'Reason'),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Submit'),
              ),
            ],
          ),
        ),
      ),
    );

    if (ok != true) return;
    try {
      await ApiClient.instance.post('/teacher/leave-requests', body: {
        'leaveType': type,
        'startDate': DateFormat('yyyy-MM-dd').format(from!),
        'endDate': DateFormat('yyyy-MM-dd').format(to!),
        'reason': reason.text,
      });
      await _load();
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = (_rows ?? []).where((r) => _filter == 'ALL' || r.status == _filter).toList();
    return Scaffold(
      floatingActionButton: FloatingActionButton(onPressed: _apply, child: const Icon(Icons.add)),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: SizedBox(
            height: 40,
            child: SegmentedButton<String>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact, textStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12))),
              segments: const [
                ButtonSegment(value: 'ALL', label: Text('All')),
                ButtonSegment(value: 'PENDING', label: Text('Pending')),
                ButtonSegment(value: 'APPROVED', label: Text('Approved')),
                ButtonSegment(value: 'REJECTED', label: Text('Rejected')),
              ],
              selected: {_filter},
              onSelectionChanged: (s) => setState(() => _filter = s.first),
            ),
          ),
        ),
        Expanded(
          child: _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: rows.isEmpty
                      ? ListView(children: const [SizedBox(height: 200), Center(child: Text('No leave requests'))])
                      : ListView(
                          padding: const EdgeInsets.all(12),
                          children: rows.map((r) => Card(
                            margin: const EdgeInsets.symmetric(vertical: 4),
                            child: ListTile(
                              title: Text('${r.typeLabel} · ${r.startDate} → ${r.endDate}'),
                              subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(r.reason, maxLines: 2, overflow: TextOverflow.ellipsis),
                                if (r.approvedBy != null)
                                  Text('${r.statusLabel} by ${r.approvedBy}${r.decisionNote != null ? ' — "${r.decisionNote}"' : ''}',
                                      style: Theme.of(context).textTheme.labelSmall),
                              ]),
                              trailing: StatusChip(
                                label: r.statusLabel,
                                color: switch (r.status) {
                                  'APPROVED' => Colors.green,
                                  'REJECTED' => Colors.red,
                                  _ => Colors.orange,
                                },
                              ),
                            ),
                          )).toList(),
                        ),
                ),
        ),
      ]),
    );
  }
}

class ApprovalsTab extends StatefulWidget {
  const ApprovalsTab({super.key});

  @override
  State<ApprovalsTab> createState() => _ApprovalsTabState();
}

class _ApprovalsTabState extends State<ApprovalsTab> {
  List<LeaveRequest>? _rows;
  String? _error;
  String _filter = 'PENDING';

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.list('/teacher/leave-approvals?status=$_filter');
      if (!mounted) return;
      setState(() { _rows = rows.map((e) => LeaveRequest.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) { if (mounted) setState(() => _error = e.detail); }
    catch (e) { if (mounted) setState(() => _error = 'Network error: $e'); }
  }

  Future<void> _decide(LeaveRequest r, String decision) async {
    final noteCtrl = TextEditingController();
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        // Keyboard insets + safe area so the buttons never clip off-screen.
        padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16),
        child: Wrap(
          children: [
            Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('$decision leave for ${r.teacherName}?', style: Theme.of(ctx).textTheme.titleMedium),
              const SizedBox(height: 12),
              TextField(controller: noteCtrl, decoration: const InputDecoration(labelText: 'Note (optional)')),
              const SizedBox(height: 16),
              SafeArea(
                child: Row(children: [
                  Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel'))),
                  const SizedBox(width: 12),
                  Expanded(child: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(decision))),
                ]),
              ),
            ]),
          ],
        ),
      ),
    );
    if (confirmed != true) return;
    try {
      await ApiClient.instance.post('/teacher/leave-requests/${r.id}/decision', body: {
        'decision': decision == 'Approve' ? 'APPROVED' : 'REJECTED',
        'note': noteCtrl.text,
      });
      await _load();
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: SizedBox(
            height: 40,
            child: SegmentedButton<String>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact, textStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12))),
              segments: const [
                ButtonSegment(value: 'PENDING', label: Text('Pending')),
                ButtonSegment(value: 'APPROVED', label: Text('Approved')),
                ButtonSegment(value: 'REJECTED', label: Text('Rejected')),
              ],
              selected: {_filter},
              onSelectionChanged: (s) { setState(() => _filter = s.first); _load(); },
            ),
          ),
        ),
        Expanded(
          child: _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: (_rows ?? []).isEmpty
                      ? ListView(children: const [SizedBox(height: 200), Center(child: Text('Nothing here'))])
                      : ListView(
                          padding: const EdgeInsets.all(12),
                          children: (_rows ?? []).map((r) => Card(
                            margin: const EdgeInsets.symmetric(vertical: 4),
                            child: ListTile(
                              title: Text('${r.teacherName} · ${r.typeLabel}'),
                              subtitle: Text('${r.department ?? '-'}\n${r.startDate} → ${r.endDate}\n${r.reason}'),
                              isThreeLine: true,
                              trailing: r.status == 'PENDING'
                                  ? Row(mainAxisSize: MainAxisSize.min, children: [
                                      IconButton(
                                        tooltip: 'Approve',
                                        onPressed: () => _decide(r, 'Approve'),
                                        icon: const Icon(Icons.check_circle, color: Colors.green),
                                      ),
                                      IconButton(
                                        tooltip: 'Reject',
                                        onPressed: () => _decide(r, 'Reject'),
                                        icon: const Icon(Icons.cancel, color: Colors.red),
                                      ),
                                    ])
                                  : StatusChip(label: r.statusLabel, color: r.status == 'APPROVED' ? Colors.green : Colors.red),
                            ),
                          )).toList(),
                        ),
                ),
        ),
      ]),
    );
  }
}

class DirectoryTab extends StatefulWidget {
  const DirectoryTab({super.key});

  @override
  State<DirectoryTab> createState() => _DirectoryTabState();
}

class _DirectoryTabState extends State<DirectoryTab> {
  List<StudentDirectory>? _rows;
  String? _error;
  final _search = TextEditingController();

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final q = _search.text.trim();
      final rows = await ApiClient.instance.list('/teacher/students?q=${Uri.encodeComponent(q)}');
      if (!mounted) return;
      setState(() { _rows = rows.map((e) => StudentDirectory.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) { if (mounted) setState(() => _error = e.detail); }
    catch (e) { if (mounted) setState(() => _error = 'Network error: $e'); }
  }

  @override
  void dispose() { _search.dispose(); super.dispose(); }

  /// Pick from gallery → upload → refresh the row (and the global photo
  /// cache so any other avatar showing this student updates too).
  Future<void> _uploadStudentPhoto(StudentDirectory s) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );
      if (picked == null || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Uploading photo for ${s.name}…')));
      final bytes = await picked.readAsBytes();
      final ext = picked.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      await ApiClient.instance.uploadFile(
        '/teacher/students/${s.id}/photo',
        field: 'photo',
        filename: 'photo.$ext',
        bytes: bytes,
      );
      AuthPhotoProvider.clearCache();
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text('Photo updated for ${s.name} ✓')));
      }
    } on ApiError catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.detail)));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Could not upload photo')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _search,
            decoration: InputDecoration(
              hintText: 'Search name or admission no',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: IconButton(icon: const Icon(Icons.arrow_forward), onPressed: _load),
            ),
            onSubmitted: (_) => _load(),
          ),
        ),
        Expanded(
          child: _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: (_rows ?? []).isEmpty
                      ? ListView(children: const [SizedBox(height: 200), Center(child: Text('No students found'))])
                      : ListView(
                          padding: const EdgeInsets.all(12),
                          children: (_rows ?? []).map((s) => Card(
                            margin: const EdgeInsets.symmetric(vertical: 4),
                            child: ListTile(
                              leading: GestureDetector(
                                onTap: () => _uploadStudentPhoto(s),
                                child: Stack(children: [
                                  s.photoUrl != null && s.photoUrl!.isNotEmpty
                                      ? CircleAvatar(radius: 22, backgroundImage: AuthPhotoProvider(s.photoUrl!))
                                      : CircleAvatar(radius: 22, child: Text(s.name.isNotEmpty ? s.name[0] : '?')),
                                  const Positioned(
                                    right: -2, bottom: -2,
                                    child: CircleAvatar(radius: 9, backgroundColor: Colors.blueGrey, child: Icon(Icons.camera_alt, size: 10, color: Colors.white)),
                                  ),
                                ]),
                              ),
                              title: Text(s.name),
                              subtitle: Text('${s.admissionNo} · ${s.className ?? '-'} ${s.section ?? ''}'),
                            ),
                          )).toList(),
                        ),
                ),
        ),
      ]),
    );
  }
}

// ── Branch punctuality report (principal / admin) ──
// GET /attendance/staff/punctuality?month=&year= — one card per staff
// member: present/late/absent counts, late minutes, average check-in and a
// punctuality rate. Sorted most-late first by the server; the principal
// reads the problem cases off the top.
class PunctualityTab extends StatefulWidget {
  const PunctualityTab({super.key});

  @override
  State<PunctualityTab> createState() => _PunctualityTabState();
}

class _PunctualityTabState extends State<PunctualityTab> {
  List<_PunctualityRow>? _rows;
  String? _error;
  late int _month;
  late int _year;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _month = now.month;
    _year = now.year;
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final data = await ApiClient.instance
          .get('/attendance/staff/punctuality?month=$_month&year=$_year');
      final rows = (data is Map ? data['staff'] : null) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() => _rows =
          rows.map((e) => _PunctualityRow.fromJson(Map<String, dynamic>.from(e))).toList());
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.detail);
    } catch (e) {
      if (mounted) setState(() => _error = 'Network error: $e');
    }
  }

  Future<void> _pickMonth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(_year, _month, 1),
      firstDate: DateTime(now.year - 2),
      lastDate: DateTime(now.year + 1),
      helpText: 'Select month (pick any day)',
    );
    if (picked != null && (picked.month != _month || picked.year != _year)) {
      setState(() { _month = picked.month; _year = picked.year; });
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        title: 'Punctuality — ${monthNames[_month - 1]} $_year',
        error: _error,
        empty: _rows != null && _rows!.isEmpty,
        emptyText: 'No active staff in this branch.',
        onRetry: _load,
        children: [
          // Month switcher.
          Card(
            margin: const EdgeInsets.fromLTRB(16, 8, 16, 6),
            child: ListTile(
              leading: const Icon(Icons.calendar_month),
              title: Text('${monthNames[_month - 1]} $_year', style: const TextStyle(fontWeight: FontWeight.w700)),
              trailing: const Icon(Icons.expand_more),
              onTap: _pickMonth,
            ),
          ),
          ...(_rows ?? []).map((r) => Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      r.photo != null && r.photo!.isNotEmpty
                          ? CircleAvatar(radius: 20, backgroundImage: AuthPhotoProvider(r.photo!))
                          : CircleAvatar(radius: 20, child: Text(r.name.isNotEmpty ? r.name[0] : '?')),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(r.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                          Text('${r.designation} · ${r.department} · ${r.employeeId}',
                              style: Theme.of(context).textTheme.bodySmall),
                        ]),
                      ),
                      // Punctuality rate badge; grey when nobody checked in.
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: r.punctualityRate == null
                              ? Colors.grey.shade300
                              : r.punctualityRate! >= 90
                                  ? Colors.green.shade100
                                  : r.punctualityRate! >= 70
                                      ? Colors.orange.shade100
                                      : Colors.red.shade100,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          r.punctualityRate == null ? '—' : '${r.punctualityRate}%',
                          style: TextStyle(fontWeight: FontWeight.w800, color: Colors.grey.shade900),
                        ),
                      ),
                    ]),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 12, runSpacing: 6,
                      children: [
                        _statChip('${r.present}', 'present', Colors.green),
                        _statChip('${r.lateCount}', 'late', Colors.orange),
                        if (r.totalLateMinutes > 0) _statChip('${r.totalLateMinutes}m', 'late total', Colors.deepOrange),
                        _statChip('${r.absent}', 'absent', Colors.red),
                        _statChip('${r.onLeave}', 'leave', Colors.blue),
                        if (r.avgCheckIn != null) _statChip(r.avgCheckIn!, 'avg check-in', Colors.blueGrey),
                      ],
                    ),
                  ]),
                ),
              )),
        ],
      ),
    );
  }

  static Widget _statChip(String value, String label, Color color) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircleAvatar(radius: 5, backgroundColor: color),
          const SizedBox(width: 5),
          Text('$value $label', style: const TextStyle(fontSize: 12)),
        ],
      );
}

class _PunctualityRow {
  final String staffId;
  final String name;
  final String employeeId;
  final String designation;
  final String department;
  final String? photo;
  final int markedDays;
  final int present;
  final int lateCount;
  final int totalLateMinutes;
  final int absent;
  final int onLeave;
  final int halfDays;
  final String? avgCheckIn;
  final int checkOutCount;
  final int? punctualityRate;

  _PunctualityRow({
    required this.staffId,
    required this.name,
    required this.employeeId,
    required this.designation,
    required this.department,
    this.photo,
    required this.markedDays,
    required this.present,
    required this.lateCount,
    required this.totalLateMinutes,
    required this.absent,
    required this.onLeave,
    required this.halfDays,
    this.avgCheckIn,
    required this.checkOutCount,
    this.punctualityRate,
  });

  factory _PunctualityRow.fromJson(Map<String, dynamic> j) {
    int n(Object? v) => v == null ? 0 : (v is num ? v.toInt() : int.tryParse(v.toString()) ?? 0);
    return _PunctualityRow(
      staffId: j['staffId']?.toString() ?? '',
      name: j['name']?.toString() ?? '',
      employeeId: j['employeeId']?.toString() ?? '',
      designation: j['designation']?.toString() ?? '',
      department: j['department']?.toString() ?? '',
      photo: j['photo']?.toString(),
      markedDays: n(j['markedDays']),
      present: n(j['present']),
      lateCount: n(j['lateCount']),
      totalLateMinutes: n(j['totalLateMinutes']),
      absent: n(j['absent']),
      onLeave: n(j['onLeave']),
      halfDays: n(j['halfDays']),
      avgCheckIn: j['avgCheckIn']?.toString(),
      checkOutCount: n(j['checkOutCount']),
      punctualityRate: j['punctualityRate'] == null ? null : n(j['punctualityRate']),
    );
  }
}
