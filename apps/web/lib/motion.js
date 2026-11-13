/*
 * motion.js — 动效在 JS 侧的唯一天真源。
 *
 * CSS 的时长、曲线、stagger 步长都住在 styles/tokens.css；JS 只有必须知道同一套
 * 语义时才从这里读（例如判断动画何时收尾、给列表写 stagger 索引），组件里不允许
 * 再出现 28 / 10 / 400 这类字面量。
 *
 * 本文件刻意不 import 任何东西、也不在模块顶层碰 document / window：所有宿主对象
 * （matchMedia、document、页面根节点、元素）都从参数注入，因此 node --test 可以用
 * 假对象跑完整逻辑，浏览器里照常工作。
 */

/** 与 base.css 的 @media (prefers-reduced-motion:reduce) 保持同一份查询。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 镜像 tokens.css 的 --duration-fast:140ms / --duration-base:220ms。
 * 只镜像 CSS 里真实存在的值：CSS 调参时这两处要一起改，否则 JS 的兜底等待会早于
 * 或晚于真实动画结束。JS 自己从不拿它当动画时长（那属于 CSS 层）。
 */
export const DURATION = Object.freeze({ fast: 140, base: 220 });

/** 动画事件的兜底窗口：动画被中断、元素不可见或 keyframes 根本没跑时也能收尾。 */
const ANIMATION_FALLBACK_MS = 400;

/** 视图转场的最长存活时间：被中断的转场 finished 永远不会 resolve。 */
const VIEW_TRANSITION_TIMEOUT_MS = 2000;

/** 只在真正动画期间挂上的类（规则 2：不准常驻 will-change）。 */
const ANIMATING_CLASS = 'is-animating';

/** 页面根的入场类（规则 7：入场写在共享类上，才可能被转场抑制规则匹配到）。 */
const ENTER_CLASS = 'motion-enter';

/** 「每次导航只播一次」的标记属性。 */
const TOKEN_ATTR = 'data-motion-token';

/** 转场期间挂在根节点上、供 CSS 抑制被换页面入场的标志。 */
const SWAP_ATTR = 'data-vt-swapping';

/**
 * 列表 stagger 的上限（规则 8：不封顶的 28ms 步长会让 20 项列表等半秒）。
 * step 同时就是 motion.css 里 calc(var(--i) * 28ms) 的毫秒数。
 */
export const STAGGER = Object.freeze({ step: 28, cap: 10 });

/**
 * 系统是否要求减少动态效果。
 * env 可注入 { matchMedia }（测试或非浏览器宿主），缺省用 globalThis.matchMedia。
 * 没有 matchMedia、或它抛异常，一律当作「没开减少动效」——动效可以少，但不能因为
 * 一次探测失败而让整页交互失效。
 */
export function prefersReducedMotion(env) {
  if (env && typeof env.matchMedia === 'function') return queryMatches(env.matchMedia, env);
  if (typeof globalThis.matchMedia !== 'function') return false;
  // 不能先把 matchMedia 取出来再裸调用：浏览器的 window.matchMedia 需要接收者，
  // 裸调用会抛 Illegal invocation，所以整条路径都经由 globalThis。
  return queryMatches(globalThis.matchMedia, globalThis);
}

/** 统一查询入口：任何异常都收敛成 false。 */
function queryMatches(matchMedia, receiver) {
  try {
    const query = matchMedia.call(receiver, REDUCED_MOTION_QUERY);
    return Boolean(query && query.matches);
  } catch {
    return false;
  }
}

/**
 * 列表项的 stagger 槽位：负数、NaN、非数字（字符串也算）都归一成 0，
 * 超过上限的索引压到 cap，列表尾巴一起到场。
 */
export function staggerIndex(index) {
  if (typeof index !== 'number' || !Number.isFinite(index) || index <= 0) return 0;
  // 槽位必须落成整数：它要拿去乘毫秒，半格延迟在视觉上没有意义。
  return Math.min(Math.floor(index), STAGGER.cap);
}

/**
 * 第 index 项实际使用的延迟毫秒数，供测量和调试（CSS 仍走 calc，不读这个值）。
 * options: { step = STAGGER.step, cap = STAGGER.cap }。
 */
export function staggerDelay(index, options) {
  const opts = options || {};
  const step = Number.isFinite(opts.step) ? opts.step : STAGGER.step;
  const cap = Number.isFinite(opts.cap) ? Math.max(0, opts.cap) : STAGGER.cap;
  const slot = typeof index === 'number' && Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  // 这里单独算槽位而不是复用 staggerIndex：调用方可能传入自定义 cap。
  return Math.min(slot, cap) * step;
}

/**
 * 给元素挂 is-animating（只在此刻提升合成层），动画结束或取消时摘掉。
 *
 * 三种收尾都必须覆盖：
 * - animationend：正常结束；
 * - animationcancel：动画被打断（换路由、display:none、reduced-motion 的 .001ms
 *   覆盖），不摘类会留下永久的 will-change；
 * - 根本没触发动画时（元素不可见、keyframes 未定义）事件永远不会来，所以还有
 *   400ms 定时兜底。
 *
 * 返回幂等的 cleanup，重复调用只生效一次。
 */
export function markAnimating(element) {
  if (!element || !element.classList || typeof element.addEventListener !== 'function') {
    return () => {};
  }

  element.classList.add(ANIMATING_CLASS);

  let settled = false;
  let timer;

  const release = () => {
    if (settled) return;
    settled = true;
    if (typeof element.removeEventListener === 'function') {
      element.removeEventListener('animationend', onEnd);
      element.removeEventListener('animationcancel', onEnd);
    }
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
    element.classList.remove(ANIMATING_CLASS);
  };

  // target 必须是元素本身：子元素的 animationend 会冒泡上来，提前摘类会让子项
  // 的 stagger 一起丢掉合成层。
  function onEnd(event) {
    if (event && event.target != null && event.target !== element) return;
    release();
  }

  element.addEventListener('animationend', onEnd);
  element.addEventListener('animationcancel', onEnd);

  timer = globalThis.setTimeout(release, ANIMATION_FALLBACK_MS);
  // Node 里定时器会拖住进程退出；浏览器里 setTimeout 返回数字，可选链自动跳过。
  if (timer && typeof timer.unref === 'function') timer.unref();

  return release;
}

/**
 * 用 View Transitions 包一次 DOM 更换，并把抑制标志的存活期绑到「转场对象」上，
 * 而不是绑到几帧之后的时间点。
 *
 * options: { root = document.documentElement, doc = document,
 *            reduced = prefersReducedMotion() }
 *
 * 降级优先：没有 startViewTransition 或系统要求减少动效时直接执行 update()，返回 null。
 * 有转场时给根节点加 data-vt-swapping，让 CSS 只抑制被换的那块 surface，
 * 而不是整个文档（规则 6：范围收窄到一个 surface）。
 */
export function withViewTransition(update, options) {
  const opts = options || {};
  const doc = opts.doc || (typeof document === 'undefined' ? null : document);
  const root = opts.root || (doc && doc.documentElement) || null;
  const reduced = typeof opts.reduced === 'boolean' ? opts.reduced : prefersReducedMotion();

  if (reduced || !doc || typeof doc.startViewTransition !== 'function') {
    update();
    return null;
  }

  let released = false;
  let timer;

  const release = () => {
    if (released) return;
    released = true;
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
    if (root && typeof root.removeAttribute === 'function') root.removeAttribute(SWAP_ATTR);
  };

  if (root && typeof root.setAttribute === 'function') root.setAttribute(SWAP_ATTR, '');

  try {
    const transition = doc.startViewTransition(update);
    if (transition && transition.finished && typeof transition.finished.then === 'function') {
      // resolve 和 reject 都要释放：下一次导航打断转场时走的是 reject 分支。
      transition.finished.then(release, release);
    }
    // 中断的转场 finished 永不落定，标志绝不能留在文档上；2000ms 是无条件上限。
    timer = globalThis.setTimeout(release, VIEW_TRANSITION_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return transition || null;
  } catch {
    // 有的环境里 startViewTransition 会同步抛（例如已有转场在进行），此时标志已经挂上，
    // 必须先摘掉再退化成普通更新。
    release();
    update();
    return null;
  }
}

/**
 * 页面根的「每次导航只播一次」守卫。
 *
 * - 同一 token 第二次调用：返回 false 且什么都不动，避免重复渲染让入场重播
 *   （规则 7：入场重播看起来就是闪一下）；
 * - 换 token：先摘类、读一次 offsetWidth 强制 reflow、再挂类，动画才会从头跑；
 * - 元素为 null 安全返回 false；
 * - 系统要求减少动效时不挂类（base.css 已把时长压到 .001ms，位移交给 CSS 降级），
 *   但 token 仍然要更新，否则关掉减少动效后的第一次导航会被误判成「刚播过」。
 *
 * 第三参数 options.reduced 只为测试注入；正常调用只用前两个参数。
 */
export function onceOnRoute(element, token, options) {
  if (!element || typeof element.setAttribute !== 'function' || !element.classList) return false;

  const opts = options || {};
  const reduced = typeof opts.reduced === 'boolean' ? opts.reduced : prefersReducedMotion();
  const next = token == null ? '' : String(token);
  if (readToken(element) === next) return false;

  writeToken(element, next);

  if (!reduced) {
    element.classList.remove(ENTER_CLASS);
    // 读 offsetWidth 会同步刷新样式；否则同一帧内先删后加会被样式系统合并，
    // 类在 DOM 上变了，动画却不会重新开始。
    void element.offsetWidth;
    element.classList.add(ENTER_CLASS);
  }

  return true;
}

function readToken(element) {
  if (typeof element.getAttribute === 'function') {
    const value = element.getAttribute(TOKEN_ATTR);
    return value == null ? null : String(value);
  }
  if (element.dataset && element.dataset.motionToken != null) return String(element.dataset.motionToken);
  return null;
}

function writeToken(element, token) {
  element.setAttribute(TOKEN_ATTR, token);
  // 真 DOM 里 setAttribute 会同步 dataset；这里只在假对象上补写一次，
  // 保证两种宿主读到的是同一个值。
  if (element.dataset && element.dataset.motionToken !== token) element.dataset.motionToken = token;
}

/**
 * 列表 stagger 的唯一入口：给每个元素写 --i，motion.css 用 calc(var(--i) * 28ms) 算延迟。
 * 组件里禁止自己算 Math.min(index, 10)。
 *
 * options: { from = 0 } —— 局部列表可以从外层索引继续编号。
 * 返回成功写入的元素数量（跳过 null 和没有 style.setProperty 的对象）。
 */
export function announceEntrance(elements, options) {
  if (!elements || typeof elements === 'string') return 0;
  const opts = options || {};
  const from = Number.isFinite(opts.from) ? Math.floor(opts.from) : 0;
  let count = 0;
  let offset = 0;

  for (const element of elements) {
    if (!element || !element.style || typeof element.style.setProperty !== 'function') continue;
    element.style.setProperty('--i', String(staggerIndex(from + offset)));
    offset += 1;
    count += 1;
  }

  return count;
}

/** 主代理接线用的常量出口：类名和属性名全仓库只在这里出现一次。 */
export const MOTION_ATTRS = Object.freeze({
  animatingClass: ANIMATING_CLASS,
  enterClass: ENTER_CLASS,
  tokenAttr: TOKEN_ATTR,
  swapAttr: SWAP_ATTR,
  fallbackMs: ANIMATION_FALLBACK_MS,
  viewTransitionTimeoutMs: VIEW_TRANSITION_TIMEOUT_MS,
});
