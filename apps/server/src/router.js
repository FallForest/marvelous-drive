/**
 * A minimal path router.
 *
 * Patterns support static segments and `:param` captures only, which is all the
 * API needs. Registration order decides the match, so literal paths are
 * registered before parameterised siblings.
 */
export class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    const keys = []
    const regex = new RegExp('^' + pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1))
          return '([^/]+)'
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/') + '/?$')
    this.routes.push({ method, regex, keys, handler })
    return this
  }

  get(pattern, handler) { return this.add('GET', pattern, handler) }
  post(pattern, handler) { return this.add('POST', pattern, handler) }
  put(pattern, handler) { return this.add('PUT', pattern, handler) }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler) }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler) }

  /** Resolves a request to `{handler, params}`, or null. */
  match(method, path) {
    let pathMatched = false
    for (const route of this.routes) {
      const result = route.regex.exec(path)
      if (!result) continue
      pathMatched = true
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue
      const params = {}
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(result[index + 1]) })
      return { handler: route.handler, params }
    }
    return pathMatched ? { handler: null, params: {} } : null
  }
}
