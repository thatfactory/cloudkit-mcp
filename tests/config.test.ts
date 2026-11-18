import assert from "node:assert/strict";
import test from "node:test";
import { parseProfilesDocument } from "../src/config/profiles.js";
import { CloudKitMCPError } from "../src/errors.js";

const valid = { schemaVersion: 1, profiles: [{ id: "owner", containerId: "iCloud.com.example.test", environment: "development", backend: "web-services", authenticationMode: "web-user", credentialRef: "owner", allowedScopes: ["private", "shared"], recordPolicy: { allowedTypes: ["Entry"], queryableFields: ["entryID"], readablePayloadFields: [] } }] };

test("strict profiles preserve explicit context and defaults", () => {
  const document = parseProfilesDocument(valid);
  assert.equal(document.profiles[0]?.environment, "development");
  assert.equal(document.profiles[0]?.recordPolicy.discloseRecordNames, false);
});

test("unknown fields and inline secrets fail before credential resolution", () => {
  assert.throws(() => parseProfilesDocument({ ...valid, profiles: [{ ...valid.profiles[0], password: "secret" }] }), CloudKitMCPError);
});

test("non-user credentials cannot silently authorize private scope", () => {
  assert.throws(() => parseProfilesDocument({ ...valid, profiles: [{ ...valid.profiles[0], authenticationMode: "api-token-public" }] }), CloudKitMCPError);
});

test("duplicate profile ids fail closed", () => {
  assert.throws(() => parseProfilesDocument({ ...valid, profiles: [valid.profiles[0], valid.profiles[0]] }), CloudKitMCPError);
});

test("shared credential slots cannot cross container, environment or authentication boundaries", () => {
  for (const changes of [{ containerId: "iCloud.com.example.other" }, { environment: "production" }, { authenticationMode: "api-token-public", allowedScopes: ["public"] }]) {
    assert.throws(() => parseProfilesDocument({ ...valid, profiles: [valid.profiles[0], { ...valid.profiles[0], ...changes, id: "second" }] }), CloudKitMCPError);
  }
  assert.equal(parseProfilesDocument({ ...valid, profiles: [valid.profiles[0], { ...valid.profiles[0], id: "second", allowedScopes: ["shared"] }] }).profiles.length, 2);
});
