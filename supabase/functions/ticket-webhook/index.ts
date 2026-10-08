import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import QRCode from "npm:qrcode@1.5.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SIGNATURE_TOLERANCE_SECONDS = 300;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("TIXWAVE_WEBHOOK_SECRET") || Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const serviceRoleKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SB_PROJECT_URL") || "https://lantiwcpwkfjmqjgvhbg.supabase.co";

  if (!webhookSecret) return jsonResponse({ error: "Missing TIXWAVE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET secret" }, 500);
  if (!serviceRoleKey || !supabaseUrl) return jsonResponse({ error: "Missing Supabase service configuration" }, 500);

  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();
  if (!signature) return jsonResponse({ error: "Missing stripe-signature header" }, 400);

  const verified = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!verified) return jsonResponse({ error: "Invalid Stripe signature" }, 400);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid Stripe payload" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
  });

  try {
    const session = event.data.object;
    if (event.type.startsWith("checkout.session.") && session.metadata?.platform !== "tixwave") {
      // Recover older sessions only when their IDs match a saved Tixwave order.
      const orderId = getString(session.metadata?.order_id);
      if (session.metadata?.platform || !orderId) return jsonResponse({ received: true, ignored: true });
      const legacy = await supabase.from("orders").select("id").eq("id", orderId).eq("stripe_session_id", session.id).maybeSingle();
      if (legacy.error) throw legacy.error;
      if (!legacy.data) return jsonResponse({ received: true, ignored: true });
    }
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && session.payment_status === "paid") {
      await handleCheckoutCompleted(supabase, session);
      await emailTickets(supabase, session);
    } else if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type)) {
      const { error } = await supabase.rpc("release_ticket_order", { p_order: session.metadata?.order_id, p_session: session.id });
      if (error) throw error;
    }
    if (["charge.refunded", "charge.dispute.created"].includes(event.type)) {
      const object = event.data.object;
      const intent = object.payment_intent;
      if (intent) {
        const changes = event.type === "charge.refunded" && object.refunded ? { payout_blocked: true, status: "refunded" } : { payout_blocked: true };
        const saved = await supabase.from("orders").update(changes).eq("payment_intent_id", intent);
        if (saved.error) throw saved.error;
      }
    }
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("ticket-webhook handler failed", error);
    return jsonResponse({ error: "Webhook handling failed", detail: "Please retry this webhook" }, 500);
  }
});

async function handleCheckoutCompleted(supabase: any, session: any): Promise<void> {
  const orderId = getString(session.metadata?.order_id);
  if (!orderId) throw new Error("Missing order metadata");
  const { error } = await supabase.rpc("fulfill_ticket_order", {
    p_order: orderId, p_session: session.id, p_amount_cents: session.amount_total,
    p_currency: session.currency, p_payment_intent: session.payment_intent || null,
  });
  if (error) throw new Error(error.message);
}

async function emailTickets(supabase: any, session: any): Promise<void> {
  const key = Deno.env.get("RESEND_API_KEY");
  const sender = Deno.env.get("TIXWAVE_EMAIL_FROM");
  if (!key || !sender) throw new Error("Ticket email delivery is not configured");
  const { data: order, error } = await supabase.from("orders")
    .select("id,buyer_email,public_order_token,email_sent_at,status,events(name)")
    .eq("id", session.metadata.order_id).single();
  if (error) throw error;
  if (order.email_sent_at || order.status !== "paid") return;
  const site = Deno.env.get("TIXWAVE_SITE_URL") || "https://tixwave.party";
  const link = `${site}/checkout-success.html?order_id=${order.id}&token=${order.public_order_token}`;
  const tickets = await supabase.from("tickets").select("id,ticket_number,ticket_types(name)").eq("order_id", order.id).order("ticket_number");
  if (tickets.error) throw tickets.error;
  if (!tickets.data?.length) throw new Error("No issued tickets to email");
  const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
  const attachments = [];
  const cards = [];
  for (const ticket of tickets.data) {
    const cid = `ticket-${ticket.id}`;
    const image = await QRCode.toDataURL(ticket.id, { width: 320, margin: 4, errorCorrectionLevel: "M" });
    attachments.push({ filename: `Tixwave-ticket-${ticket.ticket_number}.png`, content: image.split(",")[1], content_type: "image/png", content_id: cid });
    cards.push(`<div style="background:#fff;border:1px solid #ddd;border-radius:16px;padding:20px;margin:20px 0;color:#111"><h2>Ticket ${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.ticket_types?.name)}</h2><img src="cid:${cid}" width="280" height="280" alt="QR code for ticket ${escapeHtml(ticket.ticket_number)}" style="display:block;width:280px;max-width:100%;height:auto"><p>Show this QR code at the gate. Each ticket admits one person and can be scanned once.</p></div>`);
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `tickets-qr-v2-${order.id}` },
    body: JSON.stringify({ from: sender, to: [order.buyer_email], subject: "Your TixWave tickets", attachments, html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px"><h1>TixWave.party</h1><h2>${escapeHtml(order.events?.name || "Your event")}</h2><p>Your tickets are ready. Your QR codes are included below and attached as images.</p>${cards.join("")}<p><a href="${escapeHtml(link)}">View your tickets online</a></p><p>Keep your tickets private. Do not share your QR codes publicly.</p></div>`, text: `Your tickets for ${order.events?.name || "your event"} are ready. Your QR codes are attached as PNG images. Backup ticket link: ${link}\nKeep your QR codes private. Show each ticket at the gate.` }),
  });
  if (!response.ok) throw new Error("Ticket email delivery failed");
  const saved = await supabase.from("orders").update({ email_sent_at: new Date().toISOString() }).eq("id", order.id);
  if (saved.error) throw saved.error;
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
