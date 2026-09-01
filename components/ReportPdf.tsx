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
  ScoreComponent,
  ScoredCollege,
  StudentProfile,
} from "@/lib/types";

// Prose-cased program phrases used inside sentences. Deliberately separate
// from the display labels in app/page.tsx: these are written to sit
// mid-sentence ("an academic interest in computer science").
const PROGRAM_PHRASES: Record<ProgramArea, string> = {
  "computer-science": "computer science",
  engineering: "engineering",
  biology: "biology",
  "marine-biology": "marine biology",
  "natural-resources": "natural resources",
  business: "business",
  health: "health",
  psychology: "psychology",
  "visual-performing-arts": "visual and performing arts",
  mathematics: "mathematics",
  "physical-sciences": "physical sciences",
  "social-sciences": "social sciences",
  english: "English",
  history: "history",
  education: "education",
  communications: "communications",
  undecided: "a major still to be decided",
};

const BUCKET_TITLES: Record<Bucket, string> = {
  reach: "Reach",
  target: "Target",
  likely: "Likely",
};

// Short reminders repeated in each section header so the meaning travels
// with the section onto page two.
const BUCKET_NOTES: Record<Bucket, string> = {
  reach: "Admission is a stretch, worth one strong application",
  target: "Your profile sits inside the typical admitted range",
  likely: "You are above the typical admitted range",
};

// Plain-language guide shown once under the masthead.
const READING_GUIDE: ReadonlyArray<{ bucket: Bucket; sentence: string }> = [
  {
    bucket: "reach",
    sentence:
      "Admission is a stretch based on the published numbers, and each one is worth a single strong, well-prepared application.",
  },
  {
    bucket: "target",
    sentence:
      "Your profile sits inside the typical admitted range, so these schools form the core of the list.",
  },
  {
    bucket: "likely",
    sentence:
      "You are above the typical admitted range here, which puts you in a strong position.",
  },
];

// ---------- Text assembly helpers (facts from the data only) ----------

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function profileSummary(profile: StudentProfile): string {
  const facts: string[] = [];
  if (profile.gpa !== null) {
    facts.push(`a ${profile.gpa.toFixed(1)} GPA`);
  }
  if (profile.satTotal !== null) {
    facts.push(`a ${profile.satTotal} SAT`);
  }
  if (profile.actComposite !== null) {
    facts.push(`a ${profile.actComposite} ACT composite`);
  }
  const interests = profile.interests
    .filter((area) => area !== "undecided")
    .map((area) => PROGRAM_PHRASES[area]);
  if (interests.length > 0) {
    facts.push(`an academic interest in ${joinWithAnd(interests)}`);
  } else if (profile.interests.includes("undecided")) {
    facts.push("a major still to be decided");
  }
  if (profile.homeState !== null) {
    facts.push(`a home state of ${profile.homeState}`);
  }

  const first =
    facts.length > 0
      ? `This list was built for ${
          profile.name ?? "this student"
        } from the profile on file: ${joinWithAnd(facts)}.`
      : `This list was built for ${
          profile.name ?? "this student"
        } from the profile on file.`;

  const preferences: string[] = [];
  if (profile.learningStyle === "hands-on") {
    preferences.push("hands-on, project-driven programs");
  } else if (profile.learningStyle === "research") {
    preferences.push("research-driven programs");
  } else if (profile.learningStyle === "balanced") {
    preferences.push("programs balancing coursework and applied work");
  }
  if (profile.sizePreference === "small") {
    preferences.push("smaller campuses");
  } else if (profile.sizePreference === "medium") {
    preferences.push("mid-sized campuses");
  } else if (profile.sizePreference === "large") {
    preferences.push("larger campuses");
  }
  if (profile.prefersNearHome) {
    preferences.push("campuses within easy reach of home");
  }
  if (profile.prefersWarmClimate) {
    preferences.push("warmer locations");
  }
  if (profile.needsFinancialAid) {
    preferences.push("schools with strong aid and a manageable net price");
  }
  if (preferences.length === 0) {
    return first;
  }
  return `${first} The matching leaned toward ${joinWithAnd(preferences)}.`;
}

// ---------- Stats line (rendered only from the college row) ----------

function statsLine(college: College): string {
  const parts: string[] = [];
  if (college.admitRate !== null) {
    parts.push(`Admit rate ${Math.round(college.admitRate * 100)}%`);
  }
  const { satReading25, satReading75, satMath25, satMath75 } = college;
  if (
    satReading25 !== null &&
    satReading75 !== null &&
    satMath25 !== null &&
    satMath75 !== null
  ) {
    parts.push(
      `SAT mid-50 ${satReading25 + satMath25}–${satReading75 + satMath75}`
    );
  }
  if (college.avgNetPrice !== null) {
    parts.push(
      `Avg net price $${college.avgNetPrice.toLocaleString("en-US")}/yr`
    );
  }
  if (college.undergradSize !== null) {
    parts.push(`${college.undergradSize.toLocaleString("en-US")} undergrads`);
  }
  if (college.gradRate !== null) {
    parts.push(`Grad rate ${Math.round(college.gradRate * 100)}%`);
  }
  return parts.join("   ·   ");
}

function locationLine(college: College): string {
  const control = college.control === "public" ? "Public" : "Private";
  return `${college.city}, ${college.state}  ·  ${control}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ---------- Palette and styles ----------

const NAVY = "#1A2438";
const EMERALD = "#157A5A";
const INK = "#26241F";
const GRAY = "#6C675E";
const HAIRLINE = "#DEDAD2";

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 64,
    paddingHorizontal: 54,
    backgroundColor: "#FFFFFF",
    fontFamily: "Helvetica",
    fontSize: 8.5,
    color: INK,
  },

  // Masthead
  mastheadBar: {
    borderTopWidth: 2.4,
    borderTopColor: NAVY,
  },
  mastheadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingTop: 7,
    paddingBottom: 7,
    borderBottomWidth: 0.7,
    borderBottomColor: NAVY,
  },
  wordmark: {
    fontFamily: "Times-Bold",
    fontSize: 13,
    letterSpacing: 3.2,
    textTransform: "uppercase",
    color: NAVY,
  },
  preparedDate: {
    fontFamily: "Helvetica",
    fontSize: 7,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: GRAY,
  },
  studentName: {
    fontFamily: "Times-Bold",
    fontSize: 23,
    color: NAVY,
    marginTop: 10,
  },
  framingLine: {
    fontFamily: "Times-Italic",
    fontSize: 9,
    color: GRAY,
    marginTop: 3,
  },
  summary: {
    fontFamily: "Helvetica",
    fontSize: 8.5,
    lineHeight: 1.45,
    color: INK,
    marginTop: 8,
  },

  // Reading guide
  guide: {
    marginTop: 10,
    borderTopWidth: 0.7,
    borderTopColor: HAIRLINE,
    borderBottomWidth: 0.7,
    borderBottomColor: HAIRLINE,
    paddingVertical: 7,
  },
  guideLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 6.5,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: NAVY,
    marginBottom: 4,
  },
  guideRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 2,
  },
  guideBand: {
    fontFamily: "Helvetica-Bold",
    fontSize: 6.8,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: EMERALD,
    width: 46,
    marginTop: 1,
  },
  guideSentence: {
    flex: 1,
    fontFamily: "Times-Roman",
    fontSize: 9,
    lineHeight: 1.25,
    color: INK,
  },

  // Sections
  section: {
    marginTop: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    borderBottomWidth: 0.9,
    borderBottomColor: NAVY,
    paddingBottom: 3.5,
  },
  sectionTitleGroup: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  sectionTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: EMERALD,
  },
  sectionNote: {
    fontFamily: "Times-Italic",
    fontSize: 8,
    color: GRAY,
    marginLeft: 10,
  },
  sectionCount: {
    fontFamily: "Helvetica",
    fontSize: 6.8,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: GRAY,
  },

  // School rows
  schoolRow: {
    paddingTop: 6,
    paddingBottom: 6,
  },
  schoolRowRule: {
    borderTopWidth: 0.6,
    borderTopColor: HAIRLINE,
  },
  schoolTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  schoolName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: NAVY,
    flex: 1,
    paddingRight: 12,
  },
  schoolPlace: {
    fontFamily: "Helvetica",
    fontSize: 7.2,
    color: GRAY,
  },
  schoolStats: {
    fontFamily: "Helvetica",
    fontSize: 6.8,
    letterSpacing: 0.2,
    color: GRAY,
    marginTop: 2.5,
  },
  rationale: {
    fontFamily: "Times-Roman",
    fontSize: 9,
    lineHeight: 1.3,
    color: INK,
    marginTop: 3.5,
  },
  whyBlock: {
    marginTop: 3.5,
    paddingLeft: 9,
    borderLeftWidth: 0.8,
    borderLeftColor: HAIRLINE,
  },
  whyLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 5.8,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    color: GRAY,
    marginBottom: 1.5,
  },
  whyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 1,
  },
  whyMarker: {
    fontFamily: "Helvetica",
    fontSize: 7,
    color: GRAY,
    width: 8,
  },
  whyText: {
    flex: 1,
    fontFamily: "Helvetica",
    fontSize: 7,
    lineHeight: 1.28,
    color: GRAY,
  },
  whyStrong: {
    fontFamily: "Helvetica-Bold",
    color: INK,
  },

  // Closing mark
  closing: {
    marginTop: 16,
    alignItems: "center",
  },
  closingRule: {
    width: 34,
    borderTopWidth: 0.8,
    borderTopColor: EMERALD,
    marginBottom: 6,
  },
  closingWordmark: {
    fontFamily: "Times-Bold",
    fontSize: 8,
    letterSpacing: 3,
    textTransform: "uppercase",
    color: EMERALD,
  },

  // Footer
  footer: {
    position: "absolute",
    bottom: 30,
    left: 54,
    right: 54,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.6,
    borderTopColor: HAIRLINE,
    paddingTop: 6,
  },
  footerText: {
    fontFamily: "Helvetica",
    fontSize: 6.5,
    color: GRAY,
  },
});

// ---------- Components ----------

interface WhyBulletProps {
  component: ScoreComponent;
}

function WhyBullet({ component }: WhyBulletProps) {
  return (
    <View style={styles.whyRow}>
      <Text style={styles.whyMarker}>{"–"}</Text>
      <Text style={styles.whyText}>
        <Text style={styles.whyStrong}>{component.label}</Text>
        {"  —  "}
        {component.detail}
      </Text>
    </View>
  );
}

interface SchoolRowProps {
  scored: ScoredCollege;
  first: boolean;
}

function SchoolRow({ scored, first }: SchoolRowProps) {
  const { college } = scored;
  const rowStyle = first
    ? styles.schoolRow
    : [styles.schoolRow, styles.schoolRowRule];
  return (
    <View style={rowStyle} wrap={false}>
      <View style={styles.schoolTopLine}>
        <Text style={styles.schoolName}>{college.name}</Text>
        <Text style={styles.schoolPlace}>{locationLine(college)}</Text>
      </View>
      <Text style={styles.schoolStats}>{statsLine(college)}</Text>
      <Text style={styles.rationale}>{scored.rationale}</Text>
      {scored.components.length > 0 && (
        <View style={styles.whyBlock}>
          <Text style={styles.whyLabel}>Why this made your list</Text>
          {scored.components.map((component, index) => (
            <WhyBullet key={`${component.label}-${index}`} component={component} />
          ))}
        </View>
      )}
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
  const count = schools.length === 1 ? "1 school" : `${schools.length} schools`;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader} minPresenceAhead={96}>
        <View style={styles.sectionTitleGroup}>
          <Text style={styles.sectionTitle}>{BUCKET_TITLES[bucket]}</Text>
          <Text style={styles.sectionNote}>{BUCKET_NOTES[bucket]}</Text>
        </View>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {schools.map((scored, index) => (
        <SchoolRow
          key={scored.college.unitId}
          scored={scored}
          first={index === 0}
        />
      ))}
    </View>
  );
}

export interface ReportPdfProps {
  report: Report;
}

export function ReportPdf({ report }: ReportPdfProps) {
  const generated = formatDate(report.generatedAt);
  const studentName = report.profile.name ?? "Student college list";
  return (
    <Document
      title={`College list for ${report.profile.name ?? "student"}`}
      author="College List Builder"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.mastheadBar} />
        <View style={styles.mastheadRow}>
          <Text style={styles.wordmark}>College List</Text>
          <Text style={styles.preparedDate}>Prepared {generated}</Text>
        </View>
        <Text style={styles.studentName}>{studentName}</Text>
        <Text style={styles.framingLine}>
          A counselor-style report on where to apply and why, drawn from this
          profile and public College Scorecard data.
        </Text>
        <Text style={styles.summary}>{profileSummary(report.profile)}</Text>

        <View style={styles.guide}>
          <Text style={styles.guideLabel}>How to read this list</Text>
          {READING_GUIDE.map(({ bucket, sentence }) => (
            <View key={bucket} style={styles.guideRow}>
              <Text style={styles.guideBand}>{BUCKET_TITLES[bucket]}</Text>
              <Text style={styles.guideSentence}>{sentence}</Text>
            </View>
          ))}
        </View>

        <BucketSection bucket="reach" schools={report.reach} />
        <BucketSection bucket="target" schools={report.target} />
        <BucketSection bucket="likely" schools={report.likely} />

        <View style={styles.closing} wrap={false}>
          <View style={styles.closingRule} />
          <Text style={styles.closingWordmark}>College List</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Data: US Department of Education College Scorecard
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Generated ${generated}  ·  Page ${pageNumber} of ${totalPages}`
            }
            fixed
          />
        </View>
      </Page>
    </Document>
  );
}

export default ReportPdf;
