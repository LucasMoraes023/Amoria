-- Add video storage without changing existing experiences or media buckets.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('amoria-videos','amoria-videos',true,26214400,array['video/mp4','video/webm'])
on conflict (id) do nothing;

drop policy if exists amoria_video_read on storage.objects;
create policy amoria_video_read on storage.objects
for select using (bucket_id='amoria-videos');

drop policy if exists amoria_video_insert on storage.objects;
create policy amoria_video_insert on storage.objects
for insert to authenticated
with check (bucket_id='amoria-videos' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists amoria_video_delete on storage.objects;
create policy amoria_video_delete on storage.objects
for delete to authenticated
using (bucket_id='amoria-videos' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
