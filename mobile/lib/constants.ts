// Mirrors INSUFFICIENT_CONFIDENCE_MESSAGE in
// supabase/functions/orchestrate-scan/ensemble.ts. Kept as a fallback string
// here (the backend always sends its own `message` in `final_result`, so
// this only matters if that field is ever missing) — if you change the
// wording server-side, update it here too so they never drift apart.
export const INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT =
  "We cannot identify this specimen with sufficient confidence from the available images.";
