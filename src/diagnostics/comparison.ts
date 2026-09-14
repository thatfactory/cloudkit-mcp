import type { RecordObservation, ViewObservation } from "../domain/types.js";

/** Evidence-based category returned by cross-view comparison. */
export type ComparisonCategory =
  | "matchingObservedMetadata"
  | "visibilityMismatch"
  | "environmentMismatch"
  | "uploadFailureNotEstablished"
  | "clientEvidenceRequired"
  | "manualInspectionRequired"
  | "inconclusive";

/** One comparison conclusion with its bounded evidence and limitations. */
export interface ComparisonConclusion {
  readonly category: ComparisonCategory;
  readonly confidence: "high" | "medium" | "low";
  readonly recordSelector: string;
  readonly evidence: readonly string[];
  readonly limitations: readonly string[];
  readonly nextStep: string;
}

/** Compares two already-authorized observations without performing I/O. */
export function compareObservations(left: ViewObservation, right: ViewObservation): readonly ComparisonConclusion[] {
  if (left.view.containerId !== right.view.containerId || left.view.environment !== right.view.environment) {
    return [{
      category: "environmentMismatch",
      confidence: "high",
      recordSelector: "all",
      evidence: ["The selected container or environment differs between the two explicit views."],
      limitations: [...left.limitations, ...right.limitations],
      nextStep: "Select matching container and environment contexts, or explicitly interpret this as a cross-environment diagnostic.",
    }];
  }

  const selectors = new Set([...Object.keys(left.records), ...Object.keys(right.records)]);
  const conclusions: ComparisonConclusion[] = [];
  for (const selector of selectors) {
    const leftRecord = left.records[selector];
    const rightRecord = right.records[selector];
    conclusions.push(compareRecord(selector, leftRecord, rightRecord, left, right));
  }
  if (conclusions.length === 0) {
    conclusions.push({
      category: "inconclusive",
      confidence: "low",
      recordSelector: "all",
      evidence: ["Neither bounded observation contains a corresponding record selector."],
      limitations: [...left.limitations, ...right.limitations],
      nextStep: "Perform exact named lookups in both explicitly authorized views.",
    });
  }
  return conclusions;
}

function compareRecord(
  selector: string,
  left: RecordObservation | undefined,
  right: RecordObservation | undefined,
  leftView: ViewObservation,
  rightView: ViewObservation,
): ComparisonConclusion {
  const limitations = [...leftView.limitations, ...rightView.limitations];
  if (leftView.view.principalAlias === rightView.view.principalAlias) limitations.push("Both profiles resolve to the same authenticated principal; this is not an owner-versus-participant observation.");
  if (leftView.identityMapping !== "verified" || rightView.identityMapping !== "verified") {
    return {
      category: "inconclusive",
      confidence: "low",
      recordSelector: selector,
      evidence: ["Record correspondence or principal identity is not verified."],
      limitations,
      nextStep: "Verify owner-aware zone and principal correspondence before interpreting visibility.",
    };
  }
  if (leftView.view.principalAlias === rightView.view.principalAlias) {
    return {
      category: "inconclusive",
      confidence: "high",
      recordSelector: selector,
      evidence: ["Both profiles resolve to the same authenticated principal."],
      limitations,
      nextStep: "Use two independently authenticated principals before interpreting this as an owner-versus-participant comparison.",
    };
  }
  if (left?.outcome === "inaccessible" || left?.outcome === "unknown" || right?.outcome === "inaccessible" || right?.outcome === "unknown") {
    return {
      category: "inconclusive",
      confidence: "low",
      recordSelector: selector,
      evidence: ["At least one view returned an inaccessible or unknown per-record observation."],
      limitations,
      nextStep: "Restore authorization or provider compatibility and repeat the exact lookup before interpreting visibility or absence.",
    };
  }
  if (left?.outcome === "present" && right?.outcome === "present") {
    const matching = left.changeTag !== undefined && left.changeTag === right.changeTag;
    return {
      category: matching ? "matchingObservedMetadata" : "inconclusive",
      confidence: matching ? "medium" : "low",
      recordSelector: selector,
      evidence: matching
        ? ["Both authorized views observed the corresponding record with the same available change tag."]
        : ["Both authorized views observed the corresponding record, but available metadata differs or is incomplete."],
      limitations: ["Observations are not transactional and change-tag comparability does not prove full payload equality.", ...limitations],
      nextStep: matching ? "Use app-local evidence if the client still appears stale." : "Compare bounded selected fields or collect client-side synchronization evidence.",
    };
  }
  if (left?.outcome === "present" || right?.outcome === "present") {
    const other = left?.outcome === "present" ? right : left;
    if (other === undefined) {
      return {
        category: "inconclusive",
        confidence: "low",
        recordSelector: selector,
        evidence: ["One view observed the record, but the other observation was incomplete or failed."],
        limitations,
        nextStep: "Restore the failed authorization or response path and repeat the exact lookup without discarding the successful evidence.",
      };
    }
    return {
      category: "visibilityMismatch",
      confidence: "medium",
      recordSelector: selector,
      evidence: ["The record was present in one authorized view and explicitly not found in the other."],
      limitations: ["This does not establish upload failure or global nonexistence.", ...limitations],
      nextStep: "Inspect sharing permission and perform exact lookup in the non-observing view; use client logs to assess upload state.",
    };
  }
  return {
    category: "uploadFailureNotEstablished",
    confidence: "high",
    recordSelector: selector,
    evidence: ["Neither bounded remote observation positively established the record in both views."],
    limitations: ["Remote absence alone cannot establish whether a client upload failed.", ...limitations],
    nextStep: "Collect the originating client's upload queue, CKSyncEngine state, and privacy-safe logs.",
  };
}
