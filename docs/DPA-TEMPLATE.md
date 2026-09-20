# Data Processing Agreement — Template (BUILD_PLAN 10.1 #4)

> **Status: TEMPLATE.** Gate 10 requires a lawyer to review this before the
> first paid contract. It is drafted to the DPDP Act 2023 roles: the **school
> is the Data Fiduciary**; EduCore ([company]) is the **Data Processor**.
> Do not present this to a school as final advice.

**Parties.** This Agreement is between **[School legal name]** ("the
Fiduciary", address, GSTIN) and **[Your company legal name]** ("the
Processor", address, GSTIN), effective [date].

**1. Purpose and scope.** The Processor provides the EduCore school
management platform (SaaS) to the Fiduciary, processing personal data of
students, parents/guardians, and staff on the Fiduciary's documented
instructions (this Agreement and the Fiduciary's use of the platform). No
processing for any other purpose, including no behavioural advertising or
tracking of children (DPDP Act, s.9).

**2. Data covered.** Student identity and academic records; attendance;
fee and payment records; guardian contact details; staff employment and
payroll data; device tokens and notification logs; documents and photos
uploaded by the Fiduciary. Special-category/child data is processed only
where the Fiduciary has recorded verifiable parental consent in the
platform (module: Compliance → Consents).

**3. Processor obligations.**
a. Process only on the Fiduciary's instructions; notify the Fiduciary if an
   instruction infringes the Act.
b. Security: encryption in transit (TLS 1.2+); role-based access control
   with branch scoping; audit logging of mark changes, certificate issue,
   consent and erasure actions; secrets in a managed store; least-privilege
   database access.
c. **Data localisation:** all production data hosted in an India region
   ([provider, region]). No transfer outside India without prior written
   consent.
d. Confidentiality: personnel bound by written confidentiality
   obligations.
e. Assist the Fiduciary with data-principal requests (access, correction,
   erasure, grievance) within 5 working days — the platform exposes these
   natively (Compliance module; export/erasure endpoints).
f. Breach assistance per the runbook (see BREACH-NOTIFICATION-RUNBOOK.md):
   notify the Fiduciary within **24 hours** of becoming aware.
g. Deletion/return: on termination, exportable data returns to the
   Fiduciary; Processor deletes copies within 90 days, save where statute
   (e.g. tax law, 8 years for fee records) requires retention — retention
   documented per dataset.
h. Sub-processors: current list in Schedule A (hosting, SMS/WhatsApp BSP,
   email, payments, push). The Processor remains fully liable for
   sub-processors; 30 days' notice of additions; the Fiduciary may object
   on reasonable grounds.

**4. Fiduciary obligations.** Lawful basis and verifiable parental consent
for processing children's data; accuracy of data entered; consent records
maintained in the platform; grievance officer named (defaults to
Principal; configurable in-platform); responding to data principals
within the DPDP timelines.

**5. Audit.** The Fiduciary may audit Processor compliance annually on 30
days' notice, or after any personal-data breach, via reports (access
logs, audit trails) and a written questionnaire; on-site audits at
Processor's discretion and cost.

**6. Liability and indemnity.** As agreed in the master services
agreement. Nothing limits liability that cannot be limited by law.

**7. Term.** Coterminous with the subscription; obligations 3(f), 3(g), 5
and 7 survive termination.

**Schedule A — Sub-processors.**
| Function | Provider | Region |
|---|---|---|
| Application hosting + database | [e.g. AWS Mumbai ap-south-1] | India |
| SMS (DLT) / WhatsApp BSP | [e.g. Meta Cloud API via BSP] | India / [as offered] |
| Transactional email | [e.g. SES Mumbai] | India |
| Payment gateway | Razorpay | India |
| Push notifications | Firebase (Google) | [disclose region] |

**Schedule B — Retention schedule (platform defaults).**
| Data | Retention |
|---|---|
| Fee/payment records | 8 years (tax) |
| Attendance | Current + 2 academic years |
| Exam marks & report cards | Current + 3 academic years |
| Chat messages | 12 months rolling |
| Notification logs | 12 months |
| Erasure requests | Completed: record of the request + retention note kept; erasure executed per DPDP |
