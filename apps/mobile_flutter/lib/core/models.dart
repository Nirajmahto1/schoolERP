// ──────────────────────────────────────────────
// Models — the typed shapes the Flutter app consumes. Deliberately loose:
// the gateway payloads evolve fast, so every field is nullable and the
// screens defend with fallbacks, exactly like the RN app did.
// ──────────────────────────────────────────────

class Session {
  final String accessToken;
  final String? refreshToken;
  final Map<String, dynamic> raw;

  Session({required this.accessToken, this.refreshToken, required this.raw});

  factory Session.fromJson(Map<String, dynamic> j) => Session(
        accessToken: j['accessToken'] as String? ?? '',
        refreshToken: j['refreshToken'] as String?,
        raw: j,
      );

  List<String> get roles =>
      (raw['roles'] as List<dynamic>?)?.map((e) => e.toString()).toList() ?? const [];

  String? get branchId => raw['branchId'] as String?;
}

class Child {
  final String id;
  final String name;
  final String admissionNo;
  final String? className;
  final String? section;
  final String? rollNo;
  final String? photo;
  final double attendancePct;
  final double dueAmount;

  Child({
    required this.id,
    required this.name,
    required this.admissionNo,
    this.className,
    this.section,
    this.rollNo,
    this.photo,
    this.attendancePct = 0,
    this.dueAmount = 0,
  });

  factory Child.fromJson(Map<String, dynamic> j) {
    double num2(Object? v) => v == null ? 0 : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0);
    return Child(
      id: j['id']?.toString() ?? '',
      name: (j['name'] ?? '${j['firstName'] ?? ''} ${j['lastName'] ?? ''}').toString().trim(),
      admissionNo: j['admissionNo']?.toString() ?? '',
      className: j['className']?.toString() ?? j['class']?['name']?.toString(),
      section: j['section']?.toString() ?? j['section']?['name']?.toString(),
      rollNo: j['rollNo']?.toString(),
      photo: (j['photoUrl'] ?? j['photo'])?.toString(),
      attendancePct: num2(j['attendancePct'] ?? j['attendancePercent']),
      dueAmount: num2(j['dueAmount'] ?? j['dues']),
    );
  }
}

class FeeItem {
  final String id;
  final String invoiceNo;
  final String title;
  final double amount;
  final double paid;
  final double due;
  final DateTime? dueDate;
  final String status;

  FeeItem({
    required this.id,
    required this.invoiceNo,
    required this.title,
    required this.amount,
    required this.paid,
    required this.due,
    this.dueDate,
    required this.status,
  });

  factory FeeItem.fromJson(Map<String, dynamic> j) {
    double num2(Object? v) => v == null ? 0 : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0);
    return FeeItem(
      id: j['id']?.toString() ?? '',
      invoiceNo: j['invoiceNo']?.toString() ?? '',
      // The wire sends the fee head as `type` (children-summary) — map it
      // through, or every card degrades to a generic "Fee" title.
      title: j['title']?.toString() ?? j['type']?.toString() ?? j['description']?.toString() ?? 'Fee',
      amount: num2(j['totalAmount'] ?? j['amount']),
      paid: num2(j['paidAmount'] ?? j['paid']),
      due: num2(j['dueAmount'] ?? j['due'] ?? ((num2(j['totalAmount'] ?? j['amount'])) - num2(j['paidAmount'] ?? j['paid']))),
      dueDate: j['dueDate'] == null ? null : DateTime.tryParse(j['dueDate'].toString()),
      status: j['status']?.toString() ?? 'UNKNOWN',
    );
  }
}

class TimetableSlot {
  String day; // MON..SAT
  int period;
  final String? subject;
  final String? teacher;
  final String? room;
  final String? startTime;
  final String? endTime;

  TimetableSlot({
    required this.day,
    required this.period,
    this.subject,
    this.teacher,
    this.room,
    this.startTime,
    this.endTime,
  });

  factory TimetableSlot.fromJson(Map<String, dynamic> j) => TimetableSlot(
        day: (j['day'] ?? j['dayOfWeek'] ?? '').toString().toUpperCase(),
        period: (j['period'] as num?)?.toInt() ?? 0,
        subject: j['subject']?.toString() ?? j['subjectName']?.toString(),
        teacher: j['teacher']?.toString() ?? j['teacherName']?.toString() ?? j['classSection']?.toString(),
        room: j['room']?.toString(),
        startTime: j['startTime']?.toString(),
        endTime: j['endTime']?.toString(),
      );
}

class ChatMessage {
  final String id;
  final String authorId;
  final String authorName;
  final String body;
  final DateTime createdAt;

  ChatMessage({
    required this.id,
    required this.authorId,
    required this.authorName,
    required this.body,
    required this.createdAt,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id']?.toString() ?? '',
        authorId: j['authorId']?.toString() ?? '',
        authorName: j['authorName']?.toString() ?? '',
        body: j['body']?.toString() ?? '',
        createdAt: DateTime.tryParse(j['createdAt']?.toString() ?? '') ?? DateTime.now(),
      );
}

class LeaveRequest {
  final String id;
  final String teacherName;
  final String leaveType;
  final String startDate;
  final String endDate;
  final String reason;
  final String status;
  final String? approvedBy;
  final String? decisionNote;
  final String? department;

  LeaveRequest({
    required this.id,
    required this.teacherName,
    required this.leaveType,
    required this.startDate,
    required this.endDate,
    required this.reason,
    required this.status,
    this.approvedBy,
    this.decisionNote,
    this.department,
  });

  factory LeaveRequest.fromJson(Map<String, dynamic> j) => LeaveRequest(
        id: j['id']?.toString() ?? '',
        teacherName: j['teacherName']?.toString() ?? '',
        leaveType: j['leaveType']?.toString() ?? '',
        startDate: (j['startDate'] ?? '').toString().split('T').first,
        endDate: (j['endDate'] ?? '').toString().split('T').first,
        reason: j['reason']?.toString() ?? '',
        status: j['status']?.toString() ?? 'PENDING',
        approvedBy: j['approvedBy']?.toString(),
        decisionNote: j['decisionNote']?.toString(),
        department: j['department']?.toString(),
      );

  String get typeLabel => switch (leaveType.toUpperCase()) {
        'CASUAL' => 'Casual Leave',
        'SICK' => 'Sick Leave',
        'EARNED' => 'Earned Leave',
        'MATERNITY' => 'Maternity Leave',
        'DUTY' => 'Duty Leave',
        _ => leaveType.isEmpty ? 'Leave' : '${leaveType[0]}${leaveType.substring(1).toLowerCase()} Leave',
      };

  String get statusLabel => switch (status.toUpperCase()) {
        'APPROVED' => 'Approved',
        'REJECTED' => 'Rejected',
        _ => 'Pending',
      };
}

class StudentDirectory {
  final String id;
  final String name;
  final String admissionNo;
  final String? className;
  final String? section;
  final String? attendancePct;
  final String? photoUrl;

  StudentDirectory({
    required this.id,
    required this.name,
    required this.admissionNo,
    this.className,
    this.section,
    this.attendancePct,
    this.photoUrl,
  });

  factory StudentDirectory.fromJson(Map<String, dynamic> j) => StudentDirectory(
        id: j['id']?.toString() ?? '',
        name: (j['name'] ?? '${j['firstName'] ?? ''} ${j['lastName'] ?? ''}').toString().trim(),
        admissionNo: j['admissionNo']?.toString() ?? '',
        className: j['className']?.toString() ?? j['class']?['name']?.toString(),
        section: j['section']?.toString() ?? j['sectionName']?.toString() ?? j['section']?['name']?.toString(),
        attendancePct: j['attendancePct']?.toString(),
        photoUrl: j['photoUrl']?.toString(),
      );
}

class Announcement {
  final String id;
  final String title;
  final String content;
  final DateTime createdAt;

  Announcement({required this.id, required this.title, required this.content, required this.createdAt});

  factory Announcement.fromJson(Map<String, dynamic> j) => Announcement(
        id: j['id']?.toString() ?? '',
        title: j['title']?.toString() ?? '',
        content: j['content']?.toString() ?? '',
        createdAt: DateTime.tryParse(j['createdAt']?.toString() ?? '') ?? DateTime.now(),
      );
}
