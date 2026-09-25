create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  date date not null,
  time time,
  venue text,
  city text,
  country text,
  banner_url text,
  promoter_email text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ticket_types (
  id uuid default gen_random_uuid() primary key,
  event_id uuid references public.events(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  quantity integer not null check (quantity >= 0),
  sold integer default 0 check (sold >= 0),
  created_at timestamptz default now(),
  constraint ticket_types_not_oversold check (sold <= quantity)
);

create table if not exists public.orders (
  id uuid default gen_random_uuid() primary key,
  buyer_email text not null,
  event_id uuid references public.events(id),
  ticket_type_id uuid references public.ticket_types(id),
  quantity integer default 1 check (quantity > 0),
  amount_paid numeric(10,2),
  stripe_session_id text unique,
  public_order_token text not null default encode(gen_random_bytes(16), 'hex') unique,
  commission numeric(10,2),
  status text default 'pending' check (status in ('pending', 'paid', 'refunded', 'cancelled')),
  created_at timestamptz default now()
);

create table if not exists public.tickets (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references public.orders(id) on delete cascade,
  event_id uuid references public.events(id),
  ticket_type_id uuid references public.ticket_types(id),
  buyer_email text not null,
  ticket_ref text unique not null,
  used boolean default false,
  used_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_events_active_country_date on public.events (is_active, country, date);
create index if not exists idx_ticket_types_event_id on public.ticket_types (event_id);
create index if not exists idx_orders_buyer_email on public.orders (buyer_email);
create index if not exists idx_orders_stripe_session_id on public.orders (stripe_session_id);
create index if not exists idx_tickets_buyer_email on public.tickets (buyer_email);
create index if not exists idx_tickets_order_id on public.tickets (order_id);

create or replace function public.increment_ticket_type_sold(ticket_type_uuid uuid, increment_by integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ticket_types
  set sold = sold + increment_by
  where id = ticket_type_uuid
    and sold + increment_by <= quantity;

  if not found then
    raise exception 'Ticket type is sold out or does not exist';
  end if;
end;
$$;

alter table public.events enable row level security;
alter table public.ticket_types enable row level security;
alter table public.orders enable row level security;
alter table public.tickets enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.events to anon, authenticated;
grant select on public.ticket_types to anon, authenticated;
grant select on public.orders to anon, authenticated;
grant select on public.tickets to anon, authenticated;
grant insert, update, delete on public.events to anon, authenticated;
grant insert, update, delete on public.ticket_types to anon, authenticated;
grant insert, update on public.orders to anon, authenticated;
grant insert, update on public.tickets to anon, authenticated;
grant execute on function public.increment_ticket_type_sold(uuid, integer) to service_role;

drop policy if exists events_public_read_active on public.events;
create policy events_public_read_active
on public.events for select
to public
using (is_active = true);

drop policy if exists ticket_types_public_read_for_active_events on public.ticket_types;
create policy ticket_types_public_read_for_active_events
on public.ticket_types for select
to public
using (exists (select 1 from public.events where events.id = ticket_types.event_id and events.is_active = true));

drop policy if exists orders_select_owner_or_success_token on public.orders;
create policy orders_select_owner_or_success_token
on public.orders for select
to public
using (
  buyer_email = coalesce(auth.jwt() ->> 'email', '')
  or public_order_token = coalesce((current_setting('request.headers', true)::json ->> 'x-order-token'), '')
);

drop policy if exists tickets_select_owner_or_success_token on public.tickets;
create policy tickets_select_owner_or_success_token
on public.tickets for select
to public
using (
  buyer_email = coalesce(auth.jwt() ->> 'email', '')
  or exists (
    select 1 from public.orders
    where orders.id = tickets.order_id
      and orders.public_order_token = coalesce((current_setting('request.headers', true)::json ->> 'x-order-token'), '')
  )
);

-- Simple prototype admin policies. The bundled admin.html adds a client-side PIN gate only.
-- Before production, remove these four policies and replace them with server-side admin Edge Functions.
drop policy if exists prototype_admin_insert_events on public.events;
create policy prototype_admin_insert_events on public.events for insert to public with check (true);

drop policy if exists prototype_admin_update_events on public.events;
create policy prototype_admin_update_events on public.events for update to public using (true) with check (true);

drop policy if exists prototype_admin_insert_ticket_types on public.ticket_types;
create policy prototype_admin_insert_ticket_types on public.ticket_types for insert to public with check (true);

drop policy if exists prototype_admin_update_ticket_types on public.ticket_types;
create policy prototype_admin_update_ticket_types on public.ticket_types for update to public using (true) with check (true);

drop policy if exists prototype_admin_read_orders on public.orders;
create policy prototype_admin_read_orders on public.orders for select to public using (true);

drop policy if exists prototype_admin_read_tickets on public.tickets;
create policy prototype_admin_read_tickets on public.tickets for select to public using (true);

-- Optional seed events for first preview. Delete or edit after confirming the UI.
insert into public.events (name, description, date, time, venue, city, country, banner_url, promoter_email)
values
('Accra Nights: Afrobeats Takeover', 'A premium Afrobeats, Amapiano, and dancehall nightclub experience for the diaspora.', '2026-12-19', '22:00', 'Skybar 25', 'Accra', 'Ghana', 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=1400&q=80', 'promoter@tixwave.demo'),
('Lisbon Afrohouse Live', 'Live DJs, bottle service, and a packed dancefloor in the heart of Lisbon.', '2026-11-14', '21:30', 'Lust in Rio', 'Lisbon', 'Portugal', 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=80', 'lisbon@tixwave.demo'),
('London Diaspora Linkup', 'A stylish community linkup with live performances, food vendors, and late-night sets.', '2026-10-31', '20:00', 'Electric Brixton', 'London', 'UK', 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=80', 'london@tixwave.demo')
on conflict do nothing;

insert into public.ticket_types (event_id, name, price, quantity)
select events.id, ticket_name, price, quantity
from public.events
cross join (values
  ('Early Bird', 15.00, 40),
  ('General Admission', 25.00, 150),
  ('VIP', 65.00, 30)
) as seeded(ticket_name, price, quantity)
where events.promoter_email like '%@tixwave.demo'
on conflict do nothing;
