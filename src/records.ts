/** 互动记录：每次开口留一行；连续相同的跳过原因只记一条。 */
import type { NudgeBlockReason } from './scheduler.ts';

/** 一条邀约的下场。 */
export type InteractionOutcome = 'pending' | 'spoke' | 'silent' | 'dropped';

export interface InteractionRecord {
  atMs: number;
  kind: 'nudge' | 'skip';
  /** 跳过时的原因。 */
  reason?: NudgeBlockReason;
  outcome?: InteractionOutcome;
  /** 这次是保底放行，不是判定命中的。 */
  pity?: boolean;
  /** 这一轮调过的工具名，用来复盘它到底做了什么。 */
  tools?: string[];
  /** 工具名对应的补充说明：截图为什么没成、调速后的倍率等。 */
  toolNotes?: Record<string, string>;
  /** 从叫醒到这一轮结束的毫秒数。 */
  ms?: number;
}

/** 记住多少条；每条都是一次判定命中或一次新的跳过原因。 */
export const MAX_RECORDS = 60;

const BLOCK_REASONS: readonly NudgeBlockReason[] = [
  'quiet',
  'outside-hours',
  'daily-cap',
  'nudge-cap',
  'user-speaking',
  'user-active',
  'user-away',
];

/** 读盘时校验：只认这几种跳过原因。 */
export function isBlockReason(value: unknown): value is NudgeBlockReason {
  return typeof value === 'string' && (BLOCK_REASONS as readonly string[]).includes(value);
}

const OUTCOMES: readonly InteractionOutcome[] = ['pending', 'spoke', 'silent', 'dropped'];

export function isOutcome(value: unknown): value is InteractionOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

const SKIP_LABELS: Record<NudgeBlockReason, string> = {
  quiet: '安静期',
  'outside-hours': '不在活跃时段',
  'daily-cap': '今天开口次数用满',
  'nudge-cap': '今天叫模型次数用满',
  'user-speaking': '你刚说过话',
  'user-active': '你正在用电脑',
  'user-away': '你离开太久',
};

const OUTCOME_LABELS: Record<InteractionOutcome, string> = {
  pending: '还没回应',
  spoke: '开口了',
  silent: '没开口',
  dropped: '被清掉了',
};

export function skipLabel(reason: NudgeBlockReason): string {
  return SKIP_LABELS[reason];
}

export function outcomeLabel(outcome: InteractionOutcome): string {
  return OUTCOME_LABELS[outcome];
}
