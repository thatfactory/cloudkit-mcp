import { createHash, createPrivateKey, sign } from "node:crypto";
import { safeError } from "../errors.js";

/** Server-to-server signing credential resolved only after policy validation. */
export interface ServerKeyCredential {
  readonly keyId: string;
  readonly privateKeyPem: string;
}

/** Headers required by CloudKit server-to-server authentication. */
export interface ServerKeyHeaders {
  readonly "X-Apple-CloudKit-Request-KeyID": string;
  readonly "X-Apple-CloudKit-Request-ISO8601Date": string;
  readonly "X-Apple-CloudKit-Request-SignatureV1": string;
}

/** Formats the UTC timestamp used by CloudKit's canonical signature input. */
export function cloudKitTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Builds the documented CloudKit signature input from exact body bytes and path/query. */
export function serverKeySignatureInput(timestamp: string, body: Uint8Array, pathAndQuery: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64");
  return `${timestamp}:${bodyHash}:${pathAndQuery}`;
}

/** Signs one exact CloudKit request using ECDSA with SHA-256. */
export function signServerKeyRequest(
  credential: ServerKeyCredential,
  body: Uint8Array,
  pathAndQuery: string,
  date: Date,
): ServerKeyHeaders {
  if (!pathAndQuery.startsWith("/database/1/") || pathAndQuery.includes("#")) {
    throw safeError({
      code: "invalidInput",
      message: "The signing path is outside the CloudKit Web Services registry.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Use a registered CloudKit operation and validated context identifiers.",
    });
  }
  try {
    const timestamp = cloudKitTimestamp(date);
    const key = createPrivateKey({ key: credential.privateKeyPem, format: "pem" });
    const signature = sign("sha256", Buffer.from(serverKeySignatureInput(timestamp, body, pathAndQuery), "utf8"), {
      key,
      dsaEncoding: "der",
    }).toString("base64");
    return {
      "X-Apple-CloudKit-Request-KeyID": credential.keyId,
      "X-Apple-CloudKit-Request-ISO8601Date": timestamp,
      "X-Apple-CloudKit-Request-SignatureV1": signature,
    };
  } catch {
    throw safeError({
      code: "authenticationRequired",
      message: "The configured CloudKit server key could not sign the request.",
      execution: "notStarted",
      sessionEffect: "unchanged",
      retryable: false,
      retryConditions: [],
      nextStep: "Import a valid P-256 CloudKit server-to-server private key for this profile.",
    });
  }
}
