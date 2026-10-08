alter table public.events add column commission_rate numeric(5,4) not null default 0.05 check(commission_rate in (0,0.05));
-- Keep allocated event IDs even if an event is deleted: used launch slots are never recycled.
create table public.launch_event_waivers(slot smallint primary key check(slot between 1 and 5),event_id uuid unique not null,allocated_at timestamptz not null default now());
alter table public.launch_event_waivers enable row level security;
create policy waiver_admin_read on public.launch_event_waivers for select to authenticated using(public.is_platform_admin());
grant select on public.launch_event_waivers to authenticated;
grant all on public.launch_event_waivers to service_role;
create function public.assign_launch_event_waiver() returns trigger language plpgsql security definer set search_path=public as $$
declare free_slot smallint;
begin
 new.commission_rate=0.05;
 if exists(select 1 from launch_event_waivers where event_id=new.id) then new.commission_rate=0; return new; end if;
 if not new.is_active or coalesce(new.promoter_email,'') like '%@tixwave.demo' then return new; end if;
 if tg_op='UPDATE' then if old.is_active then return new; end if; end if;
 perform pg_advisory_xact_lock(84521916005);
 select n into free_slot from generate_series(1,5) n where not exists(select 1 from launch_event_waivers where slot=n) order by n limit 1;
 if free_slot is not null then
 insert into launch_event_waivers(slot,event_id) values(free_slot,new.id);
 new.commission_rate=0;
 end if;
 return new;
end $$;
revoke all on function public.assign_launch_event_waiver() from public,anon,authenticated;
create trigger assign_launch_event_waiver before insert or update of is_active,commission_rate on public.events for each row execute function public.assign_launch_event_waiver();

create or replace function public.reserve_ticket_order(p_ticket_type uuid,p_event uuid,p_quantity integer,p_email text)
returns public.orders language plpgsql security definer set search_path=public as $$
declare t ticket_types; o orders; reserved integer; event_rate numeric;
begin
 if p_quantity is null or p_quantity<1 or p_quantity>10 or p_email is null or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid ticket quantity or email'; end if;
 select * into t from ticket_types where id=p_ticket_type and event_id=p_event for update;
 if not found or not exists(select 1 from events where id=p_event and is_active and date>=current_date) then raise exception 'Event or ticket type unavailable'; end if;
 select commission_rate into event_rate from events where id=p_event;
 -- Reservations are released only after Stripe confirms expiration/cancellation.
 select coalesce(sum(quantity),0) into reserved from orders where ticket_type_id=t.id and status='pending' and reservation_expires_at is not null;
 if t.quantity-t.sold-reserved<p_quantity then raise exception 'Not enough tickets remain'; end if;
 insert into orders(buyer_email,event_id,ticket_type_id,quantity,amount_paid,commission,status,reservation_expires_at)
 values(lower(trim(p_email)),p_event,t.id,p_quantity,round(t.price*p_quantity,2),round(t.price*p_quantity*event_rate,2),'pending',now()+interval '30 minutes') returning * into o;
 return o;
end $$;

revoke all on function public.reserve_ticket_order(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.reserve_ticket_order(uuid,uuid,integer,text) to service_role;
