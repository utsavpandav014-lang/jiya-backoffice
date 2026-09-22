import test from "node:test";
import assert from "node:assert/strict";
import { mustBlockForEmergency, normalizeEmergencyStatus } from "./emergencyLockdown.js";

test("normalizes the public emergency status response", () => {
  assert.deepEqual(normalizeEmergencyStatus({ enabled:true, enabledAt:"2026-09-22T10:00:00Z" }), {
    enabled:true, enabledAt:"2026-09-22T10:00:00Z", updatedAt:null,
  });
});

test("lockdown blocks clients and sub-admins but never the master admin", () => {
  const active={enabled:true};
  assert.equal(mustBlockForEmergency(active, null), true);
  assert.equal(mustBlockForEmergency(active, {role:"client"}), true);
  assert.equal(mustBlockForEmergency(active, {role:"admin"}), true);
  assert.equal(mustBlockForEmergency(active, {role:"superadmin"}), false);
  assert.equal(mustBlockForEmergency({enabled:false}, {role:"client"}), false);
});

