// Shared type contract for the College List Builder.
// Every module codes against these interfaces; do not widen with `any`.

// ---------- Student profile (output of the Gemini parse step) ----------

export type ProgramArea =
  | "computer-science"
  | "engineering"
  | "biology"
  | "marine-biology"
  | "natural-resources"
  | "business"
  | "health"
  | "psychology"
  | "visual-performing-arts"
  | "mathematics"
  | "physical-sciences"
  | "social-sciences"
  | "english"
  | "history"
  | "education"
  | "communications"
  | "undecided";

export type SizePreference = "small" | "medium" | "large";
export type LearningStyle = "hands-on" | "research" | "balanced";

export interface StudentProfile {
  name: string | null;
  gpa: number | null; // 4.0 scale
  satTotal: number | null; // 400-1600
  actComposite: number | null; // 1-36
  interests: ProgramArea[];
  homeState: string | null; // USPS two-letter code
  prefersNearHome: boolean;
  prefersWarmClimate: boolean;
  sizePreference: SizePreference | null;
  learningStyle: LearningStyle | null;
  needsFinancialAid: boolean;
  // Awards, activities, and story hooks used only to personalize prose,
  // never to invent facts about colleges.
  narrativeHighlights: string[];
}

// ---------- College (one row of data/colleges.json) ----------

export interface College {
  unitId: number;
  name: string;
  city: string;
  state: string; // USPS two-letter code
  control: "public" | "private";
  admitRate: number | null; // 0-1
  satReading25: number | null;
  satReading75: number | null;
  satMath25: number | null;
  satMath75: number | null;
  satAvg: number | null;
  actComposite25: number | null;
  actComposite75: number | null;
  actCompositeMid: number | null;
  tuitionInState: number | null; // USD per year
  tuitionOutOfState: number | null;
  avgNetPrice: number | null; // USD per year, coalesced NPT4_PUB/NPT4_PRIV
  undergradSize: number | null;
  locale: number | null; // IPEDS locale code
  gradRate: number | null; // C150_4, 0-1
  medianEarnings10yr: number | null; // USD
  // Share of degrees by two-digit CIP code, keys "pcip01".."pcip54", values 0-1.
  programShares: Record<string, number>;
}

// ---------- Matching output ----------

export type Bucket = "reach" | "target" | "likely";

export interface ScoreComponent {
  label: string; // e.g. "Academic fit"
  detail: string; // human-readable explanation grounded in data
  points: number; // contribution to the total score
}

export interface ScoredCollege {
  college: College;
  bucket: Bucket;
  score: number;
  components: ScoreComponent[];
  rationale: string; // two lines max, grounded prose
  rationaleSource: "gemini" | "fallback";
}

export interface Report {
  profile: StudentProfile;
  generatedAt: string; // ISO timestamp
  reach: ScoredCollege[];
  target: ScoredCollege[];
  likely: ScoredCollege[];
}

// ---------- API contracts ----------

export interface ParseRequest {
  description: string;
}

export interface ParseResponse {
  profile: StudentProfile;
}

export interface ReportRequest {
  profile: StudentProfile;
}

export interface ReportResponse {
  report: Report;
}

export interface ApiError {
  error: string;
}
