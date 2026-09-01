"use client";

// Recent-students panel shown on the input screen. Renders nothing at all
// when there is no history, so an empty or unavailable localStorage leaves
// the input screen untouched.

import type { StoredStudent } from "@/lib/storage";

interface HistoryPanelProps {
  students: StoredStudent[];
  onOpen: (studentId: string) => void;
  onDelete: (studentId: string) => void;
}

function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function HistoryPanel({
  students,
  onOpen,
  onDelete,
}: HistoryPanelProps) {
  if (students.length === 0) {
    return null;
  }
  return (
    <section aria-label="Recent students" className="mt-12">
      <div className="flex items-baseline justify-between pb-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
          Recent students
        </h2>
        <span className="shrink-0 text-xs tabular-nums text-faint">
          {students.length} saved
        </span>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface shadow-card">
        {students.map((student) => {
          const finalIndex = student.versions.findIndex(
            (version) => version.isFinal
          );
          const versionCount = student.versions.length;
          const date = formatDate(student.createdAt);
          return (
            <li key={student.id}>
              <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-background/60">
                <button
                  type="button"
                  onClick={() => onOpen(student.id)}
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {student.label}
                    </span>
                    {finalIndex >= 0 && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium tabular-nums text-accent-strong">
                        v{finalIndex + 1} final
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 text-xs tabular-nums text-muted">
                    {date.length > 0 ? `${date} · ` : ""}
                    {versionCount} {versionCount === 1 ? "version" : "versions"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(student.id)}
                  aria-label={`Delete ${student.label} from recent students`}
                  className="-m-1 shrink-0 rounded p-1 text-faint transition-colors hover:bg-line/70 hover:text-foreground"
                >
                  <svg
                    aria-hidden
                    className="h-4 w-4"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="m4 4 8 8m0-8-8 8" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
