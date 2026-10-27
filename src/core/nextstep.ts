import type { Finding, RunDetail } from '../shared/types.js';
import { blocksCompletion } from './findings.js';
import { policyOf } from './policy.js';
import { latestChecks } from './qualityevidence.js';
import { readVerdict } from './report.js';
import { humanizeTestIds } from './testids.js';

/** Why a stopped run is stopped, in the few kinds that tell a person what to do. `generic` keeps the old sentence. */
export type StepCode =
  | 'finding_open' | 'verifier_inconclusive' | 'verifier_pending' | 'evidence_missing' | 'author_stuck' | 'checks_failing'
  | 'setup_failed' | 'capacity' | 'quota' | 'interrupted' | 'user_stop' | 'generic';

/** What the page does for each: it knows how to open a form or call an endpoint for these ids, and nothing else. */
export type StepActionId = 'close_finding' | 'review_findings' | 'switch_single' | 'revise_contract' | 'edit_project' | 'resume' | 'recheck';
export interface StepAction { id: StepActionId; label: string; /** Whether doing it spends an agent's time (and money). */ cost: 'free' | 'ai'; findingId?: string }

export interface NextStep {
  code: StepCode;
  /** One sentence naming what is in the way. */
  title: string;
  /** One or two sentences: why it stopped and what the person's move changes. */
  why: string;
  /** Exactly one move that gets the run going, and at most two other ways. */
  primary: StepAction;
  others: StepAction[];
  /** False when pressing "Chạy tiếp" cannot change anything, so the page says so instead of letting it be pressed again. */
  resumeChanges: boolean;
  /** What else holds the run back once this is done, in plain words. */
  after: string[];
}

type Input = Pick<RunDetail, 'run' | 'findings' | 'checks' | 'artifacts' | 'matrix' | 'authorDraft' | 'testRepair' | 'pendingPaths'>;

const act = (id: StepActionId, label: string, cost: StepAction['cost'] = 'free', findingId?: string): StepAction => ({ id, label, cost, ...(findingId ? { findingId } : {}) });
const SINGLE = act('switch_single', 'Chuyển sang Single (chấp nhận không có kiểm chứng độc lập)');
const REVISE = (label = 'Sửa hợp đồng') => act('revise_contract', label);
const ids = (list: readonly string[]) => list.join(', ');
const first = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const INFRA: Partial<Record<NonNullable<Input['run']['stopCode']>, (blocker: string) => NextStep>> = {
  setup_failed: () => ({
    code: 'setup_failed', title: 'Lệnh cài đặt của dự án bị lỗi',
    why: 'Lệnh cài đặt (ví dụ npm install) không chạy thành công nên chưa có bản sao để làm việc. Hãy sửa “Lệnh cài đặt” trong phần Sửa dự án, rồi bấm Chạy tiếp; chạy tiếp mà chưa sửa sẽ lỗi y như cũ.',
    primary: act('edit_project', 'Sửa lệnh cài đặt của dự án'), others: [], resumeChanges: true, after: [],
  }),
  capacity: () => ({
    code: 'capacity', title: 'Máy chủ của model đang quá tải',
    why: 'Đây không phải lỗi của việc này và công việc đã làm vẫn được giữ. Đợi vài phút rồi chạy tiếp.',
    primary: act('resume', 'Chạy tiếp', 'ai'), others: [], resumeChanges: true, after: [],
  }),
  quota: () => ({
    code: 'quota', title: 'Có thể đã chạm giới hạn sử dụng của nhà cung cấp',
    why: 'Chờ hạn mức làm mới rồi chạy tiếp; hệ thống không tự đổi nhà cung cấp.',
    primary: act('resume', 'Chạy tiếp', 'ai'), others: [], resumeChanges: true, after: [],
  }),
  interrupted: () => ({
    code: 'interrupted', title: 'Việc bị gián đoạn giữa chừng',
    why: 'Máy chủ dừng khi việc đang chạy. Chạy tiếp sẽ làm lại giai đoạn đó từ phần đã được chấp nhận.',
    primary: act('resume', 'Chạy tiếp', 'ai'), others: [], resumeChanges: true, after: [],
  }),
  user_stop: () => ({
    code: 'user_stop', title: 'Bạn đã dừng việc này',
    why: 'Chạy tiếp để làm tiếp từ chỗ đã dừng.',
    primary: act('resume', 'Chạy tiếp', 'ai'), others: [], resumeChanges: true, after: [],
  }),
};

/**
 * The one thing to do next for a run that stopped. It reads what the run is made of (the stop code, the draft, the checks, the
 * findings, the verdict), never the sentence stored when it stopped, so it is right after a fix and never out of date.
 * Runs waiting for something the page already has a panel for (a test correction, paths to approve) get nothing here.
 */
export function nextStep(d: Input): NextStep | undefined {
  const { run } = d;
  if (!['blocked', 'failed', 'paused'].includes(run.status)) return undefined;
  if ((d.testRepair && !run.testRepairApproval) || d.pendingPaths.length) return undefined;
  if (run.stopCode) { const infra = INFRA[run.stopCode]; if (infra) return infra(run.blocker ?? ''); }

  const policy = policyOf(run);

  // The Author left a draft that was not locked.
  const draft = d.authorDraft;
  if (draft) {
    if (draft.empty) return {
      code: 'author_stuck', title: 'Author chưa viết được test',
      why: 'Author không tạo file test nào, thường vì hợp đồng chưa đủ ví dụ hay tiêu chí để viết. Chạy tiếp sẽ không đổi kết quả; hãy bổ sung ví dụ vào hợp đồng hoặc kế hoạch ca.',
      primary: REVISE('Bổ sung ví dụ vào hợp đồng'), others: [SINGLE], resumeChanges: false, after: [],
    };
    if (draft.repairAvailable === true) return {
      code: 'author_stuck', title: 'Test do Author viết chưa dùng được',
      why: 'Còn một lượt để Author sửa; test chỉ được khóa khi qua đầy đủ kiểm tra.',
      primary: act('resume', 'Sửa draft và chạy tiếp', 'ai'), others: [REVISE()], resumeChanges: true, after: [],
    };
    return {
      code: 'author_stuck', title: 'Author đã dùng hết lượt sửa test',
      why: 'Chạy tiếp không cấp thêm lượt AI cho hợp đồng này. Hãy sửa hợp đồng hoặc kế hoạch ca để Author làm lại.',
      primary: REVISE(), others: [SINGLE], resumeChanges: false, after: [],
    };
  }

  // A required check is failing: the code or the test is wrong, and an agent can work on it.
  const failing = latestChecks(run, d.checks).filter((c) => c.required && (c.status === 'failed' || c.status === 'incomplete'));
  if (failing.length) return {
    code: 'checks_failing', title: `Có ${failing.length > 1 ? `${failing.length} kiểm tra` : 'một kiểm tra'} đang không đạt`,
    why: `Kiểm tra ${ids(failing.map((c) => `“${c.recipeId}”`))} chưa đạt. Chạy tiếp để Developer sửa (tốn AI), hoặc chạy lại kiểm tra nếu bạn vừa sửa cấu hình (không tốn AI).`,
    primary: act('resume', 'Chạy tiếp để sửa', 'ai'), others: [act('recheck', 'Chạy lại kiểm tra')], resumeChanges: true, after: [],
  };

  // Everything passes but a required requirement has no test behind it.
  const unverified = d.matrix.filter((r) => r.required && !r.manual && r.status !== 'verified').map((r) => r.requirementId);
  if (unverified.length) return {
    code: 'evidence_missing', title: 'Có yêu cầu chưa có test chứng minh',
    why: `Chưa có test đạt cho ${ids(unverified)}. Chạy tiếp không đổi được điều này. Yêu cầu chỉ kiểm bằng mắt thì đánh dấu “Thủ công”; yêu cầu kiểm bằng máy thì thêm ví dụ để có test.`,
    primary: REVISE('Sửa yêu cầu trong hợp đồng'), others: [], resumeChanges: false, after: [],
  };

  // What the Verifier said, and what it could not conclude.
  const open: Finding[] = d.findings.filter((f) => f.contractVersion === run.contract.version && blocksCompletion(f, policy.strict));
  const verdict = policy.strict && (run.mode === 'verify' || run.mode === 'compare') ? readVerdict(d.artifacts, run) : null;
  const inconclusive = !!verdict && ['abstain', 'skipped', 'unparsed'].includes(verdict.decision);
  const pending = policy.strict && (run.mode === 'verify' || run.mode === 'compare') && !verdict && !!run.checkpoint;

  if (open.length) {
    const f = open.find((x) => x.severity === 'blocker') ?? open[0]!;
    const more = open.length > 1 ? ` (còn ${open.length - 1} phát hiện khác sau đó)` : '';
    const after = [...(inconclusive ? ['Verifier chưa kết luận được: cần chuyển sang Single hoặc bổ sung ví dụ vào hợp đồng.'] : []), ...(open.length > 1 ? [`Còn ${open.length - 1} phát hiện khác của Verifier.`] : [])];
    if (f.confirmed) return {
      code: 'finding_open', title: `Chờ bạn đóng một phát hiện của Verifier${more}`,
      why: `Phát hiện: “${first(f.title)}”. Máy không có cách chạy thử để chứng minh bản sửa, nên chỉ bạn đóng được. Hãy tự thử trên app; nếu thấy đúng, đóng lại kèm lý do.`,
      primary: act('close_finding', 'Tôi đã thử và thấy đúng: đóng phát hiện', 'free', f.id), others: [act('review_findings', 'Xem chi tiết phát hiện')], resumeChanges: false, after,
    };
    return {
      code: 'finding_open', title: `Verifier nghi có lỗi, cần bạn quyết định${more}`,
      why: `Phát hiện: “${first(f.title)}”. Máy chưa chứng minh được. Xem chi tiết rồi chọn: nhờ Developer sửa, hoặc đóng lại nếu bạn thấy không đúng hay chưa cần.`,
      primary: act('review_findings', 'Xem và quyết định'), others: [act('close_finding', 'Đóng phát hiện (không cần sửa)', 'free', f.id)], resumeChanges: false, after,
    };
  }
  if (inconclusive) {
    const why = verdict!.decision === 'skipped'
      ? 'Verifier bị bỏ qua vì hết ngân sách cho bước kiểm chứng cuối, nên chưa có kiểm chứng độc lập cho bản này.'
      : verdict!.decision === 'unparsed'
        ? 'Kết luận của Verifier không đọc được, nên chưa có kiểm chứng độc lập cho bản này.'
        : 'Verifier từ chối kết luận, thường vì hợp đồng chưa có ví dụ cụ thể để đối chiếu.';
    return {
      code: 'verifier_inconclusive', title: 'Verifier chưa kết luận được',
      why: `${why} Chạy tiếp sẽ không đổi kết quả. Hoặc bổ sung ví dụ vào hợp đồng để kiểm chứng lại, hoặc chấp nhận bản này mà không có kiểm chứng độc lập.`,
      primary: SINGLE, others: [REVISE('Bổ sung ví dụ vào hợp đồng')], resumeChanges: false, after: [],
    };
  }
  if (pending) return {
    code: 'verifier_pending', title: 'Chờ Verifier kiểm chứng bản này',
    why: 'Các kiểm tra đã đạt nhưng Verifier chưa kiểm chứng bản hiện tại. Chạy tiếp để Verifier làm việc (tốn AI).',
    primary: act('resume', 'Chạy tiếp để Verifier kiểm chứng', 'ai'), others: [], resumeChanges: true, after: [],
  };

  return {
    code: 'generic', title: 'Việc đang dừng',
    why: run.blocker ? humanizeTestIds(run.blocker) : 'Chạy tiếp để làm tiếp từ chỗ đã dừng.',
    primary: act('resume', 'Chạy tiếp', 'ai'), others: [REVISE(), act('recheck', 'Chạy lại kiểm tra')], resumeChanges: true, after: [],
  };
}
