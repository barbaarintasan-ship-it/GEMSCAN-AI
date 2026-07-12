// Shared CORS headers for Edge Functions.
// verify-subscription is called from the mobile app AND the website, so it
// allows cross-origin calls; webhook endpoints (stripe-webhook) do NOT use
// this since they're server-to-server and validate via signature instead.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
