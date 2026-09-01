// Client-side persistence for counselor workflow state. Everything here runs
// against localStorage and must only be called from browser effects or event
// handlers. Every read and write is wrapped so quota errors, private-mode
// restrictions, and corrupt payloads degrade to safe defaults instead of
// crashing the page.

import type { Report } from "@/lib/types";

// ---------- stored shapes (local to this module by design) ----------

export interface StoredVersion {
  report: Report;
  description: string;
  addedContext: string | null;
  createdAt: string; // ISO timestamp
  isFinal: boolean;
}

export interface StoredStudent {
  id: string;
  label: string;
  createdAt: string; // ISO timestamp
  versions: StoredVersion[];
}

// ---------- constants ----------

const STORAGE_KEY = "clb.students.v1";
const MAX_STUDENTS = 20;
const LABEL_MAX_LENGTH = 40;

// ---------- internal helpers ----------

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp-based id.
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isStoredVersion(value: unknown): value is StoredVersion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.report !== "object" || v.report === null) {
    return false;
  }
  // The page renders report.profile fields and maps over the three bucket
  // arrays, so a corrupt payload missing any of them must be dropped here
  // rather than crash the render.
  const report = v.report as Record<string, unknown>;
  return (
    typeof v.description === "string" &&
    (v.addedContext === null || typeof v.addedContext === "string") &&
    typeof v.createdAt === "string" &&
    typeof v.isFinal === "boolean" &&
    typeof report.profile === "object" &&
    report.profile !== null &&
    Array.isArray(report.reach) &&
    Array.isArray(report.target) &&
    Array.isArray(report.likely)
  );
}

function isStoredStudent(value: unknown): value is StoredStudent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.label === "string" &&
    typeof s.createdAt === "string" &&
    Array.isArray(s.versions) &&
    s.versions.every(isStoredVersion)
  );
}

// Newest students live at the front of the array; eviction drops from the end.
function readAll(): StoredStudent[] {
  try {
    if (typeof window === "undefined") {
      return [];
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isStoredStudent);
  } catch {
    return [];
  }
}

function writeAll(students: StoredStudent[]): boolean {
  try {
    if (typeof window === "undefined") {
      return false;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
    return true;
  } catch {
    return false;
  }
}

function labelFor(description: string, report: Report): string {
  const name = report.profile.name;
  if (name !== null && name.trim().length > 0) {
    return name.trim();
  }
  const trimmed = description.trim();
  if (trimmed.length <= LABEL_MAX_LENGTH) {
    return trimmed.length > 0 ? trimmed : "Untitled student";
  }
  return trimmed.slice(0, LABEL_MAX_LENGTH).trimEnd();
}

// ---------- public API ----------

export function listStudents(): StoredStudent[] {
  return readAll();
}

export function getStudent(studentId: string): StoredStudent | null {
  const found = readAll().find((student) => student.id === studentId);
  return found ?? null;
}

export function saveNewStudent(
  description: string,
  report: Report
): StoredStudent | null {
  const now = new Date().toISOString();
  const student: StoredStudent = {
    id: makeId(),
    label: labelFor(description, report),
    createdAt: now,
    versions: [
      {
        report,
        description,
        addedContext: null,
        createdAt: now,
        isFinal: false,
      },
    ],
  };
  const students = [student, ...readAll()].slice(0, MAX_STUDENTS);
  return writeAll(students) ? student : null;
}

export function appendVersion(
  studentId: string,
  description: string,
  addedContext: string | null,
  report: Report
): StoredStudent | null {
  const students = readAll();
  const index = students.findIndex((student) => student.id === studentId);
  const existing = index >= 0 ? students[index] : undefined;
  if (existing === undefined) {
    return null;
  }
  const version: StoredVersion = {
    report,
    description,
    addedContext,
    createdAt: new Date().toISOString(),
    isFinal: false,
  };
  const updated: StoredStudent = {
    ...existing,
    versions: [...existing.versions, version],
  };
  students[index] = updated;
  return writeAll(students) ? updated : null;
}

// Renames a student: updates the history label and stamps the name onto the
// profile of every stored version, so the PDF header, filename, and email
// subject all pick it up regardless of which version is open.
export function renameStudent(
  studentId: string,
  name: string
): StoredStudent | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const students = readAll();
  const index = students.findIndex((student) => student.id === studentId);
  const existing = index >= 0 ? students[index] : undefined;
  if (existing === undefined) {
    return null;
  }
  const updated: StoredStudent = {
    ...existing,
    label: trimmed,
    versions: existing.versions.map((version) => ({
      ...version,
      report: {
        ...version.report,
        profile: { ...version.report.profile, name: trimmed },
      },
    })),
  };
  students[index] = updated;
  return writeAll(students) ? updated : null;
}

// Toggles the final flag on one version. Setting a version final clears the
// flag on every other version of the same student; toggling the current final
// version off leaves the student with no final version.
export function markFinal(
  studentId: string,
  versionIndex: number
): StoredStudent | null {
  const students = readAll();
  const index = students.findIndex((student) => student.id === studentId);
  const existing = index >= 0 ? students[index] : undefined;
  if (existing === undefined) {
    return null;
  }
  const target = existing.versions[versionIndex];
  if (target === undefined) {
    return null;
  }
  const nextFinal = !target.isFinal;
  const updated: StoredStudent = {
    ...existing,
    versions: existing.versions.map((version, i) => ({
      ...version,
      isFinal: i === versionIndex ? nextFinal : false,
    })),
  };
  students[index] = updated;
  return writeAll(students) ? updated : null;
}

export function deleteStudent(studentId: string): boolean {
  const students = readAll();
  const next = students.filter((student) => student.id !== studentId);
  if (next.length === students.length) {
    return false;
  }
  return writeAll(next);
}
