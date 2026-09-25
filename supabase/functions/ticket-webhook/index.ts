import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SIGNATURE_TOLERANCE_SECONDS = 300;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SB_PROJECT_URL");

  if (!webhookSecret) return jsonResponse({ error: "Missing STRIPE_WEBHOOK_SECRET secret" }, 500);
  if (!serviceRoleKey || !supabaseUrl) return jsonResponse({ error: "Missing Supabase service configuration" }, 500);

  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();
  if (!signature) return jsonResponse({ error: "Missing stripe-signature header" }, 400);

  const verified = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!verified) return jsonResponse({ error: "Invalid Stripe signature" }, 400);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch (_error) {
    return jsonResponse({ error: "Invalid Stripe payload" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(supabase, event.data.object);
    }
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("ticket-webhook handler failed", error);
    return jsonResponse({ error: "Webhook handling failed", detail: String(error) }, 500);
  }
});

async function handleCheckoutCompleted(supabase: any, session: any): Promise<void> {
  const metadata = session.metadata || {};
  const orderId = getString(metadata.order_id);
  const eventId = getString(metadata.event_id);
  const ticketTypeId = getString(metadata.ticket_type_id);
  const buyerEmail = (getString(metadata.buyer_email) || getString(session.customer_details?.email) || getString(session.customer_email) || "").toLowerCase();
  const quantity = Number(metadata.quantity || 1);
  const amountPaid = Number(session.amount_total || 0) / 100;

  if (!orderId || !eventId || !ticketTypeId || !buyerEmail || !Number.isInteger(quantity) || quantity < 1) {
    throw new Error("checkout.session.completed is missing required ticket metadata");
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from("orders")
    .select("id,status")
    .eq("id", orderId)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);
  if (existingOrder?.status === "paid") return;

  const { error: orderError } = await supabase.from("orders").update({
    buyer_email: buyerEmail,
    event_id: eventId,
    ticket_type_id: ticketTypeId,
    quantity,
    amount_paid: amountPaid,
    commission: roundMoney(amountPaid * 0.05),
    stripe_session_id: session.id,
    status: "paid",
  }).eq("id", orderId);

  if (orderError) throw new Error(`Order update failed: ${orderError.message}`);

  const tickets = Array.from({ length: quantity }, () => ({
    order_id: orderId,
    event_id: eventId,
    ticket_type_id: ticketTypeId,
    buyer_email: buyerEmail,
    ticket_ref: createTicketReference(),
  }));

  const { error: ticketError } = await supabase.from("tickets").insert(tickets);
  if (ticketError) throw new Error(`Ticket creation failed: ${ticketError.message}`);

  const { error: soldError } = await supabase.rpc("increment_ticket_type_sold", {
    ticket_type_uuid: ticketTypeId,
    increment_by: quantity,
  });
  if (soldError) throw new Error(`Sold count update failed: ${soldError.message}`);
}

function createTicketReference(): string {
  const year = new Date().getUTCFullYear();
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `TKT-${year}-${random}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function verifyStripeSignature(rawBody: string, signatureHeader: string, webhookSecret: string): Promise<boolean> {
  const timestamp = extractSignatureValue(signatureHeader, "t");
  const signatures = extractSignatureValues(signatureHeader, "v1");
  if (!timestamp || signatures.length === 0) return false;

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > SIGNATURE_TOLERANCE_SECONDS) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = await createHmacSha256Hex(webhookSecret, signedPayload);
  return signatures.some((signature) => constantTimeEquals(signature, expectedSignature));
}

function extractSignatureValue(header: string, key: string): string | null {
  const match = header.split(",").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  return match ? match.slice(key.length + 1) : null;
}

function extractSignatureValues(header: string, key: string): string[] {
  return header.split(",").map((part) => part.trim()).filter((part) => part.startsWith(`${key}=`)).map((part) => part.slice(key.length + 1));
}

async function createHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signatureBuffer)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
