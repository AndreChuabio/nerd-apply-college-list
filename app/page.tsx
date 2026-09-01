"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DownloadButton from "@/components/DownloadButton";
import HistoryPanel from "@/components/HistoryPanel";
import PdfPreview from "@/components/PdfPreview";
import { sampleReport } from "@/lib/fixtures";
import {
  appendVersion,
  deleteStudent,
  getStudent,
  listStudents,
  markFinal,
  saveNewStudent,
} from "@/lib/storage";
import type { StoredStudent, StoredVersion } from "@/lib/storage";
import type {
  ApiError,
  Bucket,
  College,
  ParseRequest,
  ParseResponse,
  ProgramArea,
  Report,
  ReportRequest,
  ReportResponse,
  ScoredCollege,
  StudentProfile,
} from "@/lib/types";

// ---------- constants ----------

const EXAMPLE_PROMPTS: string[] = [
  "I have a student named John Smith, loves programming, won the Congressional App Challenge for the state of PA, 1230 SAT, 3.5 GPA, good AP scores like a 4 on Calc BC, 5 on Comp Sci A, 3 on Human Geo. Wants schools that aren't too far from home and are more practical and hands-on.",
  "Quiet kid, really into marine biology, middling test scores but a great story. Needs financial aid. Somewhere warm would be a plus.",
  "Junior from New Jersey, varsity soccer captain hoping to play in college, obsessed with finance and the stock market, family is worried about costs, 1350 SAT, 3.8 GPA.",
];

const STEP_LABELS: string[] = [
  "Reading the student",
  "Matching against real data",
  "Writing the list",
];

// Kept in sync with the map in components/ReportPdf.tsx. Duplicated on
// purpose: this page must never statically import that module, or react-pdf
// lands in the SSR bundle.
const PROGRAM_LABELS: Record<ProgramArea, string> = {
  "computer-science": "Computer science",
  engineering: "Engineering",
  biology: "Biology",
  "marine-biology": "Marine biology",
  "natural-resources": "Natural resources",
  business: "Business",
  health: "Health",
  psychology: "Psychology",
  "visual-performing-arts": "Visual and performing arts",
  mathematics: "Mathematics",
  "physical-sciences": "Physical sciences",
  "social-sciences": "Social sciences",
  english: "English",
  history: "History",
  education: "Education",
  communications: "Communications",
  undecided: "Undecided",
};

interface BucketMeta {
  title: string;
  note: string;
}

const BUCKET_META: Record<Bucket, BucketMeta> = {
  reach: {
    title: "Reach",
    note: "Admission is a stretch. Worth one strong application.",
  },
  target: {
    title: "Target",
    note: "The profile lines up with the typical admit.",
  },
  likely: {
    title: "Likely",
    note: "Strong odds of admission. Anchor the list here.",
  },
};

const BUCKET_ORDER: Bucket[] = ["reach", "target", "likely"];

const SIZE_LABELS: Record<NonNullable<StudentProfile["sizePreference"]>, string> =
  {
    small: "Small",
    medium: "Mid-size",
    large: "Large",
  };

const LEARNING_STYLE_LABELS: Record<
  NonNullable<StudentProfile["learningStyle"]>,
  string
> = {
  "hands-on": "Hands-on learner",
  research: "Research-oriented",
  balanced: "Balanced learner",
};

// ---------- formatting helpers ----------

function formatAdmitRate(rate: number | null): string | null {
  return rate === null ? null : `Admit ${Math.round(rate * 100)}%`;
}

function formatSatRange(college: College): string | null {
  const { satReading25, satReading75, satMath25, satMath75 } = college;
  if (
    satReading25 === null ||
    satReading75 === null ||
    satMath25 === null ||
    satMath75 === null
  ) {
    return null;
  }
  return `SAT ${satReading25 + satMath25}-${satReading75 + satMath75}`;
}

function formatNetPrice(price: number | null): string | null {
  return price === null ? null : `$${price.toLocaleString("en-US")}/yr net`;
}

function formatUndergrads(size: number | null): string | null {
  return size === null ? null : `${size.toLocaleString("en-US")} undergrads`;
}

function collegeStatChips(college: College): string[] {
  return [
    formatAdmitRate(college.admitRate),
    formatSatRange(college),
    formatNetPrice(college.avgNetPrice),
    formatUndergrads(college.undergradSize),
  ].filter((chip): chip is string => chip !== null);
}

function profileChips(profile: StudentProfile): string[] {
  const chips: string[] = [];
  if (profile.gpa !== null) {
    chips.push(`GPA ${profile.gpa.toFixed(1)}`);
  }
  if (profile.satTotal !== null) {
    chips.push(`SAT ${profile.satTotal}`);
  }
  if (profile.actComposite !== null) {
    chips.push(`ACT ${profile.actComposite}`);
  }
  for (const area of profile.interests) {
    chips.push(PROGRAM_LABELS[area]);
  }
  if (profile.homeState !== null) {
    chips.push(`Home: ${profile.homeState}`);
  }
  if (profile.prefersNearHome) {
    chips.push("Near home");
  }
  if (profile.prefersWarmClimate) {
    chips.push("Warm climate");
  }
  if (profile.needsFinancialAid) {
    chips.push("Financial aid");
  }
  if (profile.sizePreference !== null) {
    chips.push(`${SIZE_LABELS[profile.sizePreference]} campus`);
  }
  if (profile.learningStyle !== null) {
    chips.push(LEARNING_STYLE_LABELS[profile.learningStyle]);
  }
  return chips;
}

// A component at or above this many points shaped the placement enough to
// deserve the highlighted treatment on its tag.
const COMPONENT_HIGHLIGHT_AT = 20;

async function readApiError(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as ApiError).error === "string"
    ) {
      return (data as ApiError).error;
    }
  } catch {
    // Body was not JSON; fall through to the generic message.
  }
  return `The server responded with status ${res.status}. Please try again.`;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0
    ? err.message
    : "The request could not be completed. Check your connection and try again.";
}

function makeLocalVersion(
  description: string,
  addedContext: string | null,
  report: Report
): StoredVersion {
  return {
    report,
    description,
    addedContext,
    createdAt: new Date().toISOString(),
    isFinal: false,
  };
}

// ---------- version diffing (pure, client-side, from stored versions) ----------

interface DiffEntry {
  unitId: number;
  name: string;
}

interface MovedEntry extends DiffEntry {
  from: Bucket;
  to: Bucket;
}

interface VersionDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  moved: MovedEntry[];
}

function indexReportSchools(
  report: Report
): Map<number, { name: string; bucket: Bucket }> {
  const map = new Map<number, { name: string; bucket: Bucket }>();
  for (const bucket of BUCKET_ORDER) {
    for (const scored of report[bucket]) {
      map.set(scored.college.unitId, { name: scored.college.name, bucket });
    }
  }
  return map;
}

function diffReports(previous: Report, current: Report): VersionDiff {
  const prevMap = indexReportSchools(previous);
  const currMap = indexReportSchools(current);
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const moved: MovedEntry[] = [];
  for (const [unitId, school] of currMap) {
    const before = prevMap.get(unitId);
    if (before === undefined) {
      added.push({ unitId, name: school.name });
    } else if (before.bucket !== school.bucket) {
      moved.push({
        unitId,
        name: school.name,
        from: before.bucket,
        to: school.bucket,
      });
    }
  }
  for (const [unitId, school] of prevMap) {
    if (!currMap.has(unitId)) {
      removed.push({ unitId, name: school.name });
    }
  }
  return { added, removed, moved };
}

// ---------- small presentational components ----------

function CheckIcon() {
  return (
    <svg
      aria-hidden
      className="h-3 w-3"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

interface GenerationStepsProps {
  current: number;
}

function GenerationSteps({ current }: GenerationStepsProps) {
  const clamped = Math.min(current, STEP_LABELS.length - 1);
  const fill = ((clamped + 0.5) / STEP_LABELS.length) * 100;
  return (
    <div>
      <div className="h-0.5 w-full overflow-hidden rounded-full bg-line">
        <div
          aria-hidden
          className="h-full rounded-full bg-accent transition-all duration-700 ease-out"
          style={{ width: `${fill}%` }}
        />
      </div>
      <ol className="mt-8 flex flex-col">
        {STEP_LABELS.map((label, index) => {
          const done = index < current;
          const active = index === current;
          const last = index === STEP_LABELS.length - 1;
          return (
            <li key={label} className="flex items-stretch gap-4">
              <div className="flex flex-col items-center">
                {done ? (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                    <CheckIcon />
                  </span>
                ) : active ? (
                  <span
                    aria-hidden
                    className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-accent/20 border-t-accent"
                  />
                ) : (
                  <span className="h-6 w-6 shrink-0 rounded-full border border-line bg-surface" />
                )}
                {!last && (
                  <span
                    aria-hidden
                    className={`my-1 w-px flex-1 ${done ? "bg-accent" : "bg-line"}`}
                  />
                )}
              </div>
              <div
                className={`flex min-w-0 flex-1 items-baseline justify-between gap-4 pt-0.5 ${
                  last ? "" : "pb-7"
                }`}
              >
                <span
                  className={
                    active
                      ? "text-[15px] font-medium text-foreground"
                      : done
                        ? "text-[15px] text-muted"
                        : "text-[15px] text-faint"
                  }
                >
                  {label}
                </span>
                <span className="text-[11px] font-medium tabular-nums tracking-[0.08em] text-faint">
                  0{index + 1}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface ProfileCardProps {
  profile: StudentProfile;
  variant?: "card" | "rail";
}

function ProfileCard({ profile, variant = "card" }: ProfileCardProps) {
  if (variant === "rail") {
    return (
      <section aria-label="Parsed student profile">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
          Parsed profile
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profileChips(profile).map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium tabular-nums text-accent-strong"
            >
              {chip}
            </span>
          ))}
        </div>
        {profile.narrativeHighlights.length > 0 && (
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            {profile.narrativeHighlights.join(" · ")}
          </p>
        )}
      </section>
    );
  }
  return (
    <section
      aria-label="Parsed student profile"
      className="animate-rise rounded-md border border-line bg-surface p-6 shadow-card"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-2xl tracking-tight">
          {profile.name ?? "Student profile"}
        </h2>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
          Parsed profile
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {profileChips(profile).map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium tabular-nums text-accent-strong"
          >
            {chip}
          </span>
        ))}
      </div>
      {profile.narrativeHighlights.length > 0 && (
        <p className="mt-4 text-sm leading-relaxed text-muted">
          {profile.narrativeHighlights.join(" · ")}
        </p>
      )}
    </section>
  );
}

interface SchoolCardProps {
  scored: ScoredCollege;
  onRemove: () => void;
}

function SchoolCard({ scored, onRemove }: SchoolCardProps) {
  const { college } = scored;
  return (
    <article className="flex flex-col rounded-md border border-line bg-surface p-5 shadow-card transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-[15px] font-semibold leading-snug">
            {college.name}
          </h4>
          <p className="mt-0.5 text-[13px] text-muted">
            {college.city}, {college.state}
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${college.name} from the list`}
          className="-m-1 shrink-0 rounded p-1 text-faint transition-colors hover:bg-background hover:text-foreground"
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
      <div className="mt-3 flex flex-wrap gap-1.5">
        {collegeStatChips(college).map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center rounded bg-accent-soft px-2 py-0.5 text-xs font-medium tabular-nums text-foreground"
          >
            {chip}
          </span>
        ))}
      </div>
      <p className="mt-3.5 text-sm leading-relaxed text-foreground/80">
        {scored.rationale}
      </p>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
        {scored.components.map((component) => (
          <span
            key={component.label}
            title={component.detail}
            className={
              component.points >= COMPONENT_HIGHLIGHT_AT
                ? "inline-flex items-center rounded border border-accent/30 bg-accent-soft/60 px-1.5 py-0.5 text-[11px] font-medium text-accent-strong"
                : "inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] text-faint"
            }
          >
            {component.label}
          </span>
        ))}
      </div>
    </article>
  );
}

interface ErrorCardProps {
  message: string;
}

function ErrorCard({ message }: ErrorCardProps) {
  return (
    <div
      role="alert"
      className="animate-rise rounded-md border border-red-200 bg-red-50 p-4"
    >
      <p className="text-sm font-semibold text-red-800">
        Something went wrong while generating the list
      </p>
      <p className="mt-1 text-sm text-red-700">{message}</p>
    </div>
  );
}

// ---------- page ----------

type Phase = "input" | "generating" | "result";

interface BucketLists {
  reach: ScoredCollege[];
  target: ScoredCollege[];
  likely: ScoredCollege[];
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("input");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [lists, setLists] = useState<BucketLists | null>(null);
  const [genStep, setGenStep] = useState(0);
  const stepTimerRef = useRef<number | null>(null);

  // Counselor workflow state: saved students, the open student, its versions.
  const [students, setStudents] = useState<StoredStudent[]>([]);
  const [currentStudentId, setCurrentStudentId] = useState<string | null>(null);
  const [versions, setVersions] = useState<StoredVersion[]>([]);
  const [versionIndex, setVersionIndex] = useState(0);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    setStudents(listStudents());
  }, []);

  useEffect(() => {
    return () => {
      if (stepTimerRef.current !== null) {
        window.clearTimeout(stepTimerRef.current);
      }
    };
  }, []);

  function clearStepTimer(): void {
    if (stepTimerRef.current !== null) {
      window.clearTimeout(stepTimerRef.current);
      stepTimerRef.current = null;
    }
  }

  const report: Report | null = useMemo(() => {
    if (profile === null || generatedAt === null || lists === null) {
      return null;
    }
    return {
      profile,
      generatedAt,
      reach: lists.reach,
      target: lists.target,
      likely: lists.likely,
    };
  }, [profile, generatedAt, lists]);

  function applyReport(generated: Report): void {
    setProfile(generated.profile);
    setGeneratedAt(generated.generatedAt);
    setLists({
      reach: generated.reach,
      target: generated.target,
      likely: generated.likely,
    });
  }

  // Shared parse-then-report pipeline behind both generate and refine.
  // Drives the progress steps and surfaces the parsed profile as soon as it
  // lands; throws with a user-facing message on any failure.
  async function runPipeline(desc: string): Promise<Report> {
    setGenStep(0);
    const parseRes = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc } satisfies ParseRequest),
    });
    if (!parseRes.ok) {
      throw new Error(await readApiError(parseRes));
    }
    const { profile: parsedProfile } = (await parseRes.json()) as ParseResponse;
    setProfile(parsedProfile);
    setGenStep(1);
    stepTimerRef.current = window.setTimeout(() => setGenStep(2), 1800);

    const reportRes = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: parsedProfile } satisfies ReportRequest),
    });
    clearStepTimer();
    if (!reportRes.ok) {
      throw new Error(await readApiError(reportRes));
    }
    const { report: generated } = (await reportRes.json()) as ReportResponse;
    return generated;
  }

  async function handleGenerate(): Promise<void> {
    const trimmed = description.trim();
    if (trimmed.length === 0 || phase === "generating") {
      return;
    }
    setPhase("generating");
    setError(null);
    setProfile(null);
    setLists(null);
    setGeneratedAt(null);
    try {
      const generated = await runPipeline(trimmed);
      const saved = saveNewStudent(trimmed, generated);
      if (saved !== null) {
        setCurrentStudentId(saved.id);
        setVersions(saved.versions);
      } else {
        // Storage unavailable: keep the session working in memory only.
        setCurrentStudentId(null);
        setVersions([makeLocalVersion(trimmed, null, generated)]);
      }
      setVersionIndex(0);
      setStudents(listStudents());
      setRefineOpen(false);
      setRefineText("");
      applyReport(generated);
      setPhase("result");
    } catch (err) {
      clearStepTimer();
      setError(toErrorMessage(err));
      setPhase("input");
    }
  }

  async function handleRefine(): Promise<void> {
    const added = refineText.trim();
    if (added.length === 0 || phase === "generating") {
      return;
    }
    const latest = versions.length > 0 ? versions[versions.length - 1] : undefined;
    const base = latest !== undefined ? latest.description : description.trim();
    const composite = `${base}\n\nAdditional context from the counselor: ${added}`;
    // Snapshot the displayed report so a failed refine can restore it.
    const prevProfile = profile;
    const prevGeneratedAt = generatedAt;
    const prevLists = lists;
    setPhase("generating");
    setError(null);
    setProfile(null);
    setLists(null);
    setGeneratedAt(null);
    try {
      const generated = await runPipeline(composite);
      let nextVersions: StoredVersion[] | null = null;
      if (currentStudentId !== null) {
        const updated = appendVersion(
          currentStudentId,
          composite,
          added,
          generated
        );
        if (updated !== null) {
          nextVersions = updated.versions;
        }
      }
      if (nextVersions === null) {
        // Student was evicted or storage is unavailable; keep going in memory.
        nextVersions = [...versions, makeLocalVersion(composite, added, generated)];
      }
      setVersions(nextVersions);
      setVersionIndex(nextVersions.length - 1);
      setStudents(listStudents());
      setRefineOpen(false);
      setRefineText("");
      applyReport(generated);
      setPhase("result");
    } catch (err) {
      clearStepTimer();
      setError(toErrorMessage(err));
      setProfile(prevProfile);
      setGeneratedAt(prevGeneratedAt);
      setLists(prevLists);
      setPhase("result");
    }
  }

  function handleSelectVersion(index: number): void {
    const version = versions[index];
    if (version === undefined || index === versionIndex) {
      return;
    }
    setVersionIndex(index);
    applyReport(version.report);
  }

  function handleToggleFinal(index: number): void {
    if (currentStudentId !== null) {
      const updated = markFinal(currentStudentId, index);
      if (updated !== null) {
        setVersions(updated.versions);
        setStudents(listStudents());
        return;
      }
    }
    // In-memory fallback mirrors the storage semantics: exclusive toggle.
    setVersions((prev) =>
      prev.map((version, i) => ({
        ...version,
        isFinal: i === index ? !version.isFinal : false,
      }))
    );
  }

  function handleOpenStudent(studentId: string): void {
    const student = getStudent(studentId);
    if (student === null || student.versions.length === 0) {
      setStudents(listStudents());
      return;
    }
    const finalIndex = student.versions.findIndex((version) => version.isFinal);
    const index = finalIndex >= 0 ? finalIndex : student.versions.length - 1;
    const version = student.versions[index];
    if (version === undefined) {
      return;
    }
    setCurrentStudentId(student.id);
    setVersions(student.versions);
    setVersionIndex(index);
    setError(null);
    setRefineOpen(false);
    setRefineText("");
    applyReport(version.report);
    setPhase("result");
  }

  function handleDeleteStudent(studentId: string): void {
    const target = students.find((student) => student.id === studentId);
    const label = target !== undefined ? target.label : "this student";
    if (!window.confirm(`Delete ${label} and all saved versions?`)) {
      return;
    }
    deleteStudent(studentId);
    setStudents(listStudents());
    if (currentStudentId === studentId) {
      setCurrentStudentId(null);
    }
  }

  function handleRemove(bucket: Bucket, unitId: number): void {
    setLists((prev) => {
      if (prev === null) {
        return prev;
      }
      return {
        ...prev,
        [bucket]: prev[bucket].filter(
          (scored) => scored.college.unitId !== unitId
        ),
      };
    });
  }

  function handleStartOver(): void {
    clearStepTimer();
    setPhase("input");
    setDescription("");
    setError(null);
    setProfile(null);
    setGeneratedAt(null);
    setLists(null);
    setGenStep(0);
    setCurrentStudentId(null);
    setVersions([]);
    setVersionIndex(0);
    setRefineOpen(false);
    setRefineText("");
    setPreviewOpen(false);
    setStudents(listStudents());
  }

  // Logo-goes-home: from the result state this is exactly the start-over
  // reset (reports are already persisted to history before display, and
  // refine text gets the same treatment as Cancel). On the input state it
  // is already home, and during generation it stays inert so the in-flight
  // request cannot race the reset.
  function handleGoHome(): void {
    if (phase !== "result") {
      return;
    }
    handleStartOver();
  }

  function handlePreviewSample(): void {
    setError(null);
    setCurrentStudentId(null);
    setVersions([makeLocalVersion("Sample report preview", null, sampleReport)]);
    setVersionIndex(0);
    setRefineOpen(false);
    setRefineText("");
    applyReport(sampleReport);
    setPhase("result");
  }

  const isDev = process.env.NODE_ENV === "development";
  const finalVersionIndex = versions.findIndex((version) => version.isFinal);
  const displayedVersion =
    versionIndex < versions.length ? versions[versionIndex] : undefined;

  // Compares the displayed version against the one before it, straight from
  // the versions already in state. Null on v1, so the strip never renders.
  const versionDiff: VersionDiff | null = useMemo(() => {
    if (versionIndex < 1) {
      return null;
    }
    const current = versions[versionIndex];
    const previous = versions[versionIndex - 1];
    if (current === undefined || previous === undefined) {
      return null;
    }
    return diffReports(previous.report, current.report);
  }, [versions, versionIndex]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b-2 border-accent bg-foreground">
        <div className="mx-auto flex w-full max-w-[1400px] items-center px-6 py-2.5 lg:px-10">
          <button
            type="button"
            onClick={handleGoHome}
            aria-label="College List Builder home"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <span aria-hidden className="h-2 w-2 rounded-[2px] bg-accent" />
            <span className="font-display text-[17px] tracking-tight text-white">
              College List Builder
            </span>
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-12 lg:px-10">
        {phase === "input" && (
          <div className="mx-auto max-w-3xl animate-rise">
            <header className="mb-12 pt-8 text-center lg:pt-14">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                For counselors
              </p>
              <h1 className="mt-4 font-display text-5xl leading-[1.05] tracking-tight lg:text-[3.5rem]">
                Describe a student. Get the list.
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted">
                A reach, target, and likely college list grounded in real
                admissions data, ready to hand to the student.
              </p>
            </header>

            {error !== null && (
              <div className="mb-6">
                <ErrorCard message={error} />
              </div>
            )}

            <label
              htmlFor="student-description"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              Student description
            </label>
            <textarea
              id="student-description"
              rows={8}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Name, scores, interests, and anything else you know about the student. The more context, the better the list."
              className="w-full resize-y rounded-md border border-line bg-surface p-5 text-[15px] leading-relaxed shadow-card outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setDescription(prompt)}
                  className="group flex flex-col items-start rounded-md border border-line bg-surface p-4 text-left shadow-card transition-all duration-200 hover:border-accent/40 hover:shadow-lift"
                >
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-faint transition-colors group-hover:text-accent">
                    Example
                  </span>
                  <span className="mt-2 line-clamp-5 block text-[13px] leading-relaxed text-muted">
                    {prompt}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-7 flex items-center justify-between">
              {isDev ? (
                <button
                  type="button"
                  onClick={handlePreviewSample}
                  className="text-xs text-faint underline-offset-2 transition-colors hover:text-muted hover:underline"
                >
                  Preview sample report
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={description.trim().length === 0}
                className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-white shadow-card transition-all hover:bg-accent-strong active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
              >
                Generate list
              </button>
            </div>

            <HistoryPanel
              students={students}
              onOpen={handleOpenStudent}
              onDelete={handleDeleteStudent}
            />
          </div>
        )}

        {phase === "generating" && (
          <div className="mx-auto max-w-2xl animate-rise pt-4">
            <header className="mb-8">
              <h1 className="font-display text-3xl tracking-tight">
                Building the list
              </h1>
              <p className="mt-2 text-muted">
                This usually takes a few seconds.
              </p>
            </header>
            <div className="rounded-md border border-line bg-surface p-7 shadow-card">
              <GenerationSteps current={genStep} />
            </div>
            {profile !== null && (
              <div className="mt-6">
                <ProfileCard profile={profile} />
              </div>
            )}
          </div>
        )}

        {phase === "result" && report !== null && lists !== null && (
          <div className="animate-rise">
            {error !== null && (
              <div className="mb-8">
                <ErrorCard message={error} />
              </div>
            )}

            <div className="lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start lg:gap-12 xl:grid-cols-[380px_minmax(0,1fr)] xl:gap-16">
              <aside className="lg:sticky lg:top-10 lg:self-start">
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="group mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-foreground"
                >
                  <svg
                    aria-hidden
                    className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3 5 8l5 5" />
                  </svg>
                  Back to students
                </button>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                  Report
                </p>
                <h1 className="mt-2 font-display text-[2rem] leading-tight tracking-tight xl:text-[2.25rem]">
                  College list
                  {report.profile.name !== null
                    ? ` for ${report.profile.name}`
                    : ""}
                </h1>

                <div className="mt-6 [&>div]:items-stretch [&_button]:w-full [&_button]:justify-center [&_button]:py-3 [&_button]:text-[15px]">
                  <DownloadButton report={report} />
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewOpen((open) => !open)}
                  aria-expanded={previewOpen}
                  className="mt-3 w-full text-center text-[13px] font-medium text-muted transition-colors hover:text-foreground"
                >
                  {previewOpen ? "Hide preview" : "Preview report"}
                </button>
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="mt-3 w-full text-center text-[13px] font-medium text-muted transition-colors hover:text-foreground"
                >
                  Start over
                </button>

                {versions.length > 0 && (
                  <div className="mt-8 border-t border-line pt-6">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
                      Versions
                    </p>
                    {(versions.length > 1 || finalVersionIndex >= 0) && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {versions.length > 1 && (
                        <div
                          role="group"
                          aria-label="Report versions"
                          className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-card"
                        >
                          {versions.map((version, index) => (
                            <button
                              key={`v${index + 1}`}
                              type="button"
                              onClick={() => handleSelectVersion(index)}
                              aria-pressed={index === versionIndex}
                              className={
                                index === versionIndex
                                  ? "rounded bg-accent px-3 py-1 text-xs font-semibold tabular-nums text-white"
                                  : "rounded px-3 py-1 text-xs font-medium tabular-nums text-muted transition-colors hover:bg-background"
                              }
                            >
                              v{index + 1}
                            </button>
                          ))}
                        </div>
                      )}
                      {finalVersionIndex >= 0 && (
                        <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium tabular-nums text-accent-strong">
                          v{finalVersionIndex + 1} marked final
                        </span>
                      )}
                    </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleFinal(versionIndex)}
                        className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-card transition-colors hover:bg-background"
                      >
                        {displayedVersion?.isFinal === true
                          ? "Unmark final"
                          : "Mark as final"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRefineOpen((open) => !open)}
                        className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-card transition-colors hover:bg-background"
                      >
                        {refineOpen ? "Close refine" : "Refine"}
                      </button>
                    </div>
                  </div>
                )}

                {refineOpen && (
                  <div className="animate-rise mt-4 rounded-md border border-line bg-surface p-4 shadow-card">
                    <label
                      htmlFor="refine-context"
                      className="mb-2 block text-sm font-medium text-foreground"
                    >
                      Add more context about this student
                    </label>
                    <textarea
                      id="refine-context"
                      rows={3}
                      value={refineText}
                      onChange={(event) => setRefineText(event.target.value)}
                      placeholder="New scores, activities, preferences, or anything else you have learned."
                      className="w-full resize-y rounded-md border border-line bg-surface p-3 text-sm leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                    <div className="mt-3 flex items-center justify-end gap-4">
                      <button
                        type="button"
                        onClick={() => {
                          setRefineOpen(false);
                          setRefineText("");
                        }}
                        className="text-sm font-medium text-muted transition-colors hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleRefine}
                        disabled={refineText.trim().length === 0}
                        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-card transition-all hover:bg-accent-strong active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Regenerate list
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-8 border-t border-line pt-6">
                  <ProfileCard profile={report.profile} variant="rail" />
                </div>

                <div className="mt-8 border-t border-line pt-6">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
                    On this list
                  </p>
                  <ul className="mt-3 space-y-2.5">
                    {BUCKET_ORDER.map((bucket) => (
                      <li
                        key={bucket}
                        className="flex items-baseline justify-between text-sm"
                      >
                        <span className="text-muted">
                          {BUCKET_META[bucket].title}
                        </span>
                        <span className="font-semibold tabular-nums text-accent-strong">
                          {lists[bucket].length}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </aside>

              <div className="mt-12 min-w-0 lg:mt-0">

            {versionDiff !== null && (
              <section
                aria-label={`Changes from v${versionIndex}`}
                className="mb-8 rounded-md border border-line bg-surface p-4 shadow-card"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
                  Changes from v{versionIndex}
                </p>
                {versionDiff.added.length === 0 &&
                versionDiff.removed.length === 0 &&
                versionDiff.moved.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">
                    No school changes from v{versionIndex}.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {versionDiff.added.map((entry) => (
                      <span
                        key={`added-${entry.unitId}`}
                        className="inline-flex items-center rounded border border-accent/30 bg-accent-soft/60 px-2 py-0.5 text-xs font-medium text-accent-strong"
                      >
                        + {entry.name}
                      </span>
                    ))}
                    {versionDiff.removed.map((entry) => (
                      <span
                        key={`removed-${entry.unitId}`}
                        className="inline-flex items-center rounded border border-line px-2 py-0.5 text-xs text-faint"
                      >
                        -&nbsp;<span className="line-through">{entry.name}</span>
                      </span>
                    ))}
                    {versionDiff.moved.map((entry) => (
                      <span
                        key={`moved-${entry.unitId}`}
                        className="inline-flex items-center rounded border border-line px-2 py-0.5 text-xs text-muted"
                      >
                        {entry.name}: {entry.from} to {entry.to}
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )}

            {previewOpen && (
              <div className="mb-8">
                <PdfPreview report={report} />
              </div>
            )}

            {BUCKET_ORDER.map((bucket) => {
              const schools = lists[bucket];
              const meta = BUCKET_META[bucket];
              return (
                <section
                  key={bucket}
                  aria-label={meta.title}
                  className="mt-12 first:mt-0"
                >
                  <div className="border-b border-line pb-3.5">
                    <div className="flex items-baseline justify-between gap-4">
                      <h3 className="font-display text-[1.75rem] leading-tight tracking-tight">
                        {meta.title}
                      </h3>
                      <span className="shrink-0 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] tabular-nums text-accent-strong">
                        {schools.length}{" "}
                        {schools.length === 1 ? "school" : "schools"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[15px] text-muted">{meta.note}</p>
                  </div>
                  {schools.length === 0 ? (
                    <p className="mt-4 text-sm text-faint">
                      No schools left in this bucket.
                    </p>
                  ) : (
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      {schools.map((scored) => (
                        <SchoolCard
                          key={scored.college.unitId}
                          scored={scored}
                          onRemove={() =>
                            handleRemove(bucket, scored.college.unitId)
                          }
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}

                <footer className="mt-14 border-t border-line pt-4 text-xs text-faint">
                  Data: US Dept of Education College Scorecard
                </footer>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
