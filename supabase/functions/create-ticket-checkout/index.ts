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
    const body = await req.json();
    const {
      event_id,
      eventId,
      ticket_type_id,
      ticketTypeId,
      quantity,
      buyer_email,
      buyerEmail,
    } = body;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const serviceRoleKey = Deno.env.get("SB_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SB_PROJECT_URL") || "https://lantiwcpwkfjmqjgvhbg.supabase.co";
    const siteUrl = Deno.env.get("TIXWAVE_SITE_URL") || "https://tixwave.party";

    const mode = Deno.env.get("STRIPE_MODE") || "test";
    if (stripeSecretKey && !stripeSecretKey.startsWith(mode === "live" ? "sk_live_" : "sk_test_")) return jsonResponse({ error: "Stripe key does not match the configured payment mode" }, 503);
    if (!stripeSecretKey) return jsonResponse({ error: "Missing STRIPE_SECRET_KEY secret" }, 500);
    if (!serviceRoleKey) return jsonResponse({ error: "Missing SB_SERVICE_ROLE_KEY secret" }, 500);
    if (!supabaseUrl) return jsonResponse({ error: "Missing SUPABASE_URL secret" }, 500);

    const cleanEventId = String(event_id || eventId || "").trim();
    const cleanTicketTypeId = String(ticket_type_id || ticketTypeId || "").trim();
    const cleanEmail = String(buyer_email || buyerEmail || "").trim().toLowerCase();
    const ticketQuantity = Number(quantity || 1);

    if (!cleanTicketTypeId || !cleanEmail.includes("@")) {
      return jsonResponse({ error: "Missing ticket type or buyer email" }, 400);
    }
    if (!Number.isInteger(ticketQuantity) || ticketQuantity < 1 || ticketQuantity > 10) {
      return jsonResponse({ error: "Quantity must be between 1 and 10" }, 400);
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

    let ticketQuery = supabase
      .from("ticket_types")
      .select("id,name,price,quantity,sold,event_id,events(name,date,venue,city,country)")
      .eq("id", cleanTicketTypeId);

    if (cleanEventId) ticketQuery = ticketQuery.eq("event_id", cleanEventId);

    const { data: ticketType, error: ticketError } = await ticketQuery.maybeSingle();

    if (ticketError) throw new Error(`Ticket type lookup failed: ${ticketError.message}`);
    if (!ticketType) return jsonResponse({ error: "Ticket type not found" }, 404);

    const resolvedEventId = cleanEventId || String(ticketType.event_id || "").trim();
    if (!resolvedEventId) throw new Error("Ticket type is missing event_id");

    const unitPrice = Number(ticketType.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error("Ticket type has an invalid price");
    }

    const { data: reservation, error: orderError } = await supabase.rpc("reserve_ticket_order", {
      p_ticket_type: cleanTicketTypeId, p_event: resolvedEventId,
      p_quantity: ticketQuantity, p_email: cleanEmail,
    });

    const order = Array.isArray(reservation) ? reservation[0] : reservation;
    if (orderError || !order) {
      throw new Error(`Could not create pending order: ${orderError?.message || "unknown error"}`);
    }
    if (!order.public_order_token) {
      throw new Error("Order insert succeeded but public_order_token was not returned");
    }

    const eventName = getEventName(ticketType.events) || "TixWave.party event";
    const successUrl = `${siteUrl.replace(/\/$/, "")}/checkout-success.html?order_id=${order.id}&token=${order.public_order_token}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${siteUrl.replace(/\/$/, "")}/event.html?id=${resolvedEventId}`;

    const stripePayload = new URLSearchParams({
      mode: "payment",
      customer_email: cleanEmail,
      "payment_method_types[0]": "card",
      expires_at: String(Math.floor(Date.now() / 1000) + 1860),
      success_url: successUrl,
      cancel_url: cancelUrl,
      "line_items[0][quantity]": String(ticketQuantity),
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": String(Math.round(unitPrice * 100)),
      "line_items[0][price_data][product_data][name]": `${eventName} — ${ticketType.name}`,
      "metadata[platform]": "tixwave",
      "payment_intent_data[metadata][platform]": "tixwave",
      "payment_intent_data[metadata][event_id]": resolvedEventId,
      "payment_intent_data[metadata][order_id]": order.id,
      "payment_intent_data[description]": `Tixwave tickets: ${eventName}`,
      "payment_intent_data[statement_descriptor_suffix]": "TIXWAVE",
      "payment_intent_data[transfer_group]": `event_${resolvedEventId}`,
      "metadata[order_id]": order.id,
      "metadata[order_token]": order.public_order_token,
      "metadata[event_id]": resolvedEventId,
      "metadata[ticket_type_id]": cleanTicketTypeId,
      "metadata[quantity]": String(ticketQuantity),
      "metadata[buyer_email]": cleanEmail,
    });

    let stripeResponse: Response;
    try {
      stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `ticket-order-${order.id}`,
        },
        body: stripePayload,
      });
    } catch (error) {
      // Keep the reservation: Stripe may have received the request despite a network failure.
      throw new Error(`Stripe checkout request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const session = await parseStripeResponse(stripeResponse);
    if (!stripeResponse.ok) {
      await markOrderCancelled(supabase, order.id);
      return jsonResponse({ error: session.error?.message || "Stripe checkout failed" }, stripeResponse.status || 400);
    }
    if (!session?.id || !session?.url) {
      await markOrderCancelled(supabase, order.id);
      throw new Error("Stripe checkout response is missing session id or url");
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", order.id);
    if (updateError) {
      const expired = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/expire`, {
        method: "POST", headers: { Authorization: `Bearer ${stripeSecretKey}` },
      });
      if (expired.ok) await markOrderCancelled(supabase, order.id);
      throw new Error("Could not finish checkout setup. Please try again later.");
    }

    return jsonResponse({ url: session.url, order_id: order.id, token: order.public_order_token });
  } catch (error) {
    console.error("create-ticket-checkout error", error);
    return jsonResponse({
      error: "Could not start checkout. Tickets may be unavailable; please try again.",
    }, 500);
  }
});

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function getEventName(eventRelation: unknown): string | undefined {
  if (eventRelation && typeof eventRelation === "object" && !Array.isArray(eventRelation)) {
    const name = (eventRelation as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }
  if (Array.isArray(eventRelation) && eventRelation.length > 0) {
    const first = eventRelation[0];
    if (first && typeof first === "object") {
      const name = (first as { name?: unknown }).name;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    }
  }
  return undefined;
}

async function parseStripeResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stripe returned a non-JSON response (status ${response.status})`);
  }
}

async function markOrderCancelled(supabase: any, orderId: string): Promise<void> {
  const { error } = await supabase.from("orders").update({ status: "cancelled" }).eq("id", orderId);
  if (error) {
    console.error("Failed to cancel order after checkout error", error);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
