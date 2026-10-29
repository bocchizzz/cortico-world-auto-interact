/**
 * 两个面板：「使用说明」是静态介绍，「互动记录」向 World 要最近的判断并支持清空。
 * 浏览器侧只用 client-panel.ts 的类型，不 import 框架的运行时代码。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface GuideSection {
  title: string;
  items: string[];
}

const GUIDE_ZH: GuideSection[] = [
  {
    title: '这个扩展做什么',
    items: [
      '每 5 分钟做一次判定，命中就轮到 Coo 开口；未命中不打扰你。',
      '未命中不会叫醒模型，也不产生模型调用；连续未命中会按保底强制互动一次。',
    ],
  },
  {
    title: '页签',
    items: [
      '使用说明（本页）→ 互动记录 → 配置 → 提示词。',
      '配置改完，下一轮判断就生效，不用重启。',
    ],
  },
  {
    title: '配置要点',
    items: [
      '互动频率：1–10 档，档位越高越容易命中，平均 100 到 5 分钟开口一次。',
      '每天开口上限：只数真的开口（调了 pet_say 或 pet_ask）的次数。',
      '每天叫醒上限：判定命中就叫，哪怕没开口也算；防止一天跑几十轮。',
      '沉默后加码：连续 N 次被叫醒却没开口（模型没照做），下一次把要求写死。',
      '允许模型调速：打开后它可以用 auto_pace 按屏幕内容临时调高或调低频率。',
    ],
  },
  {
    title: '记录怎么读',
    items: [
      '主动搭话：判定命中，把模型叫醒。保底叫醒：连续未命中，按保底叫的。',
      '开口了 / 没开口：这一轮有没有调 pet_say 或 pet_ask。',
      '下面的小字是这一轮做了什么：看了屏幕、看了状态、问了你，以及花了多久。',
      '还没回应 / 被清掉了 / 中断了（重启）：这一轮还没结束、事件被你在队列里清空了，或者上次进程在邀约中途退出。',
      '跳过：安静期、不在时段、上限用满、你正在用电脑、你离开太久等。连续相同的原因只记一条。',
    ],
  },
  {
    title: '前提与隐私',
    items: [
      '只支持 Windows；空闲时长和截图都经 powershell.exe 读取。',
      '截图要在配置里打开「允许截图」；玩电脑要在「习惯」页打开「电脑操作」。',
      '只写部署 data 目录里的 auto-interact-records.json，别的不落盘；截图只发给你配置的模型端点。',
    ],
  },
];

const GUIDE_EN: GuideSection[] = [
  {
    title: 'What it does',
    items: [
      'Makes a chance check every 5 minutes; a hit means it is the pet’s turn to speak, and it is not asked to decide again.',
      'Misses cost no tokens. A pity rule forces one wake-up after a run of misses.',
    ],
  },
  {
    title: 'Tabs',
    items: ['Guide (this page) → Interaction log → Config → Prompt. Config changes apply on the next check.'],
  },
  {
    title: 'Settings',
    items: [
      'Frequency: 1–10, the hit chance; about one wake-up per 100 to 5 minutes.',
      'Daily speaks: counts only real speech (pet_say or pet_ask).',
      'Daily wake-ups: every hit counts, silent or not.',
      'Force after silence: after N turns where the model ignored the wake-up, the next event spells the demand out.',
      'Model pacing: lets the pet call auto_pace to scale the rate for a while.',
    ],
  },
  {
    title: 'Reading the log',
    items: [
      'Scheduled / pity: why the model was woken.',
      'Spoke / silent: whether pet_say or pet_ask was called in that turn.',
      'The small line shows what that turn did: looked at the screen, checked status, asked you, and how long it took.',
      'Pending / dropped / interrupted: turn still running, you cleared the queued event, or the previous process exited mid-turn.',
      'Skipped: quiet hours, outside hours, daily caps, you were active or away. Repeated reasons are collapsed.',
    ],
  },
];

interface RecordRow {
  at: string;
  text: string;
  outcome: string;
  tone: string;
  detail: string;
}

interface RecordsPayload {
  records: RecordRow[];
}

/** 记录面板的界面文案；面板本身支持中文和英文，不能把中文写死在 DOM 里。 */
interface RecordsCopy {
  title: string;
  refresh: string;
  clear: string;
  confirm: string;
  empty: string;
  readFailed: (message: string) => string;
  clearFailed: (message: string) => string;
}

const RECORDS_COPY: Record<'zh' | 'en', RecordsCopy> = {
  zh: {
    title: '最近的记录',
    refresh: '刷新',
    clear: '清除',
    confirm: '清除全部互动记录？这会同时删掉磁盘上的记录文件。',
    empty: '还没有记录：等下一次判定命中。',
    readFailed: (message) => `读取失败：${message}`,
    clearFailed: (message) => `清除失败：${message}`,
  },
  en: {
    title: 'Recent log',
    refresh: 'Refresh',
    clear: 'Clear',
    confirm: 'Clear all interaction records? This also deletes the record file on disk.',
    empty: 'No records yet. Wait for the next hit.',
    readFailed: (message) => `Could not load: ${message}`,
    clearFailed: (message) => `Could not clear: ${message}`,
  },
};

/** `zh`、`zh-Hant` 都走中文；其余语言走英文。 */
function uiLanguage(language: string): 'zh' | 'en' {
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function row(doc: Document, record: RecordRow): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'ai-records__row';

  const at = doc.createElement('span');
  at.className = 'ai-records__at';
  at.textContent = record.at;

  const body = doc.createElement('span');
  body.className = 'ai-records__textcol';
  const text = doc.createElement('span');
  text.className = 'ai-records__text';
  text.textContent = record.text;
  body.append(text);
  if (record.detail) {
    const detail = doc.createElement('span');
    detail.className = 'ai-records__detail';
    detail.textContent = record.detail;
    body.append(detail);
  }

  const outcome = doc.createElement('span');
  outcome.className = `ai-records__outcome ai-records__outcome--${record.tone}`;
  outcome.textContent = record.outcome;

  el.append(at, body, outcome);
  return el;
}

function button(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
  const el = doc.createElement('button');
  el.className = 'ai-records__button';
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

async function load(
  ctx: WebUiPanelContext,
  list: HTMLElement,
  note: HTMLElement,
  copy: RecordsCopy,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const payload = await ctx.invoke<RecordsPayload>('list');
    if (!isCurrent()) return;
    const records = payload?.records ?? [];
    list.replaceChildren(...records.map((record) => row(ctx.root.ownerDocument, record)));
    note.textContent = records.length ? '' : copy.empty;
  } catch (error) {
    if (!isCurrent()) return;
    note.textContent = copy.readFailed(error instanceof Error ? error.message : String(error));
  }
}

function mountGuide(ctx: WebUiPanelContext): void {
  const doc = ctx.root.ownerDocument;
  const zh = uiLanguage(ctx.language) === 'zh';
  const wrap = doc.createElement('div');
  wrap.className = 'ai-guide';

  for (const section of zh ? GUIDE_ZH : GUIDE_EN) {
    const block = doc.createElement('section');
    block.className = 'ai-guide__section';
    const title = doc.createElement('h3');
    title.textContent = section.title;
    const list = doc.createElement('ul');
    for (const item of section.items) {
      const li = doc.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    block.append(title, list);
    wrap.append(block);
  }

  ctx.root.append(wrap);
}

function mountRecords(ctx: WebUiPanelContext): void {
  const doc = ctx.root.ownerDocument;
  const copy = RECORDS_COPY[uiLanguage(ctx.language)];
  const wrap = doc.createElement('div');
  wrap.className = 'ai-records';

  const bar = doc.createElement('div');
  bar.className = 'ai-records__bar';
  const title = doc.createElement('span');
  title.className = 'ai-records__title';
  title.textContent = copy.title;
  const actions = doc.createElement('span');
  actions.className = 'ai-records__actions';

  const note = doc.createElement('p');
  note.className = 'ai-records__note';

  const list = doc.createElement('div');
  list.className = 'ai-records__list';

  // 定时刷新和手动刷新可能同时在跑；只让最后一次请求落地，避免旧结果覆盖新结果。
  let requestId = 0;
  const reload = (): void => {
    const current = ++requestId;
    void load(ctx, list, note, copy, () => current === requestId);
  };

  actions.append(
    button(doc, copy.refresh, reload),
    button(doc, copy.clear, () => {
      const ok = doc.defaultView?.confirm(copy.confirm) ?? true;
      if (!ok) return;
      void ctx.invoke<RecordsPayload>('clear')
        .then(() => reload())
        .catch((error: unknown) => {
          note.textContent = copy.clearFailed(error instanceof Error ? error.message : String(error));
        });
    }),
  );
  bar.append(title, actions);
  wrap.append(bar, note, list);
  ctx.root.append(wrap);

  reload();
  ctx.interval(reload, 10_000);
}

export const bundle: WebUiClientBundle = {
  panels: {
    guide: { mount: mountGuide },
    records: { mount: mountRecords },
  },
};

export default bundle;
