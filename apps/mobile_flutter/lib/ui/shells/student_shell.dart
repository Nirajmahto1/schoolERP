// ──────────────────────────────────────────────
// Student shell — self dashboard, timetable, attendance, fees, and the
// class chat (same class+section only, server-enforced).
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'dart:async';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/sockets.dart';
import '../widgets/common.dart';
import 'parent_shell.dart' show FeesTab;

class StudentShell extends StatefulWidget {
  const StudentShell({super.key});

  @override
  State<StudentShell> createState() => _StudentShellState();
}

class _StudentShellState extends State<StudentShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final tabs = const [StudentHomeTab(), TimetableTab(), AttendanceTab(), ResultsTab(), ChatTab(), FeesTabStudent()];
    return Scaffold(
      body: tabs[_tab],
      appBar: AppBar(
        title: Text(switch (_tab) { 0 => 'Home', 1 => 'My Timetable', 2 => 'My Attendance', 3 => 'My Results', 4 => 'Class Chat', _ => 'My Fees' }),
        leading: const AvatarAction(),
        // The chat tab keeps its live status clean — no school mark there.
        actions: [if (_tab != 4) const SchoolLogoAction(), const LogoutAction()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.calendar_view_week), label: 'Timetable'),
          NavigationDestination(icon: Icon(Icons.fact_check_outlined), label: 'Attendance'),
          NavigationDestination(icon: Icon(Icons.workspace_premium_outlined), label: 'Results'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), label: 'Fees'),
        ],
      ),
    );
  }
}

class StudentHomeTab extends StatefulWidget {
  const StudentHomeTab({super.key});

  @override
  State<StudentHomeTab> createState() => _StudentHomeTabState();
}

class _StudentHomeTabState extends State<StudentHomeTab> {
  Map<String, dynamic>? _profile;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final p = await ApiClient.instance.object('/students/profile');
      setState(() { _profile = p; _error = null; });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) { setState(() => _error = 'Network error'); }
  }

  @override
  Widget build(BuildContext context) {
    final p = _profile ?? const {};
    final student = (p['student'] ?? p) as Map<String, dynamic>;
    return RefreshIndicator(
      onRefresh: _load,
      child: Scaffold(
        
        body: _error != null
            ? Center(child: Text(_error!))
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text('Hi, ${student['firstName'] ?? ''} 👋', style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 16),
                  Row(children: [
                    _Stat(label: 'Class', value: '${student['className'] ?? '-'} ${student['section'] ?? ''}'),
                    _Stat(label: 'Roll No', value: student['rollNo']?.toString() ?? '-'),
                  ]),
                  Row(children: [
                    _Stat(label: 'Admission No', value: student['admissionNo']?.toString() ?? '-'),
                    _Stat(label: 'House', value: student['house']?.toString() ?? '-'),
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
            Text(value, style: Theme.of(context).textTheme.titleMedium, overflow: TextOverflow.ellipsis),
          ]),
        ),
      ),
    );
  }
}

class TimetableTab extends StatefulWidget {
  const TimetableTab({super.key});

  @override
  State<TimetableTab> createState() => _TimetableTabState();
}

class _TimetableTabState extends State<TimetableTab> {
  List<TimetableSlot>? _slots;
  String? _error;

  static const _days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final data = await ApiClient.instance.get('/students/my-timetable');
      // Wire shape: { className, timetable: [{ time, mon, tue, wed, thu, fri }]
      // } — one row per time band, day columns hold the subject name ('-' when
      // free). Flatten into slots so the day tabs can filter.
      final rows = (data is Map ? data['timetable'] : null) as List<dynamic>? ?? const [];
      const dayKeys = {'MON': 'mon', 'TUE': 'tue', 'WED': 'wed', 'THU': 'thu', 'FRI': 'fri', 'SAT': 'sat'};
      final List<TimetableSlot> slots = [];
      for (final r in rows) {
        final row = Map<String, dynamic>.from(r as Map);
        final time = (row['time'] ?? '').toString();
        final parts = time.split('-');
        final start = parts.isNotEmpty ? parts[0].trim() : '';
        final end = parts.length > 1 ? parts[1].trim() : '';
        dayKeys.forEach((day, key) {
          final subject = row[key]?.toString();
          if (subject != null && subject.isNotEmpty && subject != '-') {
            slots.add(TimetableSlot(day: day, period: 0, subject: subject, startTime: start, endTime: end));
          }
        });
      }
      if (!mounted) return;
      setState(() { _slots = slots; _error = null; });
    } on ApiError catch (e) { if (mounted) setState(() => _error = e.detail); }
    catch (e) { if (mounted) setState(() => _error = 'Network error: $e'); }
  }

  @override
  Widget build(BuildContext context) {
    final today = DateFormat('EEE').format(DateTime.now()).toUpperCase().substring(0, 3);
    final initialDay = _days.contains(today) ? today : 'MON';
    return Scaffold(
      
      body: _error != null
          ? Center(child: Text(_error!))
          : DefaultTabController(
              length: _days.length,
              initialIndex: _days.indexOf(initialDay).clamp(0, 5),
              child: Column(children: [
                TabBar(
                  isScrollable: true,
                  tabs: _days.map((d) => Tab(text: d)).toList(),
                ),
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
                            title: Text(s.subject ?? '-'),
                            subtitle: Text([s.teacher, s.room].whereType<String>().where((t) => t.isNotEmpty && t != 'null').join(' · ')),
                            trailing: Text('${s.startTime ?? ''}${s.endTime != null && s.endTime!.isNotEmpty ? '–${s.endTime}' : ''}', style: Theme.of(context).textTheme.labelSmall),
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

class AttendanceTab extends StatefulWidget {
  const AttendanceTab({super.key});

  @override
  State<AttendanceTab> createState() => _AttendanceTabState();
}

class _AttendanceTabState extends State<AttendanceTab> {
  dynamic _data;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final d = await ApiClient.instance.get('/students/my-attendance');
      setState(() { _data = d; _error = null; });
    } on ApiError catch (e) { setState(() => _error = e.detail); }
    catch (_) { setState(() => _error = 'Network error'); }
  }

  @override
  Widget build(BuildContext context) {
    final map = _data is Map ? Map<String, dynamic>.from(_data as Map) : <String, dynamic>{};
    final pct = (map['attendancePct'] ?? map['attendancePercent'] ?? map['percent'])?.toString() ?? '—';
    return Scaffold(
      
      body: _error != null
          ? Center(child: Text(_error!))
          : ListView(padding: const EdgeInsets.all(16), children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(children: [
                    Text('$pct%', style: Theme.of(context).textTheme.displaySmall),
                    const SizedBox(height: 4),
                    const Text('attendance this year'),
                  ]),
                ),
              ),
              ...((map['monthly'] ?? map['summaries'] ?? []) as List).map((m) {
                final row = Map<String, dynamic>.from(m as Map);
                return ListTile(
                  title: Text('${row['month']}/${row['year']}'),
                  trailing: Text('${row['presentDays'] ?? 0}/${row['workingDays'] ?? 0} days'),
                );
              }),
            ]),
    );
  }
}

class ChatTab extends StatefulWidget {
  const ChatTab({super.key});

  @override
  State<ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends State<ChatTab> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  final List<ChatMessage> _messages = [];
  StreamSubscription? _sub;
  bool _live = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    ChatSocket.instance.connectAndListen();
    _sub = ChatSocket.instance.messages.listen(_onIncoming);
    ChatSocket.instance.live.listen((l) => mounted ? setState(() => _live = l) : null);
  }

  void _onIncoming(ChatMessage m) {
    if (!mounted) return;
    setState(() {
      if (!_messages.any((x) => x.id == m.id)) _messages.add(m);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.list('/communication/chat/messages?limit=50');
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(rows.map((e) => ChatMessage.fromJson(Map<String, dynamic>.from(e))));
        _error = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    } on ApiError catch (e) { setState(() => _error = e.detail); }
    catch (_) { setState(() => _error = 'Network error'); }
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    try {
      await ApiClient.instance.post('/communication/chat/messages', body: {'body': text});
      await _load();
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _error != null
          ? Center(child: Text(_error!))
          : Column(children: [
              if (!_live)
                Material(color: Colors.orange.shade100, child: const Padding(padding: EdgeInsets.symmetric(vertical: 4), child: Center(child: Text('offline — messages may be delayed', style: TextStyle(fontSize: 12))))),
              Expanded(
                child: ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(12),
                  itemCount: _messages.length,
                  itemBuilder: (_, i) {
                    final m = _messages[i];
                    return ListTile(
                      dense: true,
                      title: Text(m.authorName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                      subtitle: Text(m.body),
                      trailing: Text(DateFormat('HH:mm').format(m.createdAt), style: Theme.of(context).textTheme.labelSmall),
                    );
                  },
                ),
              ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
                  child: Row(children: [
                    Expanded(
                      child: TextField(
                        controller: _controller,
                        decoration: const InputDecoration(hintText: 'Message your class…', isDense: true),
                        onSubmitted: (_) => _send(),
                      ),
                    ),
                    IconButton.filled(onPressed: _send, icon: const Icon(Icons.send)),
                  ]),
                ),
              ),
            ]),
    );
  }
}

// FeesTab comes from parent_shell.dart — the same /students/my-fees
// contract, self-resolved for the student.
class FeesTabStudent extends StatelessWidget {
  const FeesTabStudent({super.key});

  @override
  Widget build(BuildContext context) => const FeesTab();
}

// ── My Results ──
// Published exams only (the server filters — nothing unpublished exists
// here). Tap an exam for the full report card: subject marks, grades and
// the overall percentage/grade.
class ResultsTab extends StatefulWidget {
  const ResultsTab({super.key});

  @override
  State<ResultsTab> createState() => _ResultsTabState();
}

class _ResultsTabState extends State<ResultsTab> {
  List<Map<String, dynamic>>? _exams;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final data = await ApiClient.instance.get('/exams/my-results');
      final rows = (data is Map ? data['data'] : null) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() => _exams = rows.map((e) => Map<String, dynamic>.from(e)).toList());
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.detail);
    } catch (e) {
      if (mounted) setState(() => _error = 'Network error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        title: 'My Results',
        error: _error,
        empty: _exams != null && _exams!.isEmpty,
        emptyText: 'No published results yet — they appear here the moment an exam is published.',
        onRetry: _load,
        children: (_exams ?? []).map((e) => Card(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: ListTile(
            leading: const Icon(Icons.workspace_premium_outlined),
            title: Text(e['name']?.toString() ?? 'Examination', style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text(e['publishedAt'] != null
                ? 'Published ${DateFormat('d MMM yyyy').format(DateTime.parse(e['publishedAt'].toString()).toLocal())}'
                : ''),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _openReportCard(e),
          ),
        )).toList(),
      ),
    );
  }

  Future<void> _openReportCard(Map<String, dynamic> exam) async {
    setState(() => _error = null);
    try {
      // The student's own id comes from the same children-summary the home
      // tab uses — self-resolution returns exactly one row.
      final me = await ApiClient.instance.get('/parents/me/children-summary');
      final students = (me is Map ? me['students'] : null) as List<dynamic>? ?? const [];
      if (students.isEmpty) throw ApiError(404, 'No student record linked to this account.');
      final studentId = Map<String, dynamic>.from(students.first)['id'].toString();
      if (!mounted) return;
      final card = await ApiClient.instance.get('/exams/report-card/${exam['examinationId']}/$studentId');
      final payload = Map<String, dynamic>.from((card as Map)['data'] as Map);
      if (!mounted) return;
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => _ReportCardSheet(data: payload),
      );
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.detail);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load report card: $e');
    }
  }
}

class _ReportCardSheet extends StatelessWidget {
  const _ReportCardSheet({required this.data});

  final Map<String, dynamic> data;

  @override
  Widget build(BuildContext context) {
    final exam = Map<String, dynamic>.from(data['examination'] as Map);
    final student = Map<String, dynamic>.from(data['student'] as Map);
    final subjects = ((data['subjects'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e)).toList();
    final total = Map<String, dynamic>.from((data['total'] as Map?) ?? const {});

    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        builder: (ctx, scroll) => Container(
          padding: const EdgeInsets.all(18),
          child: ListView(
            controller: scroll,
            children: [
              Text(exam['name']?.toString() ?? 'Report Card', style: Theme.of(ctx).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text('${student['name']} · ${student['class'] ?? '-'} ${student['section'] ?? ''} · ${student['admissionNo']}', style: Theme.of(ctx).textTheme.bodySmall),
              const Divider(height: 22),
              // Subject rows.
              Table(
                columnWidths: const {0: FlexColumnWidth(4), 1: FlexColumnWidth(2), 2: FlexColumnWidth(1.4), 3: FlexColumnWidth(1.4)},
                border: TableBorder(horizontalInside: BorderSide(color: Theme.of(ctx).dividerColor.withValues(alpha: 0.4))),
                children: [
                  TableRow(decoration: BoxDecoration(color: Theme.of(ctx).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5)), children: [
                    Padding(padding: const EdgeInsets.all(6), child: Text('Subject', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12))),
                    Padding(padding: const EdgeInsets.all(6), child: Text('Marks', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12))),
                    Padding(padding: const EdgeInsets.all(6), child: Text('%', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12))),
                    Padding(padding: const EdgeInsets.all(6), child: Text('Grade', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12))),
                  ]),
                  ...subjects.map((s) => TableRow(children: [
                    Padding(padding: const EdgeInsets.all(6), child: Text(s['subject']?.toString() ?? '', style: const TextStyle(fontSize: 13))),
                    Padding(padding: const EdgeInsets.all(6), child: Text(s['isAbsent'] == true ? 'AB' : '${s['marksObtained'] ?? '—'} / ${s['maxMarks']}', style: const TextStyle(fontSize: 13))),
                    Padding(padding: const EdgeInsets.all(6), child: Text(s['percent']?.toString() ?? '—', style: const TextStyle(fontSize: 13))),
                    Padding(padding: const EdgeInsets.all(6), child: Text(s['grade']?.toString() ?? '—', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700))),
                  ])),
                ],
              ),
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Theme.of(ctx).colorScheme.primaryContainer.withValues(alpha: 0.35),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                  Column(children: [Text('${total['marks'] ?? 0} / ${total['maxMarks'] ?? 0}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)), const Text('Total', style: TextStyle(fontSize: 11))]),
                  Column(children: [Text('${total['percent'] ?? '—'}%', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)), const Text('Percentage', style: TextStyle(fontSize: 11))]),
                  Column(children: [Text('${total['grade'] ?? '—'}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)), const Text('Grade', style: TextStyle(fontSize: 11))]),
                ]),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }
}
