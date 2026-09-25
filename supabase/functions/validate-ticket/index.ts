import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const { ticket_id, pin } = await req.json();
    const scannerPin = Deno.env.get("SCANNER_PIN");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SB_PROJECT_URL");

    if (scannerPin && String(pin || "") !== scannerPin) return jsonResponse({ valid: false, error: "Invalid scanner PIN" }, 401);
    if (!serviceRoleKey || !supabaseUrl) return jsonResponse({ valid: false, error: "Missing Supabase service configuration" }, 500);
    if (!ticket_id) return jsonResponse({ valid: false, error: "Missing ticket_id" }, 400);

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("id,ticket_ref,buyer_email,used,used_at,events(name,date,venue,city,country),ticket_types(name)")
      .eq("id", ticket_id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!ticket) return jsonResponse({ valid: false, already_used: false, error: "Ticket not found" }, 404);

    if (ticket.used) {
      return jsonResponse({
        valid: false,
        already_used: true,
        ticket_ref: ticket.ticket_ref,
        event_name: ticket.events?.name,
        ticket_type: ticket.ticket_types?.name,
        buyer_email: ticket.buyer_email,
        used_at: ticket.used_at,
      });
    }

    const { error: updateError } = await supabase
      .from("tickets")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", ticket_id)
      .eq("used", false);

    if (updateError) throw new Error(updateError.message);

    return jsonResponse({
      valid: true,
      already_used: false,
      ticket_ref: ticket.ticket_ref,
      event_name: ticket.events?.name,
      ticket_type: ticket.ticket_types?.name,
      buyer_email: ticket.buyer_email,
    });
  } catch (error) {
    console.error("validate-ticket error", error);
    return jsonResponse({ valid: false, error: "Unexpected validation error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
