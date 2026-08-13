// Which failures retire an entry, and which must never.
//
//   deno test --allow-read supabase/functions/expeditions/handler.test.ts
//
// A permanent failure deletes field evidence. The queue stops asking, the entry
// leaves the queue, and the observation — already photographed, already uploaded
// to R2 — is never assessed. So the question this file asks of every message is
// narrow: is this the ENTRY'S fault, or OURS?
//
// It was nearly answered wrongly. `isPermanent` matched `/not found/i`, and
// PostgREST's message for an RPC in the wrong schema is "Could not find the
// function enterprise.upsert_mission_package in the schema cache". "not find",
// not "not found" — one letter between a schema-name mistake and every finished
// section on every phone being silently discarded. That mistake was made three
// times in one day.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isPermanent } from "./handler.ts";

Deno.test("the entry's own fault is permanent — retrying cannot change the data", () => {
  // Each of these is a fact about what was sent, and it will be identical next time.
  assertEquals(isPermanent("no_data_found: expedition ex-1 is not open"), true);
  assertEquals(isPermanent("invalid_parameter_value: p_started is null"), true);
  assertEquals(isPermanent("a track needs at least two points"), true);
  assertEquals(isPermanent("invalid input syntax for type uuid"), true);
  assertEquals(isPermanent("new row violates check constraint"), true);
});

Deno.test("OUR fault is never permanent, however it reads", () => {
  // THE ONE THAT MATTERS. This message used to slip past `/not found/i` only by
  // luck of spelling; now it is refused on purpose.
  assertEquals(
    isPermanent("Could not find the function enterprise.upsert_mission_package(p_actor, p_package) in the schema cache"),
    false,
  );
  assertEquals(isPermanent("permission denied for table mission_package"), false);
  assertEquals(isPermanent("PostgREST schema cache is stale"), false);
});

Deno.test("a signed-out or unentitled account keeps its queue", () => {
  // Against the obvious reading, and deliberately. A token without the entitlement
  // is not the observation's fault and it is not for ever: the account is enabled,
  // the geologist signs in again, and the day's work should still be waiting.
  assertEquals(isPermanent("JWT expired"), false);
  assertEquals(isPermanent("unauthorized"), false);
  assertEquals(isPermanent("forbidden: this account is not enabled for field work"), false);
});

Deno.test("transport trouble keeps its queue", () => {
  assertEquals(isPermanent("fetch failed"), false);
  assertEquals(isPermanent("network request timed out"), false);
  assertEquals(isPermanent("socket hang up"), false);
  assertEquals(isPermanent("upstream returned 502"), false);
});

Deno.test("our fault WINS over a data fault in the same message", () => {
  // Order is the fix, not the word list. A message carrying both must be treated
  // as ours: the cost of one wasted retry is a retry; the cost of one wrong
  // retirement is a geologist's morning.
  assertEquals(
    isPermanent("permission denied for table geo.field_mission — invalid input"),
    false,
  );
});

Deno.test("an unrecognised message is NOT permanent", () => {
  // The default has to be "keep it". Anything else means every new error message
  // the database or the platform invents starts deleting evidence quietly.
  assertEquals(isPermanent("something nobody has seen before"), false);
  assertEquals(isPermanent(""), false);
});
