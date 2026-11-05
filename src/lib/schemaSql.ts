'use client';
// 설치 화면에서 복사해 쓰는 스키마 SQL — 원본: supabase/schema.sql
// (원본을 고치면 이 파일도 함께 갱신)

export const SCHEMA_SQL = `-- ============================================================
-- O.HOME 서버 스키마 (공개 홈용)
-- Supabase → SQL Editor 에 통째로 붙여넣고 [Run].
-- 여러 번 실행해도 안전합니다 (이미 있으면 건너뜀).
-- ============================================================

-- ── 1. 회원 프로필 ───────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  avatar_url text,
  avatar_color text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ── 2. 가입코드 (초대코드 방식) ──────────────────────────────
create table if not exists public.invite_codes (
  code text primary key,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users(id),
  used_at timestamptz
);

-- ── 3. 사이트 설정 (테마·폰트·메뉴·메인 위젯·게시판 설정 등) ──
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── 4. 관리자 판별 함수 ──────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
$$;

-- ── 4-1. 회원 판별 함수 — 프로필 행이 있는 계정만 회원 (보안 제보) ──────
-- 로그인 계정은 공개 anon 키만으로 누구나 만들 수 있다(가입 화면을 거치지 않고 Auth API로).
-- 그래서 「로그인했다 = 회원」으로 보지 않고, 가입 트리거(5)가 만든 프로필 행이 있어야 회원이다.
-- 관리자가 회원 목록에서 지운 계정은 프로필이 없어 회원 권한도 없다 (계정 자체는 콘솔에서만 지울 수 있다).
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid())
$$;

-- ── 4-2. 가입코드 검사 — 코드 자체는 관리자만 읽을 수 있고(7), 맞는지만 알려 준다 ──
-- 가입 화면이 틀린 코드를 바로 알려 주기 위한 것 — 가입 자체는 5의 트리거가 막는다.
create or replace function public.check_invite(code text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(trim(code), '') <> ''
     and trim(code) = coalesce(
       nullif(trim((select s.value #>> '{}' from public.site_settings s where s.key = 'ohome.invite.v1')), ''),
       'WELCOME')
$$;
grant execute on function public.check_invite(text) to anon, authenticated;

-- ── 4-3. 행이 이미 있는지 (정책용) ──────────────────────────────
-- upsert는 INSERT 정책도 거친다. 편집 권한을 받은 회원이 남의 글을 「다시 저장」하는 것은 허용하고
-- 남의 이름으로 「새로 만드는」 것은 막으려면 테이블을 봐야 하는데, 정책 안에서 같은 테이블을 직접 보면
-- 재귀 오류가 난다 → 정의자 권한 함수로 본다
create or replace function public.row_exists(tbl text, row_id text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare hit boolean;
begin
  execute format('select exists (select 1 from public.%I where id = $1)', tbl) into hit using row_id;
  return hit;
end $$;

-- ── 5. 가입 시 프로필 자동 생성 (첫 가입자 = 관리자) + 가입코드 검사 ─────────
-- 가입코드 검사는 여태 가입 화면(브라우저)에서만 했다 — 공개 anon 키로 Auth API에 직접 가입하면 코드 없이
-- 회원이 됐다 (보안 제보). 이제 코드가 틀리면 여기서 예외를 던져 계정 자체가 만들어지지 않는다.
-- 코드는 가입 화면이 user metadata(invite)에 실어 보낸다. 첫 가입자(관리자)는 코드 없이 된다.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare existing int;
begin
  select count(*) into existing from public.profiles;
  if existing > 0 and not public.check_invite(new.raw_user_meta_data->>'invite') then
    raise exception 'invalid invite code';
  end if;
  insert into public.profiles (id, nickname, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)),
    case when existing = 0 then 'admin' else 'member' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 5-1. role은 관리자만 바꿀 수 있다 (보안 제보 — 회원이 자기 profiles 행의 role을 'admin'으로 고쳐 스스로 승격할 수 있었다) ──
-- 아래 profiles_update_own 정책은 「자기 행 수정」을 열(column) 구분 없이 허용한다. 접속 정보(anon 키)는 원래 공개라
-- 로그인한 회원이면 누구나 PostgREST로 자기 행을 고칠 수 있으므로, role 열만은 트리거로 지킨다.
--  · UPDATE: 관리자가 아니면 role은 예전 값 그대로 (조용히 되돌린다 — 앱의 프로필 저장(upsert)은 role을 보내지 않는다)
--  · INSERT: 이미 관리자가 있으면 admin으로 들어올 수 없다 (첫 가입자 = 관리자 규칙은 그대로 — 그때는 관리자가 없다)
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.role is distinct from old.role and not public.is_admin() then
      new.role := old.role;
    end if;
  elsif tg_op = 'INSERT' then
    if new.role = 'admin' and not public.is_admin()
       and exists (select 1 from public.profiles where role = 'admin') then
      new.role := 'member';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before insert or update on public.profiles
  for each row execute function public.guard_profile_role();

-- ── 6. 콘텐츠 테이블 23종 ────────────────────────────────────
-- 항목 하나 = 행 하나 (행 단위 권한·실시간). 항목의 세부 필드는 data(jsonb)에 담고,
-- 권한·정렬·필터에 쓰는 값만 별도 컬럼으로 뽑아 둔다.
do $$
declare t text;
declare content_tables text[] := array[
  'posts',        -- 게시판 글
  'guestbook',    -- 방명록
  'characters',   -- 캐릭터
  'relations',    -- 자관
  'gallery',      -- 그림 백업(갤러리)
  'roadview',     -- 로드뷰
  'trpg_logs',        -- TRPG 로그(목록 문서 — 본문 제외)
  'trpg_log_bodies',  -- TRPG 로그 본문 (v2.0, 목록과 분리 저장 — 나만보기 로그의 본문 보호용)
  'trpg_chars',   -- TRPG 캐릭터
  'dotori',       -- 도토리
  'playlog',      -- 플레이기록
  'rp_rooms',     -- 역극 방
  'rp_typing',    -- 역극 입력 중 표시 (커플홈 — 사람마다 한 줄, 임시)
  'threads',      -- 감상타래
  'diary',        -- 다이어리
  'memos',        -- 스티커 메모
  'commissions',  -- 커미션
  'applicants',   -- 신청자
  'moods',        -- 무드 목록
  'comments',     -- 댓글 (v2.0 — 글 안이 아니라 자기 행으로. 글을 수정하지 않고 댓글을 달 수 있게)
  'qa_answers',   -- 자관 문답 답변 (v2.0 — 같은 이유로 자관 안이 아니라 자기 행으로)
  'rp_messages',  -- 역극 발화 (v2.0 — 같은 이유로 방 안이 아니라 자기 행으로)
  'thread_posts', -- 감상타래 글 (커플홈 — 같은 이유로 타래 안이 아니라 자기 행으로. 두 사람이 같이 쓴다)
  'videos',       -- Videos 게시판 (커플홈 — 영상 하나를 파일·링크로)
  'notifications', -- 알림 (v2.0 — 기기 보관이던 것을 서버로: 받은 사람 계정으로 어느 기기에서나)
  'push_subs'      -- 웹푸시 기기 구독 (커플홈 — 회원끼리 읽힌다: 보내는 쪽이 받는 사람 구독을 읽어야. 서버 개인키 없이는 못 보낸다)
];
begin
  foreach t in array content_tables loop
    execute format($f$
      create table if not exists public.%I (
        id          text primary key,
        data        jsonb not null default '{}'::jsonb,
        author_id   uuid references auth.users(id) on delete set null,
        visibility  text not null default 'public',
        sort        double precision not null default 0,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      )$f$, t);

    -- 편집 권한을 받은 회원 (v2.0) — 캐릭터 grants의 「편집까지」 대상. 이미 만든 테이블에도 붙는다
    execute format($f$
      alter table public.%I add column if not exists editor_ids text[] not null default '{}'::text[]
    $f$, t);

    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I (sort)', t || '_sort_idx', t);

    -- 읽기: 전체공개 / 멤버공개(회원 — 프로필이 있는 계정) / 본인 글 / 관리자
    execute format('drop policy if exists "read" on public.%I', t);
    execute format($p$
      create policy "read" on public.%I for select using (
        visibility = 'public'
        or (visibility = 'member' and (select public.is_member()))
        or author_id = auth.uid()
        or public.is_admin()
      )$p$, t);

    -- 쓰기: 회원 — 글의 주인(author_id)은 자기 자신 (남의 이름으로는 만들 수 없다 — 보안 제보).
    -- 관리자는 백업 복원 때문에 예외. 편집 권한을 받은 회원(editor_ids)은 남의 글을 다시 저장(upsert — INSERT 정책도
    -- 거친다)할 수 있어야 하므로, **이미 있는 행**에 한해 예외 (새 행을 남의 이름으로 만드는 것은 불가).
    -- (방명록·댓글·알림은 아래에서 따로 — 비로그인 방문자 허용)
    execute format('drop policy if exists "insert" on public.%I', t);
    execute format($p$
      create policy "insert" on public.%I for insert to authenticated
        with check ((select public.is_member())
                    and (author_id = auth.uid() or public.is_admin()
                         or (auth.uid()::text = any(editor_ids) and public.row_exists(%L, id))))$p$, t, t);

    -- 수정·삭제: 본인 · 편집 권한을 받은 회원(editor_ids) · 관리자 (모두 회원이어야 한다)
    execute format('drop policy if exists "update" on public.%I', t);
    execute format($p$
      create policy "update" on public.%I for update to authenticated
        using ((select public.is_member())
               and (author_id = auth.uid() or public.is_admin()
                    or auth.uid()::text = any(editor_ids)))$p$, t);

    execute format('drop policy if exists "delete" on public.%I', t);
    execute format($p$
      create policy "delete" on public.%I for delete to authenticated
        using ((select public.is_member())
               and (author_id = auth.uid() or public.is_admin()
                    or auth.uid()::text = any(editor_ids)))$p$, t);
  end loop;
end $$;

-- 방명록·게시판 댓글은 비로그인 방문자도 남길 수 있음 (닉네임+비밀번호 방식) — 그때 author_id는 비어 있다.
-- 회원이 남길 때는 자기 uid여야 한다 (남의 이름으로는 못 만든다 — 보안 제보)
drop policy if exists "insert" on public.guestbook;
create policy "insert" on public.guestbook for insert
  with check (author_id is null or (author_id = auth.uid() and (select public.is_member())) or public.is_admin());

-- 댓글도 비로그인 방문자가 남길 수 있다 (닉네임+비밀번호 방식 — 방명록과 동일, v2.0).
-- 수정·삭제는 위 공통 정책 그대로: 작성자 본인 또는 관리자.
drop policy if exists "insert" on public.comments;
create policy "insert" on public.comments for insert
  with check (author_id is null or (author_id = auth.uid() and (select public.is_member())) or public.is_admin());

-- 알림도 비로그인 방문자가 만들 수 있다 (v2.0) — 손님 댓글·방명록이 관리자에게 알림을 남겨야 하므로.
-- 행의 주인(author_id)은 받는 사람이라 남의 uid를 적는 게 정상 — 회원은 누구에게나, 손님은 관리자에게만.
-- 읽기·수정·삭제는 받는 사람과 관리자만 (공통 정책 그대로).
drop policy if exists "insert" on public.notifications;
create policy "insert" on public.notifications for insert
  with check ((select public.is_member())
              or author_id in (select p.id from public.profiles p where p.role = 'admin'));

-- ── 7. 사이트 설정 권한 (읽기 공개 · 쓰기 관리자) ────────────
alter table public.profiles enable row level security;
alter table public.invite_codes enable row level security;
alter table public.site_settings enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select using (true);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (auth.uid() = id or public.is_admin());
-- 프로필 저장은 upsert(INSERT 경로)라 INSERT 정책이 없으면 행이 이미 있어도 거부된다
-- ("new row violates row-level security policy" — v2.0 포크 제보). 자기 행만.
-- 단, 행이 이미 있는(= 가입 트리거가 만든) 계정만 — 관리자가 회원 목록에서 지운 계정이 자기 프로필을
-- 다시 만들어 회원으로 돌아오지 못하게 (보안 제보). 프로필은 가입 트리거가 만들므로 회원이 새로 만들 일은 없다.
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles for insert to authenticated
  with check ((auth.uid() = id and (select public.is_member())) or public.is_admin());
drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin" on public.profiles for delete to authenticated
  using (public.is_admin());

-- invite_codes 표는 앱이 쓰지 않는다 — 관리자만 (예전엔 누구나 읽고 고칠 수 있었다 — 보안 제보)
drop policy if exists "invite_select" on public.invite_codes;
create policy "invite_select" on public.invite_codes for select to authenticated using (public.is_admin());
drop policy if exists "invite_write" on public.invite_codes;
create policy "invite_write" on public.invite_codes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "invite_use" on public.invite_codes;

-- 사이트 설정은 읽기 공개 — 단 가입코드(ohome.invite.v1)만은 관리자만 (방문자가 읽을 수 있으면 코드가 무의미하다 — 보안 제보)
drop policy if exists "settings_select" on public.site_settings;
create policy "settings_select" on public.site_settings for select
  using (key <> 'ohome.invite.v1' or public.is_admin());
drop policy if exists "settings_write" on public.site_settings;
create policy "settings_write" on public.site_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── 8. 이미지 저장소 (Storage 버킷) ──────────────────────────
insert into storage.buckets (id, name, public)
values ('ohome', 'ohome', true)
on conflict (id) do nothing;

drop policy if exists "ohome_read" on storage.objects;
create policy "ohome_read" on storage.objects for select using (bucket_id = 'ohome');
-- 올리기·고치기는 회원만 (프로필이 있는 계정 — 보안 제보: 계정만 만든 외부인이 저장소를 채우지 못하게)
drop policy if exists "ohome_write" on storage.objects;
create policy "ohome_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'ohome' and (select public.is_member()));
drop policy if exists "ohome_update" on storage.objects;
create policy "ohome_update" on storage.objects for update to authenticated
  using (bucket_id = 'ohome' and (select public.is_member()));
drop policy if exists "ohome_delete" on storage.objects;
create policy "ohome_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ohome' and (owner = auth.uid() or public.is_admin()));

-- ── 9. 실시간 (역극·문답 티키타카) ───────────────────────────
do $$
declare t text;
begin
  -- 발화·답변·댓글이 각자 행으로 분리됐으므로(v2.0) 실시간도 그 테이블을 봐야 한다
  foreach t in array array['rp_rooms', 'rp_messages', 'rp_typing', 'relations', 'qa_answers', 'posts', 'comments', 'guestbook', 'notifications', 'thread_posts'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null;  -- 이미 추가돼 있으면 무시
    end;
  end loop;
end $$;

-- ── 10. 스키마 캐시 갱신 (중요) ──────────────────────────────
-- PostgREST(= REST API)는 테이블·컬럼 목록을 캐시해 둔다. SQL로 컬럼을 새로 추가해도
-- 캐시가 갱신되기 전에는 API가 그 컬럼을 모른다 —
--   Could not find the 'editor_ids' column of 'posts' in the schema cache (PGRST204)
-- 실제로 업데이트 후 「글을 저장하지 못했습니다」로 나타났다. 마지막에 캐시를 새로 읽게 한다.
notify pgrst, 'reload schema';

-- ── 완료 ─────────────────────────────────────────────────────
-- 이 스크립트를 실행한 뒤, 홈의 설치 화면에서 [연결 확인]을 누르면 검증됩니다.
-- 첫 번째로 가입하는 계정이 자동으로 관리자가 됩니다. 그 다음부터는 가입코드(환경설정 → 회원/보안,
-- 기본 WELCOME — 꼭 바꾸세요)를 맞혀야 가입됩니다. 가입 화면을 거치지 않고 계정만 만들 수는 없습니다.
`;
