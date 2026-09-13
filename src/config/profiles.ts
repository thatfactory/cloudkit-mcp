import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { safeError } from "../errors.js";
import type { Profile } from "../domain/types.js";

const identifier = z.string().min(1).max(255).regex(/^[A-Za-z0-9._:-]+$/);
const cloudKitContainer = z.string().min(8).max(255).regex(/^iCloud\.[A-Za-z0-9.-]+$/);
const fieldName = z.string().min(1).max(255).regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);

const recordPolicySchema = z
  .object({
    allowedTypes: z.array(fieldName).max(64).default([]),
    queryableFields: z.array(fieldName).max(64).default([]),
    readablePayloadFields: z.array(fieldName).max(64).default([]),
    discloseRecordNames: z.boolean().default(false),
    discloseZoneNames: z.boolean().default(false),
  })
  .strict();

const profileSchema = z
  .object({
    id: identifier,
    containerId: cloudKitContainer,
    environment: z.enum(["development", "production"]),
    backend: z.literal("web-services"),
    authenticationMode: z.enum(["server-key", "web-user", "api-token-public"]),
    credentialRef: identifier,
    allowedScopes: z.array(z.enum(["public", "private", "shared"])).min(1).max(3),
    recordPolicy: recordPolicySchema.default({ allowedTypes: [], queryableFields: [], readablePayloadFields: [], discloseRecordNames: false, discloseZoneNames: false }),
  })
  .strict()
  .superRefine((profile, context) => {
    const scopes = new Set(profile.allowedScopes);
    if (scopes.size !== profile.allowedScopes.length) {
      context.addIssue({ code: "custom", message: "allowedScopes contains duplicates", path: ["allowedScopes"] });
    }
    if (profile.authenticationMode !== "web-user" && [...scopes].some((scope) => scope !== "public")) {
      context.addIssue({ code: "custom", message: "only web-user authentication may authorize private or shared scopes", path: ["allowedScopes"] });
    }
    for (const field of profile.recordPolicy.queryableFields) {
      if (!profile.recordPolicy.allowedTypes.length) {
        context.addIssue({ code: "custom", message: `queryable field ${field} requires at least one allowed record type`, path: ["recordPolicy", "queryableFields"] });
      }
    }
  });

const profilesDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(profileSchema).min(1).max(32),
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.profiles.forEach((profile, index) => {
      if (seen.has(profile.id)) {
        context.addIssue({ code: "custom", message: "profile id must be unique", path: ["profiles", index, "id"] });
      }
      seen.add(profile.id);
    });
  });

/** Parsed startup profile document. */
export interface ProfilesDocument {
  readonly schemaVersion: 1;
  readonly profiles: readonly Profile[];
}

/** Parses and validates an untrusted profile document without resolving credentials. */
export function parseProfilesDocument(input: unknown): ProfilesDocument {
  const parsed = profilesDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw safeError({
      code: "invalidConfiguration",
      message: "The profile configuration does not match the supported schema.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Correct the profile file using the documented schema; never place secret values in it.",
    });
  }
  return parsed.data;
}

/** Loads an explicitly selected local profile file with a bounded byte limit. */
export async function loadProfilesFile(path: string, maximumBytes = 64 * 1024): Promise<ProfilesDocument> {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength > maximumBytes) {
    throw safeError({
      code: "invalidConfiguration",
      message: "The profile configuration exceeds the local size limit.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Reduce the configuration to the documented profile and policy fields.",
    });
  }
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw safeError({
      code: "invalidConfiguration",
      message: "The profile configuration is not valid UTF-8 JSON.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Replace the file with a valid JSON profile document.",
    });
  }
  return parseProfilesDocument(input);
}

/** Resolves a profile by its explicit identifier. */
export function requireProfile(document: ProfilesDocument, id: string): Profile {
  const profile = document.profiles.find((candidate) => candidate.id === id);
  if (!profile) {
    throw safeError({
      code: "invalidInput",
      message: "The selected profile is not configured.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Select an id returned by get_context.",
    });
  }
  return profile;
}
