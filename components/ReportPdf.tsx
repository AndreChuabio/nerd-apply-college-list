// PDF document for the student-facing college list.
// IMPORTANT: this module imports @react-pdf/renderer, which must never run
// during SSR. Load it only via dynamic import in a browser event handler
// (see DownloadButton). Do not import it statically from any page or layout.

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type {
  Bucket,
  College,
  ProgramArea,
  Report,
  ScoredCollege,
  StudentProfile,
} from "@/lib/types";

// Kept in sync with the map in app/page.tsx. Duplicated on purpose: page.tsx
// must never statically import this module, or react-pdf lands in the SSR
// bundle.
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

const BUCKET_TITLES: Record<Bucket, string> = {
  reach: "Reach",
  target: "Target",
  likely: "Likely",
};

const BUCKET_NOTES: Record<Bucket, string> = {
  reach: "Admission is a stretch. Apply with a strong story.",
  target: "Profile lines up with the typical admit.",
  likely: "Strong odds of admission. Anchor the list here.",
};

function formatPercent(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)}% admit`;
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
  return size === null
    ? null
    : `${size.toLocaleString("en-US")} undergrads`;
}

function statsLine(college: College): string {
  return [
    formatPercent(college.admitRate),
    formatSatRange(college),
    formatNetPrice(college.avgNetPrice),
    formatUndergrads(college.undergradSize),
  ]
    .filter((part): part is string => part !== null)
    .join("   ·   ");
}

function profileSummary(profile: StudentProfile): string {
  const parts: string[] = [];
  if (profile.gpa !== null) {
    parts.push(`${profile.gpa.toFixed(1)} GPA`);
  }
  if (profile.satTotal !== null) {
    parts.push(`${profile.satTotal} SAT`);
  }
  if (profile.actComposite !== null) {
    parts.push(`${profile.actComposite} ACT`);
  }
  if (profile.interests.length > 0) {
    parts.push(
      profile.interests.map((area) => PROGRAM_LABELS[area]).join(", ")
    );
  }
  if (profile.homeState !== null) {
    parts.push(`${profile.homeState} resident`);
  }
  const prefs: string[] = [];
  if (profile.learningStyle === "hands-on") {
    prefs.push("hands-on programs");
  }
  if (profile.prefersNearHome) {
    prefs.push("close to home");
  }
  if (profile.prefersWarmClimate) {
    prefs.push("warm climate");
  }
  if (profile.needsFinancialAid) {
    prefs.push("financial aid a priority");
  }
  if (prefs.length > 0) {
    parts.push(`prefers ${prefs.join(", ")}`);
  }
  return parts.join("  ·  ");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const ACCENT = "#1d4ed8";
const INK = "#1c1917";
const MUTED = "#6b6560";
const RULE = "#e5e2de";

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 34,
    paddingHorizontal: 36,
    fontFamily: "Helvetica",
    color: INK,
    fontSize: 8,
  },
  brand: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 1.6,
    color: ACCENT,
    textTransform: "uppercase",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 5,
  },
  studentName: {
    fontFamily: "Times-Bold",
    fontSize: 17,
  },
  generatedAt: {
    fontSize: 7.5,
    color: MUTED,
  },
  summary: {
    fontFamily: "Times-Italic",
    fontSize: 8.5,
    color: MUTED,
    marginTop: 4,
  },
  headerRule: {
    borderBottomWidth: 1.2,
    borderBottomColor: INK,
    marginTop: 7,
    marginBottom: 0,
  },
  section: {
    marginTop: 6,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    borderBottomWidth: 0.6,
    borderBottomColor: RULE,
    paddingBottom: 2,
    marginBottom: 1,
  },
  sectionTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: ACCENT,
  },
  sectionNote: {
    fontSize: 6.5,
    color: MUTED,
    marginLeft: 8,
  },
  schoolRow: {
    paddingVertical: 3,
    borderBottomWidth: 0.6,
    borderBottomColor: RULE,
  },
  schoolTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  schoolName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
  },
  schoolPlace: {
    fontSize: 7,
    color: MUTED,
  },
  schoolStats: {
    fontSize: 6.5,
    color: MUTED,
    marginTop: 1.5,
  },
  rationale: {
    fontFamily: "Times-Roman",
    fontSize: 7.5,
    lineHeight: 1.25,
    marginTop: 2,
    maxLines: 2,
    textOverflow: "ellipsis",
  },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.6,
    borderTopColor: RULE,
    paddingTop: 5,
  },
  footerText: {
    fontSize: 6.5,
    color: MUTED,
  },
});

interface SchoolRowProps {
  scored: ScoredCollege;
}

function SchoolRow({ scored }: SchoolRowProps) {
  const { college } = scored;
  return (
    <View style={styles.schoolRow} wrap={false}>
      <View style={styles.schoolTopLine}>
        <Text style={styles.schoolName}>{college.name}</Text>
        <Text style={styles.schoolPlace}>
          {college.city}, {college.state}
        </Text>
      </View>
      <Text style={styles.schoolStats}>{statsLine(college)}</Text>
      <Text style={styles.rationale}>{scored.rationale}</Text>
    </View>
  );
}

interface BucketSectionProps {
  bucket: Bucket;
  schools: ScoredCollege[];
}

function BucketSection({ bucket, schools }: BucketSectionProps) {
  if (schools.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{BUCKET_TITLES[bucket]}</Text>
        <Text style={styles.sectionNote}>{BUCKET_NOTES[bucket]}</Text>
      </View>
      {schools.map((scored) => (
        <SchoolRow key={scored.college.unitId} scored={scored} />
      ))}
    </View>
  );
}

export interface ReportPdfProps {
  report: Report;
}

export function ReportPdf({ report }: ReportPdfProps) {
  const generated = formatDate(report.generatedAt);
  return (
    <Document
      title={`College list for ${report.profile.name ?? "student"}`}
      author="College List Builder"
    >
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.brand}>College List Builder</Text>
        <View style={styles.headerRow}>
          <Text style={styles.studentName}>
            {report.profile.name ?? "Student college list"}
          </Text>
          <Text style={styles.generatedAt}>Generated {generated}</Text>
        </View>
        <Text style={styles.summary}>{profileSummary(report.profile)}</Text>
        <View style={styles.headerRule} />
        <BucketSection bucket="reach" schools={report.reach} />
        <BucketSection bucket="target" schools={report.target} />
        <BucketSection bucket="likely" schools={report.likely} />
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Data: US Dept of Education College Scorecard
          </Text>
          <Text style={styles.footerText}>Generated {generated}</Text>
        </View>
      </Page>
    </Document>
  );
}
