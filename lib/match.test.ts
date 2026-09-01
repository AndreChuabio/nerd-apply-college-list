// Unit tests for the deterministic matcher. Synthetic fixtures only; these
// tests must never import data/colleges.json or lib/colleges.ts.
// Run with: node --import tsx --test lib/match.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { actToSat, buildFallbackRationale, matchColleges } from "./match";
import type { College, ScoredCollege, StudentProfile } from "./types";

function makeProfile(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    name: null,
    gpa: null,
    satTotal: null,
    actComposite: null,
    interests: [],
    homeState: null,
    prefersNearHome: false,
    prefersWarmClimate: false,
    sizePreference: null,
    learningStyle: null,
    needsFinancialAid: false,
    narrativeHighlights: [],
    ...overrides,
  };
}

function makeCollege(overrides: Partial<College> = {}): College {
  return {
    unitId: 1,
    name: "Synthetic University",
    city: "Testville",
    state: "OH",
    control: "public",
    admitRate: 0.5,
    satReading25: null,
    satReading75: null,
    satMath25: null,
    satMath75: null,
    satAvg: null,
    actComposite25: null,
    actComposite75: null,
    actCompositeMid: null,
    tuitionInState: null,
    tuitionOutOfState: null,
    avgNetPrice: null,
    undergradSize: null,
    locale: null,
    gradRate: null,
    medianEarnings10yr: null,
    programShares: {},
    ...overrides,
  };
}

// Middle 50 percent windows: 1300-1480, 1150-1350, 1000-1200.
function threeTierSchools(): College[] {
  return [
    makeCollege({
      unitId: 101,
      name: "Reach University",
      satReading25: 650,
      satMath25: 650,
      satReading75: 740,
      satMath75: 740,
    }),
    makeCollege({
      unitId: 102,
      name: "Target University",
      satReading25: 575,
      satMath25: 575,
      satReading75: 675,
      satMath75: 675,
    }),
    makeCollege({
      unitId: 103,
      name: "Likely University",
      satReading25: 500,
      satMath25: 500,
      satReading75: 600,
      satMath75: 600,
    }),
  ];
}

function names(list: ScoredCollege[]): string[] {
  return list.map((scored) => scored.college.name);
}

test("actToSat hits the concordance anchors and interpolates between them", () => {
  assert.equal(actToSat(36), 1590);
  assert.equal(actToSat(30), 1360);
  assert.equal(actToSat(24), 1160);
  assert.equal(actToSat(18), 960);
  assert.equal(actToSat(27), 1260);
  assert.equal(actToSat(33), 1475);
});

test("a 1230 SAT student sees reach, target, and likely buckets by mid-50 window", () => {
  const result = matchColleges(makeProfile({ satTotal: 1230 }), threeTierSchools());
  assert.deepEqual(names(result.reach), ["Reach University"]);
  assert.deepEqual(names(result.target), ["Target University"]);
  assert.deepEqual(names(result.likely), ["Likely University"]);
});

test("an admit rate under 15 percent forces reach even for a 1550 student", () => {
  const elite = makeCollege({
    unitId: 201,
    name: "Ultra Selective College",
    admitRate: 0.08,
    satReading25: 500,
    satMath25: 500,
    satReading75: 600,
    satMath75: 600,
  });
  const result = matchColleges(makeProfile({ satTotal: 1550 }), [elite]);
  assert.deepEqual(names(result.reach), ["Ultra Selective College"]);
  assert.equal(result.reach[0].bucket, "reach");
  assert.match(result.reach[0].components[0].detail, /reach for every applicant/);
  assert.equal(result.target.length, 0);
  assert.equal(result.likely.length, 0);
});

test("a selective school stays a target even when a 1550 student clears its window", () => {
  // Window 1240 to 1400, admit rate 22.4 percent: the score clears the window
  // but the school still rejects most applicants, so likely would overstate it.
  const selective = makeCollege({
    unitId: 701,
    name: "Selective Window College",
    admitRate: 0.224,
    satReading25: 620,
    satMath25: 620,
    satReading75: 700,
    satMath75: 700,
  });
  const result = matchColleges(makeProfile({ satTotal: 1550 }), [selective]);
  assert.deepEqual(names(result.target), ["Selective Window College"]);
  assert.equal(result.target[0].bucket, "target");
  assert.match(result.target[0].components[0].detail, /22 percent admit rate/);
  assert.equal(result.likely.length, 0);
});

test("a school with no test data falls back to admit-rate banding without throwing", () => {
  const noData = makeCollege({ unitId: 301, name: "Opaque College", admitRate: 0.45 });
  const result = matchColleges(makeProfile({ satTotal: 1230 }), [noData]);
  assert.deepEqual(names(result.target), ["Opaque College"]);
  assert.match(result.target[0].components[0].detail, /45 percent admit rate/);
});

test("an ACT-only student gets a sane index and buckets like the equivalent SAT", () => {
  // ACT 27 converts to a 1260 index: below 1300, inside 1150-1350, above 1200.
  const result = matchColleges(makeProfile({ actComposite: 27 }), threeTierSchools());
  assert.deepEqual(names(result.reach), ["Reach University"]);
  assert.deepEqual(names(result.target), ["Target University"]);
  assert.deepEqual(names(result.likely), ["Likely University"]);
  assert.match(result.target[0].components[0].detail, /27 ACT \(about 1260 on the SAT scale\)/);
});

test("a warm-climate preference ranks a Florida school above an equal Minnesota school", () => {
  const florida = makeCollege({
    unitId: 401,
    name: "Florida School",
    state: "FL",
    satReading25: 575,
    satMath25: 575,
    satReading75: 675,
    satMath75: 675,
  });
  const minnesota = makeCollege({
    unitId: 402,
    name: "Minnesota School",
    state: "MN",
    satReading25: 575,
    satMath25: 575,
    satReading75: 675,
    satMath75: 675,
  });
  const [reachAnchor, , likelyAnchor] = threeTierSchools();
  const result = matchColleges(
    makeProfile({ satTotal: 1230, prefersWarmClimate: true }),
    [minnesota, reachAnchor, florida, likelyAnchor]
  );
  assert.deepEqual(names(result.target), ["Florida School", "Minnesota School"]);
  assert.ok(result.target[0].score > result.target[1].score);
});

test("a student with no test scores is bucketed on admit-rate bands without throwing", () => {
  const schools = [
    makeCollege({ unitId: 501, name: "Selective College", admitRate: 0.2 }),
    makeCollege({ unitId: 502, name: "Moderate College", admitRate: 0.45 }),
    makeCollege({ unitId: 503, name: "Open College", admitRate: 0.7 }),
  ];
  const result = matchColleges(makeProfile(), schools);
  assert.deepEqual(names(result.reach), ["Selective College"]);
  assert.deepEqual(names(result.target), ["Moderate College"]);
  assert.deepEqual(names(result.likely), ["Open College"]);
  assert.match(result.reach[0].components[0].detail, /No test scores were provided/);
});

test("the fallback rationale is grounded in profile and college numbers", () => {
  const profile = makeProfile({ satTotal: 1230, prefersWarmClimate: true });
  const florida = makeCollege({
    unitId: 601,
    name: "Florida School",
    state: "FL",
    satReading25: 575,
    satMath25: 575,
    satReading75: 675,
    satMath75: 675,
  });
  const result = matchColleges(profile, [florida]);
  const scored = result.target[0];
  assert.equal(scored.rationaleSource, "fallback");
  assert.equal(scored.rationale, buildFallbackRationale(scored, profile));
  assert.match(scored.rationale, /Florida location fits your warm climate preference/);
  assert.match(scored.rationale, /Your 1230 SAT sits inside its middle 50 percent range of 1150 to 1350\./);
});
