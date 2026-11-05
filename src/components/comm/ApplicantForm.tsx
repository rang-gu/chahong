'use client';
// 신청자 등록/수정 공용 폼 (4.18) — 가운데 정렬 단일 패널 · 내용은 리치 에디터 ·
// CANCEL/저장 버튼은 패널 오른쪽 아래
import React, { useRef, useState } from 'react';
import { Applicant, CommItem, CommSettings, applyVis, APPLY_VIS_LABEL } from '@/lib/commStore';
import { useMembers } from '@/lib/members';
import { putBlob } from '@/lib/blobStore';
import { fileDrop } from '@/lib/dnd';
import { KInput, KSelect, KDate } from '@/components/ui/Kit';
import { RichEditor } from '@/components/ui/RichEditor';
import { useToast } from '@/components/ui/Toast';

export function ApplicantForm({ initial, comms, settings, onSave, onCancel }: {
  initial: Applicant | null;
  comms: CommItem[];
  settings: CommSettings;
  onSave: (v: Omit<Applicant, 'id'>) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const isNew = !initial;
  const [deadline, setDeadline] = useState(initial?.deadline ?? '');
  const [badgeId, setBadgeId] = useState(initial?.badgeId ?? settings.applyBadges[0]?.id ?? 'wait');
  const [name, setName] = useState(initial?.name ?? '');
  const [nameOpen, setNameOpen] = useState(String(initial?.nameOpen ?? 1));
  const [source, setSource] = useState(initial?.source ?? '');
  const [appliedDate, setAppliedDate] = useState(initial?.appliedDate ?? '');
  const [commId, setCommId] = useState(initial?.commId ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [contentVis, setContentVis] = useState<'private' | 'self' | 'public'>(
    initial ? applyVis(initial) : 'private');
  // 본인 열람 허용 — 지정 회원 (검색해서 드롭다운 선택)
  const pool = useMembers();
  const [selfId, setSelfId] = useState(initial?.selfId ?? '');
  const [selfQ, setSelfQ] = useState(() => pool.find(p => p.id === initial?.selfId)?.nickname ?? '');
  const [selfOpen, setSelfOpen] = useState(false);
  // 제출받은 신청서 HTML (선택) — blob 저장
  const [submitFileId, setSubmitFileId] = useState<string | undefined>(initial?.submitFileId);
  const [submitFileName, setSubmitFileName] = useState('');
  const htmlRef = useRef<HTMLInputElement>(null);
  const pickHtml = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast('신청서 파일은 20MB까지 업로드할 수 있습니다'); return; }
    setSubmitFileId(await putBlob(f));
    setSubmitFileName(f.name);
    toast('신청서 파일이 첨부되었습니다');
  };
  const selfMatches = pool.filter(p =>
    !selfQ.trim() || p.nickname.toLowerCase().includes(selfQ.trim().toLowerCase())
    || p.id.toLowerCase().includes(selfQ.trim().toLowerCase()));

  const save = () => {
    if (!name.trim()) { toast('신청자 표기를 입력해 주세요'); return; }
    onSave({
      deadline: deadline || undefined, badgeId, name: name.trim(),
      nameOpen: Math.max(0, parseInt(nameOpen, 10) || 0),
      source: source.trim() || undefined,
      appliedDate: appliedDate || undefined, commId: commId || undefined,
      content, contentVis, allowSelf: contentVis === 'self', // allowSelf는 구버전 호환용
      selfId: contentVis === 'self' ? (selfId || undefined) : undefined,
      submitFileId,
    });
  };

  return (
    <div className="panel" style={{ maxWidth: 620, margin: '0 auto', padding: 26, display: 'grid', gap: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label className="k-label" style={{ marginBottom: 5 }}>마감일 (선택)</label>
          <KDate value={deadline} onChange={setDeadline} style={{ width: '100%' }} />
        </div>
        <div>
          <label className="k-label" style={{ marginBottom: 5 }}>신청일 (선택)</label>
          <KDate value={appliedDate} onChange={setAppliedDate} style={{ width: '100%' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          {/* 이름 전체 저장 — 비권한자에게는 공개 글자 수만큼만 보이고 나머지는 * 마스킹 */}
          <label className="k-label" style={{ marginBottom: 5 }}>신청자 이름 — 관리자만 전체 표시</label>
          <KInput value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ width: 110 }}>
          <label className="k-label" style={{ marginBottom: 5 }}>공개 글자 수</label>
          <KInput value={nameOpen} onChange={e => setNameOpen(e.target.value.replace(/[^\d]/g, ''))}
            style={{ textAlign: 'center' }} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label className="k-label" style={{ marginBottom: 5 }}>진행 상태</label>
          <KSelect value={badgeId} onChange={setBadgeId}
            options={settings.applyBadges.map(b => ({ value: b.id, label: b.label }))} />
        </div>
        <div>
          <label className="k-label" style={{ marginBottom: 5 }}>신청 커미션</label>
          <KSelect value={commId} onChange={setCommId} placeholder="선택 안 함"
            options={[{ value: '', label: '선택 안 함' }, ...comms.map(cm => ({ value: cm.id, label: cm.name }))]} />
        </div>
      </div>
      <div>
        <label className="k-label" style={{ marginBottom: 5 }}>출처 (선택) — 커미션을 받은 곳</label>
        <KInput value={source} onChange={e => setSource(e.target.value)} />
      </div>
      <div>
        <label className="k-label" style={{ marginBottom: 5 }}>내용</label>
        <RichEditor value={content} onChange={setContent} placeholder="신청 내용을 작성하세요" />
      </div>
      {/* 제출받은 신청서 HTML (선택, v1.9) — 커미션 양식으로 받은 파일을 올려두면 리스트에서 열람 */}
      <div>
        <label className="k-label" style={{ marginBottom: 5 }}>신청서 HTML (선택)</label>
        <input ref={htmlRef} type="file" accept=".html,text/html" style={{ display: 'none' }}
          onChange={e => { pickHtml(e.target.files?.[0]); e.target.value = ''; }} />
        {submitFileId ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="pill dark">HTML</span>
            <small style={{ color: 'var(--sub)', fontSize: 12 }}>{submitFileName || '첨부된 신청서'}</small>
            <span className="fx" onClick={() => { setSubmitFileId(undefined); setSubmitFileName(''); }}>✕</span>
          </div>
        ) : (
          <button className="btn btn-ghost" style={{ padding: '6px 13px', fontSize: 11 }}
            onClick={() => htmlRef.current?.click()}
            {...fileDrop(fl => pickHtml(fl[0]))}>↑ 파일 선택</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <label className="k-label" style={{ marginBottom: 5 }}>내용 공개범위</label>
          <KSelect value={contentVis} onChange={v => setContentVis(v as 'private')}
            options={[
              { value: 'private', label: APPLY_VIS_LABEL.private },
              { value: 'self', label: APPLY_VIS_LABEL.self },
              { value: 'public', label: APPLY_VIS_LABEL.public },
            ]} />
        </div>
        {/* 본인 열람 허용 — 어느 회원이 본인인지 검색해서 선택 (v1.9) */}
        {contentVis === 'self' && (
          <div style={{ flex: 1, minWidth: 180, position: 'relative' }}>
            <label className="k-label" style={{ marginBottom: 5 }}>본인 (회원 검색)</label>
            <KInput value={selfQ}
              onChange={e => { setSelfQ(e.target.value); setSelfId(''); setSelfOpen(true); }}
              onFocus={() => setSelfOpen(true)}
              onBlur={() => setTimeout(() => setSelfOpen(false), 150)} />
            {selfId && (
              <small style={{ position: 'absolute', right: 8, top: 33, fontSize: 10.5, color: 'var(--accent)', fontWeight: 700 }}>✓</small>
            )}
            {selfOpen && selfMatches.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 4,
                background: 'var(--panel-solid)', border: '1px solid var(--line)', borderRadius: 10,
                boxShadow: 'var(--sh-dd)', padding: 4, maxHeight: 180, overflow: 'auto',
              }}>
                {selfMatches.map(p => (
                  <button key={p.id} type="button"
                    style={{
                      display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left',
                      padding: '7px 10px', borderRadius: 7, fontSize: 12.5,
                      background: selfId === p.id ? 'var(--btn-dark,#1d2025)' : undefined,
                      color: selfId === p.id ? 'var(--btn-dark-fg,#fff)' : 'var(--ink)',
                    }}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { setSelfId(p.id); setSelfQ(p.nickname); setSelfOpen(false); }}>
                    <span>{p.nickname}</span>
                    <small style={{ color: selfId === p.id ? 'inherit' : 'var(--faint)' }}>{p.id}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {/* 버튼 — 패널 오른쪽 아래 */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn btn-ghost" onClick={onCancel}>CANCEL</button>
        <button className="btn btn-accent" style={{ padding: '9px 26px' }} onClick={save}>
          {isNew ? 'ADD' : 'SAVE'}
        </button>
      </div>
    </div>
  );
}
