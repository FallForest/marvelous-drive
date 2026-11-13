import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DURATION, MOTION_ATTRS, REDUCED_MOTION_QUERY, STAGGER,
  announceEntrance, markAnimating, onceOnRoute, prefersReducedMotion, staggerDelay, staggerIndex,
  withViewTransition,
} from '../lib/motion.js'

/**
 * motion.js 是 JS 侧动效的唯一真源。这里全部用注入的假宿主对象验证：不 import CSS，
 * 不 mock 整个 document，也不依赖任何 browser 全局——所以 node --test 能跑完整逻辑。
 */

/* ── 假对象：够用就好，但监听器的注册/注销要能被数出来 ─────────── */
function fakeClassList(initial) {
  const names = new Set(initial || [])
  return {
    add(name) { names.add(name) },
    remove(name) { names.delete(name) },
    contains(name) { return names.has(name) },
    toggle(name, force) {
      const on = force === undefined ? !names.has(name) : Boolean(force)
      if (on) names.add(name)
      else names.delete(name)
      return on
    },
    toArray() { return Array.from(names) },
  }
}

function fakeStyle() {
  const props = new Map()
  return {
    props,
    setProperty(name, value) { props.set(name, String(value)) },
    getPropertyValue(name) { return props.has(name) ? props.get(name) : '' },
  }
}

function fakeElement(options) {
  const opts = options || {}
  const listeners = new Map()
  const attrs = new Map()
  const element = {
    classList: fakeClassList(opts.classes),
    dataset: {},
    style: fakeStyle(),
    reflows: 0,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      const set = listeners.get(type)
      if (set) set.delete(handler)
    },
    listenerCount(type) {
      const set = listeners.get(type)
      return set ? set.size : 0
    },
    /** 派发一个事件；target 由调用方给，用来模拟子元素冒泡。 */
    fire(type, target) {
      const event = { type, target: target === undefined ? element : target }
      for (const handler of Array.from(listeners.get(type) || [])) handler(event)
      return event
    },
    setAttribute(name, value) {
      attrs.set(name, String(value))
      if (name === MOTION_ATTRS.tokenAttr) element.dataset.motionToken = String(value)
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    removeAttribute(name) { attrs.delete(name) },
    hasAttribute(name) { return attrs.has(name) },
    attributeNames() { return Array.from(attrs.keys()) },
  }
  // offsetWidth 是可读属性：读一次就说明调用方在强制 reflow。
  Object.defineProperty(element, 'offsetWidth', {
    get() { element.reflows += 1; return 120 },
  })
  return element
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 让 finished 的 then 回调有机会执行完。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/* ── staggerIndex ─────────────────────────────────────────────── */
describe('staggerIndex', () => {
  it('keeps small indices, caps past ten', () => {
    // 前 11 项按自己的位置排队：0..10
    assert.equal(staggerIndex(0), 0)
    assert.equal(staggerIndex(3), 3)
    assert.equal(staggerIndex(10), 10)
    // 第 12 项起压到 cap：11 项之后延迟不再增长，否则 40 项列表要等一秒多
    assert.equal(staggerIndex(11), 10)
    assert.equal(staggerIndex(99), 10)
  })

  it('normalises negative, non-numeric and NaN to zero', () => {
    // 负数意味着「比第一项还早」，没有意义，归一成 0
    assert.equal(staggerIndex(-2), 0)
    // 字符串不做隐式转换：'3' 一旦被 Number 化就会绕过上限检查，统一当无效输入
    assert.equal(staggerIndex('3'), 0)
    assert.equal(staggerIndex(null), 0)
    assert.equal(staggerIndex(undefined), 0)
    // NaN 参与 Math.min 会得到 NaN，写进 --i 就是无效的 calc()
    assert.equal(staggerIndex(NaN), 0)
  })

  it('exposes the same cap the CSS uses', () => {
    assert.equal(STAGGER.cap, 10)
    assert.equal(STAGGER.step, 28)
    assert.equal(staggerIndex(STAGGER.cap + 1), STAGGER.cap)
  })
})

/* ── staggerDelay ─────────────────────────────────────────────── */
describe('staggerDelay', () => {
  it('advances 28ms per item by default', () => {
    assert.equal(staggerDelay(0), 0)
    assert.equal(staggerDelay(1), 28)
    assert.equal(staggerDelay(3), 84)
    assert.equal(staggerDelay(10), 280)
  })

  it('stops growing at the cap', () => {
    // 第 11 项和第 12 项拿到同一个延迟：尾巴一起到场
    assert.equal(staggerDelay(11), 280)
    assert.equal(staggerDelay(99), 280)
  })

  it('takes a custom step and cap', () => {
    assert.equal(staggerDelay(4, { step: 40 }), 160)
    assert.equal(staggerDelay(9, { step: 40, cap: 3 }), 120)
    assert.equal(staggerDelay(1, { cap: 0 }), 0)
  })

  it('returns a number for hostile input', () => {
    // 测量/调试代码拿到的必须永远是毫秒数，不能是 NaN
    assert.equal(staggerDelay(-1), 0)
    assert.equal(staggerDelay(NaN), 0)
    assert.equal(staggerDelay('5'), 0)
  })
})

/* ── prefersReducedMotion ─────────────────────────────────────── */
describe('prefersReducedMotion', () => {
  it('reads .matches from the injected matcher', () => {
    let asked = null
    const env = {
      matchMedia(query) {
        asked = query
        return { matches: true, media: query }
      },
    }
    assert.equal(prefersReducedMotion(env), true)
    // 查询串和 CSS 里那句 @media 必须是同一份，否则 JS 和 CSS 会各降级各的
    assert.equal(asked, REDUCED_MOTION_QUERY)
  })

  it('returns false when the matcher says motion is fine', () => {
    assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false)
    // 没有 matches 字段时按「未开启」处理
    assert.equal(prefersReducedMotion({ matchMedia: () => ({}) }), false)
  })

  it('returns false when matchMedia throws', () => {
    // 探测失败不能让整页交互失效，只能退回「允许动效」
    const env = { matchMedia() { throw new Error('nope') } }
    assert.equal(prefersReducedMotion(env), false)
  })

  it('returns false when no matchMedia exists', () => {
    // Node 没有 window.matchMedia；若未来宿主注入了它，这条断言不再适用。
    if (typeof globalThis.matchMedia === 'function') {
      assert.equal(typeof prefersReducedMotion(), 'boolean')
      return
    }
    assert.equal(prefersReducedMotion(), false)
    assert.equal(prefersReducedMotion({}), false)
    assert.equal(prefersReducedMotion({ matchMedia: undefined }), false)
  })
})

/* ── markAnimating ────────────────────────────────────────────── */
describe('markAnimating', () => {
  it('adds the class and removes it on animationend', () => {
    const element = fakeElement()
    const cleanup = markAnimating(element)
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), true)
    element.fire('animationend')
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), false)
    // 收尾后监听器必须摘干净，否则同一个元素反复动画会堆 handler
    assert.equal(element.listenerCount('animationend'), 0)
    assert.equal(element.listenerCount('animationcancel'), 0)
    cleanup()
  })

  it('ignores events bubbling up from children', () => {
    const element = fakeElement()
    const child = fakeElement()
    markAnimating(element)
    element.fire('animationend', child)
    // 子元素的 stagger 结束时提前摘类，会让父元素的合成层在动画中途消失
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), true)
    assert.equal(element.listenerCount('animationend'), 1)
    element.fire('animationend', element)
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), false)
  })

  it('also settles on animationcancel', () => {
    const element = fakeElement()
    markAnimating(element)
    element.fire('animationcancel')
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), false)
  })

  it('returns an idempotent cleanup', () => {
    const element = fakeElement()
    const cleanup = markAnimating(element)
    cleanup()
    cleanup()
    assert.equal(element.classList.contains(MOTION_ATTRS.animatingClass), false)
    // 重复调用不应报错，也不应把监听器加回来
    assert.equal(element.listenerCount('animationend'), 0)
    assert.equal(element.listenerCount('animationcancel'), 0)
  })

  it('is safe with null', () => {
    const cleanup = markAnimating(null)
    assert.equal(typeof cleanup, 'function')
    cleanup()
  })
})

/* ── withViewTransition ───────────────────────────────────────── */
describe('withViewTransition', () => {
  it('runs the update directly when the API is missing', () => {
    const root = fakeElement()
    const doc = { documentElement: root }
    let calls = 0
    const result = withViewTransition(() => { calls += 1 }, { doc, root, reduced: false })
    assert.equal(result, null)
    assert.equal(calls, 1)
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), false)
  })

  it('runs the update directly when motion is reduced', () => {
    const root = fakeElement()
    let started = 0
    const doc = {
      documentElement: root,
      startViewTransition() { started += 1; throw new Error('should not be called') },
    }
    let calls = 0
    const result = withViewTransition(() => { calls += 1 }, { doc, root, reduced: true })
    // 降级优先：连 startViewTransition 都不该被摸到
    assert.equal(result, null)
    assert.equal(calls, 1)
    assert.equal(started, 0)
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), false)
  })

  it('sets the swapping flag and releases it when finished resolves', async () => {
    const root = fakeElement()
    const done = deferred()
    const transition = { finished: done.promise }
    let calls = 0
    const doc = {
      documentElement: root,
      startViewTransition(callback) {
        callback()
        return transition
      },
    }
    const result = withViewTransition(() => { calls += 1 }, { doc, root, reduced: false })
    assert.equal(result, transition)
    assert.equal(calls, 1)
    // 标志必须活过整个转场，而不是两帧之后就被摘掉
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), true)
    done.resolve()
    await settle()
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), false)
  })

  it('releases the flag when finished rejects', async () => {
    const root = fakeElement()
    const done = deferred()
    let calls = 0
    const doc = {
      documentElement: root,
      startViewTransition(callback) {
        callback()
        return { finished: done.promise }
      },
    }
    withViewTransition(() => { calls += 1 }, { doc, root, reduced: false })
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), true)
    // 被下一次导航打断的转场走 reject 分支，标志不能留在文档上
    done.reject(new Error('interrupted'))
    await settle()
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), false)
    assert.equal(calls, 1)
  })

  it('falls back to a plain update when startViewTransition throws', () => {
    const root = fakeElement()
    let calls = 0
    const doc = {
      documentElement: root,
      startViewTransition() { throw new Error('already transitioning') },
    }
    const result = withViewTransition(() => { calls += 1 }, { doc, root, reduced: false })
    assert.equal(result, null)
    // 异常路径也必须把内容更新一次，且只更新一次
    assert.equal(calls, 1)
    assert.equal(root.hasAttribute(MOTION_ATTRS.swapAttr), false)
  })
})

/* ── onceOnRoute ──────────────────────────────────────────────── */
describe('onceOnRoute', () => {
  it('plays once per token and does not replay on a repeat render', () => {
    const element = fakeElement()
    assert.equal(onceOnRoute(element, 'drive:root', { reduced: false }), true)
    assert.equal(element.classList.contains(MOTION_ATTRS.enterClass), true)
    assert.equal(element.getAttribute(MOTION_ATTRS.tokenAttr), 'drive:root')

    // 模拟 CSS 入场跑完后浏览器把类摘掉，同一路由再渲染一次不能重新挂上
    element.classList.remove(MOTION_ATTRS.enterClass)
    assert.equal(onceOnRoute(element, 'drive:root', { reduced: false }), false)
    assert.equal(element.classList.contains(MOTION_ATTRS.enterClass), false)
  })

  it('plays again on a new token, forcing a reflow first', () => {
    const element = fakeElement()
    onceOnRoute(element, 'drive:root', { reduced: false })
    const before = element.reflows
    assert.equal(onceOnRoute(element, 'trash', { reduced: false }), true)
    assert.equal(element.classList.contains(MOTION_ATTRS.enterClass), true)
    assert.equal(element.getAttribute(MOTION_ATTRS.tokenAttr), 'trash')
    // 先删类再读 offsetWidth，动画才会从头跑；不读就会同一帧被合并掉
    assert.ok(element.reflows > before)
  })

  it('is safe with null', () => {
    assert.equal(onceOnRoute(null, 'drive:root', { reduced: false }), false)
  })

  it('updates the token without a class when motion is reduced', () => {
    const element = fakeElement()
    assert.equal(onceOnRoute(element, 'starred', { reduced: true }), true)
    // 类由 CSS 降级接管，JS 不加也不该抢；但 token 必须更新，
    // 否则用户关掉减少动效后第一次导航会被误判成「刚播过」
    assert.equal(element.classList.contains(MOTION_ATTRS.enterClass), false)
    assert.equal(element.getAttribute(MOTION_ATTRS.tokenAttr), 'starred')
    assert.equal(onceOnRoute(element, 'starred', { reduced: true }), false)
  })
})

/* ── announceEntrance ─────────────────────────────────────────── */
describe('announceEntrance', () => {
  it('writes --i for each element and caps the tail', () => {
    const elements = Array.from({ length: 13 }, () => fakeElement())
    const count = announceEntrance(elements, {})
    assert.equal(count, 13)
    assert.equal(elements[0].style.getPropertyValue('--i'), '0')
    assert.equal(elements[3].style.getPropertyValue('--i'), '3')
    // 第 12、13 项和上限处的第 11 项共用同一个槽位
    assert.equal(elements[10].style.getPropertyValue('--i'), '10')
    assert.equal(elements[11].style.getPropertyValue('--i'), '10')
    assert.equal(elements[12].style.getPropertyValue('--i'), '10')
  })

  it('continues numbering from options.from', () => {
    const elements = [fakeElement(), fakeElement(), fakeElement()]
    announceEntrance(elements, { from: 9 })
    assert.equal(elements[0].style.getPropertyValue('--i'), '9')
    // 从 9 起算，第二项就撞上上限
    assert.equal(elements[1].style.getPropertyValue('--i'), '10')
    assert.equal(elements[2].style.getPropertyValue('--i'), '10')
  })

  it('skips nulls and counts only what it wrote', () => {
    const first = fakeElement()
    const third = fakeElement()
    const count = announceEntrance([first, null, undefined, third], {})
    assert.equal(count, 2)
    // 跳过的 null 不占槽位，否则列表中间会多出一段空等
    assert.equal(first.style.getPropertyValue('--i'), '0')
    assert.equal(third.style.getPropertyValue('--i'), '1')
  })

  it('tolerates an empty or missing list', () => {
    assert.equal(announceEntrance([], {}), 0)
    assert.equal(announceEntrance(null), 0)
  })

  it('never lets a component compute its own cap', () => {
    // 唯一入口的语义：同一份输入永远得到和 staggerIndex 一致的结果
    const elements = Array.from({ length: 15 }, () => fakeElement())
    announceEntrance(elements)
    for (let index = 0; index < elements.length; index += 1) {
      assert.equal(elements[index].style.getPropertyValue('--i'), String(staggerIndex(index)))
    }
  })
})

/* ── 常量 ─────────────────────────────────────────────────────── */
describe('motion constants', () => {
  it('mirrors the durations that exist in tokens.css', () => {
    // 只镜像真实存在的 token；CSS 调参时这里要一起改，否则兜底等待会错位
    assert.equal(DURATION.fast, 140)
    assert.equal(DURATION.base, 220)
    assert.equal(MOTION_ATTRS.fallbackMs, 400)
    assert.equal(MOTION_ATTRS.viewTransitionTimeoutMs, 2000)
    assert.equal(MOTION_ATTRS.animatingClass, 'is-animating')
    assert.equal(MOTION_ATTRS.enterClass, 'motion-enter')
  })
})
