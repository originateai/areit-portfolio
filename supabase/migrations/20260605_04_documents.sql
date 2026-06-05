-- ============================================================
-- 20260605_04 — DOCUMENT UPLOADS (contract notes, distribution & tax statements)
-- Storage bucket + metadata table + the policies the anon-key SPA needs to
-- upload and read its own documents. Run in Supabase SQL editor.
--
-- SECURITY NOTE: this is a single-user personal tool, so the policies below let
-- the anon key read/write the `documents` bucket. If this app is ever shared,
-- tighten these to authenticated-only or per-user folders.
-- ============================================================

-- ── METADATA TABLE ────────────────────────────────────────────────────────────
create table if not exists public.document_uploads (
  id            bigserial primary key,
  doc_type      text not null,                 -- 'contract_note' | 'distribution_statement' | 'tax_statement'
  ticker        text,
  doc_date      date,
  file_path     text not null,                 -- path within the storage bucket
  file_name     text,
  parsed        jsonb,                          -- whatever the parser extracted
  status        text default 'stored',          -- 'stored' | 'parsed' | 'confirmed' | 'error'
  notes         text,
  created_at    timestamptz default now()
);
create index if not exists idx_document_uploads_type on public.document_uploads(doc_type, created_at desc);

alter table public.document_uploads enable row level security;
drop policy if exists document_uploads_anon_select on public.document_uploads;
create policy document_uploads_anon_select on public.document_uploads for select to anon, authenticated using (true);
drop policy if exists document_uploads_anon_write on public.document_uploads;
create policy document_uploads_anon_write on public.document_uploads for all to anon, authenticated using (true) with check (true);
grant select, insert, update, delete on public.document_uploads to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- ── STORAGE BUCKET ────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- ── STORAGE POLICIES (on storage.objects, scoped to the documents bucket) ─────
drop policy if exists "documents read"   on storage.objects;
drop policy if exists "documents insert" on storage.objects;
drop policy if exists "documents update" on storage.objects;
drop policy if exists "documents delete" on storage.objects;

create policy "documents read"   on storage.objects for select to anon, authenticated using (bucket_id = 'documents');
create policy "documents insert" on storage.objects for insert to anon, authenticated with check (bucket_id = 'documents');
create policy "documents update" on storage.objects for update to anon, authenticated using (bucket_id = 'documents') with check (bucket_id = 'documents');
create policy "documents delete" on storage.objects for delete to anon, authenticated using (bucket_id = 'documents');
