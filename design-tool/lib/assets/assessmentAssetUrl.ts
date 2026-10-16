// G-1 (docs/coteacher-gaps-2026-10-design.md, D-1): the staff-facing image URL
// for one asset of one assessment. Pure, so client components can build it;
// `lib/assets/assessmentAssets.ts` holds the server side.
export function assessmentAssetUrl(assessmentId: string, assetId: string): string {
  return (
    `/api/assessments/${encodeURIComponent(assessmentId.toLowerCase())}` +
    `/assets/${encodeURIComponent(assetId.toLowerCase())}`
  );
}
