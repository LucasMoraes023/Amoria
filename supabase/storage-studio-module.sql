-- AMORIA — Storage para fotos do Estúdio de QR
-- Execute este arquivo no Supabase SQL Editor uma única vez.
-- O bucket "photos" já é usado pelo editor e pelas fotos das experiências.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

drop policy if exists "AMORIA photos public read" on storage.objects;
create policy "AMORIA photos public read"
on storage.objects for select
to public
using (bucket_id = 'photos');

drop policy if exists "AMORIA users upload photos" on storage.objects;
create policy "AMORIA users upload photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "AMORIA users update photos" on storage.objects;
create policy "AMORIA users update photos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "AMORIA users delete photos" on storage.objects;
create policy "AMORIA users delete photos"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
