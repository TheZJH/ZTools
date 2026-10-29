import type { Event, WebContents, WebContentsDidStartNavigationEventParams } from 'electron'

export interface PluginViewReadiness {
  /** 当前主框架文档是否已就绪，可直接复用而无需加载占位。 */
  readonly isReady: boolean
  /** 当前主框架页面的 DOM 就绪结果；导航或重载后读取会得到新的 Promise。 */
  readonly ready: Promise<boolean>
  /** 上次等待仅因超时结束而页面仍可能在加载时，为新的调用者重新开始计时等待。 */
  retryIfTimedOut(): void
}

/** Chromium 的 net::ERR_ABORTED，导航被拦截或取消时没有提交新文档。 */
const ERR_ABORTED = -3

/**
 * 在首次加载前绑定视图就绪等待，并随主框架导航更新等待结果。
 * @param contents 插件视图的 WebContents
 * @param timeoutMs 每次页面加载允许等待 DOM 就绪的毫秒数
 * @returns 随页面更新的就绪记录；失败、超时或销毁时本次等待返回 false
 */
export function createPluginViewReadiness(
  contents: WebContents,
  timeoutMs: number = 5000
): PluginViewReadiness {
  // 已销毁的视图不能再注册监听，也不能产生永远无法完成的等待。
  if (contents.isDestroyed()) {
    return { isReady: false, ready: Promise.resolve(false), retryIfTimedOut: () => {} }
  }

  let ready: Promise<boolean>
  let resolveReady: (value: boolean) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = true
  let navigationStarted = false
  let loadFailed = false
  let domReady = false
  let timedOut = false
  // 离开已就绪文档的导航目标；该导航被取消时原文档仍在显示，可恢复为就绪。
  let restorableUrl: string | undefined

  /**
   * 完成本次页面等待并释放计时器，继续观察迟到的页面就绪事件。
   * @param value 当前页面是否已经 DOM 就绪
   * @returns 无返回值
   */
  function finish(value: boolean): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveReady(value)
  }

  /**
   * 接受当前主框架页面的 DOM 就绪通知。
   * @returns 无返回值
   */
  function onReady(): void {
    // 超时只终止本次等待；慢页面随后就绪时，后续调用仍应可以使用该视图。
    if (loadFailed) return
    domReady = true
    restorableUrl = undefined
    if (settled) ready = Promise.resolve(true)
    finish(true)
  }

  /**
   * 主框架加载失败时结束等待，子框架失败不影响插件页面。
   * @param _event Electron 加载失败事件
   * @param _errorCode Chromium 错误码
   * @param _errorDescription Chromium 错误描述
   * @param _validatedURL 加载失败的地址
   * @param isMainFrame 是否为主框架
   * @returns 无返回值
   */
  function onFailed(
    _event: Event,
    _errorCode: number,
    _errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean
  ): void {
    if (!isMainFrame) return
    // 加载失败后的错误页也可能发出 DOM 就绪，不能将其当成可用插件页面。
    loadFailed = true
    domReady = false
    restorableUrl = undefined
    finish(false)
    ready = Promise.resolve(false)
  }

  /**
   * 主框架导航未提交便被取消时，恢复导航前已就绪文档的状态。
   * @param _event Electron 加载失败事件
   * @param errorCode Chromium 错误码
   * @param _errorDescription Chromium 错误描述
   * @param validatedURL 未能提交的导航地址
   * @param isMainFrame 是否为主框架
   * @returns 无返回值
   */
  function onProvisionalFailed(
    _event: Event,
    errorCode: number,
    _errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ): void {
    // 只处理离开已就绪文档的最近一次导航；其它失败仍按超时或 did-fail-load 结束。
    if (!isMainFrame || errorCode !== ERR_ABORTED) return
    if (restorableUrl === undefined || validatedURL !== restorableUrl) return
    // 跨源链接被 will-navigate 拦截后不会再有 dom-ready，原文档仍可继续使用。
    restorableUrl = undefined
    domReady = true
    if (settled) ready = Promise.resolve(true)
    finish(true)
  }

  /**
   * 为新的主框架页面建立有时间上限的等待。
   * @returns 无返回值
   */
  function begin(): void {
    settled = false
    loadFailed = false
    domReady = false
    timedOut = false
    ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve
    })
    timer = setTimeout(() => {
      timedOut = true
      finish(false)
    }, timeoutMs)
  }

  /**
   * 为超时后仍在加载的页面重新等待，供后续启动请求使用。
   * @returns 无返回值
   */
  function retryIfTimedOut(): void {
    // 失败、已就绪或仍在等待的结果都不能被新的等待覆盖。
    if (!settled || !timedOut || domReady || loadFailed || contents.isDestroyed()) return
    begin()
  }

  /**
   * 页面导航时更新就绪记录，保留首次 loadURL 之前已取得的等待。
   * @param details 导航目标及主框架、同文档标记
   * @returns 无返回值
   */
  function onNavigation(details: Event<WebContentsDidStartNavigationEventParams>): void {
    if (!details.isMainFrame || details.isSameDocument) return
    // 首次导航沿用创建时的等待；之后导航使旧文档的未完成等待失效。
    if (navigationStarted || settled) {
      // 连续导航时沿用最初的可恢复判断，只认最近一次导航的取消结果。
      const previousReady = domReady || restorableUrl !== undefined
      finish(false)
      begin()
      restorableUrl = previousReady ? details.url : undefined
    }
    navigationStarted = true
  }

  /**
   * 视图销毁时结束等待并释放跨导航保留的监听。
   * @returns 无返回值
   */
  function onDestroyed(): void {
    finish(false)
    domReady = false
    restorableUrl = undefined
    // 销毁后的读取必须返回失败，不能保留已就绪页面的成功结果。
    ready = Promise.resolve(false)
    contents.removeListener('dom-ready', onReady)
    contents.removeListener('did-fail-load', onFailed)
    contents.removeListener('did-fail-provisional-load', onProvisionalFailed)
    contents.removeListener('did-start-navigation', onNavigation)
    contents.removeListener('destroyed', onDestroyed)
  }

  // 每类事件只监听一次，跨导航及超时继续观察页面，直到视图销毁统一释放。
  contents.on('dom-ready', onReady)
  contents.on('did-fail-load', onFailed)
  contents.on('did-fail-provisional-load', onProvisionalFailed)
  contents.on('did-start-navigation', onNavigation)
  contents.once('destroyed', onDestroyed)
  begin()
  return {
    /**
     * 判断当前文档能否立即复用，导航、失败或销毁后重新等待。
     * @returns 当前主框架文档是否已完成 DOM 初始化
     */
    get isReady(): boolean {
      return domReady
    },
    /**
     * 获取当前页面对应的等待，避免重载后使用旧文档的就绪结果。
     * @returns 当前主框架页面的 DOM 就绪 Promise
     */
    get ready(): Promise<boolean> {
      return ready
    },
    retryIfTimedOut
  }
}
