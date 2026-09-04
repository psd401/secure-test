# Security

This is a district-built secure-testing system. A vulnerability in it can
expose student responses or weaken a lockdown, so reports are taken
seriously even though there is no bug-bounty program.

## Reporting

Use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability"). Do not open a public issue for
anything exploitable.

Include what you can: the component (`design-tool/`, `client/`,
`packages/schema/`, `design-tool/infra/`), steps to reproduce, and the
impact you believe it has. A minimal fixture beats a real assessment.

## What to expect

- Acknowledgement within five working days.
- A fix or a mitigation before any public disclosure, and credit in the
  release notes if you want it.
- No response commitment for reports about the proof-of-concept
  directories (`poc-*/`); they are historical records, not shipped code.

## Scope notes

- The student client's lockdown depends on Apple's Automatic Assessment
  Configuration. Reports about bypassing macOS itself belong with Apple;
  reports about this app failing to configure or exit a session correctly
  belong here.
- The wire format is designed so a student's delivery bundle cannot carry an
  answer key (ADR 0016). A way to get one through is in scope.
- The public repository never carries real credentials, account ids, or
  student data. If you find any in the history or the tree, report it here
  the same way.
