"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DownloadButton from "@/components/DownloadButton";
import HistoryPanel from "@/components/HistoryPanel";
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

function formatPoints(points: number): string {
  return points >= 0 ? `+${points}` : `${points}`;
}

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

// ---------- small presentational components ----------

function CheckIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
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
  return (
    <ol className="flex flex-col gap-5">
      {STEP_LABELS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex items-center gap-3.5">
            {done ? (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                <CheckIcon />
              </span>
            ) : active ? (
              <span
                aria-hidden
                className="h-7 w-7 shrink-0 animate-spin rounded-full border-[3px] border-accent/25 border-t-accent"
              />
            ) : (
              <span className="h-7 w-7 shrink-0 rounded-full border-2 border-zinc-300" />
            )}
            <span
              className={
                active
                  ? "font-medium text-foreground"
                  : done
                    ? "text-zinc-600"
                    : "text-zinc-400"
              }
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface ProfileCardProps {
  profile: StudentProfile;
}

function ProfileCard({ profile }: ProfileCardProps) {
  return (
    <section
      aria-label="Parsed student profile"
      className="animate-rise rounded-xl border border-zinc-200 bg-surface p-5 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">
          {profile.name ?? "Student profile"}
        </h2>
        <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">
          Parsed profile
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {profileChips(profile).map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong"
          >
            {chip}
          </span>
        ))}
      </div>
      {profile.narrativeHighlights.length > 0 && (
        <p className="mt-3 text-sm text-zinc-500">
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
    <article className="flex flex-col rounded-xl border border-zinc-200 bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold leading-snug">{college.name}</h4>
          <p className="mt-0.5 text-sm text-zinc-500">
            {college.city}, {college.state}
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${college.name} from the list`}
          className="-m-1 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
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
            className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
          >
            {chip}
          </span>
        ))}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-zinc-700">
        {scored.rationale}
      </p>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
        {scored.components.map((component) => (
          <span
            key={component.label}
            title={component.detail}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500"
          >
            {component.label} {formatPoints(component.points)}
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
      className="animate-rise rounded-xl border border-red-200 bg-red-50 p-4"
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
    setStudents(listStudents());
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

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        {phase === "input" && (
          <div className="mx-auto max-w-2xl">
            <header className="mb-8">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                For counselors
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight">
                College List Builder
              </h1>
              <p className="mt-3 text-lg text-zinc-600">
                Describe a student in plain language. Get a reach, target, and
                likely list grounded in real admissions data, ready to hand to
                the student.
              </p>
            </header>

            {error !== null && (
              <div className="mb-6">
                <ErrorCard message={error} />
              </div>
            )}

            <label
              htmlFor="student-description"
              className="mb-2 block text-sm font-medium text-zinc-700"
            >
              Student description
            </label>
            <textarea
              id="student-description"
              rows={8}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Name, scores, interests, and anything else you know about the student. The more context, the better the list."
              className="w-full resize-y rounded-xl border border-zinc-300 bg-surface p-4 text-[15px] leading-relaxed shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setDescription(prompt)}
                  className="flex flex-col items-start rounded-xl border border-zinc-200 bg-surface p-3.5 text-left shadow-sm transition-colors hover:border-accent/50 hover:bg-accent-soft/50"
                >
                  <span className="block text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
                    Example
                  </span>
                  <span className="mt-1.5 line-clamp-4 block text-[13px] leading-relaxed text-zinc-600">
                    {prompt}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              {isDev ? (
                <button
                  type="button"
                  onClick={handlePreviewSample}
                  className="text-xs text-zinc-400 underline-offset-2 transition-colors hover:text-zinc-600 hover:underline"
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
                className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
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
          <div className="mx-auto max-w-2xl">
            <header className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight">
                Building the list
              </h1>
              <p className="mt-1 text-zinc-500">
                This usually takes a few seconds.
              </p>
            </header>
            <div className="rounded-xl border border-zinc-200 bg-surface p-6 shadow-sm">
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
            <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                  College List Builder
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                  College list
                  {report.profile.name !== null
                    ? ` for ${report.profile.name}`
                    : ""}
                </h1>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="rounded-lg border border-zinc-300 bg-surface px-4 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
                >
                  Start over
                </button>
                <DownloadButton report={report} />
              </div>
            </header>

            {error !== null && (
              <div className="mb-6">
                <ErrorCard message={error} />
              </div>
            )}

            {versions.length > 0 && (
              <div className="mb-6 flex flex-wrap items-center gap-3">
                {versions.length > 1 && (
                  <div
                    role="group"
                    aria-label="Report versions"
                    className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-300 bg-surface p-0.5 shadow-sm"
                  >
                    {versions.map((version, index) => (
                      <button
                        key={`v${index + 1}`}
                        type="button"
                        onClick={() => handleSelectVersion(index)}
                        aria-pressed={index === versionIndex}
                        className={
                          index === versionIndex
                            ? "rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white"
                            : "rounded-md px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100"
                        }
                      >
                        v{index + 1}
                      </button>
                    ))}
                  </div>
                )}
                {finalVersionIndex >= 0 && (
                  <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong">
                    v{finalVersionIndex + 1} marked final
                  </span>
                )}
                <div className="ml-auto flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleToggleFinal(versionIndex)}
                    className="rounded-lg border border-zinc-300 bg-surface px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
                  >
                    {displayedVersion?.isFinal === true
                      ? "Unmark final"
                      : "Mark as final"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRefineOpen((open) => !open)}
                    className="rounded-lg border border-zinc-300 bg-surface px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
                  >
                    {refineOpen ? "Close refine" : "Refine"}
                  </button>
                </div>
              </div>
            )}

            {refineOpen && (
              <div className="mb-6 rounded-xl border border-zinc-200 bg-surface p-4 shadow-sm">
                <label
                  htmlFor="refine-context"
                  className="mb-2 block text-sm font-medium text-zinc-700"
                >
                  Add more context about this student
                </label>
                <textarea
                  id="refine-context"
                  rows={3}
                  value={refineText}
                  onChange={(event) => setRefineText(event.target.value)}
                  placeholder="New scores, activities, preferences, or anything else you have learned."
                  className="w-full resize-y rounded-xl border border-zinc-300 bg-surface p-3 text-sm leading-relaxed shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <div className="mt-3 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setRefineOpen(false);
                      setRefineText("");
                    }}
                    className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRefine}
                    disabled={refineText.trim().length === 0}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Regenerate list
                  </button>
                </div>
              </div>
            )}

            <ProfileCard profile={report.profile} />

            {BUCKET_ORDER.map((bucket) => {
              const schools = lists[bucket];
              const meta = BUCKET_META[bucket];
              return (
                <section key={bucket} aria-label={meta.title} className="mt-8">
                  <div className="flex items-baseline gap-3 border-b border-zinc-200 pb-2">
                    <h3 className="text-sm font-semibold uppercase tracking-widest text-accent">
                      {meta.title}
                    </h3>
                    <span className="text-sm text-zinc-500">{meta.note}</span>
                    <span className="ml-auto shrink-0 text-xs text-zinc-400">
                      {schools.length}{" "}
                      {schools.length === 1 ? "school" : "schools"}
                    </span>
                  </div>
                  {schools.length === 0 ? (
                    <p className="mt-3 text-sm text-zinc-400">
                      No schools left in this bucket.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
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

            <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-400">
              Data: US Dept of Education College Scorecard
            </footer>
          </div>
        )}
      </main>
    </div>
  );
}
