-- Graded Reader EN — Supabase schema
-- Run this whole file once in Supabase: SQL Editor → New query → paste → Run.
-- It is safe to run again (it only creates what is missing).

-- 1. Texts you import (with optional audio)
create table if not exists public.texts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null,
  level       text,
  source      text not null default 'imported',
  paragraphs  jsonb not null default '[]'::jsonb,
  glossary    jsonb not null default '{}'::jsonb,
  questions   jsonb not null default '[]'::jsonb,
  audio_path  text,
  created_at  timestamptz not null default now()
);

-- 2. Reading progress per story (built-in stories use their text id, e.g. "wrong-suitcase")
create table if not exists public.progress (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  story_id    text not null,
  pos         int  not null default 0,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, story_id)
);

-- 3. Saved words with spaced-repetition state
create table if not exists public.words (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  word        text not null,
  def         text default '',
  pt          text default '',
  sentence    text default '',
  story_id    text,
  story_title text,
  box         int not null default 0,
  due         timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (user_id, word)
);

-- Row Level Security: each person sees and changes only their own rows
alter table public.texts    enable row level security;
alter table public.progress enable row level security;
alter table public.words    enable row level security;

drop policy if exists "own texts"    on public.texts;
drop policy if exists "own progress" on public.progress;
drop policy if exists "own words"    on public.words;
create policy "own texts"    on public.texts    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own progress" on public.progress for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own words"    on public.words    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Live sync between devices (Realtime)
do $$
begin
  begin alter publication supabase_realtime add table public.texts;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.progress; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.words;    exception when duplicate_object then null; end;
end $$;

-- 4. Private bucket for audio files (MP3, M4A…), max 50 MB per file
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio', 'audio', false, 52428800, array['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/ogg','audio/wav','audio/webm'])
on conflict (id) do nothing;

-- Files live under audio/<your user id>/… and only you can read or change them
drop policy if exists "audio read own"   on storage.objects;
drop policy if exists "audio insert own" on storage.objects;
drop policy if exists "audio update own" on storage.objects;
drop policy if exists "audio delete own" on storage.objects;
create policy "audio read own"   on storage.objects for select using      (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "audio insert own" on storage.objects for insert with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "audio update own" on storage.objects for update using      (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "audio delete own" on storage.objects for delete using      (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
