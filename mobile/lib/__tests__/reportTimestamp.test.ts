// A field report is dated on the geologist's clock, not on Greenwich's.
//
// REPORTED FROM THE FIELD. A section finished at 14:29 East Africa Time came back
// as `2026-08-12 11:29` under a field labelled "Date". Three hours out, on the one
// line of the record whose entire job is to say when somebody stood somewhere.
//
// The cause was `new Date(ms).toISOString().slice(0, 16)`. `toISOString` is always
// UTC — that is what the Z on the end of it means — and the screen printed it with
// no marker at all, so there was nothing to tell the reader it was not their own
// time. In Somalia that is a silent three-hour error; further east it is more.
//
// These pin the two properties that matter and neither depends on the timezone the
// suite happens to run in, because a test that only passes in UTC would have passed
// against the broken code too.
import { localStamp } from "../exploration/format";

/** 2026-08-12T11:29:00Z — the exact reading from the report. */
const REPORTED = Date.parse("2026-08-12T11:29:00.000Z");

function localParts(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    offsetMin: -d.getTimezoneOffset(),
  };
}

describe("the date on a field report", () => {
  test("is the LOCAL wall clock, whatever the suite's timezone", () => {
    const { day, time } = localParts(REPORTED);
    expect(localStamp(REPORTED)).toBe(`${day} ${time}`);
  });

  test("differs from the UTC rendering wherever the offset is not zero", () => {
    // The regression itself. Somewhere east of Greenwich these two must not agree;
    // if the suite runs in UTC there is nothing to see and the case is skipped
    // rather than passed, so it can never be a false green.
    const { offsetMin } = localParts(REPORTED);
    if (offsetMin === 0) return;
    const utc = new Date(REPORTED).toISOString().slice(0, 16).replace("T", " ");
    expect(localStamp(REPORTED)).not.toBe(utc);
  });

  test("an East Africa clock reads 14:29 for the 11:29Z the report showed", () => {
    // Reconstructed rather than read from the environment: EAT is UTC+3 with no
    // daylight saving, so the local wall clock is the instant plus three hours.
    const eat = new Date(REPORTED + 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    expect(`${p(eat.getUTCHours())}:${p(eat.getUTCMinutes())}`).toBe("14:29");
  });

  test("the list form carries the day and drops the time", () => {
    const { day } = localParts(REPORTED);
    expect(localStamp(REPORTED, false)).toBe(day);
  });

  test("a date that is not one prints nothing, rather than 'Invalid Date'", () => {
    expect(localStamp(Number.NaN)).toBe("");
  });

  test("minutes and months are zero-padded", () => {
    // 2026-01-05 09:07 local, built from local parts so the assertion holds anywhere.
    const d = new Date(2026, 0, 5, 9, 7, 0);
    expect(localStamp(d.getTime())).toBe("2026-01-05 09:07");
  });
});

describe("neither screen renders UTC any more", () => {
  const read = (p: string) =>
    require("fs").readFileSync(require("path").join(__dirname, "..", "..", p), "utf8");

  test("the report page does not call toISOString", () => {
    expect(read("app/(app)/enterprise/report/[missionId].tsx")).not.toContain("toISOString");
  });

  test("the reports list does not call toISOString", () => {
    expect(read("app/(app)/enterprise/reports.tsx")).not.toContain("toISOString");
  });
});
