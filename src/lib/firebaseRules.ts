'use client';
// 설치 화면에서 복사해 쓰는 Firebase 보안 규칙 — 원본: firebase/firestore.rules · firebase/storage.rules
// (원본을 고치면 이 파일도 함께 갱신)

export const FIRESTORE_RULES = `rules_version = '2';

// ============================================================
// O.HOME Firestore 보안 규칙
// Firebase 콘솔 → Firestore Database → 규칙 에 붙여넣고 [게시].
//
// 문서 구조
//   meta/owner            { uid, admins[] }   ← 첫 로그인 계정이 1회만 자기를 등록
//   meta/invite           { code }            ← 가입코드 (관리자만 읽고 쓴다 — 환경설정 → 회원/보안)
//   signups/{uid}         { code }            ← 가입 직후 코드를 적어 내는 자리 (맞을 때만 만들어지고 아무도 못 읽는다)
//   profiles/{uid}        { nickname, avatarUrl, avatarColor }
//   settings/{key}        { value }           ← 테마·메뉴·폰트·메인 위젯 등
//   <콘텐츠>/{id}          { data, authorId, visibility, sort }
//   push_subs/{id}        ← 웹푸시 기기 구독 (콘텐츠 규칙 그대로 — 주인은 그 회원, member 공개라 회원끼리 읽힌다.
//                            구독만으로는 아무도 못 보낸다: 서버의 개인키로 서명해야 푸시 서비스가 받는다)
//
// 회원 = 로그인 계정 + profiles 문서 (보안 제보).
//   Firebase Authentication 계정은 공개 apiKey만으로 누구나 만들 수 있다 — 가입 화면을 거치지 않고 REST API로.
//   그래서 「로그인했다 = 회원」으로 보면 가입코드가 무의미했다. 이제 profiles 문서는 가입코드를 맞힌
//   계정(signups/{uid})만 만들 수 있고, 회원 권한(멤버공개 읽기·글쓰기)은 profiles 문서가 있어야 생긴다.
//   관리자가 회원 목록에서 지운 계정은 프로필이 없어 권한도 없다 (계정 자체는 콘솔에서만 지울 수 있다).
// ============================================================

service cloud.firestore {
  match /databases/{database}/documents {

    // 로그인 계정이 있다 — 회원인지는 isMember()로 본다 (계정은 누구나 만들 수 있으므로)
    function signedIn() {
      return request.auth != null;
    }

    function ownerData() {
      return get(/databases/$(database)/documents/meta/owner).data;
    }

    function isAdmin() {
      return signedIn()
        && exists(/databases/$(database)/documents/meta/owner)
        && (ownerData().uid == request.auth.uid
            || (ownerData().keys().hasAny(['admins']) && request.auth.uid in ownerData().admins));
    }

    // 회원 — 프로필 문서가 있는 계정 (가입코드를 통과해야 생긴다). 관리자는 늘 회원
    function isMember() {
      return signedIn()
        && (isAdmin() || exists(/databases/$(database)/documents/profiles/$(request.auth.uid)));
    }

    // 가입코드 — meta/invite 에 저장, 아직 없으면 기본값 WELCOME (환경설정 → 회원/보안에서 바꾸면 저장된다)
    function inviteCode() {
      return exists(/databases/$(database)/documents/meta/invite)
        ? get(/databases/$(database)/documents/meta/invite).data.code
        : 'WELCOME';
    }

    // 새로 쓰는 문서의 주인(authorId) — 없으면 null
    function newAuthor() {
      return request.resource.data.get('authorId', null);
    }

    // 관리자 uid인지 (손님 알림의 받는 사람 확인용)
    function isAdminUid(uid) {
      return exists(/databases/$(database)/documents/meta/owner)
        && (ownerData().uid == uid
            || (ownerData().keys().hasAny(['admins']) && uid in ownerData().admins));
    }

    // 콘텐츠 컬렉션 목록 — 여기 없는 이름은 아무 권한도 없다
    function isContent(name) {
      return name in [
        'posts', 'guestbook', 'characters', 'relations', 'gallery', 'roadview',
        'trpg_logs', 'trpg_log_bodies', 'trpg_chars', 'dotori', 'playlog', 'rp_rooms', 'threads',
        'diary', 'memos', 'commissions', 'applicants', 'moods', 'comments', 'qa_answers', 'rp_messages',
        'notifications', 'thread_posts', 'videos', 'rp_typing', 'push_subs'
      ];
    }

    // ── 소유자(관리자) 지정 — 아직 없을 때 딱 한 번 ──────────────
    match /meta/owner {
      allow read: if true;
      allow create: if signedIn() && !exists(/databases/$(database)/documents/meta/owner);
      allow update, delete: if isAdmin();
    }

    // ── 가입코드 — 관리자만 (방문자가 읽을 수 있으면 코드가 무의미하다) ──
    match /meta/invite {
      allow read, write: if isAdmin();
    }

    // ── 가입코드 확인 — 가입 직후 자기 uid로 코드를 적어 낸다. 맞을 때만 만들어지고, 아무도 읽을 수 없다 ──
    match /signups/{uid} {
      allow create: if signedIn() && request.auth.uid == uid
        && request.resource.data.code == inviteCode();
      allow delete: if isAdmin();
    }

    // ── 회원 프로필 ─────────────────────────────────────────────
    match /profiles/{uid} {
      allow read: if true;
      // 만들기: 관리자 · 설치 중(아직 소유자가 없을 때 — 첫 관리자 계정) · 가입코드를 맞힌 본인
      allow create: if signedIn() && (
        isAdmin()
        || !exists(/databases/$(database)/documents/meta/owner)
        || (request.auth.uid == uid && exists(/databases/$(database)/documents/signups/$(uid)))
      );
      allow update: if signedIn() && (request.auth.uid == uid || isAdmin());
      allow delete: if isAdmin();
    }

    // ── 사이트 설정 (읽기 공개 · 쓰기 관리자) — 가입코드는 여기 두지 않는다(meta/invite) ──
    match /settings/{key} {
      allow read: if true;
      allow write: if isAdmin();
    }

    // ── 콘텐츠 ─────────────────────────────────────────────────
    match /{coll}/{docId} {
      // 읽기: 전체공개 / 멤버공개(회원) / 내가 쓴 것 / 관리자
      allow read: if isContent(coll) && (
        resource.data.visibility == 'public'
        || (resource.data.visibility == 'member' && isMember())
        || (isMember() && resource.data.authorId == request.auth.uid)
        || isAdmin()
      );

      // 만들기: 회원 — 글의 주인(authorId)은 자기 자신 (남의 이름으로는 만들 수 없다 · 관리자는 백업 복원 때문에 예외)
      //  · 방명록·댓글은 비로그인 방문자도 남길 수 있음(닉네임+비밀번호 방식) — 그때 authorId는 비어 있다
      //  · notifications: 받는 사람이 행 주인(authorId)이라 남의 uid를 적는 게 정상 (v2.0) —
      //    회원은 누구에게나, 손님(댓글·방명록 알림)은 관리자에게만
      allow create: if isContent(coll) && (
        (isMember() && (newAuthor() == request.auth.uid || isAdmin() || coll == 'notifications'))
        || (coll in ['guestbook', 'comments'] && newAuthor() == null)
        || (coll == 'notifications' && newAuthor() is string && isAdminUid(newAuthor()))
      );

      // 수정·삭제: 작성자 본인 · 편집 권한을 받은 회원 · 관리자 — 주인(authorId)은 바꿀 수 없다(관리자 제외)
      // 댓글은 글과 따로 저장되므로(v2.0) 댓글을 달 때 글을 수정할 필요가 없다 —
      // 예전엔 댓글이 글 안에 있어서 일반 회원이 관리자 글에 댓글을 달면 이 규칙에 막혔다.
      // 게스트 댓글(로그인 없이 남긴 것)은 authorId가 비어 있어 본인 확인이 안 되므로
      // 지우는 것은 관리자만 — 방명록의 게스트 글과 같은 규칙이다.
      // editorIds: 캐릭터에 「편집까지」 권한을 준 회원 (v2.0). grants는 객체 배열이라
      // 규칙에서 훑을 수 없어, 저장할 때 회원 id만 뽑아 둔 평평한 배열을 본다.
      allow update: if isContent(coll)
        && isMember()
        && (resource.data.authorId == request.auth.uid
            || isAdmin()
            || (resource.data.keys().hasAny(['editorIds'])
                && request.auth.uid in resource.data.editorIds))
        && (isAdmin() || newAuthor() == resource.data.get('authorId', null));
      allow delete: if isContent(coll)
        && isMember()
        && (resource.data.authorId == request.auth.uid
            || isAdmin()
            || (resource.data.keys().hasAny(['editorIds'])
                && request.auth.uid in resource.data.editorIds));
    }
  }
}
`;

export const STORAGE_RULES = `rules_version = '2';

// ============================================================
// O.HOME Storage 보안 규칙 (이미지·파일)
// Firebase 콘솔 → Storage → 규칙 에 붙여넣고 [게시].
//   · 읽기는 공개 (방문자가 그림을 봐야 하므로)
//   · 올리기·지우기는 로그인 회원만
//   · 한 번에 20MB 초과 업로드 차단
// ============================================================

service firebase.storage {
  match /b/{bucket}/o {
    match /ohome/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null
        && request.resource.size < 20 * 1024 * 1024;
      allow delete: if request.auth != null;
    }
  }
}
`;
