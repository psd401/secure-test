// Shapes shared by the catalog build (lib/standards/build.ts) and the lookup
// module (lib/standards/catalog.ts). docs/batch-item-generation-design.md.

export type StandardScheme = "wa2026" | "ccss2010" | "ngss";
export type StandardSubject = "math" | "ela" | "science";

export type StandardCourse = {
  course: string;
  priority: boolean;
  /** Only when this course words the standard differently from the entry's text. */
  text?: string;
};

export type StandardEntry = {
  scheme: StandardScheme;
  code: string;
  subject: StandardSubject;
  grade_band: string;
  domain: string;
  text: string;
  /** wa2026 only (OSPI's PRIORITY flag; HS math: true if priority in any course). */
  priority?: boolean;
  /** wa2026 only. */
  new_in_2026?: boolean;
  /** HS math wa2026 only: one row per course the standard appears in. */
  courses?: StandardCourse[];
  /** ngss only: the bracketed "Clarification Statement" of the performance expectation. */
  clarification?: string;
  /** ngss only: the bracketed "Assessment Boundary". */
  assessment_boundary?: string;
  /** ngss only: marked with an asterisk in the PDF (integrates engineering). */
  engineering?: boolean;
};

export type CrosswalkPair = { ccss2010: string; wa2026: string };
