-- Run this once in the Supabase SQL Editor for an existing AMORIA project.
-- New experiences have no count limit; each stays private until individually approved.
drop trigger if exists t_limit on public.experiences;
create or replace function public.limit_exp()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  return new;
end $$;
create trigger t_limit before insert on public.experiences for each row execute function public.limit_exp();

create or replace function public.get_experience(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare e public.experiences%rowtype;
begin
  select * into e from public.experiences where slug=p_slug;
  if not found or exists(select 1 from public.profiles where id=e.owner and blocked) then
    return null;
  end if;
  if not e.paid then
    return jsonb_build_object('unpaid',true);
  end if;
  if e.at is not null and e.at>now() then
    return jsonb_build_object('at', floor(extract(epoch from e.at)*1000));
  end if;
  update public.experiences set views=views+1, last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values (e.id);
  return jsonb_build_object('pub', e.pub);
end $$;
