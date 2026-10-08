alter table public.event_submissions add column ticket_types jsonb;
create or replace function public.valid_submission_ticket_types(items jsonb) returns boolean language plpgsql immutable set search_path=public as $$
declare item jsonb;
begin
 if items is null then return true; end if;
 if jsonb_typeof(items)!='array' then return false; end if;
 if jsonb_array_length(items)<1 or jsonb_array_length(items)>10 then return false; end if;
 for item in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(item)!='object' or jsonb_typeof(item->'name')!='string' or length(trim(item->>'name')) not between 1 and 120 or jsonb_typeof(item->'price')!='number' or jsonb_typeof(item->'quantity')!='number' then return false; end if;
  if (item->>'price')::numeric<=0 or (item->>'price')::numeric>100000 or round((item->>'price')::numeric,2)!=(item->>'price')::numeric or (item->>'quantity')::numeric not between 1 and 100000 or trunc((item->>'quantity')::numeric)!=(item->>'quantity')::numeric then return false; end if;
 end loop;
 if (select count(distinct lower(trim(value->>'name'))) from jsonb_array_elements(items))!=jsonb_array_length(items) then return false; end if;
 return true;
exception when others then return false;
end $$;
alter table public.event_submissions add constraint valid_ticket_types check(public.valid_submission_ticket_types(ticket_types));
create or replace function public.approve_event_submission(p_id uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare s event_submissions; e uuid;
begin
 if not public.is_platform_admin() then raise exception 'Administrator required'; end if;
 select * into s from event_submissions where id=p_id for update;
 if not found or s.status!='pending' then raise exception 'Submission is not pending'; end if;
 if s.ends_at<=now() or s.date<current_date then raise exception 'Event dates are invalid'; end if;
 insert into events(name,description,date,time,venue,city,country,banner_url,promoter_email,promoter_user_id,ends_at)
 select s.name,s.description,s.date,s.time,s.venue,s.city,s.country,s.banner_url,u.email,s.user_id,s.ends_at from auth.users u where u.id=s.user_id returning id into e;
 if s.ticket_types is null then
 insert into ticket_types(event_id,name,price,quantity) values(e,s.ticket_name,s.price,s.quantity);
 else
 insert into ticket_types(event_id,name,price,quantity) select e,trim(value->>'name'),(value->>'price')::numeric,(value->>'quantity')::integer from jsonb_array_elements(s.ticket_types);
 end if;
 update event_submissions set status='approved' where id=s.id;
 return e;
end $$;
revoke all on function approve_event_submission(uuid) from public,anon;
grant execute on function approve_event_submission(uuid) to authenticated;
