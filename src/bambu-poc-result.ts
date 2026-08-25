/**
 * Bambu Studio POC — result extraction adapter. ISOLATED EXPERIMENT.
 *
 * Parses the slice_info.config embedded in Bambu Studio's *.gcode.3mf output
 * into the same three fields the application's SliceResult currently carries
 * (printTimeSeconds, filamentWeightGrams, supportUsed).
 *
 * This module is NOT imported by the production worker. The production
 * backend remains PrusaSlicer (src/slicer.ts, checkpoint prusa-a1-known-good).
 * Known limitation (accepted for POC): Bambu emits one combined filament line
 * for single-material jobs, so model/support splitting is not implemented yet.
 */

export interface BambuPocResult {
  /** Bambu `prediction`, seconds. null when missing/unparsable. */
  printTimeSeconds: number | null;
  /** Bambu `weight`, grams. null when missing/unparsable/empty. */
  filamentWeightGrams: number | null;
  /** True when any filament entry declares used_for_support="true". */
  supportUsed: boolean;
}

/** Parse slice_info.config content. Never throws; nulls signal failure so callers never fabricate zero-cost data. */
export function parseBambuSliceInfo(sliceInfoXml: string): BambuPocResult {
  const prediction = sliceInfoXml.match(/key="prediction"\s+value="(\d+)"/);
  const weight = sliceInfoXml.match(/key="weight"\s+value="([0-9]+(?:\.[0-9]+)?)"/);
  return {
    printTimeSeconds: prediction ? Number.parseInt(prediction[1], 10) : null,
    filamentWeightGrams: weight ? Number.parseFloat(weight[1]) : null,
    supportUsed: /used_for_support="true"/.test(sliceInfoXml),
  };
}

/** Validate a parsed result is complete enough for downstream pricing-style consumption. */
export function isCompleteBambuResult(r: BambuPocResult): boolean {
  return (
    r.printTimeSeconds !== null &&
    r.printTimeSeconds > 0 &&
    r.filamentWeightGrams !== null &&
    r.filamentWeightGrams >= 0
  );
}
