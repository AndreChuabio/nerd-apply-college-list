// One-time dataset builder: US College Scorecard institution CSV -> data/colleges.json.
//
// Source: https://ed-public-download.scorecard.network/downloads/Most-Recent-Cohorts-Institution_06102026.zip
// (the current zip is linked from https://collegescorecard.ed.gov/data; the date
// stamp in the filename rotates with each data release).
//
// Refresh instructions:
//   1. Download the current Most-Recent-Cohorts-Institution zip from the page above.
//   2. Unzip it somewhere outside the repo (the CSV is ~170MB and is not committed).
//   3. Run: npx tsx scripts/build-dataset.ts /path/to/Most-Recent-Cohorts-Institution_MMDDYYYY.csv
//
// Filters applied: currently operating, predominantly bachelor's-granting, public or
// private nonprofit, at least 500 undergrads, located in the 50 states plus DC, and
// at least one of SAT_AVG / ACTCMMID / ADM_RATE reported.

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse";
import type { College } from "../lib/types";

type RawRow = Record<string, string | undefined>;

// Single mapping point between Scorecard VARNAMEs and College fields. If the
// Department of Education renames a column, the header check below fails loudly
// before any rows are processed.
const NUMERIC_COLUMNS = {
  ADM_RATE: "admitRate",
  SATVR25: "satReading25",
  SATVR75: "satReading75",
  SATMT25: "satMath25",
  SATMT75: "satMath75",
  SAT_AVG: "satAvg",
  ACTCM25: "actComposite25",
  ACTCM75: "actComposite75",
  ACTCMMID: "actCompositeMid",
  TUITIONFEE_IN: "tuitionInState",
  TUITIONFEE_OUT: "tuitionOutOfState",
  UGDS: "undergradSize",
  LOCALE: "locale",
  C150_4: "gradRate",
} as const;

type NumericField = (typeof NUMERIC_COLUMNS)[keyof typeof NUMERIC_COLUMNS];

// Columns required by filters, identity fields, or coalescing rather than by the
// direct numeric mapping above.
const OTHER_REQUIRED_COLUMNS = [
  "UNITID",
  "INSTNM",
  "CITY",
  "STABBR",
  "CONTROL",
  "CURROPER",
  "PREDDEG",
  "NPT4_PUB",
  "NPT4_PRIV",
] as const;

// Present in most releases but occasionally moved between files; its absence is a
// warning, not a build failure.
const EARNINGS_COLUMN = "MD_EARN_WNE_P10";

const STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
  "WY",
]);

const MIN_ROWS = 800;
const MAX_ROWS = 3000;
const MIN_UNDERGRADS = 500;
const MIN_PCIP_COLUMNS = 30;

const warnedColumns = new Set<string>();

function parseNumeric(raw: string | undefined, column: string): number | null {
  // The 2026 release uses "NA" alongside the documented "NULL" and "PrivacySuppressed".
  if (
    raw === undefined ||
    raw === "" ||
    raw === "NULL" ||
    raw === "NA" ||
    raw === "PrivacySuppressed"
  ) {
    return null;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    if (!warnedColumns.has(column)) {
      warnedColumns.add(column);
      console.warn(`warning: non-numeric value "${raw}" in column ${column}; treating as null`);
    }
    return null;
  }
  return value;
}

function requireString(row: RawRow, column: string): string {
  const raw = row[column];
  if (raw === undefined || raw === "" || raw === "NULL") {
    throw new Error(`row ${row["UNITID"] ?? "?"} missing required value for ${column}`);
  }
  return raw;
}

function checkHeader(columns: string[]): { pcipColumns: string[]; hasEarnings: boolean } {
  const present = new Set(columns);
  const required: string[] = [...Object.keys(NUMERIC_COLUMNS), ...OTHER_REQUIRED_COLUMNS];
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new Error(
      `expected columns missing from CSV header (renamed upstream?): ${missing.join(", ")}`
    );
  }
  const pcipColumns = columns.filter((column) => /^PCIP\d{2}$/.test(column)).sort();
  if (pcipColumns.length < MIN_PCIP_COLUMNS) {
    throw new Error(
      `only ${pcipColumns.length} PCIP columns found (expected at least ${MIN_PCIP_COLUMNS}); header layout changed?`
    );
  }
  const hasEarnings = present.has(EARNINGS_COLUMN);
  if (!hasEarnings) {
    console.warn(
      `warning: column ${EARNINGS_COLUMN} absent; medianEarnings10yr will be null for all rows`
    );
  }
  return { pcipColumns, hasEarnings };
}

function passesFilters(row: RawRow): boolean {
  if (row["CURROPER"] !== "1") return false;
  if (row["PREDDEG"] !== "3") return false;
  const control = row["CONTROL"];
  if (control !== "1" && control !== "2") return false;
  const state = row["STABBR"];
  if (state === undefined || !STATES.has(state)) return false;
  const undergrads = parseNumeric(row["UGDS"], "UGDS");
  if (undergrads === null || undergrads < MIN_UNDERGRADS) return false;
  const hasAdmissionsSignal =
    parseNumeric(row["SAT_AVG"], "SAT_AVG") !== null ||
    parseNumeric(row["ACTCMMID"], "ACTCMMID") !== null ||
    parseNumeric(row["ADM_RATE"], "ADM_RATE") !== null;
  return hasAdmissionsSignal;
}

function toCollege(row: RawRow, pcipColumns: string[], hasEarnings: boolean): College {
  const numericFields = {} as Record<NumericField, number | null>;
  for (const [column, field] of Object.entries(NUMERIC_COLUMNS) as [
    keyof typeof NUMERIC_COLUMNS,
    NumericField,
  ][]) {
    numericFields[field] = parseNumeric(row[column], column);
  }

  const programShares: Record<string, number> = {};
  for (const column of pcipColumns) {
    const share = parseNumeric(row[column], column);
    if (share !== null) {
      programShares[column.toLowerCase()] = share;
    }
  }

  const unitId = parseNumeric(row["UNITID"], "UNITID");
  if (unitId === null) {
    throw new Error(`row with INSTNM "${row["INSTNM"] ?? "?"}" has no numeric UNITID`);
  }

  return {
    unitId,
    name: requireString(row, "INSTNM"),
    city: requireString(row, "CITY"),
    state: requireString(row, "STABBR"),
    control: row["CONTROL"] === "1" ? "public" : "private",
    ...numericFields,
    avgNetPrice:
      parseNumeric(row["NPT4_PUB"], "NPT4_PUB") ?? parseNumeric(row["NPT4_PRIV"], "NPT4_PRIV"),
    medianEarnings10yr: hasEarnings ? parseNumeric(row[EARNINGS_COLUMN], EARNINGS_COLUMN) : null,
    programShares,
  };
}

function nullRate(colleges: College[], field: NumericField | "avgNetPrice"): string {
  const nulls = colleges.filter((college) => college[field] === null).length;
  return `${((nulls / colleges.length) * 100).toFixed(1)}% (${nulls}/${colleges.length})`;
}

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (csvPath === undefined) {
    console.error("usage: npx tsx scripts/build-dataset.ts /path/to/Most-Recent-Cohorts-Institution.csv");
    process.exit(1);
  }

  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, bom: true, relaxColumnCount: false })
  );

  let headerInfo: { pcipColumns: string[]; hasEarnings: boolean } | null = null;
  let totalRows = 0;
  const colleges: College[] = [];

  for await (const record of parser as AsyncIterable<RawRow>) {
    if (headerInfo === null) {
      headerInfo = checkHeader(Object.keys(record));
    }
    totalRows += 1;
    if (!passesFilters(record)) continue;
    colleges.push(toCollege(record, headerInfo.pcipColumns, headerInfo.hasEarnings));
  }

  if (colleges.length < MIN_ROWS || colleges.length > MAX_ROWS) {
    throw new Error(
      `sanity check failed: ${colleges.length} colleges after filtering (expected ${MIN_ROWS}-${MAX_ROWS}); not writing output`
    );
  }

  colleges.sort((a, b) => a.unitId - b.unitId);

  const outPath = path.join(process.cwd(), "data", "colleges.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(colleges), "utf8");

  console.log(`rows read from CSV: ${totalRows}`);
  console.log(`colleges written: ${colleges.length} -> ${outPath}`);
  console.log(`null rate admitRate: ${nullRate(colleges, "admitRate")}`);
  console.log(`null rate satAvg: ${nullRate(colleges, "satAvg")}`);
  console.log(`null rate avgNetPrice: ${nullRate(colleges, "avgNetPrice")}`);
  console.log(`null rate undergradSize: ${nullRate(colleges, "undergradSize")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
