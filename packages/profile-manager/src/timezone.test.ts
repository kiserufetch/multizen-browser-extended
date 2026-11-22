import { test } from "node:test";
import assert from "node:assert/strict";
import { localeCatalog } from "./fingerprint.js";
import { canonicalTimeZone, findSameTimeZone, sameTimeZone } from "./timezone.js";

test("a catalog zone and the spelling Chromium's ICU reports for it are the same zone", () => {
  const pairs: Array<[string, string]> = [
    ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
  ];
  for (const [iana, icu] of pairs) {
    assert.ok(sameTimeZone(iana, icu), `${iana} ~ ${icu}`);
    assert.ok(sameTimeZone(icu, iana), `${icu} ~ ${iana}`);
  }
});

test("different zones stay different, even with the same offset", () => {
  assert.equal(sameTimeZone("America/Argentina/Buenos_Aires", "America/Sao_Paulo"), false);
  assert.equal(sameTimeZone("Europe/Brussels", "Europe/Paris"), false);
  assert.equal(sameTimeZone("Asia/Kolkata", "Not/A_Zone"), false);
  assert.equal(sameTimeZone("Not/A_Zone", "Not/A_Zone"), true);
  assert.equal(canonicalTimeZone("Not/A_Zone"), null);
});

test("every catalog zone is known to ICU and matches its own canonical form", () => {
  for (const locale of localeCatalog()) {
    for (const tz of locale.timezones) {
      const canonical = canonicalTimeZone(tz);
      assert.ok(canonical, tz);
      assert.ok(sameTimeZone(tz, canonical), `${tz} ~ ${canonical}`);
    }
  }
});

test("findSameTimeZone returns the list's own spelling", () => {
  assert.equal(findSameTimeZone("Europe/Kiev", ["Europe/Warsaw", "Europe/Kyiv"]), "Europe/Kyiv");
  assert.equal(findSameTimeZone("Europe/Kiev", ["Europe/Warsaw"]), undefined);
});
