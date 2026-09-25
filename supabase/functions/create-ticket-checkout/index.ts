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
    const { event_id, ticket_type_id, quantity, buyer_email } = await req.json();
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
    const requestApiKey = req.headers.get("apikey") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const requestUrl = new URL(req.url);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SB_PROJECT_URL") || `${requestUrl.protocol}//${requestUrl.host}`;
    const siteUrl = Deno.env.get("TIXWAVE_SITE_URL") || req.headers.get("origin") || "https://tixwave.party";

    if (!stripeSecretKey) return jsonResponse({ error: "Missing STRIPE_SECRET_KEY secret" }, 500);
    const apiKey = serviceRoleKey || requestApiKey;
    if (!apiKey) return jsonResponse({ error: "Missing Supabase service configuration" }, 500);

    const cleanEventId = String(event_id || "").trim();
    const cleanTicketTypeId = String(ticket_type_id || "").trim();
    const cleanEmail = String(buyer_email || "").trim().toLowerCase();
    const ticketQuantity = Number(quantity || 1);
    if (!cleanEventId || !cleanTicketTypeId || !cleanEmail.includes("@")) return jsonResponse({ error: "Missing event, ticket type, or buyer email" }, 400);
    if (!Number.isInteger(ticketQuantity) || ticketQuantity < 1 || ticketQuantity > 10) return jsonResponse({ error: "Quantity must be between 1 and 10" }, 400);

    const supabase = createClient(supabaseUrl, apiKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: ticketType, error: ticketError } = await supabase
      .from("ticket_types")
      .select("id,name,price,quantity,sold,event_id,events(name,date,venue,city,country)")
      .eq("id", cleanTicketTypeId)
      .eq("event_id", cleanEventId)
      .single();

    if (ticketError || !ticketType) return jsonResponse({ error: "Ticket type not found" }, 404);
    const remaining = Number(ticketType.quantity) - Number(ticketType.sold || 0);
    if (remaining < ticketQuantity) return jsonResponse({ error: `Only ${remaining} ticket(s) remaining` }, 409);

    const amountPaid = Number(ticketType.price) * ticketQuantity;
    const { data: order, error: orderError } = await supabase.from("orders").insert({
      buyer_email: cleanEmail,
      event_id: cleanEventId,
      ticket_type_id: cleanTicketTypeId,
      quantity: ticketQuantity,
      amount_paid: amountPaid,
      commission: roundMoney(amountPaid * 0.05),
      status: "pending",
    }).select("id,public_order_token").single();

    if (orderError || !order) throw new Error(orderError?.message || "Could not create pending order");

    const eventName = ticketType.events?.name || "TixWave.party event";
    const successUrl = `${siteUrl.replace(/\/$/, "")}/checkout-success.html?order_id=${order.id}&token=${order.public_order_token}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${siteUrl.replace(/\/$/, "")}/event.html?id=${cleanEventId}`;

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        mode: "payment",
        customer_email: cleanEmail,
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][quantity]": String(ticketQuantity),
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": String(Math.round(Number(ticketType.price) * 100)),
        "line_items[0][price_data][product_data][name]": `${eventName} — ${ticketType.name}`,
        "metadata[order_id]": order.id,
        "metadata[order_token]": order.public_order_token,
        "metadata[event_id]": cleanEventId,
        "metadata[ticket_type_id]": cleanTicketTypeId,
        "metadata[quantity]": String(ticketQuantity),
        "metadata[buyer_email]": cleanEmail,
      }),
    });

    const session = await stripeResponse.json();
    if (!stripeResponse.ok) {
      await supabase.from("orders").update({ status: "cancelled" }).eq("id", order.id);
      return jsonResponse({ error: session.error?.message || "Stripe checkout failed" }, 400);
    }

    await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
    return jsonResponse({ url: session.url, order_id: order.id, token: order.public_order_token });
  } catch (error) {
    console.error("create-ticket-checkout error", error);
    return jsonResponse({ error: "Unexpected checkout error" }, 500);
  }
});

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
