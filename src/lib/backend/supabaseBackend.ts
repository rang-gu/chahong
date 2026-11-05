'use client';
// Supabase 백엔드 — Postgres 테이블(행 단위) + Auth + Storage + Realtime
// 스키마·권한: supabase/schema.sql
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Backend, BackendCheck, BackendConfig, BackendUser, ListItem, diffList, metaOf,
} from './types';
import { visFloorOf } from '../visFloor';

const BUCKET = 'ohome';
const PROBE = ['profiles', 'site_settings', 'posts', 'characters'];

export async function createSupabaseBackend(
  cfg: Extract<BackendConfig, { kind: 'supabase' }>,
): Promise<Backend> {
  const { createBrowserClient } = await import('@supabase/ssr');
  const sb: SupabaseClient = createBrowserClient(cfg.url.replace(/\/$/, ''), cfg.anonKey);

  const toUser = async (u: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined): Promise<BackendUser | null> => {
    if (!u) return null;
    const { data: prof } = await sb.from('profiles')
      .select('nickname, role, avatar_url, avatar_color').eq('id', u.id).maybeSingle();
    return {
      id: u.id,
      nickname: prof?.nickname ?? (u.user_metadata?.nickname as string) ?? u.email ?? 'user',
      role: (prof?.role as 'admin' | 'member') ?? 'member',
      email: u.email,
      avatarUrl: prof?.avatar_url ?? undefined,
      avatarColor: prof?.avatar_color ?? undefined,
    };
  };

  return {
    kind: 'supabase',

    async check(): Promise<BackendCheck> {
      const fail = (p: Partial<BackendCheck>): BackendCheck =>
        ({ ok: false, reachable: false, schema: false, hasAdmin: false, message: '', ...p });
      let reachable = false;
      try {
        const { error } = await sb.from('profiles').select('id').limit(1);
        if (error) {
          if (error.code === '42P01' || /does not exist/i.test(error.message)) reachable = true;
          else if (/JWT|api key|Invalid/i.test(error.message)) {
            return fail({ message: 'anon key가 올바르지 않습니다 — Supabase → Settings → API에서 anon public 키를 다시 복사해 주세요.' });
          } else if (/fetch|network|Load failed/i.test(error.message)) {
            return fail({ message: '프로젝트에 닿지 못했습니다 — Project URL이 정확한지, 프로젝트가 일시정지(Paused) 상태는 아닌지 확인해 주세요.' });
          } else return fail({ message: `연결에 실패했습니다 — ${error.message}` });
        } else reachable = true;
      } catch {
        return fail({ message: '프로젝트에 접속할 수 없습니다 — URL을 확인해 주세요.' });
      }

      const missing: string[] = [];
      for (const t of PROBE) {
        const { error } = await sb.from(t).select('*', { head: true, count: 'exact' }).limit(1);
        if (error && (error.code === '42P01' || /does not exist/i.test(error.message))) missing.push(t);
      }
      if (missing.length) {
        return fail({ reachable, message: `스키마가 아직 없습니다 (${missing.join(', ')}) — 아래 SQL을 Supabase의 SQL Editor에서 한 번 실행해 주세요.` });
      }

      const { count } = await sb.from('profiles').select('id', { head: true, count: 'exact' }).eq('role', 'admin');
      const hasAdmin = (count ?? 0) > 0;
      return {
        ok: true, reachable, schema: true, hasAdmin,
        message: hasAdmin ? '연결 완료 — 관리자 계정이 이미 있습니다. 그 계정으로 로그인해 주세요.'
          : '연결 완료 — 이제 관리자 계정을 만들면 됩니다. 첫 번째 가입 계정이 관리자가 됩니다.',
      };
    },

    async currentUser() {
      const { data } = await sb.auth.getUser();
      return toUser(data.user);
    },

    onAuthChange(cb) {
      const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
        void toUser(session?.user).then(cb);
      });
      return () => sub.subscription.unsubscribe();
    },

    async signIn(id, password) {
      const { error } = await sb.auth.signInWithPassword({ email: id, password });
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async signUp(id, password, nickname, invite) {
      if (invite !== undefined) {
        const chk = await sb.rpc('check_invite', { code: invite });
        if (!chk.error && chk.data === false) return { ok: false, error: '가입코드가 올바르지 않습니다.' };
      }
      const data = invite !== undefined ? { nickname, invite } : { nickname };
      const { error } = await sb.auth.signUp({ email: id, password, options: { data } });
      if (!error) return { ok: true };
      if (/database error/i.test(error.message)) return { ok: false, error: '가입코드가 올바르지 않습니다. (서버가 가입을 거부했습니다)' };
      return { ok: false, error: error.message };
    },

    async signOut() { await sb.auth.signOut(); },

    async authToken() {
      const { data } = await sb.auth.getSession();
      return data.session?.access_token ?? null;
    },

    async resetPassword(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email);
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async updateProfile(patch) {
      const { data } = await sb.auth.getUser();
      if (!data.user) return { ok: false, error: '로그인이 필요합니다.' };
      if (patch.newPassword) {
        if (!data.user.email) return { ok: false, error: '이 계정은 이메일/비밀번호 로그인이 아니라 비밀번호를 바꿀 수 없습니다.' };
        if (!patch.currentPassword) return { ok: false, error: '현재 비밀번호를 입력해 주세요.' };
        const chk = await sb.auth.signInWithPassword({ email: data.user.email, password: patch.currentPassword });
        if (chk.error) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };
        const up = await sb.auth.updateUser({ password: patch.newPassword });
        if (up.error) return { ok: false, error: up.error.message };
      }
      const row: Record<string, unknown> = { id: data.user.id };
      if (patch.nickname !== undefined) row.nickname = patch.nickname;
      if (patch.avatarUrl !== undefined) row.avatar_url = patch.avatarUrl;
      if (patch.avatarColor !== undefined) row.avatar_color = patch.avatarColor;
      if (Object.keys(row).length === 1) return { ok: true };
      const { error } = await sb.from('profiles').upsert(row, { onConflict: 'id' });
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async claimOwner() { return { ok: true }; },

    async getInviteCode() {
      const { data } = await sb.from('site_settings').select('value').eq('key', 'ohome.invite.v1').maybeSingle();
      const v = (data as { value?: unknown } | null)?.value;
      const code = typeof v === 'string' && v.trim() ? v.trim() : 'WELCOME';
      const probe = await sb.rpc('check_invite', { code: '' });
      return { code, legacy: !!probe.error };
    },

    async setInviteCode(code) {
      const { error } = await sb.from('site_settings')
        .upsert({ key: 'ohome.invite.v1', value: code.trim(), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) return { ok: false, error: error.message };
      const probe = await sb.rpc('check_invite', { code: '' });
      return probe.error ? { ok: true, legacy: true } : { ok: true };
    },

    async listMembers() {
      const { data, error } = await sb.from('profiles').select('id, nickname, role, avatar_url').order('created_at');
      if (error) throw error;
      return (data ?? []).map(r => {
        const p = r as { id: string; nickname: string; role: string; avatar_url?: string | null };
        return {
          id: p.id, nickname: p.nickname, role: (p.role as 'admin' | 'member') ?? 'member',
          avatarUrl: p.avatar_url ?? undefined,
        };
      });
    },

    async fetchList<T extends ListItem>(coll: string): Promise<T[]> {
      const { data, error } = await sb.from(coll).select('id, data, sort').order('sort', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(r => {
        const item = r as { id: string; data: unknown; sort: number };
        return { id: item.id, data: item.data, sort: item.sort } as T;
      });
    },

    async syncList<T extends ListItem>(coll: string, onChange: (list: T[]) => void): Promise<() => void> {
      let current: T[] = [];
      
      const fetchAndTrigger = async () => {
        try {
          const list = await this.fetchList<T>(coll);
          current = list;
          onChange(list);
        } catch (e) {
          console.error(`[Supabase Sync ${coll}] Fetch failed`, e);
        }
      };

      await fetchAndTrigger();

      // 수정 핵심 지점: .on() 리스너를 먼저 완벽히 결합하고, .subscribe()를 맨 마지막에 붙여 호출 구조를 맞춥니다.
      const channel = sb
        .channel(`realtime:ohome:${coll}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: coll }, (payload) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as { id: string; data: unknown; sort: number };
            const item = { id: row.id, data: row.data, sort: row.sort } as T;
            current = [...current, item].sort((a, b) => a.sort - b.sort);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as { id: string; data: unknown; sort: number };
            const item = { id: row.id, data: row.data, sort: row.sort } as T;
            current = current.map(img => img.id === item.id ? item : img).sort((a, b) => a.sort - b.sort);
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as { id: string };
            current = current.filter(img => img.id !== row.id);
          }
          onChange(current);
        })
        .subscribe();

      return () => {
        void sb.removeChannel(channel);
      };
    },

    async saveList<T extends ListItem>(coll: string, orig: T[], next: T[]): Promise<void> {
      const { ins, upd, del } = diffList(orig, next);
      
      if (del.length) {
        const { error } = await sb.from(coll).delete().in('id', del.map(i => i.id));
        if (error) throw error;
      }
      
      if (ins.length) {
        const rows = ins.map(i => ({ id: i.id, data: i.data, sort: i.sort }));
        const { error } = await sb.from(coll).insert(rows);
        if (error) throw error;
      }
      
      if (upd.length) {
